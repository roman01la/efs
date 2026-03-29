const DIR_MAP = { x: 0, y: 1, z: 2 };
const BC_MAP = { PEC: 0, PMC: 1, MUR: 2, PBC: -1 };

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtNum = (v) => {
  if (typeof v !== 'number') return String(v);
  if (Math.abs(v) >= 1e6 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3)) return v.toExponential();
  return String(v);
};

function Unique(l, tol = 1e-7) {
  l = [...new Set(l)].sort((a, b) => a - b);
  if (l.length < 2) return l;
  const dl = [];
  for (let i = 0; i < l.length - 1; i++) dl.push(l[i + 1] - l[i]);
  const mean = dl.reduce((a, b) => a + b, 0) / dl.length;
  const idx = [];
  for (let i = 0; i < dl.length; i++) {
    if (dl[i] < mean * tol) idx.push(i);
  }
  if (idx.length > 0) {
    const remove = new Set(idx);
    l = l.filter((_, i) => !remove.has(i));
  }
  return l;
}

function CheckSymmetry(lines) {
  const tolerance = 1e-10;
  const NP = lines.length;
  if (NP <= 2) return 0;
  const line_range = lines[NP - 1] - lines[0];
  const center = 0.5 * (lines[NP - 1] + lines[0]);
  for (let n = 0; n < Math.floor(NP / 2); n++) {
    if (Math.abs((center - lines[n]) - (lines[NP - n - 1] - center)) > line_range * tolerance) return 0;
  }
  if (NP % 2 === 1) {
    if (Math.abs(lines[Math.floor(NP / 2)] - center) > line_range * tolerance) return 0;
  }
  return NP % 2 === 0 ? 2 : 1;
}

function SmoothRange(start, stop, start_res, stop_res, max_res, ratio) {
  console.assert(ratio > 1);
  const rng = stop - start;
  if (rng < max_res && rng < start_res * ratio && rng < stop_res * ratio) {
    return Unique([start, stop]);
  }
  if (start_res >= (max_res / ratio) && stop_res >= (max_res / ratio)) {
    const N = Math.ceil(rng / max_res);
    const tmp = [];
    for (let i = 0; i <= N; i++) tmp.push(start + (stop - start) * i / N);
    return [start, ...tmp.slice(1, -1), stop];
  }

  const one_side_taper = (start_res_inner, ratio_inner, max_res_inner) => {
    let res = start_res_inner;
    let pos = 0;
    let N = 0;
    while (res < max_res_inner && pos < rng) {
      res *= ratio_inner;
      pos += res;
      N += 1;
    }
    if (pos > rng) {
      const l = new Array(N + 1);
      l[0] = 0;
      for (let n = 1; n <= N; n++) {
        let s = 0;
        for (let k = 1; k <= n; k++) s += start_res_inner * Math.pow(ratio_inner, k);
        l[n] = s;
      }
      return l.map((v) => v * rng / pos);
    }
    const _ratio = Math.exp((Math.log(max_res_inner) - Math.log(start_res_inner)) / N);
    const l = [0];
    pos = 0;
    res = start_res_inner;
    for (let n = 0; n < N; n++) {
      res *= _ratio;
      pos += res;
      l.push(pos);
    }
    while (pos < rng) {
      pos += max_res_inner;
      l.push(pos);
    }
    const last = l[l.length - 1];
    return l.map((v) => v * rng / last);
  };

  if (start_res < (max_res / ratio) && stop_res >= (max_res / ratio)) {
    const tmp = one_side_taper(start_res, ratio, max_res).map((v) => start + v);
    return [start, ...tmp.slice(1, -1), stop];
  }
  if (start_res >= (max_res / ratio) && stop_res < (max_res / ratio)) {
    const raw = one_side_taper(stop_res, ratio, max_res).map((v) => stop - v);
    const tmp = [...raw].sort((a, b) => a - b);
    return [start, ...tmp.slice(1, -1), stop];
  }

  let pos1 = 0, N1 = 0, res = start_res;
  while (res < max_res) {
    res *= ratio;
    pos1 += res;
    N1 += 1;
  }
  const ratio1 = Math.exp((Math.log(max_res) - Math.log(start_res)) / N1);
  pos1 = 0;
  for (let k = 1; k <= N1; k++) pos1 += start_res * Math.pow(ratio1, k);

  let pos2 = 0, N2 = 0;
  res = stop_res;
  while (res < max_res) {
    res *= ratio;
    pos2 += res;
    N2 += 1;
  }
  const ratio2 = Math.exp((Math.log(max_res) - Math.log(stop_res)) / N2);
  pos2 = 0;
  for (let k = 1; k <= N2; k++) pos2 += stop_res * Math.pow(ratio2, k);

  if ((pos1 + pos2) < rng) {
    const l = [0];
    for (let n = 1; n <= N1; n++) l.push(l[l.length - 1] + start_res * Math.pow(ratio1, n));
    const r = [0];
    for (let n = 1; n <= N2; n++) r.push(r[r.length - 1] + stop_res * Math.pow(ratio2, n));
    const left = rng - pos1 - pos2;
    const N = Math.ceil(left / max_res);
    for (let n = 0; n < N; n++) l.push(l[l.length - 1] + max_res);
    const length = l[l.length - 1] + r[r.length - 1];
    const combined = [...l, ...r.map((v) => length - v)];
    const c = Unique(combined);
    const tmp = c.map((v) => start + v * rng / length);
    return [start, ...tmp.slice(1, -1), stop];
  }

  const l = [0], r = [0];
  while (l[l.length - 1] + r[r.length - 1] < rng) {
    if (start_res === stop_res) {
      start_res *= ratio;
      l.push(l[l.length - 1] + start_res);
      stop_res *= ratio;
      r.push(r[r.length - 1] + start_res);
    } else if (start_res < stop_res) {
      start_res *= ratio;
      l.push(l[l.length - 1] + start_res);
    } else {
      stop_res *= ratio;
      r.push(r[r.length - 1] + start_res);
    }
  }
  const length = l[l.length - 1] + r[r.length - 1];
  const combined = [...l, ...r.map((v) => length - v)];
  const c = Unique(combined);
  const tmp = c.map((v) => start + v * rng / length);
  return [start, ...tmp.slice(1, -1), stop];
}

function SmoothMeshLines(lines, max_res, ratio = 1.5) {
  let out_l = Unique([...lines]);
  const sym = CheckSymmetry(out_l);
  let center;
  if (sym === 1) {
    center = 0.5 * (out_l[out_l.length - 1] + out_l[0]);
    out_l = out_l.slice(0, Math.floor(out_l.length / 2) + 1);
  } else if (sym === 2) {
    center = 0.5 * (out_l[out_l.length - 1] + out_l[0]);
    out_l = out_l.slice(0, Math.floor(out_l.length / 2));
  }
  let dl = [];
  for (let i = 0; i < out_l.length - 1; i++) dl.push(out_l[i + 1] - out_l[i]);
  while (dl.some((v) => v > max_res)) {
    const N = out_l.length;
    const maxDl = Math.max(...dl);
    const dl_mod = dl.map((v) => v <= max_res ? maxDl * 2 : v);
    let idx = 0;
    for (let i = 1; i < dl_mod.length; i++) {
      if (dl_mod[i] < dl_mod[idx]) idx = i;
    }
    dl = [];
    for (let i = 0; i < out_l.length - 1; i++) dl.push(out_l[i + 1] - out_l[i]);
    const start_res = idx > 0 ? dl[idx - 1] : max_res;
    const stop_res = idx < dl.length - 1 ? dl[idx + 1] : max_res;
    const l = SmoothRange(out_l[idx], out_l[idx + 1], start_res, stop_res, max_res, ratio);
    out_l = Unique([...out_l, ...l]);
    dl = [];
    for (let i = 0; i < out_l.length - 1; i++) dl.push(out_l[i + 1] - out_l[i]);
    if (out_l.length === N) break;
  }
  if (sym === 1) {
    const mirrored = out_l.slice(0, -1).map((v) => 2 * center - v);
    return Unique([...out_l, ...mirrored]);
  } else if (sym === 2) {
    const l = SmoothRange(out_l[out_l.length - 1], 2 * center - out_l[out_l.length - 1], dl[dl.length - 1], dl[dl.length - 1], max_res, ratio);
    const mirrored = out_l.map((v) => 2 * center - v);
    return Unique([...out_l, ...l, ...mirrored]);
  }
  return Unique(out_l);
}

class Mesh {
  constructor() {
    this._lines = { x: [], y: [], z: [] };
    this._deltaUnit = 1;
  }

  SetDeltaUnit(unit) {
    this._deltaUnit = unit;
  }

  AddLine(dir, values) {
    const vals = Array.isArray(values) ? values : [values];
    if (dir === 'all') {
      for (const d of ['x', 'y', 'z']) this._lines[d].push(...vals);
    } else {
      this._lines[dir].push(...vals);
    }
  }

  SmoothMeshLines(dir, maxRes, ratio = 1.5) {
    const dirs = dir === 'all' ? ['x', 'y', 'z'] : [dir];
    for (const d of dirs) {
      this._lines[d] = SmoothMeshLines(this._lines[d], maxRes, ratio);
    }
  }

  GetLines(dir) {
    return [...this._lines[dir]].sort((a, b) => a - b);
  }

  SetLines(dir, lines) {
    this._lines[dir] = [...lines];
  }
}

class Property {
  constructor(type, name, attrs = {}) {
    this.type = type;
    this.name = name;
    this.attrs = attrs;
    this.primitives = [];
  }

  AddBox(start, stop, priority = 0) {
    this.primitives.push({ kind: 'Box', priority, start, stop });
    return this;
  }

  AddCylinder(start, stop, radius, priority = 0) {
    this.primitives.push({ kind: 'Cylinder', priority, start, stop, radius });
    return this;
  }

  AddSphere(center, radius, priority = 0) {
    this.primitives.push({ kind: 'Sphere', priority, center, radius });
    return this;
  }

  AddCurve(points, priority = 0) {
    this.primitives.push({ kind: 'Curve', priority, points });
    return this;
  }

  AddWire(points, radius, priority = 0) {
    this.primitives.push({ kind: 'Wire', priority, points, radius });
    return this;
  }

  _toXML(indent) {
    const pad = ' '.repeat(indent);
    const pad2 = ' '.repeat(indent + 2);
    const pad3 = ' '.repeat(indent + 4);
    let tag, attrStr = '';

    switch (this.type) {
      case 'Metal':
        tag = 'Metal';
        attrStr = ` Name="${escapeXml(this.name)}"`;
        break;
      case 'Material': {
        tag = 'Material';
        attrStr = ` Name="${escapeXml(this.name)}"`;
        break;
      }
      case 'ConductingSheet':
        tag = 'ConductingSheet';
        attrStr = ` Name="${escapeXml(this.name)}"`;
        if (this.attrs.conductivity != null) attrStr += ` Conductivity="${this.attrs.conductivity}"`;
        if (this.attrs.thickness != null) attrStr += ` Thickness="${this.attrs.thickness}"`;
        break;
      case 'LumpedElement':
        tag = 'LumpedElement';
        attrStr = ` Name="${escapeXml(this.name)}"`;
        if (this.attrs.Direction != null) attrStr += ` Direction="${this.attrs.Direction}"`;
        if (this.attrs.R != null) attrStr += ` R="${this.attrs.R}"`;
        attrStr += ` C="${this.attrs.C ?? 0}" L="${this.attrs.L ?? 0}"`;
        break;
      case 'Excitation':
        tag = 'Excitation';
        attrStr = ` Name="${escapeXml(this.name)}" Type="${this.attrs.Type ?? 0}"`;
        if (this.attrs.Excite != null) attrStr += ` Excite="${this.attrs.Excite}"`;
        break;
      case 'ProbeBox':
        tag = 'ProbeBox';
        attrStr = ` Name="${escapeXml(this.name)}" Type="${this.attrs.Type}"`;
        if (this.attrs.Weight != null) attrStr += ` Weight="${this.attrs.Weight}"`;
        if (this.attrs.NormDir != null) attrStr += ` NormDir="${this.attrs.NormDir}"`;
        break;
      case 'DumpBox':
        tag = 'DumpBox';
        attrStr = ` Name="${escapeXml(this.name)}"`;
        if (this.attrs.DumpType != null) attrStr += ` DumpType="${this.attrs.DumpType}"`;
        if (this.attrs.DumpMode != null) attrStr += ` DumpMode="${this.attrs.DumpMode}"`;
        if (this.attrs.FileType != null) attrStr += ` FileType="${this.attrs.FileType}"`;
        break;
      default:
        tag = this.type;
        attrStr = ` Name="${escapeXml(this.name)}"`;
        break;
    }

    let xml = `${pad}<${tag}${attrStr}>\n`;

    if (this.type === 'Material') {
      const props = [];
      if (this.attrs.Epsilon != null) props.push(`Epsilon="${this.attrs.Epsilon}"`);
      if (this.attrs.Kappa != null) props.push(`Kappa="${this.attrs.Kappa}"`);
      if (this.attrs.Mue != null) props.push(`Mue="${this.attrs.Mue}"`);
      if (props.length > 0) xml += `${pad2}<Property ${props.join(' ')}/>\n`;
    }

    if (this.attrs.FD_Samples != null) {
      xml += `${pad2}<FD_Samples>${fmtNum(this.attrs.FD_Samples)}</FD_Samples>\n`;
    }

    if (this.primitives.length > 0) {
      xml += `${pad2}<Primitives>\n`;
      for (const p of this.primitives) {
        xml += this._primToXML(p, pad3);
      }
      xml += `${pad2}</Primitives>\n`;
    }

    xml += `${pad}</${tag}>\n`;
    return xml;
  }

  _primToXML(p, pad) {
    const fv = (v) => fmtNum(v);
    const point = (tag, xyz) => `<${tag} X="${fv(xyz[0])}" Y="${fv(xyz[1])}" Z="${fv(xyz[2])}"/>`;
    const normalizePoints = (points) => {
      if (Array.isArray(points[0]) && points.length === 3 && points[0].length !== 3) {
        const result = [];
        for (let i = 0; i < points[0].length; i++) {
          result.push([points[0][i], points[1][i], points[2][i]]);
        }
        return result;
      }
      if (points[0] && typeof points[0] === 'object' && 'x' in points[0]) {
        return points.map((p) => [p.x, p.y, p.z]);
      }
      return points;
    };

    switch (p.kind) {
      case 'Box':
        return `${pad}<Box Priority="${p.priority}">${point('P1', p.start)}${point('P2', p.stop)}</Box>\n`;
      case 'Cylinder':
        return `${pad}<Cylinder Priority="${p.priority}" Radius="${fv(p.radius)}">${point('P1', p.start)}${point('P2', p.stop)}</Cylinder>\n`;
      case 'Sphere':
        return `${pad}<Sphere Priority="${p.priority}" Radius="${fv(p.radius)}">${point('P1', p.center)}${point('P2', p.center)}</Sphere>\n`;
      case 'Curve': {
        const pts = normalizePoints(p.points);
        let xml = `${pad}<Curve Priority="${p.priority}">`;
        for (const pt of pts) xml += `<Vertex X="${fv(pt[0])}" Y="${fv(pt[1])}" Z="${fv(pt[2])}"/>`;
        xml += `</Curve>\n`;
        return xml;
      }
      case 'Wire': {
        const pts = normalizePoints(p.points);
        let xml = `${pad}<Wire Priority="${p.priority}" WireRadius="${fv(p.radius)}">`;
        for (const pt of pts) xml += `<Vertex X="${fv(pt[0])}" Y="${fv(pt[1])}" Z="${fv(pt[2])}"/>`;
        xml += `</Wire>\n`;
        return xml;
      }
      default:
        return '';
    }
  }
}

class ContinuousStructure {
  constructor() {
    this._grid = new Mesh();
    this._properties = [];
  }

  GetGrid() {
    return this._grid;
  }

  AddMetal(name) {
    const p = new Property('Metal', name);
    this._properties.push(p);
    return p;
  }

  AddMaterial(name, { Epsilon, Kappa, Mue } = {}) {
    const p = new Property('Material', name, { Epsilon, Kappa, Mue });
    this._properties.push(p);
    return p;
  }

  AddConductingSheet(name, { conductivity, thickness } = {}) {
    const p = new Property('ConductingSheet', name, { conductivity, thickness });
    this._properties.push(p);
    return p;
  }

  AddExcitation(name, type, exciteVec) {
    const p = new Property('Excitation', name, {
      Type: type, Excite: Array.isArray(exciteVec) ? exciteVec.join(',') : exciteVec,
    });
    this._properties.push(p);
    return p;
  }

  AddProbe(name, type, { weight, normDir } = {}) {
    const attrs = { Type: type };
    if (weight != null) attrs.Weight = weight;
    if (normDir != null) attrs.NormDir = normDir;
    const p = new Property('ProbeBox', name, attrs);
    this._properties.push(p);
    return p;
  }

  _addProperty(type, name, attrs) {
    const p = new Property(type, name, attrs);
    this._properties.push(p);
    return p;
  }
}

class OpenEMS {
  constructor({ NrTS = 30000, EndCriteria = 1e-4 } = {}) {
    this._nrTS = NrTS;
    this._endCriteria = EndCriteria;
    this._f0 = 0;
    this._fc = 0;
    this._bc = null;
    this._blochPhase = { x: 0, y: 0, z: 0 };
    this._csx = null;
    this._ports = [];
    this._nf2ff = null;
  }

  SetGaussExcite(f0, fc) {
    this._f0 = f0;
    this._fc = fc;
  }

  SetBoundaryCond(conds) {
    this._bc = conds;
  }

  /**
   * Set Bloch/Floquet phase shift for periodic boundary conditions.
   * @param {{x?: number, y?: number, z?: number}} phase - phase shift [rad] per axis
   */
  SetBlochPhaseShift(phase) {
    if (phase.x !== undefined) this._blochPhase.x = phase.x;
    if (phase.y !== undefined) this._blochPhase.y = phase.y;
    if (phase.z !== undefined) this._blochPhase.z = phase.z;
  }

  SetCSX(csx) {
    this._csx = csx;
  }

  AddLumpedPort(nr, R, start, stop, dir, excite = 1.0, { priority = 5 } = {}) {
    const dirIdx = DIR_MAP[dir];
    const exciteVec = [0, 0, 0];
    exciteVec[dirIdx] = 1;
    const exciteStr = exciteVec.join(',');

    const lumped = this._csx._addProperty('LumpedElement', `port_resist_${nr}`, {
      Direction: dirIdx, R, C: 0, L: 0,
    });
    lumped.AddBox(start, stop, priority);

    if (excite) {
      const exc = this._csx._addProperty('Excitation', `port_excite_${nr}`, {
        Type: 0, Excite: exciteStr,
      });
      exc.AddBox(start, stop, priority);
    }

    const vProbe = this._csx._addProperty('ProbeBox', `port_ut${nr}`, {
      Type: 0, Weight: -1,
    });
    vProbe.AddBox(start, stop, priority);

    const expandedStart = [...start];
    const expandedStop = [...stop];
    const mid = (start[dirIdx] + stop[dirIdx]) / 2;
    expandedStart[dirIdx] = mid;
    expandedStop[dirIdx] = mid;
    for (let i = 0; i < 3; i++) {
      if (i !== dirIdx) {
        const mesh = this._csx._grid;
        const lines = mesh.GetLines(['x', 'y', 'z'][i]);
        const lo = Math.min(start[i], stop[i]);
        const hi = Math.max(start[i], stop[i]);
        let loIdx = lines.findIndex((v) => Math.abs(v - lo) < 1e-10);
        let hiIdx = lines.findIndex((v) => Math.abs(v - hi) < 1e-10);
        if (loIdx < 0) loIdx = lines.findIndex((v) => v >= lo);
        if (hiIdx < 0) hiIdx = lines.findIndex((v) => v >= hi);
        if (loIdx < 0) loIdx = 0;
        if (hiIdx < 0) hiIdx = lines.length - 1;
        const newLo = loIdx > 1 ? lines[loIdx - 2] : loIdx > 0 ? lines[loIdx - 1] : lines[loIdx];
        const newHi = hiIdx < lines.length - 2 ? lines[hiIdx + 2] : hiIdx < lines.length - 1 ? lines[hiIdx + 1] : lines[hiIdx];
        if (start[i] <= stop[i]) {
          expandedStart[i] = newLo;
          expandedStop[i] = newHi;
        } else {
          expandedStart[i] = newHi;
          expandedStop[i] = newLo;
        }
      }
    }

    const iProbe = this._csx._addProperty('ProbeBox', `port_it${nr}`, {
      Type: 1, Weight: 1, NormDir: dirIdx,
    });
    iProbe.AddBox(expandedStart, expandedStop, priority);

    this._ports.push({ nr, R, start, stop, dir, excite });
    return { nr, lumped, vProbe, iProbe };
  }

  CreateNF2FFBox({ frequency, opt_resolution } = {}) {
    this._nf2ff = { frequency, opt_resolution };
  }

  GenerateXML() {
    const fMax = this._f0 + this._fc;
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<openEMS>\n`;
    xml += `  <FDTD NumberOfTimesteps="${this._nrTS}" endCriteria="${fmtNum(this._endCriteria)}" f_max="${fmtNum(fMax)}">\n`;
    xml += `    <Excitation Type="0" f0="${fmtNum(this._f0)}" fc="${fmtNum(this._fc)}"/>\n`;

    if (this._bc) {
      const dirs = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'];
      const bcAttrs = [];
      const pmlAttrs = [];
      for (let i = 0; i < 6; i++) {
        const cond = this._bc[i];
        const m = cond.match(/^PML_(\d+)$/);
        if (m) {
          bcAttrs.push(`${dirs[i]}="3"`);
          pmlAttrs.push(`PML_${dirs[i]}="${m[1]}"`);
        } else {
          bcAttrs.push(`${dirs[i]}="${BC_MAP[cond] ?? 0}"`);
        }
      }
      const blochAttrs = [];
      if (this._blochPhase.x !== 0) blochAttrs.push(`BlochPhase_x="${this._blochPhase.x}"`);
      if (this._blochPhase.y !== 0) blochAttrs.push(`BlochPhase_y="${this._blochPhase.y}"`);
      if (this._blochPhase.z !== 0) blochAttrs.push(`BlochPhase_z="${this._blochPhase.z}"`);
      xml += `    <BoundaryCond ${bcAttrs.join(' ')}`;
      if (pmlAttrs.length > 0) xml += `\n                  ${pmlAttrs.join(' ')}`;
      if (blochAttrs.length > 0) xml += `\n                  ${blochAttrs.join(' ')}`;
      xml += `/>\n`;
    }

    xml += `  </FDTD>\n`;

    if (this._csx) {
      const grid = this._csx._grid;
      xml += `  <ContinuousStructure CoordSystem="0">\n`;
      xml += `    <RectilinearGrid DeltaUnit="${fmtNum(grid._deltaUnit)}">\n`;

      for (const dir of ['x', 'y', 'z']) {
        const tag = dir.toUpperCase() + 'Lines';
        const lines = grid.GetLines(dir);
        xml += `      <${tag}>${lines.map(fmtNum).join(',')}</${tag}>\n`;
      }
      xml += `    </RectilinearGrid>\n`;

      if (this._nf2ff) {
        this._generateNF2FFProperties();
      }

      xml += `    <Properties>\n`;
      for (const prop of this._csx._properties) {
        xml += prop._toXML(6);
      }
      xml += `    </Properties>\n`;
      xml += `  </ContinuousStructure>\n`;
    }

    xml += `</openEMS>\n`;
    return xml;
  }

  _generateNF2FFProperties() {
    const grid = this._csx._grid;
    const xLines = grid.GetLines('x');
    const yLines = grid.GetLines('y');
    const zLines = grid.GetLines('z');
    const minLen = Math.min(xLines.length, yLines.length, zLines.length);
    if (minLen < 7) return;

    // Skip NF2FF faces on PBC axes — periodic faces have cancelling contributions.
    // For PBC axes, use full unit cell extent (no inset) on the remaining faces.
    // For PML axes, inset must clear the PML region (PML_N uses N cells).
    const bc = this._bc || [];
    const xPBC = bc[0] === 'PBC' && bc[1] === 'PBC';
    const yPBC = bc[2] === 'PBC' && bc[3] === 'PBC';
    const zPBC = bc[4] === 'PBC' && bc[5] === 'PBC';

    // Compute per-axis insets: PBC=0, PML=N+1 (clear PML region), other=3
    const insets = [0, 0, 0, 0, 0, 0]; // xmin, xmax, ymin, ymax, zmin, zmax
    const dirs = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'];
    for (let i = 0; i < 6; i++) {
      const cond = bc[i] || 'PEC';
      const pmlM = cond.match?.(/^PML_(\d+)$/);
      if (cond === 'PBC') {
        insets[i] = 0;
      } else if (pmlM) {
        insets[i] = parseInt(pmlM[1]) + 1; // clear PML + 1 cell margin
      } else {
        insets[i] = Math.min(3, Math.floor((minLen - 1) / 2));
      }
    }

    // For PBC axes, use full unit cell but exclude the last mesh line
    // (it's the periodic duplicate of line 0, and ix=Nx-1 triggers boundary
    // checks in the NF2FF shader that zero the E-field interpolation).
    const xMin = xPBC ? xLines[0] : xLines[insets[0]];
    const xMax = xPBC ? xLines[xLines.length - 2] : xLines[xLines.length - 1 - insets[1]];
    const yMin = yPBC ? yLines[0] : yLines[insets[2]];
    const yMax = yPBC ? yLines[yLines.length - 2] : yLines[yLines.length - 1 - insets[3]];
    const zMin = zPBC ? zLines[0] : zLines[insets[4]];
    const zMax = zPBC ? zLines[zLines.length - 2] : zLines[zLines.length - 1 - insets[5]];

    const fdSamples = this._nf2ff.frequency != null ? fmtNum(this._nf2ff.frequency) : null;

    const faces = [];
    if (!xPBC) {
      faces.push({ name: 'xn', start: [xMin, yMin, zMin], stop: [xMin, yMax, zMax] });
      faces.push({ name: 'xp', start: [xMax, yMin, zMin], stop: [xMax, yMax, zMax] });
    }
    if (!yPBC) {
      faces.push({ name: 'yn', start: [xMin, yMin, zMin], stop: [xMax, yMin, zMax] });
      faces.push({ name: 'yp', start: [xMin, yMax, zMin], stop: [xMax, yMax, zMax] });
    }
    if (!zPBC) {
      faces.push({ name: 'zn', start: [xMin, yMin, zMin], stop: [xMax, yMax, zMin] });
      faces.push({ name: 'zp', start: [xMin, yMin, zMax], stop: [xMax, yMax, zMax] });
    }

    for (const field of ['E', 'H']) {
      const dumpType = field === 'E' ? 10 : 11;
      const prop = this._csx._addProperty('DumpBox', `nf2ff_${field}`, {
        DumpType: dumpType, DumpMode: 1, FileType: 1,
        ...(fdSamples != null ? { FD_Samples: fdSamples } : {}),
      });
      for (const face of faces) {
        prop.AddBox(face.start, face.stop, 0);
      }
    }
  }
}

export { OpenEMS, ContinuousStructure, Mesh, Property, SmoothMeshLines, Unique, CheckSymmetry, SmoothRange };
