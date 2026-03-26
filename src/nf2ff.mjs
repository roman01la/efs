/**
 * NF2FF (Near-Field to Far-Field) recording box, computation, and result classes.
 * Mirrors vendor/openEMS/python/openEMS/nf2ff.py and nf2ff_calc.cpp
 *
 * The far-field computation is implemented in pure JavaScript following the
 * algorithm from vendor/openEMS/nf2ff/nf2ff_calc.cpp.
 *
 * Threading model:
 *   This module runs synchronously on the main thread. The computation loops
 *   (surface integration over theta/phi/freq) are single-threaded JavaScript.
 *   Multi-threaded FDTD execution happens at the WASM layer (Emscripten
 *   pthreads, engine type=3) and is independent of this post-processing step.
 *   For large angular grids, consider chunking theta/phi ranges across Web
 *   Workers at the application level.
 *
 * Complexity: O(N_surface * N_theta * N_phi * N_freq) -- can be slow for
 * fine angular resolution over large surfaces.
 */

import { C0, Z0, MUE0, EPS0 } from './analysis.mjs';

/**
 * Create an NF2FF recording box on the simulation.
 * Adds 6 E-field and H-field dump boxes (one per face of the bounding box).
 *
 * @param {import('./simulation.mjs').Simulation} sim
 * @param {string} name
 * @param {import('./types.mjs').Vec3} start
 * @param {import('./types.mjs').Vec3} stop
 * @param {Object} [opts]
 * @param {boolean[]} [opts.directions] - 6-element array enabling each face [xmin,xmax,ymin,ymax,zmin,zmax]
 * @param {number[]} [opts.mirror] - 6-element array: 0=off, 1=PEC, 2=PMC mirror per face
 * @param {number[]} [opts.frequency] - list of frequencies for FD-domain recording
 * @returns {NF2FFBox}
 */
export function createNF2FFBox(sim, name, start, stop, opts = {}) {
  const directions = opts.directions || [true, true, true, true, true, true];
  const mirror = opts.mirror || [0, 0, 0, 0, 0, 0];
  const frequency = opts.frequency || null;

  if (directions.length !== 6) throw new Error('directions must have 6 elements');
  if (mirror.length !== 6) throw new Error('mirror must have 6 elements');

  // Determine dump type: 0 = Et/Ht (time-domain), 10 = Ef/Hf (freq-domain)
  const dumpType = frequency !== null ? 10 : 0;
  const dumpMode = 1; // cell interpolated

  const eFile = `${name}_E`;
  const hFile = `${name}_H`;

  // Create dump box properties via CSXCAD
  const M = sim._module;
  const csx = sim._csx;
  const ps = csx.GetParameterSet();

  const eDump = M.CSPropDumpBox.create(ps);
  eDump.SetName(eFile);
  eDump.SetDumpType(dumpType);
  eDump.SetDumpMode(dumpMode);
  eDump.SetFileType(1);
  csx.AddProperty(eDump);

  const hDump = M.CSPropDumpBox.create(ps);
  hDump.SetName(hFile);
  hDump.SetDumpType(dumpType + 1);
  hDump.SetDumpMode(dumpMode);
  hDump.SetFileType(1);
  csx.AddProperty(hDump);

  // Add 6 face boxes (one per direction pair)
  for (let ny = 0; ny < 3; ny++) {
    const pos = 2 * ny;
    // Lower face (start side)
    if (directions[pos]) {
      const lStart = [...start];
      const lStop = [...stop];
      lStop[ny] = lStart[ny];
      const eb = M.CSPrimBox.create(ps, eDump);
      eb.SetStartStop(lStart[0], lStart[1], lStart[2], lStop[0], lStop[1], lStop[2]);
      const hb = M.CSPrimBox.create(ps, hDump);
      hb.SetStartStop(lStart[0], lStart[1], lStart[2], lStop[0], lStop[1], lStop[2]);
    }
    // Upper face (stop side)
    if (directions[pos + 1]) {
      const lStart = [...start];
      const lStop = [...stop];
      lStart[ny] = lStop[ny];
      const eb = M.CSPrimBox.create(ps, eDump);
      eb.SetStartStop(lStart[0], lStart[1], lStart[2], lStop[0], lStop[1], lStop[2]);
      const hb = M.CSPrimBox.create(ps, hDump);
      hb.SetStartStop(lStart[0], lStart[1], lStart[2], lStop[0], lStop[1], lStop[2]);
    }
  }

  return new NF2FFBox(name, start, stop, directions, mirror, frequency);
}

/**
 * Compute NF2FF far-field transformation from pre-extracted surface field data.
 * This is a pure function implementing the algorithm from nf2ff_calc.cpp.
 *
 * @param {Object} surfaceData - Surface field data
 * @param {Array<Object>} surfaceData.faces - Array of face objects, each with:
 *   @param {Float64Array[]} face.E - E-field components [Ex, Ey, Ez] as flat arrays over the face mesh
 *   @param {Float64Array[]} face.H - H-field components [Hx, Hy, Hz] as flat arrays over the face mesh
 *   @param {Object} face.mesh - { x: Float64Array, y: Float64Array, z: Float64Array } mesh lines for this face
 *   @param {number[]} face.normal - [nx, ny, nz] outward normal direction (one component is +/-1, rest 0)
 *   @param {number} [face.meshType=0] - 0 = Cartesian, 1 = cylindrical (rho, alpha, z)
 * @param {number} freq - Single frequency [Hz]
 * @param {Float64Array|number[]} theta - Theta observation angles [radians]
 * @param {Float64Array|number[]} phi - Phi observation angles [radians]
 * @param {number[]} [center=[0,0,0]] - Phase reference center [x, y, z]
 * @param {number} [radius=1] - Far-field observation radius [m]
 * @param {Object} [opts] - Additional options
 * @param {number} [opts.meshType=0] - Default mesh type for faces: 0 = Cartesian, 1 = cylindrical
 * @param {Object} [opts.mirror] - Mirror plane configuration
 * @param {string} opts.mirror.type - 'PEC' or 'PMC'
 * @param {number} opts.mirror.direction - Mirror direction: 0 (x), 1 (y), or 2 (z)
 * @param {number} opts.mirror.position - Mirror plane position along the direction axis
 * @returns {{ E_theta_re, E_theta_im, E_phi_re, E_phi_im, Prad, Dmax, P_rad }}
 */
export function computeNF2FF(surfaceData, freq, theta, phi, center = [0, 0, 0], radius = 1, opts = {}) {
  const nTheta = theta.length;
  const nPhi = phi.length;
  const nAngles = nTheta * nPhi;

  // Radiation integrals: Nt, Np, Lt, Lp (complex, accumulated in Float64 for precision)
  const Nt_re = new Float64Array(nAngles);
  const Nt_im = new Float64Array(nAngles);
  const Np_re = new Float64Array(nAngles);
  const Np_im = new Float64Array(nAngles);
  const Lt_re = new Float64Array(nAngles);
  const Lt_im = new Float64Array(nAngles);
  const Lp_re = new Float64Array(nAngles);
  const Lp_im = new Float64Array(nAngles);

  const k = 2 * Math.PI * freq / C0;

  // Accumulated radiated power from Poynting vector on the surfaces
  let radPower = 0;

  const defaultMeshType = opts.meshType ?? 0;
  const mirrorOpt = opts.mirror ?? null;

  // Helper: accumulate radiation integrals for a single set of face data
  // with optional E/H sign factors (used for mirror contributions)
  function accumulateFaces(faces, centerXYZ, E_sign, H_sign, mirrorDir, mirrorPos) {
    for (const face of faces) {
      const { E, H, mesh, normal } = face;
      const meshType = face.meshType ?? defaultMeshType;

      // Determine normal direction index and tangent directions
      let ny = -1;
      for (let n = 0; n < 3; n++) {
        if (normal[n] !== 0) { ny = n; break; }
      }
      if (ny < 0) continue;

      const nP = (ny + 1) % 3;
      const nPP = (ny + 2) % 3;

      const meshArrays = [mesh.x, mesh.y, mesh.z];
      const numP = meshArrays[nP].length;
      const numPP = meshArrays[nPP].length;
      const normSign = normal[ny]; // +1 or -1

      // Compute edge lengths for area weighting (midpoint rule)
      const edgeLenP = computeEdgeLengths(meshArrays[nP]);
      const edgeLenPP = computeEdgeLengths(meshArrays[nPP]);

      // For cylindrical meshes, adjust edge lengths per C++ reference:
      // surface rho-z (ny==0): alpha edge lengths *= rho
      // surface rho-alpha (ny==2): alpha edge lengths *= rho[pos_rho]
      if (meshType === 1) {
        if (ny === 0) {
          // nP = alpha direction; multiply by rho (which is meshArrays[0][0])
          const rho = meshArrays[0][0];
          for (let i = 0; i < edgeLenP.length; i++) edgeLenP[i] *= rho;
        } else if (ny === 2) {
          // nP = rho direction, nPP = alpha direction
          // alpha edge lengths *= rho at each rho position -- handled below per-point
        }
      }

      // For each surface point, compute equivalent currents and accumulate integrals
      for (let iP = 0; iP < numP; iP++) {
        for (let iPP = 0; iPP < numPP; iPP++) {
          const idx = iP * numPP + iPP;
          let area = edgeLenP[iP] * edgeLenPP[iPP];

          // For cylindrical mesh ny==2 surface: multiply by rho for alpha edge
          if (meshType === 1 && ny === 2) {
            // nP = rho, nPP = alpha; rho = meshArrays[nP][iP] = meshArrays[0][iP]
            area *= meshArrays[0][iP];
          }

          // E and H field at this surface point
          const Ex_re = E[0][2 * idx], Ex_im = E[0][2 * idx + 1];
          const Ey_re = E[1][2 * idx], Ey_im = E[1][2 * idx + 1];
          const Ez_re = E[2][2 * idx], Ez_im = E[2][2 * idx + 1];
          const Hx_re = H[0][2 * idx], Hx_im = H[0][2 * idx + 1];
          const Hy_re = H[1][2 * idx], Hy_im = H[1][2 * idx + 1];
          const Hz_re = H[2][2 * idx], Hz_im = H[2][2 * idx + 1];

          // Apply E/H sign factors for mirror contributions
          const eEx_re = Ex_re * E_sign[0], eEx_im = Ex_im * E_sign[0];
          const eEy_re = Ey_re * E_sign[1], eEy_im = Ey_im * E_sign[1];
          const eEz_re = Ez_re * E_sign[2], eEz_im = Ez_im * E_sign[2];
          const eHx_re = Hx_re * H_sign[0], eHx_im = Hx_im * H_sign[0];
          const eHy_re = Hy_re * H_sign[1], eHy_im = Hy_im * H_sign[1];
          const eHz_re = Hz_re * H_sign[2], eHz_im = Hz_im * H_sign[2];

          // Js = n x H
          const normDir = [0, 0, 0];
          normDir[ny] = normSign;
          let Js_re_0 = normDir[1] * eHz_re - normDir[2] * eHy_re;
          let Js_im_0 = normDir[1] * eHz_im - normDir[2] * eHy_im;
          let Js_re_1 = normDir[2] * eHx_re - normDir[0] * eHz_re;
          let Js_im_1 = normDir[2] * eHx_im - normDir[0] * eHz_im;
          const Js_re_2 = normDir[0] * eHy_re - normDir[1] * eHx_re;
          const Js_im_2 = normDir[0] * eHy_im - normDir[1] * eHx_im;

          // Ms = -n x E
          let Ms_re_0 = normDir[2] * eEy_re - normDir[1] * eEz_re;
          let Ms_im_0 = normDir[2] * eEy_im - normDir[1] * eEz_im;
          let Ms_re_1 = normDir[0] * eEz_re - normDir[2] * eEx_re;
          let Ms_im_1 = normDir[0] * eEz_im - normDir[2] * eEx_im;
          const Ms_re_2 = normDir[1] * eEx_re - normDir[0] * eEy_re;
          const Ms_im_2 = normDir[1] * eEx_im - normDir[0] * eEy_im;

          // Transform cylindrical (rho, alpha, z) currents to Cartesian (x, y, z)
          // Following nf2ff_calc.cpp lines 85-96
          if (meshType === 1) {
            // meshArrays[1] is the alpha (azimuthal angle) array
            // Determine alpha index based on face orientation
            let pos_alpha;
            if (ny === 1) {
              // face normal is alpha: face at constant alpha, alpha = meshArrays[1][0]
              pos_alpha = 0;
            } else if (nP === 1) {
              pos_alpha = iP;
            } else {
              pos_alpha = iPP;
            }
            const alpha = meshArrays[1][pos_alpha];
            const cos_a = Math.cos(alpha);
            const sin_a = Math.sin(alpha);

            // Js: transform (rho, alpha, z) -> (x, y, z)
            const Js_rho_re = Js_re_0, Js_rho_im = Js_im_0;
            const Js_alpha_re = Js_re_1, Js_alpha_im = Js_im_1;
            Js_re_0 = Js_rho_re * cos_a - Js_alpha_re * sin_a;
            Js_im_0 = Js_rho_im * cos_a - Js_alpha_im * sin_a;
            Js_re_1 = Js_rho_re * sin_a + Js_alpha_re * cos_a;
            Js_im_1 = Js_rho_im * sin_a + Js_alpha_im * cos_a;
            // Js_z unchanged (Js_re_2, Js_im_2)

            // Ms: same transform
            const Ms_rho_re = Ms_re_0, Ms_rho_im = Ms_im_0;
            const Ms_alpha_re = Ms_re_1, Ms_alpha_im = Ms_im_1;
            Ms_re_0 = Ms_rho_re * cos_a - Ms_alpha_re * sin_a;
            Ms_im_0 = Ms_rho_im * cos_a - Ms_alpha_im * sin_a;
            Ms_re_1 = Ms_rho_re * sin_a + Ms_alpha_re * cos_a;
            Ms_im_1 = Ms_rho_im * sin_a + Ms_alpha_im * cos_a;
            // Ms_z unchanged
          }

          const Js_re = [Js_re_0, Js_re_1, Js_re_2];
          const Js_im = [Js_im_0, Js_im_1, Js_im_2];
          const Ms_re = [Ms_re_0, Ms_re_1, Ms_re_2];
          const Ms_im = [Ms_im_0, Ms_im_1, Ms_im_2];

          // Position of this surface point
          const pos = [0, 0, 0];
          pos[ny] = meshArrays[ny][0]; // face is at single coordinate along ny
          pos[nP] = meshArrays[nP][iP];
          pos[nPP] = meshArrays[nPP][iPP];

          // For cylindrical mesh, convert position to Cartesian
          let posCart;
          if (meshType === 1) {
            const rho = pos[0];
            const alpha = pos[1];
            posCart = [rho * Math.cos(alpha), rho * Math.sin(alpha), pos[2]];
          } else {
            posCart = pos;
          }

          // Apply mirror position offset: reflect coordinate along mirror direction
          if (mirrorDir >= 0) {
            posCart[mirrorDir] = 2 * mirrorPos - posCart[mirrorDir];
          }

          // Radiated power (only for main, non-mirror pass)
          if (mirrorDir < 0) {
            const E_nP_re = [eEx_re, eEy_re, eEz_re][nP];
            const E_nP_im = [eEx_im, eEy_im, eEz_im][nP];
            const H_nPP_re = [eHx_re, eHy_re, eHz_re][nPP];
            const H_nPP_im = [eHx_im, eHy_im, eHz_im][nPP];
            const E_nPP_re = [eEx_re, eEy_re, eEz_re][nPP];
            const E_nPP_im = [eEx_im, eEy_im, eEz_im][nPP];
            const H_nP_re = [eHx_re, eHy_re, eHz_re][nP];
            const H_nP_im = [eHx_im, eHy_im, eHz_im][nP];

            const poynting = (E_nP_re * H_nPP_re + E_nP_im * H_nPP_im)
                           - (E_nPP_re * H_nP_re + E_nPP_im * H_nP_im);
            radPower += 0.5 * area * poynting * normSign;
          }

          // For each observation angle, accumulate radiation integrals
          for (let tn = 0; tn < nTheta; tn++) {
            const sinT = Math.sin(theta[tn]);
            const cosT = Math.cos(theta[tn]);

            for (let pn = 0; pn < nPhi; pn++) {
              const sinP = Math.sin(phi[pn]);
              const cosP = Math.cos(phi[pn]);

              const cosT_cosP = cosT * cosP;
              const cosT_sinP = cosT * sinP;
              const cosP_sinT = cosP * sinT;
              const sinT_sinP = sinP * sinT;

              // Phase: exp(jk * r_dot_rhat)
              const r_cos_psi = (posCart[0] - centerXYZ[0]) * cosP_sinT
                              + (posCart[1] - centerXYZ[1]) * sinT_sinP
                              + (posCart[2] - centerXYZ[2]) * cosT;
              const phase = k * r_cos_psi;
              const exp_re = Math.cos(phase);
              const exp_im = Math.sin(phase);

              const angIdx = tn * nPhi + pn;

              const Js_t_re = Js_re[0] * cosT_cosP + Js_re[1] * cosT_sinP - Js_re[2] * sinT;
              const Js_t_im = Js_im[0] * cosT_cosP + Js_im[1] * cosT_sinP - Js_im[2] * sinT;
              const Js_p_re = Js_re[1] * cosP - Js_re[0] * sinP;
              const Js_p_im = Js_im[1] * cosP - Js_im[0] * sinP;

              const Ms_t_re = Ms_re[0] * cosT_cosP + Ms_re[1] * cosT_sinP - Ms_re[2] * sinT;
              const Ms_t_im = Ms_im[0] * cosT_cosP + Ms_im[1] * cosT_sinP - Ms_im[2] * sinT;
              const Ms_p_re = Ms_re[1] * cosP - Ms_re[0] * sinP;
              const Ms_p_im = Ms_im[1] * cosP - Ms_im[0] * sinP;

              const areaExp_re = area * exp_re;
              const areaExp_im = area * exp_im;

              Nt_re[angIdx] += areaExp_re * Js_t_re - areaExp_im * Js_t_im;
              Nt_im[angIdx] += areaExp_re * Js_t_im + areaExp_im * Js_t_re;

              Np_re[angIdx] += areaExp_re * Js_p_re - areaExp_im * Js_p_im;
              Np_im[angIdx] += areaExp_re * Js_p_im + areaExp_im * Js_p_re;

              Lt_re[angIdx] += areaExp_re * Ms_t_re - areaExp_im * Ms_t_im;
              Lt_im[angIdx] += areaExp_re * Ms_t_im + areaExp_im * Ms_t_re;

              Lp_re[angIdx] += areaExp_re * Ms_p_re - areaExp_im * Ms_p_im;
              Lp_im[angIdx] += areaExp_re * Ms_p_im + areaExp_im * Ms_p_re;
            }
          }
        }
      }
    }
  }

  // Convert center to Cartesian for cylindrical meshes
  let centerXYZ;
  if (defaultMeshType === 1) {
    centerXYZ = [center[0] * Math.cos(center[1]), center[0] * Math.sin(center[1]), center[2]];
  } else {
    centerXYZ = center;
  }

  // Main pass: accumulate with identity signs
  const E_sign_main = [1, 1, 1];
  const H_sign_main = [1, 1, 1];
  accumulateFaces(surfaceData.faces, centerXYZ, E_sign_main, H_sign_main, -1, 0);

  // Mirror pass: if a mirror is configured, re-accumulate with mirrored position and adjusted signs
  if (mirrorOpt) {
    const n = mirrorOpt.direction;
    const nP_m = (n + 1) % 3;
    const nPP_m = (n + 2) % 3;

    const E_factor = [1, 1, 1];
    const H_factor = [1, 1, 1];

    if (mirrorOpt.type === 'PEC') {
      // PEC mirror: tangential E reversed, normal H reversed
      H_factor[n] = -1;
      E_factor[nP_m] = -1;
      E_factor[nPP_m] = -1;
    } else if (mirrorOpt.type === 'PMC') {
      // PMC mirror: normal E reversed, tangential H reversed
      E_factor[n] = -1;
      H_factor[nP_m] = -1;
      H_factor[nPP_m] = -1;
    }

    accumulateFaces(surfaceData.faces, centerXYZ, E_factor, H_factor, n, mirrorOpt.position);
  }

  // Compute far-field: equations 8.23a/b and 8.24a/b from Balanis
  // factor = j*k / (4*pi*r) * exp(-jkr)
  const fac_mag = k / (4 * Math.PI * radius);
  const fac_phase = -k * radius;
  // j * fac_mag * exp(j*fac_phase) = fac_mag * (j*cos(fac_phase) - sin(fac_phase))
  // = fac_mag * (-sin(fac_phase) + j*cos(fac_phase))
  const fac_re = fac_mag * (-Math.sin(fac_phase));
  const fac_im = fac_mag * Math.cos(fac_phase);

  const fZ0 = Z0; // free space impedance

  const E_theta_re = new Float64Array(nAngles);
  const E_theta_im = new Float64Array(nAngles);
  const E_phi_re = new Float64Array(nAngles);
  const E_phi_im = new Float64Array(nAngles);
  const P_rad = new Float64Array(nAngles);

  let P_max = 0;

  for (let i = 0; i < nAngles; i++) {
    // E_theta = -factor * (Lp + Z0 * Nt)
    const LpZ0Nt_re = Lp_re[i] + fZ0 * Nt_re[i];
    const LpZ0Nt_im = Lp_im[i] + fZ0 * Nt_im[i];
    // -factor * val = -(fac_re * val_re - fac_im * val_im) + j*(-(fac_re * val_im + fac_im * val_re))
    E_theta_re[i] = -(fac_re * LpZ0Nt_re - fac_im * LpZ0Nt_im);
    E_theta_im[i] = -(fac_re * LpZ0Nt_im + fac_im * LpZ0Nt_re);

    // E_phi = factor * (Lt - Z0 * Np)
    const LtZ0Np_re = Lt_re[i] - fZ0 * Np_re[i];
    const LtZ0Np_im = Lt_im[i] - fZ0 * Np_im[i];
    E_phi_re[i] = fac_re * LtZ0Np_re - fac_im * LtZ0Np_im;
    E_phi_im[i] = fac_re * LtZ0Np_im + fac_im * LtZ0Np_re;

    // P_rad = (|E_theta|^2 + |E_phi|^2) / (2 * Z0)
    const Et_mag2 = E_theta_re[i] * E_theta_re[i] + E_theta_im[i] * E_theta_im[i];
    const Ep_mag2 = E_phi_re[i] * E_phi_re[i] + E_phi_im[i] * E_phi_im[i];
    P_rad[i] = (Et_mag2 + Ep_mag2) / (2 * fZ0);

    if (P_rad[i] > P_max) P_max = P_rad[i];
  }

  // Maximum directivity
  const Dmax = radPower > 0 ? P_max * 4 * Math.PI * radius * radius / radPower : 0;

  return {
    E_theta_re,
    E_theta_im,
    E_phi_re,
    E_phi_im,
    Prad: radPower,
    Dmax,
    P_rad,
  };
}

/**
 * Compute edge lengths for midpoint-rule area weighting.
 * For interior points: 0.5 * (line[i+1] - line[i-1])
 * For endpoints: 0.5 * (line[1] - line[0]) or 0.5 * (line[N-1] - line[N-2])
 * @param {Float64Array|number[]} lines
 * @returns {Float64Array}
 */
function computeEdgeLengths(lines) {
  const N = lines.length;
  const lengths = new Float64Array(N);
  if (N === 1) {
    lengths[0] = 0; // degenerate single point — zero area contribution
    return lengths;
  }
  lengths[0] = 0.5 * Math.abs(lines[1] - lines[0]);
  for (let i = 1; i < N - 1; i++) {
    lengths[i] = 0.5 * Math.abs(lines[i + 1] - lines[i - 1]);
  }
  lengths[N - 1] = 0.5 * Math.abs(lines[N - 1] - lines[N - 2]);
  return lengths;
}

/**
 * NF2FF recording box. Holds metadata and provides calcNF2FF.
 */
export class NF2FFBox {
  /**
   * @param {string} name
   * @param {import('./types.mjs').Vec3} start
   * @param {import('./types.mjs').Vec3} stop
   * @param {boolean[]} directions
   * @param {number[]} mirror
   * @param {number[]|null} frequency
   */
  constructor(name, start, stop, directions, mirror, frequency) {
    this.name = name;
    this.start = [...start];
    this.stop = [...stop];
    this.directions = [...directions];
    this.mirror = [...mirror];
    this.frequency = frequency ? [...frequency] : null;
  }

  /**
   * Calculate far-field from near-field surface data.
   *
   * @param {Object} surfaceData - { faces: [{ E, H, mesh, normal }] }
   *   Each face's E and H are arrays of 3 Float64Arrays (one per component),
   *   with complex values stored as re/im interleaved pairs.
   * @param {number|number[]} freq - Frequency or array of frequencies [Hz]
   * @param {number[]} theta - Theta angles in radians
   * @param {number[]} phi - Phi angles in radians
   * @param {Object} [opts]
   * @param {number[]} [opts.center=[0,0,0]] - Phase reference center
   * @param {number} [opts.radius=1] - Far-field observation radius [m]
   * @returns {NF2FFResult}
   */
  calcNF2FF(surfaceData, freq, theta, phi, opts = {}) {
    const center = opts.center ?? [0, 0, 0];
    const radius = opts.radius ?? 1;

    const freqArr = Array.isArray(freq) ? freq : [freq];
    const thetaArr = theta instanceof Float64Array ? theta : new Float64Array(theta);
    const phiArr = phi instanceof Float64Array ? phi : new Float64Array(phi);
    const nTheta = thetaArr.length;
    const nPhi = phiArr.length;
    const nAngles = nTheta * nPhi;

    const Dmax_arr = [];
    const Prad_arr = [];
    const E_theta_all = [];
    const E_phi_all = [];
    const E_norm_all = [];
    const P_rad_all = [];

    for (const f of freqArr) {
      const result = computeNF2FF(surfaceData, f, thetaArr, phiArr, center, radius, {
        meshType: opts.meshType,
        mirror: opts.mirror,
      });

      Dmax_arr.push(result.Dmax);
      Prad_arr.push(result.Prad);

      // E_norm = sqrt(|E_theta|^2 + |E_phi|^2)
      const E_norm = new Float64Array(nAngles);
      for (let i = 0; i < nAngles; i++) {
        E_norm[i] = Math.sqrt(
          result.E_theta_re[i] * result.E_theta_re[i] + result.E_theta_im[i] * result.E_theta_im[i] +
          result.E_phi_re[i] * result.E_phi_re[i] + result.E_phi_im[i] * result.E_phi_im[i]
        );
      }

      E_theta_all.push({ re: result.E_theta_re, im: result.E_theta_im });
      E_phi_all.push({ re: result.E_phi_re, im: result.E_phi_im });
      E_norm_all.push(E_norm);
      P_rad_all.push(result.P_rad);
    }

    // Circular polarization: E_cprh = (E_theta - j*E_phi)/sqrt(2), E_cplh = (E_theta + j*E_phi)/sqrt(2)
    const E_cprh_all = [];
    const E_cplh_all = [];
    for (let fi = 0; fi < freqArr.length; fi++) {
      const cprh = new Float64Array(nAngles);
      const cplh = new Float64Array(nAngles);
      const et = E_theta_all[fi], ep = E_phi_all[fi];
      for (let i = 0; i < nAngles; i++) {
        // RHCP = (E_theta - j*E_phi) / sqrt(2) → magnitude
        const rh_re = et.re[i] + ep.im[i];
        const rh_im = et.im[i] - ep.re[i];
        cprh[i] = Math.sqrt(rh_re * rh_re + rh_im * rh_im) / Math.SQRT2;
        // LHCP = (E_theta + j*E_phi) / sqrt(2) → magnitude
        const lh_re = et.re[i] - ep.im[i];
        const lh_im = et.im[i] + ep.re[i];
        cplh[i] = Math.sqrt(lh_re * lh_re + lh_im * lh_im) / Math.SQRT2;
      }
      E_cprh_all.push(cprh);
      E_cplh_all.push(cplh);
    }

    return new NF2FFResult({
      theta: thetaArr,
      phi: phiArr,
      r: radius,
      freq: freqArr,
      Dmax: Dmax_arr,
      Prad: Prad_arr,
      E_theta: E_theta_all,
      E_phi: E_phi_all,
      E_norm: E_norm_all,
      E_cprh: E_cprh_all,
      E_cplh: E_cplh_all,
      P_rad: P_rad_all,
    });
  }
}

/**
 * Read NF2FF surface field data from simulation output files.
 *
 * openEMS writes NF2FF surface dumps as HDF5 files (FileType=1).
 * This implementation uses the WASM module's HDF5 reading functions
 * (via HDF5_File_Reader compiled into WASM) to read the data directly
 * from MEMFS.
 *
 * Expected files at: {simPath}/{boxName}_E_{xn,xp,yn,yp,zn,zp}.h5
 *                and: {simPath}/{boxName}_H_{xn,xp,yn,yp,zn,zp}.h5
 *
 * @param {Object} wasmEms - WASM openEMS wrapper instance (with readHDF5Mesh, readHDF5TDField, etc.)
 * @param {string} simPath - Simulation output directory path in MEMFS
 * @param {string} boxName - NF2FF box name used in createNF2FFBox
 * @param {Object} [opts]
 * @param {number[]} [opts.frequency] - Frequencies for FD-domain reading (if null, reads TD data)
 * @param {boolean[]} [opts.directions] - 6-element array enabling each face [xmin,xmax,ymin,ymax,zmin,zmax]
 * @returns {{ faces: Array<Object> }} Surface data structure for calcNF2FF
 */
export function readNF2FFSurfaceData(wasmEms, simPath, boxName, opts = {}) {
  if (!wasmEms || typeof wasmEms.readHDF5Mesh !== 'function') {
    throw new Error(
      `readNF2FFSurfaceData requires a WASM module with HDF5 reading support (readHDF5Mesh). ` +
      `Expected HDF5 files at ${simPath}/${boxName}_E_*.h5 and ${simPath}/${boxName}_H_*.h5. ` +
      `Pass surface data directly to calcNF2FF() instead, or ensure the WASM module is initialized.`
    );
  }

  const directions = opts.directions || [true, true, true, true, true, true];
  const frequency = opts.frequency || null;

  // Face suffixes and their normal directions
  const faceSuffixes = ['xn', 'xp', 'yn', 'yp', 'zn', 'zp'];
  const faceNormals = [
    [-1, 0, 0], [1, 0, 0],
    [0, -1, 0], [0, 1, 0],
    [0, 0, -1], [0, 0, 1],
  ];

  const faces = [];

  for (let fi = 0; fi < 6; fi++) {
    if (!directions[fi]) continue;

    const suffix = faceSuffixes[fi];
    const eFile = `${simPath}/${boxName}_E_${suffix}.h5`;
    const hFile = `${simPath}/${boxName}_H_${suffix}.h5`;

    // Read mesh from E-field file (same mesh for H)
    const meshX = _vectorToArray(wasmEms.readHDF5Mesh(eFile, 0));
    const meshY = _vectorToArray(wasmEms.readHDF5Mesh(eFile, 1));
    const meshZ = _vectorToArray(wasmEms.readHDF5Mesh(eFile, 2));

    if (meshX.length === 0 && meshY.length === 0 && meshZ.length === 0) {
      continue; // File not found or empty
    }

    const meshType = wasmEms.getHDF5MeshType(eFile);
    const Nx = meshX.length, Ny = meshY.length, Nz = meshZ.length;
    const cellCount = Nx * Ny * Nz;

    const normal = faceNormals[fi];

    if (frequency !== null) {
      // Frequency-domain reading
      const eFieldRaw = _vectorToArray(wasmEms.readHDF5FDField(eFile, 0));
      const hFieldRaw = _vectorToArray(wasmEms.readHDF5FDField(hFile, 0));

      if (eFieldRaw.length === 0 || hFieldRaw.length === 0) continue;

      // eFieldRaw is interleaved re/im: [d][i][j][k] with 2 floats per element
      // Total: 2 * 3 * Nx * Ny * Nz
      // Split into per-component arrays with re/im interleaved
      const E = [
        new Float64Array(2 * cellCount),
        new Float64Array(2 * cellCount),
        new Float64Array(2 * cellCount),
      ];
      const H = [
        new Float64Array(2 * cellCount),
        new Float64Array(2 * cellCount),
        new Float64Array(2 * cellCount),
      ];

      for (let d = 0; d < 3; d++) {
        const offset = d * cellCount * 2;
        for (let c = 0; c < cellCount; c++) {
          E[d][2 * c] = eFieldRaw[offset + 2 * c];
          E[d][2 * c + 1] = eFieldRaw[offset + 2 * c + 1];
          H[d][2 * c] = hFieldRaw[offset + 2 * c];
          H[d][2 * c + 1] = hFieldRaw[offset + 2 * c + 1];
        }
      }

      faces.push({
        E, H,
        mesh: {
          x: new Float64Array(meshX),
          y: new Float64Array(meshY),
          z: new Float64Array(meshZ),
        },
        normal,
        meshType: meshType >= 0 ? meshType : 0,
      });
    } else {
      // Time-domain reading: read all timesteps and return the last one
      // (For NF2FF, the caller typically DFTs externally)
      const numTS = wasmEms.getHDF5NumTimeSteps(eFile);
      if (numTS === 0) continue;

      // Read the last timestep
      const tsIdx = numTS - 1;
      const eFieldRaw = _vectorToArray(wasmEms.readHDF5TDField(eFile, tsIdx));
      const hFieldRaw = _vectorToArray(wasmEms.readHDF5TDField(hFile, tsIdx));

      if (eFieldRaw.length === 0 || hFieldRaw.length === 0) continue;

      // TD data is real-valued: [d][i][j][k], total = 3 * Nx * Ny * Nz
      // Convert to complex (re/im interleaved) with zero imaginary part
      const E = [
        new Float64Array(2 * cellCount),
        new Float64Array(2 * cellCount),
        new Float64Array(2 * cellCount),
      ];
      const H = [
        new Float64Array(2 * cellCount),
        new Float64Array(2 * cellCount),
        new Float64Array(2 * cellCount),
      ];

      for (let d = 0; d < 3; d++) {
        const offset = d * cellCount;
        for (let c = 0; c < cellCount; c++) {
          E[d][2 * c] = eFieldRaw[offset + c];
          E[d][2 * c + 1] = 0;
          H[d][2 * c] = hFieldRaw[offset + c];
          H[d][2 * c + 1] = 0;
        }
      }

      faces.push({
        E, H,
        mesh: {
          x: new Float64Array(meshX),
          y: new Float64Array(meshY),
          z: new Float64Array(meshZ),
        },
        normal,
        meshType: meshType >= 0 ? meshType : 0,
      });
    }
  }

  return { faces };
}

/**
 * Helper: convert Emscripten vector to JS array.
 * Handles both std::vector wrappers and plain arrays.
 */
function _vectorToArray(vec) {
  if (!vec) return [];
  if (Array.isArray(vec) || vec instanceof Float32Array || vec instanceof Float64Array) {
    return vec;
  }
  // Emscripten vector wrapper
  if (typeof vec.size === 'function') {
    const n = vec.size();
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) arr[i] = vec.get(i);
    vec.delete(); // Free C++ memory
    return arr;
  }
  return [];
}

/**
 * NF2FF result container.
 * Holds far-field data after computation.
 */
export class NF2FFResult {
  /**
   * @param {Object} data
   * @param {Float64Array} data.theta
   * @param {Float64Array} data.phi
   * @param {number} data.r
   * @param {number[]} data.freq
   * @param {number[]} data.Dmax - directivity per frequency
   * @param {number[]} data.Prad - total radiated power per frequency
   * @param {Array} data.E_theta - E-field theta component per frequency
   * @param {Array} data.E_phi - E-field phi component per frequency
   * @param {Array} data.E_norm - E-field magnitude per frequency
   * @param {Array} data.E_cprh - co-pol RHCP per frequency
   * @param {Array} data.E_cplh - co-pol LHCP per frequency
   * @param {Array} data.P_rad - radiated power density per frequency
   */
  constructor(data) {
    this.theta = data.theta;
    this.phi = data.phi;
    this.r = data.r;
    this.freq = data.freq;
    this.Dmax = data.Dmax;
    this.Prad = data.Prad;
    this.E_theta = data.E_theta;
    this.E_phi = data.E_phi;
    this.E_norm = data.E_norm;
    this.E_cprh = data.E_cprh;
    this.E_cplh = data.E_cplh;
    this.P_rad = data.P_rad;
  }
}
