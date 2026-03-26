/**
 * Visualization data preparation functions for openEMS.
 * Pure data transforms — no DOM, no canvas, no Three.js.
 * These prepare data structures for any plotting library.
 */

import { complexDivide, complexAbs } from './analysis.mjs';

/**
 * Prepare S-parameter data for plotting.
 *
 * @param {Array} ports - array of port objects with uf_inc_re/im and uf_ref_re/im
 * @param {Float64Array|number[]} freq - frequency array [Hz]
 * @returns {Object} { freq, ...sNN_dB } e.g. { freq, s11_dB, s21_dB }
 */
export function prepareSParamData(ports, freq) {
  const result = { freq: Float64Array.from(freq) };

  for (let i = 0; i < ports.length; i++) {
    for (let j = 0; j < ports.length; j++) {
      const refPort = ports[i];
      const incPort = ports[j];

      if (!refPort.uf_ref_re || !incPort.uf_inc_re) continue;

      const { re, im } = complexDivide(
        refPort.uf_ref_re, refPort.uf_ref_im,
        incPort.uf_inc_re, incPort.uf_inc_im
      );
      const mag = complexAbs(re, im);
      const dB = new Float64Array(mag.length);
      for (let k = 0; k < mag.length; k++) {
        dB[k] = 20 * Math.log10(Math.max(mag[k], 1e-15));
      }
      result[`s${i + 1}${j + 1}_dB`] = dB;
    }
  }

  return result;
}

/**
 * Prepare Smith chart data from a port's reflection coefficient.
 *
 * @param {Object} port - port with uf_ref_re/im and uf_inc_re/im
 * @param {Float64Array|number[]} freq - frequency array [Hz]
 * @returns {{ gamma_re: Float64Array, gamma_im: Float64Array, freq: Float64Array }}
 */
export function prepareSmithData(port, freq) {
  const { re, im } = complexDivide(
    port.uf_ref_re, port.uf_ref_im,
    port.uf_inc_re, port.uf_inc_im
  );
  return {
    gamma_re: re,
    gamma_im: im,
    freq: Float64Array.from(freq),
  };
}

/**
 * Prepare radiation pattern data from NF2FF result for a specific cut plane.
 *
 * @param {Object} nf2ffResult - NF2FF result with theta, phi, E_norm arrays
 * @param {'phi'|'theta'} cutPlane - which angle to hold constant
 * @param {number} cutAngle - value of the constant angle in radians
 * @param {number} [freqIdx=0] - frequency index
 * @returns {{ angles: Float64Array, pattern_dB: Float64Array }}
 */
export function prepareRadiationPattern(nf2ffResult, cutPlane, cutAngle, freqIdx = 0) {
  const theta = nf2ffResult.theta;
  const phi = nf2ffResult.phi;
  const nTheta = theta.length;
  const nPhi = phi.length;
  const E_norm = nf2ffResult.E_norm[freqIdx];

  if (cutPlane === 'phi') {
    // Find closest phi index
    let phiIdx = 0;
    let minDist = Math.abs(phi[0] - cutAngle);
    for (let i = 1; i < nPhi; i++) {
      const d = Math.abs(phi[i] - cutAngle);
      if (d < minDist) { minDist = d; phiIdx = i; }
    }

    const angles = new Float64Array(nTheta);
    const pattern = new Float64Array(nTheta);
    for (let i = 0; i < nTheta; i++) {
      angles[i] = theta[i];
      pattern[i] = E_norm[i * nPhi + phiIdx];
    }

    // Convert to dB
    let maxVal = 0;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] > maxVal) maxVal = pattern[i];
    }
    const pattern_dB = new Float64Array(pattern.length);
    for (let i = 0; i < pattern.length; i++) {
      pattern_dB[i] = 20 * Math.log10(Math.max(pattern[i] / (maxVal || 1), 1e-15));
    }

    return { angles, pattern_dB };
  } else {
    // cutPlane === 'theta'
    let thetaIdx = 0;
    let minDist = Math.abs(theta[0] - cutAngle);
    for (let i = 1; i < nTheta; i++) {
      const d = Math.abs(theta[i] - cutAngle);
      if (d < minDist) { minDist = d; thetaIdx = i; }
    }

    const angles = new Float64Array(nPhi);
    const pattern = new Float64Array(nPhi);
    for (let i = 0; i < nPhi; i++) {
      angles[i] = phi[i];
      pattern[i] = E_norm[thetaIdx * nPhi + i];
    }

    let maxVal = 0;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] > maxVal) maxVal = pattern[i];
    }
    const pattern_dB = new Float64Array(pattern.length);
    for (let i = 0; i < pattern.length; i++) {
      pattern_dB[i] = 20 * Math.log10(Math.max(pattern[i] / (maxVal || 1), 1e-15));
    }

    return { angles, pattern_dB };
  }
}

/**
 * Prepare impedance data from port voltage/current frequency-domain data.
 *
 * @param {Object} port - port with uf_inc_re/im, uf_ref_re/im, and Z_ref
 * @param {Float64Array|number[]} freq - frequency array [Hz]
 * @returns {{ freq: Float64Array, z_re: Float64Array, z_im: Float64Array, vswr: Float64Array }}
 */
export function prepareImpedanceData(port, freq) {
  // Gamma = uf_ref / uf_inc
  const gamma = complexDivide(
    port.uf_ref_re, port.uf_ref_im,
    port.uf_inc_re, port.uf_inc_im
  );
  const gammaMag = complexAbs(gamma.re, gamma.im);

  const n = freq.length;
  const Zref = port.Z_ref || 50;

  // Z = Zref * (1 + gamma) / (1 - gamma)
  const numRe = new Float64Array(n);
  const numIm = new Float64Array(n);
  const denRe = new Float64Array(n);
  const denIm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    numRe[i] = 1 + gamma.re[i];
    numIm[i] = gamma.im[i];
    denRe[i] = 1 - gamma.re[i];
    denIm[i] = -gamma.im[i];
  }
  const zNorm = complexDivide(numRe, numIm, denRe, denIm);

  const z_re = new Float64Array(n);
  const z_im = new Float64Array(n);
  const vswr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    z_re[i] = zNorm.re[i] * Zref;
    z_im[i] = zNorm.im[i] * Zref;
    const g = Math.min(gammaMag[i], 0.9999); // clamp to avoid Infinity
    vswr[i] = (1 + g) / (1 - g);
  }

  return {
    freq: Float64Array.from(freq),
    z_re,
    z_im,
    vswr,
  };
}

/**
 * Prepare time-domain data for plotting.
 *
 * @param {Object} probeData - { time: Float64Array, values: Float64Array }
 * @param {string} [timeUnit='s'] - desired time unit: 'ns', 'us', 'ms', 's'
 * @param {string} [label=''] - label for the trace
 * @returns {{ time: Float64Array, values: Float64Array, label: string }}
 */
export function prepareTimeDomainData(probeData, timeUnit = 's', label = '') {
  const scales = { s: 1, ms: 1e3, us: 1e6, ns: 1e9 };
  const scale = scales[timeUnit] || 1;

  const time = new Float64Array(probeData.time.length);
  for (let i = 0; i < probeData.time.length; i++) {
    time[i] = probeData.time[i] * scale;
  }

  return {
    time,
    values: new Float64Array(probeData.values),
    label,
  };
}
