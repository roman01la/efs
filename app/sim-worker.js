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

// ---- GPU FD accumulation setup ----

/**
 * Parse FD dump box info from C++ and build face descriptors for GPU accumulation.
 * Each face gets: indices, weights, frequencies, numPoints, numNeighbors, dualTime, fdInterval.
 */
function buildFDAccumulationFaces(ems, gridSize, dT) {
  const infoVec = ems.getDumpBoxFDInfo();
  const namesVec = ems.getDumpBoxFDNames();
  const count = infoVec.get(0) | 0;
  if (count === 0) { infoVec.delete(); namesVec.delete(); return []; }

  const [Nx, Ny, Nz] = gridSize;
  const cellStride = Nx * Ny * Nz;

  // Get edge lengths for interpolation weights
  const edgeLenVec = ems.getEdgeLengths(false);
  const edgeLen = new Float32Array(edgeLenVec.size());
  for (let i = 0; i < edgeLen.length; i++) edgeLen[i] = edgeLenVec.get(i);
  edgeLenVec.delete();

  const edgeLenDualVec = ems.getEdgeLengths(true);
  const edgeLenDual = new Float32Array(edgeLenDualVec.size());
  for (let i = 0; i < edgeLenDual.length; i++) edgeLenDual[i] = edgeLenDualVec.get(i);
  edgeLenDualVec.delete();

  const faces = [];
  let off = 1;

  for (let b = 0; b < count; b++) {
    const dumpType = infoVec.get(off) | 0; // 0=E, 1=H
    const dualTime = infoVec.get(off + 1) > 0;
    const fdInterval = infoVec.get(off + 2) | 0;
    const numFreqs = infoVec.get(off + 3) | 0;
    off += 4;

    const frequencies = new Float32Array(numFreqs);
    for (let f = 0; f < numFreqs; f++) frequencies[f] = infoVec.get(off + f);
    off += numFreqs;

    const nl = [infoVec.get(off)|0, infoVec.get(off+1)|0, infoVec.get(off+2)|0];
    off += 3;

    const posLines = [];
    for (let d = 0; d < 3; d++) {
      const arr = new Uint32Array(nl[d]);
      for (let j = 0; j < nl[d]; j++) arr[j] = infoVec.get(off + j) | 0;
      off += nl[d];
      posLines.push(arr);
    }

    const discLines = [];
    for (let d = 0; d < 3; d++) {
      const arr = new Float64Array(nl[d]);
      for (let j = 0; j < nl[d]; j++) arr[j] = infoVec.get(off + j);
      off += nl[d];
      discLines.push(arr);
    }

    const name = namesVec.get(b);
    const isEField = dumpType === 0;
    const numNeighbors = isEField ? 4 : 2;

    // Surface points: iterate over the 2D face
    const numPoints = nl[0] * nl[1] * nl[2];
    const allIndices = [];
    const allWeights = [];

    for (let comp = 0; comp < 3; comp++) {
      const nP = (comp + 1) % 3;
      const nPP = (comp + 2) % 3;

      for (let i0 = 0; i0 < nl[0]; i0++) {
        for (let i1 = 0; i1 < nl[1]; i1++) {
          for (let i2 = 0; i2 < nl[2]; i2++) {
            const pos = [posLines[0][i0], posLines[1][i1], posLines[2][i2]];

            if (isEField) {
              // E CELL_INTERPOLATE: average of 4 neighbors, each divided by edge length
              // Boundary: if any pos[d] >= NumLines[d]-1, field = 0
              const atBoundary = pos[0] >= Nx-1 || pos[1] >= Ny-1 || pos[2] >= Nz-1;

              const neighbors = [
                [pos[0], pos[1], pos[2]],
              ];
              const p1 = [...pos]; p1[nP]++;
              neighbors.push(p1);
              const p2 = [...pos]; p2[nP]++; p2[nPP]++;
              neighbors.push(p2);
              const p3 = [...pos]; p3[nPP]++;
              neighbors.push(p3);

              for (const nb of neighbors) {
                const idx = comp * cellStride + nb[0] * Ny * Nz + nb[1] * Nz + nb[2];
                allIndices.push(idx);
                if (atBoundary || nb[0] >= Nx || nb[1] >= Ny || nb[2] >= Nz) {
                  allWeights.push(0);
                } else {
                  const eLen = edgeLen[comp * cellStride + nb[0] * Ny * Nz + nb[1] * Nz + nb[2]];
                  allWeights.push(eLen > 0 ? 0.25 / eLen : 0);
                }
              }
            } else {
              // H CELL_INTERPOLATE: weighted interpolation along comp direction
              // raw_dual(pos) = curr / edgeLenDual, then weighted blend
              const atBoundary = pos[comp] >= (comp === 0 ? Nx : comp === 1 ? Ny : Nz) - 1;

              const idx0 = comp * cellStride + pos[0] * Ny * Nz + pos[1] * Nz + pos[2];
              const pos1 = [...pos]; pos1[comp]++;
              const idx1 = comp * cellStride + pos1[0] * Ny * Nz + pos1[1] * Nz + pos1[2];

              if (atBoundary) {
                allIndices.push(idx0, idx0); // dummy second index
                allWeights.push(0, 0);
              } else {
                const delta = edgeLenDual[idx0];
                const deltaUp = edgeLenDual[idx1];
                const deltaRel = (delta + deltaUp) > 0 ? delta / (delta + deltaUp) : 0;
                const w0 = delta > 0 ? (1 - deltaRel) / delta : 0;
                const w1 = deltaUp > 0 ? deltaRel / deltaUp : 0;
                allIndices.push(idx0, idx1);
                allWeights.push(w0, w1);
              }
            }
          }
        }
      }
    }

    faces.push({
      indices: new Uint32Array(allIndices),
      weights: new Float32Array(allWeights),
      numPoints,
      numNeighbors,
      numFreqs,
      frequencies,
      dualTime,
      fdInterval,
      isEField,
      name,
      discLines,
      numLines: nl,
      dT,
    });
  }

  infoVec.delete();
  namesVec.delete();
  return faces;
}

/**
 * Build surfaceData for computeNF2FF from GPU FD accumulator readback.
 * Pairs E and H faces by matching face geometry.
 */
function buildNF2FFSurfaceData(fdFaces, fdResults) {
  // Group faces: E faces and H faces, paired by order
  const eFaces = [], hFaces = [];
  for (let i = 0; i < fdFaces.length; i++) {
    (fdFaces[i].isEField ? eFaces : hFaces).push({ face: fdFaces[i], result: fdResults[i] });
  }

  const faces = [];
  const numPairs = Math.min(eFaces.length, hFaces.length);

  for (let fi = 0; fi < numPairs; fi++) {
    const eF = eFaces[fi], hF = hFaces[fi];
    const np = eF.face.numPoints;

    // Determine normal from collapsed dimension (numLines=1)
    const nl = eF.face.numLines;
    let normal = [0, 0, 0];
    for (let d = 0; d < 3; d++) {
      if (nl[d] === 1) {
        // Determine sign: negative face if this is an early face in the pair sequence
        normal[d] = (fi % 2 === 0) ? -1 : 1;
        break;
      }
    }

    // Convert GPU f32 accumulators to Float64Array with interleaved re/im per component
    const E = [], H = [];
    for (let comp = 0; comp < 3; comp++) {
      const eArr = new Float64Array(np * 2);
      const hArr = new Float64Array(np * 2);
      for (let p = 0; p < np; p++) {
        const eIdx = (0 * 3 * np + comp * np + p) * 2;
        const hIdx = (0 * 3 * np + comp * np + p) * 2;
        eArr[p * 2] = eF.result.data[eIdx];
        eArr[p * 2 + 1] = eF.result.data[eIdx + 1];
        hArr[p * 2] = hF.result.data[hIdx];
        hArr[p * 2 + 1] = hF.result.data[hIdx + 1];
      }
      E.push(eArr);
      H.push(hArr);
    }

    faces.push({
      E, H,
      mesh: {
        x: new Float64Array(eF.face.discLines[0]),
        y: new Float64Array(eF.face.discLines[1]),
        z: new Float64Array(eF.face.discLines[2]),
      },
      normal,
      meshType: 0,
    });
  }

  return { faces };
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

  // Configure GPU-side FD accumulation for NF2FF dump boxes
  // Initialize processing objects (needed for dump box numLines/posLines)
  ems.initProcessing();
  const fdFaces = buildFDAccumulationFaces(ems, config.gridSize, dT);
  let fdInterval = 0;
  if (fdFaces.length > 0) {
    gpuEngine.configureFDAccumulation(fdFaces);
    fdInterval = fdFaces[0].fdInterval;
    log(`  NF2FF: ${fdFaces.length} FD faces, accumulating every ${fdInterval} steps`);
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
  const stepSize = sampleInterval;

  let maxEnergy = 0;
  const energyCheckInterval = 1000;

  while (totalSteps < maxTS && !stopRequested) {
    const stepsThisBatch = Math.min(stepSize, maxTS - totalSteps);
    gpuEngine.iterate(stepsThisBatch);
    totalSteps += stepsThisBatch;

    // GPU FD accumulation for NF2FF (no readback, just a compute dispatch)
    if (fdInterval > 0) {
      gpuEngine.accumulateFD(totalSteps);
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
    if (totalSteps % energyCheckInterval < stepSize) {
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

  // Read FD accumulators from GPU and compute NF2FF
  let nf2ffData = null;
  if (fdFaces.length > 0) {
    try {
      const fdResults = await gpuEngine.readFDAccumulators();
      const surfaceData = buildNF2FFSurfaceData(fdFaces, fdResults);
      const { computeNF2FF } = await import('/src/nf2ff.mjs');

      // Use the first frequency from the FD faces
      const freqHz = fdFaces[0].frequencies[0];

      const thetaRad = [], thetaDeg = [];
      for (let t = -180; t < 180; t += 2) {
        thetaDeg.push(t);
        thetaRad.push(t * Math.PI / 180);
      }
      const phiRad = [0, Math.PI / 2];
      const result = computeNF2FF(surfaceData, freqHz, thetaRad, phiRad, [0, 0, 0]);
      const nAngles = thetaRad.length * phiRad.length;
      const E_norm = new Float64Array(nAngles);
      for (let i = 0; i < nAngles; i++) {
        E_norm[i] = Math.sqrt(
          result.E_theta_re[i] ** 2 + result.E_theta_im[i] ** 2 +
          result.E_phi_re[i] ** 2 + result.E_phi_im[i] ** 2
        );
      }
      nf2ffData = {
        freqHz, thetaDeg, E_norm: Array.from(E_norm),
        Dmax: result.Dmax, nPhi: phiRad.length,
      };
      const DmaxdBi = 10 * Math.log10(Math.max(result.Dmax, 1e-15));
      log(`Far-field computed: Dmax = ${DmaxdBi.toFixed(1)} dBi at ${(freqHz / 1e9).toFixed(3)} GHz`);
    } catch (e) {
      log(`NF2FF computation failed: ${e.message}`);
    }
  }

  gpuEngine.destroy();

  // Collect results
  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

  // Read probe files from WASM FS
  const probeData = {};
  try {
    const files = Module.FS.readdir(simPath);
    for (const f of files) {
      if (f.startsWith('port_') && (f.includes('_ut') || f.includes('_it'))) {
        probeData[f] = new TextDecoder().decode(Module.FS.readFile(`${simPath}/${f}`));
      }
    }
  } catch (e) {}

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
