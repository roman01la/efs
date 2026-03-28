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

function buildMurConfig(murRegions, gridSize) {
  const [Nx, Ny, Nz] = gridSize;
  const dims = [Nx, Ny, Nz];
  const stride = Nx * Ny * Nz;
  const allCoeffP = [], allCoeffPP = [];
  const allNormalIdx = [], allShiftedIdx = [];

  for (const r of murRegions) {
    const ny = r.ny;
    const nP = (ny + 1) % 3, nPP = (ny + 2) % 3;
    const [n0, n1] = r.numLines;

    for (let i1 = 0; i1 < n1; i1++) {
      for (let i0 = 0; i0 < n0; i0++) {
        const idx = i0 + i1 * n0;
        const pos = [0, 0, 0];
        pos[ny] = r.lineNr;
        // Map the 2D face indices to the two tangential directions
        const tangDirs = [nP, nPP];
        pos[tangDirs[0]] = i0;
        pos[tangDirs[1]] = i1;
        const flatIdx = pos[0] * Ny * Nz + pos[1] * Nz + pos[2];

        const posShift = [...pos];
        posShift[ny] = r.lineNrShift;
        const flatShift = posShift[0] * Ny * Nz + posShift[1] * Nz + posShift[2];

        // nyP component
        allCoeffP.push(r.coeffNyP[idx]);
        allNormalIdx.push(nP * stride + flatIdx);
        allShiftedIdx.push(nP * stride + flatShift);

        // nyPP component
        allCoeffPP.push(r.coeffNyPP[idx]);
        allNormalIdx.push(nPP * stride + flatIdx);
        allShiftedIdx.push(nPP * stride + flatShift);
      }
    }
  }

  const total = allNormalIdx.length;
  return {
    coeff: new Float32Array(allCoeffP.concat(allCoeffPP)),
    normal_idx: new Uint32Array(allNormalIdx),
    shifted_idx: new Uint32Array(allShiftedIdx),
  };
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

/**
 * Parse NF2FF configuration from simulation XML.
 * Extracts DumpBox elements for NF2FF (DumpType="10" for E, "11" for H),
 * the FD_Samples frequency, and the face box coordinates.
 *
 * @param {string} xml - simulation XML
 * @returns {Object|null} { frequency, faces: [{start, stop, normal, normalDir, normalSign}] }
 */
function parseNF2FFConfigFromXML(xml) {
  // Find all nf2ff E-field dump boxes (DumpType="10").
  // Handles both formats:
  //   1. Single DumpBox with 6 Box primitives (hardcoded XML)
  //   2. Six separate DumpBox elements, one per face (API-generated XML)
  const allDumpBoxRegex = /<DumpBox\b([^>]*)>([\s\S]*?)<\/DumpBox>/gi;
  let frequency = null;
  const faces = [];
  let dbMatch;
  while ((dbMatch = allDumpBoxRegex.exec(xml)) !== null) {
    const attrs = dbMatch[1];
    const nameM = attrs.match(/Name="([^"]+)"/);
    const typeM = attrs.match(/DumpType="(\d+)"/);
    if (!nameM || !typeM || !/nf2ff/i.test(nameM[1]) || typeM[1] !== '10') continue;
    // Skip H-field dumps (DumpType 11) — only process E-field dumps
    // But also accept boxes without "E" in name (e.g. just "nf2ff_E" or "nf2ff_E_xn")

    const dumpContent = dbMatch[2];

    // Extract FD_Samples frequency (use the first one found)
    if (frequency === null) {
      const fdMatch = dumpContent.match(/<FD_Samples[^>]*>([^<]+)<\/FD_Samples>/i);
      if (fdMatch) {
        const f = parseFloat(fdMatch[1]);
        if (!isNaN(f) && f > 0) frequency = f;
      }
    }

    // Extract all Box primitives from this DumpBox
    const boxRegex = /<Box\b[^>]*>\s*<P1\s+X="([^"]+)"\s+Y="([^"]+)"\s+Z="([^"]+)"[^/]*\/>\s*<P2\s+X="([^"]+)"\s+Y="([^"]+)"\s+Z="([^"]+)"[^/]*\/>\s*<\/Box>/gi;
    let boxMatch;
    while ((boxMatch = boxRegex.exec(dumpContent)) !== null) {
      const start = [parseFloat(boxMatch[1]), parseFloat(boxMatch[2]), parseFloat(boxMatch[3])];
      const stop = [parseFloat(boxMatch[4]), parseFloat(boxMatch[5]), parseFloat(boxMatch[6])];

      let normalDir = -1;
      for (let n = 0; n < 3; n++) {
        if (Math.abs(start[n] - stop[n]) < 1e-15) {
          normalDir = n;
          break;
        }
      }
      if (normalDir < 0) continue;

      faces.push({ start, stop, normalDir });
    }
  }

  if (faces.length === 0 || frequency === null) return null;

  // Determine normal signs by pairing faces along each direction.
  // For each direction, the face at the lower coordinate has outward normal -1,
  // and the face at the higher coordinate has outward normal +1.
  for (let d = 0; d < 3; d++) {
    const dirFaces = faces.filter(f => f.normalDir === d);
    if (dirFaces.length === 2) {
      const pos0 = dirFaces[0].start[d];
      const pos1 = dirFaces[1].start[d];
      dirFaces[0].normalSign = pos0 <= pos1 ? -1 : 1;
      dirFaces[1].normalSign = pos1 <= pos0 ? -1 : 1;
    } else {
      for (const f of dirFaces) f.normalSign = f.normalSign || 1;
    }
  }

  return { frequency, faces };
}

/**
 * Parse mesh lines from XML.
 * @param {string} xml - simulation XML
 * @returns {{ meshLines: [Float64Array, Float64Array, Float64Array], deltaUnit: number }|null}
 */
function parseMeshFromXML(xml) {
  const duMatch = xml.match(/DeltaUnit="([^"]+)"/);
  const deltaUnit = duMatch ? parseFloat(duMatch[1]) : 1;

  const dirs = ['X', 'Y', 'Z'];
  const meshLines = [];
  for (const d of dirs) {
    const re = new RegExp(`<${d}Lines>([^<]+)</${d}Lines>`, 'i');
    const m = xml.match(re);
    if (!m) return null;
    const vals = m[1].split(',').map(Number);
    meshLines.push(new Float64Array(vals));
  }
  return { meshLines, deltaUnit };
}

/**
 * Find nearest mesh line index for a physical coordinate.
 * @param {Float64Array} lines - sorted mesh line positions
 * @param {number} coord - physical coordinate (already scaled by deltaUnit)
 * @returns {number} nearest index
 */
function snapToMeshIndex(lines, coord) {
  let bestIdx = 0;
  let bestDist = Math.abs(lines[0] - coord);
  for (let i = 1; i < lines.length; i++) {
    const dist = Math.abs(lines[i] - coord);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Build NF2FF surface indices for GPU accumulation.
 * Enumerates all grid points on each NF2FF face and creates a flat
 * Uint32Array of [ix, iy, iz] triplets.
 *
 * @param {Array} faces - from parseNF2FFConfigFromXML
 * @param {Array} meshLines - [xLines, yLines, zLines]
 * @param {number} deltaUnit
 * @returns {{ surfaceIndices: Uint32Array, numPoints: number,
 *             faceSlices: Array, faceMeshes: Array }}
 */
function buildNF2FFSurfaceIndices(faces, meshLines, deltaUnit) {
  const allPoints = [];
  const faceSlices = [];
  const faceMeshes = [];

  const faceNormals = [
    [-1, 0, 0], [1, 0, 0],
    [0, -1, 0], [0, 1, 0],
    [0, 0, -1], [0, 0, 1],
  ];

  for (const face of faces) {
    const offset = allPoints.length / 3;
    const { start, stop, normalDir } = face;

    // Convert box coords to grid indices (both in same unit system)
    const startIdx = [0, 0, 0];
    const stopIdx = [0, 0, 0];
    for (let n = 0; n < 3; n++) {
      const lo = Math.min(start[n], stop[n]);
      const hi = Math.max(start[n], stop[n]);
      startIdx[n] = snapToMeshIndex(meshLines[n], lo);
      stopIdx[n] = snapToMeshIndex(meshLines[n], hi);
    }

    // Extract face mesh lines (converted to meters for computeNF2FF)
    const faceMeshX = [];
    const faceMeshY = [];
    const faceMeshZ = [];
    for (let i = startIdx[0]; i <= stopIdx[0]; i++) faceMeshX.push(meshLines[0][i] * deltaUnit);
    for (let i = startIdx[1]; i <= stopIdx[1]; i++) faceMeshY.push(meshLines[1][i] * deltaUnit);
    for (let i = startIdx[2]; i <= stopIdx[2]; i++) faceMeshZ.push(meshLines[2][i] * deltaUnit);

    const Nx = stopIdx[0] - startIdx[0] + 1;
    const Ny = stopIdx[1] - startIdx[1] + 1;
    const Nz = stopIdx[2] - startIdx[2] + 1;

    const normalSign = face.normalSign;

    // Enumerate all points on this face
    for (let ix = startIdx[0]; ix <= stopIdx[0]; ix++) {
      for (let iy = startIdx[1]; iy <= stopIdx[1]; iy++) {
        for (let iz = startIdx[2]; iz <= stopIdx[2]; iz++) {
          allPoints.push(ix, iy, iz);
        }
      }
    }

    const count = (allPoints.length / 3) - offset;
    const normal = [0, 0, 0];
    normal[normalDir] = normalSign;

    faceSlices.push({ offset, count, normalDir, normalSign, startIdx, stopIdx, Nx, Ny, Nz });
    faceMeshes.push({
      x: new Float64Array(faceMeshX),
      y: new Float64Array(faceMeshY),
      z: new Float64Array(faceMeshZ),
    });
  }

  return {
    surfaceIndices: new Uint32Array(allPoints),
    numPoints: allPoints.length / 3,
    faceSlices,
    faceMeshes,
  };
}

/**
 * Convert GPU-accumulated NF2FF data to surfaceData format for computeNF2FF.
 * The GPU accumulates raw volt/curr DFT values. We divide by edge lengths
 * to get E/H fields.
 *
 * @param {Float32Array} accumE - GPU E accumulation (numPoints * 6 floats)
 * @param {Float32Array} accumH - GPU H accumulation (numPoints * 6 floats)
 * @param {Array} faceSlices - face slice metadata
 * @param {Array} faceMeshes - face mesh lines
 * @param {Array} meshLines - full grid mesh lines
 * @returns {{ faces: Array }}
 */
function convertGPUAccumToSurfaceData(accumE, accumH, faceSlices, faceMeshes) {
  const faces = [];

  for (let fi = 0; fi < faceSlices.length; fi++) {
    const slice = faceSlices[fi];
    const mesh = faceMeshes[fi];
    const { offset, count, normalDir, normalSign, Nx, Ny, Nz } = slice;

    const cellCount = Nx * Ny * Nz;
    const E = [
      new Float64Array(2 * cellCount),
      new Float64Array(2 * cellCount),
      new Float64Array(2 * cellCount),
    ];
    const H = [
      new Float64Array(2 * cellCount),
      new Float64Array(2 * cellCount),
      new Float64Array(2 * cellCount),
    ];

    // GPU shader already outputs cell-interpolated E/H in physical units (V/m, A/m).
    // Just copy from the flat GPU buffers into per-face per-component arrays.
    for (let p = 0; p < count; p++) {
      const pid = offset + p;
      const localIz = p % Nz;
      const localIy = Math.floor(p / Nz) % Ny;
      const localIx = Math.floor(p / (Ny * Nz));
      const cellIdx = localIx * Ny * Nz + localIy * Nz + localIz;

      for (let comp = 0; comp < 3; comp++) {
        E[comp][2 * cellIdx] = accumE[pid * 6 + comp * 2];
        E[comp][2 * cellIdx + 1] = accumE[pid * 6 + comp * 2 + 1];
        H[comp][2 * cellIdx] = accumH[pid * 6 + comp * 2];
        H[comp][2 * cellIdx + 1] = accumH[pid * 6 + comp * 2 + 1];
      }
    }

    const normal = [0, 0, 0];
    normal[normalDir] = normalSign;
    faces.push({ E, H, mesh, normal });
  }

  return { faces };
}

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
  if (config.murRegions.length > 0) gpuEngine.configureMur(buildMurConfig(config.murRegions, config.gridSize));
  log('WebGPU engine initialized.');
  log(`  Excitation: ${config.excitation?.pos?.length || 0} sources`);

  const probes = parseProbeInfo(ems);
  const dT = ems.getSimDT();
  const { indices, probeSlices } = buildGatherIndices(probes, config.gridSize);
  gpuEngine.configureProbeGather(indices);
  log(`  Probes: ${probes.length} (${indices.length} gather indices)`);

  // Configure GPU-side NF2FF FD accumulation
  let gpuNF2FFConfig = null;
  const nf2ffXMLConfig = parseNF2FFConfigFromXML(xml);
  if (nf2ffXMLConfig) {
    const meshInfo = parseMeshFromXML(xml);
    if (meshInfo) {
      const { meshLines, deltaUnit } = meshInfo;
      const surfInfo = buildNF2FFSurfaceIndices(nf2ffXMLConfig.faces, meshLines, deltaUnit);
      const omega = 2 * Math.PI * nf2ffXMLConfig.frequency;
      // Compute primal and dual edge lengths in meters for GPU cell interpolation
      const primalEdgeLens = [];
      const dualEdgeLens = [];
      for (let n = 0; n < 3; n++) {
        const lines = meshLines[n];
        const N = lines.length;
        const el = new Float32Array(N);
        const del = new Float32Array(N);
        for (let i = 0; i < N - 1; i++) el[i] = (lines[i + 1] - lines[i]) * deltaUnit;
        if (N > 1) el[N - 1] = el[N - 2];
        del[0] = 0.5 * el[0];
        for (let i = 1; i < N - 1; i++) del[i] = 0.5 * (el[i - 1] + el[i]);
        if (N > 1) del[N - 1] = 0.5 * el[N - 2];
        primalEdgeLens.push(el);
        dualEdgeLens.push(del);
      }
      gpuEngine.configureNF2FFAccumulation({
        surfaceIndices: surfInfo.surfaceIndices,
        numPoints: surfInfo.numPoints,
        omega,
        dT,
        gridSize: config.gridSize,
        primalEdgeLens,
        dualEdgeLens,
      });
      gpuNF2FFConfig = {
        frequency: nf2ffXMLConfig.frequency,
        faceSlices: surfInfo.faceSlices,
        faceMeshes: surfInfo.faceMeshes,
        meshLines,
        numPoints: surfInfo.numPoints,
      };
      log(`  NF2FF GPU accumulation: ${surfInfo.numPoints} surface points, f=${(nf2ffXMLConfig.frequency / 1e9).toFixed(3)} GHz`);
    }
  }

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

  // Read back GPU NF2FF accumulation BEFORE destroying GPU engine
  let gpuNF2FFAccum = null;
  if (gpuNF2FFConfig) {
    try {
      gpuNF2FFAccum = await gpuEngine.readNF2FFAccumulation();
      log(`  NF2FF GPU readback: ${gpuNF2FFConfig.numPoints} points, accumE size ${gpuNF2FFAccum.accumE.length}`);
    } catch (e) {
      log(`  NF2FF GPU readback failed: ${e.message}`);
    }
  }

  // Write probe data to WASM FS (only when C++ processing is not active,
  // since C++ probes already write correct data via doProcess)
  if (cppProcessInterval === 0) for (let p = 0; p < probes.length; p++) {
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

  // NF2FF data — prefer GPU-accumulated data, fall back to C++ HDF5
  let nf2ffData = null;
  let nf2ffFreqHz = null;
  let surfaceData = null;

  if (gpuNF2FFAccum && gpuNF2FFConfig) {
    // Use GPU-accumulated DFT data (runs every timestep, no undersampling)
    nf2ffFreqHz = gpuNF2FFConfig.frequency;
    try {
      surfaceData = convertGPUAccumToSurfaceData(
        gpuNF2FFAccum.accumE, gpuNF2FFAccum.accumH,
        gpuNF2FFConfig.faceSlices, gpuNF2FFConfig.faceMeshes,
      );
      log(`  NF2FF using GPU-accumulated data (${surfaceData.faces.length} faces)`);
    } catch (e) {
      log(`  GPU NF2FF conversion failed: ${e.message}`);
    }
  }

  if (!surfaceData) {
    // Fall back to C++ HDF5 FD dump data
    const nf2ffInfo = readNF2FFData(Module, ems, simPath);
    if (nf2ffInfo?.freqHz) {
      nf2ffFreqHz = nf2ffInfo.freqHz;
      try {
        const { readNF2FFSurfaceData } = await import('/src/nf2ff.mjs');
        surfaceData = readNF2FFSurfaceData(ems, simPath, nf2ffInfo.boxName, { frequency: nf2ffInfo.freqHz });
        log(`  NF2FF using C++ HDF5 data (${surfaceData.faces.length} faces)`);
      } catch (e) {
        log(`  C++ NF2FF reading failed: ${e.message}`);
      }
    }
  }

  if (surfaceData && nf2ffFreqHz) {
    try {
      const { computeNF2FF } = await import('/src/nf2ff.mjs');

      // Full 3D grid for radiation pattern
      const thetaRad3d = [], phiRad3d = [];
      for (let t = 0; t <= 180; t += 3) thetaRad3d.push(t * Math.PI / 180);
      for (let p = 0; p <= 360; p += 5) phiRad3d.push(p * Math.PI / 180);
      const result = computeNF2FF(surfaceData, nf2ffFreqHz, thetaRad3d, phiRad3d, [0, 0, 0]);
      const nAngles = thetaRad3d.length * phiRad3d.length;
      const E_norm = new Float64Array(nAngles);
      for (let i = 0; i < nAngles; i++) {
        E_norm[i] = Math.sqrt(
          result.E_theta_re[i] ** 2 + result.E_theta_im[i] ** 2 +
          result.E_phi_re[i] ** 2 + result.E_phi_im[i] ** 2
        );
      }
      const Dmax = result.Dmax;
      const DmaxdBi = 10 * Math.log10(Math.max(Dmax, 1e-15));

      // Extract 2D cuts (phi=0 xz-plane, phi=90 yz-plane) for the 2D plot
      const nTheta3d = thetaRad3d.length;
      const nPhi3d = phiRad3d.length;
      const phi0Idx = 0;
      const phi90Idx = Math.round(90 / 5); // index for phi=90deg
      const thetaDeg2d = [];
      for (let t = -180; t < 180; t += 2) thetaDeg2d.push(t);
      // Map full theta range (-180..180) by mirroring the 0..180 pattern
      const xzPattern = [], yzPattern = [];
      let maxE = 0;
      for (const v of E_norm) if (v > maxE) maxE = v;
      for (const tDeg of thetaDeg2d) {
        const tAbs = Math.abs(tDeg);
        const tIdx = Math.min(Math.round(tAbs / 3), nTheta3d - 1);
        const phiOff = tDeg < 0 ? Math.round(180 / 5) : 0; // opposite hemisphere
        const xzIdx = tIdx * nPhi3d + ((phi0Idx + phiOff) % nPhi3d);
        const yzIdx = tIdx * nPhi3d + ((phi90Idx + phiOff) % nPhi3d);
        xzPattern.push(20 * Math.log10(Math.max(E_norm[xzIdx] / maxE, 1e-15)) + DmaxdBi);
        yzPattern.push(20 * Math.log10(Math.max(E_norm[yzIdx] / maxE, 1e-15)) + DmaxdBi);
      }

      // Build directivity_dBi array for 3D viewer
      const directivity_dBi = new Array(nAngles);
      for (let i = 0; i < nAngles; i++) {
        directivity_dBi[i] = 20 * Math.log10(Math.max(E_norm[i] / maxE, 1e-15)) + DmaxdBi;
      }

      nf2ffData = {
        freqHz: nf2ffFreqHz, Dmax, DmaxdBi,
        // 2D cuts
        thetaDeg: thetaDeg2d, xzPattern, yzPattern,
        // 3D grid
        thetaRad: Array.from(thetaRad3d), phiRad: Array.from(phiRad3d),
        directivity_dBi, nTheta: nTheta3d, nPhi: nPhi3d,
      };
      log(`Far-field computed: Dmax = ${DmaxdBi.toFixed(1)} dBi at ${(nf2ffFreqHz / 1e9).toFixed(3)} GHz`);
    } catch (e) {
      log(`NF2FF computation failed: ${e.message}`);
    }
  }

  ems.delete();

  return { nrTS: totalSteps, elapsed, probeData, nf2ffData, fMax };
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
