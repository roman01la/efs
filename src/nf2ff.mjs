/**
 * NF2FF (Near-Field to Far-Field) recording box and result classes.
 * Mirrors vendor/openEMS/python/openEMS/nf2ff.py
 *
 * The actual far-field computation requires WASM nf2ff integration (Phase 5).
 * This module provides the data structures and box setup.
 */

/**
 * Create an NF2FF recording box on the simulation.
 * Adds 6 E-field and H-field dump boxes (one per face of the bounding box).
 *
 * @param {import('./simulation.mjs').Simulation} sim
 * @param {string} name
 * @param {import('./types.mjs').Vec3} start
 * @param {import('./types.mjs').Vec3} stop
 * @param {Object} [opts]
 * @param {boolean[]} [opts.directions] - 6-element array enabling each face [xmin,xmax,ymin,ymax,zmin,zmax]
 * @param {number[]} [opts.mirror] - 6-element array: 0=off, 1=PEC, 2=PMC mirror per face
 * @param {number[]} [opts.frequency] - list of frequencies for FD-domain recording
 * @returns {NF2FFBox}
 */
export function createNF2FFBox(sim, name, start, stop, opts = {}) {
  const directions = opts.directions || [true, true, true, true, true, true];
  const mirror = opts.mirror || [0, 0, 0, 0, 0, 0];
  const frequency = opts.frequency || null;

  if (directions.length !== 6) throw new Error('directions must have 6 elements');
  if (mirror.length !== 6) throw new Error('mirror must have 6 elements');

  // Determine dump type: 0 = Et/Ht (time-domain), 10 = Ef/Hf (freq-domain)
  const dumpType = frequency !== null ? 10 : 0;
  const dumpMode = 1; // cell interpolated

  const eFile = `${name}_E`;
  const hFile = `${name}_H`;

  // Add E-field and H-field dump properties
  const eDumpProp = {
    type: 'DumpBox',
    name: eFile,
    attrs: { DumpType: dumpType, DumpMode: dumpMode, FileType: 1 },
    primitives: [],
  };
  const hDumpProp = {
    type: 'DumpBox',
    name: hFile,
    attrs: { DumpType: dumpType + 1, DumpMode: dumpMode, FileType: 1 },
    primitives: [],
  };

  if (frequency !== null) {
    eDumpProp.attrs.Frequency = frequency.join(',');
    hDumpProp.attrs.Frequency = frequency.join(',');
  }

  // Add 6 face boxes (one per direction pair)
  for (let ny = 0; ny < 3; ny++) {
    const pos = 2 * ny;
    // Lower face (start side)
    if (directions[pos]) {
      const lStart = [...start];
      const lStop = [...stop];
      lStop[ny] = lStart[ny];
      eDumpProp.primitives.push({ type: 'Box', start: lStart, stop: lStop, priority: 0 });
      hDumpProp.primitives.push({ type: 'Box', start: lStart, stop: lStop, priority: 0 });
    }
    // Upper face (stop side)
    if (directions[pos + 1]) {
      const lStart = [...start];
      const lStop = [...stop];
      lStart[ny] = lStop[ny];
      eDumpProp.primitives.push({ type: 'Box', start: lStart, stop: lStop, priority: 0 });
      hDumpProp.primitives.push({ type: 'Box', start: lStart, stop: lStop, priority: 0 });
    }
  }

  sim._properties.push(eDumpProp);
  sim._properties.push(hDumpProp);

  return new NF2FFBox(name, start, stop, directions, mirror, frequency);
}

/**
 * NF2FF recording box. Holds metadata and provides calcNF2FF stub.
 */
export class NF2FFBox {
  /**
   * @param {string} name
   * @param {import('./types.mjs').Vec3} start
   * @param {import('./types.mjs').Vec3} stop
   * @param {boolean[]} directions
   * @param {number[]} mirror
   * @param {number[]|null} frequency
   */
  constructor(name, start, stop, directions, mirror, frequency) {
    this.name = name;
    this.start = [...start];
    this.stop = [...stop];
    this.directions = [...directions];
    this.mirror = [...mirror];
    this.frequency = frequency ? [...frequency] : null;
  }

  /**
   * Calculate far-field from near-field data.
   * Stub -- actual implementation requires Phase 5 WASM integration.
   *
   * @param {string} simPath
   * @param {number|number[]} freq
   * @param {number[]} theta - theta angles in degrees
   * @param {number[]} phi - phi angles in degrees
   * @param {Object} [opts]
   * @param {import('./types.mjs').Vec3} [opts.center=[0,0,0]]
   * @param {number} [opts.radius=1]
   * @param {number} [opts.verbose=0]
   * @returns {Promise<NF2FFResult>}
   */
  async calcNF2FF(simPath, freq, theta, phi, opts = {}) {
    throw new Error('NF2FF computation requires Phase 5 WASM integration');
  }
}

/**
 * NF2FF result container.
 * Holds far-field data after computation.
 */
export class NF2FFResult {
  /**
   * @param {Object} data
   * @param {Float64Array} data.theta
   * @param {Float64Array} data.phi
   * @param {number} data.r
   * @param {number[]} data.freq
   * @param {number[]} data.Dmax - directivity per frequency
   * @param {number[]} data.Prad - total radiated power per frequency
   * @param {Array} data.E_theta - E-field theta component per frequency
   * @param {Array} data.E_phi - E-field phi component per frequency
   * @param {Array} data.E_norm - E-field magnitude per frequency
   * @param {Array} data.E_cprh - co-pol RHCP per frequency
   * @param {Array} data.E_cplh - co-pol LHCP per frequency
   * @param {Array} data.P_rad - radiated power density per frequency
   */
  constructor(data) {
    this.theta = data.theta;
    this.phi = data.phi;
    this.r = data.r;
    this.freq = data.freq;
    this.Dmax = data.Dmax;
    this.Prad = data.Prad;
    this.E_theta = data.E_theta;
    this.E_phi = data.E_phi;
    this.E_norm = data.E_norm;
    this.E_cprh = data.E_cprh;
    this.E_cplh = data.E_cplh;
    this.P_rad = data.P_rad;
  }
}
