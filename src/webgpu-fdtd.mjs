// WebGPU FDTD Integration Layer
//
// Bridges the WASM CPU engine (which computes operator coefficients) with
// the WebGPU GPU engine (which runs the time-stepping). Falls back to CPU
// if WebGPU is unavailable.

import { WebGPUEngine } from './webgpu-engine.mjs';

/**
 * Reference CPU implementation of the FDTD update equations.
 * Matches the C++ engine.cpp exactly for validation and fallback.
 */
export class CPUFDTDEngine {
    /**
     * @param {number[]} numLines - [Nx, Ny, Nz]
     * @param {object} coefficients - { vv, vi, ii, iv } Float32Arrays
     */
    constructor(numLines, coefficients) {
        this.numLines = numLines;
        const [Nx, Ny, Nz] = numLines;
        this.Nx = Nx;
        this.Ny = Ny;
        this.Nz = Nz;
        this.totalCells = Nx * Ny * Nz;

        this.vv = coefficients.vv;
        this.vi = coefficients.vi;
        this.ii = coefficients.ii;
        this.iv = coefficients.iv;

        // Field arrays, zero-initialized
        this.volt = new Float32Array(3 * this.totalCells);
        this.curr = new Float32Array(3 * this.totalCells);

        this.numTS = 0;
        this.excitation = null;
        this.pmlRegions = [];
    }

    /**
     * Linear index into N-I-J-K array.
     * addr(n,i,j,k) = n*Nx*Ny*Nz + i*Ny*Nz + j*Nz + k
     */
    idx(n, x, y, z) {
        return n * this.totalCells + x * this.Ny * this.Nz + y * this.Nz + z;
    }

    /**
     * Update all voltage (E-field) components.
     * Matches engine.cpp UpdateVoltages exactly.
     */
    updateVoltages() {
        const { Nx, Ny, Nz, volt, curr, vv, vi } = this;

        for (let x = 0; x < Nx; x++) {
            const shiftX = x > 0 ? 1 : 0;
            for (let y = 0; y < Ny; y++) {
                const shiftY = y > 0 ? 1 : 0;
                for (let z = 0; z < Nz; z++) {
                    const shiftZ = z > 0 ? 1 : 0;

                    // Ex update
                    const exIdx = this.idx(0, x, y, z);
                    volt[exIdx] *= vv[exIdx];
                    volt[exIdx] += vi[exIdx] * (
                        curr[this.idx(2, x, y, z)] -
                        curr[this.idx(2, x, y - shiftY, z)] -
                        curr[this.idx(1, x, y, z)] +
                        curr[this.idx(1, x, y, z - shiftZ)]
                    );

                    // Ey update
                    const eyIdx = this.idx(1, x, y, z);
                    volt[eyIdx] *= vv[eyIdx];
                    volt[eyIdx] += vi[eyIdx] * (
                        curr[this.idx(0, x, y, z)] -
                        curr[this.idx(0, x, y, z - shiftZ)] -
                        curr[this.idx(2, x, y, z)] +
                        curr[this.idx(2, x - shiftX, y, z)]
                    );

                    // Ez update
                    const ezIdx = this.idx(2, x, y, z);
                    volt[ezIdx] *= vv[ezIdx];
                    volt[ezIdx] += vi[ezIdx] * (
                        curr[this.idx(1, x, y, z)] -
                        curr[this.idx(1, x - shiftX, y, z)] -
                        curr[this.idx(0, x, y, z)] +
                        curr[this.idx(0, x, y - shiftY, z)]
                    );
                }
            }
        }
    }

    /**
     * Update all current (H-field) components.
     * Matches engine.cpp UpdateCurrents exactly.
     * Note: loops go to Ny-1 and Nz-1 (not Ny, Nz).
     */
    updateCurrents() {
        const { Nx, Ny, Nz, volt, curr } = this;
        const ii = this.ii;
        const iv = this.iv;

        // C++ calls UpdateCurrents(0, numLines[0]-1), so X goes to Nx-2.
        // This is because the Hy/Hz curl stencil reads volt at x+1.
        for (let x = 0; x < Nx - 1; x++) {
            for (let y = 0; y < Ny - 1; y++) {
                for (let z = 0; z < Nz - 1; z++) {
                    // Hx update
                    const hxIdx = this.idx(0, x, y, z);
                    curr[hxIdx] *= ii[hxIdx];
                    curr[hxIdx] += iv[hxIdx] * (
                        volt[this.idx(2, x, y, z)] -
                        volt[this.idx(2, x, y + 1, z)] -
                        volt[this.idx(1, x, y, z)] +
                        volt[this.idx(1, x, y, z + 1)]
                    );

                    // Hy update
                    const hyIdx = this.idx(1, x, y, z);
                    curr[hyIdx] *= ii[hyIdx];
                    curr[hyIdx] += iv[hyIdx] * (
                        volt[this.idx(0, x, y, z)] -
                        volt[this.idx(0, x, y, z + 1)] -
                        volt[this.idx(2, x, y, z)] +
                        volt[this.idx(2, x + 1, y, z)]
                    );

                    // Hz update
                    const hzIdx = this.idx(2, x, y, z);
                    curr[hzIdx] *= ii[hzIdx];
                    curr[hzIdx] += iv[hzIdx] * (
                        volt[this.idx(1, x, y, z)] -
                        volt[this.idx(1, x + 1, y, z)] -
                        volt[this.idx(0, x, y, z)] +
                        volt[this.idx(0, x, y + 1, z)]
                    );
                }
            }
        }
    }

    /**
     * Apply excitation to voltage fields.
     * Matches engine_ext_excitation.cpp Apply2Voltages.
     */
    applyExcitation() {
        if (!this.excitation) return;

        const exc = this.excitation;
        const { signal, delay, amp, dir, pos, period } = exc;
        const numTS = this.numTS;
        const length = signal.length;

        let p = numTS + 1;
        if (period > 0) {
            p = period;
        }

        for (let n = 0; n < amp.length; n++) {
            let excPos = numTS - delay[n];
            excPos *= (excPos > 0) ? 1 : 0;
            excPos %= p;
            excPos *= (excPos < length) ? 1 : 0;

            const component = dir[n];
            const linearPos = pos[n];
            const fieldIdx = component * this.totalCells + linearPos;
            this.volt[fieldIdx] += amp[n] * signal[excPos];
        }
    }

    /**
     * Configure excitation sources.
     * @param {object} excitation - { signal, delay, amp, dir, pos, period }
     */
    configureExcitation(excitation) {
        this.excitation = excitation;
    }

    /**
     * Configure PML (Perfectly Matched Layer) regions.
     *
     * Each region has:
     *   startPos: [sx, sy, sz]  — start position in global grid
     *   numLines: [nx, ny, nz]  — PML region dimensions
     *   vv, vvfo, vvfn          — voltage PML coefficient arrays (Float32Array, size 3*nx*ny*nz)
     *   ii, iifo, iifn          — current PML coefficient arrays (Float32Array, size 3*nx*ny*nz)
     *
     * @param {Object[]} pmlRegions
     */
    configurePML(pmlRegions) {
        this.pmlRegions = pmlRegions.map(region => {
            const [nx, ny, nz] = region.numLines;
            const pmlTotal = 3 * nx * ny * nz;
            return {
                startPos: region.startPos,
                numLines: region.numLines,
                vv: region.vv,
                vvfo: region.vvfo,
                vvfn: region.vvfn,
                ii: region.ii,
                iifo: region.iifo,
                iifn: region.iifn,
                volt_flux: new Float32Array(pmlTotal),
                curr_flux: new Float32Array(pmlTotal),
            };
        });
    }

    /**
     * PML local index: addr(n, lx, ly, lz) within PML region.
     */
    pmlIdx(n, lx, ly, lz, ny, nz) {
        return n * (ny * nz * ((this.pmlRegions.length > 0) ? 1 : 1)) + lx * ny * nz + ly * nz + lz;
    }

    /**
     * Pre-voltage PML update.
     * From engine_ext_upml.cpp DoPreVoltageUpdates:
     *   f_help = vv * V[g] - vvfo * volt_flux[p]
     *   V[g] = volt_flux[p]
     *   volt_flux[p] = f_help
     */
    preVoltageUpdatePML() {
        for (const region of this.pmlRegions) {
            const [sx, sy, sz] = region.startPos;
            const [nx, ny, nz] = region.numLines;
            const { vv, vvfo, volt_flux } = region;

            for (let lx = 0; lx < nx; lx++) {
                const gx = lx + sx;
                for (let ly = 0; ly < ny; ly++) {
                    const gy = ly + sy;
                    for (let lz = 0; lz < nz; lz++) {
                        const gz = lz + sz;
                        for (let n = 0; n < 3; n++) {
                            const p = n * nx * ny * nz + lx * ny * nz + ly * nz + lz;
                            const g = this.idx(n, gx, gy, gz);
                            const f_help = vv[p] * this.volt[g] - vvfo[p] * volt_flux[p];
                            this.volt[g] = volt_flux[p];
                            volt_flux[p] = f_help;
                        }
                    }
                }
            }
        }
    }

    /**
     * Post-voltage PML update.
     * From engine_ext_upml.cpp DoPostVoltageUpdates:
     *   f_help = volt_flux[p]
     *   volt_flux[p] = V[g]
     *   V[g] = f_help + vvfn * volt_flux[p]
     */
    postVoltageUpdatePML() {
        for (const region of this.pmlRegions) {
            const [sx, sy, sz] = region.startPos;
            const [nx, ny, nz] = region.numLines;
            const { vvfn, volt_flux } = region;

            for (let lx = 0; lx < nx; lx++) {
                const gx = lx + sx;
                for (let ly = 0; ly < ny; ly++) {
                    const gy = ly + sy;
                    for (let lz = 0; lz < nz; lz++) {
                        const gz = lz + sz;
                        for (let n = 0; n < 3; n++) {
                            const p = n * nx * ny * nz + lx * ny * nz + ly * nz + lz;
                            const g = this.idx(n, gx, gy, gz);
                            const f_help = volt_flux[p];
                            volt_flux[p] = this.volt[g];
                            this.volt[g] = f_help + vvfn[p] * volt_flux[p];
                        }
                    }
                }
            }
        }
    }

    /**
     * Pre-current PML update.
     * From engine_ext_upml.cpp DoPreCurrentUpdates:
     *   f_help = ii * I[g] - iifo * curr_flux[p]
     *   I[g] = curr_flux[p]
     *   curr_flux[p] = f_help
     */
    preCurrentUpdatePML() {
        for (const region of this.pmlRegions) {
            const [sx, sy, sz] = region.startPos;
            const [nx, ny, nz] = region.numLines;
            const { ii, iifo, curr_flux } = region;

            for (let lx = 0; lx < nx; lx++) {
                const gx = lx + sx;
                for (let ly = 0; ly < ny; ly++) {
                    const gy = ly + sy;
                    for (let lz = 0; lz < nz; lz++) {
                        const gz = lz + sz;
                        for (let n = 0; n < 3; n++) {
                            const p = n * nx * ny * nz + lx * ny * nz + ly * nz + lz;
                            const g = this.idx(n, gx, gy, gz);
                            const f_help = ii[p] * this.curr[g] - iifo[p] * curr_flux[p];
                            this.curr[g] = curr_flux[p];
                            curr_flux[p] = f_help;
                        }
                    }
                }
            }
        }
    }

    /**
     * Post-current PML update.
     * From engine_ext_upml.cpp DoPostCurrentUpdates:
     *   f_help = curr_flux[p]
     *   curr_flux[p] = I[g]
     *   I[g] = f_help + iifn * curr_flux[p]
     */
    postCurrentUpdatePML() {
        for (const region of this.pmlRegions) {
            const [sx, sy, sz] = region.startPos;
            const [nx, ny, nz] = region.numLines;
            const { iifn, curr_flux } = region;

            for (let lx = 0; lx < nx; lx++) {
                const gx = lx + sx;
                for (let ly = 0; ly < ny; ly++) {
                    const gy = ly + sy;
                    for (let lz = 0; lz < nz; lz++) {
                        const gz = lz + sz;
                        for (let n = 0; n < 3; n++) {
                            const p = n * nx * ny * nz + lx * ny * nz + ly * nz + lz;
                            const g = this.idx(n, gx, gy, gz);
                            const f_help = curr_flux[p];
                            curr_flux[p] = this.curr[g];
                            this.curr[g] = f_help + iifn[p] * curr_flux[p];
                        }
                    }
                }
            }
        }
    }

    /**
     * Run one complete FDTD timestep.
     * Order: pre-voltage PML -> voltage -> post-voltage PML -> excitation ->
     *        pre-current PML -> current -> post-current PML -> increment
     */
    step() {
        this.preVoltageUpdatePML();
        this.updateVoltages();
        this.postVoltageUpdatePML();
        this.applyExcitation();
        this.preCurrentUpdatePML();
        this.updateCurrents();
        this.postCurrentUpdatePML();
        this.numTS++;
    }

    /**
     * Run N complete FDTD timesteps.
     * @param {number} numSteps
     */
    iterate(numSteps) {
        for (let i = 0; i < numSteps; i++) {
            this.step();
        }
    }

    /**
     * Get field data.
     * @returns {{ volt: Float32Array, curr: Float32Array }}
     */
    getFields() {
        return {
            volt: new Float32Array(this.volt),
            curr: new Float32Array(this.curr),
        };
    }

    /**
     * Upload field data (for testing, state restoration).
     */
    uploadFields(volt, curr) {
        this.volt.set(volt);
        this.curr.set(curr);
    }
}


/**
 * Hybrid FDTD engine: uses WebGPU when available, falls back to CPU.
 *
 * Usage:
 *   const fdtd = new WebGPUFDTD();
 *   const useGPU = await fdtd.init(gridSize, coefficients);
 *   fdtd.configureExcitation(excitation);
 *   await fdtd.iterate(1000);
 *   const fields = await fdtd.getFields();
 */
export class WebGPUFDTD {
    constructor() {
        this._gpuEngine = null;
        this._cpuEngine = null;
        this._useGPU = false;
    }

    /**
     * Initialize the FDTD engine. Tries WebGPU first, falls back to CPU.
     *
     * @param {number[]} gridSize - [Nx, Ny, Nz]
     * @param {object} coefficients - { vv, vi, ii, iv } Float32Arrays of size 3*Nx*Ny*Nz
     * @returns {Promise<boolean>} true if using GPU, false if CPU fallback
     */
    async init(gridSize, coefficients) {
        // Try WebGPU
        try {
            const gpu = new WebGPUEngine();
            const gpuAvailable = await gpu.initGPU();
            if (gpuAvailable) {
                await gpu.init(gridSize, coefficients);
                this._gpuEngine = gpu;
                this._useGPU = true;
                return true;
            }
        } catch (e) {
            console.warn('WebGPU initialization failed, falling back to CPU:', e.message);
        }

        // Fall back to CPU
        this._cpuEngine = new CPUFDTDEngine(gridSize, coefficients);
        this._useGPU = false;
        return false;
    }

    /**
     * Whether the engine is using WebGPU acceleration.
     */
    get isGPU() {
        return this._useGPU;
    }

    /**
     * Configure excitation sources.
     * @param {object} excitation
     */
    configureExcitation(excitation) {
        if (this._useGPU) {
            this._gpuEngine.configureExcitation(excitation);
        } else {
            this._cpuEngine.configureExcitation(excitation);
        }
    }

    /**
     * Configure PML regions.
     * @param {Object[]} pmlRegions
     */
    configurePML(pmlRegions) {
        if (this._useGPU) {
            this._gpuEngine.configurePML(pmlRegions);
        } else {
            this._cpuEngine.configurePML(pmlRegions);
        }
    }

    /**
     * Run N timesteps.
     * @param {number} numSteps
     */
    async iterate(numSteps) {
        if (this._useGPU) {
            await this._gpuEngine.iterate(numSteps);
        } else {
            this._cpuEngine.iterate(numSteps);
        }
    }

    /**
     * Get current timestep number.
     */
    get numTS() {
        return this._useGPU ? this._gpuEngine.numTS : this._cpuEngine.numTS;
    }

    /**
     * Read all field data.
     * @returns {Promise<{volt: Float32Array, curr: Float32Array}>}
     */
    async getFields() {
        if (this._useGPU) {
            return this._gpuEngine.getFields();
        }
        return this._cpuEngine.getFields();
    }

    /**
     * Upload field data.
     */
    async uploadFields(volt, curr) {
        if (this._useGPU) {
            this._gpuEngine.uploadFields(volt, curr);
        } else {
            this._cpuEngine.uploadFields(volt, curr);
        }
    }

    /**
     * Destroy all resources.
     */
    destroy() {
        if (this._gpuEngine) {
            this._gpuEngine.destroy();
        }
    }
}
