/**
 * NF2FF (Near-Field to Far-Field) recording box, computation, and result classes.
 * Mirrors vendor/openEMS/python/openEMS/nf2ff.py and nf2ff_calc.cpp
 *
 * The far-field computation is implemented in pure JavaScript following the
 * algorithm from vendor/openEMS/nf2ff/nf2ff_calc.cpp.
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

  // Add E-field and H-field dump properties
  const eDumpProp = {
    type: 'DumpBox',
    name: eFile,
    attrs: { DumpType: dumpType, DumpMode: dumpMode, FileType: 1 },
    primitives: [],
  };
  const hDumpProp = {
    type: 'DumpBox',
    name: hFile,
    attrs: { DumpType: dumpType + 1, DumpMode: dumpMode, FileType: 1 },
    primitives: [],
  };

  if (frequency !== null) {
    eDumpProp.attrs.Frequency = frequency.join(',');
    hDumpProp.attrs.Frequency = frequency.join(',');
  }

  // Add 6 face boxes (one per direction pair)
  for (let ny = 0; ny < 3; ny++) {
    const pos = 2 * ny;
    // Lower face (start side)
    if (directions[pos]) {
      const lStart = [...start];
      const lStop = [...stop];
      lStop[ny] = lStart[ny];
      eDumpProp.primitives.push({ type: 'Box', start: lStart, stop: lStop, priority: 0 });
      hDumpProp.primitives.push({ type: 'Box', start: lStart, stop: lStop, priority: 0 });
    }
    // Upper face (stop side)
    if (directions[pos + 1]) {
      const lStart = [...start];
      const lStop = [...stop];
      lStart[ny] = lStop[ny];
      eDumpProp.primitives.push({ type: 'Box', start: lStart, stop: lStop, priority: 0 });
      hDumpProp.primitives.push({ type: 'Box', start: lStart, stop: lStop, priority: 0 });
    }
  }

  sim._properties.push(eDumpProp);
  sim._properties.push(hDumpProp);

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
 * @param {number} freq - Single frequency [Hz]
 * @param {Float64Array|number[]} theta - Theta observation angles [radians]
 * @param {Float64Array|number[]} phi - Phi observation angles [radians]
 * @param {number[]} [center=[0,0,0]] - Phase reference center [x, y, z]
 * @param {number} [radius=1] - Far-field observation radius [m]
 * @returns {{ E_theta_re, E_theta_im, E_phi_re, E_phi_im, Prad, Dmax, P_rad }}
 */
export function computeNF2FF(surfaceData, freq, theta, phi, center = [0, 0, 0], radius = 1) {
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

  for (const face of surfaceData.faces) {
    const { E, H, mesh, normal } = face;

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

    // For each surface point, compute equivalent currents and accumulate integrals
    for (let iP = 0; iP < numP; iP++) {
      for (let iPP = 0; iPP < numPP; iPP++) {
        const idx = iP * numPP + iPP;
        const area = edgeLenP[iP] * edgeLenPP[iPP];

        // E and H field at this surface point (complex, stored as [re, im] pairs or just real for FD data)
        // Convention: E[0..2] are Ex, Ey, Ez at this point
        // For frequency-domain data, E[comp][idx] is complex stored as re,im interleaved
        // or as separate re/im arrays. Here we assume re/im interleaved:
        const Ex_re = E[0][2 * idx], Ex_im = E[0][2 * idx + 1];
        const Ey_re = E[1][2 * idx], Ey_im = E[1][2 * idx + 1];
        const Ez_re = E[2][2 * idx], Ez_im = E[2][2 * idx + 1];
        const Hx_re = H[0][2 * idx], Hx_im = H[0][2 * idx + 1];
        const Hy_re = H[1][2 * idx], Hy_im = H[1][2 * idx + 1];
        const Hz_re = H[2][2 * idx], Hz_im = H[2][2 * idx + 1];

        // Js = n x H (cross product with normal)
        // If normal = [0, 0, normSign] (ny=2): Js = normSign * [Hy, -Hx, 0]
        // General: Js[i] = normal[(i+1)%3]*H[(i+2)%3] - normal[(i+2)%3]*H[(i+1)%3]
        const normDir = [0, 0, 0];
        normDir[ny] = normSign;
        const Js_re = [
          normDir[1] * Hz_re - normDir[2] * Hy_re,
          normDir[2] * Hx_re - normDir[0] * Hz_re,
          normDir[0] * Hy_re - normDir[1] * Hx_re,
        ];
        const Js_im = [
          normDir[1] * Hz_im - normDir[2] * Hy_im,
          normDir[2] * Hx_im - normDir[0] * Hz_im,
          normDir[0] * Hy_im - normDir[1] * Hx_im,
        ];

        // Ms = -n x E
        const Ms_re = [
          normDir[2] * Ey_re - normDir[1] * Ez_re,
          normDir[0] * Ez_re - normDir[2] * Ex_re,
          normDir[1] * Ex_re - normDir[0] * Ey_re,
        ];
        const Ms_im = [
          normDir[2] * Ey_im - normDir[1] * Ez_im,
          normDir[0] * Ez_im - normDir[2] * Ex_im,
          normDir[1] * Ex_im - normDir[0] * Ey_im,
        ];

        // Position of this surface point
        const pos = [0, 0, 0];
        pos[ny] = meshArrays[ny][0]; // face is at single coordinate along ny
        pos[nP] = meshArrays[nP][iP];
        pos[nPP] = meshArrays[nPP][iPP];

        // Radiated power: P += 0.5 * Re(E_nP * conj(H_nPP) - E_nPP * conj(H_nP)) * area * normSign
        const E_nP_re = [Ex_re, Ey_re, Ez_re][nP];
        const E_nP_im = [Ex_im, Ey_im, Ez_im][nP];
        const H_nPP_re = [Hx_re, Hy_re, Hz_re][nPP];
        const H_nPP_im = [Hx_im, Hy_im, Hz_im][nPP];
        const E_nPP_re = [Ex_re, Ey_re, Ez_re][nPP];
        const E_nPP_im = [Ex_im, Ey_im, Ez_im][nPP];
        const H_nP_re = [Hx_re, Hy_re, Hz_re][nP];
        const H_nP_im = [Hx_im, Hy_im, Hz_im][nP];

        // Re(a * conj(b)) = a_re * b_re + a_im * b_im
        const poynting = (E_nP_re * H_nPP_re + E_nP_im * H_nPP_im)
                       - (E_nPP_re * H_nP_re + E_nPP_im * H_nP_im);
        radPower += 0.5 * area * poynting * normSign;

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
            const r_cos_psi = (pos[0] - center[0]) * cosP_sinT
                            + (pos[1] - center[1]) * sinT_sinP
                            + (pos[2] - center[2]) * cosT;
            const phase = k * r_cos_psi;
            const exp_re = Math.cos(phase);
            const exp_im = Math.sin(phase);

            const angIdx = tn * nPhi + pn;

            // Project Js onto theta/phi: Js_theta = Jx*cosT*cosP + Jy*cosT*sinP - Jz*sinT
            //                             Js_phi   = -Jx*sinP + Jy*cosP
            const Js_t_re = Js_re[0] * cosT_cosP + Js_re[1] * cosT_sinP - Js_re[2] * sinT;
            const Js_t_im = Js_im[0] * cosT_cosP + Js_im[1] * cosT_sinP - Js_im[2] * sinT;
            const Js_p_re = Js_re[1] * cosP - Js_re[0] * sinP;
            const Js_p_im = Js_im[1] * cosP - Js_im[0] * sinP;

            const Ms_t_re = Ms_re[0] * cosT_cosP + Ms_re[1] * cosT_sinP - Ms_re[2] * sinT;
            const Ms_t_im = Ms_im[0] * cosT_cosP + Ms_im[1] * cosT_sinP - Ms_im[2] * sinT;
            const Ms_p_re = Ms_re[1] * cosP - Ms_re[0] * sinP;
            const Ms_p_im = Ms_im[1] * cosP - Ms_im[0] * sinP;

            // Accumulate: integral += area * exp(jk*r_cos_psi) * Js_projected
            // (a+jb)(c+jd) = (ac-bd) + j(ad+bc)
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
      const result = computeNF2FF(surfaceData, f, thetaArr, phiArr, center, radius);

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
