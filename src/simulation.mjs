/**
 * High-level Simulation class for openEMS WASM.
 * Mirrors the Python openEMS API: builds XML, loads into WASM, runs FDTD.
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

/**
 * Internal property representation for XML generation.
 * @typedef {Object} CSProperty
 * @property {string} type - 'Metal', 'Material', 'LumpedElement', etc.
 * @property {string} name
 * @property {Object} attrs - additional XML attributes
 * @property {Array} primitives - list of { type, attrs, ... }
 */

export class Simulation {
  /**
   * @param {OpenEMSConfig} [config]
   */
  constructor(config = {}) {
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

    /** @type {CSProperty[]} */
    this._properties = [];

    /** @type {import('./ports.mjs').LumpedPort[]} */
    this._ports = [];

    /** @type {{ unit: number, x: number[], y: number[], z: number[] }} */
    this._grid = { unit: 1, x: [], y: [], z: [] };
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
    this._grid = {
      unit,
      x: [...xLines].sort((a, b) => a - b),
      y: [...yLines].sort((a, b) => a - b),
      z: [...zLines].sort((a, b) => a - b),
    };
  }

  /**
   * Add a metal property (PEC).
   * @param {string} name
   * @returns {{ name: string, addBox: Function, addCylinder: Function }}
   */
  addMetal(name) {
    const prop = { type: 'Metal', name, attrs: {}, primitives: [] };
    this._properties.push(prop);
    return this._makePropAPI(prop);
  }

  /**
   * Add a material property with epsilon/mue/kappa/sigma.
   * @param {string} name
   * @param {Object} [materialProps]
   * @param {number} [materialProps.epsilon]
   * @param {number} [materialProps.mue]
   * @param {number} [materialProps.kappa]
   * @param {number} [materialProps.sigma]
   * @returns {{ name: string, addBox: Function, addCylinder: Function }}
   */
  addMaterial(name, materialProps = {}) {
    const attrs = {};
    if (materialProps.epsilon !== undefined) attrs.Epsilon = materialProps.epsilon;
    if (materialProps.mue !== undefined) attrs.Mue = materialProps.mue;
    if (materialProps.kappa !== undefined) attrs.Kappa = materialProps.kappa;
    if (materialProps.sigma !== undefined) attrs.Sigma = materialProps.sigma;
    const prop = { type: 'Material', name, attrs, primitives: [] };
    this._properties.push(prop);
    return this._makePropAPI(prop);
  }

  /**
   * Add a lumped port.
   * @param {Object} params
   * @param {number} params.portNr
   * @param {number} params.R
   * @param {Vec3} params.start
   * @param {Vec3} params.stop
   * @param {number} params.excDir - 0=x, 1=y, 2=z
   * @param {number} [params.excite=0]
   * @param {number} [params.priority=0]
   * @returns {import('./ports.mjs').LumpedPort}
   */
  addLumpedPort(params) {
    const port = new LumpedPort(params);
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
   * @param {number} [opts.weight=1]
   * @param {number} [opts.normDir=-1]
   */
  addProbe(name, type, start, stop, opts = {}) {
    const weight = opts.weight !== undefined ? opts.weight : 1;
    const normDir = opts.normDir !== undefined ? opts.normDir : -1;
    const prop = {
      type: 'ProbeBox',
      name,
      attrs: { Type: type, Weight: weight, NormDir: normDir },
      primitives: [{ type: 'Box', start: [...start], stop: [...stop], priority: 0 }],
    };
    this._properties.push(prop);
  }

  /**
   * Add a box primitive to a property.
   * @param {string} propertyName
   * @param {number} priority
   * @param {Vec3} start
   * @param {Vec3} stop
   */
  addBox(propertyName, priority, start, stop) {
    const prop = this._properties.find(p => p.name === propertyName);
    if (!prop) throw new Error(`Property "${propertyName}" not found`);
    prop.primitives.push({ type: 'Box', start: [...start], stop: [...stop], priority });
  }

  /**
   * Add a cylinder primitive to a property.
   * @param {string} propertyName
   * @param {number} priority
   * @param {Vec3} start
   * @param {Vec3} stop
   * @param {number} radius
   */
  addCylinder(propertyName, priority, start, stop, radius) {
    const prop = this._properties.find(p => p.name === propertyName);
    if (!prop) throw new Error(`Property "${propertyName}" not found`);
    prop.primitives.push({ type: 'Cylinder', start: [...start], stop: [...stop], radius, priority });
  }

  /**
   * Create a fluent API for adding primitives to a property.
   * @param {CSProperty} prop
   * @returns {Object}
   */
  _makePropAPI(prop) {
    return {
      name: prop.name,
      addBox: (start, stop, priority = 0) => {
        prop.primitives.push({ type: 'Box', start: [...start], stop: [...stop], priority });
        return prop;
      },
      addCylinder: (start, stop, radius, priority = 0) => {
        prop.primitives.push({ type: 'Cylinder', start: [...start], stop: [...stop], radius, priority });
        return prop;
      },
      addCylindricalShell: (start, stop, radius, shellWidth, priority = 0) => {
        prop.primitives.push({ type: 'CylindricalShell', start: [...start], stop: [...stop], radius, shellWidth, priority });
        return prop;
      },
      addCurve: (points, priority = 0) => {
        prop.primitives.push({ type: 'Curve', points: points.map(p => [...p]), priority });
        return prop;
      },
      addSphere: (center, radius, priority = 0) => {
        prop.primitives.push({ type: 'Sphere', center: [...center], radius, priority });
        return prop;
      },
      addSphericalShell: (center, radius, shellWidth, priority = 0) => {
        prop.primitives.push({ type: 'SphericalShell', center: [...center], radius, shellWidth, priority });
        return prop;
      },
      addPolygon: (points, normDir, elevation, priority = 0) => {
        prop.primitives.push({ type: 'Polygon', points: points.map(p => [...p]), normDir, elevation, priority });
        return prop;
      },
      addLinPoly: (points, normDir, elevation, length, priority = 0) => {
        prop.primitives.push({ type: 'LinPoly', points: points.map(p => [...p]), normDir, elevation, length, priority });
        return prop;
      },
      addRotPoly: (points, normDir, elevation, angle, priority = 0) => {
        prop.primitives.push({ type: 'RotPoly', points: points.map(p => [...p]), normDir, elevation, angle, priority });
        return prop;
      },
      addWire: (points, radius, priority = 0) => {
        prop.primitives.push({ type: 'Wire', points: points.map(p => [...p]), radius, priority });
        return prop;
      },
    };
  }

  /**
   * Generate the openEMS XML string.
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

    // f_max from excitation
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

    // Check if any PML boundaries need size
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

    // ContinuousStructure
    lines.push(`  <ContinuousStructure CoordSystem="${this.config.coordSystem || 0}">`);

    // Grid
    const g = this._grid;
    lines.push(`    <RectilinearGrid DeltaUnit="${g.unit}" CoordSystem="${this.config.coordSystem || 0}">`);
    lines.push(`      <XLines>${g.x.map(v => v.toExponential(10)).join(',')}</XLines>`);
    lines.push(`      <YLines>${g.y.map(v => v.toExponential(10)).join(',')}</YLines>`);
    lines.push(`      <ZLines>${g.z.map(v => v.toExponential(10)).join(',')}</ZLines>`);
    lines.push(`    </RectilinearGrid>`);

    // Properties
    lines.push(`    <Properties>`);

    // User-defined properties
    for (const prop of this._properties) {
      lines.push(this._propertyToXML(prop));
    }

    // Port-generated properties
    for (const port of this._ports) {
      lines.push(port.toXML());
    }

    lines.push(`    </Properties>`);
    lines.push(`  </ContinuousStructure>`);
    lines.push(`</openEMS>`);

    return lines.join('\n');
  }

  /**
   * Convert a property to XML.
   * @param {CSProperty} prop
   * @returns {string}
   */
  _propertyToXML(prop) {
    const lines = [];
    const attrStr = Object.entries(prop.attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
    const extra = attrStr ? ' ' + attrStr : '';

    // Opening tag
    if (prop.type === 'Metal') {
      lines.push(`      <Metal ID="0" Name="${prop.name}"${extra}>`);
    } else if (prop.type === 'Material') {
      // Material properties: Epsilon, Mue, Kappa, Sigma as child Property element
      lines.push(`      <Material ID="0" Name="${prop.name}">`);
      if (Object.keys(prop.attrs).length > 0) {
        const matAttrs = Object.entries(prop.attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
        lines.push(`        <Property ${matAttrs}/>`);
      }
    } else if (prop.type === 'ProbeBox') {
      lines.push(`      <ProbeBox ID="0" Name="${prop.name}" Number="0"${extra}>`);
    } else if (prop.type === 'DumpBox') {
      lines.push(`      <DumpBox ID="0" Name="${prop.name}"${extra}>`);
    } else {
      lines.push(`      <${prop.type} ID="0" Name="${prop.name}"${extra}>`);
    }

    // Primitives
    if (prop.primitives.length > 0) {
      lines.push(`        <Primitives>`);
      for (const prim of prop.primitives) {
        lines.push(this._primitiveToXML(prim));
      }
      lines.push(`        </Primitives>`);
    }

    // Closing tag
    if (prop.type === 'Material') {
      lines.push(`      </Material>`);
    } else if (prop.type === 'Metal') {
      lines.push(`      </Metal>`);
    } else if (prop.type === 'ProbeBox') {
      lines.push(`      </ProbeBox>`);
    } else if (prop.type === 'DumpBox') {
      lines.push(`      </DumpBox>`);
    } else {
      lines.push(`      </${prop.type}>`);
    }

    return lines.join('\n');
  }

  /**
   * Convert a primitive to XML.
   * @param {Object} prim
   * @returns {string}
   */
  _primitiveToXML(prim) {
    const lines = [];
    if (prim.type === 'Box') {
      lines.push(`          <Box Priority="${prim.priority}">`);
      lines.push(`            <P1 X="${prim.start[0]}" Y="${prim.start[1]}" Z="${prim.start[2]}"/>`);
      lines.push(`            <P2 X="${prim.stop[0]}" Y="${prim.stop[1]}" Z="${prim.stop[2]}"/>`);
      lines.push(`          </Box>`);
    } else if (prim.type === 'Cylinder') {
      lines.push(`          <Cylinder Priority="${prim.priority}" Radius="${prim.radius}">`);
      lines.push(`            <P1 X="${prim.start[0]}" Y="${prim.start[1]}" Z="${prim.start[2]}"/>`);
      lines.push(`            <P2 X="${prim.stop[0]}" Y="${prim.stop[1]}" Z="${prim.stop[2]}"/>`);
      lines.push(`          </Cylinder>`);
    } else if (prim.type === 'CylindricalShell') {
      lines.push(`          <CylindricalShell Priority="${prim.priority}" Radius="${prim.radius}" ShellWidth="${prim.shellWidth}">`);
      lines.push(`            <P1 X="${prim.start[0]}" Y="${prim.start[1]}" Z="${prim.start[2]}"/>`);
      lines.push(`            <P2 X="${prim.stop[0]}" Y="${prim.stop[1]}" Z="${prim.stop[2]}"/>`);
      lines.push(`          </CylindricalShell>`);
    } else if (prim.type === 'Curve') {
      lines.push(`          <Curve Priority="${prim.priority}">`);
      for (let i = 0; i < prim.points.length; i++) {
        const pt = prim.points[i];
        lines.push(`            <Vertex X="${pt[0]}" Y="${pt[1]}" Z="${pt[2]}"/>`);
      }
      lines.push(`          </Curve>`);
    } else if (prim.type === 'Sphere') {
      lines.push(`          <Sphere Priority="${prim.priority}" Radius="${prim.radius}">`);
      lines.push(`            <Center X="${prim.center[0]}" Y="${prim.center[1]}" Z="${prim.center[2]}"/>`);
      lines.push(`          </Sphere>`);
    } else if (prim.type === 'SphericalShell') {
      lines.push(`          <SphericalShell Priority="${prim.priority}" Radius="${prim.radius}" ShellWidth="${prim.shellWidth}">`);
      lines.push(`            <Center X="${prim.center[0]}" Y="${prim.center[1]}" Z="${prim.center[2]}"/>`);
      lines.push(`          </SphericalShell>`);
    } else if (prim.type === 'Polygon') {
      lines.push(`          <Polygon Priority="${prim.priority}" NormDir="${prim.normDir}" Elevation="${prim.elevation}">`);
      for (const pt of prim.points) {
        lines.push(`            <Vertex X="${pt[0]}" Y="${pt[1]}"/>`);
      }
      lines.push(`          </Polygon>`);
    } else if (prim.type === 'LinPoly') {
      lines.push(`          <LinPoly Priority="${prim.priority}" NormDir="${prim.normDir}" Elevation="${prim.elevation}" Length="${prim.length}">`);
      for (const pt of prim.points) {
        lines.push(`            <Vertex X="${pt[0]}" Y="${pt[1]}"/>`);
      }
      lines.push(`          </LinPoly>`);
    } else if (prim.type === 'RotPoly') {
      lines.push(`          <RotPoly Priority="${prim.priority}" NormDir="${prim.normDir}" Elevation="${prim.elevation}" RotAngle="${prim.angle}">`);
      for (const pt of prim.points) {
        lines.push(`            <Vertex X="${pt[0]}" Y="${pt[1]}"/>`);
      }
      lines.push(`          </RotPoly>`);
    } else if (prim.type === 'Wire') {
      lines.push(`          <Wire Priority="${prim.priority}" WireRadius="${prim.radius}">`);
      for (const pt of prim.points) {
        lines.push(`            <Vertex X="${pt[0]}" Y="${pt[1]}" Z="${pt[2]}"/>`);
      }
      lines.push(`          </Wire>`);
    }
    return lines.join('\n');
  }

  /**
   * Run the simulation via WASM.
   *
   * @param {Function} createOpenEMS - the WASM module factory
   * @param {Object} [opts]
   * @param {number} [opts.engineType=0] - 0=basic, 1=sse, 2=sse-compressed, 3=multithreaded
   * @param {string} [opts.simPath='/sim'] - MEMFS simulation directory
   * @returns {Promise<{ module: Object, ems: Object, simPath: string }>}
   */
  async run(createOpenEMS, opts = {}) {
    const engineType = opts.engineType || 0;
    const simPath = opts.simPath || '/sim';

    const Module = await createOpenEMS();

    // Create sim directory
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
   * @param {Object} params
   * @param {number} params.portNr
   * @param {string} params.metalProp
   * @param {Vec3} params.start
   * @param {Vec3} params.stop
   * @param {number} params.propDir - propagation direction: 0=x, 1=y, 2=z
   * @param {number} params.excDir - excitation direction: 0=x, 1=y, 2=z
   * @param {number} [params.excite=0]
   * @param {number} [params.priority=0]
   * @param {number} [params.feedShift=0]
   * @param {number} [params.measPlaneShift]
   * @param {number} [params.feedR=Infinity]
   * @returns {import('./ports.mjs').MSLPort}
   */
  addMSLPort(params) {
    const port = new MSLPort(this, params);
    this._ports.push(port);
    return port;
  }

  /**
   * Add a waveguide port with explicit mode functions.
   * @param {Object} params
   * @param {number} params.portNr
   * @param {Vec3} params.start
   * @param {Vec3} params.stop
   * @param {number} params.excDir
   * @param {Array<string|number>} params.E_func
   * @param {Array<string|number>} params.H_func
   * @param {number} params.kc
   * @param {number} [params.excite=0]
   * @returns {import('./ports.mjs').WaveguidePort}
   */
  addWaveGuidePort(params) {
    const port = new WaveguidePort(params);
    this._ports.push(port);
    return port;
  }

  /**
   * Add a rectangular waveguide port (TE modes).
   * @param {Object} params
   * @param {number} params.portNr
   * @param {Vec3} params.start
   * @param {Vec3} params.stop
   * @param {number} params.excDir
   * @param {number} params.a - waveguide width
   * @param {number} params.b - waveguide height
   * @param {string} params.modeName - e.g. 'TE10'
   * @param {number} [params.excite=0]
   * @param {number} [params.unit=1]
   * @returns {import('./ports.mjs').RectWGPort}
   */
  addRectWaveGuidePort(params) {
    const port = new RectWGPort(params);
    this._ports.push(port);
    return port;
  }

  /**
   * Create an NF2FF recording box.
   * @param {string} name
   * @param {Vec3} start
   * @param {Vec3} stop
   * @param {Object} [opts]
   * @param {boolean[]} [opts.directions]
   * @param {number[]} [opts.mirror]
   * @param {number[]} [opts.frequency]
   * @returns {import('./nf2ff.mjs').NF2FFBox}
   */
  createNF2FFBox(name, start, stop, opts = {}) {
    return createNF2FFBox(this, name, start, stop, opts);
  }

  /**
   * Add a cylindrical shell primitive to a property.
   * @param {string} propertyName
   * @param {number} priority
   * @param {Vec3} start
   * @param {Vec3} stop
   * @param {number} radius
   * @param {number} shellWidth
   */
  addCylindricalShell(propertyName, priority, start, stop, radius, shellWidth) {
    const prop = this._properties.find(p => p.name === propertyName);
    if (!prop) throw new Error(`Property "${propertyName}" not found`);
    prop.primitives.push({
      type: 'CylindricalShell',
      start: [...start],
      stop: [...stop],
      radius,
      shellWidth,
      priority,
    });
  }

  /**
   * Add a curve (polyline) primitive to a property.
   * @param {string} propertyName
   * @param {number} priority
   * @param {Vec3[]} points - array of [x, y, z] points
   */
  addCurve(propertyName, priority, points) {
    const prop = this._properties.find(p => p.name === propertyName);
    if (!prop) throw new Error(`Property "${propertyName}" not found`);
    prop.primitives.push({
      type: 'Curve',
      points: points.map(p => [...p]),
      priority,
    });
  }

  /**
   * Smooth the grid so no spacing exceeds maxRes on any axis.
   * Calls smoothMeshLines from automesh.mjs on each axis.
   * @param {number|number[]} maxRes - maximum resolution (scalar or [x,y,z])
   */
  smoothGrid(maxRes) {
    const mx = Array.isArray(maxRes) ? maxRes[0] : maxRes;
    const my = Array.isArray(maxRes) ? maxRes[1] : maxRes;
    const mz = Array.isArray(maxRes) ? maxRes[2] : maxRes;
    this._grid.x = smoothMeshLines(this._grid.x, mx);
    this._grid.y = smoothMeshLines(this._grid.y, my);
    this._grid.z = smoothMeshLines(this._grid.z, mz);
  }

  /**
   * Read simulation from XML string.
   * Stub for future implementation — documents the API surface.
   * @param {string} xmlString
   */
  readFromXML(xmlString) {
    throw new Error('Not yet implemented — use toXML() to generate XML');
  }

  /**
   * Get ports.
   * @returns {import('./ports.mjs').Port[]}
   */
  get ports() {
    return this._ports;
  }
}
