/**
 * Simple Patch Antenna Example
 *
 * Port of vendor/openEMS/python/Tutorials/Simple_Patch_Antenna.py
 * to JavaScript using the antenna-prop Simulation API.
 *
 * Patch antenna on FR4 substrate with lumped port feed.
 */

import { Simulation } from '../src/simulation.mjs';
import { C0, EPS0, linspace, complexDivide, complexAbs, calcSParam } from '../src/analysis.mjs';
import { readNF2FFSurfaceData } from '../src/nf2ff.mjs';
import { meshHintFromBox, smoothMeshLines } from '../src/automesh.mjs';

/**
 * Run the patch antenna simulation and return results.
 *
 * @param {Object} Module - WASM module from createOpenEMS()
 * @param {Object} [opts]
 * @param {Function} [opts.onProgress] - progress callback(message)
 * @returns {Promise<Object>} results
 */
export async function runPatchAntenna(Module, opts = {}) {
  const log = opts.onProgress || (() => {});

  // --- Antenna parameters (all in mm, grid unit = 1e-3) ---
  const patch_width = 32;   // resonant length, x-direction
  const patch_length = 40;  // y-direction

  // Substrate
  const substrate_epsR = 3.38;
  const substrate_kappa = 1e-3 * 2 * Math.PI * 2.45e9 * EPS0 * substrate_epsR;
  const substrate_width = 60;
  const substrate_length = 60;
  const substrate_thickness = 1.524;
  const substrate_cells = 4;

  // Feed
  const feed_pos = -6;  // x-position of feed
  const feed_R = 50;    // feed resistance [Ohm]

  // Simulation box [mm]
  const SimBox = [200, 200, 150];

  // Excitation
  const f0 = 2e9;  // center frequency
  const fc = 1e9;  // 20 dB corner frequency

  // Mesh resolution
  const mesh_res = C0 / (f0 + fc) / 1e-3 / 20;  // ~5 mm

  log('Setting up simulation...');

  // --- Create simulation ---
  const sim = new Simulation(Module, { nrTS: 30000, endCriteria: 1e-4 });
  sim.setExcitation({ type: 'gauss', f0, fc });
  sim.setBoundaryConditions(['MUR', 'MUR', 'MUR', 'MUR', 'MUR', 'MUR']);

  // --- Initial grid (air box) ---
  const xLines = [-SimBox[0] / 2, SimBox[0] / 2];
  const yLines = [-SimBox[1] / 2, SimBox[1] / 2];
  const zLines = [-SimBox[2] / 3, SimBox[2] * 2 / 3];

  // Add patch edge mesh hints
  const patchStart = [-patch_width / 2, -patch_length / 2, substrate_thickness];
  const patchStop = [patch_width / 2, patch_length / 2, substrate_thickness];
  const patchHints = meshHintFromBox(patchStart, patchStop, 'xy', { metalEdgeRes: mesh_res / 2 });
  if (patchHints[0]) for (const v of patchHints[0]) xLines.push(v);
  if (patchHints[1]) for (const v of patchHints[1]) yLines.push(v);

  // Add ground edge mesh hints
  const gndStart = [-substrate_width / 2, -substrate_length / 2, 0];
  const gndStop = [substrate_width / 2, substrate_length / 2, 0];
  const gndHints = meshHintFromBox(gndStart, gndStop, 'xy');
  if (gndHints[0]) for (const v of gndHints[0]) xLines.push(v);
  if (gndHints[1]) for (const v of gndHints[1]) yLines.push(v);

  // Add substrate z-lines
  const subZLines = Array.from(linspace(0, substrate_thickness, substrate_cells + 1));
  for (const v of subZLines) zLines.push(v);

  // Add feed position to mesh
  xLines.push(feed_pos);

  // Smooth all lines
  const smoothX = smoothMeshLines([...new Set(xLines)].sort((a, b) => a - b), mesh_res);
  const smoothY = smoothMeshLines([...new Set(yLines)].sort((a, b) => a - b), mesh_res);
  const smoothZ = smoothMeshLines([...new Set(zLines)].sort((a, b) => a - b), mesh_res);

  sim.setGrid(1e-3, smoothX, smoothY, smoothZ);

  log(`Grid: ${smoothX.length} x ${smoothY.length} x ${smoothZ.length} = ${smoothX.length * smoothY.length * smoothZ.length} cells`);

  // --- Create patch (PEC) ---
  const patch = sim.addMetal('patch');
  patch.addBox(patchStart, patchStop, 10);

  // --- Create substrate ---
  const substrate = sim.addMaterial('substrate', {
    epsilon: substrate_epsR,
    kappa: substrate_kappa,
  });
  substrate.addBox(
    [-substrate_width / 2, -substrate_length / 2, 0],
    [substrate_width / 2, substrate_length / 2, substrate_thickness],
    0,
  );

  // --- Create ground plane (PEC, same size as substrate) ---
  const gnd = sim.addMetal('gnd');
  gnd.addBox(
    [-substrate_width / 2, -substrate_length / 2, 0],
    [substrate_width / 2, substrate_length / 2, 0],
    10,
  );

  // --- Add lumped port (feed) ---
  const port = sim.addLumpedPort({
    portNr: 1,
    R: feed_R,
    start: [feed_pos, 0, 0],
    stop: [feed_pos, 0, substrate_thickness],
    excDir: 2,  // z-direction
    excite: 1.0,
    priority: 5,
  });

  // --- NF2FF box ---
  // Place slightly inside the sim box boundary
  const nf2ffStart = [smoothX[1], smoothY[1], smoothZ[1]];
  const nf2ffStop = [smoothX[smoothX.length - 2], smoothY[smoothY.length - 2], smoothZ[smoothZ.length - 2]];
  const nf2ff = sim.createNF2FFBox('nf2ff', nf2ffStart, nf2ffStop);

  // --- Run simulation ---
  log('Running FDTD simulation...');
  const t0 = Date.now();
  const { module: M, ems, simPath } = await sim.runDirect({ engineType: 2 });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`Simulation complete in ${elapsed}s`);

  // --- Post-processing ---
  log('Post-processing...');

  // Frequency range for analysis
  const nFreq = 401;
  const freq = linspace(Math.max(1e9, f0 - fc), f0 + fc, nFreq);

  // Calculate port parameters
  port.calcPort(ems, simPath, freq, feed_R);

  // S11
  const { s11_dB } = calcSParam(port, freq);

  // Zin = uf_tot / if_tot
  const zin = complexDivide(port.uf_tot_re, port.uf_tot_im, port.if_tot_re, port.if_tot_im);

  // Find resonance: minimum S11 below -10 dB
  let minS11 = 0;
  let minIdx = -1;
  for (let i = 0; i < nFreq; i++) {
    if (s11_dB[i] < minS11) {
      minS11 = s11_dB[i];
      minIdx = i;
    }
  }

  const resonance_freq = minIdx >= 0 ? freq[minIdx] : null;
  log(`Resonance: ${resonance_freq ? (resonance_freq / 1e9).toFixed(3) + ' GHz' : 'not found'}, S11 = ${minS11.toFixed(1)} dB`);

  // --- NF2FF far-field ---
  let nf2ffResult = null;
  if (resonance_freq && minS11 < -10) {
    log('Computing far-field pattern...');
    try {
      const surfaceData = readNF2FFSurfaceData(ems, simPath, 'nf2ff');

      // Theta from -180 to 180 deg in 2-deg steps
      const thetaDeg = [];
      for (let t = -180; t < 180; t += 2) thetaDeg.push(t);
      const thetaRad = thetaDeg.map(t => t * Math.PI / 180);
      const phiRad = [0, Math.PI / 2];  // xz-plane and yz-plane

      const nf2ffRes = nf2ff.calcNF2FF(surfaceData, resonance_freq, thetaRad, phiRad, {
        center: [0, 0, 1e-3],
      });

      // E_norm in dBi: 20*log10(E_norm/max(E_norm)) + 10*log10(Dmax)
      const E_norm = nf2ffRes.E_norm[0];  // first (only) frequency
      const Dmax = nf2ffRes.Dmax[0];
      let maxE = 0;
      for (let i = 0; i < E_norm.length; i++) {
        if (E_norm[i] > maxE) maxE = E_norm[i];
      }

      const nTheta = thetaRad.length;
      const nPhi = phiRad.length;
      const E_norm_dBi = new Float64Array(nTheta * nPhi);
      for (let i = 0; i < E_norm.length; i++) {
        E_norm_dBi[i] = 20 * Math.log10(Math.max(E_norm[i] / maxE, 1e-15)) + 10 * Math.log10(Math.max(Dmax, 1e-15));
      }

      nf2ffResult = {
        theta: thetaDeg,
        E_norm_dBi,
        Dmax,
        nTheta,
        nPhi,
      };

      log(`Far-field: Dmax = ${(10 * Math.log10(Dmax)).toFixed(1)} dBi`);
    } catch (e) {
      log(`NF2FF computation failed: ${e.message}`);
    }
  }

  // Clean up (runDirect transfers CSX ownership — don't call sim.destroy())
  ems.delete();

  // Build results
  const results = {
    freq: Array.from(freq),
    s11_dB: Array.from(s11_dB),
    zin_re: Array.from(zin.re),
    zin_im: Array.from(zin.im),
    resonance_freq,
    nf2ff: nf2ffResult,
  };

  log('Done.');
  return results;
}
