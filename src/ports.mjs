/**
 * Port classes for openEMS WASM API.
 * Mirrors vendor/openEMS/python/openEMS/ports.py
 */

import { C0, Z0, dftTime2Freq, complexAbs, parseProbe } from './analysis.mjs';

/**
 * Base port class. Holds probe filenames, reads UI data, computes
 * incident/reflected decomposition.
 */
export class Port {
  /**
   * @param {object} params
   * @param {number} params.portNr
   * @param {import('./types.mjs').Vec3} params.start
   * @param {import('./types.mjs').Vec3} params.stop
   * @param {number} [params.excite=0]
   * @param {number} [params.priority=0]
   * @param {string} [params.prefix='']
   */
  constructor({ portNr, start, stop, excite = 0, priority = 0, prefix = '' }) {
    this.number = portNr;
    this.start = [...start];
    this.stop = [...stop];
    this.excite = excite;
    this.priority = priority;
    this.prefix = prefix;
    this.Z_ref = null;

    /** @type {string[]} */
    this.U_filenames = [];
    /** @type {string[]} */
    this.I_filenames = [];

    // Frequency-domain results (set after calcPort)
    this.uf_inc_re = null;
    this.uf_inc_im = null;
    this.uf_ref_re = null;
    this.uf_ref_im = null;
    this.if_inc_re = null;
    this.if_inc_im = null;
    this.if_ref_re = null;
    this.if_ref_im = null;
    this.P_inc = null;
    this.P_ref = null;
    this.P_acc = null;
  }

  /**
   * Generate a label from the template.
   * @param {string} kind - e.g. 'ut', 'it', 'resist', 'excite'
   * @returns {string}
   */
  _label(kind) {
    return `${this.prefix}port_${kind}_${this.number}`;
  }

  /**
   * Read voltage and current probe data, compute DFT at given frequencies.
   *
   * @param {object} wasmEms - WASM OpenEMS instance (for readFile)
   * @param {string} simPath - simulation directory path in MEMFS
   * @param {Float64Array|number[]} freq - target frequencies
   */
  readUIData(wasmEms, simPath, freq) {
    // Read voltage probes
    this._uf_vals = [];
    for (const fn of this.U_filenames) {
      const text = this._readProbeFile(wasmEms, simPath, fn);
      const probe = parseProbe(text);
      const ft = dftTime2Freq(probe.time, probe.values, freq);
      this._uf_vals.push(ft);
    }

    // Sum all voltage probes
    const nf = freq.length;
    this.uf_tot_re = new Float64Array(nf);
    this.uf_tot_im = new Float64Array(nf);
    for (const v of this._uf_vals) {
      for (let i = 0; i < nf; i++) {
        this.uf_tot_re[i] += v.re[i];
        this.uf_tot_im[i] += v.im[i];
      }
    }

    // Read current probes
    this._if_vals = [];
    for (const fn of this.I_filenames) {
      const text = this._readProbeFile(wasmEms, simPath, fn);
      const probe = parseProbe(text);
      const ft = dftTime2Freq(probe.time, probe.values, freq);
      this._if_vals.push(ft);
    }

    // Sum all current probes
    this.if_tot_re = new Float64Array(nf);
    this.if_tot_im = new Float64Array(nf);
    for (const v of this._if_vals) {
      for (let i = 0; i < nf; i++) {
        this.if_tot_re[i] += v.re[i];
        this.if_tot_im[i] += v.im[i];
      }
    }
  }

  /**
   * Read a probe file from WASM MEMFS. Tries common suffixes.
   * @param {object} wasmEms
   * @param {string} simPath
   * @param {string} name
   * @returns {string}
   */
  _readProbeFile(wasmEms, simPath, name) {
    // Try the exact name first, then common openEMS probe suffixes
    const candidates = [
      `${simPath}/${name}`,
      `${simPath}/${name}.csv`,
    ];
    // Also try listing files to find the right one
    let files = [];
    try {
      const vec = wasmEms.listFiles(simPath);
      for (let i = 0; i < vec.size(); i++) files.push(vec.get(i));
    } catch (e) {
      // ignore
    }

    // Find file matching the probe name prefix (openEMS appends no extension or .csv)
    const match = files.find(f => f === name || f.startsWith(name + '.') || f.startsWith(name));
    if (match) {
      const text = wasmEms.readFile(`${simPath}/${match}`);
      if (text.length > 0) return text;
    }

    // Try candidates
    for (const path of candidates) {
      const text = wasmEms.readFile(path);
      if (text.length > 0) return text;
    }

    throw new Error(`Probe file not found: ${name} in ${simPath}`);
  }

  /**
   * Compute port parameters: incident/reflected voltage, current, power.
   * Mirrors Python Port.CalcPort().
   *
   * @param {object} wasmEms
   * @param {string} simPath
   * @param {Float64Array|number[]} freq
   * @param {number} [refImpedance]
   */
  calcPort(wasmEms, simPath, freq, refImpedance) {
    this.readUIData(wasmEms, simPath, freq);

    if (refImpedance !== undefined && refImpedance !== null) {
      this.Z_ref = refImpedance;
    }
    if (this.Z_ref === null) {
      throw new Error('Port Z_ref must be set before calcPort');
    }

    const nf = freq.length;
    const Z = typeof this.Z_ref === 'number' ? this.Z_ref : 0;
    if (Z <= 0) {
      throw new Error(`Port Z_ref must be positive (got ${Z}). Use R > 0 for lumped ports.`);
    }

    // uf_inc = 0.5 * (uf_tot + if_tot * Z_ref)
    this.uf_inc_re = new Float64Array(nf);
    this.uf_inc_im = new Float64Array(nf);
    this.uf_ref_re = new Float64Array(nf);
    this.uf_ref_im = new Float64Array(nf);
    this.if_inc_re = new Float64Array(nf);
    this.if_inc_im = new Float64Array(nf);
    this.if_ref_re = new Float64Array(nf);
    this.if_ref_im = new Float64Array(nf);
    this.P_inc = new Float64Array(nf);
    this.P_ref = new Float64Array(nf);
    this.P_acc = new Float64Array(nf);

    for (let i = 0; i < nf; i++) {
      // incident
      this.uf_inc_re[i] = 0.5 * (this.uf_tot_re[i] + this.if_tot_re[i] * Z);
      this.uf_inc_im[i] = 0.5 * (this.uf_tot_im[i] + this.if_tot_im[i] * Z);
      this.if_inc_re[i] = 0.5 * (this.if_tot_re[i] + this.uf_tot_re[i] / Z);
      this.if_inc_im[i] = 0.5 * (this.if_tot_im[i] + this.uf_tot_im[i] / Z);

      // reflected
      this.uf_ref_re[i] = this.uf_tot_re[i] - this.uf_inc_re[i];
      this.uf_ref_im[i] = this.uf_tot_im[i] - this.uf_inc_im[i];
      this.if_ref_re[i] = this.if_inc_re[i] - this.if_tot_re[i];
      this.if_ref_im[i] = this.if_inc_im[i] - this.if_tot_im[i];

      // power: P = 0.5 * Re(u * conj(i))
      this.P_inc[i] = 0.5 * (this.uf_inc_re[i] * this.if_inc_re[i] + this.uf_inc_im[i] * this.if_inc_im[i]);
      this.P_ref[i] = 0.5 * (this.uf_ref_re[i] * this.if_ref_re[i] + this.uf_ref_im[i] * this.if_ref_im[i]);
      this.P_acc[i] = 0.5 * (this.uf_tot_re[i] * this.if_tot_re[i] + this.uf_tot_im[i] * this.if_tot_im[i]);
    }
  }
}

/**
 * Lumped port: creates a lumped resistor element + voltage/current probes.
 * Mirrors Python LumpedPort.
 */
export class LumpedPort extends Port {
  /**
   * @param {object} params
   * @param {number} params.portNr
   * @param {number} params.R - resistance [Ohm]
   * @param {import('./types.mjs').Vec3} params.start
   * @param {import('./types.mjs').Vec3} params.stop
   * @param {number} params.excDir - excitation direction: 0=x, 1=y, 2=z
   * @param {number} [params.excite=0] - excitation amplitude (0 = passive)
   * @param {number} [params.priority=0]
   * @param {string} [params.prefix='']
   */
  constructor({ portNr, R, start, stop, excDir, excite = 0, priority = 0, prefix = '' }) {
    super({ portNr, start, stop, excite, priority, prefix });
    this.R = R;
    this.excDir = excDir;

    const dir = Math.sign(this.stop[this.excDir] - this.start[this.excDir]);
    this.direction = dir || 1;

    // Probe placement: voltage probe along excitation axis at center of transverse plane
    const uStart = [
      0.5 * (start[0] + stop[0]),
      0.5 * (start[1] + stop[1]),
      0.5 * (start[2] + stop[2]),
    ];
    const uStop = [...uStart];
    uStart[this.excDir] = start[this.excDir];
    uStop[this.excDir] = stop[this.excDir];

    this.U_filenames = [this._label('ut')];
    this._u_probe_start = uStart;
    this._u_probe_stop = uStop;

    // Current probe at midpoint of excitation axis, full transverse extent
    const iStart = [...start];
    const iStop = [...stop];
    const mid = 0.5 * (start[this.excDir] + stop[this.excDir]);
    iStart[this.excDir] = mid;
    iStop[this.excDir] = mid;

    this.I_filenames = [this._label('it')];
    this._i_probe_start = iStart;
    this._i_probe_stop = iStop;
  }

  /**
   * Add this port's geometry (lumped element, excitation, probes) to a native
   * ContinuousStructure via CSXCAD Embind bindings.
   * @param {Object} csx - native ContinuousStructure
   * @param {Object} Module - WASM module
   */
  addToCSX(csx, Module) {
    const ps = csx.GetParameterSet();
    const ny = this.excDir;
    const dir = this.direction;
    const p = this.priority;
    const s = this.start;
    const grid = csx.GetGrid();

    // Add port edges as grid lines for proper snapping
    for (let d = 0; d < 3; d++) {
      grid.AddDiscLine(d, this.start[d]);
      grid.AddDiscLine(d, this.stop[d]);
    }
    const e = this.stop;

    // Lumped element or metal short
    if (this.R > 0) {
      const le = Module.CSPropLumpedElement.create(ps);
      le.SetName(this._label('resist'));
      le.SetResistance(this.R);
      le.SetDirection(ny);
      le.SetCaps(true);
      csx.AddProperty(le);
      const box = Module.CSPrimBox.create(ps, le);
      box.SetStartStop(s[0], s[1], s[2], e[0], e[1], e[2]);
      box.SetPriority(p);
    } else if (this.R === 0) {
      const metal = Module.CSPropMetal.create(ps);
      metal.SetName(this._label('resist'));
      csx.AddProperty(metal);
      const box = Module.CSPrimBox.create(ps, metal);
      box.SetStartStop(s[0], s[1], s[2], e[0], e[1], e[2]);
      box.SetPriority(p);
    }

    // Excitation
    if (this.excite !== 0) {
      const exc = Module.CSPropExcitation.create(ps, 0);
      exc.SetName(this._label('excite'));
      exc.SetExcitType(0);
      for (let c = 0; c < 3; c++) {
        exc.SetExcitation(c === ny ? -1 * dir * this.excite : 0, c);
      }
      csx.AddProperty(exc);
      const box = Module.CSPrimBox.create(ps, exc);
      box.SetStartStop(s[0], s[1], s[2], e[0], e[1], e[2]);
      box.SetPriority(p);
    }

    // Voltage probe
    const us = this._u_probe_start;
    const ue = this._u_probe_stop;
    const vProbe = Module.CSPropProbeBox.create(ps);
    vProbe.SetName(this.U_filenames[0]);
    vProbe.SetProbeType(0);
    vProbe.SetWeighting(-1);
    csx.AddProperty(vProbe);
    const vBox = Module.CSPrimBox.create(ps, vProbe);
    vBox.SetStartStop(us[0], us[1], us[2], ue[0], ue[1], ue[2]);

    // Current probe
    const is_ = this._i_probe_start;
    const ie = this._i_probe_stop;
    const iProbe = Module.CSPropProbeBox.create(ps);
    iProbe.SetName(this.I_filenames[0]);
    iProbe.SetProbeType(1);
    iProbe.SetWeighting(dir);
    iProbe.SetNormalDir(ny);
    csx.AddProperty(iProbe);
    const iBox = Module.CSPrimBox.create(ps, iProbe);
    iBox.SetStartStop(is_[0], is_[1], is_[2], ie[0], ie[1], ie[2]);
  }

  /**
   * @override
   */
  calcPort(wasmEms, simPath, freq, refImpedance) {
    if (refImpedance === undefined || refImpedance === null) {
      this.Z_ref = this.R;
    }
    super.calcPort(wasmEms, simPath, freq, refImpedance);
  }
}

/**
 * Microstrip line port: creates 3 voltage probes (A, B, C) and 2 current probes.
 * Extracts propagation constant beta and characteristic impedance ZL.
 * Mirrors Python MSLPort.
 */
export class MSLPort extends Port {
  /**
   * @param {object} sim - Simulation instance (used to access grid)
   * @param {object} params
   * @param {number} params.portNr
   * @param {string} params.metalProp - name of the metal property for the MSL plane
   * @param {import('./types.mjs').Vec3} params.start
   * @param {import('./types.mjs').Vec3} params.stop
   * @param {number} params.propDir - propagation direction: 0=x, 1=y, 2=z
   * @param {number} params.excDir - excitation direction: 0=x, 1=y, 2=z
   * @param {number} [params.excite=0]
   * @param {number} [params.priority=0]
   * @param {string} [params.prefix='']
   * @param {number} [params.feedShift=0]
   * @param {number} [params.measPlaneShift] - defaults to half the port length
   * @param {number} [params.feedR=Infinity]
   */
  constructor(sim, { portNr, metalProp, start, stop, propDir, excDir, excite = 0, priority = 0, prefix = '', feedShift = 0, measPlaneShift, feedR = Infinity }) {
    super({ portNr, start, stop, excite, priority, prefix });
    this.propDir = propDir;
    this.excDir = excDir;
    this.metalProp = metalProp;
    this.feedShift = feedShift;
    this.feedR = feedR;

    if (this.excDir === this.propDir) {
      throw new Error('Excitation direction must not be equal to propagation direction');
    }

    this.direction = Math.sign(stop[this.propDir] - start[this.propDir]);
    this.upsideDown = Math.sign(stop[this.excDir] - start[this.excDir]);

    // Default measPlaneShift = half port length in propagation direction
    if (measPlaneShift !== undefined) {
      this.measPlaneShift = measPlaneShift;
    } else {
      this.measPlaneShift = 0.5 * Math.abs(start[this.propDir] - stop[this.propDir]);
    }
    this.measPlanePos = start[this.propDir] + this.measPlaneShift * this.direction;

    // Get propagation-direction grid lines from the simulation
    const gridLines = this._getGridLines(sim, this.propDir);

    // Find measurement plane index on the grid
    let measPosIdx = 0;
    if (gridLines && gridLines.length > 5) {
      let minDist = Infinity;
      for (let i = 0; i < gridLines.length; i++) {
        const dist = Math.abs(gridLines[i] - this.measPlanePos);
        if (dist < minDist) { minDist = dist; measPosIdx = i; }
      }
      if (measPosIdx === 0) measPosIdx = 1;
      if (measPosIdx >= gridLines.length - 1) measPosIdx = gridLines.length - 2;

      this.measPlaneShift = Math.abs(start[this.propDir] - gridLines[measPosIdx]);

      let probeIdx = [measPosIdx - 1, measPosIdx, measPosIdx + 1];
      if (this.direction < 0) probeIdx = probeIdx.reverse();

      const uProbePos = probeIdx.map(i => gridLines[i]);
      this.U_delta = [uProbePos[1] - uProbePos[0], uProbePos[2] - uProbePos[1]];

      // Create 3 voltage probes (A, B, C)
      this.U_filenames = [];
      this._u_probes = [];
      const suffixes = ['A', 'B', 'C'];
      for (let n = 0; n < 3; n++) {
        const uStart = [
          0.5 * (start[0] + stop[0]),
          0.5 * (start[1] + stop[1]),
          0.5 * (start[2] + stop[2]),
        ];
        const uStop = [...uStart];
        uStart[this.propDir] = uProbePos[n];
        uStop[this.propDir] = uProbePos[n];
        uStart[this.excDir] = start[this.excDir];
        uStop[this.excDir] = stop[this.excDir];

        const uName = this._label('ut') + suffixes[n];
        this.U_filenames.push(uName);
        this._u_probes.push({ name: uName, start: uStart, stop: uStop });
      }

      // Current probe positions: midpoints between voltage probe positions
      const iProbePos = [
        uProbePos[0] + (uProbePos[1] - uProbePos[0]) / 2,
        uProbePos[1] + (uProbePos[2] - uProbePos[1]) / 2,
      ];
      this.I_delta = [iProbePos[1] - iProbePos[0]];

      // Create 2 current probes (A, B)
      this.I_filenames = [];
      this._i_probes = [];
      for (let n = 0; n < 2; n++) {
        const iStart = [...start];
        const iStop = [...stop];
        iStop[this.excDir] = start[this.excDir]; // current probes on metal plane
        iStart[this.propDir] = iProbePos[n];
        iStop[this.propDir] = iProbePos[n];

        const iName = this._label('it') + suffixes[n];
        this.I_filenames.push(iName);
        this._i_probes.push({ name: iName, start: iStart, stop: iStop });
      }
    } else {
      // Fallback when no grid lines available: create placeholder probes
      this.U_delta = [1, 1];
      this.I_delta = [1];
      this.U_filenames = [this._label('ut') + 'A', this._label('ut') + 'B', this._label('ut') + 'C'];
      this.I_filenames = [this._label('it') + 'A', this._label('it') + 'B'];
      this._u_probes = [];
      this._i_probes = [];
    }

    // Feed excitation position
    if (gridLines && gridLines.length > 0) {
      const feedPos = start[this.propDir] + this.feedShift * this.direction;
      let feedIdx = 0;
      let minDist = Infinity;
      for (let i = 0; i < gridLines.length; i++) {
        const dist = Math.abs(gridLines[i] - feedPos);
        if (dist < minDist) { minDist = dist; feedIdx = i; }
      }
      this._feedPos = gridLines[feedIdx];
    } else {
      this._feedPos = start[this.propDir];
    }

    this.beta = null;
    this.ZL = null;
  }

  /**
   * Get sorted grid lines for a direction from the simulation.
   * @param {object} sim
   * @param {number} dir
   * @returns {number[]|null}
   */
  _getGridLines(sim, dir) {
    if (!sim || !sim._grid) return null;
    const g = sim._grid;
    if (dir === 0) return g.x && g.x.length > 0 ? [...g.x].sort((a, b) => a - b) : null;
    if (dir === 1) return g.y && g.y.length > 0 ? [...g.y].sort((a, b) => a - b) : null;
    if (dir === 2) return g.z && g.z.length > 0 ? [...g.z].sort((a, b) => a - b) : null;
    return null;
  }

  /**
   * Add MSL port geometry to native ContinuousStructure.
   * @param {Object} csx - native ContinuousStructure
   * @param {Object} Module - WASM module
   */
  addToCSX(csx, Module) {
    const ps = csx.GetParameterSet();
    const p = this.priority;
    const grid = csx.GetGrid();

    // Snap feed and probe positions to grid by adding explicit grid lines
    grid.AddDiscLine(this.propDir, this._feedPos);
    for (const probe of this._u_probes) {
      grid.AddDiscLine(this.propDir, probe.start[this.propDir]);
    }
    for (const probe of this._i_probes) {
      grid.AddDiscLine(this.propDir, probe.start[this.propDir]);
    }

    // Metal MSL plane
    const mslStart = [...this.start];
    const mslStop = [...this.stop];
    mslStop[this.excDir] = mslStart[this.excDir];
    const mslMetal = Module.CSPropMetal.create(ps);
    mslMetal.SetName(`${this.metalProp}_msl_${this.number}`);
    csx.AddProperty(mslMetal);
    const mslBox = Module.CSPrimBox.create(ps, mslMetal);
    mslBox.SetStartStop(mslStart[0], mslStart[1], mslStart[2], mslStop[0], mslStop[1], mslStop[2]);
    mslBox.SetPriority(p);

    // Excitation
    if (this.excite !== 0) {
      const excStart = [...this.start];
      const excStop = [...this.stop];
      excStart[this.propDir] = this._feedPos;
      excStop[this.propDir] = this._feedPos;
      const excVec = [0, 0, 0];
      excVec[this.excDir] = -1 * this.upsideDown * this.excite;
      const exc = Module.CSPropExcitation.create(ps, 0);
      exc.SetName(this._label('excite'));
      exc.SetExcitType(0);
      for (let c = 0; c < 3; c++) exc.SetExcitation(excVec[c], c);
      csx.AddProperty(exc);
      const excBox = Module.CSPrimBox.create(ps, exc);
      excBox.SetStartStop(excStart[0], excStart[1], excStart[2], excStop[0], excStop[1], excStop[2]);
      excBox.SetPriority(p);
    }

    // Feed resistance
    if (this.feedR >= 0 && isFinite(this.feedR)) {
      const rStart = [...this.start];
      const rStop = [...this.stop];
      rStop[this.propDir] = rStart[this.propDir];
      if (this.feedR === 0) {
        const rMetal = Module.CSPropMetal.create(ps);
        rMetal.SetName(this._label('resist'));
        csx.AddProperty(rMetal);
        const rBox = Module.CSPrimBox.create(ps, rMetal);
        rBox.SetStartStop(rStart[0], rStart[1], rStart[2], rStop[0], rStop[1], rStop[2]);
        rBox.SetPriority(p);
      } else {
        const le = Module.CSPropLumpedElement.create(ps);
        le.SetName(this._label('resist'));
        le.SetResistance(this.feedR);
        le.SetDirection(this.excDir);
        le.SetCaps(true);
        csx.AddProperty(le);
        const leBox = Module.CSPrimBox.create(ps, le);
        leBox.SetStartStop(rStart[0], rStart[1], rStart[2], rStop[0], rStop[1], rStop[2]);
        leBox.SetPriority(p);
      }
    }

    // Voltage probes (3)
    for (const probe of this._u_probes) {
      const vp = Module.CSPropProbeBox.create(ps);
      vp.SetName(probe.name);
      vp.SetProbeType(0);
      vp.SetWeighting(1);
      csx.AddProperty(vp);
      const vBox = Module.CSPrimBox.create(ps, vp);
      vBox.SetStartStop(probe.start[0], probe.start[1], probe.start[2], probe.stop[0], probe.stop[1], probe.stop[2]);
    }

    // Current probes (2)
    for (const probe of this._i_probes) {
      const ip = Module.CSPropProbeBox.create(ps);
      ip.SetName(probe.name);
      ip.SetProbeType(1);
      ip.SetWeighting(this.direction);
      ip.SetNormalDir(this.propDir);
      csx.AddProperty(ip);
      const iBox = Module.CSPrimBox.create(ps, ip);
      iBox.SetStartStop(probe.start[0], probe.start[1], probe.start[2], probe.stop[0], probe.stop[1], probe.stop[2]);
    }
  }

  /**
   * Generate XML for this MSL port.
   * @returns {string}
   */
  toXML() {
    const parts = [];
    const p = this.priority;

    // Metal MSL plane: box from start to stop with excDir flattened
    const mslStart = [...this.start];
    const mslStop = [...this.stop];
    mslStop[this.excDir] = mslStart[this.excDir];
    parts.push(
      `<Metal ID="0" Name="${this.metalProp}_msl_${this.number}">`,
      `  <Primitives>`,
      `    <Box Priority="${p}">`,
      `      <P1 X="${mslStart[0]}" Y="${mslStart[1]}" Z="${mslStart[2]}"/>`,
      `      <P2 X="${mslStop[0]}" Y="${mslStop[1]}" Z="${mslStop[2]}"/>`,
      `    </Box>`,
      `  </Primitives>`,
      `</Metal>`
    );

    // Excitation
    if (this.excite !== 0) {
      const excStart = [...this.start];
      const excStop = [...this.stop];
      excStart[this.propDir] = this._feedPos;
      excStop[this.propDir] = this._feedPos;
      const excVec = [0, 0, 0];
      excVec[this.excDir] = -1 * this.upsideDown * this.excite;
      parts.push(
        `<Excitation ID="0" Name="${this._label('excite')}" Number="0" Type="0" Excite="${excVec.join(',')}">`,
        `  <Primitives>`,
        `    <Box Priority="${p}">`,
        `      <P1 X="${excStart[0]}" Y="${excStart[1]}" Z="${excStart[2]}"/>`,
        `      <P2 X="${excStop[0]}" Y="${excStop[1]}" Z="${excStop[2]}"/>`,
        `    </Box>`,
        `  </Primitives>`,
        `</Excitation>`
      );
    }

    // Feed resistance
    if (this.feedR >= 0 && isFinite(this.feedR)) {
      const rStart = [...this.start];
      const rStop = [...this.stop];
      rStop[this.propDir] = rStart[this.propDir];
      if (this.feedR === 0) {
        // Metal short at feed
        parts.push(
          `<Metal ID="0" Name="${this._label('resist')}">`,
          `  <Primitives>`,
          `    <Box Priority="${p}">`,
          `      <P1 X="${rStart[0]}" Y="${rStart[1]}" Z="${rStart[2]}"/>`,
          `      <P2 X="${rStop[0]}" Y="${rStop[1]}" Z="${rStop[2]}"/>`,
          `    </Box>`,
          `  </Primitives>`,
          `</Metal>`
        );
      } else {
        parts.push(
          `<LumpedElement ID="0" Name="${this._label('resist')}" Direction="${this.excDir}" R="${this.feedR}" Caps="1">`,
          `  <Primitives>`,
          `    <Box Priority="${p}">`,
          `      <P1 X="${rStart[0]}" Y="${rStart[1]}" Z="${rStart[2]}"/>`,
          `      <P2 X="${rStop[0]}" Y="${rStop[1]}" Z="${rStop[2]}"/>`,
          `    </Box>`,
          `  </Primitives>`,
          `</LumpedElement>`
        );
      }
    }

    // Voltage probes (3)
    for (const probe of this._u_probes) {
      parts.push(
        `<ProbeBox ID="0" Name="${probe.name}" Number="0" Type="0" Weight="1" NormDir="-1">`,
        `  <Primitives>`,
        `    <Box Priority="0">`,
        `      <P1 X="${probe.start[0]}" Y="${probe.start[1]}" Z="${probe.start[2]}"/>`,
        `      <P2 X="${probe.stop[0]}" Y="${probe.stop[1]}" Z="${probe.stop[2]}"/>`,
        `    </Box>`,
        `  </Primitives>`,
        `</ProbeBox>`
      );
    }

    // Current probes (2)
    for (const probe of this._i_probes) {
      parts.push(
        `<ProbeBox ID="0" Name="${probe.name}" Number="0" Type="1" Weight="${this.direction}" NormDir="${this.propDir}">`,
        `  <Primitives>`,
        `    <Box Priority="0">`,
        `      <P1 X="${probe.start[0]}" Y="${probe.start[1]}" Z="${probe.start[2]}"/>`,
        `      <P2 X="${probe.stop[0]}" Y="${probe.stop[1]}" Z="${probe.stop[2]}"/>`,
        `    </Box>`,
        `  </Primitives>`,
        `</ProbeBox>`
      );
    }

    return parts.join('\n');
  }

  /**
   * Read UI data and compute beta and ZL.
   * MSLPort overrides readUIData to extract propagation constant.
   * Mirrors Python MSLPort.ReadUIData.
   */
  readUIData(wasmEms, simPath, freq) {
    // Read all voltage probes
    this._uf_vals = [];
    for (const fn of this.U_filenames) {
      const text = this._readProbeFile(wasmEms, simPath, fn);
      const probe = parseProbe(text);
      const ft = dftTime2Freq(probe.time, probe.values, freq);
      this._uf_vals.push(ft);
    }

    // Read all current probes
    this._if_vals = [];
    for (const fn of this.I_filenames) {
      const text = this._readProbeFile(wasmEms, simPath, fn);
      const probe = parseProbe(text);
      const ft = dftTime2Freq(probe.time, probe.values, freq);
      this._if_vals.push(ft);
    }

    const nf = freq.length;
    const unit = 1; // TODO: get from simulation grid unit

    // uf_tot = voltage at measurement plane (probe B = index 1)
    this.uf_tot_re = new Float64Array(this._uf_vals[1].re);
    this.uf_tot_im = new Float64Array(this._uf_vals[1].im);

    // if_tot = average of two current probes
    this.if_tot_re = new Float64Array(nf);
    this.if_tot_im = new Float64Array(nf);
    for (let i = 0; i < nf; i++) {
      this.if_tot_re[i] = 0.5 * (this._if_vals[0].re[i] + this._if_vals[1].re[i]);
      this.if_tot_im[i] = 0.5 * (this._if_vals[0].im[i] + this._if_vals[1].im[i]);
    }

    // Compute beta and ZL from the 3 voltage probes and 2 current probes
    // Et = uf_vals[1], dEt = (uf_vals[2] - uf_vals[0]) / sum(|U_delta|) / unit
    // Ht = if_tot, dHt = (if_vals[1] - if_vals[0]) / |I_delta[0]| / unit
    const totalUDelta = (Math.abs(this.U_delta[0]) + Math.abs(this.U_delta[1])) * unit;
    const iDelta = Math.abs(this.I_delta[0]) * unit;

    this.beta_re = new Float64Array(nf);
    this.beta_im = new Float64Array(nf);
    this.ZL_re = new Float64Array(nf);
    this.ZL_im = new Float64Array(nf);

    for (let i = 0; i < nf; i++) {
      // Et (complex)
      const etRe = this._uf_vals[1].re[i];
      const etIm = this._uf_vals[1].im[i];

      // dEt = (V_C - V_A) / totalUDelta
      const dEtRe = (this._uf_vals[2].re[i] - this._uf_vals[0].re[i]) / totalUDelta;
      const dEtIm = (this._uf_vals[2].im[i] - this._uf_vals[0].im[i]) / totalUDelta;

      // Ht (complex)
      const htRe = this.if_tot_re[i];
      const htIm = this.if_tot_im[i];

      // dHt = (I_B - I_A) / iDelta
      const dHtRe = (this._if_vals[1].re[i] - this._if_vals[0].re[i]) / iDelta;
      const dHtIm = (this._if_vals[1].im[i] - this._if_vals[0].im[i]) / iDelta;

      // beta = sqrt(-dEt * dHt / (Ht * Et))
      // ZL = sqrt(Et * dEt / (Ht * dHt))
      // These are complex square roots -- store as real parts for now
      // (full complex sqrt would be needed for lossy lines)

      // For now, store magnitude-based approximation
      const dEtMag = Math.sqrt(dEtRe * dEtRe + dEtIm * dEtIm);
      const dHtMag = Math.sqrt(dHtRe * dHtRe + dHtIm * dHtIm);
      const htMag = Math.sqrt(htRe * htRe + htIm * htIm);
      const etMag = Math.sqrt(etRe * etRe + etIm * etIm);

      if (htMag > 0 && etMag > 0) {
        this.beta_re[i] = Math.sqrt(dEtMag * dHtMag / (htMag * etMag));
        this.ZL_re[i] = Math.sqrt(etMag * dEtMag / (htMag * dHtMag));
      }
    }

    this.beta = this.beta_re;
    this.Z_ref = this.ZL_re;
  }
}

/**
 * Coaxial transmission line port: 3 voltage + 2 current probes with
 * propagation-constant extraction, mirroring the Matlab AddCoaxialPort.
 * Uses analytical TEM impedance as reference: Z0 = 60/sqrt(eps_r) * ln(r_o/r_i).
 */
export class CoaxialPort extends Port {
  /**
   * @param {object} sim - Simulation instance (for grid access)
   * @param {object} params
   * @param {number} params.portNr
   * @param {string} params.metalProp - metal property name
   * @param {number[]} params.start
   * @param {number[]} params.stop
   * @param {number} params.propDir - propagation direction: 0=x, 1=y, 2=z
   * @param {number} params.r_i  - inner conductor radius
   * @param {number} params.r_o  - outer conductor inner radius
   * @param {number} params.r_os - outer shield outer radius
   * @param {number} [params.excite=0]
   * @param {number} [params.priority=0]
   * @param {string} [params.prefix='']
   * @param {number} [params.feedShift=0]
   * @param {number} [params.measPlaneShift]
   * @param {number} [params.feedR=Infinity]
   * @param {number} [params.epsR=1] - dielectric relative permittivity
   */
  constructor(sim, { portNr, metalProp, start, stop, propDir, r_i, r_o, r_os, excite = 0, priority = 0, prefix = '', feedShift = 0, measPlaneShift, feedR = Infinity, epsR = 1 }) {
    super({ portNr, start, stop, excite, priority, prefix });
    this.propDir = propDir;
    this.metalProp = metalProp;
    this.r_i = r_i;
    this.r_o = r_o;
    this.r_os = r_os;
    this.feedShift = feedShift;
    this.feedR = feedR;
    this.epsR = epsR;

    const nP = (propDir + 1) % 3;
    const nPP = (propDir + 2) % 3;
    this.nP = nP;
    this.nPP = nPP;

    this.direction = Math.sign(stop[propDir] - start[propDir]);

    // Analytical TEM impedance: Z0 = (Z0_free / 2pi) * (1/sqrt(eps_r)) * ln(r_o/r_i)
    // = 60 / sqrt(eps_r) * ln(r_o / r_i)
    this.Z_ref_analytical = (60 / Math.sqrt(epsR)) * Math.log(r_o / r_i);
    this.Z_ref = this.Z_ref_analytical;

    // Default measPlaneShift = half port length
    if (measPlaneShift !== undefined) {
      this.measPlaneShift = measPlaneShift;
    } else {
      this.measPlaneShift = 0.5 * Math.abs(start[propDir] - stop[propDir]);
    }
    this.measPlanePos = start[propDir] + this.measPlaneShift * this.direction;

    // Get grid lines
    const gridLines = this._getGridLines(sim, propDir);

    if (gridLines && gridLines.length > 5) {
      // Snap to nearest grid line
      let measIdx = 0;
      let minDist = Infinity;
      for (let i = 0; i < gridLines.length; i++) {
        const d = Math.abs(gridLines[i] - this.measPlanePos);
        if (d < minDist) { minDist = d; measIdx = i; }
      }
      if (measIdx < 1) measIdx = 1;
      if (measIdx >= gridLines.length - 1) measIdx = gridLines.length - 2;

      this.measPlaneShift = Math.abs(start[propDir] - gridLines[measIdx]);

      let probeIdx = [measIdx - 1, measIdx, measIdx + 1];
      if (this.direction < 0) probeIdx = probeIdx.reverse();

      const meshlines = probeIdx.map(i => gridLines[i]);
      this.U_delta = [meshlines[1] - meshlines[0], meshlines[2] - meshlines[1]];

      // 3 voltage probes (A, B, C)
      this.U_filenames = [];
      this._u_probes = [];
      const suffixes = ['A', 'B', 'C'];
      for (let n = 0; n < 3; n++) {
        const uStart = [0, 0, 0];
        const uStop = [0, 0, 0];
        uStart[propDir] = meshlines[n];
        uStop[propDir] = meshlines[n];
        uStart[nP] = start[nP] + r_i;
        uStop[nP] = start[nP] + r_o;
        uStart[nPP] = start[nPP];
        uStop[nPP] = start[nPP];

        const uName = this._label('ut') + suffixes[n];
        this.U_filenames.push(uName);
        this._u_probes.push({ name: uName, start: uStart, stop: uStop });
      }

      // 2 current probes (A, B)
      const iProbePos = [
        meshlines[0] + (meshlines[1] - meshlines[0]) / 2,
        meshlines[1] + (meshlines[2] - meshlines[1]) / 2,
      ];
      this.I_delta = [iProbePos[1] - iProbePos[0]];

      this.I_filenames = [];
      this._i_probes = [];
      for (let n = 0; n < 2; n++) {
        const iStart = [0, 0, 0];
        const iStop = [0, 0, 0];
        iStart[propDir] = iProbePos[n];
        iStop[propDir] = iProbePos[n];
        iStart[nP] = start[nP] - r_i - 0.1 * (r_o - r_i);
        iStop[nP] = start[nP] + r_i + 0.1 * (r_o - r_i);
        iStart[nPP] = start[nPP] - r_i - 0.1 * (r_o - r_i);
        iStop[nPP] = start[nPP] + r_i + 0.1 * (r_o - r_i);

        const iName = this._label('it') + suffixes[n];
        this.I_filenames.push(iName);
        this._i_probes.push({ name: iName, start: iStart, stop: iStop });
      }

      this._meshlines = meshlines;
    } else {
      // Fallback
      this.U_delta = [1, 1];
      this.I_delta = [1];
      this.U_filenames = [this._label('ut') + 'A', this._label('ut') + 'B', this._label('ut') + 'C'];
      this.I_filenames = [this._label('it') + 'A', this._label('it') + 'B'];
      this._u_probes = [];
      this._i_probes = [];
      this._meshlines = null;
    }

    // Feed position
    if (gridLines && gridLines.length > 0) {
      const feedPos = start[propDir] + this.feedShift * this.direction;
      let feedIdx = 0;
      let minDist = Infinity;
      for (let i = 0; i < gridLines.length; i++) {
        const d = Math.abs(gridLines[i] - feedPos);
        if (d < minDist) { minDist = d; feedIdx = i; }
      }
      this._feedPos = gridLines[feedIdx];
    } else {
      this._feedPos = start[propDir];
    }

    this.beta = null;
    this.ZL = null;
  }

  /**
   * Get sorted grid lines for a direction from the simulation.
   */
  _getGridLines(sim, dir) {
    if (!sim || !sim._grid) return null;
    const g = sim._grid;
    if (dir === 0) return g.x && g.x.length > 0 ? [...g.x].sort((a, b) => a - b) : null;
    if (dir === 1) return g.y && g.y.length > 0 ? [...g.y].sort((a, b) => a - b) : null;
    if (dir === 2) return g.z && g.z.length > 0 ? [...g.z].sort((a, b) => a - b) : null;
    return null;
  }

  /**
   * Add coaxial port geometry to native ContinuousStructure.
   */
  addToCSX(csx, Module) {
    const ps = csx.GetParameterSet();
    const p = this.priority;
    const grid = csx.GetGrid();
    const propDir = this.propDir;
    const nP = this.nP;
    const nPP = this.nPP;
    const dir = this.direction;

    // Add port bounds as grid lines
    for (let d = 0; d < 3; d++) {
      grid.AddDiscLine(d, this.start[d]);
      grid.AddDiscLine(d, this.stop[d]);
    }

    // Inner conductor (Cylinder)
    const innerMetal = Module.CSPropMetal.create(ps);
    innerMetal.SetName(`${this.metalProp}_coax_inner_${this.number}`);
    csx.AddProperty(innerMetal);
    const innerCyl = Module.CSPrimCylinder.create(ps, innerMetal);
    innerCyl.SetStartStop(this.start[0], this.start[1], this.start[2],
                          this.stop[0], this.stop[1], this.stop[2]);
    innerCyl.SetRadius(this.r_i);
    innerCyl.SetPriority(p);

    // Outer shield (CylindricalShell)
    const outerMetal = Module.CSPropMetal.create(ps);
    outerMetal.SetName(`${this.metalProp}_coax_outer_${this.number}`);
    csx.AddProperty(outerMetal);
    const outerShell = Module.CSPrimCylindricalShell.create(ps, outerMetal);
    outerShell.SetStartStop(this.start[0], this.start[1], this.start[2],
                            this.stop[0], this.stop[1], this.stop[2]);
    outerShell.SetRadius(0.5 * (this.r_o + this.r_os));
    outerShell.SetShellWidth(this.r_os - this.r_o);
    outerShell.SetPriority(p);

    // Excitation with radial TEM weight functions
    if (this.excite !== 0) {
      const eStart = [...this.start];
      const eStop = [...this.start];

      // Find minimum cell size for nonzero excitation thickness
      const numPropLines = grid.GetQtyLines(propDir);
      let minCell = 1;
      if (numPropLines > 1) {
        minCell = Infinity;
        for (let i = 0; i < numPropLines - 1; i++) {
          const d = Math.abs(grid.GetLine(propDir, i + 1) - grid.GetLine(propDir, i));
          if (d > 0 && d < minCell) minCell = d;
        }
      }

      eStart[propDir] = this._feedPos - 0.01 * minCell;
      eStop[propDir] = this._feedPos + 0.01 * minCell;

      const dirNames = ['x', 'y', 'z'];
      const nameX = `(${dirNames[nP]}-${this.start[nP]})`;
      const nameY = `(${dirNames[nPP]}-${this.start[nPP]})`;
      const rExpr = `sqrt(${nameX}*${nameX}+${nameY}*${nameY})`;
      const r2Expr = `(${nameX}*${nameX}+${nameY}*${nameY})`;
      const mask = `(${rExpr}>${this.r_i})*(${rExpr}<${this.r_o})`;

      const funcE = [0, 0, 0];
      funcE[nP] = `${nameX}/${r2Expr}*${mask}`;
      funcE[nPP] = `${nameY}/${r2Expr}*${mask}`;

      const eVec = [0, 0, 0];
      eVec[nP] = 1;
      eVec[nPP] = 1;

      const exc = Module.CSPropExcitation.create(ps, 0);
      exc.SetName(this._label('excite'));
      exc.SetExcitType(0);
      for (let c = 0; c < 3; c++) exc.SetExcitation(eVec[c], c);
      for (let c = 0; c < 3; c++) {
        if (funcE[c] && funcE[c] !== 0 && funcE[c] !== '0') {
          try { exc.SetWeightFunction(String(funcE[c]), c); } catch (e) { /* ignore */ }
        }
      }
      csx.AddProperty(exc);
      const excShell = Module.CSPrimCylindricalShell.create(ps, exc);
      excShell.SetStartStop(eStart[0], eStart[1], eStart[2], eStop[0], eStop[1], eStop[2]);
      excShell.SetRadius(0.5 * (this.r_i + this.r_o));
      excShell.SetShellWidth(this.r_o - this.r_i);
      excShell.SetPriority(0);
    }

    // Feed resistance
    if (this.feedR === 0) {
      const rMetal = Module.CSPropMetal.create(ps);
      rMetal.SetName(this._label('resist'));
      csx.AddProperty(rMetal);
      const rStart = [...this.start];
      const rStop = [...this.stop];
      rStop[propDir] = rStart[propDir];
      const rShell = Module.CSPrimCylindricalShell.create(ps, rMetal);
      rShell.SetStartStop(rStart[0], rStart[1], rStart[2], rStop[0], rStop[1], rStop[2]);
      rShell.SetRadius(0.5 * (this.r_i + this.r_o));
      rShell.SetShellWidth(this.r_o - this.r_i);
      rShell.SetPriority(p);
    }

    // Voltage probes (3)
    for (const probe of this._u_probes) {
      const vp = Module.CSPropProbeBox.create(ps);
      vp.SetName(probe.name);
      vp.SetProbeType(0);
      vp.SetWeighting(1);
      csx.AddProperty(vp);
      const vBox = Module.CSPrimBox.create(ps, vp);
      vBox.SetStartStop(probe.start[0], probe.start[1], probe.start[2],
                        probe.stop[0], probe.stop[1], probe.stop[2]);
    }

    // Current probes (2)
    for (const probe of this._i_probes) {
      const ip = Module.CSPropProbeBox.create(ps);
      ip.SetName(probe.name);
      ip.SetProbeType(1);
      ip.SetWeighting(dir);
      ip.SetNormalDir(propDir);
      csx.AddProperty(ip);
      const iBox = Module.CSPrimBox.create(ps, ip);
      iBox.SetStartStop(probe.start[0], probe.start[1], probe.start[2],
                        probe.stop[0], probe.stop[1], probe.stop[2]);
    }
  }

  /**
   * Read UI data and compute beta and ZL (same approach as MSLPort).
   */
  readUIData(wasmEms, simPath, freq) {
    // Read all voltage probes
    this._uf_vals = [];
    for (const fn of this.U_filenames) {
      const text = this._readProbeFile(wasmEms, simPath, fn);
      const probe = parseProbe(text);
      const ft = dftTime2Freq(probe.time, probe.values, freq);
      this._uf_vals.push(ft);
    }

    // Read all current probes
    this._if_vals = [];
    for (const fn of this.I_filenames) {
      const text = this._readProbeFile(wasmEms, simPath, fn);
      const probe = parseProbe(text);
      const ft = dftTime2Freq(probe.time, probe.values, freq);
      this._if_vals.push(ft);
    }

    const nf = freq.length;

    // uf_tot = voltage at measurement plane (probe B = index 1)
    this.uf_tot_re = new Float64Array(this._uf_vals[1].re);
    this.uf_tot_im = new Float64Array(this._uf_vals[1].im);

    // if_tot = average of two current probes
    this.if_tot_re = new Float64Array(nf);
    this.if_tot_im = new Float64Array(nf);
    for (let i = 0; i < nf; i++) {
      this.if_tot_re[i] = 0.5 * (this._if_vals[0].re[i] + this._if_vals[1].re[i]);
      this.if_tot_im[i] = 0.5 * (this._if_vals[0].im[i] + this._if_vals[1].im[i]);
    }

    // Compute beta and ZL from 3 voltage + 2 current probes
    const totalUDelta = (Math.abs(this.U_delta[0]) + Math.abs(this.U_delta[1]));
    const iDelta = Math.abs(this.I_delta[0]);

    this.beta_re = new Float64Array(nf);
    this.beta_im = new Float64Array(nf);
    this.ZL_re = new Float64Array(nf);
    this.ZL_im = new Float64Array(nf);

    for (let i = 0; i < nf; i++) {
      const etRe = this._uf_vals[1].re[i];
      const etIm = this._uf_vals[1].im[i];
      const dEtRe = (this._uf_vals[2].re[i] - this._uf_vals[0].re[i]) / totalUDelta;
      const dEtIm = (this._uf_vals[2].im[i] - this._uf_vals[0].im[i]) / totalUDelta;
      const htRe = this.if_tot_re[i];
      const htIm = this.if_tot_im[i];
      const dHtRe = (this._if_vals[1].re[i] - this._if_vals[0].re[i]) / iDelta;
      const dHtIm = (this._if_vals[1].im[i] - this._if_vals[0].im[i]) / iDelta;

      const dEtMag = Math.sqrt(dEtRe * dEtRe + dEtIm * dEtIm);
      const dHtMag = Math.sqrt(dHtRe * dHtRe + dHtIm * dHtIm);
      const htMag = Math.sqrt(htRe * htRe + htIm * htIm);
      const etMag = Math.sqrt(etRe * etRe + etIm * etIm);

      if (htMag > 0 && etMag > 0) {
        this.beta_re[i] = Math.sqrt(dEtMag * dHtMag / (htMag * etMag));
        this.ZL_re[i] = Math.sqrt(etMag * dEtMag / (htMag * dHtMag));
      }
    }

    this.beta = this.beta_re;
    // Use analytical impedance as reference (more stable than extracted)
    this.Z_ref = this.Z_ref_analytical;
  }

  /**
   * @override
   */
  calcPort(wasmEms, simPath, freq, refImpedance) {
    if (refImpedance === undefined || refImpedance === null) {
      this.Z_ref = this.Z_ref_analytical;
    }
    super.calcPort(wasmEms, simPath, freq, refImpedance);
  }
}

/**
 * Waveguide port: mode-matched voltage/current probes with weight functions.
 * Mirrors Python WaveguidePort.
 */
export class WaveguidePort extends Port {
  /**
   * @param {object} params
   * @param {number} params.portNr
   * @param {import('./types.mjs').Vec3} params.start
   * @param {import('./types.mjs').Vec3} params.stop
   * @param {number} params.excDir - propagation/excitation direction: 0=x, 1=y, 2=z
   * @param {Array<string|number>} params.E_func - [Ex, Ey, Ez] weight functions for E-field
   * @param {Array<string|number>} params.H_func - [Hx, Hy, Hz] weight functions for H-field
   * @param {number} params.kc - cutoff wavenumber
   * @param {number} [params.excite=0]
   * @param {number} [params.priority=0]
   * @param {string} [params.prefix='']
   * @param {number} [params.refIndex=1]
   */
  constructor({ portNr, start, stop, excDir, E_func, H_func, kc, excite = 0, priority = 0, prefix = '', refIndex = 1 }) {
    super({ portNr, start, stop, excite, priority, prefix });
    this.excDir = excDir;
    this.ny_P = (excDir + 1) % 3;
    this.ny_PP = (excDir + 2) % 3;
    this.direction = Math.sign(stop[excDir] - start[excDir]);
    this.kc = kc;
    this.E_func = E_func;
    this.H_func = H_func;
    this.refIndex = refIndex;

    this.beta = null;
    this.ZL = null;

    // Measurement plane at stop side
    const mStart = [...start];
    const mStop = [...stop];
    mStart[this.excDir] = mStop[this.excDir];
    this.measPlaneShift = Math.abs(stop[this.excDir] - start[this.excDir]);

    this.U_filenames = [this._label('ut')];
    this._u_probe_start = mStart;
    this._u_probe_stop = mStop;

    this.I_filenames = [this._label('it')];
    this._i_probe_start = [...mStart];
    this._i_probe_stop = [...mStop];
  }

  /**
   * Generate XML for this waveguide port.
   * @returns {string}
   */

  /**
   * Add waveguide port geometry to native ContinuousStructure.
   * @param {Object} csx - native ContinuousStructure
   * @param {Object} Module - WASM module
   */
  addToCSX(csx, Module) {
    const ps = csx.GetParameterSet();
    const p = this.priority;
    const grid = csx.GetGrid();

    // Add port edges as grid lines for proper snapping
    for (let d = 0; d < 3; d++) {
      grid.AddDiscLine(d, this.start[d]);
      grid.AddDiscLine(d, this.stop[d]);
    }

    // Excitation with weight functions
    if (this.excite !== 0) {
      const eStart = [...this.start];
      const eStop = [...this.stop];
      eStop[this.excDir] = eStart[this.excDir];
      const eVec = [0, 0, 0];
      eVec[this.ny_P] = 1;
      eVec[this.ny_PP] = 1;
      const exc = Module.CSPropExcitation.create(ps, 0);
      exc.SetName(this._label('excite'));
      exc.SetExcitType(0);
      for (let c = 0; c < 3; c++) exc.SetExcitation(eVec[c], c);
      // Set weight functions for mode-matched excitation
      for (let c = 0; c < 3; c++) {
        if (this.E_func[c] && this.E_func[c] !== 0 && this.E_func[c] !== '0') {
          try { exc.SetWeightFunction(String(this.E_func[c]), c); } catch(e) {}
        }
      }
      csx.AddProperty(exc);
      const excBox = Module.CSPrimBox.create(ps, exc);
      excBox.SetStartStop(eStart[0], eStart[1], eStart[2], eStop[0], eStop[1], eStop[2]);
      excBox.SetPriority(p);
    }

    // Voltage probe (Type=10 = mode-matched E-field)
    const us = this._u_probe_start;
    const ue = this._u_probe_stop;
    const vp = Module.CSPropProbeBox.create(ps);
    vp.SetName(this.U_filenames[0]);
    vp.SetProbeType(10);
    // Mode functions for E-field matching (openEMS reads ModeFunctionX/Y/Z)
    // All three must be set — empty string causes parse error
    const mfNames = ['ModeFunctionX', 'ModeFunctionY', 'ModeFunctionZ'];
    for (let c = 0; c < 3; c++) {
      vp.AddAttribute(mfNames[c], this.E_func[c] ? String(this.E_func[c]) : '0');
    }
    csx.AddProperty(vp);
    const vBox = Module.CSPrimBox.create(ps, vp);
    vBox.SetStartStop(us[0], us[1], us[2], ue[0], ue[1], ue[2]);

    // Current probe (Type=11 = mode-matched H-field)
    const is_ = this._i_probe_start;
    const ie = this._i_probe_stop;
    const ip = Module.CSPropProbeBox.create(ps);
    ip.SetName(this.I_filenames[0]);
    ip.SetProbeType(11);
    ip.SetWeighting(this.direction);
    ip.SetNormalDir(this.excDir);
    // Mode functions for H-field matching (openEMS reads ModeFunctionX/Y/Z)
    for (let c = 0; c < 3; c++) {
      ip.AddAttribute(mfNames[c], this.H_func[c] ? String(this.H_func[c]) : '0');
    }
    csx.AddProperty(ip);
    const iBox = Module.CSPrimBox.create(ps, ip);
    iBox.SetStartStop(is_[0], is_[1], is_[2], ie[0], ie[1], ie[2]);
  }

  toXML() {
    const parts = [];
    const p = this.priority;

    // Excitation with weight functions
    if (this.excite !== 0) {
      const eStart = [...this.start];
      const eStop = [...this.stop];
      eStop[this.excDir] = eStart[this.excDir];
      const eVec = [0, 0, 0];
      eVec[this.ny_P] = 1;
      eVec[this.ny_PP] = 1;
      // Include weight functions as attributes
      const wfAttrs = this.E_func.map((f, i) => `Weight_${i}="${f}"`).join(' ');
      parts.push(
        `<Excitation ID="0" Name="${this._label('excite')}" Number="0" Type="0" Excite="${eVec.join(',')}" ${wfAttrs}>`,
        `  <Primitives>`,
        `    <Box Priority="${p}">`,
        `      <P1 X="${eStart[0]}" Y="${eStart[1]}" Z="${eStart[2]}"/>`,
        `      <P2 X="${eStop[0]}" Y="${eStop[1]}" Z="${eStop[2]}"/>`,
        `    </Box>`,
        `  </Primitives>`,
        `</Excitation>`
      );
    }

    // Voltage probe (Type=10 = mode-matched E-field)
    const us = this._u_probe_start;
    const ue = this._u_probe_stop;
    const uWfAttrs = this.E_func.map((f, i) => `ModeFunction_${i}="${f}"`).join(' ');
    parts.push(
      `<ProbeBox ID="0" Name="${this.U_filenames[0]}" Number="0" Type="10" ${uWfAttrs}>`,
      `  <Primitives>`,
      `    <Box Priority="0">`,
      `      <P1 X="${us[0]}" Y="${us[1]}" Z="${us[2]}"/>`,
      `      <P2 X="${ue[0]}" Y="${ue[1]}" Z="${ue[2]}"/>`,
      `    </Box>`,
      `  </Primitives>`,
      `</ProbeBox>`
    );

    // Current probe (Type=11 = mode-matched H-field)
    const is_ = this._i_probe_start;
    const ie = this._i_probe_stop;
    const iWfAttrs = this.H_func.map((f, i) => `ModeFunction_${i}="${f}"`).join(' ');
    parts.push(
      `<ProbeBox ID="0" Name="${this.I_filenames[0]}" Number="0" Type="11" Weight="${this.direction}" ${iWfAttrs}>`,
      `  <Primitives>`,
      `    <Box Priority="0">`,
      `      <P1 X="${is_[0]}" Y="${is_[1]}" Z="${is_[2]}"/>`,
      `      <P2 X="${ie[0]}" Y="${ie[1]}" Z="${ie[2]}"/>`,
      `    </Box>`,
      `  </Primitives>`,
      `</ProbeBox>`
    );

    return parts.join('\n');
  }

  /**
   * Compute port parameters including waveguide impedance.
   * @override
   */
  calcPort(wasmEms, simPath, freq, refImpedance) {
    const nf = freq.length;

    // beta = sqrt(k^2 - kc^2) where k = 2*pi*f/C0 * refIndex
    this.beta_re = new Float64Array(nf);
    this.ZL_re = new Float64Array(nf);
    for (let i = 0; i < nf; i++) {
      const k = 2 * Math.PI * freq[i] / C0 * this.refIndex;
      const kSq = k * k;
      const kcSq = this.kc * this.kc;
      if (kSq > kcSq) {
        this.beta_re[i] = Math.sqrt(kSq - kcSq);
        this.ZL_re[i] = k * Z0 / this.beta_re[i];
      } else {
        // Below cutoff
        this.beta_re[i] = 0;
        this.ZL_re[i] = Infinity;
      }
    }
    this.beta = this.beta_re;
    this.ZL = this.ZL_re;

    if (refImpedance === undefined || refImpedance === null) {
      // Use frequency-dependent waveguide impedance
      // For base Port.calcPort we need a scalar Z_ref; use median or first value
      this.Z_ref = this.ZL_re[0];
    }

    super.calcPort(wasmEms, simPath, freq, refImpedance);
  }
}

/**
 * Rectangular waveguide port: auto-computes E_func, H_func, kc for TE modes.
 * Mirrors Python RectWGPort.
 */
export class RectWGPort extends WaveguidePort {
  /**
   * @param {object} params
   * @param {number} params.portNr
   * @param {import('./types.mjs').Vec3} params.start
   * @param {import('./types.mjs').Vec3} params.stop
   * @param {number} params.excDir - propagation direction: 0=x, 1=y, 2=z
   * @param {number} params.a - waveguide width [length units]
   * @param {number} params.b - waveguide height [length units]
   * @param {string} params.modeName - e.g. 'TE10', 'TE01', 'TE20'
   * @param {number} [params.excite=0]
   * @param {number} [params.priority=0]
   * @param {string} [params.prefix='']
   * @param {number} [params.unit=1] - grid unit for coordinate scaling
   */
  constructor({ portNr, start, stop, excDir, a, b, modeName, excite = 0, priority = 0, prefix = '', unit = 1 }) {
    if (!modeName || modeName.length !== 4) {
      throw new Error(`Invalid mode definition: ${modeName}`);
    }
    if (!modeName.startsWith('TE')) {
      throw new Error(`Currently only TE modes are supported. Got: ${modeName}`);
    }

    const M = parseInt(modeName[2], 10);
    const N = parseInt(modeName[3], 10);

    // Cutoff wavenumber
    const kc = Math.sqrt((M * Math.PI / a) ** 2 + (N * Math.PI / b) ** 2);

    const ny_P = (excDir + 1) % 3;
    const ny_PP = (excDir + 2) % 3;

    // Build weight function strings (Pozar, Microwave Engineering)
    const xyz = ['x', 'y', 'z'];
    const nameP = `(${xyz[ny_P]}-${start[ny_P]})`;
    const namePP = `(${xyz[ny_PP]}-${start[ny_PP]})`;

    const aScaled = a / unit;
    const bScaled = b / unit;

    const E_func = [0, 0, 0];
    const H_func = [0, 0, 0];

    if (N > 0) {
      E_func[ny_P] = `${N / bScaled}*cos(${M * Math.PI / aScaled}*${nameP})*sin(${N * Math.PI / bScaled}*${namePP})`;
    }
    if (M > 0) {
      E_func[ny_PP] = `${-1 * M / aScaled}*sin(${M * Math.PI / aScaled}*${nameP})*cos(${N * Math.PI / bScaled}*${namePP})`;
    }
    if (M > 0) {
      H_func[ny_P] = `${M / aScaled}*sin(${M * Math.PI / aScaled}*${nameP})*cos(${N * Math.PI / bScaled}*${namePP})`;
    }
    if (N > 0) {
      H_func[ny_PP] = `${N / bScaled}*cos(${M * Math.PI / aScaled}*${nameP})*sin(${N * Math.PI / bScaled}*${namePP})`;
    }

    super({ portNr, start, stop, excDir, E_func, H_func, kc, excite, priority, prefix });

    this.a = a;
    this.b = b;
    this.modeName = modeName;
    this.M = M;
    this.N = N;
  }
}
