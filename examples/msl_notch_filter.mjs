/**
 * MSL Notch Filter example.
 * Port of vendor/openEMS/python/Tutorials/MSL_NotchFilter.py
 *
 * Microstrip notch filter with an open stub on a RO4350B substrate.
 */

import { Simulation } from '../src/simulation.mjs';
import { C0, linspace, complexDivide, complexAbs } from '../src/analysis.mjs';

/**
 * Run the MSL notch filter simulation.
 * @param {Object} Module - WASM module from createOpenEMS()
 * @returns {Promise<{ freq: Float64Array, s11_dB: Float64Array, s21_dB: Float64Array }>}
 */
export async function runMSLNotchFilter(Module) {
  // --- Dimensions (all in um) ---
  const unit = 1e-6;
  const MSL_length = 50000;
  const MSL_width = 600;
  const substrate_thickness = 254;
  const substrate_epr = 3.66;
  const stub_length = 12e3;
  const f_max = 7e9;

  // --- Simulation setup ---
  const sim = new Simulation(Module, { nrTS: 1000000, endCriteria: 1e-5 });
  sim.setExcitation({ type: 'gauss', f0: f_max / 2, fc: f_max / 2 });
  sim.setBoundaryConditions(['PML_8', 'PML_8', 'MUR', 'MUR', 'PEC', 'MUR']);

  // --- Mesh ---
  const resolution = C0 / (f_max * Math.sqrt(substrate_epr)) / unit / 50;
  const third_mesh = [2 * resolution / 3 / 4, -resolution / 3 / 4];

  // X mesh: MSL width region + full extent
  let xLines = [];
  xLines.push(0);
  xLines.push(MSL_width / 2 + third_mesh[0]);
  xLines.push(MSL_width / 2 + third_mesh[1]);
  xLines.push(-MSL_width / 2 - third_mesh[0]);
  xLines.push(-MSL_width / 2 - third_mesh[1]);
  xLines.push(-MSL_length, MSL_length);

  // Y mesh: MSL width region + stub region + full extent
  let yLines = [];
  yLines.push(0);
  yLines.push(MSL_width / 2 + third_mesh[0]);
  yLines.push(MSL_width / 2 + third_mesh[1]);
  yLines.push(-MSL_width / 2 - third_mesh[0]);
  yLines.push(-MSL_width / 2 - third_mesh[1]);
  yLines.push(-15 * MSL_width, 15 * MSL_width + stub_length);
  yLines.push(MSL_width / 2 + stub_length + third_mesh[0]);
  yLines.push(MSL_width / 2 + stub_length + third_mesh[1]);

  // Z mesh: substrate + air above
  let zLines = [];
  for (let i = 0; i <= 4; i++) {
    zLines.push(substrate_thickness * i / 4);
  }
  zLines.push(3000);

  sim.setGrid(unit, xLines, yLines, zLines);
  sim.smoothGrid(resolution);

  // --- Substrate ---
  sim.addMaterial('RO4350B', { epsilon: substrate_epr }).addBox(
    [-MSL_length, -15 * MSL_width, 0],
    [MSL_length, 15 * MSL_width + stub_length, substrate_thickness]
  );

  // --- PEC metal (for MSL ports and stub) ---
  const pec = sim.addMetal('PEC');

  // --- MSL Ports ---
  // Port 1: excited, from -MSL_length to 0
  const port1 = sim.addMSLPort({
    portNr: 1,
    metalProp: 'PEC',
    start: [-MSL_length, -MSL_width / 2, substrate_thickness],
    stop: [0, MSL_width / 2, 0],
    propDir: 0, // x
    excDir: 2,  // z
    excite: -1,
    priority: 10,
    feedShift: 10 * resolution,
    measPlaneShift: MSL_length / 3,
  });

  // Port 2: passive, from MSL_length to 0
  const port2 = sim.addMSLPort({
    portNr: 2,
    metalProp: 'PEC',
    start: [MSL_length, -MSL_width / 2, substrate_thickness],
    stop: [0, MSL_width / 2, 0],
    propDir: 0, // x
    excDir: 2,  // z
    priority: 10,
    measPlaneShift: MSL_length / 3,
  });

  // --- Filter stub ---
  pec.addBox(
    [-MSL_width / 2, MSL_width / 2, substrate_thickness],
    [MSL_width / 2, MSL_width / 2 + stub_length, substrate_thickness],
    10
  );

  // --- Run simulation ---
  console.log('Running MSL Notch Filter simulation...');
  const t0 = Date.now();
  const { module: M, ems, simPath } = await sim.runDirect({ engineType: 2 });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Simulation complete in ${elapsed}s.`);

  // --- Post-processing ---
  const freq = linspace(1e6, f_max, 1601);

  port1.calcPort(ems, simPath, freq, 50);
  port2.calcPort(ems, simPath, freq, 50);

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

  const s11_dB = new Float64Array(freq.length);
  const s21_dB = new Float64Array(freq.length);
  for (let i = 0; i < freq.length; i++) {
    s11_dB[i] = 20 * Math.log10(Math.max(s11_mag[i], 1e-15));
    s21_dB[i] = 20 * Math.log10(Math.max(s21_mag[i], 1e-15));
  }

  // Clean up (don't call sim.destroy() — runDirect transfers CSX ownership to openEMS)
  ems.delete();

  return { freq, s11_dB, s21_dB };
}
