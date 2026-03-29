/**
 * Simulation engine for Node.js.
 * Ports the orchestration logic from app/sim-worker.js into a reusable async function.
 */

// ---- Embind helpers ----

function _embindVecToF32(vec) {
  const arr = new Float32Array(vec.size());
  for (let i = 0; i < arr.length; i++) arr[i] = vec.get(i);
  vec.delete();
  return arr;
}

function extractGPUConfig(ems, Module) {
  const gridSizeVec = ems.getGridSize();
  const gridSize = [gridSizeVec.get(0), gridSizeVec.get(1), gridSizeVec.get(2)];
  gridSizeVec.delete();
  const coeffInfo = ems.getCoefficientsPtr();
  let vv, vi, ii, iv;
  if (coeffInfo.size() === 8) {
    const vvPtr = coeffInfo.get(0), vvLen = coeffInfo.get(1);
    const viPtr = coeffInfo.get(2), viLen = coeffInfo.get(3);
    const iiPtr = coeffInfo.get(4), iiLen = coeffInfo.get(5);
    const ivPtr = coeffInfo.get(6), ivLen = coeffInfo.get(7);
    vv = new Float32Array(Module.HEAPF32.buffer, vvPtr, vvLen).slice();
    vi = new Float32Array(Module.HEAPF32.buffer, viPtr, viLen).slice();
    ii = new Float32Array(Module.HEAPF32.buffer, iiPtr, iiLen).slice();
    iv = new Float32Array(Module.HEAPF32.buffer, ivPtr, ivLen).slice();
  } else {
    vv = _embindVecToF32(ems.getVV());
    vi = _embindVecToF32(ems.getVI());
    ii = _embindVecToF32(ems.getII());
    iv = _embindVecToF32(ems.getIV());
  }
  coeffInfo.delete();

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

  const pbcAxes = [];
  try {
    const bcVec = ems.getBoundaryConditions();
    if (bcVec && bcVec.size() === 6) {
      for (let a = 0; a < 3; a++) {
        const lo = bcVec.get(a * 2);
        const hi = bcVec.get(a * 2 + 1);
        if (lo === -1 && hi === -1) {
          pbcAxes.push({ axis: a, phase: 0 });
        }
      }
      bcVec.delete();
    }
  } catch (e) {}

  return { gridSize, coefficients: { vv, vi, ii, iv }, excitation, pmlRegions, murRegions, pbcAxes };
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
        const tangDirs = [nP, nPP];
        pos[tangDirs[0]] = i0;
        pos[tangDirs[1]] = i1;
        const flatIdx = pos[0] * Ny * Nz + pos[1] * Nz + pos[2];

        const posShift = [...pos];
        posShift[ny] = r.lineNrShift;
        const flatShift = posShift[0] * Ny * Nz + posShift[1] * Nz + posShift[2];

        allCoeffP.push(r.coeffNyP[idx]);
        allNormalIdx.push(nP * stride + flatIdx);
        allShiftedIdx.push(nP * stride + flatShift);

        allCoeffPP.push(r.coeffNyPP[idx]);
        allNormalIdx.push(nPP * stride + flatIdx);
        allShiftedIdx.push(nPP * stride + flatShift);
      }
    }
  }

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

function parseNF2FFConfigFromXML(xml) {
  const allDumpBoxRegex = /<DumpBox\b([^>]*)>([\s\S]*?)<\/DumpBox>/gi;
  let frequency = null;
  const faces = [];
  let dbMatch;
  while ((dbMatch = allDumpBoxRegex.exec(xml)) !== null) {
    const attrs = dbMatch[1];
    const nameM = attrs.match(/Name="([^"]+)"/);
    const typeM = attrs.match(/DumpType="(\d+)"/);
    if (!nameM || !typeM || !/nf2ff/i.test(nameM[1]) || typeM[1] !== '10') continue;

    const dumpContent = dbMatch[2];

    if (frequency === null) {
      const fdMatch = dumpContent.match(/<FD_Samples[^>]*>([^<]+)<\/FD_Samples>/i);
      if (fdMatch) {
        const f = parseFloat(fdMatch[1]);
        if (!isNaN(f) && f > 0) frequency = f;
      }
    }

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

function buildNF2FFSurfaceIndices(faces, meshLines, deltaUnit) {
  const allPoints = [];
  const faceSlices = [];
  const faceMeshes = [];

  for (const face of faces) {
    const offset = allPoints.length / 3;
    const { start, stop, normalDir } = face;

    const startIdx = [0, 0, 0];
    const stopIdx = [0, 0, 0];
    for (let n = 0; n < 3; n++) {
      const lo = Math.min(start[n], stop[n]);
      const hi = Math.max(start[n], stop[n]);
      startIdx[n] = snapToMeshIndex(meshLines[n], lo);
      stopIdx[n] = snapToMeshIndex(meshLines[n], hi);
    }

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

    for (let ix = startIdx[0]; ix <= stopIdx[0]; ix++) {
      for (let iy = startIdx[1]; iy <= stopIdx[1]; iy++) {
        for (let iz = startIdx[2]; iz <= stopIdx[2]; iz++) {
          allPoints.push(ix, iy, iz);
        }
      }
    }

    const count = (allPoints.length / 3) - offset;
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

function _computeEdgeLengths(lines) {
  const N = lines.length;
  const lengths = new Float64Array(N);
  if (N === 1) {
    lengths[0] = 0;
    return lengths;
  }
  lengths[0] = 0.5 * Math.abs(lines[1] - lines[0]);
  for (let i = 1; i < N - 1; i++) {
    lengths[i] = 0.5 * Math.abs(lines[i + 1] - lines[i - 1]);
  }
  lengths[N - 1] = 0.5 * Math.abs(lines[N - 1] - lines[N - 2]);
  return lengths;
}

function buildNF2FFPointMetadata(faceSlices, faceMeshes) {
  let totalPoints = 0;
  for (const slice of faceSlices) totalPoints += slice.count;

  const meta = new Float32Array(totalPoints * 8);

  for (let fi = 0; fi < faceSlices.length; fi++) {
    const slice = faceSlices[fi];
    const mesh = faceMeshes[fi];
    const { offset, count, normalDir, normalSign, Nx, Ny, Nz } = slice;

    const nP = (normalDir + 1) % 3;
    const nPP = (normalDir + 2) % 3;

    const meshArrays = [mesh.x, mesh.y, mesh.z];
    const meshP = meshArrays[nP];
    const meshPP = meshArrays[nPP];

    const edgeLenP = _computeEdgeLengths(meshP);
    const edgeLenPP = _computeEdgeLengths(meshPP);

    for (let p = 0; p < count; p++) {
      const pid = offset + p;
      const localIz = p % Nz;
      const localIy = Math.floor(p / Nz) % Ny;
      const localIx = Math.floor(p / (Ny * Nz));

      const posX = mesh.x[localIx];
      const posY = mesh.y[localIy];
      const posZ = mesh.z[localIz];

      const localIndices = [localIx, localIy, localIz];
      const local_nP_idx = localIndices[nP];
      const local_nPP_idx = localIndices[nPP];

      const area = edgeLenP[local_nP_idx] * edgeLenPP[local_nPP_idx];

      const base = pid * 8;
      meta[base + 0] = posX;
      meta[base + 1] = posY;
      meta[base + 2] = posZ;
      meta[base + 3] = normalDir;
      meta[base + 4] = normalSign;
      meta[base + 5] = area;
      meta[base + 6] = 0;
      meta[base + 7] = 0;
    }
  }

  return meta;
}

function computeRadPower(accumE, accumH, pointMeta, numPoints) {
  let radPower = 0;
  for (let pid = 0; pid < numPoints; pid++) {
    const normalDir = pointMeta[pid * 8 + 3];
    const normSign = pointMeta[pid * 8 + 4];
    const area = pointMeta[pid * 8 + 5];
    const nP = (normalDir + 1) % 3;
    const nPP = (normalDir + 2) % 3;

    const E_nP_re = accumE[pid * 6 + nP * 2];
    const E_nP_im = accumE[pid * 6 + nP * 2 + 1];
    const H_nPP_re = accumH[pid * 6 + nPP * 2];
    const H_nPP_im = accumH[pid * 6 + nPP * 2 + 1];
    const E_nPP_re = accumE[pid * 6 + nPP * 2];
    const E_nPP_im = accumE[pid * 6 + nPP * 2 + 1];
    const H_nP_re = accumH[pid * 6 + nP * 2];
    const H_nP_im = accumH[pid * 6 + nP * 2 + 1];

    const poynting = (E_nP_re * H_nPP_re + E_nP_im * H_nPP_im)
                   - (E_nPP_re * H_nP_re + E_nPP_im * H_nP_im);
    radPower += 0.5 * area * poynting * normSign;
  }
  return radPower;
}

// ---- Main simulation ----

/**
 * Run an FDTD simulation with WebGPU acceleration.
 *
 * @param {string} xml - Simulation XML string
 * @param {object} opts
 * @param {(msg: string) => void} opts.onLog - Log callback
 * @param {(step: number, maxTS: number) => void} opts.onStatus - Progress callback
 * @param {object} opts.Module - Pre-loaded WASM module
 * @returns {Promise<{ probeData: object, nf2ffData: object|null, elapsed: string, nrTS: number, fMax: number }>}
 */
export async function runSimulation(xml, { onLog, onStatus, Module }) {
  const log = onLog || (() => {});
  const status = onStatus || (() => {});

  const t0 = performance.now();

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
  const config = extractGPUConfig(ems, Module);
  log(`Grid: ${config.gridSize.join('x')}, ${config.pmlRegions.length} PML, ${config.murRegions.length} Mur`);

  const { WebGPUEngine } = await import('../../src/webgpu-engine.mjs');
  const gpuEngine = new WebGPUEngine();
  if (!await gpuEngine.initGPU()) throw new Error('WebGPU not available');

  await gpuEngine.init(config.gridSize, config.coefficients);
  if (config.excitation) gpuEngine.configureExcitation(config.excitation);
  if (config.pmlRegions.length > 0) gpuEngine.configurePML(config.pmlRegions);
  if (config.murRegions.length > 0) gpuEngine.configureMur(buildMurConfig(config.murRegions, config.gridSize));
  if (config.pbcAxes.length > 0) {
    const blochPhases = [0, 0, 0];
    const bcMatch = xml.match(/<BoundaryCond[^>]*>/);
    if (bcMatch) {
      const bcTag = bcMatch[0];
      for (let a = 0; a < 3; a++) {
        const axisName = ['x', 'y', 'z'][a];
        const phaseMatch = bcTag.match(new RegExp(`BlochPhase_${axisName}="([^"]+)"`));
        if (phaseMatch) blochPhases[a] = parseFloat(phaseMatch[1]);
      }
    }
    const pbcConfig = { axes: config.pbcAxes.map(a => ({ axis: a.axis, phase: blochPhases[a.axis] })) };
    gpuEngine.configurePBC(pbcConfig);
    log(`  PBC: ${config.pbcAxes.length} periodic axes` + (blochPhases.some(p => p !== 0) ? ` (Bloch: [${blochPhases.join(', ')}])` : ''));
  }
  log('WebGPU engine initialized.');
  log(`  Excitation: ${config.excitation?.pos?.length || 0} sources`);

  const probes = parseProbeInfo(ems);
  const dT = ems.getSimDT();
  const { indices, probeSlices } = buildGatherIndices(probes, config.gridSize);
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
      const nf2ffMaxTS = ems.getMaxTimesteps();
      const nf2ffWindowType = config.pbcAxes.length > 0 ? 1 : 0;
      gpuEngine.configureNF2FFAccumulation({
        surfaceIndices: surfInfo.surfaceIndices,
        numPoints: surfInfo.numPoints,
        omega,
        dT,
        gridSize: config.gridSize,
        primalEdgeLens,
        dualEdgeLens,
        maxTS: nf2ffMaxTS,
        windowType: nf2ffWindowType,
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

  const hasGeneralDumpBoxes = /<DumpBox\b[^>]*Name="(?!nf2ff)[^"]*"/i.test(xml);
  const hasDumpBoxes = /<DumpBox\b/i.test(xml);
  let cppProcessInterval = 0;
  if (hasGeneralDumpBoxes || (hasDumpBoxes && !gpuNF2FFConfig)) {
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
  const sampleInterval = baseInterval;

  const maxSamples = Math.ceil(maxTS / sampleInterval) + 1;
  gpuEngine.configureProbeGatherBuffered(indices, { maxSamples, sampleInterval });

  let maxEnergy = 0;
  const energyCheckInterval = 100;

  const readbackInterval = cppProcessInterval > 0
    ? Math.min(cppProcessInterval, energyCheckInterval)
    : energyCheckInterval;
  let _voltStage = 0, _currStage = 0;

  while (totalSteps < maxTS) {
    const stepsThisBatch = Math.min(readbackInterval, maxTS - totalSteps);
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

    // Energy end-criteria
    if (totalSteps % energyCheckInterval < stepsThisBatch) {
      const energy = await gpuEngine.computeEnergy();
      if (energy > maxEnergy) maxEnergy = energy;
      if (maxEnergy > 0 && (energy / maxEnergy) <= endCrit) {
        log(`  End criteria met at step ${totalSteps} (energy ratio: ${(energy/maxEnergy).toExponential(2)})`);
        break;
      }
    }

    status(totalSteps, maxTS);
    if (totalSteps % 1000 < stepsThisBatch) log(`  Step ${totalSteps}/${maxTS}`);
  }

  const gatherResult = await gpuEngine.readProbeGatherBuffered();
  if (gatherResult) {
    const { data, numSamples, stride } = gatherResult;
    for (let s = 0; s < numSamples; s++) {
      const gathered = data.subarray(s * stride, (s + 1) * stride);
      const sampleStep = (s + 1) * sampleInterval;
      const integrals = computeProbeIntegrals(gathered, probes, probeSlices);
      for (let p = 0; p < probes.length; p++) {
        const isDual = probes[p].type === 1;
        probeTS[p].time.push((sampleStep + (isDual ? 0.5 : 0)) * dT);
        probeTS[p].values.push(integrals[p]);
      }
    }
  }

  if (cppProcessInterval > 0) ems.finalizeRun();

  // Read back GPU NF2FF accumulation BEFORE destroying GPU engine
  let gpuNF2FFAccum = null;
  if (gpuNF2FFConfig) {
    try {
      gpuNF2FFAccum = await gpuEngine.readNF2FFAccumulation();
    } catch (e) {
      log(`  NF2FF GPU readback failed: ${e.message}`);
    }
  }

  // Write probe data to WASM FS
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

  // NF2FF far-field computation
  let nf2ffData = null;

  if (gpuNF2FFAccum && gpuNF2FFConfig) {
    const nf2ffFreqHz = gpuNF2FFConfig.frequency;
    try {
      const pointMeta = buildNF2FFPointMetadata(gpuNF2FFConfig.faceSlices, gpuNF2FFConfig.faceMeshes);

      const thetaRad3d = [];
      const phiRad3d = [];
      for (let t = 0; t <= 180; t += 3) thetaRad3d.push(t * Math.PI / 180);
      for (let p = 0; p <= 360; p += 5) phiRad3d.push(p * Math.PI / 180);

      const gpuFarFieldResult = await gpuEngine.computeNF2FFfarField({
        pointMeta,
        theta: new Float32Array(thetaRad3d),
        phi: new Float32Array(phiRad3d),
        center: [0, 0, 0],
        frequency: nf2ffFreqHz,
        radius: 1,
        numPoints: gpuNF2FFConfig.numPoints,
      });

      gpuEngine.destroy();

      const nTheta3d = thetaRad3d.length;
      const nPhi3d = phiRad3d.length;
      const nAngles = nTheta3d * nPhi3d;
      const E_norm = new Float64Array(nAngles);
      let P_max = 0;

      for (let i = 0; i < nAngles; i++) {
        const base = i * 5;
        const P_rad_i = gpuFarFieldResult[base + 0];
        const Et_re = gpuFarFieldResult[base + 1];
        const Et_im = gpuFarFieldResult[base + 2];
        const Ep_re = gpuFarFieldResult[base + 3];
        const Ep_im = gpuFarFieldResult[base + 4];
        E_norm[i] = Math.sqrt(Et_re * Et_re + Et_im * Et_im + Ep_re * Ep_re + Ep_im * Ep_im);
        if (P_rad_i > P_max) P_max = P_rad_i;
      }

      const radPower = computeRadPower(gpuNF2FFAccum.accumE, gpuNF2FFAccum.accumH, pointMeta, gpuNF2FFConfig.numPoints);

      const Dmax = radPower > 0 ? P_max * 4 * Math.PI * 1 * 1 / radPower : 0;
      const DmaxdBi = 10 * Math.log10(Math.max(Dmax, 1e-15));

      const phi0Idx = 0;
      const phi90Idx = Math.round(90 / 5);
      const thetaDeg2d = [];
      for (let t = -180; t < 180; t += 2) thetaDeg2d.push(t);
      const xzPattern = [], yzPattern = [];
      let maxE = 0;
      for (const v of E_norm) if (v > maxE) maxE = v;
      for (const tDeg of thetaDeg2d) {
        const tAbs = Math.abs(tDeg);
        const tFrac = tAbs / 3;
        const tIdx0 = Math.min(Math.floor(tFrac), nTheta3d - 1);
        const tIdx1 = Math.min(tIdx0 + 1, nTheta3d - 1);
        const frac = tFrac - tIdx0;
        const phiOff = tDeg < 0 ? Math.round(180 / 5) : 0;
        const xzP0 = phi0Idx + phiOff;
        const yzP0 = phi90Idx + phiOff;
        const xzE = E_norm[tIdx0 * nPhi3d + (xzP0 % nPhi3d)] * (1 - frac) + E_norm[tIdx1 * nPhi3d + (xzP0 % nPhi3d)] * frac;
        const yzE = E_norm[tIdx0 * nPhi3d + (yzP0 % nPhi3d)] * (1 - frac) + E_norm[tIdx1 * nPhi3d + (yzP0 % nPhi3d)] * frac;
        xzPattern.push(20 * Math.log10(Math.max(xzE / maxE, 1e-15)) + DmaxdBi);
        yzPattern.push(20 * Math.log10(Math.max(yzE / maxE, 1e-15)) + DmaxdBi);
      }

      // Build directivity_dBi array for 3D viewer
      const directivity_dBi = new Array(nAngles);
      for (let i = 0; i < nAngles; i++) {
        directivity_dBi[i] = 20 * Math.log10(Math.max(E_norm[i] / maxE, 1e-15)) + DmaxdBi;
      }

      nf2ffData = {
        freqHz: nf2ffFreqHz, Dmax, DmaxdBi,
        thetaDeg: thetaDeg2d, xzPattern, yzPattern,
        thetaRad: Array.from(thetaRad3d), phiRad: Array.from(phiRad3d),
        directivity_dBi, nTheta: nTheta3d, nPhi: nPhi3d,
      };
      log(`Far-field computed: Dmax = ${DmaxdBi.toFixed(1)} dBi at ${(nf2ffFreqHz / 1e9).toFixed(3)} GHz`);
    } catch (e) {
      log(`NF2FF computation failed: ${e.message}`);
      gpuEngine.destroy();
    }
  } else {
    gpuEngine.destroy();
  }

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

  ems.delete();

  return { nrTS: totalSteps, elapsed, probeData, nf2ffData, fMax };
}
