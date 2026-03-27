// WASM-to-GPU Bridge Module
//
// Transfers FDTD operator coefficients from a configured WASM openEMS module
// (or plain JS typed arrays) to a WebGPU or CPU FDTD engine.
//
// Two usage modes:
// 1. From plain JS arrays (works now, for testing and CPU fallback)
// 2. From WASM module (requires embind_api.cpp additions, deferred)

import { CPUFDTDEngine } from './webgpu-fdtd.mjs';

/**
 * Bridge configuration object describing the FDTD simulation setup.
 *
 * @typedef {Object} FDTDConfig
 * @property {number[]} gridSize - [Nx, Ny, Nz] grid dimensions
 * @property {Object} coefficients - { vv, vi, ii, iv } Float32Arrays of size 3*Nx*Ny*Nz
 * @property {Object} [excitation] - optional excitation config
 * @property {Object[]} [pmlRegions] - optional PML region configs
 */

/**
 * Bridge that transfers simulation data from a source (WASM or JS arrays)
 * to an FDTD engine (WebGPU or CPU).
 */
export class WASMGPUBridge {
    constructor() {
        this._config = null;
    }

    /**
     * Configure the bridge from plain JS typed arrays.
     * This is the primary interface that works without WASM rebuilds.
     *
     * @param {FDTDConfig} config
     */
    configure(config) {
        const { gridSize, coefficients } = config;
        if (!gridSize || gridSize.length !== 3) {
            throw new Error('gridSize must be [Nx, Ny, Nz]');
        }
        const [Nx, Ny, Nz] = gridSize;
        const expectedSize = 3 * Nx * Ny * Nz;

        for (const name of ['vv', 'vi', 'ii', 'iv']) {
            if (!coefficients[name]) {
                throw new Error(`Missing coefficient array: ${name}`);
            }
            if (coefficients[name].length !== expectedSize) {
                throw new Error(
                    `Coefficient ${name} size mismatch: expected ${expectedSize}, got ${coefficients[name].length}`
                );
            }
        }

        // Validate PML regions if provided
        if (config.pmlRegions) {
            for (let i = 0; i < config.pmlRegions.length; i++) {
                const region = config.pmlRegions[i];
                this._validatePMLRegion(region, gridSize, i);
            }
        }

        this._config = config;
    }

    /**
     * Configure the bridge from a WASM openEMS module after SetupFDTD().
     *
     * NOTE: This requires additions to embind_api.cpp that expose:
     * - getGridSize() -> [Nx, Ny, Nz]
     * - getVV/getVI/getII/getIV() -> coefficient vectors
     * - getExcitationData() -> excitation arrays
     * - getPMLRegions() -> PML region data
     *
     * These C++ additions are deferred until WebGPU is available in the
     * target browser environment for end-to-end testing.
     *
     * @param {Object} wasmModule - Emscripten module with OpenEMS bindings
     */
    /**
     * Configure the bridge from a WASM openEMS instance after SetupFDTD().
     *
     * The WASM module must expose an OpenEMS class with:
     * - getGridSize() -> VectorUInt [Nx, Ny, Nz]
     * - getVV/getVI/getII/getIV() -> VectorFloat (3*Nx*Ny*Nz coefficient arrays)
     *
     * @param {Object} emsInstance - An already-constructed and setup'd OpenEMS instance
     *   from the WASM module (i.e., after calling loadXML + setup).
     */
    configureFromWASM(emsInstance) {
        if (!emsInstance || typeof emsInstance.getGridSize !== 'function') {
            throw new Error(
                'WASM instance must expose getGridSize(), getVV(), getVI(), getII(), getIV(). ' +
                'Pass an OpenEMS instance after calling setup().'
            );
        }

        let gridSizeVec;
        let vvVec;
        let viVec;
        let iiVec;
        let ivVec;

        try {
            // Extract grid size from WASM (returns embind vector)
            gridSizeVec = emsInstance.getGridSize();
            if (!gridSizeVec || gridSizeVec.size() < 3) {
                throw new Error(
                    'getGridSize() returned empty or incomplete result. ' +
                    'Ensure SetupFDTD() has been called before configureFromWASM().'
                );
            }
            const gridSize = [gridSizeVec.get(0), gridSizeVec.get(1), gridSizeVec.get(2)];

            // Extract coefficient arrays from WASM (returns embind vectors)
            vvVec = emsInstance.getVV();
            viVec = emsInstance.getVI();
            iiVec = emsInstance.getII();
            ivVec = emsInstance.getIV();

            // Convert embind vectors to Float32Arrays
            const vv = _embindVectorToFloat32Array(vvVec);
            const vi = _embindVectorToFloat32Array(viVec);
            const ii = _embindVectorToFloat32Array(iiVec);
            const iv = _embindVectorToFloat32Array(ivVec);

            this.configure({ gridSize, coefficients: { vv, vi, ii, iv } });
        } finally {
            if (gridSizeVec) gridSizeVec.delete();
            if (vvVec) vvVec.delete();
            if (viVec) viVec.delete();
            if (iiVec) iiVec.delete();
            if (ivVec) ivVec.delete();
        }
    }

    /**
     * Create and return a configured CPUFDTDEngine from the current config.
     *
     * @returns {CPUFDTDEngine} a ready-to-iterate CPU engine
     */
    createCPUEngine() {
        if (!this._config) {
            throw new Error('Bridge not configured. Call configure() first.');
        }

        const { gridSize, coefficients, excitation, pmlRegions } = this._config;
        const engine = new CPUFDTDEngine(gridSize, coefficients);

        if (excitation) {
            engine.configureExcitation(excitation);
        }

        if (pmlRegions && pmlRegions.length > 0) {
            engine.configurePML(pmlRegions);
        }

        return engine;
    }

    /**
     * Create and return a configured WebGPUEngine from the current config.
     * Requires WebGPU to be available.
     *
     * @returns {Promise<WebGPUEngine>} a ready-to-iterate GPU engine
     */
    async createGPUEngine() {
        if (!this._config) {
            throw new Error('Bridge not configured. Call configure() first.');
        }

        // Dynamic import to avoid failing in Node.js
        const { WebGPUEngine } = await import('./webgpu-engine.mjs');
        const engine = new WebGPUEngine();

        const gpuAvailable = await engine.initGPU();
        if (!gpuAvailable) {
            throw new Error('WebGPU is not available');
        }

        const { gridSize, coefficients, excitation, pmlRegions } = this._config;
        await engine.init(gridSize, coefficients);

        if (excitation) {
            engine.configureExcitation(excitation);
        }

        if (pmlRegions && pmlRegions.length > 0) {
            engine.configurePML(pmlRegions);
        }

        return engine;
    }

    /**
     * Get the current configuration.
     * @returns {FDTDConfig|null}
     */
    getConfig() {
        return this._config;
    }

    // --- Private ---

    _validatePMLRegion(region, gridSize, index) {
        const [Nx, Ny, Nz] = gridSize;
        const required = ['startPos', 'numLines', 'vv', 'vvfo', 'vvfn', 'ii', 'iifo', 'iifn'];
        for (const field of required) {
            if (region[field] === undefined || region[field] === null) {
                throw new Error(`PML region ${index} missing field: ${field}`);
            }
        }

        if (region.startPos.length !== 3 || region.numLines.length !== 3) {
            throw new Error(`PML region ${index}: startPos and numLines must be length 3`);
        }

        const pmlTotal = 3 * region.numLines[0] * region.numLines[1] * region.numLines[2];
        for (const name of ['vv', 'vvfo', 'vvfn', 'ii', 'iifo', 'iifn']) {
            if (region[name].length !== pmlTotal) {
                throw new Error(
                    `PML region ${index}: ${name} size mismatch: expected ${pmlTotal}, got ${region[name].length}`
                );
            }
        }

        // Check bounds
        for (let d = 0; d < 3; d++) {
            if (region.startPos[d] + region.numLines[d] > gridSize[d]) {
                throw new Error(
                    `PML region ${index}: extends beyond grid in dimension ${d}`
                );
            }
        }
    }
}

/**
 * Convert an Emscripten embind vector<float> to a Float32Array.
 * Embind vectors expose .size() and .get(i) methods.
 *
 * @param {Object} vec - embind vector
 * @returns {Float32Array}
 */
function _embindVectorToFloat32Array(vec) {
    if (typeof vec.toFloat32Array === 'function') {
        const data = vec.toFloat32Array();
        return data instanceof Float32Array ? data : new Float32Array(data);
    }

    const len = vec.size();
    const arr = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        arr[i] = vec.get(i);
    }
    return arr;
}
