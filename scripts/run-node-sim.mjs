#!/usr/bin/env node
/**
 * Node.js CLI for running antenna simulations using WebGPU (via Dawn bindings).
 *
 * Usage:
 *   node scripts/run-node-sim.mjs [example-name] [--output-dir path] [--json]
 *   node scripts/run-node-sim.mjs --xml sim.xml [--json]
 *   cat sim.xml | node scripts/run-node-sim.mjs --stdin [--json]
 *
 * --json:  Output raw simulation results to stdout (same format as browser worker
 *          'done' message) instead of generating plot files.
 * --xml:   Read simulation XML from a file instead of generating from example.
 * --stdin: Read simulation XML from stdin.
 *
 * Examples: patch_antenna, msl_notch, helical, uwb, cloverleaf, pbc_array, rect_waveguide
 */

import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// ---- WebGPU shims for Node.js (must be set before any imports that use navigator.gpu) ----
import { create, globals } from 'webgpu';
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', {
  value: { gpu: create([]) },
  writable: true,
  configurable: true,
});

// ---- Imports ----
import { loadWASM } from './lib/node-wasm.mjs';
import { runSimulation } from './lib/sim-engine.mjs';
import { parseProbeData, computeS11, extractRadiationData } from './lib/post-process.mjs';
import { plotSVG, polarPlotSVG, saveSVG, saveSVGtoPNG } from './lib/plot-utils.mjs';

// ---- Example map ----
const EXAMPLE_MAP = {
  patch_antenna: 'PATCH_ANTENNA',
  msl_notch: 'MSL_NOTCH_FILTER',
  helical: 'HELICAL_ANTENNA',
  rect_waveguide: 'RECT_WAVEGUIDE',
  uwb: 'UWB_COMB_DIPOLE',
  cloverleaf: 'CLOVERLEAF_ANTENNA',
  pbc_array: 'PATCH_ANTENNA_ARRAY',
};

// ---- CLI argument parsing ----
const args = process.argv.slice(2);
let exampleName = 'patch_antenna';
let outputDir = resolve(projectRoot, 'output');
let jsonMode = false;
let xmlFilePath = null;
let readStdin = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output-dir' && args[i + 1]) {
    outputDir = resolve(args[i + 1]);
    i++;
  } else if (args[i] === '--json') {
    jsonMode = true;
  } else if (args[i] === '--xml' && args[i + 1]) {
    xmlFilePath = resolve(args[i + 1]);
    i++;
  } else if (args[i] === '--stdin') {
    readStdin = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    process.stderr.write(`Usage: node scripts/run-node-sim.mjs [example-name] [--output-dir path] [--json]\n`);
    process.stderr.write(`       node scripts/run-node-sim.mjs --xml sim.xml [--json]\n`);
    process.stderr.write(`       cat sim.xml | node scripts/run-node-sim.mjs --stdin [--json]\n`);
    process.stderr.write(`\nAvailable examples: ${Object.keys(EXAMPLE_MAP).join(', ')}\n`);
    process.exit(0);
  } else if (!args[i].startsWith('-')) {
    exampleName = args[i];
  }
}

if (!xmlFilePath && !readStdin && !EXAMPLE_MAP[exampleName]) {
  process.stderr.write(`Unknown example: ${exampleName}\n`);
  process.stderr.write(`Available: ${Object.keys(EXAMPLE_MAP).join(', ')}\n`);
  process.exit(1);
}

// ---- Main ----
async function main() {
  const log = (msg) => process.stderr.write(`[sim] ${msg}\n`);
  const status = (step, maxTS) => {
    // Status updates handled by onLog callbacks in sim-engine
  };

  if (!jsonMode) {
    log(`Output: ${outputDir}`);
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  }

  // 1. Get simulation XML
  let xml;
  if (readStdin) {
    log('Reading XML from stdin...');
    const { readFileSync } = await import('fs');
    xml = readFileSync(0, 'utf8');
  } else if (xmlFilePath) {
    log(`Reading XML from ${xmlFilePath}...`);
    const { readFileSync } = await import('fs');
    xml = readFileSync(xmlFilePath, 'utf8');
  } else {
    log(`Example: ${exampleName}`);
    log('Generating simulation XML...');
    const { OpenEMS, ContinuousStructure } = await import('../app/ems-api.mjs');
    const examples = await import('../app/examples.mjs');
    const exportName = EXAMPLE_MAP[exampleName];
    const example = examples[exportName];
    if (!example) {
      process.stderr.write(`Example export '${exportName}' not found in examples.mjs\n`);
      process.exit(1);
    }
    const scriptFn = new Function('OpenEMS', 'ContinuousStructure', example.script);
    xml = scriptFn(OpenEMS, ContinuousStructure);
  }
  if (!xml || typeof xml !== 'string') {
    process.stderr.write('No valid XML provided\n');
    process.exit(1);
  }
  log(`XML loaded (${(xml.length / 1024).toFixed(1)} KB)`);

  // 2. Load WASM module
  log('Loading WASM module...');
  const Module = await loadWASM({ onPrintErr: (msg) => process.stderr.write(`[wasm] ${msg}\n`) });
  log('WASM loaded.');

  // 3. Run simulation
  log('Starting simulation...');
  const t0 = performance.now();
  const result = await runSimulation(xml, { onLog: log, onStatus: status, Module });
  process.stderr.write('\n'); // clear status line
  const totalTime = ((performance.now() - t0) / 1000).toFixed(2);
  log(`Simulation complete: ${result.nrTS} timesteps in ${result.elapsed}s (total wall: ${totalTime}s)`);

  // 4. JSON mode: output raw results matching browser worker 'done' message format
  if (jsonMode) {
    const doneMsg = {
      type: 'done',
      nrTS: result.nrTS,
      elapsed: result.elapsed,
      fMax: result.fMax,
      probeData: result.probeData,
      nf2ffData: result.nf2ffData,
      fieldDumps: [],
    };
    process.stdout.write(JSON.stringify(doneMsg) + '\n');
    process.exit(0);
  }

  // 4b. Post-process for plot mode
  const parsedProbes = parseProbeData(result.probeData);
  const s11Result = computeS11(parsedProbes, result.fMax);
  const radData = extractRadiationData(result.nf2ffData);

  // 5. Generate and save plots
  let hasRsvg = false;
  try {
    const { execSync } = await import('child_process');
    execSync('which rsvg-convert', { stdio: 'ignore' });
    hasRsvg = true;
  } catch (e) {}

  if (s11Result) {
    // S11 plot
    const s11SVG = plotSVG({
      title: 'S11 (Return Loss)',
      xLabel: 'Frequency (GHz)',
      yLabel: 'S11 (dB)',
      lines: [{ x: s11Result.freqGHz, y: s11Result.s11_dB, label: 'S11', color: '#818cf8' }],
      markers: s11Result.bestS11 < -3 ? [{
        x: s11Result.bestFreqGHz, y: s11Result.bestS11,
        label: `${s11Result.bestFreqGHz.toFixed(2)} GHz, ${s11Result.bestS11.toFixed(1)} dB`,
        color: '#34d399',
      }] : [],
      refLines: [{ value: -10, label: '-10 dB', color: '#f87171' }],
    });

    const s11SvgPath = resolve(outputDir, `${exampleName}_s11.svg`);
    saveSVG(s11SVG, s11SvgPath);
    log(`Saved: ${s11SvgPath}`);

    if (hasRsvg) {
      const s11PngPath = resolve(outputDir, `${exampleName}_s11.png`);
      if (saveSVGtoPNG(s11SVG, 1040, 640, s11PngPath)) {
        log(`Saved: ${s11PngPath}`);
      }
    }

    // Impedance plot
    const zSVG = plotSVG({
      title: 'Input Impedance',
      xLabel: 'Frequency (GHz)',
      yLabel: 'Z (Ohm)',
      lines: [
        { x: s11Result.freqGHz, y: s11Result.zRe, label: 'Re(Z)', color: '#818cf8' },
        { x: s11Result.freqGHz, y: s11Result.zIm, label: 'Im(Z)', color: '#f87171' },
      ],
      refLines: [{ value: 50, label: '50\u2126', color: '#55556a' }],
      markers: [{
        x: s11Result.bestZFreqGHz, y: s11Result.bestZRe,
        label: `${s11Result.bestZFreqGHz.toFixed(2)} GHz, ${s11Result.bestZRe.toFixed(0)}+j${s11Result.bestZIm.toFixed(0)}\u2126`,
        color: '#34d399',
      }],
    });

    const zSvgPath = resolve(outputDir, `${exampleName}_impedance.svg`);
    saveSVG(zSVG, zSvgPath);
    log(`Saved: ${zSvgPath}`);

    if (hasRsvg) {
      const zPngPath = resolve(outputDir, `${exampleName}_impedance.png`);
      if (saveSVGtoPNG(zSVG, 1040, 640, zPngPath)) {
        log(`Saved: ${zPngPath}`);
      }
    }
  }

  if (radData) {
    const radSVG = polarPlotSVG({
      thetaDeg: radData.thetaDeg,
      xzPattern: radData.xzPattern,
      yzPattern: radData.yzPattern,
      peak: radData.DmaxdBi,
    });

    const radSvgPath = resolve(outputDir, `${exampleName}_radiation.svg`);
    saveSVG(radSVG, radSvgPath);
    log(`Saved: ${radSvgPath}`);

    if (hasRsvg) {
      const radPngPath = resolve(outputDir, `${exampleName}_radiation.png`);
      if (saveSVGtoPNG(radSVG, 1040, 640, radPngPath)) {
        log(`Saved: ${radPngPath}`);
      }
    }
  }

  // 6. Print summary
  process.stderr.write('\n');
  log('=== Summary ===');
  log(`Source: ${xmlFilePath || readStdin ? (xmlFilePath || 'stdin') : exampleName}`);
  log(`Timesteps: ${result.nrTS}`);
  log(`Elapsed: ${result.elapsed}s`);

  if (s11Result) {
    log(`Resonant frequency: ${s11Result.bestFreqGHz.toFixed(3)} GHz`);
    log(`Peak S11: ${s11Result.bestS11.toFixed(1)} dB`);
    log(`Best Z match: ${s11Result.bestZRe.toFixed(0)}+j${s11Result.bestZIm.toFixed(0)} Ohm @ ${s11Result.bestZFreqGHz.toFixed(3)} GHz`);
  }

  if (radData) {
    log(`Max directivity: ${radData.DmaxdBi.toFixed(1)} dBi @ ${radData.freqGHz.toFixed(3)} GHz`);
  }

  if (!hasRsvg) {
    log('Note: rsvg-convert not found. Only SVG files saved (install librsvg for PNG output).');
  }

  // JSON summary to stdout for structured consumption
  const summary = {
    example: exampleName,
    timesteps: result.nrTS,
    elapsed_s: parseFloat(result.elapsed),
    ...(s11Result ? {
      resonant_freq_GHz: parseFloat(s11Result.bestFreqGHz.toFixed(4)),
      peak_s11_dB: parseFloat(s11Result.bestS11.toFixed(2)),
    } : {}),
    ...(radData ? {
      max_directivity_dBi: parseFloat(radData.DmaxdBi.toFixed(2)),
    } : {}),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${err.message}\n`);
  if (err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
