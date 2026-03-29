/**
 * Post-processing utilities for simulation results.
 * Computes S11, impedance, and extracts radiation data.
 */

/**
 * Parse probe data text files into time/values arrays.
 * @param {Object<string, string>} probeData - { filename: text }
 * @returns {Object<string, { time: Float64Array, values: Float64Array }>}
 */
export function parseProbeData(probeData) {
  const parsed = {};
  for (const [name, text] of Object.entries(probeData)) {
    const lines = text.split('\n').filter(l => !l.startsWith('%') && l.trim());
    const time = new Float64Array(lines.length);
    const values = new Float64Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      time[i] = parseFloat(parts[0]);
      values[i] = parseFloat(parts[1]);
    }
    parsed[name] = { time, values };
  }
  return parsed;
}

/**
 * Discrete Fourier Transform of time-domain data.
 * @param {Float64Array} time
 * @param {Float64Array} values
 * @param {Float64Array} freqs - frequency points to evaluate
 * @returns {{ re: Float64Array, im: Float64Array }}
 */
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
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}

/**
 * Compute S11, impedance from parsed probe data.
 * @param {Object} parsedProbes - parsed probe data (from parseProbeData)
 * @param {number} fMax - maximum frequency in Hz (0 = auto from Nyquist)
 * @param {number} nf - number of frequency points
 * @returns {{ freqGHz: number[], s11_dB: number[], zRe: number[], zIm: number[], bestS11: number, bestFreqGHz: number }|null}
 */
export function computeS11(parsedProbes, fMax = 0, nf = 201) {
  const utKeys = Object.keys(parsedProbes).filter(k => k.includes('_ut'));
  const itKeys = Object.keys(parsedProbes).filter(k => k.includes('_it'));

  if (utKeys.length === 0 || itKeys.length === 0) return null;

  const ut = parsedProbes[utKeys[0]];
  const it = parsedProbes[itKeys[0]];
  if (!ut || !it || ut.time.length < 10) return null;

  const N = Math.min(ut.time.length, it.time.length);
  const dt = ut.time[1] - ut.time[0];
  const fmax = fMax > 0 ? fMax : 0.5 / dt;
  const freq = new Float64Array(nf);
  for (let i = 0; i < nf; i++) freq[i] = (i / (nf - 1)) * fmax;

  const Uf = dft(ut.time, ut.values, freq);
  const If = dft(it.time, it.values, freq);

  const Z0 = 50;
  const s11_dB = new Float64Array(nf);
  const z_re = new Float64Array(nf);
  const z_im = new Float64Array(nf);

  for (let i = 0; i < nf; i++) {
    const denom = If.re[i] * If.re[i] + If.im[i] * If.im[i];
    if (denom < 1e-30) { s11_dB[i] = 0; z_re[i] = 0; z_im[i] = 0; continue; }
    const zr = (Uf.re[i] * If.re[i] + Uf.im[i] * If.im[i]) / denom;
    const zi = (Uf.im[i] * If.re[i] - Uf.re[i] * If.im[i]) / denom;
    z_re[i] = zr;
    z_im[i] = zi;

    const gnr = zr - Z0;
    const gni = zi;
    const gdr = zr + Z0;
    const gdi = zi;
    const gd2 = gdr * gdr + gdi * gdi;
    const gr = (gnr * gdr + gni * gdi) / gd2;
    const gi = (gni * gdr - gnr * gdi) / gd2;
    const mag = Math.sqrt(gr * gr + gi * gi);
    s11_dB[i] = 20 * Math.log10(Math.max(mag, 1e-15));
  }

  const freqGHz = Array.from(freq).map(f => f / 1e9);
  const s11Arr = Array.from(s11_dB);
  const zReArr = Array.from(z_re);
  const zImArr = Array.from(z_im);

  // Find best S11 match (deepest dip, skip DC)
  let bestIdx = 1, bestS11 = 0;
  for (let i = 1; i < nf; i++) {
    if (s11Arr[i] < bestS11) { bestS11 = s11Arr[i]; bestIdx = i; }
  }

  // Find frequency where Z is closest to 50+j0
  let bestZIdx = 1, bestZDist = Infinity;
  for (let i = 1; i < freqGHz.length; i++) {
    const d = Math.sqrt((zReArr[i] - 50) ** 2 + zImArr[i] ** 2);
    if (d < bestZDist && isFinite(d)) { bestZDist = d; bestZIdx = i; }
  }

  return {
    freqGHz, s11_dB: s11Arr, zRe: zReArr, zIm: zImArr,
    bestS11, bestFreqGHz: freqGHz[bestIdx],
    bestZFreqGHz: freqGHz[bestZIdx], bestZRe: zReArr[bestZIdx], bestZIm: zImArr[bestZIdx],
  };
}

/**
 * Extract radiation data from nf2ffData.
 * @param {object} nf2ffData - from sim-engine
 * @returns {{ thetaDeg: number[], xzPattern: number[], yzPattern: number[], DmaxdBi: number, freqGHz: number }}
 */
export function extractRadiationData(nf2ffData) {
  if (!nf2ffData) return null;
  return {
    thetaDeg: nf2ffData.thetaDeg,
    xzPattern: nf2ffData.xzPattern,
    yzPattern: nf2ffData.yzPattern,
    DmaxdBi: nf2ffData.DmaxdBi,
    freqGHz: nf2ffData.freqHz / 1e9,
  };
}
