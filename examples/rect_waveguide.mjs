/**
 * Rectangular Waveguide example.
 * Port of vendor/openEMS/python/Tutorials/Rect_Waveguide.py
 *
 * WR42 rectangular waveguide with TE10 mode excitation.
 */

import { Simulation } from '../src/simulation.mjs';
import { C0, Z0, linspace, complexDivide, complexAbs } from '../src/analysis.mjs';

/**
 * Run the rectangular waveguide simulation.
 * @param {Object} Module - WASM module from createOpenEMS()
 * @returns {Promise<{ freq: Float64Array, s11_dB: Float64Array, s21_dB: Float64Array, ZL_re: Float64Array, ZL_im: Float64Array, ZL_analytic: Float64Array }>}
 */
export async function runRectWaveguide(Module) {
  // --- Dimensions (all in um) ---
  const unit = 1e-6;

  // WR42 waveguide dimensions
  const a = 10700;   // waveguide width [um]
  const b = 4300;    // waveguide height [um]
  const length = 50000;

  // Frequency range
  const f_start = 20e9;
  const f_0 = 24e9;
  const f_stop = 26e9;
  const lambda0 = C0 / f_0 / unit;

  // TE mode
  const TE_mode = 'TE10';

  // Mesh resolution
  const mesh_res = lambda0 / 30;

  // --- Simulation setup ---
  const sim = new Simulation(Module, { nrTS: 10000, endCriteria: 1e-5 });
  sim.setExcitation({
    type: 'gauss',
    f0: 0.5 * (f_start + f_stop),
    fc: 0.5 * (f_stop - f_start),
  });

  // Boundary conditions: PEC walls on x/y, PML on z
  // Python uses [0, 0, 0, 0, 3, 3] which maps to PEC,PEC,PEC,PEC,PML_8,PML_8
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PML_8', 'PML_8']);

  // --- Mesh ---
  let xLines = [0, a];
  let yLines = [0, b];
  let zLines = [0, length];

  // Port 1 positions
  const p1_start_z = 10 * mesh_res;
  const p1_stop_z = 15 * mesh_res;
  zLines.push(p1_start_z, p1_stop_z);

  // Port 2 positions
  const p2_start_z = length - 10 * mesh_res;
  const p2_stop_z = length - 15 * mesh_res;
  zLines.push(p2_start_z, p2_stop_z);

  sim.setGrid(unit, xLines, yLines, zLines);
  sim.smoothGrid(mesh_res);

  // --- Waveguide Ports ---
  // Port 1: excited
  const port1 = sim.addRectWaveGuidePort({
    portNr: 0,
    start: [0, 0, p1_start_z],
    stop: [a, b, p1_stop_z],
    excDir: 2,  // z propagation
    a: a * unit,
    b: b * unit,
    modeName: TE_mode,
    excite: 1,
    unit: unit,
  });

  // Port 2: passive
  const port2 = sim.addRectWaveGuidePort({
    portNr: 1,
    start: [0, 0, p2_start_z],
    stop: [a, b, p2_stop_z],
    excDir: 2,  // z propagation
    a: a * unit,
    b: b * unit,
    modeName: TE_mode,
    unit: unit,
  });

  // --- Run simulation ---
  console.log('Running Rectangular Waveguide simulation...');
  const t0 = Date.now();
  const { module: M, ems, simPath } = await sim.runDirect({ engineType: 2 });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Simulation complete in ${elapsed}s.`);

  // --- Post-processing ---
  const freq = linspace(f_start, f_stop, 201);

  port1.calcPort(ems, simPath, freq);
  port2.calcPort(ems, simPath, freq);

  // S11 = port1.uf_ref / port1.uf_inc
  const s11 = complexDivide(
    port1.uf_ref_re, port1.uf_ref_im,
    port1.uf_inc_re, port1.uf_inc_im
  );
  const s11_mag = complexAbs(s11.re, s11.im);

  // S21 = port2.uf_ref / port1.uf_inc
  const s21 = complexDivide(
    port2.uf_ref_re, port2.uf_ref_im,
    port1.uf_inc_re, port1.uf_inc_im
  );
  const s21_mag = complexAbs(s21.re, s21.im);

  // ZL = port1.uf_tot / port1.if_tot (complex impedance)
  const ZL = complexDivide(
    port1.uf_tot_re, port1.uf_tot_im,
    port1.if_tot_re, port1.if_tot_im
  );

  // Analytic waveguide impedance
  const ZL_analytic = new Float64Array(freq.length);
  for (let i = 0; i < freq.length; i++) {
    const k = 2 * Math.PI * freq[i] / C0;
    const kc = Math.PI / (a * unit);  // TE10: kc = pi/a
    const kSq = k * k;
    const kcSq = kc * kc;
    if (kSq > kcSq) {
      const beta = Math.sqrt(kSq - kcSq);
      ZL_analytic[i] = k * Z0 / beta;
    } else {
      ZL_analytic[i] = Infinity;
    }
  }

  const s11_dB = new Float64Array(freq.length);
  const s21_dB = new Float64Array(freq.length);
  for (let i = 0; i < freq.length; i++) {
    s11_dB[i] = 20 * Math.log10(Math.max(s11_mag[i], 1e-15));
    s21_dB[i] = 20 * Math.log10(Math.max(s21_mag[i], 1e-15));
  }

  // Clean up (runDirect transfers CSX ownership — don't call sim.destroy())
  ems.delete();

  return {
    freq,
    s11_dB,
    s21_dB,
    ZL_re: ZL.re,
    ZL_im: ZL.im,
    ZL_analytic,
  };
}
