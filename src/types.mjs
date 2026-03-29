/**
 * TypeScript-style type definitions as JSDoc for the openEMS WASM API.
 * Import this module for documentation; actual runtime types are plain objects.
 */

/**
 * @typedef {[number, number, number]} Vec3
 */

/**
 * @typedef {'PEC' | 'PMC' | 'MUR' | 'PBC' | string} BoundaryType
 * PEC=0, PMC=1, MUR=2, PML_N=3 (N cells), PBC=-1 (periodic).
 * String 'PML_8' means PML with 8 cells.
 */

/**
 * @typedef {[BoundaryType, BoundaryType, BoundaryType, BoundaryType, BoundaryType, BoundaryType]} BoundaryCond
 * [xmin, xmax, ymin, ymax, zmin, zmax]
 */

/**
 * @typedef {Object} ExcitationGauss
 * @property {'gauss'} type
 * @property {number} f0 - center frequency [Hz]
 * @property {number} fc - cutoff frequency [Hz]
 */

/**
 * @typedef {Object} ExcitationSinus
 * @property {'sinus'} type
 * @property {number} f0 - frequency [Hz]
 */

/**
 * @typedef {Object} ExcitationDirac
 * @property {'dirac'} type
 * @property {number} fmax - max frequency [Hz]
 */

/**
 * @typedef {Object} ExcitationStep
 * @property {'step'} type
 * @property {number} fmax - max frequency [Hz]
 */

/**
 * @typedef {Object} ExcitationCustom
 * @property {'custom'} type
 * @property {string} func - custom function string
 * @property {number} f0 - center frequency [Hz]
 * @property {number} fmax - max frequency [Hz]
 */

/**
 * @typedef {ExcitationGauss | ExcitationSinus | ExcitationDirac | ExcitationStep | ExcitationCustom} ExcitationType
 */

/**
 * @typedef {Object} OpenEMSConfig
 * @property {number} [nrTS=1e6] - number of timesteps
 * @property {number} [endCriteria=1e-5] - end criteria threshold
 * @property {number} [maxTime] - maximum simulation time [s]
 * @property {number} [overSampling] - oversampling factor
 * @property {number} [coordSystem=0] - 0=Cartesian, 1=Cylindrical
 * @property {number} [timeStepMethod] - timestep calculation method
 * @property {number} [timeStepFactor] - timestep scaling factor
 */

/**
 * @typedef {Object} PortResult
 * @property {Float64Array} uf_inc_re - incident voltage (real)
 * @property {Float64Array} uf_inc_im - incident voltage (imag)
 * @property {Float64Array} uf_ref_re - reflected voltage (real)
 * @property {Float64Array} uf_ref_im - reflected voltage (imag)
 * @property {Float64Array} if_inc_re - incident current (real)
 * @property {Float64Array} if_inc_im - incident current (imag)
 * @property {Float64Array} if_ref_re - reflected current (real)
 * @property {Float64Array} if_ref_im - reflected current (imag)
 * @property {Float64Array} P_inc - incident power [W]
 * @property {Float64Array} P_ref - reflected power [W]
 * @property {Float64Array} P_acc - accepted power [W]
 * @property {number} Z_ref - reference impedance [Ohm]
 */

/**
 * @typedef {Object} NF2FFResult
 * @property {Float64Array} theta
 * @property {Float64Array} phi
 * @property {number} Dmax - maximum directivity
 * @property {number} Prad - total radiated power [W]
 * @property {{ re: Float64Array, im: Float64Array }} E_theta
 * @property {{ re: Float64Array, im: Float64Array }} E_phi
 */

export {};
