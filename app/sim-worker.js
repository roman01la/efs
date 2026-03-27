/**
 * Simulation Web Worker.
 * Runs WASM + WebGPU FDTD simulation off the main thread.
 *
 * Messages IN:  { type: 'run', xml: string }
 *               { type: 'stop' }
 * Messages OUT: { type: 'log', msg: string }
 *               { type: 'status', step: number, maxTS: number }
 *               { type: 'done', nrTS, elapsed, probeData, nf2ffData? }
 *               { type: 'error', msg: string }
 */

let stopRequested = false;

function log(msg) { postMessage({ type: 'log', msg }); }
function status(step, maxTS) { postMessage({ type: 'status', step, maxTS }); }

// ---- WASM loading ----
let wasmModule = null;

async function loadWASM() {
  if (wasmModule) return wasmModule;
  importScripts('/build-wasm/openems.js');
  wasmModule = await createOpenEMS({
    locateFile: (path) => '/build-wasm/' + path,
    mainScriptUrlOrBlob: '/build-wasm/openems.js',
  });
  log('WASM module loaded.');
  return wasmModule;
}

// ---- Embind helpers ----

function _embindVecToF32(vec) {
  const arr = new Float32Array(vec.size());
  for (let i = 0; i < arr.length; i++) arr[i] = vec.get(i);
  vec.delete();
  return arr;
}

function extractGPUConfig(ems) {
  const gridSizeVec = ems.getGridSize();
  const gridSize = [gridSizeVec.get(0), gridSizeVec.get(1), gridSizeVec.get(2)];
  gridSizeVec.delete();
  const vv = _embindVecToF32(ems.getVV());
  const vi = _embindVecToF32(ems.getVI());
  const ii = _embindVecToF32(ems.getII());
  const iv = _embindVecToF32(ems.getIV());

  let excitation = null;
  const sigVec = ems.getExcitationSignal();
  if (sigVec.size() > 0) {
    const signal = _embindVecToF32(sigVec);
    const excVec = ems.getExcitationVoltages();
    const count = excVec.get(0) | 0;
    if (count > 0) {
      const amp = new Float32Array(count);
      const delay = new Uint32Array(count);
      const dir = new Uint32Array(count);
      const pos = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        amp[i] = excVec.get(1 + i);
        delay[i] = excVec.get(1 + count + i);
        dir[i] = excVec.get(1 + 2 * count + i);
        pos[i] = excVec.get(1 + 3 * count + i);
      }
      excitation = { signal, amp, delay, dir, pos, period: ems.getExcitationPeriod() };
    }
    excVec.delete();
  } else {
    sigVec.delete();
  }

  const pmlRegions = [];
  const pmlCount = ems.getPMLCount();
  for (let p = 0; p < pmlCount; p++) {
    const vec = ems.getPMLRegion(p);
    const startPos = [vec.get(0), vec.get(1), vec.get(2)];
    const numLines = [vec.get(3), vec.get(4), vec.get(5)];
    const total = 3 * numLines[0] * numLines[1] * numLines[2];
    let off = 6;
    const extract = () => {
      const a = new Float32Array(total);
      for (let i = 0; i < total; i++) a[i] = vec.get(off + i);
      off += total;
      return a;
    };
    pmlRegions.push({
      startPos, numLines,
      vv: extract(), vvfo: extract(), vvfn: extract(),
      ii: extract(), iifo: extract(), iifn: extract(),
    });
    vec.delete();
  }

  const murRegions = [];
  const murCount = ems.getMurCount();
  for (let m = 0; m < murCount; m++) {
    const vec = ems.getMurRegion(m);
    const ny = vec.get(0) | 0;
    const top = vec.get(1) > 0;
    const lineNr = vec.get(2) | 0;
    const lineNrShift = vec.get(3) | 0;
    const n0 = vec.get(4) | 0;
    const n1 = vec.get(5) | 0;
    const coeffP = new Float32Array(n0 * n1);
    const coeffPP = new Float32Array(n0 * n1);
    for (let i = 0; i < n0 * n1; i++) coeffP[i] = vec.get(6 + i);
    for (let i = 0; i < n0 * n1; i++) coeffPP[i] = vec.get(6 + n0 * n1 + i);
    murRegions.push({ ny, top, lineNr, lineNrShift, numLines: [n0, n1], coeffNyP: coeffP, coeffNyPP: coeffPP });
    vec.delete();
  }

  return { gridSize, coefficients: { vv, vi, ii, iv }, excitation, pmlRegions, murRegions };
}

function parseProbeInfo(ems) {
  const infoVec = ems.getProbeInfo();
  const namesVec = ems.getProbeNames();
  const count = infoVec.get(0) | 0;
  const probes = [];
  let off = 1;
  for (let i = 0; i < count; i++) {
    probes.push({
      type: infoVec.get(off) | 0,
      normDir: infoVec.get(off+1) | 0,
      weight: infoVec.get(off+2),
      processInterval: infoVec.get(off+3) | 0,
      start: [infoVec.get(off+4)|0, infoVec.get(off+5)|0, infoVec.get(off+6)|0],
      stop: [infoVec.get(off+7)|0, infoVec.get(off+8)|0, infoVec.get(off+9)|0],
      startInside: [infoVec.get(off+10)>0, infoVec.get(off+11)>0, infoVec.get(off+12)>0],
      stopInside: [infoVec.get(off+13)>0, infoVec.get(off+14)>0, infoVec.get(off+15)>0],
      name: namesVec.get(i),
    });
    off += 16;
  }
  infoVec.delete();
  namesVec.delete();
  return probes;
}

function buildGatherIndices(probes, gridSize) {
  const [Nx, Ny, Nz] = gridSize;
  const cellStride = Nx * Ny * Nz;
  const allIndices = [];
  const probeSlices = [];

  for (const p of probes) {
    const offset = allIndices.length;
    if (p.type === 0) {
      const voltSigns = [];
      for (let n = 0; n < 3; n++) {
        const lo = Math.min(p.start[n], p.stop[n]);
        const hi = Math.max(p.start[n], p.stop[n]);
        if (lo === hi) continue;
        const sign = p.start[n] < p.stop[n] ? 1 : -1;
        for (let pos_n = lo; pos_n < hi; pos_n++) {
          const xyz = [p.start[0], p.start[1], p.start[2]];
          xyz[n] = pos_n;
          allIndices.push(n * cellStride + xyz[0] * Ny * Nz + xyz[1] * Nz + xyz[2]);
          voltSigns.push(sign);
        }
      }
      probeSlices.push({ offset, count: allIndices.length - offset, type: 'voltage', voltSigns });
    } else {
      const s = p.start, t = p.stop, si = p.startInside, so = p.stopInside;
      const edges = [];
      const addEdge = (n, xyz, sign) => { edges.push({ n, xyz: [...xyz], sign }); };
      switch (p.normDir) {
      case 0:
        if (so[0] && si[2]) for (let i = s[1]+1; i <= t[1]; i++) addEdge(1, [t[0], i, s[2]], 1);
        if (so[0] && so[1]) for (let i = s[2]+1; i <= t[2]; i++) addEdge(2, [t[0], t[1], i], 1);
        if (si[0] && so[2]) for (let i = s[1]+1; i <= t[1]; i++) addEdge(1, [s[0], i, t[2]], -1);
        if (si[0] && si[1]) for (let i = s[2]+1; i <= t[2]; i++) addEdge(2, [s[0], s[1], i], -1);
        break;
      case 1:
        if (si[0] && si[1]) for (let i = s[2]+1; i <= t[2]; i++) addEdge(2, [s[0], s[1], i], 1);
        if (so[1] && so[2]) for (let i = s[0]+1; i <= t[0]; i++) addEdge(0, [i, t[1], t[2]], 1);
        if (so[0] && so[1]) for (let i = s[2]+1; i <= t[2]; i++) addEdge(2, [t[0], t[1], i], -1);
        if (si[1] && si[2]) for (let i = s[0]+1; i <= t[0]; i++) addEdge(0, [i, s[1], s[2]], -1);
        break;
      case 2:
        if (si[1] && si[2]) for (let i = s[0]+1; i <= t[0]; i++) addEdge(0, [i, s[1], s[2]], 1);
        if (so[0] && si[2]) for (let i = s[1]+1; i <= t[1]; i++) addEdge(1, [t[0], i, s[2]], 1);
        if (so[1] && so[2]) for (let i = s[0]+1; i <= t[0]; i++) addEdge(0, [i, t[1], t[2]], -1);
        if (si[0] && so[2]) for (let i = s[1]+1; i <= t[1]; i++) addEdge(1, [s[0], i, t[2]], -1);
        break;
      }
      for (const e of edges) {
        allIndices.push(e.n * cellStride + e.xyz[0] * Ny * Nz + e.xyz[1] * Nz + e.xyz[2]);
      }
      probeSlices.push({ offset, count: allIndices.length - offset, type: 'current', edges });
    }
  }
  return { indices: new Uint32Array(allIndices), probeSlices };
}

function computeProbeIntegrals(gathered, probes, probeSlices) {
  const results = [];
  for (let p = 0; p < probes.length; p++) {
    const slice = probeSlices[p];
    let value = 0;
    if (slice.type === 'voltage') {
      for (let i = 0; i < slice.count; i++) {
        value += gathered[(slice.offset + i) * 2] * slice.voltSigns[i];
      }
    } else {
      for (let i = 0; i < slice.count; i++) {
        value += gathered[(slice.offset + i) * 2 + 1] * slice.edges[i].sign;
      }
    }
    results.push(value * probes[p].weight);
  }
  return results;
}

// ---- NF2FF helpers ----

function readNF2FFData(Module, ems, simPath) {
  let files;
  try { files = Module.FS.readdir(simPath); } catch (e) { return null; }

  const nf2ffBoxes = new Set();
  for (const f of files) {
    const m = f.match(/^(.+)_E_(?:xn|0)\.h5$/);
    if (m) nf2ffBoxes.add(m[1]);
  }
  if (nf2ffBoxes.size === 0) return null;

  const boxName = [...nf2ffBoxes][0];

  // Read frequency from HDF5
  let freqHz = null;
  try {
    const eFile = files.includes(`${boxName}_E_0.h5`)
      ? `${simPath}/${boxName}_E_0.h5`
      : `${simPath}/${boxName}_E_xn.h5`;
    const freqVec = ems.readHDF5Frequencies(eFile);
    if (freqVec.size() > 0) freqHz = freqVec.get(0);
    freqVec.delete();
  } catch(e) {}

  return { boxName, freqHz, files };
}

// ---- Main simulation ----

async function runSimulation(xml) {
  const t0 = performance.now();
  stopRequested = false;

  const Module = await loadWASM();

  const simPath = '/sim_' + Date.now();
  try { Module.FS.mkdir(simPath); } catch (e) {}
  Module.FS.chdir(simPath);

  const ems = new Module.OpenEMS();
  ems.configure(0, 1000000, 1e-5);

  log('Loading XML config...');
  if (!ems.loadXML(xml)) throw new Error('Failed to load simulation XML');

  log('Setting up FDTD...');
  const rc = ems.setup();
  if (rc !== 0) throw new Error(`SetupFDTD failed with code ${rc}`);

  log('Running FDTD engine (WebGPU hybrid)...');

  // Extract GPU config
  const config = extractGPUConfig(ems);
  log(`Grid: ${config.gridSize.join('x')}, ${config.pmlRegions.length} PML, ${config.murRegions.length} Mur`);

  const { WebGPUEngine } = await import('/src/webgpu-engine.mjs');
  const gpuEngine = new WebGPUEngine();
  if (!await gpuEngine.initGPU()) throw new Error('WebGPU not available');

  await gpuEngine.init(config.gridSize, config.coefficients);
  if (config.excitation) gpuEngine.configureExcitation(config.excitation);
  if (config.pmlRegions.length > 0) gpuEngine.configurePML(config.pmlRegions);
  if (config.murRegions.length > 0) gpuEngine.configureMur(config.murRegions);
  log('WebGPU engine initialized.');
  log(`  Excitation: ${config.excitation?.pos?.length || 0} sources`);

  const probes = parseProbeInfo(ems);
  const dT = ems.getSimDT();
  const { indices, probeSlices } = buildGatherIndices(probes, config.gridSize);
  gpuEngine.configureProbeGather(indices);
  log(`  Probes: ${probes.length} (${indices.length} gather indices)`);

  // Parse XML for dump boxes and FDTD params
  // DOMParser not available in workers — use regex
  const hasDumpBoxes = /<DumpBox\b/i.test(xml);
  let cppProcessInterval = 0;
  if (hasDumpBoxes) {
    const step0 = ems.initRun();
    if (step0 > 0) cppProcessInterval = step0;
    log(`  Dump boxes detected: C++ processing every ${cppProcessInterval} steps`);
  }

  const maxTS = ems.getMaxTimesteps();
  const fMaxMatch = xml.match(/f_max\s*=\s*"([^"]+)"/);
  const fMax = fMaxMatch ? parseFloat(fMaxMatch[1]) : 0;
  const endCritMatch = xml.match(/endCriteria\s*=\s*"([^"]+)"/);
  const endCrit = endCritMatch ? parseFloat(endCritMatch[1]) : 1e-5;

  let totalSteps = 0;
  const probeTS = probes.map(() => ({ time: [], values: [] }));

  const baseInterval = probes.length > 0 ? probes[0].processInterval : 24;
  const maxProbeSteps = fMax > 0 ? Math.floor(0.5 / (fMax * dT)) : baseInterval * 10;
  const probeMult = Math.max(1, Math.floor(maxProbeSteps / baseInterval));
  const sampleInterval = baseInterval * probeMult;

  const stepSize = cppProcessInterval > 0
    ? Math.min(cppProcessInterval, sampleInterval)
    : sampleInterval;

  let maxEnergy = 0;
  const energyCheckInterval = 1000;
  let _voltStage = 0, _currStage = 0;

  while (totalSteps < maxTS && !stopRequested) {
    const stepsThisBatch = Math.min(stepSize, maxTS - totalSteps);
    gpuEngine.iterate(stepsThisBatch);
    totalSteps += stepsThisBatch;

    // C++ processing for dump boxes
    if (cppProcessInterval > 0 && totalSteps % cppProcessInterval === 0) {
      const fields = await gpuEngine.getFields();
      if (!_voltStage) {
        const n = fields.volt.length * 4;
        _voltStage = Module._malloc(n);
        _currStage = Module._malloc(n);
      }
      Module.HEAPF32.set(fields.volt, _voltStage >> 2);
      Module.HEAPF32.set(fields.curr, _currStage >> 2);
      ems.copyFieldsFromStaging(_voltStage, _currStage, fields.volt.length);
      ems.setTimestepCount(totalSteps);
      const nextStep = ems.doProcess();
      if (nextStep <= 0) break;
    }

    // Probe gather
    if (totalSteps % sampleInterval === 0) {
      const gathered = await gpuEngine.readProbeGather();
      if (gathered) {
        const integrals = computeProbeIntegrals(gathered, probes, probeSlices);
        for (let p = 0; p < probes.length; p++) {
          const isDual = probes[p].type === 1;
          const time = (totalSteps + (isDual ? 0.5 : 0)) * dT;
          probeTS[p].time.push(time);
          probeTS[p].values.push(integrals[p]);
        }
      }
    }

    // Energy end-criteria
    if (cppProcessInterval === 0 && totalSteps % energyCheckInterval < stepSize) {
      const energy = await gpuEngine.computeEnergy();
      if (energy > maxEnergy) maxEnergy = energy;
      if (maxEnergy > 0 && (energy / maxEnergy) <= endCrit) {
        log(`  End criteria met at step ${totalSteps} (energy ratio: ${(energy/maxEnergy).toExponential(2)})`);
        break;
      }
    }

    status(totalSteps, maxTS);
    if (totalSteps % 1000 < stepSize) log(`  Step ${totalSteps}/${maxTS}`);
  }

  if (cppProcessInterval > 0) ems.finalizeRun();

  // Write probe data to WASM FS
  for (let p = 0; p < probes.length; p++) {
    const probe = probes[p];
    const ts = probeTS[p];
    const typeStr = probe.type === 0 ? 'voltage' : 'current';
    let content = `% time-domain ${typeStr} integration by openEMS (WebGPU)\n`;
    content += `% t/s\t${typeStr}\n`;
    for (let i = 0; i < ts.time.length; i++) {
      content += `${ts.time[i]}\t${ts.values[i]}\n`;
    }
    try {
      Module.FS.writeFile(`${simPath}/${probe.name}`, new TextEncoder().encode(content));
    } catch (e) {}
  }

  gpuEngine.destroy();

  // Collect results
  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

  // Read probe files
  const probeData = {};
  try {
    const files = Module.FS.readdir(simPath);
    for (const f of files) {
      if (f.startsWith('port_') && (f.includes('_ut') || f.includes('_it'))) {
        probeData[f] = new TextDecoder().decode(Module.FS.readFile(`${simPath}/${f}`));
      }
    }
  } catch (e) {}

  // NF2FF data
  let nf2ffData = null;
  const nf2ffInfo = readNF2FFData(Module, ems, simPath);
  if (nf2ffInfo?.freqHz) {
    try {
      const { readNF2FFSurfaceData, computeNF2FF } = await import('/src/nf2ff.mjs');
      const surfaceData = readNF2FFSurfaceData(ems, simPath, nf2ffInfo.boxName, { frequency: nf2ffInfo.freqHz });

      const thetaRad = [], thetaDeg = [];
      for (let t = -180; t < 180; t += 2) {
        thetaDeg.push(t);
        thetaRad.push(t * Math.PI / 180);
      }
      const phiRad = [0, Math.PI / 2];
      const result = computeNF2FF(surfaceData, nf2ffInfo.freqHz, thetaRad, phiRad, [0, 0, 0]);
      const nAngles = thetaRad.length * phiRad.length;
      const E_norm = new Float64Array(nAngles);
      for (let i = 0; i < nAngles; i++) {
        E_norm[i] = Math.sqrt(
          result.E_theta_re[i] ** 2 + result.E_theta_im[i] ** 2 +
          result.E_phi_re[i] ** 2 + result.E_phi_im[i] ** 2
        );
      }
      nf2ffData = {
        freqHz: nf2ffInfo.freqHz,
        thetaDeg, E_norm: Array.from(E_norm),
        Dmax: result.Dmax, nPhi: phiRad.length,
      };
      const DmaxdBi = 10 * Math.log10(Math.max(result.Dmax, 1e-15));
      log(`Far-field computed: Dmax = ${DmaxdBi.toFixed(1)} dBi at ${(nf2ffInfo.freqHz / 1e9).toFixed(3)} GHz`);
    } catch (e) {
      log(`NF2FF computation failed: ${e.message}`);
    }
  }

  ems.delete();

  return { nrTS: totalSteps, elapsed, probeData, nf2ffData };
}

// ---- Message handler ----

self.onmessage = async (e) => {
  const { type, xml } = e.data;
  if (type === 'stop') {
    stopRequested = true;
    return;
  }
  if (type === 'run') {
    try {
      const result = await runSimulation(xml);
      postMessage({ type: 'done', ...result });
    } catch (err) {
      postMessage({ type: 'error', msg: err.message });
    }
  }
};
