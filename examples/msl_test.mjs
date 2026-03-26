/**
 * Test for MSL Notch Filter example.
 * Validates that the notch filter produces the expected S-parameter behavior:
 * - S21 has a notch (minimum < -10 dB) in the 0-7 GHz range
 * - S11 and S21 are finite and reasonable
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

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

async function main() {
  console.log('=== MSL Notch Filter Test ===\n');

  // Load WASM module
  let Module;
  try {
    const moduleFactory = await import(join(ROOT, 'build-wasm/openems.js'));
    const create = moduleFactory.default || moduleFactory;
    Module = await create();
    if (!Module.ContinuousStructure) {
      console.log('SKIP: CSXCAD bindings not available');
      process.exit(0);
    }
  } catch (e) {
    console.log(`SKIP: WASM module not available (${e.message})`);
    process.exit(0);
  }

  // Run the simulation
  const { runMSLNotchFilter } = await import('./msl_notch_filter.mjs');

  console.log('Running MSL Notch Filter simulation...');
  const t0 = Date.now();
  const { freq, s11_dB, s21_dB } = await runMSLNotchFilter(Module);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Simulation completed in ${elapsed}s.\n`);

  // Basic validity checks
  assert(freq.length === 1601, `Frequency array has ${freq.length} points (expected 1601)`);
  assert(s11_dB.length === freq.length, 'S11 array length matches frequency');
  assert(s21_dB.length === freq.length, 'S21 array length matches frequency');

  // Check that values are finite
  let s11Finite = true, s21Finite = true;
  for (let i = 0; i < freq.length; i++) {
    if (!isFinite(s11_dB[i])) s11Finite = false;
    if (!isFinite(s21_dB[i])) s21Finite = false;
  }
  assert(s11Finite, 'All S11 values are finite');
  assert(s21Finite, 'All S21 values are finite');

  // Find S21 minimum (the notch)
  let s21Min = Infinity;
  let s21MinFreq = 0;
  for (let i = 0; i < freq.length; i++) {
    if (s21_dB[i] < s21Min) {
      s21Min = s21_dB[i];
      s21MinFreq = freq[i];
    }
  }
  console.log(`  S21 minimum: ${s21Min.toFixed(1)} dB at ${(s21MinFreq / 1e9).toFixed(2)} GHz`);
  assert(s21Min < -10, `S21 notch depth < -10 dB (got ${s21Min.toFixed(1)} dB)`);

  // The notch should be somewhere in the expected range (roughly 3-5 GHz for a 12mm stub)
  assert(s21MinFreq > 1e9 && s21MinFreq < 7e9,
    `Notch frequency in expected range: ${(s21MinFreq / 1e9).toFixed(2)} GHz`);

  // S11 should have a peak near the notch frequency
  // At the notch, S11 should be close to 0 dB (all power reflected)
  let s11AtNotch = -Infinity;
  for (let i = 0; i < freq.length; i++) {
    if (Math.abs(freq[i] - s21MinFreq) < 0.5e9) {
      if (s11_dB[i] > s11AtNotch) s11AtNotch = s11_dB[i];
    }
  }
  assert(s11AtNotch > -5, `S11 near notch > -5 dB (got ${s11AtNotch.toFixed(1)} dB)`);

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
