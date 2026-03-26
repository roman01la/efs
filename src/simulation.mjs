/**
 * High-level Simulation class for openEMS WASM.
 * Delegates geometry to native CSXCAD (compiled to WASM via Embind).
 * Manages FDTD settings (excitation, BCs, timesteps) and port lifecycle.
 */

import { LumpedPort, MSLPort, WaveguidePort, RectWGPort } from './ports.mjs';
import { createNF2FFBox } from './nf2ff.mjs';
import { smoothMeshLines } from './automesh.mjs';

/**
 * @typedef {import('./types.mjs').Vec3} Vec3
 * @typedef {import('./types.mjs').BoundaryType} BoundaryType
 * @typedef {import('./types.mjs').ExcitationType} ExcitationType
 * @typedef {import('./types.mjs').OpenEMSConfig} OpenEMSConfig
 */

/**
 * Convert a boundary type string to its XML numeric value.
 * @param {BoundaryType} bc
 * @returns {string}
 */
function bcToXML(bc) {
  if (bc === 'PEC') return '0';
  if (bc === 'PMC') return '1';
  if (bc === 'MUR') return '2';
  if (typeof bc === 'string' && bc.startsWith('PML_')) {
    return '3';
  }
  return '0';
}

/**
 * Get PML size from a boundary string like 'PML_8'.
 * @param {BoundaryType} bc
 * @returns {number}
 */
function pmlSize(bc) {
  if (typeof bc === 'string' && bc.startsWith('PML_')) {
    return parseInt(bc.slice(4), 10) || 8;
  }
  return 0;
}

export class Simulation {
  /**
   * @param {Object} Module - WASM module from createOpenEMS()
   * @param {OpenEMSConfig} [config]
   */
  constructor(Module, config = {}) {
    /** @type {Object} */
    this._module = Module;

    /** @type {OpenEMSConfig} */
    this.config = {
      nrTS: 1000000,
      endCriteria: 1e-5,
      coordSystem: 0,
      ...config,
    };

    /** @type {ExcitationType|null} */
    this._excitation = null;

    /** @type {BoundaryType[]} */
    this._boundary = ['PEC', 'PEC', 'PEC', 'PEC', 'PEC', 'PEC'];

    /** @type {import('./ports.mjs').Port[]} */
    this._ports = [];

    // Native CSXCAD geometry container
    this._csx = new Module.ContinuousStructure();
    this._ps = this._csx.GetParameterSet();
  }

  /**
   * Set excitation type and parameters.
   * @param {ExcitationType} excitation
   */
  setExcitation(excitation) {
    this._excitation = excitation;
  }

  /**
   * Set boundary conditions.
   * @param {BoundaryType[]} bc - 6-element array [xmin, xmax, ymin, ymax, zmin, zmax]
   */
  setBoundaryConditions(bc) {
    if (bc.length !== 6) throw new Error('BoundaryConditions must have 6 elements');
    this._boundary = bc;
  }

  /**
   * Set the computational grid.
   * @param {number} unit - length unit (e.g. 1e-3 for mm)
   * @param {number[]} xLines - grid lines in x
   * @param {number[]} yLines - grid lines in y
   * @param {number[]} zLines - grid lines in z
   */
  setGrid(unit, xLines, yLines, zLines) {
    const grid = this._csx.GetGrid();
    grid.clear();
    grid.SetDeltaUnit(unit);
    const sorted = (arr) => [...arr].sort((a, b) => a - b);
    for (const v of sorted(xLines)) grid.AddDiscLine(0, v);
    for (const v of sorted(yLines)) grid.AddDiscLine(1, v);
    for (const v of sorted(zLines)) grid.AddDiscLine(2, v);
  }

  /**
   * Get the grid data (for port access compatibility).
   * @returns {{ unit: number, x: number[], y: number[], z: number[] }}
   */
  get _grid() {
    const grid = this._csx.GetGrid();
    const toArray = (vec) => {
      // Embind VectorDouble has .size()/.get(), convert to native JS array
      if (Array.isArray(vec)) return vec;
      const arr = [];
      for (let i = 0; i < vec.size(); i++) arr.push(vec.get(i));
      return arr;
    };
    return {
      unit: grid.GetDeltaUnit(),
      x: toArray(grid.GetLines(0)),
      y: toArray(grid.GetLines(1)),
      z: toArray(grid.GetLines(2)),
    };
  }

  /**
   * Add a metal property (PEC).
   * @param {string} name
   * @returns {Object} fluent API for adding primitives
   */
  addMetal(name) {
    const prop = this._module.CSPropMetal.create(this._ps);
    prop.SetName(name);
    this._csx.AddProperty(prop);
    return this._makePropAPI(prop);
  }

  /**
   * Add a material property with epsilon/mue/kappa/sigma.
   * @param {string} name
   * @param {Object} [materialProps]
   * @returns {Object} fluent API for adding primitives
   */
  addMaterial(name, materialProps = {}) {
    const prop = this._module.CSPropMaterial.create(this._ps);
    prop.SetName(name);
    if (materialProps.epsilon !== undefined) prop.SetEpsilon(materialProps.epsilon, 0);
    if (materialProps.mue !== undefined) prop.SetMue(materialProps.mue, 0);
    if (materialProps.kappa !== undefined) prop.SetKappa(materialProps.kappa, 0);
    if (materialProps.sigma !== undefined) prop.SetSigma(materialProps.sigma, 0);
    this._csx.AddProperty(prop);
    return this._makePropAPI(prop);
  }

  /**
   * Add a lumped port.
   * @param {Object} params
   * @returns {import('./ports.mjs').LumpedPort}
   */
  addLumpedPort(params) {
    const port = new LumpedPort(params);
    port.addToCSX(this._csx, this._module);
    this._ports.push(port);
    return port;
  }

  /**
   * Add a voltage or current probe.
   * @param {string} name
   * @param {number} type - 0=voltage, 1=current, 2=E-field, 3=H-field
   * @param {Vec3} start
   * @param {Vec3} stop
   * @param {Object} [opts]
   */
  addProbe(name, type, start, stop, opts = {}) {
    const weight = opts.weight !== undefined ? opts.weight : 1;
    const normDir = opts.normDir !== undefined ? opts.normDir : -1;

    const prop = this._module.CSPropProbeBox.create(this._ps);
    prop.SetName(name);
    prop.SetProbeType(type);
    prop.SetWeighting(weight);
    if (normDir >= 0) prop.SetNormalDir(normDir);
    this._csx.AddProperty(prop);

    const box = this._module.CSPrimBox.create(this._ps, prop);
    box.SetStartStop(start[0], start[1], start[2], stop[0], stop[1], stop[2]);
  }

  /**
   * Add a dump box (field recorder).
   * @param {string} name
   * @param {Object} attrs - { DumpType, DumpMode, FileType, ... }
   * @param {Vec3} start
   * @param {Vec3} stop
   */
  addDumpBox(name, attrs, start, stop) {
    const prop = this._module.CSPropDumpBox.create(this._ps);
    prop.SetName(name);
    if (attrs.DumpType !== undefined) prop.SetDumpType(attrs.DumpType);
    if (attrs.DumpMode !== undefined) prop.SetDumpMode(attrs.DumpMode);
    if (attrs.FileType !== undefined) prop.SetFileType(attrs.FileType);
    this._csx.AddProperty(prop);

    const box = this._module.CSPrimBox.create(this._ps, prop);
    box.SetStartStop(start[0], start[1], start[2], stop[0], stop[1], stop[2]);
  }

  /**
   * Add a box primitive to a named property.
   * @param {string} propertyName
   * @param {number} priority
   * @param {Vec3} start
   * @param {Vec3} stop
   */
  addBox(propertyName, priority, start, stop) {
    const prop = this._findProp(propertyName);
    const box = this._module.CSPrimBox.create(this._ps, prop);
    box.SetStartStop(start[0], start[1], start[2], stop[0], stop[1], stop[2]);
    box.SetPriority(priority);
  }

  /**
   * Add a cylinder primitive to a named property.
   * @param {string} propertyName
   * @param {number} priority
   * @param {Vec3} start
   * @param {Vec3} stop
   * @param {number} radius
   */
  addCylinder(propertyName, priority, start, stop, radius) {
    const prop = this._findProp(propertyName);
    const cyl = this._module.CSPrimCylinder.create(this._ps, prop);
    cyl.SetAxis(start[0], start[1], start[2], stop[0], stop[1], stop[2], radius);
    cyl.SetPriority(priority);
  }

  /**
   * Add a cylindrical shell primitive to a named property.
   */
  addCylindricalShell(propertyName, priority, start, stop, radius, shellWidth) {
    const prop = this._findProp(propertyName);
    const cyl = this._module.CSPrimCylindricalShell.create(this._ps, prop);
    cyl.SetAxis(start[0], start[1], start[2], stop[0], stop[1], stop[2], radius);
    cyl.SetShellWidth(shellWidth);
    cyl.SetPriority(priority);
  }

  /**
   * Add a curve (polyline) primitive to a named property.
   */
  addCurve(propertyName, priority, points) {
    const prop = this._findProp(propertyName);
    const curve = this._module.CSPrimCurve.create(this._ps, prop);
    for (const pt of points) curve.AddPoint(pt[0], pt[1], pt[2]);
    curve.SetPriority(priority);
  }

  /**
   * Create a fluent API for adding primitives to a CSXCAD property.
   * @param {Object} prop - native CSProperties
   * @returns {Object}
   */
  _makePropAPI(prop) {
    const M = this._module;
    const ps = this._ps;
    return {
      name: prop.GetName(),
      addBox: (start, stop, priority = 0) => {
        const box = M.CSPrimBox.create(ps, prop);
        box.SetStartStop(start[0], start[1], start[2], stop[0], stop[1], stop[2]);
        box.SetPriority(priority);
        return prop;
      },
      addCylinder: (start, stop, radius, priority = 0) => {
        const cyl = M.CSPrimCylinder.create(ps, prop);
        cyl.SetAxis(start[0], start[1], start[2], stop[0], stop[1], stop[2], radius);
        cyl.SetPriority(priority);
        return prop;
      },
      addCylindricalShell: (start, stop, radius, shellWidth, priority = 0) => {
        const cyl = M.CSPrimCylindricalShell.create(ps, prop);
        cyl.SetAxis(start[0], start[1], start[2], stop[0], stop[1], stop[2], radius);
        cyl.SetShellWidth(shellWidth);
        cyl.SetPriority(priority);
        return prop;
      },
      addCurve: (points, priority = 0) => {
        const curve = M.CSPrimCurve.create(ps, prop);
        for (const pt of points) curve.AddPoint(pt[0], pt[1], pt[2]);
        curve.SetPriority(priority);
        return prop;
      },
      addSphere: (center, radius, priority = 0) => {
        const sph = M.CSPrimSphere.create(ps, prop);
        sph.SetCenter(center[0], center[1], center[2]);
        sph.SetRadius(radius);
        sph.SetPriority(priority);
        return prop;
      },
      addSphericalShell: (center, radius, shellWidth, priority = 0) => {
        const sph = M.CSPrimSphericalShell.create(ps, prop);
        sph.SetCenter(center[0], center[1], center[2]);
        sph.SetRadius(radius);
        sph.SetShellWidth(shellWidth);
        sph.SetPriority(priority);
        return prop;
      },
      addPolygon: (points, normDir, elevation, priority = 0) => {
        const poly = M.CSPrimPolygon.create(ps, prop);
        poly.SetNormDir(normDir);
        poly.SetElevation(elevation);
        for (const pt of points) { poly.AddCoord(pt[0]); poly.AddCoord(pt[1]); }
        poly.SetPriority(priority);
        return prop;
      },
      addLinPoly: (points, normDir, elevation, length, priority = 0) => {
        const poly = M.CSPrimLinPoly.create(ps, prop);
        poly.SetNormDir(normDir);
        poly.SetElevation(elevation);
        poly.SetLength(length);
        for (const pt of points) { poly.AddCoord(pt[0]); poly.AddCoord(pt[1]); }
        poly.SetPriority(priority);
        return prop;
      },
      addRotPoly: (points, normDir, elevation, angle, priority = 0) => {
        const poly = M.CSPrimRotPoly.create(ps, prop);
        poly.SetNormDir(normDir);
        poly.SetElevation(elevation);
        poly.SetAngle(0, 0);
        poly.SetAngle(1, angle);
        for (const pt of points) { poly.AddCoord(pt[0]); poly.AddCoord(pt[1]); }
        poly.SetPriority(priority);
        return prop;
      },
      addWire: (points, radius, priority = 0) => {
        const wire = M.CSPrimWire.create(ps, prop);
        for (const pt of points) wire.AddPoint(pt[0], pt[1], pt[2]);
        wire.SetWireRadius(radius);
        wire.SetPriority(priority);
        return prop;
      },
    };
  }

  /**
   * Find a property by name in the ContinuousStructure.
   * @param {string} name
   * @returns {Object} native CSProperties
   */
  _findProp(name) {
    const n = this._csx.GetQtyProperties();
    for (let i = 0; i < n; i++) {
      const p = this._csx.GetProperty(i);
      if (p.GetName() === name) return p;
    }
    throw new Error(`Property "${name}" not found`);
  }

  /**
   * Generate the openEMS XML string.
   * FDTD settings are generated in JS; geometry comes from native CSXCAD.
   * @returns {string}
   */
  toXML() {
    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<openEMS>');

    // FDTD section
    const fdtdAttrs = [`NumberOfTimesteps="${this.config.nrTS}"`, `endCriteria="${this.config.endCriteria}"`];
    if (this.config.maxTime !== undefined) fdtdAttrs.push(`MaxTime="${this.config.maxTime}"`);
    if (this.config.overSampling !== undefined) fdtdAttrs.push(`OverSampling="${this.config.overSampling}"`);
    if (this.config.timeStepFactor !== undefined) fdtdAttrs.push(`TimeStepFactor="${this.config.timeStepFactor}"`);
    if (this.config.timeStepMethod !== undefined) fdtdAttrs.push(`TimeStepMethod="${this.config.timeStepMethod}"`);

    let fmax = 0;
    if (this._excitation) {
      if (this._excitation.type === 'gauss') fmax = this._excitation.f0 + this._excitation.fc;
      else if (this._excitation.type === 'sinus') fmax = this._excitation.f0;
      else if (this._excitation.type === 'dirac') fmax = this._excitation.fmax;
      else if (this._excitation.type === 'step') fmax = this._excitation.fmax;
      else if (this._excitation.type === 'custom') fmax = this._excitation.fmax;
    }
    if (fmax > 0) fdtdAttrs.push(`f_max="${fmax}"`);

    lines.push(`  <FDTD ${fdtdAttrs.join(' ')}>`);

    // Excitation
    if (this._excitation) {
      const exc = this._excitation;
      if (exc.type === 'gauss') {
        lines.push(`    <Excitation Type="0" f0="${exc.f0}" fc="${exc.fc}"/>`);
      } else if (exc.type === 'sinus') {
        lines.push(`    <Excitation Type="1" f0="${exc.f0}"/>`);
      } else if (exc.type === 'dirac') {
        lines.push(`    <Excitation Type="2" f0="0" fc="${exc.fmax}"/>`);
      } else if (exc.type === 'step') {
        lines.push(`    <Excitation Type="3" f0="0" fc="${exc.fmax}"/>`);
      } else if (exc.type === 'custom') {
        lines.push(`    <Excitation Type="10" f0="${exc.f0}" fc="${exc.fmax}" Function="${exc.func}"/>`);
      }
    }

    // Boundary conditions
    const bc = this._boundary;
    const bcAttrs = [
      `xmin="${bcToXML(bc[0])}"`, `xmax="${bcToXML(bc[1])}"`,
      `ymin="${bcToXML(bc[2])}"`, `ymax="${bcToXML(bc[3])}"`,
      `zmin="${bcToXML(bc[4])}"`, `zmax="${bcToXML(bc[5])}"`,
    ];
    const hasPML = bc.some(b => typeof b === 'string' && b.startsWith('PML_'));
    if (hasPML) {
      const pmlSizes = bc.map(b => pmlSize(b));
      bcAttrs.push(
        `PML_xmin="${pmlSizes[0]}"`, `PML_xmax="${pmlSizes[1]}"`,
        `PML_ymin="${pmlSizes[2]}"`, `PML_ymax="${pmlSizes[3]}"`,
        `PML_zmin="${pmlSizes[4]}"`, `PML_zmax="${pmlSizes[5]}"`
      );
    }
    lines.push(`    <BoundaryCond ${bcAttrs.join(' ')}/>`);
    lines.push(`  </FDTD>`);

    // ContinuousStructure — serialized by native CSXCAD
    const csxXml = this._module.csxToXML(this._csx);
    lines.push(csxXml);

    lines.push('</openEMS>');
    return lines.join('\n');
  }

  /**
   * Run the simulation via WASM.
   *
   * @param {Object} [opts]
   * @param {number} [opts.engineType=0] - 0=basic, 1=sse, 2=sse-compressed, 3=multithreaded
   * @param {string} [opts.simPath='/sim'] - MEMFS simulation directory
   * @returns {Promise<{ module: Object, ems: Object, simPath: string }>}
   */
  async run(opts = {}) {
    const Module = this._module;
    const engineType = opts.engineType || 0;
    const simPath = opts.simPath || '/sim';

    try { Module.FS.mkdir(simPath); } catch (e) { /* may exist */ }
    Module.FS.chdir(simPath);

    const xml = this.toXML();
    const ems = new Module.OpenEMS();
    try {
      ems.configure(engineType, this.config.nrTS, this.config.endCriteria);

      const loadOk = ems.loadXML(xml);
      if (!loadOk) throw new Error('Failed to load simulation XML');

      const rc = ems.setup();
      if (rc !== 0) throw new Error(`SetupFDTD failed with code ${rc}`);

      ems.run();
    } catch (e) {
      ems.delete();
      throw e;
    }

    return { module: Module, ems, simPath };
  }

  /**
   * Add an MSL (microstrip line) port.
   */
  addMSLPort(params) {
    const port = new MSLPort(this, params);
    port.addToCSX(this._csx, this._module);
    this._ports.push(port);
    return port;
  }

  /**
   * Add a waveguide port with explicit mode functions.
   */
  addWaveGuidePort(params) {
    const port = new WaveguidePort(params);
    port.addToCSX(this._csx, this._module);
    this._ports.push(port);
    return port;
  }

  /**
   * Add a rectangular waveguide port (TE modes).
   */
  addRectWaveGuidePort(params) {
    const port = new RectWGPort(params);
    port.addToCSX(this._csx, this._module);
    this._ports.push(port);
    return port;
  }

  /**
   * Create an NF2FF recording box.
   */
  createNF2FFBox(name, start, stop, opts = {}) {
    return createNF2FFBox(this, name, start, stop, opts);
  }

  /**
   * Smooth the grid so no spacing exceeds maxRes on any axis.
   * @param {number|number[]} maxRes
   */
  smoothGrid(maxRes) {
    const grid = this._csx.GetGrid();
    const mx = Array.isArray(maxRes) ? maxRes[0] : maxRes;
    const my = Array.isArray(maxRes) ? maxRes[1] : maxRes;
    const mz = Array.isArray(maxRes) ? maxRes[2] : maxRes;
    const unit = grid.GetDeltaUnit();
    const g = this._grid; // uses getter which converts to JS arrays
    const smoothed = [
      smoothMeshLines(g.x, mx),
      smoothMeshLines(g.y, my),
      smoothMeshLines(g.z, mz),
    ];
    grid.clear();
    grid.SetDeltaUnit(unit);
    for (const v of smoothed[0]) grid.AddDiscLine(0, v);
    for (const v of smoothed[1]) grid.AddDiscLine(1, v);
    for (const v of smoothed[2]) grid.AddDiscLine(2, v);
  }

  /**
   * Get the native ContinuousStructure.
   * @returns {Object}
   */
  get csx() {
    return this._csx;
  }

  /**
   * Get ports.
   * @returns {import('./ports.mjs').Port[]}
   */
  get ports() {
    return this._ports;
  }

  /**
   * Clean up native resources.
   */
  destroy() {
    if (this._csx) {
      this._csx.delete();
      this._csx = null;
    }
  }
}
