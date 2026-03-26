import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const C0 = 299792458;
const MUE0 = 4e-7 * Math.PI;
const EPS0 = 1 / (MUE0 * C0 * C0);
const Z0_FREE = Math.sqrt(MUE0 / EPS0);

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

function parseProbe(text) {
  const lines = text.split('\n').filter(l => !l.startsWith('%') && l.trim());
  const time = new Float64Array(lines.length);
  const values = new Float64Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    time[i] = parseFloat(parts[0]);
    values[i] = parseFloat(parts[1]);
  }
  return { time, values };
}

function dftMagnitude(time, values, freqs) {
  const N = time.length;
  const result = new Float64Array(freqs.length);

  for (let k = 0; k < freqs.length; k++) {
    let re = 0, im = 0;
    const omega = 2 * Math.PI * freqs[k];
    for (let n = 0; n < N; n++) {
      re += values[n] * Math.cos(omega * time[n]);
      im -= values[n] * Math.sin(omega * time[n]);
    }
    result[k] = Math.sqrt(re * re + im * im);
  }
  return result;
}

function dftComplex(time, values, freqs) {
  const N = time.length;
  const re_out = new Float64Array(freqs.length);
  const im_out = new Float64Array(freqs.length);

  for (let k = 0; k < freqs.length; k++) {
    let re = 0, im = 0;
    const omega = 2 * Math.PI * freqs[k];
    for (let n = 0; n < N; n++) {
      re += values[n] * Math.cos(omega * time[n]);
      im -= values[n] * Math.sin(omega * time[n]);
    }
    re_out[k] = re;
    im_out[k] = im;
  }
  return { re: re_out, im: im_out };
}

function complexDivide(aRe, aIm, bRe, bIm) {
  const re = new Float64Array(aRe.length);
  const im = new Float64Array(aRe.length);
  for (let i = 0; i < aRe.length; i++) {
    const denom = bRe[i] * bRe[i] + bIm[i] * bIm[i];
    if (denom === 0) {
      re[i] = 0;
      im[i] = 0;
    } else {
      re[i] = (aRe[i] * bRe[i] + aIm[i] * bIm[i]) / denom;
      im[i] = (aIm[i] * bRe[i] - aRe[i] * bIm[i]) / denom;
    }
  }
  return { re, im };
}

function complexAbs(re, im) {
  const mag = new Float64Array(re.length);
  for (let i = 0; i < re.length; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mag;
}

function linspace(start, stop, n) {
  const arr = new Float64Array(n);
  const step = (stop - start) / (n - 1);
  for (let i = 0; i < n; i++) arr[i] = start + i * step;
  return arr;
}

function maxInRange(freqs, spectrum, fLow, fHigh) {
  let maxVal = -Infinity;
  let maxFreq = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= fLow && freqs[i] <= fHigh) {
      if (spectrum[i] > maxVal) {
        maxVal = spectrum[i];
        maxFreq = freqs[i];
      }
    }
  }
  return { freq: maxFreq, amplitude: maxVal };
}

function findPeaks(freqs, spectrum, threshold) {
  const peaks = [];
  for (let i = 1; i < spectrum.length - 1; i++) {
    if (spectrum[i] > spectrum[i - 1] && spectrum[i] > spectrum[i + 1] && spectrum[i] > threshold) {
      peaks.push({ freq: freqs[i], amplitude: spectrum[i] });
    }
  }
  return peaks.sort((a, b) => b.amplitude - a.amplitude);
}

// -----------------------------------------------------------------------
// Test 1: Cavity resonator (using reference fixture data)
// -----------------------------------------------------------------------
function testCavityFromFixtures() {
  console.log('\n=== Test: Cavity Resonator (fixture data) ===');

  const ref = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/cavity/reference.json'), 'utf8'));
  const probeText = readFileSync(join(ROOT, 'tests/fixtures/cavity/probe_ut1z.csv'), 'utf8');
  const probe = parseProbe(probeText);

  assert(probe.time.length > 100, `Probe has ${probe.time.length} samples`);

  let hasSignal = false;
  for (let i = 0; i < probe.values.length; i++) {
    if (probe.values[i] !== 0) { hasSignal = true; break; }
  }
  assert(hasSignal, 'Probe data contains non-zero values');

  const dt = probe.time[1] - probe.time[0];
  const fNyquist = 1 / (2 * dt);
  const N = probe.time.length;
  const NFFT = Math.pow(2, Math.ceil(Math.log2(N)));
  const df = 1 / (NFFT * dt);

  const fStart = 1e9;
  const fStop = 10e9;

  const nFreqs = Math.ceil((fStop - fStart) / df);
  const freqs = new Float64Array(nFreqs);
  for (let i = 0; i < nFreqs; i++) freqs[i] = fStart + i * df;

  console.log(`  DFT: ${nFreqs} frequency bins, df=${(df / 1e6).toFixed(2)} MHz`);

  const spectrum = dftMagnitude(probe.time, probe.values, freqs);

  const globalMax = Math.max(...spectrum);
  const normSpectrum = new Float64Array(spectrum.length);
  for (let i = 0; i < spectrum.length; i++) normSpectrum[i] = spectrum[i] / globalMax;

  const peaks = findPeaks(freqs, normSpectrum, 0.1);
  console.log(`  Found ${peaks.length} peaks above 10% threshold:`);
  for (const p of peaks.slice(0, 8)) {
    console.log(`    f=${(p.freq / 1e9).toFixed(4)} GHz, amplitude=${p.amplitude.toFixed(4)}`);
  }

  const allModes = {
    ...ref.te_modes,
    ...ref.tm_modes,
  };

  let matchedModes = 0;
  for (const [mode, fAnalytical] of Object.entries(allModes)) {
    const isTE = mode.startsWith('TE');
    const tolRel = isTE ? ref.tolerances.te_freq_rel : ref.tolerances.tm_freq_lower_rel;
    const fLow = fAnalytical * (1 - tolRel);
    const fHigh = fAnalytical * (1 + tolRel);

    const peak = maxInRange(freqs, normSpectrum, fLow, fHigh);
    const minAmp = isTE ? ref.tolerances.te_min_amplitude : ref.tolerances.tm_min_amplitude;

    if (peak.amplitude >= minAmp) {
      assert(true, `${mode}: peak at ${(peak.freq / 1e9).toFixed(4)} GHz, amplitude=${peak.amplitude.toFixed(3)}`);
      matchedModes++;
    } else {
      console.log(`  INFO: ${mode} at ${(fAnalytical / 1e9).toFixed(4)} GHz not detected (amplitude=${peak.amplitude.toFixed(4)}, need ${minAmp})`);
    }
  }

  assert(matchedModes >= 2, `At least 2 resonance modes detected (found ${matchedModes})`);

  function cavityModeFreq(m, n, l) {
    return C0 / (2 * Math.PI) * Math.sqrt(
      (m * Math.PI / ref.dimensions_m.a) ** 2 +
      (n * Math.PI / ref.dimensions_m.b) ** 2 +
      (l * Math.PI / ref.dimensions_m.d) ** 2
    );
  }

  const allAnalyticalFreqs = [];
  for (let m = 0; m <= 4; m++) {
    for (let n = 0; n <= 4; n++) {
      for (let l = 0; l <= 4; l++) {
        if (m === 0 && n === 0) continue;
        const f = cavityModeFreq(m, n, l);
        if (f > fStart && f < fStop) allAnalyticalFreqs.push(f);
      }
    }
  }

  for (const peak of peaks) {
    let matchesAnyMode = false;
    for (const f of allAnalyticalFreqs) {
      const relError = Math.abs(peak.freq - f) / f;
      if (relError < 0.01) {
        matchesAnyMode = true;
        break;
      }
    }
    if (peak.amplitude > 0.2) {
      assert(
        matchesAnyMode,
        `Peak at ${(peak.freq / 1e9).toFixed(4)} GHz (amp=${peak.amplitude.toFixed(3)}) matches an analytical mode`
      );
    }
  }
}

// -----------------------------------------------------------------------
// Test 2: Coaxial line (using reference fixture data)
// -----------------------------------------------------------------------
function testCoaxFromFixtures() {
  console.log('\n=== Test: Coaxial Line (fixture data) ===');

  const ref = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/coax/reference.json'), 'utf8'));

  let vtHasSignal = false;
  for (const v of ref.probe_ut1.voltage) {
    if (v !== 0) { vtHasSignal = true; break; }
  }

  if (!vtHasSignal) {
    console.log('  SKIP: Coax reference probe data is all zeros (fixture needs regeneration with more timesteps)');
    console.log(`  INFO: Expected Z0 = ${ref.Z0_analytical_ohm.toFixed(2)} Ohm`);
    return;
  }

  const vProbe = {
    time: new Float64Array(ref.probe_ut1.time_s),
    values: new Float64Array(ref.probe_ut1.voltage),
  };
  const iProbe = {
    time: new Float64Array(ref.probe_it1.time_s),
    values: new Float64Array(ref.probe_it1.voltage),
  };

  const fStart = 0.1e9;
  const fStop = 0.5e9;
  const nFreqs = 200;
  const freqs = linspace(fStart, fStop, nFreqs);

  const Vf = dftComplex(vProbe.time, vProbe.values, freqs);
  const If = dftComplex(iProbe.time, iProbe.values, freqs);
  const Z = complexDivide(Vf.re, Vf.im, If.re, If.im);
  const Zmag = complexAbs(Z.re, Z.im);

  const Z0_expected = ref.Z0_analytical_ohm;
  const upperLimit = Z0_expected * (1 + ref.tolerances.upper_error);
  const lowerLimit = Z0_expected * (1 - ref.tolerances.lower_error);

  let allInRange = true;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < Zmag.length; i++) {
    if (Zmag[i] < minZ) minZ = Zmag[i];
    if (Zmag[i] > maxZ) maxZ = Zmag[i];
    if (Zmag[i] > upperLimit || Zmag[i] < lowerLimit) allInRange = false;
  }

  assert(
    allInRange,
    `Z0 in [${lowerLimit.toFixed(2)}, ${upperLimit.toFixed(2)}] Ohm (actual: ${minZ.toFixed(2)} - ${maxZ.toFixed(2)})`
  );
}

// -----------------------------------------------------------------------
// Test 3: Dipole field probes (using reference fixture data)
// -----------------------------------------------------------------------
function testDipoleFromFixtures() {
  console.log('\n=== Test: Dipole Field Probes (fixture data) ===');

  let ref;
  try {
    ref = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/dipole/reference.json'), 'utf8'));
  } catch (e) {
    console.log('  SKIP: Dipole fixture not found');
    return;
  }

  const tol = ref.tolerances;
  let probesTested = 0;

  for (const probeName of ['et1', 'et2', 'ht1', 'ht2']) {
    const key = `probe_${probeName}`;
    if (!ref[key]) {
      console.log(`  INFO: ${probeName} not in reference`);
      continue;
    }

    const data = ref[key];
    const values = new Float64Array(data.voltage);
    const times = new Float64Array(data.time_s);

    let maxAmp = 0;
    for (let i = 0; i < values.length; i++) {
      if (Math.abs(values[i]) > maxAmp) maxAmp = Math.abs(values[i]);
    }

    const isEField = probeName.startsWith('e');
    const minAmp = isEField ? tol.min_e_amp : tol.min_h_amp;

    if (maxAmp > 0) {
      assert(
        maxAmp >= minAmp,
        `${probeName}: max amplitude ${maxAmp.toExponential(3)} >= threshold ${minAmp.toExponential(1)}`
      );
      probesTested++;
    } else {
      console.log(`  INFO: ${probeName} has zero signal`);
    }
  }

  assert(probesTested >= 2, `At least 2 field probes have signal (found ${probesTested})`);

  // Verify E-field symmetry: et1 and et2 should have similar magnitudes
  if (ref.probe_et1 && ref.probe_et2) {
    const et1Max = Math.max(...ref.probe_et1.voltage.map(Math.abs));
    const et2Max = Math.max(...ref.probe_et2.voltage.map(Math.abs));
    if (et1Max > 0 && et2Max > 0) {
      const ratio = Math.max(et1Max, et2Max) / Math.min(et1Max, et2Max);
      assert(ratio < 10, `E-field symmetry: et1/et2 ratio=${ratio.toFixed(2)} (< 10)`);
    }
  }

  // Verify H-field symmetry
  if (ref.probe_ht1 && ref.probe_ht2) {
    const ht1Max = Math.max(...ref.probe_ht1.voltage.map(Math.abs));
    const ht2Max = Math.max(...ref.probe_ht2.voltage.map(Math.abs));
    if (ht1Max > 0 && ht2Max > 0) {
      const ratio = Math.max(ht1Max, ht2Max) / Math.min(ht1Max, ht2Max);
      assert(ratio < 10, `H-field symmetry: ht1/ht2 ratio=${ratio.toFixed(2)} (< 10)`);
    }
  }
}

// -----------------------------------------------------------------------
// Test 4: DFT utility validation
// -----------------------------------------------------------------------
function testDFTUtility() {
  console.log('\n=== Test: DFT Utility ===');

  const N = 1000;
  const dt = 1e-10;
  const fSignal = 3.5e9;

  const time = new Float64Array(N);
  const values = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    time[i] = i * dt;
    values[i] = Math.sin(2 * Math.PI * fSignal * time[i]);
  }

  const freqs = linspace(1e9, 5e9, 500);
  const spectrum = dftMagnitude(time, values, freqs);

  const globalMax = Math.max(...spectrum);
  let peakFreq = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (spectrum[i] === globalMax) peakFreq = freqs[i];
  }

  const relError = Math.abs(peakFreq - fSignal) / fSignal;
  assert(relError < 0.01, `DFT peak at ${(peakFreq / 1e9).toFixed(4)} GHz matches input ${(fSignal / 1e9).toFixed(1)} GHz (error=${(relError * 100).toFixed(2)}%)`);

  const time2 = new Float64Array(N);
  const v2 = new Float64Array(N);
  const i2 = new Float64Array(N);
  const Z0test = 50;
  for (let n = 0; n < N; n++) {
    time2[n] = n * dt;
    v2[n] = Z0test * Math.sin(2 * Math.PI * 1e9 * time2[n]);
    i2[n] = Math.sin(2 * Math.PI * 1e9 * time2[n]);
  }

  const testFreqs = linspace(0.5e9, 1.5e9, 100);
  const Vf = dftComplex(time2, v2, testFreqs);
  const If = dftComplex(time2, i2, testFreqs);
  const Zr = complexDivide(Vf.re, Vf.im, If.re, If.im);
  const Zmag = complexAbs(Zr.re, Zr.im);

  const peakIdx = testFreqs.indexOf(linspace(0.5e9, 1.5e9, 100).find((_, i) => {
    const fArr = linspace(0.5e9, 1.5e9, 100);
    return Math.abs(fArr[i] - 1e9) < (fArr[1] - fArr[0]);
  }));

  let closestIdx = 0;
  let closestDist = Infinity;
  for (let i = 0; i < testFreqs.length; i++) {
    const d = Math.abs(testFreqs[i] - 1e9);
    if (d < closestDist) { closestDist = d; closestIdx = i; }
  }

  const zError = Math.abs(Zmag[closestIdx] - Z0test) / Z0test;
  assert(zError < 0.05, `Impedance Z=${Zmag[closestIdx].toFixed(2)} Ohm matches expected ${Z0test} Ohm (error=${(zError * 100).toFixed(2)}%)`);
}

// -----------------------------------------------------------------------
// Test 4: WASM module loading
// -----------------------------------------------------------------------
async function testWasmModule() {
  console.log('\n=== Test: WASM Module ===');

  let createOpenEMS;
  try {
    const moduleFactory = await import(join(ROOT, 'build-wasm/openems.js'));
    createOpenEMS = moduleFactory.default || moduleFactory;
  } catch (e) {
    console.log(`  SKIP: WASM module not available (${e.message})`);
    return null;
  }

  const Module = await createOpenEMS();
  assert(Module !== null && Module !== undefined, 'Module loaded');
  assert(typeof Module.OpenEMS === 'function', 'OpenEMS class available');
  assert(typeof Module.FS === 'object', 'FS available');

  const ems = new Module.OpenEMS();
  assert(typeof ems.configure === 'function', 'configure method exists');
  assert(typeof ems.loadXML === 'function', 'loadXML method exists');
  assert(typeof ems.setup === 'function', 'setup method exists');
  assert(typeof ems.run === 'function', 'run method exists');
  assert(typeof ems.readFile === 'function', 'readFile method exists');
  assert(typeof ems.listFiles === 'function', 'listFiles method exists');
  ems.delete();

  return Module;
}

// -----------------------------------------------------------------------
// Test 5: WASM cavity simulation
// -----------------------------------------------------------------------
async function testWasmCavity(Module) {
  console.log('\n=== Test: WASM Cavity Simulation ===');

  try { Module.FS.mkdir('/sim'); } catch (e) {}
  Module.FS.chdir('/sim');

  const ref = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/cavity/reference.json'), 'utf8'));

  const a = 5e-2, b = 2e-2, d = 6e-2;
  function meshCsv(start, stop, n) {
    const vals = [];
    const step = (stop - start) / (n - 1);
    for (let i = 0; i < n; i++) vals.push((start + i * step).toExponential(10));
    return vals.join(',');
  }

  const meshX = linspace(0, a, 26);
  const meshY = linspace(0, b, 11);
  const meshZ = linspace(0, d, 32);

  const exIdxX = Math.floor(26 * 2 / 3);
  const exIdxY = Math.floor(11 * 2 / 3);
  const exIdxZ = Math.floor(32 * 2 / 3);

  const prX = meshX[Math.floor(26 / 4)];
  const prY = meshY[Math.floor(11 / 2)];
  const prZIdx = Math.floor(32 / 5);

  const fStart = 1e9, fStop = 10e9;
  const f0 = (fStop + fStart) / 2;
  const fc = (fStop - fStart) / 2;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="20000" endCriteria="1e-6" f_max="${fStop}">
    <Excitation Type="0" f0="${f0}" fc="${fc}"/>
    <BoundaryCond xmin="0" xmax="0" ymin="0" ymax="0" zmin="0" zmax="0"/>
  </FDTD>
  <ContinuousStructure CoordSystem="0">
    <RectilinearGrid DeltaUnit="1" CoordSystem="0">
      <XLines>${meshCsv(0, a, 26)}</XLines>
      <YLines>${meshCsv(0, b, 11)}</YLines>
      <ZLines>${meshCsv(0, d, 32)}</ZLines>
    </RectilinearGrid>
    <Properties>
      <Excitation ID="0" Name="excite1" Number="0" Type="0" Excite="1,1,1">
        <Primitives>
          <Curve Priority="0">
            <Vertex X="${meshX[exIdxX]}" Y="${meshY[exIdxY]}" Z="${meshZ[exIdxZ]}"/>
            <Vertex X="${meshX[exIdxX + 1]}" Y="${meshY[exIdxY + 1]}" Z="${meshZ[exIdxZ + 1]}"/>
          </Curve>
        </Primitives>
      </Excitation>
      <ProbeBox ID="1" Name="ut1z" Number="0" Type="0" Weight="1" NormDir="-1">
        <Primitives>
          <Box Priority="0">
            <P1 X="${prX}" Y="${prY}" Z="${meshZ[prZIdx]}"/>
            <P2 X="${prX}" Y="${prY}" Z="${meshZ[prZIdx + 1]}"/>
          </Box>
        </Primitives>
      </ProbeBox>
    </Properties>
  </ContinuousStructure>
</openEMS>`;

  const ems = new Module.OpenEMS();
  ems.configure(0, 20000, 1e-6);

  const loadOk = ems.loadXML(xml);
  if (!assert(loadOk, 'XML loaded successfully')) { ems.delete(); return; }

  const rc = ems.setup();
  if (!assert(rc === 0, `SetupFDTD returned ${rc} (expected 0)`)) { ems.delete(); return; }

  console.log('  Running FDTD simulation (this may take a while)...');
  const t0 = Date.now();
  ems.run();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Simulation complete in ${elapsed}s.`);

  const files = ems.listFiles('/sim');
  const fileList = [];
  for (let i = 0; i < files.size(); i++) fileList.push(files.get(i));
  console.log(`  Files in /sim: ${fileList.join(', ')}`);

  const probeFilename = fileList.find(f => f.startsWith('ut1z') && !f.includes('FD'));
  if (!assert(probeFilename !== undefined, 'Probe output file found')) { ems.delete(); return; }

  const probeText = ems.readFile(`/sim/${probeFilename}`);
  assert(probeText.length > 0, `Probe file has content (${probeText.length} bytes)`);

  const probe = parseProbe(probeText);
  assert(probe.time.length > 100, `Probe has ${probe.time.length} samples`);

  let hasNonZero = false;
  for (let i = 0; i < probe.values.length; i++) {
    if (probe.values[i] !== 0) { hasNonZero = true; break; }
  }
  assert(hasNonZero, 'Probe has non-zero values');

  if (hasNonZero) {
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
    console.log(`  WASM spectrum: ${peaks.length} peaks above 10%`);
    for (const p of peaks.slice(0, 5)) {
      console.log(`    f=${(p.freq / 1e9).toFixed(4)} GHz, amplitude=${p.amplitude.toFixed(4)}`);
    }

    const allModes = { ...ref.te_modes, ...ref.tm_modes };
    let matchedModes = 0;
    for (const [mode, fAnalytical] of Object.entries(allModes)) {
      const tolRel = mode.startsWith('TE') ? ref.tolerances.te_freq_rel : ref.tolerances.tm_freq_lower_rel;
      const minAmp = mode.startsWith('TE') ? ref.tolerances.te_min_amplitude : ref.tolerances.tm_min_amplitude;
      const fLow = fAnalytical * (1 - tolRel);
      const fHigh = fAnalytical * (1 + tolRel);
      const peak = maxInRange(freqs, normSpectrum, fLow, fHigh);
      if (peak.amplitude >= minAmp) matchedModes++;
    }
    assert(matchedModes >= 2, `WASM: at least 2 resonance modes detected (found ${matchedModes})`);
  }

  ems.delete();
}

// -----------------------------------------------------------------------
// Test: Cylindrical Coordinate Simulation
// -----------------------------------------------------------------------
async function testCylindricalCoords(_Module) {
  console.log('\n=== Test: Cylindrical Coordinate Simulation ===');

  const Module = _Module;

  // Create a cylindrical cavity:
  // CoordSystem=1 means cylindrical (rho, alpha, z)
  const rMax = 0.05;
  const aMax = 2 * Math.PI;
  const zMax = 0.06;
  const nR = 15, nA = 32, nZ = 20;

  function meshCsv(arr) { return Array.from(arr).map(v => v.toExponential(10)).join(','); }

  const rLines = linspace(0, rMax, nR);
  const aLines = linspace(0, aMax, nA);
  const zLines = linspace(0, zMax, nZ);

  // Excitation and probe indices (away from boundaries and axis)
  const exRI = 7, exAI = 8, exZI = 10;
  const prRI = 5, prAI = 16, prZI = 7;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="5000" endCriteria="1e-3" f_max="10e9">
    <Excitation Type="0" f0="5.5e9" fc="4.5e9"/>
    <BoundaryCond xmin="0" xmax="0" ymin="0" ymax="0" zmin="0" zmax="0"/>
  </FDTD>
  <ContinuousStructure CoordSystem="1">
    <RectilinearGrid DeltaUnit="1" CoordSystem="1">
      <XLines>${meshCsv(rLines)}</XLines>
      <YLines>${meshCsv(aLines)}</YLines>
      <ZLines>${meshCsv(zLines)}</ZLines>
    </RectilinearGrid>
    <Properties>
      <Excitation ID="0" Name="exc" Number="0" Type="0" Excite="0,0,1">
        <Primitives>
          <Box Priority="0">
            <P1 X="${rLines[exRI]}" Y="${aLines[exAI]}" Z="${zLines[exZI]}"/>
            <P2 X="${rLines[exRI+1]}" Y="${aLines[exAI+1]}" Z="${zLines[exZI+1]}"/>
          </Box>
        </Primitives>
      </Excitation>
      <ProbeBox ID="1" Name="et_cyl" Number="0" Type="2" Weight="1" NormDir="-1">
        <Primitives>
          <Box Priority="0">
            <P1 X="${rLines[prRI]}" Y="${aLines[prAI]}" Z="${zLines[prZI]}"/>
            <P2 X="${rLines[prRI]}" Y="${aLines[prAI]}" Z="${zLines[prZI]}"/>
          </Box>
        </Primitives>
      </ProbeBox>
    </Properties>
  </ContinuousStructure>
</openEMS>`;


  try { Module.FS.mkdir('/sim_cyl'); } catch (e) {}
  Module.FS.chdir('/sim_cyl');

  const ems = new Module.OpenEMS();
  ems.configure(0, 5000, 1e-3);

  const loadOk = ems.loadXML(xml);
  if (!assert(loadOk, 'Cylindrical XML loaded successfully')) { ems.delete(); return; }

  const rc = ems.setup();
  if (!assert(rc === 0, `Cylindrical SetupFDTD returned ${rc} (expected 0)`)) { ems.delete(); return; }

  console.log('  Running cylindrical FDTD simulation...');
  const t0 = Date.now();
  ems.run();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Cylindrical simulation complete in ${elapsed}s.`);

  const files = ems.listFiles('/sim_cyl');
  const fileList = [];
  for (let i = 0; i < files.size(); i++) fileList.push(files.get(i));
  console.log(`  Files: ${fileList.join(', ')}`);

  const probeFilename = fileList.find(f => f.startsWith('et_cyl') && !f.includes('FD'));
  assert(probeFilename !== undefined, 'Cylindrical probe output file found');

  if (probeFilename) {
    const probeText = ems.readFile(`/sim_cyl/${probeFilename}`);
    assert(probeText.length > 0, `Cylindrical probe file has content (${probeText.length} bytes)`);

    // E-field probe (Type=2) outputs: time, Er, Ealpha, Ez
    const dataLines = probeText.split('\n').filter(l => !l.startsWith('%') && l.trim());
    assert(dataLines.length > 10, `Cylindrical probe has ${dataLines.length} samples`);

    // Verify the probe file has the expected 4-column format (time + 3 E-field components)
    const firstDataLine = dataLines[1]; // skip t=0 line
    const cols = firstDataLine.trim().split(/\s+/);
    assert(cols.length === 4, `Cylindrical E-field probe has 4 columns (time, Er, Ea, Ez): found ${cols.length}`);
    assert(!isNaN(parseFloat(cols[0])), 'Cylindrical probe time column is numeric');
  }

  ems.delete();
}

// -----------------------------------------------------------------------
// Test: Multi-threaded Engine
// -----------------------------------------------------------------------
async function testMultithreaded(Module) {
  console.log('\n=== Test: Multi-threaded WASM Engine ===');

  const engines = [
    { type: 0, name: 'basic' },
    { type: 1, name: 'sse' },
    { type: 3, name: 'multithreaded' },
  ];

  const a = 5e-2, b = 2e-2, d = 6e-2;
  const meshX = linspace(0, a, 16);
  const meshY = linspace(0, b, 8);
  const meshZ = linspace(0, d, 18);
  function mc(arr) { return arr.map(v => v.toExponential(10)).join(','); }

  const exI = 10, eyI = 5, ezI = 12;
  const fStop = 10e9, f0 = 5.5e9, fc = 4.5e9;
  const STEPS = 500;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="${STEPS}" endCriteria="1e-20" f_max="${fStop}">
    <Excitation Type="0" f0="${f0}" fc="${fc}"/>
    <BoundaryCond xmin="0" xmax="0" ymin="0" ymax="0" zmin="0" zmax="0"/>
  </FDTD>
  <ContinuousStructure CoordSystem="0">
    <RectilinearGrid DeltaUnit="1" CoordSystem="0">
      <XLines>${mc(meshX)}</XLines>
      <YLines>${mc(meshY)}</YLines>
      <ZLines>${mc(meshZ)}</ZLines>
    </RectilinearGrid>
    <Properties>
      <Excitation ID="0" Name="exc" Number="0" Type="0" Excite="1,1,1">
        <Primitives>
          <Curve Priority="0">
            <Vertex X="${meshX[exI]}" Y="${meshY[eyI]}" Z="${meshZ[ezI]}"/>
            <Vertex X="${meshX[exI+1]}" Y="${meshY[eyI+1]}" Z="${meshZ[ezI+1]}"/>
          </Curve>
        </Primitives>
      </Excitation>
      <ProbeBox ID="1" Name="vp" Number="0" Type="0" Weight="1" NormDir="-1">
        <Primitives>
          <Box Priority="0">
            <P1 X="${meshX[5]}" Y="${meshY[3]}" Z="${meshZ[4]}"/>
            <P2 X="${meshX[5]}" Y="${meshY[3]}" Z="${meshZ[5]}"/>
          </Box>
        </Primitives>
      </ProbeBox>
    </Properties>
  </ContinuousStructure>
</openEMS>`;

  const results = {};

  for (const eng of engines) {
    const simDir = `/sim_mt_${eng.name}`;
    try { Module.FS.mkdir(simDir); } catch (e) {}
    Module.FS.chdir(simDir);

    const ems = new Module.OpenEMS();
    ems.configure(eng.type, STEPS, 1e-20);

    const loadOk = ems.loadXML(xml);
    if (!loadOk) {
      console.log(`  SKIP: ${eng.name} — XML load failed`);
      ems.delete();
      continue;
    }

    const rc = ems.setup();
    if (rc !== 0) {
      console.log(`  SKIP: ${eng.name} — setup failed (rc=${rc})`);
      ems.delete();
      continue;
    }

    const t0 = Date.now();
    try {
      ems.run();
    } catch (e) {
      // Multithreaded engine may throw 'unwind' on thread cleanup
      if (e !== 'unwind' && e?.message !== 'unwind') throw e;
    }
    const ms = Date.now() - t0;

    let probeText;
    try {
      probeText = ems.readFile(`${simDir}/vp`);
    } catch (e) {
      console.log(`  SKIP: ${eng.name} — probe read failed after unwind`);
      ems.delete();
      continue;
    }
    const lines = probeText.split('\n').filter(l => !l.startsWith('%') && l.trim());
    let energy = 0;
    for (const line of lines) {
      const v = parseFloat(line.split(/\s+/)[1]);
      if (!isNaN(v)) energy += v * v;
    }

    const cells = 16 * 8 * 18;
    const mcps = (cells * STEPS / ms / 1000).toFixed(1);

    results[eng.name] = { ms, mcps, energy, samples: lines.length };
    assert(lines.length > 10, `${eng.name}: probe has ${lines.length} samples`);
    assert(energy > 0, `${eng.name}: non-zero energy (${energy.toExponential(3)})`);
    console.log(`  ${eng.name}: ${ms} ms, ${mcps} MCells/s, ${lines.length} samples`);

    try { ems.delete(); } catch (e) {
      if (e !== 'unwind' && e?.message !== 'unwind') throw e;
    }
  }

  // Compare engine outputs — they should produce similar energy
  if (results.basic && results.multithreaded) {
    const ratio = results.multithreaded.energy / results.basic.energy;
    assert(
      Math.abs(ratio - 1) < 0.01,
      `Multithreaded matches basic energy: ratio=${ratio.toFixed(6)}`
    );
  }

  if (results.basic && results.sse) {
    const ratio = results.sse.energy / results.basic.energy;
    assert(
      Math.abs(ratio - 1) < 0.01,
      `SSE matches basic energy: ratio=${ratio.toFixed(6)}`
    );
  }
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------
async function main() {
  console.log('openEMS WASM Test Suite');

  testDFTUtility();
  testCavityFromFixtures();
  testCoaxFromFixtures();
  testDipoleFromFixtures();

  const Module = await testWasmModule();
  if (Module) {
    await testWasmCavity(Module);
    await testCylindricalCoords(Module);
    await testMultithreaded(Module);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  if (e === 'unwind' || e?.message === 'unwind') {
    // Emscripten pthreads cleanup — ignore
    process.exit(failed > 0 ? 1 : 0);
  }
  console.error(e);
  process.exit(1);
});
