/**
 * Automesh utilities for openEMS WASM API.
 * Mirrors vendor/openEMS/python/openEMS/automesh.py
 */

import { C0 } from './analysis.mjs';

/**
 * Generate mesh hints from a box region.
 * Returns a 3-element array [xHints, yHints, zHints] where each element
 * is either null or an array of mesh line positions.
 *
 * @param {import('./types.mjs').Vec3} start
 * @param {import('./types.mjs').Vec3} stop
 * @param {string|number|number[]} dirs - 'x','y','z','xy','xyz','all' or array of dir indices
 * @param {Object} [opts]
 * @param {number} [opts.metalEdgeRes] - 2D flat edge resolution
 * @param {boolean} [opts.upDir=true] - enable upper edge hints
 * @param {boolean} [opts.downDir=true] - enable lower edge hints
 * @returns {Array<number[]|null>} [xHints, yHints, zHints]
 */
export function meshHintFromBox(start, stop, dirs, opts = {}) {
  const metalEdgeRes = opts.metalEdgeRes !== undefined ? opts.metalEdgeRes : null;
  const upDir = opts.upDir !== undefined ? opts.upDir : true;
  const downDir = opts.downDir !== undefined ? opts.downDir : true;

  const dirIndices = parseDirs(dirs);

  let mer = null;
  if (metalEdgeRes !== null) {
    mer = [-1.0 / 3 * metalEdgeRes, 2.0 / 3 * metalEdgeRes];
  }

  const hint = [null, null, null];
  const sMin = [
    Math.min(start[0], stop[0]),
    Math.min(start[1], stop[1]),
    Math.min(start[2], stop[2]),
  ];
  const sMax = [
    Math.max(start[0], stop[0]),
    Math.max(start[1], stop[1]),
    Math.max(start[2], stop[2]),
  ];

  for (const ny of dirIndices) {
    hint[ny] = [];
    if (mer !== null && sMax[ny] - sMin[ny] > metalEdgeRes) {
      if (downDir) {
        hint[ny].push(sMin[ny] - mer[0]);
        hint[ny].push(sMin[ny] - mer[1]);
      }
      if (upDir) {
        hint[ny].push(sMax[ny] + mer[0]);
        hint[ny].push(sMax[ny] + mer[1]);
      }
    } else if (sMax[ny] - sMin[ny] > 0) {
      if (downDir) {
        hint[ny].push(sMin[ny]);
      }
      if (upDir) {
        hint[ny].push(sMax[ny]);
      }
    } else {
      hint[ny].push(sMin[ny]);
    }
  }

  return hint;
}

/**
 * Combine and deduplicate mesh lines from two hint arrays.
 * Each input is a 3-element array [xLines, yLines, zLines].
 *
 * @param {Array<number[]|null>} mesh1
 * @param {Array<number[]|null>} mesh2
 * @param {boolean} [sort=true]
 * @returns {Array<number[]|null>}
 */
export function meshCombine(mesh1, mesh2, sort = true) {
  const mesh = [null, null, null];
  for (let ny = 0; ny < 3; ny++) {
    if (mesh1[ny] === null && mesh2[ny] === null) {
      continue;
    } else if (mesh1[ny] === null) {
      mesh[ny] = [...mesh2[ny]];
    } else if (mesh2[ny] === null) {
      mesh[ny] = [...mesh1[ny]];
    } else {
      mesh[ny] = [...mesh1[ny], ...mesh2[ny]];
    }
    if (sort && mesh[ny] !== null) {
      mesh[ny].sort((a, b) => a - b);
    }
  }
  return mesh;
}

/**
 * Estimate the maximum CFL timestep for numerical stability,
 * assuming propagation in pure vacuum.
 *
 * dt <= unit / (C0 * sqrt(1/dx_min^2 + 1/dy_min^2 + 1/dz_min^2))
 *
 * @param {number[]} xLines - sorted grid lines in x
 * @param {number[]} yLines - sorted grid lines in y
 * @param {number[]} zLines - sorted grid lines in z
 * @param {number} [unit=1] - length unit (e.g. 1e-3 for mm)
 * @returns {number} timestep in seconds
 */
export function meshEstimateCflTimestep(xLines, yLines, zLines, unit = 1) {
  const minDiffSq = (lines) => {
    let minDiff = Infinity;
    for (let i = 1; i < lines.length; i++) {
      const d = lines[i] - lines[i - 1];
      if (d > 0 && d < minDiff) minDiff = d;
    }
    return 1 / (minDiff * minDiff);
  };

  const invSqSum = minDiffSq(xLines) + minDiffSq(yLines) + minDiffSq(zLines);
  return unit / (C0 * Math.sqrt(invSqSum));
}

/**
 * Smooth mesh lines so that no spacing exceeds maxRes.
 * Inserts additional lines where the gap is too large.
 *
 * @param {number[]} lines - sorted mesh lines
 * @param {number} maxRes - maximum allowed spacing
 * @returns {number[]} smoothed sorted mesh lines
 */
export function smoothMeshLines(lines, maxRes) {
  if (lines.length < 2) return [...lines];

  const sorted = [...lines].sort((a, b) => a - b);
  const result = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > maxRes) {
      const nInsert = Math.ceil(gap / maxRes);
      const step = gap / nInsert;
      for (let j = 1; j < nInsert; j++) {
        result.push(sorted[i - 1] + j * step);
      }
    }
    result.push(sorted[i]);
  }

  return result;
}

/**
 * Parse direction specification into array of indices.
 * @param {string|number|number[]} dirs
 * @returns {number[]}
 */
function parseDirs(dirs) {
  if (Array.isArray(dirs)) return dirs;
  if (typeof dirs === 'number') return [dirs];
  if (typeof dirs === 'string') {
    if (dirs === 'all' || dirs === 'xyz') return [0, 1, 2];
    const result = [];
    if (dirs.includes('x')) result.push(0);
    if (dirs.includes('y')) result.push(1);
    if (dirs.includes('z')) result.push(2);
    return result;
  }
  return [];
}
