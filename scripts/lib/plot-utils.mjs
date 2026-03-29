/**
 * SVG plot generation utilities for Node.js.
 * Extracted from app/index.html plotSVG and radiation pattern rendering.
 */

import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function niceStep(rough) {
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

function ticks(lo, hi, count) {
  const step = niceStep((hi - lo) / count);
  const start = Math.ceil(lo / step) * step;
  const arr = [];
  for (let v = start; v <= hi + step * 0.01; v += step) arr.push(v);
  return arr;
}

function fmtNum(v) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  if (Math.abs(v) < 0.01 && v !== 0) return v.toExponential(1);
  return Number(v.toPrecision(4)).toString();
}

/**
 * Generate an SVG line chart.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.xLabel
 * @param {string} opts.yLabel
 * @param {Array<{x: number[], y: number[], label?: string, color?: string}>} opts.lines
 * @param {Array<{value: number, label?: string, color?: string}>} [opts.refLines]
 * @param {Array<{x: number, y: number, label?: string, color?: string, labelBelow?: boolean}>} [opts.markers]
 * @param {string} [opts.annotation]
 * @returns {string} SVG string
 */
export function plotSVG({ title, xLabel, yLabel, lines, refLines, markers, annotation }) {
  const W = 520, H = 320;
  const margin = { top: 30, right: 20, bottom: 40, left: 55 };
  const pw = W - margin.left - margin.right;
  const ph = H - margin.top - margin.bottom;

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.x.length; i++) {
      const xv = line.x[i], yv = line.y[i];
      if (!isFinite(xv) || !isFinite(yv)) continue;
      if (xv < xMin) xMin = xv;
      if (xv > xMax) xMax = xv;
      if (yv < yMin) yMin = yv;
      if (yv > yMax) yMax = yv;
    }
  }

  if (!isFinite(xMin)) { xMin = 0; xMax = 1; }
  if (!isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (refLines) {
    for (const ref of refLines) {
      if (ref.value < yMin) yMin = ref.value;
      if (ref.value > yMax) yMax = ref.value;
    }
  }
  if (xMin === xMax) { xMin -= 0.5; xMax += 0.5; }
  if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }

  const xPad = (xMax - xMin) * 0.05 || 0.1;
  const yPad = (yMax - yMin) * 0.05 || 0.1;
  xMin -= xPad; xMax += xPad;
  yMin -= yPad; yMax += yPad;

  const sx = (v) => margin.left + ((v - xMin) / (xMax - xMin)) * pw;
  const sy = (v) => margin.top + (1 - (v - yMin) / (yMax - yMin)) * ph;

  const xticks = ticks(xMin, xMax, 6);
  const yticks = ticks(yMin, yMax, 5);

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="'Inter',system-ui,sans-serif">`;
  svg += `<rect width="${W}" height="${H}" fill="#16161c" rx="6"/>`;

  svg += `<text x="${W / 2}" y="18" text-anchor="middle" font-size="12" font-weight="600" fill="#e2e2e8">${esc(title)}</text>`;

  svg += `<g stroke="#2a2a35" stroke-width="0.5">`;
  for (const v of xticks) svg += `<line x1="${sx(v)}" y1="${margin.top}" x2="${sx(v)}" y2="${margin.top + ph}"/>`;
  for (const v of yticks) svg += `<line x1="${margin.left}" y1="${sy(v)}" x2="${margin.left + pw}" y2="${sy(v)}"/>`;
  svg += `</g>`;

  svg += `<line x1="${margin.left}" y1="${margin.top + ph}" x2="${margin.left + pw}" y2="${margin.top + ph}" stroke="#3a3a48" stroke-width="1"/>`;
  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + ph}" stroke="#3a3a48" stroke-width="1"/>`;

  for (const v of xticks) {
    svg += `<text x="${sx(v)}" y="${margin.top + ph + 14}" text-anchor="middle" font-size="10" fill="#8888a0">${fmtNum(v)}</text>`;
  }
  for (const v of yticks) {
    svg += `<text x="${margin.left - 5}" y="${sy(v) + 3}" text-anchor="end" font-size="10" fill="#8888a0">${fmtNum(v)}</text>`;
  }

  svg += `<text x="${W / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#55556a">${esc(xLabel)}</text>`;
  svg += `<text x="12" y="${H / 2}" text-anchor="middle" font-size="10" fill="#55556a" transform="rotate(-90,12,${H / 2})">${esc(yLabel)}</text>`;

  if (refLines) {
    for (const ref of refLines) {
      const y = sy(ref.value);
      if (y >= margin.top && y <= margin.top + ph) {
        svg += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + pw}" y2="${y}" stroke="${ref.color || '#55556a'}" stroke-width="1" stroke-dasharray="4,3"/>`;
        if (ref.label) svg += `<text x="${margin.left + pw - 2}" y="${y - 4}" text-anchor="end" font-size="9" fill="${ref.color || '#55556a'}">${esc(ref.label)}</text>`;
      }
    }
  }

  const colors = ['#818cf8', '#f87171', '#34d399', '#fb923c', '#a78bfa', '#22d3ee'];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const color = line.color || colors[li % colors.length];
    let path = '';
    let first = true;
    for (let i = 0; i < line.x.length; i++) {
      if (!isFinite(line.x[i]) || !isFinite(line.y[i])) continue;
      const px = sx(line.x[i]);
      const py = sy(line.y[i]);
      path += first ? `M${px.toFixed(1)},${py.toFixed(1)}` : `L${px.toFixed(1)},${py.toFixed(1)}`;
      first = false;
    }
    svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
  }

  if (lines.length > 1) {
    const lx = margin.left + 10;
    let ly = margin.top + 14;
    for (let li = 0; li < lines.length; li++) {
      const color = lines[li].color || colors[li % colors.length];
      svg += `<line x1="${lx}" y1="${ly}" x2="${lx + 16}" y2="${ly}" stroke="${color}" stroke-width="2"/>`;
      svg += `<text x="${lx + 20}" y="${ly + 3}" font-size="10" fill="#8888a0">${esc(lines[li].label || `trace ${li + 1}`)}</text>`;
      ly += 14;
    }
  }

  if (markers) {
    for (const m of markers) {
      const px = sx(m.x), py = sy(m.y);
      if (px >= margin.left && px <= margin.left + pw && py >= margin.top && py <= margin.top + ph) {
        svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" fill="${m.color || '#34d399'}"/>`;
        svg += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${px.toFixed(1)}" y2="${(margin.top + ph).toFixed(1)}" stroke="${m.color || '#34d399'}" stroke-width="0.7" stroke-dasharray="2,2"/>`;
        const labelY = m.labelBelow ? py + 13 : py - 6;
        svg += `<text x="${(px + 4).toFixed(1)}" y="${labelY.toFixed(1)}" font-size="9" fill="${m.color || '#34d399'}">${esc(m.label)}</text>`;
      }
    }
  }

  if (annotation) {
    svg += `<text x="${W - 8}" y="18" text-anchor="end" font-size="10" fill="#8888a0">${esc(annotation)}</text>`;
  }

  svg += '</svg>';
  return svg;
}

/**
 * Generate a polar radiation pattern SVG.
 * @param {object} opts
 * @param {number[]} opts.thetaDeg - theta values in degrees
 * @param {number[]} opts.xzPattern - E-plane pattern in dBi
 * @param {number[]} opts.yzPattern - H-plane pattern in dBi
 * @param {number} opts.peak - peak directivity in dBi
 * @returns {string} SVG string
 */
export function polarPlotSVG({ thetaDeg, xzPattern, yzPattern, peak }) {
  const W = 520, H = 320;
  const cx1 = W * 0.25 + 10, cx2 = W * 0.75 - 10, cy = H / 2 + 10;
  const R = Math.min(W / 4 - 20, H / 2 - 30);
  const dbMin = -30, dbMax = 0;
  const dbRange = dbMax - dbMin;

  function polarPath(theta, patternDBi, cx_) {
    let path = '';
    for (let i = 0; i < theta.length; i++) {
      const dB = patternDBi[i] - peak;
      if (!isFinite(dB)) continue;
      const clamped = Math.max(dbMin, Math.min(dbMax, dB));
      const r = ((clamped - dbMin) / dbRange) * R;
      const angle = (theta[i] - 90) * Math.PI / 180;
      const x = cx_ + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      path += path ? `L${x.toFixed(1)},${y.toFixed(1)}` : `M${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return path + 'Z';
  }

  function polarGrid(cx_) {
    let g = '';
    const rings = [0, -10, -20, -30];
    for (const db of rings) {
      const r = ((db - dbMin) / dbRange) * R;
      g += `<circle cx="${cx_}" cy="${cy}" r="${r}" fill="none" stroke="#2a2a35" stroke-width="0.5"/>`;
      if (db > dbMin) {
        g += `<text x="${cx_ + 3}" y="${cy - r + 10}" font-size="8" fill="#55556a">${db}</text>`;
      }
    }
    for (let a = 0; a < 360; a += 45) {
      const rad = (a - 90) * Math.PI / 180;
      const x2 = cx_ + R * Math.cos(rad);
      const y2 = cy + R * Math.sin(rad);
      g += `<line x1="${cx_}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#2a2a35" stroke-width="0.5"/>`;
      const lx = cx_ + (R + 10) * Math.cos(rad);
      const ly = cy + (R + 10) * Math.sin(rad);
      g += `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="middle" font-size="8" fill="#55556a">${a}\u00b0</text>`;
    }
    return g;
  }

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="'Inter',system-ui,sans-serif">`;
  svg += `<rect width="${W}" height="${H}" fill="#16161c" rx="6"/>`;
  svg += `<text x="${W / 2}" y="16" text-anchor="middle" font-size="12" font-weight="600" fill="#e2e2e8">Radiation Pattern</text>`;

  svg += polarGrid(cx1);
  svg += `<path d="${polarPath(thetaDeg, xzPattern, cx1)}" fill="rgba(129,140,248,0.1)" stroke="#818cf8" stroke-width="1.5"/>`;
  svg += `<text x="${cx1}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#818cf8">E-plane (\u03c6=0\u00b0)</text>`;

  svg += polarGrid(cx2);
  svg += `<path d="${polarPath(thetaDeg, yzPattern, cx2)}" fill="rgba(248,113,113,0.1)" stroke="#f87171" stroke-width="1.5"/>`;
  svg += `<text x="${cx2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#f87171">H-plane (\u03c6=90\u00b0)</text>`;

  svg += `<text x="${W - 8}" y="16" text-anchor="end" font-size="9" fill="#55556a">Peak: ${peak.toFixed(1)} dBi</text>`;

  svg += '</svg>';
  return svg;
}

/**
 * Save SVG to PNG using rsvg-convert. Falls back to SVG-only if not installed.
 * @param {string} svgStr - SVG string
 * @param {number} width - output width in pixels
 * @param {number} height - output height in pixels
 * @param {string} outputPath - output PNG file path
 * @returns {boolean} true if PNG was created
 */
export function saveSVGtoPNG(svgStr, width, height, outputPath) {
  try {
    execSync('which rsvg-convert', { stdio: 'ignore' });
    const svgPath = outputPath.replace(/\.png$/, '.svg');
    writeFileSync(svgPath, svgStr);
    execSync(`rsvg-convert -w ${width} -h ${height} "${svgPath}" -o "${outputPath}"`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Save SVG string to file.
 * @param {string} svgStr
 * @param {string} outputPath
 */
export function saveSVG(svgStr, outputPath) {
  writeFileSync(outputPath, svgStr);
}
