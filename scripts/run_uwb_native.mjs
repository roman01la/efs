#!/usr/bin/env node
/**
 * Generate UWB Comb Dipole XML with per-face NF2FF dumps,
 * run native openEMS, post-process NF2FF, produce S11 + radiation SVG plots.
 */
import { OpenEMS, ContinuousStructure } from '../app/ems-api.mjs';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SIM_DIR = join(ROOT, 'uwb_native');
const PLOTS = join(SIM_DIR, 'plots');
mkdirSync(PLOTS, { recursive: true });

// ─── Generate UWB XML with per-face NF2FF dumps ─────────────────────────────
function generateUWBXML() {
  const unit = 1e-3;
  const C0 = 299792458;
  const f0 = 5.8e9, fc = 4.0e9;
  const epsR = 4.4;
  const subW = 14, subL = 48, subH = 1.15;
  const hw = subW / 2;
  const SimBox = [60, 100, 60];
  const mesh_res = C0 / (f0 + fc) / unit / 20;

  // Top arm
  const tsCx = 1.2, tsYbot = 1.5, tsYtop = 23.8;
  const ssInner = 4.3, ssYtop = 10.6;
  const tabYbot = 1.9, tabYtop = 2.6;
  // Bottom arm
  const barYtop = -1.5, barYbot = -2.6;
  const bsInner = 4.7, bsYbot = -11.7;
  const bcHW = 3.9, bcYbot = -16.2;
  const bfYbot = -subL / 2;
  // Feed
  const feedY1 = 2.3, feedY2 = -2.3;

  const FDTD = new OpenEMS({ NrTS: 50000, EndCriteria: 1e-4 });
  FDTD.SetGaussExcite(f0, fc);
  FDTD.SetBoundaryCond(['PML_8','PML_8','PML_8','PML_8','PML_8','PML_8']);

  const CSX = new ContinuousStructure();
  FDTD.SetCSX(CSX);
  const mesh = CSX.GetGrid();
  mesh.SetDeltaUnit(unit);

  mesh.AddLine('x', [-SimBox[0]/2, SimBox[0]/2]);
  mesh.AddLine('y', [-SimBox[1]/2, SimBox[1]/2]);
  mesh.AddLine('z', [-SimBox[2]/3, SimBox[2]*2/3]);
  mesh.AddLine('x', [-hw, hw]);
  mesh.AddLine('y', [-subL/2, subL/2]);
  for (let i = 0; i <= 3; i++) mesh.AddLine('z', subH * i / 3);
  mesh.AddLine('x', [-tsCx, tsCx, -ssInner, ssInner]);
  mesh.AddLine('y', [tsYbot, tsYtop, ssYtop, tabYbot, tabYtop]);
  mesh.AddLine('x', [-bsInner, bsInner, -bcHW, bcHW]);
  mesh.AddLine('y', [barYtop, barYbot, bsYbot, bcYbot, bfYbot]);
  mesh.AddLine('y', [feedY1, feedY2]);
  mesh.AddLine('x', 0);
  mesh.AddLine('y', 0);

  mesh.SmoothMeshLines('x', mesh_res, 1.4);
  mesh.SmoothMeshLines('y', mesh_res, 1.4);
  mesh.SmoothMeshLines('z', mesh_res, 1.4);

  // Substrate
  CSX.AddMaterial('substrate', { Epsilon: epsR })
    .AddBox([-hw, -subL/2, 0], [hw, subL/2, subH], 1);

  // Copper polygons
  const metal = CSX.AddMetal('antenna');
  metal.AddPolygon([
    [-hw, tsYbot], [-ssInner, tsYbot], [-ssInner, tabYbot], [-tsCx, tabYbot],
    [-tsCx, tsYbot], [tsCx, tsYbot], [tsCx, tabYbot], [ssInner, tabYbot],
    [ssInner, tsYbot], [hw, tsYbot], [hw, ssYtop], [ssInner, ssYtop],
    [ssInner, tabYtop], [tsCx, tabYtop], [tsCx, tsYtop], [-tsCx, tsYtop],
    [-tsCx, tabYtop], [-ssInner, tabYtop], [-ssInner, ssYtop], [-hw, ssYtop],
  ], 2, subH, 10);
  metal.AddPolygon([
    [-hw, barYtop], [hw, barYtop], [hw, bsYbot], [bsInner, bsYbot],
    [bsInner, barYbot], [bcHW, barYbot], [bcHW, bcYbot], [hw, bcYbot],
    [hw, bfYbot], [-hw, bfYbot], [-hw, bcYbot], [-bcHW, bcYbot],
    [-bcHW, barYbot], [-bsInner, barYbot], [-bsInner, bsYbot], [-hw, bsYbot],
  ], 2, subH, 10);

  // Lumped port
  FDTD.AddLumpedPort(1, 50, [0, feedY2, subH], [0, feedY1, subH], 'y', 1.0);

  // NF2FF: per-face DumpBox (native nf2ff needs separate files)
  const xLines = mesh.GetLines('x');
  const yLines = mesh.GetLines('y');
  const zLines = mesh.GetLines('z');

  const bc = ['PML_8','PML_8','PML_8','PML_8','PML_8','PML_8'];
  const insets = bc.map(c => { const m = c.match(/^PML_(\d+)$/); return m ? parseInt(m[1]) + 1 : 3; });
  const xMin = xLines[insets[0]], xMax = xLines[xLines.length - 1 - insets[1]];
  const yMin = yLines[insets[2]], yMax = yLines[yLines.length - 1 - insets[3]];
  const zMin = zLines[insets[4]], zMax = zLines[zLines.length - 1 - insets[5]];

  const nf2ffFreq = f0;
  const faces = [
    { name: 'xn', start: [xMin, yMin, zMin], stop: [xMin, yMax, zMax] },
    { name: 'xp', start: [xMax, yMin, zMin], stop: [xMax, yMax, zMax] },
    { name: 'yn', start: [xMin, yMin, zMin], stop: [xMax, yMin, zMax] },
    { name: 'yp', start: [xMin, yMax, zMin], stop: [xMax, yMax, zMax] },
    { name: 'zn', start: [xMin, yMin, zMin], stop: [xMax, yMax, zMin] },
    { name: 'zp', start: [xMin, yMin, zMax], stop: [xMax, yMax, zMax] },
  ];

  for (const field of ['E', 'H']) {
    const dumpType = field === 'E' ? 10 : 11;
    for (const face of faces) {
      const prop = CSX._addProperty('DumpBox', `nf2ff_${field}_${face.name}`, {
        DumpType: dumpType, DumpMode: 1, FileType: 1,
        FD_Samples: nf2ffFreq.toExponential(),
      });
      prop.AddBox(face.start, face.stop, 0);
    }
  }

  return { xml: FDTD.GenerateXML(), faces, nf2ffFreq, f0, fc };
}

// ─── DFT ─────────────────────────────────────────────────────────────────────
function dft(time, values, freqs) {
  const re = new Float64Array(freqs.length);
  const im = new Float64Array(freqs.length);
  for (let k = 0; k < freqs.length; k++) {
    const omega = 2 * Math.PI * freqs[k];
    let sr = 0, si = 0;
    for (let n = 0; n < time.length; n++) {
      const w = n > 0 ? time[n] - time[n - 1] : (time.length > 1 ? time[1] - time[0] : 1);
      sr += values[n] * Math.cos(omega * time[n]) * w;
      si -= values[n] * Math.sin(omega * time[n]) * w;
    }
    re[k] = sr; im[k] = si;
  }
  return { re, im };
}

function loadProbe(path) {
  const data = readFileSync(path, 'utf8');
  const t = [], v = [];
  for (const line of data.trim().split('\n')) {
    if (line.startsWith('%') || !line.trim()) continue;
    const [ts, vs] = line.split(/\s+/);
    t.push(parseFloat(ts)); v.push(parseFloat(vs));
  }
  return { time: Float64Array.from(t), values: Float64Array.from(v) };
}

// ─── SVG helpers ─────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function linePlotSVG({ title, xLabel, yLabel, lines, refLines, W = 600, H = 360 }) {
  const m = { top: 30, right: 20, bottom: 40, left: 55 };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const l of lines) for (let i = 0; i < l.x.length; i++) {
    if (isFinite(l.x[i]) && isFinite(l.y[i])) {
      if (l.x[i] < xMin) xMin = l.x[i]; if (l.x[i] > xMax) xMax = l.x[i];
      if (l.y[i] < yMin) yMin = l.y[i]; if (l.y[i] > yMax) yMax = l.y[i];
    }
  }
  if (refLines) for (const r of refLines) { if (r.value < yMin) yMin = r.value; if (r.value > yMax) yMax = r.value; }
  if (xMin === xMax) { xMin -= 0.5; xMax += 0.5; }
  if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }
  const xP = (xMax - xMin) * 0.05 || 0.1, yP = (yMax - yMin) * 0.05 || 0.1;
  xMin -= xP; xMax += xP; yMin -= yP; yMax += yP;
  const sx = v => m.left + ((v - xMin) / (xMax - xMin)) * pw;
  const sy = v => m.top + (1 - (v - yMin) / (yMax - yMin)) * ph;
  function niceStep(r) { const mag = 10 ** Math.floor(Math.log10(r)); const n = r / mag; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag; }
  function ticks(lo, hi, cnt) { const st = niceStep((hi - lo) / cnt); const s = Math.ceil(lo / st) * st; const a = []; for (let v = s; v <= hi + st * 0.01; v += st) a.push(v); return a; }
  const fmt = v => Math.abs(v) >= 1e6 ? (v/1e6).toFixed(1)+'M' : Math.abs(v) >= 1e3 ? (v/1e3).toFixed(1)+'k' : Number(v.toPrecision(4)).toString();
  const xt = ticks(xMin, xMax, 6), yt = ticks(yMin, yMax, 5);
  const colors = ['#818cf8','#f87171','#34d399','#fb923c','#a78bfa','#22d3ee'];
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="Inter,system-ui,sans-serif">`;
  svg += `<rect width="${W}" height="${H}" fill="#16161c" rx="6"/>`;
  svg += `<text x="${W/2}" y="18" text-anchor="middle" font-size="13" font-weight="600" fill="#e2e2e8">${esc(title)}</text>`;
  svg += `<g stroke="#2a2a35" stroke-width="0.5">`;
  for (const v of xt) svg += `<line x1="${sx(v)}" y1="${m.top}" x2="${sx(v)}" y2="${m.top+ph}"/>`;
  for (const v of yt) svg += `<line x1="${m.left}" y1="${sy(v)}" x2="${m.left+pw}" y2="${sy(v)}"/>`;
  svg += `</g>`;
  for (const v of xt) svg += `<text x="${sx(v)}" y="${m.top+ph+14}" text-anchor="middle" font-size="10" fill="#8888a0">${fmt(v)}</text>`;
  for (const v of yt) svg += `<text x="${m.left-5}" y="${sy(v)+3}" text-anchor="end" font-size="10" fill="#8888a0">${fmt(v)}</text>`;
  svg += `<text x="${W/2}" y="${H-4}" text-anchor="middle" font-size="10" fill="#55556a">${esc(xLabel)}</text>`;
  svg += `<text x="12" y="${H/2}" text-anchor="middle" font-size="10" fill="#55556a" transform="rotate(-90,12,${H/2})">${esc(yLabel)}</text>`;
  if (refLines) for (const r of refLines) { const y = sy(r.value); if (y >= m.top && y <= m.top + ph) { svg += `<line x1="${m.left}" y1="${y}" x2="${m.left+pw}" y2="${y}" stroke="${r.color||'#55556a'}" stroke-width="1" stroke-dasharray="4,3"/>`; if (r.label) svg += `<text x="${m.left+pw-2}" y="${y-4}" text-anchor="end" font-size="9" fill="${r.color||'#55556a'}">${esc(r.label)}</text>`; } }
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li]; const c = l.color || colors[li % colors.length];
    let path = ''; let first = true;
    for (let i = 0; i < l.x.length; i++) { if (!isFinite(l.x[i]) || !isFinite(l.y[i])) continue; path += (first ? 'M' : 'L') + sx(l.x[i]).toFixed(1) + ',' + sy(l.y[i]).toFixed(1); first = false; }
    svg += `<path d="${path}" fill="none" stroke="${c}" stroke-width="1.5" ${l.dash ? `stroke-dasharray="${l.dash}"` : ''}/>`;
  }
  if (lines.length > 1) { let ly = m.top + 14; for (let li = 0; li < lines.length; li++) { const c = lines[li].color || colors[li % colors.length]; svg += `<line x1="${m.left+10}" y1="${ly}" x2="${m.left+26}" y2="${ly}" stroke="${c}" stroke-width="2" ${lines[li].dash?`stroke-dasharray="${lines[li].dash}"`:''}/>`; svg += `<text x="${m.left+30}" y="${ly+3}" font-size="10" fill="#8888a0">${esc(lines[li].label||'')}</text>`; ly += 14; } }
  svg += '</svg>';
  return svg;
}

function polarPlotSVG(thetaDeg, pattern, label, color, fillColor, peakDBi, title) {
  const W = 460, H = 460;
  const cx = W / 2, cy = H / 2 + 15;
  const R = Math.min(W / 2 - 40, H / 2 - 45);
  const dbMin = -30, dbMax = 0;
  const dbRange = dbMax - dbMin;
  function polarPath(theta, pat, cx_) {
    let path = '';
    for (let i = 0; i < theta.length; i++) {
      const dB = pat[i] - peakDBi;
      if (!isFinite(dB)) continue;
      const r = ((Math.max(dbMin, Math.min(dbMax, dB)) - dbMin) / dbRange) * R;
      const a = (theta[i] - 90) * Math.PI / 180;
      path += (path ? 'L' : 'M') + (cx_ + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1);
    }
    return path + 'Z';
  }
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="Inter,system-ui,sans-serif">`;
  svg += `<rect width="${W}" height="${H}" fill="#16161c" rx="6"/>`;
  svg += `<text x="${W/2}" y="18" text-anchor="middle" font-size="13" font-weight="600" fill="#e2e2e8">${esc(title)}</text>`;
  // Grid circles
  for (let db = dbMin; db <= dbMax; db += 10) {
    const r = ((db - dbMin) / dbRange) * R;
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#2a2a35" stroke-width="0.5"/>`;
    svg += `<text x="${cx+3}" y="${cy - r + 12}" font-size="9" fill="#55556a">${db}</text>`;
  }
  // Angle labels
  for (let a = 0; a < 360; a += 45) {
    const ar = (a - 90) * Math.PI / 180;
    const x2 = cx + R * Math.cos(ar), y2 = cy + R * Math.sin(ar);
    svg += `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#2a2a35" stroke-width="0.5"/>`;
    svg += `<text x="${cx + (R+15)*Math.cos(ar)}" y="${cy + (R+15)*Math.sin(ar)+4}" text-anchor="middle" font-size="10" fill="#55556a">${a}\u00b0</text>`;
  }
  // Pattern
  const path = polarPath(thetaDeg, pattern, cx);
  svg += `<path d="${path}" fill="${fillColor}" fill-opacity="0.3" stroke="${color}" stroke-width="1.5"/>`;
  svg += `<text x="${W/2}" y="${H-8}" text-anchor="middle" font-size="11" fill="#8888a0">${esc(label)}</text>`;
  svg += `<text x="${W-10}" y="18" text-anchor="end" font-size="10" fill="#55556a">Peak: ${peakDBi.toFixed(1)} dBi</text>`;
  svg += '</svg>';
  return svg;
}

// ─── Main ────────────────────────────────────────────────────────────────────
console.log('=== Generating UWB Comb Dipole XML ===');
const { xml, faces, nf2ffFreq, f0, fc } = generateUWBXML();
const xmlPath = join(SIM_DIR, 'sim.xml');
writeFileSync(xmlPath, xml);
console.log(`XML written (NF2FF freq: ${(nf2ffFreq/1e9).toFixed(1)} GHz)`);

// Run native openEMS
console.log('\n=== Running native openEMS (SSE) ===');
const openEMS = join(ROOT, 'build-native', 'openEMS');
try {
  const result = execSync(`"${openEMS}" "${xmlPath}" --engine=sse`, {
    cwd: SIM_DIR, timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = result.toString();
  const speed = stdout.match(/Speed:\s+([\d.]+)\s+MCells/);
  const ts = stdout.match(/Time for (\d+) timesteps/);
  console.log(`Done: ${ts?.[1]} timesteps, ${speed?.[1]} MCells/s`);
} catch (err) {
  console.error('openEMS error:', err.stdout?.toString().slice(-500));
  process.exit(1);
}

// Run native nf2ff
console.log('\n=== Running native NF2FF ===');
const thetaVals = [];
for (let t = -180; t <= 180; t += 2) thetaVals.push((t * Math.PI / 180).toFixed(8));
const phiVals = [0, (Math.PI / 2).toFixed(8)];

const nf2ffXml = `<?xml version="1.0" encoding="UTF-8"?>
<nf2ff freq="${nf2ffFreq}" Outfile="${join(SIM_DIR, 'nf2ff_result.h5')}" Verbose="0">
  <theta>${thetaVals.join(',')}</theta>
  <phi>${phiVals.join(',')}</phi>
${faces.map(f => `  <Planes E_Field="${join(SIM_DIR, `nf2ff_E_${f.name}.h5`)}" H_Field="${join(SIM_DIR, `nf2ff_H_${f.name}.h5`)}"/>`).join('\n')}
</nf2ff>`;
writeFileSync(join(SIM_DIR, 'nf2ff.xml'), nf2ffXml);

const nf2ffBin = join(ROOT, 'build-native', 'nf2ff', 'nf2ff');
try {
  execSync(`HDF5_DISABLE_VERSION_CHECK=2 "${nf2ffBin}" "${join(SIM_DIR, 'nf2ff.xml')}"`, {
    cwd: SIM_DIR, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log('NF2FF completed');
} catch (err) {
  console.error('nf2ff error:', err.stderr?.toString().slice(-300));
}

// ─── S11 + Impedance from probe data ─────────────────────────────────────────
console.log('\n=== Computing S11 and impedance ===');
const ut = loadProbe(join(SIM_DIR, 'port_ut1'));
const it = loadProbe(join(SIM_DIR, 'port_it1'));

const fmax = f0 + fc;
const nf = 401;
const freq = new Float64Array(nf);
for (let i = 0; i < nf; i++) freq[i] = (i / (nf - 1)) * fmax;

const Uf = dft(ut.time, ut.values, freq);
const If = dft(it.time, it.values, freq);

const Z0 = 50;
const s11_dB = new Float64Array(nf);
const z_re = new Float64Array(nf);
const z_im = new Float64Array(nf);

for (let i = 0; i < nf; i++) {
  const denom = If.re[i] ** 2 + If.im[i] ** 2;
  if (denom < 1e-30) continue;
  const zr = (Uf.re[i] * If.re[i] + Uf.im[i] * If.im[i]) / denom;
  const zi = (Uf.im[i] * If.re[i] - Uf.re[i] * If.im[i]) / denom;
  z_re[i] = zr; z_im[i] = zi;
  const gr = ((zr - Z0) * (zr + Z0) + zi * zi) / ((zr + Z0) ** 2 + zi ** 2);
  const gi = (zi * (zr + Z0) - (zr - Z0) * zi) / ((zr + Z0) ** 2 + zi ** 2);
  s11_dB[i] = 20 * Math.log10(Math.max(Math.sqrt(gr * gr + gi * gi), 1e-15));
}

const fGHz = Array.from(freq).map(f => f / 1e9);

// Find resonances (S11 < -10 dB)
let bestS11 = 0, bestFreq = 0;
for (let i = 1; i < nf; i++) {
  if (s11_dB[i] < bestS11) { bestS11 = s11_dB[i]; bestFreq = fGHz[i]; }
}
console.log(`Best match: ${bestFreq.toFixed(2)} GHz, S11 = ${bestS11.toFixed(1)} dB`);
console.log(`Z @ 5.8 GHz: ${z_re[Math.round(5.8e9/fmax*(nf-1))].toFixed(1)} + j${z_im[Math.round(5.8e9/fmax*(nf-1))].toFixed(1)} Ohm`);

// ─── Generate S11 SVG ────────────────────────────────────────────────────────
console.log('\n=== Generating plots ===');

writeFileSync(join(PLOTS, 's11.svg'), linePlotSVG({
  title: 'UWB Comb Dipole — S11 (Return Loss)',
  xLabel: 'Frequency (GHz)', yLabel: 'S11 (dB)',
  lines: [{ x: fGHz, y: Array.from(s11_dB), label: 'S11', color: '#818cf8' }],
  refLines: [{ value: -10, label: '-10 dB', color: '#f87171' }],
}));
console.log('  s11.svg');

writeFileSync(join(PLOTS, 'impedance.svg'), linePlotSVG({
  title: 'UWB Comb Dipole — Input Impedance',
  xLabel: 'Frequency (GHz)', yLabel: 'Z (Ohm)',
  lines: [
    { x: fGHz, y: Array.from(z_re), label: 'Re(Z)', color: '#818cf8' },
    { x: fGHz, y: Array.from(z_im), label: 'Im(Z)', color: '#f87171' },
  ],
  refLines: [{ value: 50, label: '50\u2126', color: '#55556a' }],
}));
console.log('  impedance.svg');

// ─── Radiation pattern from NF2FF result ─────────────────────────────────────
const nf2ffResultPath = join(SIM_DIR, 'nf2ff_result.h5');
if (existsSync(nf2ffResultPath)) {
  // Use python to extract NF2FF data from HDF5
  const pyScript = `
import h5py, json, math
f = h5py.File("${nf2ffResultPath}", "r")
nf2ff = f["nf2ff"]
Dmax = float(nf2ff.attrs["Dmax"][0]) if "Dmax" in nf2ff.attrs else 0
Prad = float(nf2ff.attrs["Prad"][0]) if "Prad" in nf2ff.attrs else 0
freq = float(nf2ff.attrs["Frequency"][0]) if "Frequency" in nf2ff.attrs else 0

theta = [float(x) for x in f["Mesh"]["theta"][:]]
phi = [float(x) for x in f["Mesh"]["phi"][:]]

Et_re = f["nf2ff/E_theta/FD/f0_real"][:].tolist()
Et_im = f["nf2ff/E_theta/FD/f0_imag"][:].tolist()
Ep_re = f["nf2ff/E_phi/FD/f0_real"][:].tolist()
Ep_im = f["nf2ff/E_phi/FD/f0_imag"][:].tolist()

# Compute E_norm for each (phi, theta) and directivity
import numpy as np
Et_re = np.array(Et_re)
Et_im = np.array(Et_im)
Ep_re = np.array(Ep_re)
Ep_im = np.array(Ep_im)
E_norm = np.sqrt(Et_re**2 + Et_im**2 + Ep_re**2 + Ep_im**2)

DmaxdBi = 10*math.log10(max(Dmax, 1e-30))
maxE = E_norm.max()

# Extract 2 cuts: phi=0 (E-plane, index 0) and phi=90 (H-plane, index 1)
Eplane = E_norm[0, :]  # phi=0
Hplane = E_norm[1, :]  # phi=90

Eplane_dBi = [20*math.log10(max(v/maxE, 1e-15)) + DmaxdBi if maxE > 0 else -30 for v in Eplane]
Hplane_dBi = [20*math.log10(max(v/maxE, 1e-15)) + DmaxdBi if maxE > 0 else -30 for v in Hplane]

result = {
  "Dmax": Dmax, "DmaxdBi": DmaxdBi, "Prad": Prad, "freq": freq,
  "theta_deg": [t * 180 / math.pi for t in theta],
  "Eplane_dBi": Eplane_dBi,
  "Hplane_dBi": Hplane_dBi,
}
print(json.dumps(result))
f.close()
`;
  writeFileSync(join(SIM_DIR, '_extract_nf2ff.py'), pyScript);
  try {
    const jsonStr = execSync(`python3 "${join(SIM_DIR, '_extract_nf2ff.py')}"`, { timeout: 30000 }).toString().trim();
    const rad = JSON.parse(jsonStr);
    console.log(`Dmax = ${rad.DmaxdBi.toFixed(1)} dBi, Prad = ${rad.Prad.toExponential(2)} W`);

    // Generate polar plots
    writeFileSync(join(PLOTS, 'radiation_eplane.svg'), polarPlotSVG(
      rad.theta_deg, rad.Eplane_dBi, 'E-plane (\u03c6=0\u00b0)', '#818cf8', '#818cf8', rad.DmaxdBi,
      `UWB Comb Dipole \u2014 E-plane @ ${(rad.freq/1e9).toFixed(1)} GHz`
    ));
    console.log('  radiation_eplane.svg');

    writeFileSync(join(PLOTS, 'radiation_hplane.svg'), polarPlotSVG(
      rad.theta_deg, rad.Hplane_dBi, 'H-plane (\u03c6=90\u00b0)', '#f87171', '#f87171', rad.DmaxdBi,
      `UWB Comb Dipole \u2014 H-plane @ ${(rad.freq/1e9).toFixed(1)} GHz`
    ));
    console.log('  radiation_hplane.svg');
  } catch (err) {
    console.error('NF2FF extraction error:', err.message);
  }
} else {
  console.log('No nf2ff_result.h5 — skipping radiation plots');
}

// Convert SVGs to PNGs if rsvg-convert is available
try {
  for (const name of ['s11', 'impedance', 'radiation_eplane', 'radiation_hplane']) {
    const svgPath = join(PLOTS, `${name}.svg`);
    const pngPath = join(PLOTS, `${name}.png`);
    if (existsSync(svgPath)) {
      execSync(`rsvg-convert -o "${pngPath}" "${svgPath}"`, { timeout: 10000 });
    }
  }
  console.log('\nPNG conversion complete');
} catch (err) {
  console.log('\nrsvg-convert not available — SVG files only');
}

console.log(`\nPlots saved to: ${PLOTS}`);
