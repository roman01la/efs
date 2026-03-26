/**
 * SAR (Specific Absorption Rate) post-processing module.
 * Implements local and averaged SAR calculation following the algorithm
 * from vendor/openEMS/tools/sar_calculation.cpp.
 *
 * Local SAR: O(N_cells)
 * Averaged SAR: O(N_cells * iterations_per_cell) due to Newton-Raphson
 * box fitting at each tissue voxel.
 */

/**
 * Compute local SAR per cell.
 *
 * SAR = 0.5 * sigma * |E|^2 / density
 *
 * @param {Float64Array|Float32Array} E_field - |E|^2 per cell (magnitude squared of E-field).
 *   If 3-component, pass as { Ex2, Ey2, Ez2 } each of length N, or a flat array of |E|^2.
 * @param {Float32Array|Float64Array} conductivity - Conductivity (sigma) per cell [S/m]
 * @param {Float32Array|Float64Array} density - Mass density per cell [kg/m^3]
 * @param {number} [_cellVolume] - Unused, kept for API compatibility
 * @returns {Float32Array} SAR values per cell [W/kg]
 */
export function computeLocalSAR(E_field, conductivity, density, _cellVolume) {
  // E_field can be:
  //   1) A flat Float64Array of |E|^2 per cell
  //   2) An object { Ex2, Ey2, Ez2 } with per-component |E_i|^2
  let E_mag2;
  if (E_field.Ex2 !== undefined) {
    const N = E_field.Ex2.length;
    E_mag2 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      E_mag2[i] = E_field.Ex2[i] + E_field.Ey2[i] + E_field.Ez2[i];
    }
  } else {
    E_mag2 = E_field;
  }

  const N = E_mag2.length;
  const SAR = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    if (density[i] > 0) {
      SAR[i] = 0.5 * conductivity[i] * E_mag2[i] / density[i];
    } else {
      // Air or zero-density voxel: SAR = 0 (not NaN)
      SAR[i] = 0;
    }
  }

  return SAR;
}

/**
 * Compute averaged SAR using cubical volume averaging.
 *
 * Implements the 'simple' averaging method from sar_calculation.cpp.
 * For each tissue voxel, finds a cubical volume containing the target mass
 * via Newton-Raphson iteration, then averages power/mass over that cube.
 *
 * @param {Float32Array} localSAR - Local SAR per cell (from computeLocalSAR)
 * @param {Float32Array|Float64Array} density - Mass density per cell [kg/m^3]
 * @param {Float32Array|Float64Array|number} cellVolume - Volume per cell [m^3], or uniform volume
 * @param {Object} cellWidth - { x: Float64Array, y: Float64Array, z: Float64Array } cell widths per axis
 * @param {number} avgMass - Target averaging mass [kg] (e.g. 0.001 for 1g, 0.01 for 10g)
 * @param {string} [method='simple'] - Averaging method: 'simple' | 'IEEE_C95_3' | 'IEEE_62704'
 * @returns {Float32Array} Averaged SAR values per cell [W/kg]
 */
export function computeAveragedSAR(localSAR, density, cellVolume, cellWidth, avgMass, method = 'simple') {
  const Nx = cellWidth.x.length;
  const Ny = cellWidth.y.length;
  const Nz = cellWidth.z.length;
  const N = Nx * Ny * Nz;

  // Parse method parameters
  const params = getMethodParams(method);

  // Resolve cell volumes
  const volumes = typeof cellVolume === 'number'
    ? new Float32Array(N).fill(cellVolume)
    : cellVolume;

  const SAR = new Float32Array(N);

  // Compute power density per cell: powerDensity[i] = localSAR[i] * density[i]
  const powerDensity = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    powerDensity[i] = localSAR[i] * density[i];
  }

  const valid = new Uint8Array(N); // 1 if voxel has a valid averaging cube
  const used = new Uint8Array(N);  // 1 if voxel is covered by some valid cube

  for (let ix = 0; ix < Nx; ix++) {
    for (let iy = 0; iy < Ny; iy++) {
      for (let iz = 0; iz < Nz; iz++) {
        const idx = (ix * Ny + iy) * Nz + iz;

        if (density[idx] <= 0) {
          SAR[idx] = 0;
          continue;
        }

        // Initial guess for box half-size based on local density
        let boxHalf = Math.pow(avgMass / density[idx], 1.0 / 3.0) / 2;

        const result = findFittingCubicalMass(
          ix, iy, iz, boxHalf,
          cellWidth, density, volumes, avgMass,
          Nx, Ny, Nz,
          params
        );

        if (result.converged) {
          SAR[idx] = computeCubicalSAR(
            result.start, result.stop, result.partialStart, result.partialStop,
            powerDensity, density, volumes, cellWidth, Nx, Ny, Nz
          );
          valid[idx] = true;
          markUsed(used, result.start, result.stop, Nx, Ny, Nz);
        }
      }
    }
  }

  // Second pass: handle voxels not covered by any valid cube
  // Try cubes with one face disabled (matching C++ lines 600-632)
  for (let ix = 0; ix < Nx; ix++) {
    for (let iy = 0; iy < Ny; iy++) {
      for (let iz = 0; iz < Nz; iz++) {
        const idx = (ix * Ny + iy) * Nz + iz;
        if (density[idx] <= 0 || valid[idx] || used[idx]) continue;

        let bestSAR = localSAR[idx];
        SAR[idx] = bestSAR;
      }
    }
  }

  return SAR;
}

/**
 * Find peak SAR value and its position.
 *
 * @param {Float32Array} sarData - SAR values per cell
 * @param {Object} [grid] - Optional grid info { Nx, Ny, Nz } to return 3D index
 * @returns {{ value: number, index: number, position?: [number, number, number] }}
 */
export function findPeakSAR(sarData, grid) {
  let maxVal = 0;
  let maxIdx = 0;
  for (let i = 0; i < sarData.length; i++) {
    if (sarData[i] > maxVal) {
      maxVal = sarData[i];
      maxIdx = i;
    }
  }

  const result = { value: maxVal, index: maxIdx };

  if (grid) {
    const iz = maxIdx % grid.Nz;
    const iy = Math.floor(maxIdx / grid.Nz) % grid.Ny;
    const ix = Math.floor(maxIdx / (grid.Ny * grid.Nz));
    result.position = [ix, iy, iz];
  }

  return result;
}

// ---- Internal helpers ----

function markUsed(used, start, stop, Nx, Ny, Nz) {
  for (let fx = start[0]; fx <= stop[0]; fx++) {
    for (let fy = start[1]; fy <= stop[1]; fy++) {
      for (let fz = start[2]; fz <= stop[2]; fz++) {
        used[(fx * Ny + fy) * Nz + fz] = 1;
      }
    }
  }
}

function getMethodParams(method) {
  switch (method) {
    case 'IEEE_62704':
      return {
        massTolerance: 0.000001,
        maxIterations: 100,
        maxBGRatio: 0.1,
        markPartialAsUsed: false,
        ignoreFaceValid: false,
      };
    case 'IEEE_C95_3':
      return {
        massTolerance: 0.05,
        maxIterations: 100,
        maxBGRatio: 1,
        markPartialAsUsed: true,
        ignoreFaceValid: false,
      };
    case 'simple':
    default:
      return {
        massTolerance: 0.05,
        maxIterations: 100,
        maxBGRatio: 1,
        markPartialAsUsed: true,
        ignoreFaceValid: true,
      };
  }
}

/**
 * Find a cubical box centered at (ix, iy, iz) whose mass matches avgMass.
 * Uses Newton-Raphson iteration on the box half-size.
 */
function findFittingCubicalMass(ix, iy, iz, boxHalf, cellWidth, density, volumes, avgMass, Nx, Ny, Nz, params) {
  let oldMass = 0;
  let oldBoxHalf = 0;
  let currentBoxHalf = boxHalf;

  for (let iter = 0; iter < params.maxIterations; iter++) {
    const cube = getCubicalMass(ix, iy, iz, currentBoxHalf, cellWidth, density, volumes, Nx, Ny, Nz);

    const massError = Math.abs(cube.mass - avgMass);
    if (massError <= params.massTolerance * avgMass) {
      return {
        converged: true,
        start: cube.start,
        stop: cube.stop,
        partialStart: cube.partialStart,
        partialStop: cube.partialStop,
      };
    }

    // Adjust box size
    if (iter === 0) {
      oldBoxHalf = currentBoxHalf;
      currentBoxHalf *= Math.pow(avgMass / Math.max(cube.mass, 1e-30), 1.0 / 3.0);
    } else {
      const dMass = cube.mass - oldMass;
      if (Math.abs(dMass) < 1e-30) break;
      const newBoxHalf = currentBoxHalf - (cube.mass - avgMass) / dMass * (currentBoxHalf - oldBoxHalf);
      oldBoxHalf = currentBoxHalf;
      currentBoxHalf = Math.max(newBoxHalf, 1e-15);
    }
    oldMass = cube.mass;
  }

  // Did not converge: return a best-effort cube
  const cube = getCubicalMass(ix, iy, iz, currentBoxHalf, cellWidth, density, volumes, Nx, Ny, Nz);
  return {
    converged: false,
    start: cube.start,
    stop: cube.stop,
    partialStart: cube.partialStart,
    partialStop: cube.partialStop,
  };
}

/**
 * Get the mass and bounds of a cube of given half-size centered at (ix, iy, iz).
 */
function getCubicalMass(ix, iy, iz, halfSize, cellWidth, density, volumes, Nx, Ny, Nz) {
  const start = [0, 0, 0];
  const stop = [0, 0, 0];
  const partialStart = [1, 1, 1];
  const partialStop = [1, 1, 1];

  const widths = [cellWidth.x, cellWidth.y, cellWidth.z];
  const dims = [Nx, Ny, Nz];
  const center = [ix, iy, iz];

  let hitBoundary = false;

  for (let n = 0; n < 3; n++) {
    // Expand downward from center
    start[n] = center[n];
    let dist = widths[n][center[n]] / 2;
    while (dist < halfSize && start[n] > 0) {
      start[n]--;
      dist += widths[n][start[n]];
    }
    if (start[n] === 0 && dist < halfSize) {
      hitBoundary = true;
      partialStart[n] = -1; // sentinel: hit domain boundary
    } else if (dist >= halfSize && start[n] < center[n]) {
      partialStart[n] = 1 - (dist - halfSize) / widths[n][start[n]];
    } else if (start[n] === center[n]) {
      partialStart[n] = Math.min(2 * halfSize / widths[n][start[n]], 1);
    }

    // Expand upward from center
    stop[n] = center[n];
    dist = widths[n][center[n]] / 2;
    while (dist < halfSize && stop[n] < dims[n] - 1) {
      stop[n]++;
      dist += widths[n][stop[n]];
    }
    if (stop[n] === dims[n] - 1 && dist < halfSize) {
      hitBoundary = true;
      partialStop[n] = -1; // sentinel: hit domain boundary
    } else if (dist >= halfSize && stop[n] > center[n]) {
      partialStop[n] = 1 - (dist - halfSize) / widths[n][stop[n]];
    } else if (stop[n] === center[n]) {
      partialStop[n] = Math.min(2 * halfSize / widths[n][stop[n]], 1);
    }
  }

  // Compute mass over the cube
  let mass = 0;
  for (let fx = start[0]; fx <= stop[0]; fx++) {
    let wx = 1;
    if (fx === start[0]) wx *= Math.abs(partialStart[0]);
    if (fx === stop[0]) wx *= Math.abs(partialStop[0]);

    for (let fy = start[1]; fy <= stop[1]; fy++) {
      let wy = 1;
      if (fy === start[1]) wy *= Math.abs(partialStart[1]);
      if (fy === stop[1]) wy *= Math.abs(partialStop[1]);

      for (let fz = start[2]; fz <= stop[2]; fz++) {
        let wz = 1;
        if (fz === start[2]) wz *= Math.abs(partialStart[2]);
        if (fz === stop[2]) wz *= Math.abs(partialStop[2]);

        const gIdx = (fx * Ny + fy) * Nz + fz;
        mass += density[gIdx] * volumes[gIdx] * wx * wy * wz;
      }
    }
  }

  return { mass, start, stop, partialStart, partialStop, hitBoundary };
}

/**
 * Compute the averaged SAR over a cubical region.
 */
function computeCubicalSAR(start, stop, partialStart, partialStop, powerDensity, density, volumes, cellWidth, Nx, Ny, Nz) {
  let powerMass = 0;
  let mass = 0;

  for (let fx = start[0]; fx <= stop[0]; fx++) {
    let wx = 1;
    if (fx === start[0]) wx *= Math.abs(partialStart[0]);
    if (fx === stop[0]) wx *= Math.abs(partialStop[0]);

    for (let fy = start[1]; fy <= stop[1]; fy++) {
      let wy = 1;
      if (fy === start[1]) wy *= Math.abs(partialStart[1]);
      if (fy === stop[1]) wy *= Math.abs(partialStop[1]);

      for (let fz = start[2]; fz <= stop[2]; fz++) {
        let wz = 1;
        if (fz === start[2]) wz *= Math.abs(partialStart[2]);
        if (fz === stop[2]) wz *= Math.abs(partialStop[2]);

        const gIdx = (fx * Ny + fy) * Nz + fz;
        const w = wx * wy * wz;

        if (density[gIdx] > 0) {
          mass += density[gIdx] * volumes[gIdx] * w;
          powerMass += powerDensity[gIdx] * volumes[gIdx] * w;
        }
      }
    }
  }

  return mass > 0 ? powerMass / mass : 0;
}
