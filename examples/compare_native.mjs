/**
 * Run examples via WASM, then run the same XML natively, compare results.
 * Requires: build-native/openEMS (native binary)
 */
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE = join(ROOT, 'build-native', 'openEMS');

// Load WASM
const mf = await import(join(ROOT, 'build-wasm/openems.js'));
const Module = await (mf.default || mf)();

function parseProbe(text) {
  const lines = text.split('\n').filter(l => !l.startsWith('%') && l.trim());
  return lines.map(l => {
    const parts = l.trim().split(/\s+/);
    return { t: parseFloat(parts[0]), v: parseFloat(parts[1]) };
  });
}

function maxAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i].v - b[i].v);
    if (d > max) max = d;
  }
  return max;
}

function maxRelDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let max = 0;
  const peakA = a.reduce((m, p) => Math.max(m, Math.abs(p.v)), 0);
  const peakB = b.reduce((m, p) => Math.max(m, Math.abs(p.v)), 0);
  const peak = Math.max(peakA, peakB);
  if (peak === 0) return 0;
  for (let i = 0; i < n; i++) {
    // Relative to peak (not per-sample) to avoid divide-by-zero
    const d = Math.abs(a[i].v - b[i].v) / peak;
    if (d > max) max = d;
  }
  return max;
}

async function compareExample(name, setupFn, probeNames) {
  console.log(`\n=== ${name}: WASM vs Native ===`);

  // Run WASM
  console.log('  Running WASM...');
  const { sim, ems, simPath } = await setupFn(Module);
  const wasmProbes = {};
  for (const pn of probeNames) {
    try {
      const text = ems.readFile(`${simPath}/${pn}`);
      wasmProbes[pn] = parseProbe(text);
    } catch { wasmProbes[pn] = null; }
  }

  // Get XML for native run
  const xml = sim.toXML();
  ems.delete();

  // Run native
  console.log('  Running Native...');
  const nativeDir = join(ROOT, 'tmp_native_' + name);
  if (!existsSync(nativeDir)) mkdirSync(nativeDir, { recursive: true });
  const xmlPath = join(nativeDir, 'sim.xml');
  writeFileSync(xmlPath, xml);
  try {
    execSync(`cd "${nativeDir}" && "${NATIVE}" "${xmlPath}" --engine=sse`, {
      timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // openEMS exits with non-zero on warnings, check if files exist
  }

  const nativeProbes = {};
  for (const pn of probeNames) {
    const fp = join(nativeDir, pn);
    try {
      nativeProbes[pn] = parseProbe(readFileSync(fp, 'utf-8'));
    } catch { nativeProbes[pn] = null; }
  }

  // Compare
  let allPass = true;
  for (const pn of probeNames) {
    const w = wasmProbes[pn];
    const n = nativeProbes[pn];
    if (!w) { console.log(`  ${pn}: WASM probe missing`); allPass = false; continue; }
    if (!n) { console.log(`  ${pn}: Native probe missing`); allPass = false; continue; }

    const absDiff = maxAbsDiff(w, n);
    const relDiff = maxRelDiff(w, n);
    const peakW = w.reduce((m, p) => Math.max(m, Math.abs(p.v)), 0);
    const peakN = n.reduce((m, p) => Math.max(m, Math.abs(p.v)), 0);
    // Pass if: same sample count and relative diff < 2%, OR absolute diff < 1e-5
    const pass = (w.length === n.length && relDiff < 0.02) || absDiff < 1e-5;
    console.log(`  ${pn}: ${w.length}/${n.length} samples, absDiff=${absDiff.toExponential(3)}, relDiff=${(relDiff*100).toFixed(2)}%, peakW=${peakW.toExponential(3)}, peakN=${peakN.toExponential(3)} ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) allPass = false;
  }

  // Cleanup
  execSync(`rm -rf "${nativeDir}"`);
  return allPass;
}

// --- Patch Antenna ---
import { Simulation } from '../src/simulation.mjs';
import { C0, EPS0, linspace } from '../src/analysis.mjs';
import { smoothMeshLines } from '../src/automesh.mjs';

async function setupPatch(M) {
  const f0 = 2e9, fc = 1e9;
  const patch_width = 32, patch_length = 40;
  const substrate_epsR = 3.38;
  const substrate_kappa = 1e-3 * 2 * Math.PI * 2.45e9 * EPS0 * substrate_epsR;
  const substrate_width = 60, substrate_length = 60, substrate_thickness = 1.524;
  const feed_pos = -6, feed_R = 50;
  const SimBox = [200, 200, 150];
  const mesh_res = C0 / (f0 + fc) / 1e-3 / 20;

  const sim = new Simulation(M, { nrTS: 30000, endCriteria: 1e-4 });
  sim.setExcitation({ type: 'gauss', f0, fc });
  sim.setBoundaryConditions(['MUR','MUR','MUR','MUR','MUR','MUR']);

  let xLines = [-SimBox[0]/2, -patch_width/2, patch_width/2, SimBox[0]/2];
  let yLines = [-SimBox[1]/2, -patch_length/2, patch_length/2, SimBox[1]/2];
  let zLines = [-SimBox[2]/3, 0, substrate_thickness, SimBox[2]*2/3];
  for (let i = 0; i <= 4; i++) zLines.push(substrate_thickness * i / 4);
  xLines = smoothMeshLines([...new Set(xLines)].sort((a,b)=>a-b), mesh_res);
  yLines = smoothMeshLines([...new Set(yLines)].sort((a,b)=>a-b), mesh_res);
  zLines = smoothMeshLines([...new Set(zLines)].sort((a,b)=>a-b), mesh_res);
  sim.setGrid(1e-3, xLines, yLines, zLines);

  sim.addMetal('patch').addBox([-patch_width/2,-patch_length/2,substrate_thickness],
    [patch_width/2,patch_length/2,substrate_thickness], 10);
  sim.addMaterial('substrate',{epsilon:substrate_epsR,kappa:substrate_kappa}).addBox(
    [-substrate_width/2,-substrate_length/2,0],[substrate_width/2,substrate_length/2,substrate_thickness]);
  sim.addMetal('gnd').addBox([-substrate_width/2,-substrate_length/2,0],
    [substrate_width/2,substrate_length/2,0], 10);
  sim.addLumpedPort({portNr:1,R:feed_R,start:[feed_pos,0,0],stop:[feed_pos,0,substrate_thickness],
    excDir:2,excite:1,priority:5});

  const { module:MM, ems, simPath } = await sim.runDirect({ engineType: 2 });
  return { sim, ems, simPath };
}

// --- MSL Notch ---
async function setupMSL(M) {
  const unit=1e-6, MSL_length=50000, MSL_width=600, substrate_thickness=254;
  const substrate_epr=3.66, stub_length=12e3, f_max=7e9;
  const resolution = C0/(f_max*Math.sqrt(substrate_epr))/unit/50;
  const third_mesh = [2*resolution/3/4, -resolution/3/4];

  const sim = new Simulation(M, {nrTS:1000000, endCriteria:1e-5});
  sim.setExcitation({type:'gauss',f0:f_max/2,fc:f_max/2});
  sim.setBoundaryConditions(['PML_8','PML_8','MUR','MUR','PEC','MUR']);

  let xLines=[0,MSL_width/2+third_mesh[0],MSL_width/2+third_mesh[1],
    -MSL_width/2-third_mesh[0],-MSL_width/2-third_mesh[1],-MSL_length,MSL_length];
  let yLines=[0,MSL_width/2+third_mesh[0],MSL_width/2+third_mesh[1],
    -MSL_width/2-third_mesh[0],-MSL_width/2-third_mesh[1],
    -15*MSL_width,15*MSL_width+stub_length,
    MSL_width/2+stub_length+third_mesh[0],MSL_width/2+stub_length+third_mesh[1]];
  let zLines=[]; for(let i=0;i<=4;i++) zLines.push(substrate_thickness*i/4); zLines.push(3000);
  sim.setGrid(unit, xLines, yLines, zLines);
  sim.smoothGrid(resolution);

  sim.addMaterial('RO4350B',{epsilon:substrate_epr}).addBox(
    [-MSL_length,-15*MSL_width,0],[MSL_length,15*MSL_width+stub_length,substrate_thickness]);
  sim.addMetal('PEC');
  sim.addMSLPort({portNr:1,metalProp:'PEC',
    start:[-MSL_length,-MSL_width/2,substrate_thickness],stop:[0,MSL_width/2,0],
    propDir:0,excDir:2,excite:-1,priority:10,feedShift:10*resolution,measPlaneShift:MSL_length/3});
  sim.addMSLPort({portNr:2,metalProp:'PEC',
    start:[MSL_length,-MSL_width/2,substrate_thickness],stop:[0,MSL_width/2,0],
    propDir:0,excDir:2,priority:10,measPlaneShift:MSL_length/3});
  sim.addMetal('PEC').addBox([-MSL_width/2,MSL_width/2,substrate_thickness],
    [MSL_width/2,MSL_width/2+stub_length,substrate_thickness],10);

  const { module:MM, ems, simPath } = await sim.runDirect({ engineType: 2 });
  return { sim, ems, simPath };
}

// --- Rect Waveguide ---
async function setupWG(M) {
  const unit=1e-6, a=10700, b=4300, length=50000;
  const f_start=20e9, f_stop=26e9;
  const mesh_res = C0/((f_start+f_stop)/2)/unit/30;

  const sim = new Simulation(M, {nrTS:10000, endCriteria:1e-5});
  sim.setExcitation({type:'gauss',f0:0.5*(f_start+f_stop),fc:0.5*(f_stop-f_start)});
  sim.setBoundaryConditions(['PEC','PEC','PEC','PEC','PML_8','PML_8']);
  sim.setGrid(unit, [0,a], [0,b], [0,length]);
  sim.smoothGrid(mesh_res);

  sim.addRectWaveGuidePort({portNr:0,start:[0,0,10*mesh_res],stop:[a,b,15*mesh_res],
    excDir:2,a:a*unit,b:b*unit,modeName:'TE10',excite:1,unit});
  sim.addRectWaveGuidePort({portNr:1,start:[0,0,length-10*mesh_res],stop:[a,b,length-15*mesh_res],
    excDir:2,a:a*unit,b:b*unit,modeName:'TE10',unit});

  const { module:MM, ems, simPath } = await sim.runDirect({ engineType: 2 });
  return { sim, ems, simPath };
}

// --- Run comparisons ---
let totalPass = 0, totalFail = 0;

const r1 = await compareExample('Patch Antenna', setupPatch,
  ['port_ut_1', 'port_it_1']);
if (r1) totalPass++; else totalFail++;

const r2 = await compareExample('MSL Notch Filter', setupMSL,
  ['port_ut_1A', 'port_ut_1B', 'port_ut_1C', 'port_it_1A', 'port_it_1B',
   'port_ut_2A', 'port_ut_2B', 'port_ut_2C', 'port_it_2A', 'port_it_2B']);
if (r2) totalPass++; else totalFail++;

const r3 = await compareExample('Rect Waveguide', setupWG,
  ['port_ut_0', 'port_it_0', 'port_ut_1', 'port_it_1']);
if (r3) totalPass++; else totalFail++;

console.log(`\n=== Summary: ${totalPass} pass, ${totalFail} fail ===`);
process.exit(totalFail > 0 ? 1 : 0);
