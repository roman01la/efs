/**
 * Test for Rectangular Waveguide example.
 * Validates WR42 waveguide S-parameters and impedance:
 * - S21 > -1 dB in passband (20-26 GHz)
 * - S11 < -15 dB in passband
 * - Waveguide impedance matches analytic values
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
  console.log('=== Rectangular Waveguide Test ===\n');

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
  const { runRectWaveguide } = await import('./rect_waveguide.mjs');

  console.log('Running Rectangular Waveguide simulation...');
  const t0 = Date.now();
  const { freq, s11_dB, s21_dB, ZL_re, ZL_im, ZL_analytic } = await runRectWaveguide(Module);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Simulation completed in ${elapsed}s.\n`);

  // Basic validity checks
  assert(freq.length === 201, `Frequency array has ${freq.length} points (expected 201)`);
  assert(s11_dB.length === freq.length, 'S11 array length matches frequency');
  assert(s21_dB.length === freq.length, 'S21 array length matches frequency');
  assert(ZL_re.length === freq.length, 'ZL_re array length matches frequency');
  assert(ZL_im.length === freq.length, 'ZL_im array length matches frequency');
  assert(ZL_analytic.length === freq.length, 'ZL_analytic array length matches frequency');

  // S21 should be > -1 dB across the passband (20-26 GHz)
  let s21_worst = 0;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= 20e9 && freq[i] <= 26e9) {
      if (s21_dB[i] < s21_worst) s21_worst = s21_dB[i];
    }
  }
  console.log(`  S21 worst in passband: ${s21_worst.toFixed(2)} dB`);
  assert(s21_worst > -1, `S21 > -1 dB in passband (got ${s21_worst.toFixed(2)} dB)`);

  // S11 should be < -15 dB across the passband
  let s11_worst = -Infinity;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= 20e9 && freq[i] <= 26e9) {
      if (s11_dB[i] > s11_worst) s11_worst = s11_dB[i];
    }
  }
  console.log(`  S11 worst in passband: ${s11_worst.toFixed(2)} dB`);
  assert(s11_worst < -15, `S11 < -15 dB in passband (got ${s11_worst.toFixed(2)} dB)`);

  // Waveguide impedance: Re{ZL} should be close to analytic ZL
  // Check at the center frequency (24 GHz)
  const centerIdx = Math.floor(freq.length / 2);
  const reZL = ZL_re[centerIdx];
  const analyticZL = ZL_analytic[centerIdx];
  const relError = Math.abs(reZL - analyticZL) / analyticZL;
  console.log(`  Re{ZL} at center: ${reZL.toFixed(1)} Ohm (analytic: ${analyticZL.toFixed(1)} Ohm, error: ${(relError * 100).toFixed(1)}%)`);
  assert(relError < 0.1, `ZL matches analytic within 10% (error: ${(relError * 100).toFixed(1)}%)`);

  // Im{ZL} should be small compared to Re{ZL} in the passband
  const imZL = ZL_im[centerIdx];
  console.log(`  Im{ZL} at center: ${imZL.toFixed(1)} Ohm`);
  assert(Math.abs(imZL) < Math.abs(reZL) * 0.2,
    `Im{ZL} is small relative to Re{ZL} (${Math.abs(imZL).toFixed(1)} vs ${reZL.toFixed(1)})`);

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
