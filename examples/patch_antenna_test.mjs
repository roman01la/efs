/**
 * Test for the Patch Antenna example.
 * Loads the WASM module, runs the simulation, and validates results.
 *
 * Usage: node examples/patch_antenna_test.mjs
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPatchAntenna } from './patch_antenna.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

async function main() {
  console.log('=== Patch Antenna Example Test ===\n');

  // Load WASM module
  console.log('Loading WASM module...');
  let Module;
  try {
    const moduleFactory = await import(join(ROOT, 'build-wasm/openems.js'));
    const create = moduleFactory.default || moduleFactory;
    Module = await create();
    if (!Module.ContinuousStructure) {
      console.log('SKIP: CSXCAD bindings not available in WASM module');
      process.exit(0);
    }
  } catch (e) {
    console.log(`SKIP: Could not load WASM module: ${e.message}`);
    process.exit(0);
  }

  console.log('WASM module loaded.\n');

  // Run simulation
  const results = await runPatchAntenna(Module, {
    onProgress: (msg) => console.log(`  [progress] ${msg}`),
  });

  console.log('\n--- Validation ---');

  // Check 1: S11 has a minimum below -10 dB in the 1-3 GHz range
  let minS11 = 0;
  let minS11Freq = 0;
  for (let i = 0; i < results.freq.length; i++) {
    const f = results.freq[i];
    if (f >= 1e9 && f <= 3e9 && results.s11_dB[i] < minS11) {
      minS11 = results.s11_dB[i];
      minS11Freq = f;
    }
  }
  console.log(`  Min S11 = ${minS11.toFixed(1)} dB at ${(minS11Freq / 1e9).toFixed(3)} GHz`);
  check('S11 minimum below -10 dB in 1-3 GHz', minS11 < -10);

  // Check 2: Resonance frequency is between 1.8 and 2.5 GHz
  const fRes = results.resonance_freq;
  console.log(`  Resonance frequency = ${fRes ? (fRes / 1e9).toFixed(3) + ' GHz' : 'not found'}`);
  check('Resonance frequency between 1.8-2.5 GHz',
    fRes !== null && fRes >= 1.8e9 && fRes <= 2.5e9);

  // Check 3: Zin real part is positive at resonance
  if (fRes !== null) {
    // Find closest frequency index
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let i = 0; i < results.freq.length; i++) {
      const d = Math.abs(results.freq[i] - fRes);
      if (d < closestDist) { closestDist = d; closestIdx = i; }
    }
    const zinReAtRes = results.zin_re[closestIdx];
    console.log(`  Zin(Re) at resonance = ${zinReAtRes.toFixed(1)} Ohm`);
    check('Zin real part positive at resonance', zinReAtRes > 0);
  } else {
    check('Zin real part positive at resonance (no resonance found)', false);
  }

  // Check 4: NF2FF result exists if resonance was found
  if (results.nf2ff) {
    const DmaxdBi = 10 * Math.log10(results.nf2ff.Dmax);
    console.log(`  Dmax = ${DmaxdBi.toFixed(1)} dBi`);
    check('NF2FF Dmax is reasonable (> 0 dBi)', DmaxdBi > 0);
  } else if (fRes !== null && minS11 < -10) {
    check('NF2FF far-field computed', false);
  } else {
    console.log('  SKIP: NF2FF not computed (no resonance below -10 dB)');
  }

  // Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('Test failed with error:', e);
  process.exit(1);
});
