/**
 * Physical constants and analysis utilities for openEMS.
 * Mirrors openEMS/python/openEMS/physical_constants.py and utilities.py
 */

/** Speed of light [m/s] */
export const C0 = 299792458;

/** Permeability of free space [H/m] */
export const MUE0 = 4e-7 * Math.PI;

/** Permittivity of free space [F/m] */
export const EPS0 = 1 / (MUE0 * C0 * C0);

/** Free space impedance [Ohm] (~376.73) */
export const Z0 = Math.sqrt(MUE0 / EPS0);

/**
 * Create a linearly spaced array.
 * @param {number} start
 * @param {number} stop
 * @param {number} n
 * @returns {Float64Array}
 */
export function linspace(start, stop, n) {
  const arr = new Float64Array(n);
  if (n === 1) { arr[0] = start; return arr; }
  const step = (stop - start) / (n - 1);
  for (let i = 0; i < n; i++) arr[i] = start + i * step;
  return arr;
}

/**
 * Discrete Fourier Transform: time domain to frequency domain (complex).
 * Mirrors openEMS utilities.DFT_time2freq.
 *
 * @param {Float64Array} time - time samples
 * @param {Float64Array} values - signal values
 * @param {Float64Array|number[]} freq - target frequencies [Hz]
 * @param {string} [signalType='pulse'] - 'pulse' or 'periodic'
 * @returns {{ re: Float64Array, im: Float64Array }}
 */
export function dftTime2Freq(time, values, freq, signalType = 'pulse') {
  const N = time.length;
  const nf = freq.length;
  const re = new Float64Array(nf);
  const im = new Float64Array(nf);

  for (let k = 0; k < nf; k++) {
    let sumRe = 0, sumIm = 0;
    const omega = 2 * Math.PI * freq[k];
    for (let n = 0; n < N; n++) {
      const dt = n > 0 ? time[n] - time[n - 1] : (N > 1 ? time[1] - time[0] : 1);
      const w = signalType === 'periodic' ? 1.0 : dt;
      sumRe += values[n] * Math.cos(omega * time[n]) * w;
      sumIm -= values[n] * Math.sin(omega * time[n]) * w;
    }
    re[k] = sumRe;
    im[k] = sumIm;
  }
  return { re, im };
}

/**
 * DFT magnitude spectrum.
 * @param {Float64Array} time
 * @param {Float64Array} values
 * @param {Float64Array|number[]} freq
 * @returns {Float64Array}
 */
export function dftMagnitude(time, values, freq) {
  const { re, im } = dftTime2Freq(time, values, freq);
  return complexAbs(re, im);
}

/**
 * Complex division: (a / b) element-wise.
 * @param {Float64Array} aRe
 * @param {Float64Array} aIm
 * @param {Float64Array} bRe
 * @param {Float64Array} bIm
 * @returns {{ re: Float64Array, im: Float64Array }}
 */
export function complexDivide(aRe, aIm, bRe, bIm) {
  const n = aRe.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const denom = bRe[i] * bRe[i] + bIm[i] * bIm[i];
    if (denom === 0) { re[i] = NaN; im[i] = NaN; }
    else {
      re[i] = (aRe[i] * bRe[i] + aIm[i] * bIm[i]) / denom;
      im[i] = (aIm[i] * bRe[i] - aRe[i] * bIm[i]) / denom;
    }
  }
  return { re, im };
}

/**
 * Complex multiplication: (a * b) element-wise.
 * @param {Float64Array} aRe
 * @param {Float64Array} aIm
 * @param {Float64Array} bRe
 * @param {Float64Array} bIm
 * @returns {{ re: Float64Array, im: Float64Array }}
 */
export function complexMultiply(aRe, aIm, bRe, bIm) {
  const n = aRe.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = aRe[i] * bRe[i] - aIm[i] * bIm[i];
    im[i] = aRe[i] * bIm[i] + aIm[i] * bRe[i];
  }
  return { re, im };
}

/**
 * Complex conjugate element-wise.
 * @param {Float64Array} re
 * @param {Float64Array} im
 * @returns {{ re: Float64Array, im: Float64Array }}
 */
export function complexConj(re, im) {
  const conjIm = new Float64Array(im.length);
  for (let i = 0; i < im.length; i++) conjIm[i] = -im[i];
  return { re: new Float64Array(re), im: conjIm };
}

/**
 * Complex absolute value (magnitude) element-wise.
 * @param {Float64Array} re
 * @param {Float64Array} im
 * @returns {Float64Array}
 */
export function complexAbs(re, im) {
  const mag = new Float64Array(re.length);
  for (let i = 0; i < re.length; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mag;
}

/**
 * Parse openEMS probe output file text.
 * Lines starting with '%' are comments. Each data line has: time value
 * @param {string} text
 * @returns {{ time: Float64Array, values: Float64Array }}
 */
export function parseProbe(text) {
  const lines = text.split('\n').filter(l => !l.startsWith('%') && l.trim());
  const time = new Float64Array(lines.length);
  const values = new Float64Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    time[i] = parseFloat(parts[0]);
    values[i] = parseFloat(parts[1]);
  }
  return { time, values };
}

/**
 * Find peaks in a spectrum above a threshold.
 * @param {Float64Array} freqs
 * @param {Float64Array} spectrum
 * @param {number} threshold
 * @returns {Array<{freq: number, amplitude: number}>}
 */
export function findPeaks(freqs, spectrum, threshold) {
  const peaks = [];
  for (let i = 1; i < spectrum.length - 1; i++) {
    if (spectrum[i] > spectrum[i - 1] && spectrum[i] > spectrum[i + 1] && spectrum[i] > threshold) {
      peaks.push({ freq: freqs[i], amplitude: spectrum[i] });
    }
  }
  return peaks.sort((a, b) => b.amplitude - a.amplitude);
}

/**
 * Compute S-parameters from port voltage/current data.
 *
 * S_ij = uf_ref_i / uf_inc_j  (when only port j is excited)
 *
 * @param {import('./ports.mjs').Port} port - a port with calcPort() already called
 * @param {Float64Array} freq
 * @returns {{ s11_re: Float64Array, s11_im: Float64Array, s11_dB: Float64Array }}
 */
export function calcSParam(port, freq) {
  // S11 = uf_ref / uf_inc
  const { re, im } = complexDivide(port.uf_ref_re, port.uf_ref_im, port.uf_inc_re, port.uf_inc_im);
  const mag = complexAbs(re, im);
  const dB = new Float64Array(mag.length);
  for (let i = 0; i < mag.length; i++) {
    dB[i] = 20 * Math.log10(Math.max(mag[i], 1e-15));
  }
  return { s11_re: re, s11_im: im, s11_dB: dB };
}
