/**
 * Phase 2 API tests: TypeScript-style API over the WASM module.
 * Tests the Simulation class, LumpedPort, and analysis utilities.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

import { C0, MUE0, EPS0, Z0, linspace, dftTime2Freq, dftMagnitude, complexDivide, complexAbs, parseProbe, findPeaks, calcSParam } from '../src/analysis.mjs';
import { Simulation } from '../src/simulation.mjs';
import { LumpedPort, MSLPort, WaveguidePort, RectWGPort } from '../src/ports.mjs';
import { createNF2FFBox, NF2FFBox, NF2FFResult, computeNF2FF, readNF2FFSurfaceData } from '../src/nf2ff.mjs';
import { computeLocalSAR, computeAveragedSAR, findPeakSAR } from '../src/sar.mjs';
import { meshHintFromBox, meshCombine, meshEstimateCflTimestep, smoothMeshLines } from '../src/automesh.mjs';
import { prepareSParamData, prepareSmithData, prepareRadiationPattern, prepareImpedanceData, prepareTimeDomainData } from '../src/visualization.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
    return false;
  }
  console.log(`  PASS: ${msg}`);
  passed++;
  return true;
}

// -----------------------------------------------------------------------
// Test 1: Physical constants
// -----------------------------------------------------------------------
function testConstants() {
  console.log('\n=== Test: Physical Constants ===');

  assert(Math.abs(C0 - 299792458) < 1, `C0 = ${C0}`);
  assert(Math.abs(Z0 - 376.73) < 0.1, `Z0 = ${Z0.toFixed(2)} (expected ~376.73)`);
  assert(Math.abs(MUE0 - 1.2566370614e-6) < 1e-12, `MUE0 = ${MUE0}`);
  assert(Math.abs(EPS0 - 8.854187817e-12) < 1e-18, `EPS0 = ${EPS0}`);
  assert(Math.abs(C0 - 1 / Math.sqrt(MUE0 * EPS0)) < 1, 'C0 = 1/sqrt(MUE0*EPS0)');
}

// -----------------------------------------------------------------------
// Test 2: Analysis utilities (linspace, DFT, parsing)
// -----------------------------------------------------------------------
function testAnalysisUtils() {
  console.log('\n=== Test: Analysis Utilities ===');

  // linspace
  const ls = linspace(0, 10, 11);
  assert(ls.length === 11, `linspace(0,10,11) has 11 elements`);
  assert(ls[0] === 0 && ls[10] === 10, `linspace endpoints correct`);
  assert(Math.abs(ls[5] - 5) < 1e-10, `linspace midpoint correct`);

  // DFT on known sinusoid
  const N = 1000;
  const dt = 1e-10;
  const fSig = 3.5e9;
  const time = new Float64Array(N);
  const vals = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    time[i] = i * dt;
    vals[i] = Math.sin(2 * Math.PI * fSig * time[i]);
  }

  const freqs = linspace(1e9, 5e9, 500);
  const mag = dftMagnitude(time, vals, freqs);
  let peakIdx = 0;
  for (let i = 1; i < mag.length; i++) {
    if (mag[i] > mag[peakIdx]) peakIdx = i;
  }
  const relErr = Math.abs(freqs[peakIdx] - fSig) / fSig;
  assert(relErr < 0.01, `DFT peak at ${(freqs[peakIdx] / 1e9).toFixed(3)} GHz (expected ${(fSig / 1e9).toFixed(1)} GHz, error ${(relErr * 100).toFixed(2)}%)`);

  // complexDivide: V/I should give impedance
  const Z0test = 75;
  const time2 = new Float64Array(N);
  const v = new Float64Array(N);
  const curr = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    time2[i] = i * dt;
    v[i] = Z0test * Math.sin(2 * Math.PI * 1e9 * time2[i]);
    curr[i] = Math.sin(2 * Math.PI * 1e9 * time2[i]);
  }
  const tf = linspace(0.5e9, 1.5e9, 100);
  const Vf = dftTime2Freq(time2, v, tf);
  const If = dftTime2Freq(time2, curr, tf);
  const Zr = complexDivide(Vf.re, Vf.im, If.re, If.im);
  const Zmag = complexAbs(Zr.re, Zr.im);

  // Find closest to 1 GHz
  let ci = 0;
  for (let i = 1; i < tf.length; i++) {
    if (Math.abs(tf[i] - 1e9) < Math.abs(tf[ci] - 1e9)) ci = i;
  }
  const zErr = Math.abs(Zmag[ci] - Z0test) / Z0test;
  assert(zErr < 0.05, `Impedance Z=${Zmag[ci].toFixed(2)} Ohm (expected ${Z0test}, error ${(zErr * 100).toFixed(1)}%)`);

  // parseProbe
  const sampleText = '% comment line\n0.0 1.0\n0.1 2.0\n0.2 3.0\n';
  const probe = parseProbe(sampleText);
  assert(probe.time.length === 3, `parseProbe: 3 samples`);
  assert(probe.values[2] === 3.0, `parseProbe: last value = 3.0`);

  // findPeaks
  const s = new Float64Array([0, 1, 3, 2, 0, 0, 5, 0, 0]);
  const f = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const peaks = findPeaks(f, s, 0.5);
  assert(peaks.length === 2, `findPeaks: found ${peaks.length} peaks (expected 2)`);
  assert(peaks[0].freq === 7 && peaks[0].amplitude === 5, `findPeaks: highest peak at f=7`);
}

// -----------------------------------------------------------------------
// Test 3: Simulation XML generation
// -----------------------------------------------------------------------
function testSimulationXML() {
  console.log('\n=== Test: Simulation XML Generation ===');

  const sim = new Simulation({ nrTS: 10000, endCriteria: 1e-6 });
  sim.setExcitation({ type: 'gauss', f0: 5e9, fc: 4e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);

  const a = 0.05, b = 0.02, d = 0.06;
  const nx = 26, ny = 11, nz = 32;
  const xLines = Array.from(linspace(0, a, nx));
  const yLines = Array.from(linspace(0, b, ny));
  const zLines = Array.from(linspace(0, d, nz));
  sim.setGrid(1, xLines, yLines, zLines);

  // Add a metal box
  const metal = sim.addMetal('cavity_walls');
  metal.addBox([0, 0, 0], [a, b, d], 10);

  // Add a probe
  sim.addProbe('ut1z', 0, [0.01, 0.01, 0.01], [0.01, 0.01, 0.012]);

  const xml = sim.toXML();

  assert(xml.includes('<?xml version="1.0"'), 'XML has declaration');
  assert(xml.includes('<openEMS>'), 'XML has openEMS root');
  assert(xml.includes('NumberOfTimesteps="10000"'), 'XML has NrTS=10000');
  assert(xml.includes('endCriteria="0.000001"'), 'XML has endCriteria');
  assert(xml.includes('Type="0"'), 'XML has Gaussian excitation (Type=0)');
  assert(xml.includes('f0="5000000000"'), 'XML has f0');
  assert(xml.includes('fc="4000000000"'), 'XML has fc');
  assert(xml.includes('xmin="0"'), 'XML has PEC boundary xmin');
  assert(xml.includes('<Metal ID="0" Name="cavity_walls"'), 'XML has metal property');
  assert(xml.includes('<P1 X="0"'), 'XML has P1');
  assert(xml.includes('<P2 X="0.05"'), 'XML has P2');
  assert(xml.includes('<ProbeBox'), 'XML has probe');
  assert(xml.includes('Name="ut1z"'), 'XML has probe name');
  assert(xml.includes('<XLines>'), 'XML has grid X');
  assert(xml.includes('<YLines>'), 'XML has grid Y');
  assert(xml.includes('<ZLines>'), 'XML has grid Z');
  assert(xml.includes('DeltaUnit="1"'), 'XML has DeltaUnit');
}

// -----------------------------------------------------------------------
// Test 4: Simulation XML with PML boundaries
// -----------------------------------------------------------------------
function testSimulationPML() {
  console.log('\n=== Test: PML Boundary XML ===');

  const sim = new Simulation({ nrTS: 1000, endCriteria: 1e-4 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PML_8', 'PML_8', 'PML_8', 'PML_8', 'PML_8', 'PML_8']);
  sim.setGrid(1e-3, [0, 10, 20], [0, 10, 20], [0, 10, 20]);

  const xml = sim.toXML();

  assert(xml.includes('xmin="3"'), 'PML boundary type=3');
  assert(xml.includes('PML_xmin="8"'), 'PML size xmin=8');
  assert(xml.includes('PML_zmax="8"'), 'PML size zmax=8');
}

// -----------------------------------------------------------------------
// Test 5: Simulation XML with different excitation types
// -----------------------------------------------------------------------
function testExcitationTypes() {
  console.log('\n=== Test: Excitation Types XML ===');

  const sim1 = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim1.setGrid(1, [0, 1], [0, 1], [0, 1]);

  // Sinus
  sim1.setExcitation({ type: 'sinus', f0: 2.4e9 });
  sim1.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  let xml = sim1.toXML();
  assert(xml.includes('Type="1"'), 'Sinus excitation Type=1');
  assert(xml.includes('f0="2400000000"'), 'Sinus f0');

  // Dirac
  sim1.setExcitation({ type: 'dirac', fmax: 10e9 });
  xml = sim1.toXML();
  assert(xml.includes('Type="2"'), 'Dirac excitation Type=2');

  // Step
  sim1.setExcitation({ type: 'step', fmax: 5e9 });
  xml = sim1.toXML();
  assert(xml.includes('Type="3"'), 'Step excitation Type=3');

  // Custom
  sim1.setExcitation({ type: 'custom', func: 'sin(2*pi*1e9*t)', f0: 1e9, fmax: 2e9 });
  xml = sim1.toXML();
  assert(xml.includes('Type="10"'), 'Custom excitation Type=10');
  assert(xml.includes('Function="sin(2*pi*1e9*t)"'), 'Custom function string');
}

// -----------------------------------------------------------------------
// Test 6: LumpedPort XML generation
// -----------------------------------------------------------------------
function testLumpedPortXML() {
  console.log('\n=== Test: LumpedPort XML Generation ===');

  const sim = new Simulation({ nrTS: 5000, endCriteria: 1e-5 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1e-3, [0, 5, 10], [0, 5, 10], [0, 5, 10]);

  const port = sim.addLumpedPort({
    portNr: 1,
    R: 50,
    start: [0, 0, 0],
    stop: [0, 0, 0.01],
    excDir: 2,
    excite: 1,
  });

  assert(port instanceof LumpedPort, 'addLumpedPort returns LumpedPort');
  assert(port.R === 50, 'Port R = 50');
  assert(port.excDir === 2, 'Port excDir = 2 (z)');
  assert(port.number === 1, 'Port number = 1');
  assert(port.U_filenames.length === 1, 'Port has 1 voltage probe filename');
  assert(port.I_filenames.length === 1, 'Port has 1 current probe filename');

  const xml = sim.toXML();

  assert(xml.includes('LumpedElement'), 'XML has LumpedElement');
  assert(xml.includes('R="50"'), 'XML has R=50');
  assert(xml.includes('Direction="2"'), 'XML has Direction=2');
  assert(xml.includes('Excite='), 'XML has Excitation for port');
  assert(xml.includes('Type="0" Weight="-1"'), 'XML has voltage probe (Type=0, Weight=-1)');
  assert(xml.includes('Type="1"'), 'XML has current probe (Type=1)');
}

// -----------------------------------------------------------------------
// Test 7: LumpedPort with R=0 (metal short)
// -----------------------------------------------------------------------
function testLumpedPortMetalShort() {
  console.log('\n=== Test: LumpedPort Metal Short (R=0) ===');

  const port = new LumpedPort({
    portNr: 2,
    R: 0,
    start: [0, 0, 0],
    stop: [0, 0, 0.005],
    excDir: 2,
    excite: 0,
  });

  const xml = port.toXML();
  assert(xml.includes('<Metal'), 'R=0 generates Metal element');
  assert(!xml.includes('LumpedElement'), 'R=0 does not generate LumpedElement');
  assert(!xml.includes('Excite='), 'excite=0 does not generate Excitation');
}

// -----------------------------------------------------------------------
// Test 8: Material property XML
// -----------------------------------------------------------------------
function testMaterialXML() {
  console.log('\n=== Test: Material Property XML ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const mat = sim.addMaterial('substrate', { epsilon: 4.6, kappa: 0.01 });
  mat.addBox([0, 0, 0], [1, 1, 0.5], 5);

  const xml = sim.toXML();
  assert(xml.includes('<Material ID="0" Name="substrate"'), 'XML has Material');
  assert(xml.includes('Epsilon="4.6"'), 'XML has Epsilon=4.6');
  assert(xml.includes('Kappa="0.01"'), 'XML has Kappa=0.01');
}

// -----------------------------------------------------------------------
// Test 9: Cylinder primitive XML
// -----------------------------------------------------------------------
function testCylinderXML() {
  console.log('\n=== Test: Cylinder Primitive XML ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal = sim.addMetal('conductor');
  metal.addCylinder([0, 0, 0], [0, 0, 1], 0.005, 10);

  const xml = sim.toXML();
  assert(xml.includes('<Cylinder Priority="10" Radius="0.005"'), 'XML has Cylinder with Radius attribute');
}

// -----------------------------------------------------------------------
// Test 10: WASM Cavity simulation via Simulation class
// -----------------------------------------------------------------------
async function testWasmCavityViaAPI() {
  console.log('\n=== Test: WASM Cavity via Simulation API ===');

  let createOpenEMS;
  try {
    const moduleFactory = await import(join(ROOT, 'build-wasm/openems.js'));
    createOpenEMS = moduleFactory.default || moduleFactory;
  } catch (e) {
    console.log(`  SKIP: WASM module not available (${e.message})`);
    return;
  }

  const a = 5e-2, b = 2e-2, d = 6e-2;
  const nx = 26, ny = 11, nz = 32;
  const fStart = 1e9, fStop = 10e9;
  const f0 = (fStop + fStart) / 2;
  const fc = (fStop - fStart) / 2;

  const sim = new Simulation({ nrTS: 20000, endCriteria: 1e-6 });
  sim.setExcitation({ type: 'gauss', f0, fc });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);

  const xLines = Array.from(linspace(0, a, nx));
  const yLines = Array.from(linspace(0, b, ny));
  const zLines = Array.from(linspace(0, d, nz));
  sim.setGrid(1, xLines, yLines, zLines);

  // Add excitation point (curve-like: use a box at a point)
  const exIdxX = Math.floor(nx * 2 / 3);
  const exIdxY = Math.floor(ny * 2 / 3);
  const exIdxZ = Math.floor(nz * 2 / 3);

  // We need to add excitation as a property with a box
  const excProp = {
    type: 'Excitation',
    name: 'excite1',
    attrs: { Number: 0, Type: 0, Excite: '1,1,1' },
    primitives: [{
      type: 'Box',
      start: [xLines[exIdxX], yLines[exIdxY], zLines[exIdxZ]],
      stop: [xLines[exIdxX + 1], yLines[exIdxY + 1], zLines[exIdxZ + 1]],
      priority: 0,
    }],
  };
  sim._properties.push(excProp);

  // Add probe
  const prX = xLines[Math.floor(nx / 4)];
  const prY = yLines[Math.floor(ny / 2)];
  const prZIdx = Math.floor(nz / 5);
  sim.addProbe('ut1z', 0, [prX, prY, zLines[prZIdx]], [prX, prY, zLines[prZIdx + 1]]);

  // Generate and verify XML
  const xml = sim.toXML();
  assert(xml.includes('NumberOfTimesteps="20000"'), 'Cavity XML has 20000 timesteps');
  assert(xml.includes('Name="ut1z"'), 'Cavity XML has probe');

  // Run via WASM
  console.log('  Running FDTD simulation via Simulation API...');
  const t0 = Date.now();
  const { module: Module, ems, simPath } = await sim.run(createOpenEMS);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Simulation complete in ${elapsed}s.`);

  // Read probe data
  const files = ems.listFiles(simPath);
  const fileList = [];
  for (let i = 0; i < files.size(); i++) fileList.push(files.get(i));
  console.log(`  Files: ${fileList.join(', ')}`);

  const probeFile = fileList.find(f => f.startsWith('ut1z') && !f.includes('FD'));
  assert(probeFile !== undefined, 'Probe output file found');

  if (probeFile) {
    const probeText = ems.readFile(`${simPath}/${probeFile}`);
    const probe = parseProbe(probeText);
    assert(probe.time.length > 100, `Probe has ${probe.time.length} samples`);

    let hasNonZero = false;
    for (let i = 0; i < probe.values.length; i++) {
      if (probe.values[i] !== 0) { hasNonZero = true; break; }
    }
    assert(hasNonZero, 'Probe has non-zero values');

    if (hasNonZero) {
      // Spectral analysis
      const dt = probe.time[1] - probe.time[0];
      const NFFT = Math.pow(2, Math.ceil(Math.log2(probe.time.length)));
      const df = 1 / (NFFT * dt);
      const nFreqs = Math.ceil((fStop - fStart) / df);
      const freqs = new Float64Array(nFreqs);
      for (let i = 0; i < nFreqs; i++) freqs[i] = fStart + i * df;

      const spectrum = dftMagnitude(probe.time, probe.values, freqs);
      const globalMax = Math.max(...spectrum);
      const normSpectrum = new Float64Array(spectrum.length);
      for (let i = 0; i < spectrum.length; i++) normSpectrum[i] = spectrum[i] / globalMax;

      const peaks = findPeaks(freqs, normSpectrum, 0.1);
      console.log(`  Spectrum: ${peaks.length} peaks above 10%`);
      for (const p of peaks.slice(0, 5)) {
        console.log(`    f=${(p.freq / 1e9).toFixed(4)} GHz, amplitude=${p.amplitude.toFixed(4)}`);
      }

      // Validate against analytical cavity modes
      function cavityModeFreq(m, n, l) {
        return C0 / (2 * Math.PI) * Math.sqrt(
          (m * Math.PI / a) ** 2 +
          (n * Math.PI / b) ** 2 +
          (l * Math.PI / d) ** 2
        );
      }

      const tm110 = cavityModeFreq(1, 1, 0);
      const te101 = cavityModeFreq(1, 0, 1);

      let matchedModes = 0;
      for (const peak of peaks) {
        for (const [mode, fAna] of [['TE101', te101], ['TM110', tm110]]) {
          const relError = Math.abs(peak.freq - fAna) / fAna;
          if (relError < 0.01 && peak.amplitude > 0.15) {
            matchedModes++;
            console.log(`  Matched ${mode}: simulated ${(peak.freq / 1e9).toFixed(4)} GHz vs analytical ${(fAna / 1e9).toFixed(4)} GHz (error ${(relError * 100).toFixed(2)}%)`);
          }
        }
      }
      assert(matchedModes >= 1, `At least 1 resonance mode matched (found ${matchedModes})`);
    }
  }

  ems.delete();
}

// -----------------------------------------------------------------------
// Test 11: WASM Coaxial line with LumpedPort
// -----------------------------------------------------------------------
async function testWasmCoaxWithPort() {
  console.log('\n=== Test: WASM Coax with LumpedPort ===');

  let createOpenEMS;
  try {
    const moduleFactory = await import(join(ROOT, 'build-wasm/openems.js'));
    createOpenEMS = moduleFactory.default || moduleFactory;
  } catch (e) {
    console.log(`  SKIP: WASM module not available (${e.message})`);
    return;
  }

  // Coaxial line geometry (from reference fixture)
  const unit = 1e-3; // mm
  const rInner = 100;  // mm (scaled)
  const rOuter = 230;
  const rShield = 240;
  const length = 1000;

  // Actually, for a quick test, use a smaller coax to keep simulation fast
  // Use a realistic coax: inner radius 0.5mm, outer radius 1.15mm (Z0 ~ 50 Ohm)
  const r_i = 0.5;   // mm
  const r_o = 1.15;   // mm (gives Z0 ~ 50 * ln(1.15/0.5) / (2*pi) ... actually Z0 = 60/sqrt(er) * ln(r_o/r_i))
  // For air-filled: Z0 = 60 * ln(r_o/r_i) = 60 * ln(2.3) = 60 * 0.833 = 50 Ohm
  const coaxLen = 50;  // mm

  // Build the simulation
  const sim = new Simulation({ nrTS: 10000, endCriteria: 1e-5 });
  sim.setExcitation({ type: 'gauss', f0: 0.5e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);

  // Grid in mm
  const meshR = [];
  for (let r = 0; r <= r_o + 0.5; r += 0.05) meshR.push(r);
  // Symmetric in x and y
  const xLines = [];
  const yLines = [];
  for (const r of meshR) {
    if (r > 0) {
      xLines.push(r);
      xLines.push(-r);
      yLines.push(r);
      yLines.push(-r);
    } else {
      xLines.push(0);
      yLines.push(0);
    }
  }
  xLines.sort((a, b) => a - b);
  yLines.sort((a, b) => a - b);
  // Remove duplicates
  const uniqueX = [...new Set(xLines)].sort((a, b) => a - b);
  const uniqueY = [...new Set(yLines)].sort((a, b) => a - b);

  const zLines = [];
  const nz = 50;
  for (let i = 0; i <= nz; i++) zLines.push(i * coaxLen / nz);

  sim.setGrid(unit, uniqueX, uniqueY, zLines);

  // Add outer conductor (metal cylinder shell)
  const shield = sim.addMetal('shield');
  shield.addCylinder([0, 0, 0], [0, 0, coaxLen], r_o, 10);

  // Add a lumped port at z=0 face, exciting in z direction
  const port = sim.addLumpedPort({
    portNr: 1,
    R: 50,
    start: [-r_i, -r_i, 0],
    stop: [r_i, r_i, zLines[1]],
    excDir: 2,
    excite: 1,
    priority: 5,
  });

  assert(port.R === 50, 'Coax port R = 50');
  assert(port.U_filenames.length === 1, 'Port has voltage probe');
  assert(port.I_filenames.length === 1, 'Port has current probe');

  // Generate XML and verify
  const xml = sim.toXML();
  assert(xml.includes('LumpedElement'), 'Coax XML has LumpedElement');
  assert(xml.includes('R="50"'), 'Coax XML has R=50');
  assert(xml.includes('<Cylinder'), 'Coax XML has Cylinder');

  console.log('  Coax XML generated successfully');
  console.log(`  Grid: ${uniqueX.length}x${uniqueY.length}x${zLines.length} = ${uniqueX.length * uniqueY.length * zLines.length} cells`);

  // Run simulation (this may be slow for a fine mesh)
  // For unit tests, we just verify the XML generation and port setup are correct.
  // The full WASM run is tested in testWasmCavityViaAPI above.
  console.log('  SKIP: Full coax WASM run omitted for speed (XML and port setup verified)');
}

// -----------------------------------------------------------------------
// Test 12: Port calcPort with fixture data
// -----------------------------------------------------------------------
function testPortCalcWithFixture() {
  console.log('\n=== Test: Port calcPort with Fixture Data ===');

  // Load coax fixture reference
  let ref;
  try {
    // Read just enough to get the structure
    ref = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/coax/reference.json'), 'utf8'));
  } catch (e) {
    console.log(`  SKIP: Coax fixture not available (${e.message})`);
    return;
  }

  // Check fixture has voltage data
  let vtHasSignal = false;
  for (const v of ref.probe_ut1.voltage) {
    if (v !== 0) { vtHasSignal = true; break; }
  }
  if (!vtHasSignal) {
    console.log('  SKIP: Coax fixture has zero signal');
    return;
  }

  // Manually compute what calcPort would do (using fixture data directly)
  const vTime = new Float64Array(ref.probe_ut1.time_s);
  const vVals = new Float64Array(ref.probe_ut1.voltage);
  const iTime = new Float64Array(ref.probe_it1.time_s);
  const iVals = new Float64Array(ref.probe_it1.voltage);

  const freqs = linspace(0.1e9, 0.5e9, 200);
  const Vf = dftTime2Freq(vTime, vVals, freqs);
  const If = dftTime2Freq(iTime, iVals, freqs);

  // Z = V/I
  const Z = complexDivide(Vf.re, Vf.im, If.re, If.im);
  const Zmag = complexAbs(Z.re, Z.im);

  const Z0_expected = ref.Z0_analytical_ohm;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < Zmag.length; i++) {
    if (Zmag[i] < minZ) minZ = Zmag[i];
    if (Zmag[i] > maxZ) maxZ = Zmag[i];
  }

  const upperLimit = Z0_expected * (1 + ref.tolerances.upper_error);
  const lowerLimit = Z0_expected * (1 - ref.tolerances.lower_error);

  let allInRange = true;
  for (let i = 0; i < Zmag.length; i++) {
    if (Zmag[i] > upperLimit || Zmag[i] < lowerLimit) { allInRange = false; break; }
  }

  assert(
    allInRange,
    `Impedance Z0 in [${lowerLimit.toFixed(2)}, ${upperLimit.toFixed(2)}] Ohm (actual: ${minZ.toFixed(2)} - ${maxZ.toFixed(2)})`
  );

  // Test incident/reflected decomposition
  const Zref = 50;
  const nf = freqs.length;

  // uf_inc = 0.5 * (V + I*Zref)
  const uf_inc_re = new Float64Array(nf);
  const uf_inc_im = new Float64Array(nf);
  const uf_ref_re = new Float64Array(nf);
  const uf_ref_im = new Float64Array(nf);
  for (let i = 0; i < nf; i++) {
    uf_inc_re[i] = 0.5 * (Vf.re[i] + If.re[i] * Zref);
    uf_inc_im[i] = 0.5 * (Vf.im[i] + If.im[i] * Zref);
    uf_ref_re[i] = Vf.re[i] - uf_inc_re[i];
    uf_ref_im[i] = Vf.im[i] - uf_inc_im[i];
  }

  // S11 = uf_ref / uf_inc
  const S11 = complexDivide(uf_ref_re, uf_ref_im, uf_inc_re, uf_inc_im);
  const S11mag = complexAbs(S11.re, S11.im);

  // For a well-matched coax with Z0 ~ 50 Ohm, S11 should be very small
  let maxS11 = 0;
  for (let i = 0; i < S11mag.length; i++) {
    if (S11mag[i] > maxS11) maxS11 = S11mag[i];
  }
  const s11dB = 20 * Math.log10(Math.max(maxS11, 1e-15));

  assert(s11dB < -10, `S11 max = ${s11dB.toFixed(1)} dB (should be < -10 dB for ~50 Ohm line with Zref=50)`);
}

// -----------------------------------------------------------------------
// Test 13: MSLPort XML generation and structure
// -----------------------------------------------------------------------
function testMSLPortXML() {
  console.log('\n=== Test: MSLPort XML Generation ===');

  const sim = new Simulation({ nrTS: 5000, endCriteria: 1e-5 });
  sim.setExcitation({ type: 'gauss', f0: 5e9, fc: 4e9 });
  sim.setBoundaryConditions(['PML_8', 'PML_8', 'PML_8', 'PML_8', 'PML_8', 'PML_8']);

  // Create a grid with enough lines in propagation direction (x)
  const xLines = [];
  for (let i = 0; i <= 20; i++) xLines.push(i * 0.5);
  const yLines = [0, 1, 2, 3, 4, 5];
  const zLines = [0, 0.5, 1, 1.5, 2];
  sim.setGrid(1e-3, xLines, yLines, zLines);

  const port = sim.addMSLPort({
    portNr: 1,
    metalProp: 'patch',
    start: [0, 0, 0],
    stop: [10, 5, 2],
    propDir: 0,
    excDir: 2,
    excite: 1,
    feedR: 50,
  });

  assert(port instanceof MSLPort, 'addMSLPort returns MSLPort');
  assert(port.number === 1, 'MSLPort number = 1');
  assert(port.propDir === 0, 'MSLPort propDir = 0 (x)');
  assert(port.excDir === 2, 'MSLPort excDir = 2 (z)');
  assert(port.U_filenames.length === 3, 'MSLPort has 3 voltage probe filenames');
  assert(port.I_filenames.length === 2, 'MSLPort has 2 current probe filenames');

  // Check filename suffixes
  assert(port.U_filenames[0].endsWith('A'), 'First voltage probe ends with A');
  assert(port.U_filenames[1].endsWith('B'), 'Second voltage probe ends with B');
  assert(port.U_filenames[2].endsWith('C'), 'Third voltage probe ends with C');
  assert(port.I_filenames[0].endsWith('A'), 'First current probe ends with A');
  assert(port.I_filenames[1].endsWith('B'), 'Second current probe ends with B');

  const xml = sim.toXML();
  assert(xml.includes('Metal'), 'MSLPort XML has Metal for MSL plane');
  assert(xml.includes('Excite='), 'MSLPort XML has Excitation');
  assert(xml.includes('LumpedElement'), 'MSLPort XML has LumpedElement for feed R');
  assert(xml.includes('R="50"'), 'MSLPort XML has R=50');

  // Count voltage probes (Type="0")
  const vProbeCount = (xml.match(/Type="0"/g) || []).length;
  assert(vProbeCount >= 3, `MSLPort XML has at least 3 voltage probe entries (found ${vProbeCount})`);

  // Count current probes (Type="1")
  const iProbeCount = (xml.match(/Type="1"/g) || []).length;
  assert(iProbeCount >= 2, `MSLPort XML has at least 2 current probe entries (found ${iProbeCount})`);
}

// -----------------------------------------------------------------------
// Test 14: MSLPort with feedR=0 (metal short) and feedR=Infinity (no feed)
// -----------------------------------------------------------------------
function testMSLPortFeedOptions() {
  console.log('\n=== Test: MSLPort Feed Options ===');

  // feedR=0: metal short
  const sim1 = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim1.setGrid(1e-3, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [0, 1, 2], [0, 1, 2]);
  sim1.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim1.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);

  const port1 = sim1.addMSLPort({
    portNr: 1, metalProp: 'patch', start: [0, 0, 0], stop: [10, 2, 2],
    propDir: 0, excDir: 2, excite: 0, feedR: 0,
  });
  const xml1 = sim1.toXML();
  // feedR=0 generates a Metal element as feed resistance (not LumpedElement)
  const metalCount = (xml1.match(/<Metal /g) || []).length;
  assert(metalCount >= 2, `feedR=0 generates Metal element for feed (found ${metalCount} Metal tags)`);

  // feedR=Infinity: no feed resistance element
  const sim2 = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim2.setGrid(1e-3, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [0, 1, 2], [0, 1, 2]);
  sim2.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim2.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);

  const port2 = sim2.addMSLPort({
    portNr: 2, metalProp: 'patch', start: [0, 0, 0], stop: [10, 2, 2],
    propDir: 0, excDir: 2, excite: 0, feedR: Infinity,
  });
  const xml2 = sim2.toXML();
  assert(!xml2.includes('LumpedElement'), 'feedR=Infinity does not generate LumpedElement');
}

// -----------------------------------------------------------------------
// Test 15: WaveguidePort XML generation
// -----------------------------------------------------------------------
function testWaveguidePortXML() {
  console.log('\n=== Test: WaveguidePort XML Generation ===');

  const port = new WaveguidePort({
    portNr: 1,
    start: [0, 0, 0],
    stop: [10, 20, 0.5],
    excDir: 2,
    E_func: ['sin(pi*x/10)', '0', '0'],
    H_func: ['0', 'sin(pi*x/10)', '0'],
    kc: 31.416,
    excite: 1,
  });

  assert(port instanceof WaveguidePort, 'WaveguidePort created');
  assert(port.kc === 31.416, 'WaveguidePort kc correct');
  assert(port.excDir === 2, 'WaveguidePort excDir = 2');
  assert(port.U_filenames.length === 1, 'WaveguidePort has 1 voltage probe');
  assert(port.I_filenames.length === 1, 'WaveguidePort has 1 current probe');

  const xml = port.toXML();
  assert(xml.includes('Type="10"'), 'WaveguidePort XML has mode-matched voltage probe (Type=10)');
  assert(xml.includes('Type="11"'), 'WaveguidePort XML has mode-matched current probe (Type=11)');
  assert(xml.includes('ModeFunction_0='), 'WaveguidePort XML has ModeFunction attributes');
  assert(xml.includes('Excite='), 'WaveguidePort XML has Excitation');
}

// -----------------------------------------------------------------------
// Test 16: RectWGPort XML generation and mode computation
// -----------------------------------------------------------------------
function testRectWGPortXML() {
  console.log('\n=== Test: RectWGPort XML Generation ===');

  // WR-90 waveguide: a=22.86mm, b=10.16mm, TE10 mode
  const a = 22.86e-3; // meters
  const b = 10.16e-3;
  const port = new RectWGPort({
    portNr: 1,
    start: [0, 0, 0],
    stop: [a, b, 0.01],
    excDir: 2,
    a,
    b,
    modeName: 'TE10',
    excite: 1,
  });

  assert(port instanceof RectWGPort, 'RectWGPort created');
  assert(port instanceof WaveguidePort, 'RectWGPort extends WaveguidePort');
  assert(port.a === a, 'RectWGPort a correct');
  assert(port.b === b, 'RectWGPort b correct');
  assert(port.modeName === 'TE10', 'RectWGPort mode = TE10');
  assert(port.M === 1, 'RectWGPort M = 1');
  assert(port.N === 0, 'RectWGPort N = 0');

  // Cutoff wavenumber for TE10: kc = pi/a
  const expectedKc = Math.PI / a;
  const kcErr = Math.abs(port.kc - expectedKc) / expectedKc;
  assert(kcErr < 1e-10, `RectWGPort kc = ${port.kc.toFixed(4)} (expected ${expectedKc.toFixed(4)})`);

  // Cutoff frequency: fc = c0 * kc / (2*pi) = c0 / (2*a)
  const fc = C0 * port.kc / (2 * Math.PI);
  const expectedFc = C0 / (2 * a);
  assert(Math.abs(fc - expectedFc) / expectedFc < 1e-10, `Cutoff freq = ${(fc / 1e9).toFixed(4)} GHz (expected ${(expectedFc / 1e9).toFixed(4)} GHz)`);

  const xml = port.toXML();
  assert(xml.includes('Type="10"'), 'RectWGPort XML has mode-matched voltage probe');
  assert(xml.includes('Type="11"'), 'RectWGPort XML has mode-matched current probe');

  // Test invalid mode
  let caught = false;
  try {
    new RectWGPort({ portNr: 2, start: [0, 0, 0], stop: [a, b, 0.01], excDir: 2, a, b, modeName: 'TM10', excite: 0 });
  } catch (e) {
    caught = true;
  }
  assert(caught, 'RectWGPort rejects TM modes');
}

// -----------------------------------------------------------------------
// Test 17: NF2FF box creation
// -----------------------------------------------------------------------
function testNF2FFBox() {
  console.log('\n=== Test: NF2FF Box Creation ===');

  const sim = new Simulation({ nrTS: 1000, endCriteria: 1e-4 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PML_8', 'PML_8', 'PML_8', 'PML_8', 'PML_8', 'PML_8']);
  sim.setGrid(1e-3, [-50, 0, 50], [-50, 0, 50], [-50, 0, 50]);

  const nf2ff = sim.createNF2FFBox('nf2ff_rec', [-40, -40, -40], [40, 40, 40]);

  assert(nf2ff instanceof NF2FFBox, 'createNF2FFBox returns NF2FFBox');
  assert(nf2ff.name === 'nf2ff_rec', 'NF2FF box name correct');
  assert(nf2ff.directions.length === 6, 'NF2FF has 6 directions');
  assert(nf2ff.directions.every(d => d === true), 'All directions enabled by default');
  assert(nf2ff.mirror.every(m => m === 0), 'No mirroring by default');

  const xml = sim.toXML();

  // Should have E and H dump boxes
  assert(xml.includes('nf2ff_rec_E'), 'NF2FF XML has E-field dump');
  assert(xml.includes('nf2ff_rec_H'), 'NF2FF XML has H-field dump');
  assert(xml.includes('DumpBox'), 'NF2FF XML has DumpBox elements');

  // Count DumpBox entries (should be 2: one E, one H)
  const dumpBoxCount = (xml.match(/<DumpBox /g) || []).length;
  assert(dumpBoxCount === 2, `NF2FF has 2 DumpBox properties (found ${dumpBoxCount})`);

  // Each DumpBox should have 6 box primitives (all 6 faces)
  // Total boxes in the dump section: 6 per dump * 2 dumps = 12
  // Count Box primitives within the XML
  const boxCount = (xml.match(/<Box Priority="0">/g) || []).length;
  assert(boxCount >= 12, `NF2FF has at least 12 face Box primitives (found ${boxCount})`);
}

// -----------------------------------------------------------------------
// Test 18: NF2FF with frequency-domain recording
// -----------------------------------------------------------------------
function testNF2FFFreqDomain() {
  console.log('\n=== Test: NF2FF Frequency-Domain ===');

  const sim = new Simulation({ nrTS: 1000, endCriteria: 1e-4 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const nf2ff = sim.createNF2FFBox('nf2ff_fd', [0, 0, 0], [1, 1, 1], {
    frequency: [1e9, 2e9],
  });

  assert(nf2ff.frequency !== null, 'NF2FF has frequency list');
  assert(nf2ff.frequency.length === 2, 'NF2FF has 2 frequencies');

  const xml = sim.toXML();
  assert(xml.includes('DumpType="10"'), 'FD NF2FF has DumpType=10 for E-field');
  assert(xml.includes('DumpType="11"'), 'FD NF2FF has DumpType=11 for H-field');
  assert(xml.includes('Frequency='), 'FD NF2FF has Frequency attribute');
}

// -----------------------------------------------------------------------
// Test 19: NF2FF calcNF2FF with surface data
// -----------------------------------------------------------------------
function testNF2FFCalcWithData() {
  console.log('\n=== Test: NF2FF calcNF2FF with Surface Data ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const nf2ff = sim.createNF2FFBox('test', [0, 0, 0], [1, 1, 1]);

  // Create minimal surface data (1 face, trivial fields)
  const nP = 3, nPP = 3;
  const nPts = nP * nPP;
  const zeros = new Float64Array(nPts * 2);
  const surfaceData = {
    faces: [{
      E: [new Float64Array(nPts * 2), new Float64Array(nPts * 2), zeros],
      H: [zeros, new Float64Array(nPts * 2), new Float64Array(nPts * 2)],
      mesh: { x: new Float64Array([0.5]), y: new Float64Array([0, 0.5, 1]), z: new Float64Array([0, 0.5, 1]) },
      normal: [1, 0, 0],
    }],
  };
  // Set some non-zero H-field to get non-zero Js
  for (let i = 0; i < nPts; i++) {
    surfaceData.faces[0].H[1][2 * i] = 1.0; // Hy_re = 1
    surfaceData.faces[0].H[2][2 * i] = 0.5; // Hz_re = 0.5
  }

  const theta = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, Math.PI];
  const phi = [0, Math.PI / 2];
  const result = nf2ff.calcNF2FF(surfaceData, 1e9, theta, phi);

  assert(result instanceof NF2FFResult, 'calcNF2FF returns NF2FFResult');
  assert(result.theta.length === 5, 'Result has 5 theta angles');
  assert(result.phi.length === 2, 'Result has 2 phi angles');
  assert(result.freq.length === 1, 'Result has 1 frequency');
  assert(result.E_norm[0].length === 10, 'E_norm has nTheta*nPhi elements');
  assert(typeof result.Dmax[0] === 'number', 'Dmax is a number');
  assert(typeof result.Prad[0] === 'number', 'Prad is a number');
}

// -----------------------------------------------------------------------
// Test 20: NF2FF with selective directions
// -----------------------------------------------------------------------
function testNF2FFDirections() {
  console.log('\n=== Test: NF2FF Selective Directions ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  // Only enable xmin and xmax faces
  const nf2ff = sim.createNF2FFBox('nf2ff_partial', [0, 0, 0], [1, 1, 1], {
    directions: [true, true, false, false, false, false],
  });

  assert(nf2ff.directions[0] === true, 'xmin enabled');
  assert(nf2ff.directions[2] === false, 'ymin disabled');

  const xml = sim.toXML();
  // With only 2 directions enabled, each dump should have 2 box primitives
  // Count the Box primitives
  const boxMatches = xml.match(/<Box Priority="0">/g) || [];
  // 2 faces * 2 dumps (E + H) = 4 box primitives total
  assert(boxMatches.length >= 4, `Partial NF2FF has at least 4 face boxes (found ${boxMatches.length})`);
}

// -----------------------------------------------------------------------
// Test 21: Automesh - meshHintFromBox
// -----------------------------------------------------------------------
function testMeshHintFromBox() {
  console.log('\n=== Test: meshHintFromBox ===');

  // Simple box, all directions
  const hint = meshHintFromBox([0, 0, 0], [10, 20, 30], 'xyz');
  assert(hint[0] !== null, 'x hints not null');
  assert(hint[1] !== null, 'y hints not null');
  assert(hint[2] !== null, 'z hints not null');
  assert(hint[0].includes(0) && hint[0].includes(10), 'x hints include start and stop');
  assert(hint[1].includes(0) && hint[1].includes(20), 'y hints include start and stop');
  assert(hint[2].includes(0) && hint[2].includes(30), 'z hints include start and stop');

  // Single direction
  const hintX = meshHintFromBox([5, 5, 5], [15, 25, 35], 'x');
  assert(hintX[0] !== null, 'x-only hint has x lines');
  assert(hintX[1] === null, 'x-only hint has null y');
  assert(hintX[2] === null, 'x-only hint has null z');

  // With metal edge resolution
  const hintMer = meshHintFromBox([0, 0, 0], [10, 20, 30], 'xyz', { metalEdgeRes: 1.0 });
  assert(hintMer[0].length === 4, `Metal edge res produces 4 x hints (found ${hintMer[0].length})`);
  // Should have lines near edges with offsets
  const xSorted = [...hintMer[0]].sort((a, b) => a - b);
  assert(xSorted[0] < 0, 'Metal edge res produces hint below start');
  assert(xSorted[xSorted.length - 1] > 10, 'Metal edge res produces hint above stop');

  // Zero-size dimension
  const hintFlat = meshHintFromBox([5, 5, 5], [5, 10, 10], 'xyz');
  assert(hintFlat[0].length === 1, 'Zero-size x has 1 hint (the point)');
  assert(hintFlat[0][0] === 5, 'Zero-size x hint is at the coordinate');
}

// -----------------------------------------------------------------------
// Test 22: Automesh - meshCombine
// -----------------------------------------------------------------------
function testMeshCombine() {
  console.log('\n=== Test: meshCombine ===');

  const m1 = [[1, 3, 5], [10, 20], null];
  const m2 = [[2, 4], null, [100, 200]];
  const combined = meshCombine(m1, m2);

  assert(combined[0].length === 5, 'Combined x has 5 elements');
  assert(combined[0][0] === 1 && combined[0][4] === 5, 'Combined x is sorted');
  assert(combined[1] !== null && combined[1].length === 2, 'Combined y from m1 only');
  assert(combined[2] !== null && combined[2].length === 2, 'Combined z from m2 only');

  // Both null
  const m3 = [null, null, null];
  const m4 = [null, null, null];
  const combined2 = meshCombine(m3, m4);
  assert(combined2[0] === null, 'null + null = null');
}

// -----------------------------------------------------------------------
// Test 23: Automesh - meshEstimateCflTimestep
// -----------------------------------------------------------------------
function testMeshCflTimestep() {
  console.log('\n=== Test: meshEstimateCflTimestep ===');

  // Uniform grid: dx=dy=dz=1mm
  const lines = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const dt = meshEstimateCflTimestep(lines, lines, lines, 1e-3);

  // Expected: dt = 1e-3 / (C0 * sqrt(3 * (1/1)^2)) = 1e-3 / (C0 * sqrt(3))
  const expected = 1e-3 / (C0 * Math.sqrt(3));
  const relErr = Math.abs(dt - expected) / expected;
  assert(relErr < 1e-10, `CFL timestep = ${dt.toExponential(4)} (expected ${expected.toExponential(4)}, error ${(relErr * 100).toFixed(6)}%)`);

  // Non-uniform grid
  const xFine = [0, 0.1, 0.2, 0.5, 1.0];
  const yCoarse = [0, 1, 2];
  const zCoarse = [0, 1, 2];
  const dt2 = meshEstimateCflTimestep(xFine, yCoarse, zCoarse, 1);

  // Min spacing: dx=0.1, dy=1, dz=1
  const expected2 = 1 / (C0 * Math.sqrt(1 / (0.1 * 0.1) + 1 / (1 * 1) + 1 / (1 * 1)));
  const relErr2 = Math.abs(dt2 - expected2) / expected2;
  assert(relErr2 < 1e-10, `CFL non-uniform timestep correct (error ${(relErr2 * 100).toFixed(6)}%)`);
}

// -----------------------------------------------------------------------
// Test 24: Automesh - smoothMeshLines
// -----------------------------------------------------------------------
function testSmoothMeshLines() {
  console.log('\n=== Test: smoothMeshLines ===');

  // Simple case with gap
  const lines = [0, 1, 5, 6];
  const smoothed = smoothMeshLines(lines, 2);
  assert(smoothed.length > lines.length, `smoothMeshLines added points (${lines.length} -> ${smoothed.length})`);

  // Check all gaps <= maxRes
  let maxGap = 0;
  for (let i = 1; i < smoothed.length; i++) {
    const gap = smoothed[i] - smoothed[i - 1];
    if (gap > maxGap) maxGap = gap;
  }
  assert(maxGap <= 2.0 + 1e-10, `Max gap after smoothing = ${maxGap.toFixed(4)} (should be <= 2.0)`);

  // Already smooth
  const alreadySmooth = [0, 1, 2, 3];
  const result = smoothMeshLines(alreadySmooth, 2);
  assert(result.length === 4, 'Already smooth lines unchanged');

  // Single point
  const single = smoothMeshLines([5], 1);
  assert(single.length === 1, 'Single point unchanged');
}

// -----------------------------------------------------------------------
// Test 25: Simulation addCylindricalShell
// -----------------------------------------------------------------------
function testCylindricalShellXML() {
  console.log('\n=== Test: CylindricalShell Primitive ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal = sim.addMetal('shield');
  sim.addCylindricalShell('shield', 10, [0, 0, 0], [0, 0, 1], 0.5, 0.01);

  const xml = sim.toXML();
  assert(xml.includes('<CylindricalShell'), 'XML has CylindricalShell');
  assert(xml.includes('Radius="0.5"'), 'CylindricalShell has Radius');
  assert(xml.includes('ShellWidth="0.01"'), 'CylindricalShell has ShellWidth');
  assert(xml.includes('Priority="10"'), 'CylindricalShell has priority');

  // Also test via fluent API
  const sim2 = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim2.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim2.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim2.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal2 = sim2.addMetal('pipe');
  metal2.addCylindricalShell([0, 0, 0], [0, 0, 1], 2.0, 0.1, 5);
  const xml2 = sim2.toXML();
  assert(xml2.includes('CylindricalShell'), 'Fluent API CylindricalShell works');
}

// -----------------------------------------------------------------------
// Test 26: Simulation addCurve
// -----------------------------------------------------------------------
function testCurveXML() {
  console.log('\n=== Test: Curve Primitive ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal = sim.addMetal('wire_path');
  sim.addCurve('wire_path', 5, [[0, 0, 0], [0.5, 0.5, 0], [1, 0.5, 0.5], [1, 1, 1]]);

  const xml = sim.toXML();
  assert(xml.includes('<Curve'), 'XML has Curve element');
  assert(xml.includes('Priority="5"'), 'Curve has priority');
  assert(xml.includes('<Vertex'), 'Curve has Vertex elements');

  // Count vertices
  const vertexCount = (xml.match(/<Vertex /g) || []).length;
  assert(vertexCount === 4, `Curve has 4 vertices (found ${vertexCount})`);

  // Also test via fluent API
  const sim2 = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim2.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim2.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim2.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal2 = sim2.addMetal('path2');
  metal2.addCurve([[0, 0, 0], [1, 1, 1]], 3);
  const xml2 = sim2.toXML();
  assert(xml2.includes('Curve'), 'Fluent API Curve works');
}

// -----------------------------------------------------------------------
// Test 27: WaveguidePort via Simulation methods
// -----------------------------------------------------------------------
function testSimWaveguidePort() {
  console.log('\n=== Test: Simulation WaveguidePort Methods ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 10e9, fc: 5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  // addWaveGuidePort
  const wgPort = sim.addWaveGuidePort({
    portNr: 1,
    start: [0, 0, 0],
    stop: [10, 20, 0.5],
    excDir: 2,
    E_func: ['sin(pi*x/10)', '0', '0'],
    H_func: ['0', 'sin(pi*x/10)', '0'],
    kc: Math.PI / 10,
    excite: 1,
  });
  assert(wgPort instanceof WaveguidePort, 'addWaveGuidePort returns WaveguidePort');

  // addRectWaveGuidePort
  const rwgPort = sim.addRectWaveGuidePort({
    portNr: 2,
    start: [0, 0, 0],
    stop: [22.86e-3, 10.16e-3, 0.01],
    excDir: 2,
    a: 22.86e-3,
    b: 10.16e-3,
    modeName: 'TE10',
    excite: 0,
  });
  assert(rwgPort instanceof RectWGPort, 'addRectWaveGuidePort returns RectWGPort');

  assert(sim.ports.length === 2, 'Simulation has 2 ports');

  const xml = sim.toXML();
  assert(xml.includes('Type="10"'), 'XML has WG voltage probe');
  assert(xml.includes('Type="11"'), 'XML has WG current probe');
}

// -----------------------------------------------------------------------
// Test 28: NF2FFResult class
// -----------------------------------------------------------------------
function testNF2FFResult() {
  console.log('\n=== Test: NF2FFResult Class ===');

  const result = new NF2FFResult({
    theta: new Float64Array([0, Math.PI / 4, Math.PI / 2]),
    phi: new Float64Array([0, Math.PI / 2]),
    r: 1.0,
    freq: [1e9],
    Dmax: [5.0],
    Prad: [0.1],
    E_theta: [new Float64Array(6)],
    E_phi: [new Float64Array(6)],
    E_norm: [new Float64Array(6)],
    E_cprh: [new Float64Array(6)],
    E_cplh: [new Float64Array(6)],
    P_rad: [new Float64Array(6)],
  });

  assert(result.theta.length === 3, 'NF2FFResult theta has 3 angles');
  assert(result.phi.length === 2, 'NF2FFResult phi has 2 angles');
  assert(result.r === 1.0, 'NF2FFResult r = 1.0');
  assert(result.Dmax[0] === 5.0, 'NF2FFResult Dmax = 5.0');
  assert(result.Prad[0] === 0.1, 'NF2FFResult Prad = 0.1');
}

// -----------------------------------------------------------------------
// Test 29: Sphere primitive XML
// -----------------------------------------------------------------------
function testSphereXML() {
  console.log('\n=== Test: Sphere Primitive ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal = sim.addMetal('ball');
  metal.addSphere([0.5, 0.5, 0.5], 0.25, 10);

  const xml = sim.toXML();
  assert(xml.includes('<Sphere Priority="10" Radius="0.25"'), 'XML has Sphere with Priority and Radius');
  assert(xml.includes('<Center X="0.5" Y="0.5" Z="0.5"/>'), 'Sphere has Center element');
  assert(xml.includes('</Sphere>'), 'Sphere has closing tag');
}

// -----------------------------------------------------------------------
// Test 30: SphericalShell primitive XML
// -----------------------------------------------------------------------
function testSphericalShellXML() {
  console.log('\n=== Test: SphericalShell Primitive ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal = sim.addMetal('shell');
  metal.addSphericalShell([0, 0, 0], 1.0, 0.05, 8);

  const xml = sim.toXML();
  assert(xml.includes('<SphericalShell Priority="8" Radius="1" ShellWidth="0.05"'), 'XML has SphericalShell with attributes');
  assert(xml.includes('<Center X="0" Y="0" Z="0"/>'), 'SphericalShell has Center');
  assert(xml.includes('</SphericalShell>'), 'SphericalShell has closing tag');
}

// -----------------------------------------------------------------------
// Test 31: Polygon primitive XML
// -----------------------------------------------------------------------
function testPolygonXML() {
  console.log('\n=== Test: Polygon Primitive ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal = sim.addMetal('patch');
  metal.addPolygon([[0, 0], [1, 0], [1, 1], [0, 1]], 2, 0.5, 10);

  const xml = sim.toXML();
  assert(xml.includes('<Polygon Priority="10" NormDir="2" Elevation="0.5"'), 'XML has Polygon with attributes');
  assert(xml.includes('<Vertex X="0" Y="0"/>'), 'Polygon has 2D Vertex');
  assert(xml.includes('</Polygon>'), 'Polygon has closing tag');

  // Count vertices
  const vertexCount = (xml.match(/<Vertex X=/g) || []).length;
  assert(vertexCount === 4, `Polygon has 4 vertices (found ${vertexCount})`);
}

// -----------------------------------------------------------------------
// Test 32: LinPoly primitive XML
// -----------------------------------------------------------------------
function testLinPolyXML() {
  console.log('\n=== Test: LinPoly Primitive ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal = sim.addMetal('extrusion');
  metal.addLinPoly([[0, 0], [1, 0], [0.5, 1]], 2, 0, 0.5, 5);

  const xml = sim.toXML();
  assert(xml.includes('<LinPoly Priority="5" NormDir="2" Elevation="0" Length="0.5"'), 'XML has LinPoly with attributes');
  assert(xml.includes('</LinPoly>'), 'LinPoly has closing tag');

  const vertexCount = (xml.match(/<Vertex X=/g) || []).length;
  assert(vertexCount === 3, `LinPoly has 3 vertices (found ${vertexCount})`);
}

// -----------------------------------------------------------------------
// Test 33: RotPoly primitive XML
// -----------------------------------------------------------------------
function testRotPolyXML() {
  console.log('\n=== Test: RotPoly Primitive ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal = sim.addMetal('revolved');
  metal.addRotPoly([[0.5, 0], [1, 0], [1, 1], [0.5, 1]], 2, 0, Math.PI, 7);

  const xml = sim.toXML();
  assert(xml.includes('<RotPoly Priority="7" NormDir="2" Elevation="0"'), 'XML has RotPoly with attributes');
  assert(xml.includes(`RotAngle="${Math.PI}"`), 'RotPoly has RotAngle');
  assert(xml.includes('</RotPoly>'), 'RotPoly has closing tag');

  const vertexCount = (xml.match(/<Vertex X=/g) || []).length;
  assert(vertexCount === 4, `RotPoly has 4 vertices (found ${vertexCount})`);
}

// -----------------------------------------------------------------------
// Test 34: Wire primitive XML
// -----------------------------------------------------------------------
function testWireXML() {
  console.log('\n=== Test: Wire Primitive ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 1], [0, 1], [0, 1]);

  const metal = sim.addMetal('antenna_wire');
  metal.addWire([[0, 0, 0], [0, 0, 0.5], [0.5, 0, 0.5]], 0.001, 10);

  const xml = sim.toXML();
  assert(xml.includes('<Wire Priority="10" WireRadius="0.001"'), 'XML has Wire with WireRadius');
  assert(xml.includes('</Wire>'), 'Wire has closing tag');

  // Wire uses 3D vertices
  const vertexCount = (xml.match(/<Vertex X=/g) || []).length;
  assert(vertexCount === 3, `Wire has 3 vertices (found ${vertexCount})`);
  assert(xml.includes('Z="0.5"'), 'Wire vertex has Z coordinate');
}

// -----------------------------------------------------------------------
// Test 35: smoothGrid method
// -----------------------------------------------------------------------
function testSmoothGrid() {
  console.log('\n=== Test: smoothGrid ===');

  const sim = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim.setGrid(1, [0, 10, 100], [0, 5, 50], [0, 1, 2]);

  // Before smoothing
  const xBefore = sim._grid.x.length;
  const yBefore = sim._grid.y.length;
  const zBefore = sim._grid.z.length;

  sim.smoothGrid(5);

  assert(sim._grid.x.length > xBefore, `smoothGrid added x lines (${xBefore} -> ${sim._grid.x.length})`);
  assert(sim._grid.y.length > yBefore, `smoothGrid added y lines (${yBefore} -> ${sim._grid.y.length})`);
  assert(sim._grid.z.length === zBefore, `smoothGrid left z unchanged (gap=1 <= maxRes=5)`);

  // Check all gaps <= maxRes
  for (let i = 1; i < sim._grid.x.length; i++) {
    const gap = sim._grid.x[i] - sim._grid.x[i - 1];
    assert(gap <= 5 + 1e-10, `x gap ${gap} <= 5`);
  }

  // Test with per-axis maxRes
  const sim2 = new Simulation({ nrTS: 100, endCriteria: 1e-3 });
  sim2.setExcitation({ type: 'gauss', f0: 1e9, fc: 0.5e9 });
  sim2.setBoundaryConditions(['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC']);
  sim2.setGrid(1, [0, 100], [0, 100], [0, 100]);
  sim2.smoothGrid([10, 20, 50]);

  assert(sim2._grid.x.length > sim2._grid.y.length, 'Per-axis: x has more lines than y (finer res)');
  assert(sim2._grid.y.length > sim2._grid.z.length, 'Per-axis: y has more lines than z (finer res)');
}

// -----------------------------------------------------------------------
// Test 36: readFromXML stub throws
// -----------------------------------------------------------------------
function testReadFromXMLStub() {
  console.log('\n=== Test: readFromXML Stub ===');

  const sim = new Simulation();
  let threw = false;
  let msg = '';
  try {
    sim.readFromXML('<openEMS/>');
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  assert(threw, 'readFromXML throws');
  assert(msg.includes('Not yet implemented'), `readFromXML error message: "${msg}"`);
}

// -----------------------------------------------------------------------
// Test 37: Visualization - prepareSParamData
// -----------------------------------------------------------------------
function testPrepareSParamData() {
  console.log('\n=== Test: prepareSParamData ===');

  const n = 10;
  const freq = new Float64Array(n);
  for (let i = 0; i < n; i++) freq[i] = (i + 1) * 1e9;

  // Mock port: perfect reflection (uf_ref = uf_inc) => S11 = 0 dB
  const port = {
    uf_ref_re: new Float64Array(n).fill(1),
    uf_ref_im: new Float64Array(n).fill(0),
    uf_inc_re: new Float64Array(n).fill(1),
    uf_inc_im: new Float64Array(n).fill(0),
  };

  const result = prepareSParamData([port], freq);
  assert(result.freq.length === n, 'prepareSParamData has freq array');
  assert(result.s11_dB !== undefined, 'prepareSParamData has s11_dB');
  assert(Math.abs(result.s11_dB[0] - 0) < 0.01, `S11 = ${result.s11_dB[0].toFixed(2)} dB (expected 0 dB for perfect reflection)`);

  // Mock port: no reflection => S11 << 0 dB
  const port2 = {
    uf_ref_re: new Float64Array(n).fill(1e-10),
    uf_ref_im: new Float64Array(n).fill(0),
    uf_inc_re: new Float64Array(n).fill(1),
    uf_inc_im: new Float64Array(n).fill(0),
  };
  const result2 = prepareSParamData([port2], freq);
  assert(result2.s11_dB[0] < -100, `S11 = ${result2.s11_dB[0].toFixed(1)} dB (expected << 0 dB)`);
}

// -----------------------------------------------------------------------
// Test 38: Visualization - prepareSmithData
// -----------------------------------------------------------------------
function testPrepareSmithData() {
  console.log('\n=== Test: prepareSmithData ===');

  const n = 5;
  const freq = new Float64Array(n);
  for (let i = 0; i < n; i++) freq[i] = (i + 1) * 1e9;

  const port = {
    uf_ref_re: new Float64Array([0.5, 0.3, 0.1, 0, -0.1]),
    uf_ref_im: new Float64Array([0, 0.1, 0.2, 0, -0.2]),
    uf_inc_re: new Float64Array(n).fill(1),
    uf_inc_im: new Float64Array(n).fill(0),
  };

  const result = prepareSmithData(port, freq);
  assert(result.gamma_re.length === n, 'Smith data has gamma_re');
  assert(result.gamma_im.length === n, 'Smith data has gamma_im');
  assert(result.freq.length === n, 'Smith data has freq');
  assert(Math.abs(result.gamma_re[0] - 0.5) < 1e-10, 'gamma_re[0] = 0.5');
  assert(Math.abs(result.gamma_im[1] - 0.1) < 1e-10, 'gamma_im[1] = 0.1');
}

// -----------------------------------------------------------------------
// Test 39: Visualization - prepareRadiationPattern
// -----------------------------------------------------------------------
function testPrepareRadiationPattern() {
  console.log('\n=== Test: prepareRadiationPattern ===');

  const nTheta = 5;
  const nPhi = 4;
  const theta = new Float64Array(nTheta);
  const phi = new Float64Array(nPhi);
  for (let i = 0; i < nTheta; i++) theta[i] = i * Math.PI / (nTheta - 1);
  for (let i = 0; i < nPhi; i++) phi[i] = i * Math.PI / 2;

  // E_norm: one value per (theta, phi) pair
  const E_norm = new Float64Array(nTheta * nPhi);
  for (let t = 0; t < nTheta; t++) {
    for (let p = 0; p < nPhi; p++) {
      E_norm[t * nPhi + p] = Math.sin(theta[t]); // dipole-like pattern
    }
  }

  const nf2ffResult = {
    theta, phi,
    E_norm: [E_norm],
  };

  // Phi cut at phi=0
  const phiCut = prepareRadiationPattern(nf2ffResult, 'phi', 0);
  assert(phiCut.angles.length === nTheta, 'Phi cut has nTheta angles');
  assert(phiCut.pattern_dB.length === nTheta, 'Phi cut has nTheta pattern values');
  assert(phiCut.pattern_dB[0] < -10, 'Pattern at theta=0 is low (end-fire null)');

  // Theta cut at theta=pi/2
  const thetaCut = prepareRadiationPattern(nf2ffResult, 'theta', Math.PI / 2);
  assert(thetaCut.angles.length === nPhi, 'Theta cut has nPhi angles');
  assert(thetaCut.pattern_dB.length === nPhi, 'Theta cut has nPhi pattern values');
}

// -----------------------------------------------------------------------
// Test 40: Visualization - prepareImpedanceData
// -----------------------------------------------------------------------
function testPrepareImpedanceData() {
  console.log('\n=== Test: prepareImpedanceData ===');

  const n = 5;
  const freq = new Float64Array(n);
  for (let i = 0; i < n; i++) freq[i] = (i + 1) * 1e9;

  // gamma = 0 => Z = Zref = 50 Ohm, VSWR = 1
  const port = {
    uf_ref_re: new Float64Array(n).fill(0),
    uf_ref_im: new Float64Array(n).fill(0),
    uf_inc_re: new Float64Array(n).fill(1),
    uf_inc_im: new Float64Array(n).fill(0),
    Z_ref: 50,
  };

  const result = prepareImpedanceData(port, freq);
  assert(result.freq.length === n, 'Impedance data has freq');
  assert(result.z_re.length === n, 'Impedance data has z_re');
  assert(result.z_im.length === n, 'Impedance data has z_im');
  assert(result.vswr.length === n, 'Impedance data has vswr');
  assert(Math.abs(result.z_re[0] - 50) < 0.01, `z_re = ${result.z_re[0].toFixed(2)} (expected 50)`);
  assert(Math.abs(result.z_im[0]) < 0.01, `z_im = ${result.z_im[0].toFixed(4)} (expected 0)`);
  assert(Math.abs(result.vswr[0] - 1) < 0.01, `VSWR = ${result.vswr[0].toFixed(4)} (expected 1.0)`);
}

// -----------------------------------------------------------------------
// Test 41: Visualization - prepareTimeDomainData
// -----------------------------------------------------------------------
function testPrepareTimeDomainData() {
  console.log('\n=== Test: prepareTimeDomainData ===');

  const probeData = {
    time: new Float64Array([0, 1e-9, 2e-9, 3e-9]),
    values: new Float64Array([0, 0.5, 1.0, 0.5]),
  };

  // ns conversion
  const result = prepareTimeDomainData(probeData, 'ns', 'voltage');
  assert(result.time.length === 4, 'Time domain data has 4 samples');
  assert(Math.abs(result.time[1] - 1.0) < 1e-10, `time[1] = ${result.time[1]} ns (expected 1.0)`);
  assert(result.values[2] === 1.0, 'values preserved');
  assert(result.label === 'voltage', 'label preserved');

  // us conversion
  const result2 = prepareTimeDomainData(probeData, 'us');
  assert(Math.abs(result2.time[1] - 0.001) < 1e-10, `time[1] = ${result2.time[1]} us (expected 0.001)`);

  // default (seconds)
  const result3 = prepareTimeDomainData(probeData);
  assert(result3.time[1] === 1e-9, 'Default unit is seconds');
}

// -----------------------------------------------------------------------
// Test 42: NF2FF Infinitesimal Dipole Radiation Pattern
// -----------------------------------------------------------------------
function testNF2FFInfinitesimalDipole() {
  console.log('\n=== Test: NF2FF Infinitesimal Dipole ===');

  // Test the NF2FF computation with a known x-directed current element.
  // An x-directed Js on a z-normal face produces:
  //   E_theta proportional to cos(theta)*cos(phi)
  //   E_phi proportional to -sin(phi)
  //   Dmax = 1.5 (when computed from angular integration)
  //
  // With n = [0,0,+1] (z-normal face):
  //   Js_x = -nz * Hy = -Hy  =>  set Hy = -Js0 for Js_x = Js0
  //
  // We test:
  // 1. Non-zero far-field output
  // 2. Pattern shape: null at (theta=pi/2, phi=0) for E_theta
  // 3. Directivity computed from angular integration ~ 1.5

  const freq = 1e9;
  const Js0 = 1.0;

  // Small 3x3 grid on z-normal face at z=0
  const meshX = new Float64Array([-0.001, 0, 0.001]);
  const meshY = new Float64Array([-0.001, 0, 0.001]);
  const meshZ = new Float64Array([0]);
  const nPts = 9;

  const face = {
    E: [new Float64Array(nPts * 2), new Float64Array(nPts * 2), new Float64Array(nPts * 2)],
    H: [new Float64Array(nPts * 2), new Float64Array(nPts * 2), new Float64Array(nPts * 2)],
    mesh: { x: meshX, y: meshY, z: meshZ },
    normal: [0, 0, 1],
  };

  for (let i = 0; i < nPts; i++) {
    face.H[1][2 * i] = -Js0; // Hy_re => Js_x = Js0
  }

  const surfaceData = { faces: [face] };

  const nTheta = 91;
  const nPhi = 73;
  const thetaArr = new Float64Array(nTheta);
  const phiArr = new Float64Array(nPhi);
  for (let i = 0; i < nTheta; i++) thetaArr[i] = i * Math.PI / (nTheta - 1);
  for (let i = 0; i < nPhi; i++) phiArr[i] = i * 2 * Math.PI / (nPhi - 1);

  const result = computeNF2FF(surfaceData, freq, thetaArr, phiArr, [0, 0, 0], 1);

  // 1. Non-zero far-field
  const p_max = Math.max(...result.P_rad);
  assert(p_max > 0, `NF2FF P_max = ${p_max.toExponential(4)} (non-zero far-field)`);

  // 2. Pattern shape: at phi=0 (phi index 0), E_theta ~ cos(theta)
  //    So P_rad at theta=pi/2, phi=0 should be near zero compared to theta=0
  const phi0Idx = 0;
  const theta0Idx = 0;
  const thetaPi2Idx = Math.floor(nTheta / 2); // theta = pi/2

  const p_at_pole = result.P_rad[theta0Idx * nPhi + phi0Idx];
  const p_at_equator_phi0 = result.P_rad[thetaPi2Idx * nPhi + phi0Idx];

  if (p_at_pole > 0) {
    const ratio = p_at_equator_phi0 / p_at_pole;
    // For x-dipole at phi=0: P ~ cos^2(theta), so P(pi/2)/P(0) should be ~0
    assert(ratio < 0.05, `Pattern null at (theta=pi/2, phi=0): ratio = ${ratio.toFixed(4)} (expected ~0)`);
  }

  // 3. Directivity from angular integration of P_rad
  //    Prad_integrated = integral of P_rad * sin(theta) dTheta dPhi / r^2
  //    Dmax = 4*pi * P_max / Prad_integrated
  let prad_int = 0;
  const dTheta = Math.PI / (nTheta - 1);
  const dPhi = 2 * Math.PI / (nPhi - 1);
  for (let tn = 0; tn < nTheta; tn++) {
    const sinT = Math.sin(thetaArr[tn]);
    for (let pn = 0; pn < nPhi; pn++) {
      prad_int += result.P_rad[tn * nPhi + pn] * sinT * dTheta * dPhi;
    }
  }

  const dmax_from_integral = prad_int > 0 ? 4 * Math.PI * p_max / prad_int : 0;
  assert(dmax_from_integral > 0, `NF2FF Dmax (from integral) = ${dmax_from_integral.toFixed(4)} (positive)`);

  const dmaxErr = Math.abs(dmax_from_integral - 1.5) / 1.5;
  assert(dmaxErr < 0.10, `NF2FF Dmax = ${dmax_from_integral.toFixed(4)} (expected ~1.5, error ${(dmaxErr * 100).toFixed(1)}%)`);

  console.log(`  Dmax (angular) = ${dmax_from_integral.toFixed(4)}, P_max = ${p_max.toExponential(4)}, Prad_int = ${prad_int.toExponential(4)}`);
}

// -----------------------------------------------------------------------
// Test 43: SAR Local with Uniform Field
// -----------------------------------------------------------------------
function testSARLocalUniform() {
  console.log('\n=== Test: SAR Local Uniform Field ===');

  // Uniform E-field with known sigma and density
  // SAR = 0.5 * sigma * |E|^2 / density
  const N = 27; // 3x3x3
  const sigma = 0.5;  // S/m
  const rho = 1000;   // kg/m^3
  const E_mag2 = 100;  // |E|^2 = 100 V^2/m^2

  const E = new Float64Array(N).fill(E_mag2);
  const conductivity = new Float32Array(N).fill(sigma);
  const density = new Float32Array(N).fill(rho);

  const SAR = computeLocalSAR(E, conductivity, density);

  const expected = 0.5 * sigma * E_mag2 / rho; // = 0.5 * 0.5 * 100 / 1000 = 0.025
  assert(SAR.length === N, `SAR has ${N} elements`);

  let allCorrect = true;
  for (let i = 0; i < N; i++) {
    if (Math.abs(SAR[i] - expected) > 1e-6) {
      allCorrect = false;
      break;
    }
  }
  assert(allCorrect, `Local SAR = ${SAR[0].toFixed(6)} W/kg (expected ${expected.toFixed(6)})`);
}

// -----------------------------------------------------------------------
// Test 44: SAR Zero Density
// -----------------------------------------------------------------------
function testSARZeroDensity() {
  console.log('\n=== Test: SAR Zero Density ===');

  const N = 10;
  const E = new Float64Array(N).fill(100);
  const conductivity = new Float32Array(N).fill(0.5);
  const density = new Float32Array(N).fill(0); // all air

  const SAR = computeLocalSAR(E, conductivity, density);

  let allZero = true;
  let anyNaN = false;
  for (let i = 0; i < N; i++) {
    if (SAR[i] !== 0) allZero = false;
    if (isNaN(SAR[i])) anyNaN = true;
  }
  assert(allZero, 'Zero density produces zero SAR (not NaN)');
  assert(!anyNaN, 'No NaN values in SAR output');
}

// -----------------------------------------------------------------------
// Test 45: SAR Averaged with Uniform Distribution
// -----------------------------------------------------------------------
function testSARAveragedUniform() {
  console.log('\n=== Test: SAR Averaged Uniform ===');

  // For a uniform field and uniform tissue, averaged SAR should match local SAR
  const Nx = 5, Ny = 5, Nz = 5;
  const N = Nx * Ny * Nz;
  const sigma = 0.5;
  const rho = 1000;
  const E_mag2 = 100;
  const cellSize = 0.002; // 2mm cells
  const cellVol = cellSize * cellSize * cellSize;

  const E = new Float64Array(N).fill(E_mag2);
  const conductivity = new Float32Array(N).fill(sigma);
  const density = new Float32Array(N).fill(rho);

  const localSAR = computeLocalSAR(E, conductivity, density);
  const expectedLocal = 0.5 * sigma * E_mag2 / rho;

  // For averaged SAR with uniform tissue, the result should match local SAR
  const cellWidth = {
    x: new Float64Array(Nx).fill(cellSize),
    y: new Float64Array(Ny).fill(cellSize),
    z: new Float64Array(Nz).fill(cellSize),
  };

  // Mass of 1g = 0.001 kg. With rho=1000 and cellVol = 8e-9 m^3,
  // mass per cell = 1000 * 8e-9 = 8e-6 kg.
  // Need 0.001 / 8e-6 = 125 cells for 1g. Our grid is only 125 cells.
  const avgMass = 0.001; // 1g

  const avgSAR = computeAveragedSAR(localSAR, density, cellVol, cellWidth, avgMass, 'simple');

  assert(avgSAR.length === N, `Averaged SAR has ${N} elements`);

  // For a uniform distribution, averaged SAR in the interior should
  // approximately match local SAR (edge effects may differ)
  const centerIdx = (2 * Ny + 2) * Nz + 2; // center voxel
  const avgLocal = avgSAR[centerIdx];
  const relErr = Math.abs(avgLocal - expectedLocal) / expectedLocal;
  assert(relErr < 0.2, `Center averaged SAR = ${avgLocal.toFixed(6)} vs local ${expectedLocal.toFixed(6)} (error ${(relErr * 100).toFixed(1)}%)`);
}

// -----------------------------------------------------------------------
// Test 46: findPeakSAR
// -----------------------------------------------------------------------
function testFindPeakSAR() {
  console.log('\n=== Test: findPeakSAR ===');

  const SAR = new Float32Array([0.1, 0.5, 0.3, 0.8, 0.2, 0.4]);
  const peak = findPeakSAR(SAR);
  assert(Math.abs(peak.value - 0.8) < 1e-6, `Peak SAR = ${peak.value} (expected ~0.8)`);
  assert(peak.index === 3, `Peak index = ${peak.index} (expected 3)`);

  // With grid info
  const SAR3D = new Float32Array(27); // 3x3x3
  SAR3D[13] = 5.0; // center voxel (1,1,1)
  const peak3D = findPeakSAR(SAR3D, { Nx: 3, Ny: 3, Nz: 3 });
  assert(peak3D.value === 5.0, `3D peak SAR = ${peak3D.value}`);
  assert(
    peak3D.position[0] === 1 && peak3D.position[1] === 1 && peak3D.position[2] === 1,
    `3D peak position = [${peak3D.position}] (expected [1,1,1])`
  );
}

// -----------------------------------------------------------------------
// Test: NF2FF with cylindrical mesh type
// -----------------------------------------------------------------------
function testNF2FFCylindricalMesh() {
  console.log('\n=== Test: NF2FF Cylindrical Mesh ===');

  // Create a face with cylindrical coordinates (rho, alpha, z).
  // Place a z-directed current on a rho-normal face at rho=0.01.
  // Mesh: x=rho, y=alpha, z=z
  const rho = 0.01;
  const nAlpha = 8;
  const nZ = 3;
  const nPts = nAlpha * nZ;

  const alphaArr = new Float64Array(nAlpha);
  for (let i = 0; i < nAlpha; i++) alphaArr[i] = i * 2 * Math.PI / nAlpha;

  const face = {
    E: [new Float64Array(nPts * 2), new Float64Array(nPts * 2), new Float64Array(nPts * 2)],
    H: [new Float64Array(nPts * 2), new Float64Array(nPts * 2), new Float64Array(nPts * 2)],
    mesh: { x: new Float64Array([rho]), y: alphaArr, z: new Float64Array([-0.001, 0, 0.001]) },
    normal: [1, 0, 0],
    meshType: 1, // cylindrical
  };

  // Set Hz (z component of H) to produce a rho-directed Js via n x H
  // For rho-normal face (n = [1,0,0]): Js = [0, Hz, -Hy]
  // With cylindrical transform at alpha = pi/2: Js_x = Js_rho*cos(a) - Js_alpha*sin(a) = -Js_alpha
  // This differs from Cartesian treatment where Js is applied as-is.
  for (let i = 0; i < nPts; i++) {
    face.H[2][2 * i] = 1.0; // Hz_re = 1 => Js_alpha = Hz (alpha component)
  }

  const surfaceData = { faces: [face] };
  const freq = 1e9;
  const theta = new Float64Array([Math.PI / 4]);
  const phi = new Float64Array([0, Math.PI / 2]);

  // With cylindrical mesh (face.meshType=1 is already set on the face)
  const resultCyl = computeNF2FF(surfaceData, freq, theta, phi, [0, 0, 0], 1);

  // Without cylindrical mesh: create a copy of the face without meshType
  const faceCart = {
    E: face.E,
    H: face.H,
    mesh: face.mesh,
    normal: face.normal,
    // meshType omitted => defaults to 0 (Cartesian)
  };
  const surfaceDataCart = { faces: [faceCart] };
  const resultCart = computeNF2FF(surfaceDataCart, freq, theta, phi, [0, 0, 0], 1);

  // The cylindrical result should differ from Cartesian because the coordinate
  // transform rotates the current direction at each alpha point.
  // In cylindrical mode, currents at different alpha angles point in different
  // Cartesian directions; in Cartesian mode they all point in the same direction.
  const pCyl_0 = resultCyl.P_rad[0]; // theta=pi/4, phi=0
  const pCyl_1 = resultCyl.P_rad[1]; // theta=pi/4, phi=pi/2
  const pCart_0 = resultCart.P_rad[0];
  const pCart_1 = resultCart.P_rad[1];

  const pMaxCyl = Math.max(pCyl_0, pCyl_1);
  const pMaxCart = Math.max(pCart_0, pCart_1);

  assert(pMaxCyl > 0, `Cylindrical NF2FF produces non-zero P_rad (${pMaxCyl.toExponential(4)})`);
  assert(pMaxCart > 0, `Cartesian NF2FF produces non-zero P_rad (${pMaxCart.toExponential(4)})`);

  // For a circular ring of currents (cylindrical), the E-field values should differ
  // from treating the same numeric data as Cartesian coordinates.
  // The cylindrical transform changes both the current direction and position.
  const etCyl_re = resultCyl.E_theta_re[0];
  const etCart_re = resultCart.E_theta_re[0];
  const epCyl_re = resultCyl.E_phi_re[0];
  const epCart_re = resultCart.E_phi_re[0];

  // At least one E-field component should differ between cylindrical and Cartesian
  const diffEt = Math.abs(etCyl_re - etCart_re);
  const diffEp = Math.abs(epCyl_re - epCart_re);
  const maxE = Math.max(
    Math.abs(etCyl_re), Math.abs(etCart_re),
    Math.abs(epCyl_re), Math.abs(epCart_re), 1e-30
  );

  assert(
    (diffEt + diffEp) / maxE > 0.01,
    `Cylindrical and Cartesian E-fields differ (dEt=${diffEt.toExponential(3)}, dEp=${diffEp.toExponential(3)})`
  );
}

// -----------------------------------------------------------------------
// Test: NF2FF with PEC mirror
// -----------------------------------------------------------------------
function testNF2FFPECMirror() {
  console.log('\n=== Test: NF2FF PEC Mirror ===');

  // An x-directed Js on a z-normal face with a PEC mirror at z=0.
  // The mirror should add a virtual image source with mirrored position and adjusted signs.
  const freq = 1e9;
  const Js0 = 1.0;
  const nX = 3, nY = 3;
  const nPts = nX * nY;

  const face = {
    E: [new Float64Array(nPts * 2), new Float64Array(nPts * 2), new Float64Array(nPts * 2)],
    H: [new Float64Array(nPts * 2), new Float64Array(nPts * 2), new Float64Array(nPts * 2)],
    mesh: { x: new Float64Array([-0.001, 0, 0.001]), y: new Float64Array([-0.001, 0, 0.001]), z: new Float64Array([0.01]) },
    normal: [0, 0, 1],
  };
  for (let i = 0; i < nPts; i++) {
    face.H[1][2 * i] = -Js0; // Hy_re => Js_x = Js0
  }

  const surfaceData = { faces: [face] };
  const theta = new Float64Array([Math.PI / 4]);
  const phi = new Float64Array([0]);

  // Without mirror
  const resultNoMirror = computeNF2FF(surfaceData, freq, theta, phi, [0, 0, 0], 1);

  // With PEC mirror at z=0
  const resultPEC = computeNF2FF(surfaceData, freq, theta, phi, [0, 0, 0], 1, {
    mirror: { type: 'PEC', direction: 2, position: 0 },
  });

  // With the mirror, we expect the far-field to be different (generally larger
  // due to constructive interference from the image source)
  const etNoMirror = Math.sqrt(resultNoMirror.E_theta_re[0] ** 2 + resultNoMirror.E_theta_im[0] ** 2);
  const etPEC = Math.sqrt(resultPEC.E_theta_re[0] ** 2 + resultPEC.E_theta_im[0] ** 2);

  assert(etNoMirror > 0, `No-mirror E_theta magnitude > 0 (${etNoMirror.toExponential(4)})`);
  assert(etPEC > 0, `PEC mirror E_theta magnitude > 0 (${etPEC.toExponential(4)})`);
  assert(
    Math.abs(etPEC - etNoMirror) > 1e-20,
    `PEC mirror changes E_theta (no-mirror: ${etNoMirror.toExponential(4)}, PEC: ${etPEC.toExponential(4)})`
  );
}

// -----------------------------------------------------------------------
// Test: NF2FF with PMC mirror
// -----------------------------------------------------------------------
function testNF2FFPMCMirror() {
  console.log('\n=== Test: NF2FF PMC Mirror ===');

  const freq = 1e9;
  const Js0 = 1.0;
  const nX = 3, nY = 3;
  const nPts = nX * nY;

  const face = {
    E: [new Float64Array(nPts * 2), new Float64Array(nPts * 2), new Float64Array(nPts * 2)],
    H: [new Float64Array(nPts * 2), new Float64Array(nPts * 2), new Float64Array(nPts * 2)],
    mesh: { x: new Float64Array([-0.001, 0, 0.001]), y: new Float64Array([-0.001, 0, 0.001]), z: new Float64Array([0.01]) },
    normal: [0, 0, 1],
  };
  for (let i = 0; i < nPts; i++) {
    face.H[1][2 * i] = -Js0; // Hy_re => Js_x = Js0
  }

  const surfaceData = { faces: [face] };
  const theta = new Float64Array([Math.PI / 4]);
  const phi = new Float64Array([0]);

  // Without mirror
  const resultNoMirror = computeNF2FF(surfaceData, freq, theta, phi, [0, 0, 0], 1);

  // With PMC mirror at z=0
  const resultPMC = computeNF2FF(surfaceData, freq, theta, phi, [0, 0, 0], 1, {
    mirror: { type: 'PMC', direction: 2, position: 0 },
  });

  // With PEC mirror at z=0 for comparison
  const resultPEC = computeNF2FF(surfaceData, freq, theta, phi, [0, 0, 0], 1, {
    mirror: { type: 'PEC', direction: 2, position: 0 },
  });

  const etNoMirror = Math.sqrt(resultNoMirror.E_theta_re[0] ** 2 + resultNoMirror.E_theta_im[0] ** 2);
  const etPMC = Math.sqrt(resultPMC.E_theta_re[0] ** 2 + resultPMC.E_theta_im[0] ** 2);
  const etPEC = Math.sqrt(resultPEC.E_theta_re[0] ** 2 + resultPEC.E_theta_im[0] ** 2);

  assert(etPMC > 0, `PMC mirror E_theta magnitude > 0 (${etPMC.toExponential(4)})`);
  assert(
    Math.abs(etPMC - etNoMirror) > 1e-20,
    `PMC mirror changes E_theta (no-mirror: ${etNoMirror.toExponential(4)}, PMC: ${etPMC.toExponential(4)})`
  );
  // PEC and PMC should produce different results due to different sign conventions
  assert(
    Math.abs(etPMC - etPEC) > 1e-20,
    `PMC and PEC mirrors give different results (PEC: ${etPEC.toExponential(4)}, PMC: ${etPMC.toExponential(4)})`
  );
}

// -----------------------------------------------------------------------
// Test: readNF2FFSurfaceData throws helpful error
// -----------------------------------------------------------------------
function testReadNF2FFSurfaceDataError() {
  console.log('\n=== Test: readNF2FFSurfaceData Error ===');

  let threw = false;
  let errorMsg = '';
  try {
    readNF2FFSurfaceData({}, '/sim', 'nf2ff_box');
  } catch (e) {
    threw = true;
    errorMsg = e.message;
  }

  assert(threw, 'readNF2FFSurfaceData throws an error');
  assert(errorMsg.includes('h5wasm'), `Error mentions h5wasm: "${errorMsg.slice(0, 60)}..."`);
  assert(errorMsg.includes('calcNF2FF'), `Error suggests calcNF2FF alternative`);
  assert(errorMsg.includes('nf2ff_box'), `Error mentions the box name`);
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------
async function main() {
  console.log('openEMS Phase 2 API Test Suite');

  // Unit tests (no WASM required)
  testConstants();
  testAnalysisUtils();
  testSimulationXML();
  testSimulationPML();
  testExcitationTypes();
  testLumpedPortXML();
  testLumpedPortMetalShort();
  testMaterialXML();
  testCylinderXML();
  testPortCalcWithFixture();

  // Phase 2 remaining tests
  testMSLPortXML();
  testMSLPortFeedOptions();
  testWaveguidePortXML();
  testRectWGPortXML();
  testNF2FFBox();
  testNF2FFFreqDomain();
  testNF2FFCalcWithData();
  testNF2FFDirections();
  testMeshHintFromBox();
  testMeshCombine();
  testMeshCflTimestep();
  testSmoothMeshLines();
  testCylindricalShellXML();
  testCurveXML();
  testSimWaveguidePort();
  testNF2FFResult();

  // Phase 2 new primitives
  testSphereXML();
  testSphericalShellXML();
  testPolygonXML();
  testLinPolyXML();
  testRotPolyXML();
  testWireXML();

  // Phase 2 grid and XML
  testSmoothGrid();
  testReadFromXMLStub();

  // Phase 2 visualization data
  testPrepareSParamData();
  testPrepareSmithData();
  testPrepareRadiationPattern();
  testPrepareImpedanceData();
  testPrepareTimeDomainData();

  // Phase 5: NF2FF and SAR tests
  testNF2FFInfinitesimalDipole();
  testSARLocalUniform();
  testSARZeroDensity();
  testSARAveragedUniform();
  testFindPeakSAR();

  // Phase 5: NF2FF cylindrical mesh and mirror tests
  testNF2FFCylindricalMesh();
  testNF2FFPECMirror();
  testNF2FFPMCMirror();
  testReadNF2FFSurfaceDataError();

  // WASM integration tests
  await testWasmCavityViaAPI();
  await testWasmCoaxWithPort();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
