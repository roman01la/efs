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

        // Extension state
        this.lorentzOrders = [];    // ADE dispersive material orders
        this.tfsfConfig = null;     // TFSF plane wave injection
        this.rlcElements = [];      // Lumped RLC elements
        this.murConfig = null;      // Mur ABC boundary
        this.steadyStateConfig = null; // Steady-state detection

        // Fusion state
        this._fusionConfig = null;  // PML+ADE fusion config
        this._rlcRingIdx = 0;       // RLC ring buffer index (0, 1, or 2)
        this._useRingBuffer = false; // Whether to use ring buffer for RLC
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

    // -----------------------------------------------------------------------
    // Lorentz/Drude ADE (Auxiliary Differential Equation) for dispersive materials
    // -----------------------------------------------------------------------

    /**
     * Configure Lorentz/Drude dispersive material orders.
     * @param {Object} config - { orders: Array<{
     *   numCells: number,
     *   hasLorentz: boolean,
     *   directions: Array<{
     *     dir: number,                 // 0=x, 1=y, 2=z
     *     pos_idx: Uint32Array,        // linear indices into global field
     *     v_int_ADE: Float32Array,     // integration coefficient
     *     v_ext_ADE: Float32Array,     // external coupling coefficient
     *     v_Lor_ADE: Float32Array,     // Lorentz coupling coefficient
     *     i_int_ADE: Float32Array,     // current integration coefficient
     *     i_ext_ADE: Float32Array,     // current external coupling coefficient
     *     i_Lor_ADE: Float32Array,     // current Lorentz coupling coefficient
     *   }>
     * }> }
     */
    configureLorentz(config) {
        this.lorentzOrders = config.orders.map(order => ({
            numCells: order.numCells,
            hasLorentz: order.hasLorentz,
            directions: order.directions.map(d => ({
                dir: d.dir,
                pos_idx: d.pos_idx,
                v_int_ADE: d.v_int_ADE,
                v_ext_ADE: d.v_ext_ADE,
                v_Lor_ADE: d.v_Lor_ADE || new Float32Array(order.numCells),
                i_int_ADE: d.i_int_ADE || new Float32Array(order.numCells),
                i_ext_ADE: d.i_ext_ADE || new Float32Array(order.numCells),
                i_Lor_ADE: d.i_Lor_ADE || new Float32Array(order.numCells),
                volt_ADE: new Float32Array(order.numCells),
                volt_Lor_ADE: new Float32Array(order.numCells),
                curr_ADE: new Float32Array(order.numCells),
                curr_Lor_ADE: new Float32Array(order.numCells),
            })),
        }));
    }

    /**
     * Update voltage ADE for all Lorentz/Drude orders and directions.
     */
    updateVoltADE() {
        for (const order of this.lorentzOrders) {
            for (const d of order.directions) {
                const { pos_idx, v_int_ADE, v_ext_ADE, v_Lor_ADE,
                        volt_ADE, volt_Lor_ADE } = d;
                const componentStride = this.totalCells;

                for (let i = 0; i < order.numCells; i++) {
                    const fieldIdx = d.dir * componentStride + pos_idx[i];
                    const V = this.volt[fieldIdx];

                    if (order.hasLorentz) {
                        volt_Lor_ADE[i] += v_Lor_ADE[i] * volt_ADE[i];
                        volt_ADE[i] = v_int_ADE[i] * volt_ADE[i]
                                     + v_ext_ADE[i] * (V - volt_Lor_ADE[i]);
                    } else {
                        volt_ADE[i] = v_int_ADE[i] * volt_ADE[i]
                                     + v_ext_ADE[i] * V;
                    }
                }
            }
        }
    }

    /**
     * Update current ADE for all Lorentz/Drude orders and directions.
     */
    updateCurrADE() {
        for (const order of this.lorentzOrders) {
            for (const d of order.directions) {
                const { pos_idx, i_int_ADE, i_ext_ADE, i_Lor_ADE,
                        curr_ADE, curr_Lor_ADE } = d;
                const componentStride = this.totalCells;

                for (let i = 0; i < order.numCells; i++) {
                    const fieldIdx = d.dir * componentStride + pos_idx[i];
                    const I = this.curr[fieldIdx];

                    if (order.hasLorentz) {
                        curr_Lor_ADE[i] += i_Lor_ADE[i] * curr_ADE[i];
                        curr_ADE[i] = i_int_ADE[i] * curr_ADE[i]
                                     + i_ext_ADE[i] * (I - curr_Lor_ADE[i]);
                    } else {
                        curr_ADE[i] = i_int_ADE[i] * curr_ADE[i]
                                     + i_ext_ADE[i] * I;
                    }
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // PML + ADE Fusion
    // -----------------------------------------------------------------------

    /**
     * Configure PML+ADE fusion. Detects overlapping cells between PML regions
     * and ADE dispersive material cells, and builds a fused cell list.
     *
     * When fusion is active, step() will skip individual postVoltageUpdatePML
     * and updateVoltADE calls for fused cells and run the fused path instead,
     * reducing global memory bandwidth by 2x for cells in dispersive PML regions.
     *
     * For GPU (WebGPU), fusion is not applied — separate dispatches are kept
     * since GPU memory bandwidth is less constrained.
     *
     * @param {Object} [config] - { enabled: boolean }
     */
    configureFusion(config = {}) {
        const enabled = config.enabled !== false;
        if (!enabled || this.pmlRegions.length === 0 || this.lorentzOrders.length === 0) {
            this._fusionConfig = null;
            return;
        }

        // Build a set of global field indices that are inside PML regions
        // We track which PML region and local index each global index maps to
        const pmlCellMap = new Map(); // globalIdx -> { regionIdx, localIdx_p, component_n }

        for (let ri = 0; ri < this.pmlRegions.length; ri++) {
            const region = this.pmlRegions[ri];
            const [sx, sy, sz] = region.startPos;
            const [nx, ny, nz] = region.numLines;

            for (let lx = 0; lx < nx; lx++) {
                const gx = lx + sx;
                for (let ly = 0; ly < ny; ly++) {
                    const gy = ly + sy;
                    for (let lz = 0; lz < nz; lz++) {
                        const gz = lz + sz;
                        for (let n = 0; n < 3; n++) {
                            const g = this.idx(n, gx, gy, gz);
                            const p = n * nx * ny * nz + lx * ny * nz + ly * nz + lz;
                            pmlCellMap.set(g, { regionIdx: ri, p, n });
                        }
                    }
                }
            }
        }

        // For each ADE order+direction, find cells that overlap with PML
        const fusedCells = []; // array of { globalIdx, pmlInfo, adeEntries[] }
        const fusedADEIndices = new Set(); // set of "orderIdx:dirIdx:cellI" strings for skipping

        for (let oi = 0; oi < this.lorentzOrders.length; oi++) {
            const order = this.lorentzOrders[oi];
            for (let di = 0; di < order.directions.length; di++) {
                const d = order.directions[di];
                const componentStride = this.totalCells;

                for (let i = 0; i < order.numCells; i++) {
                    const fieldIdx = d.dir * componentStride + d.pos_idx[i];
                    if (pmlCellMap.has(fieldIdx)) {
                        const pmlInfo = pmlCellMap.get(fieldIdx);
                        // Check if we already have a fused entry for this global idx
                        let entry = fusedCells.find(e => e.globalIdx === fieldIdx);
                        if (!entry) {
                            entry = { globalIdx: fieldIdx, pmlInfo, adeEntries: [] };
                            fusedCells.push(entry);
                        }
                        entry.adeEntries.push({ orderIdx: oi, dirIdx: di, cellIdx: i });
                        fusedADEIndices.add(`${oi}:${di}:${i}`);
                    }
                }
            }
        }

        if (fusedCells.length === 0) {
            this._fusionConfig = null;
            return;
        }

        // Build set of PML local indices to skip in normal PML post-voltage
        const fusedPMLIndices = new Map(); // regionIdx -> Set of local p indices
        for (const cell of fusedCells) {
            const ri = cell.pmlInfo.regionIdx;
            if (!fusedPMLIndices.has(ri)) {
                fusedPMLIndices.set(ri, new Set());
            }
            fusedPMLIndices.get(ri).add(cell.pmlInfo.p);
        }

        this._fusionConfig = {
            fusedCells,
            fusedADEIndices,
            fusedPMLIndices,
        };
    }

    /**
     * Fused PML post-voltage + ADE voltage update for overlapping cells.
     * Reads voltage once, applies PML correction, updates all ADE orders, writes once.
     */
    _fusedPostVoltageAndADE() {
        if (!this._fusionConfig) return;

        for (const cell of this._fusionConfig.fusedCells) {
            const g = cell.globalIdx;
            const pml = cell.pmlInfo;
            const region = this.pmlRegions[pml.regionIdx];
            const { vvfn, volt_flux } = region;
            const p = pml.p;

            // PML post-voltage: read voltage once and apply PML correction
            const f_help = volt_flux[p];
            volt_flux[p] = this.volt[g];
            this.volt[g] = f_help + vvfn[p] * volt_flux[p];

            // Now read the PML-corrected voltage for ADE updates
            const V = this.volt[g];

            // ADE voltage update for all overlapping orders
            for (const ade of cell.adeEntries) {
                const order = this.lorentzOrders[ade.orderIdx];
                const d = order.directions[ade.dirIdx];
                const i = ade.cellIdx;

                if (order.hasLorentz) {
                    d.volt_Lor_ADE[i] += d.v_Lor_ADE[i] * d.volt_ADE[i];
                    d.volt_ADE[i] = d.v_int_ADE[i] * d.volt_ADE[i]
                                   + d.v_ext_ADE[i] * (V - d.volt_Lor_ADE[i]);
                } else {
                    d.volt_ADE[i] = d.v_int_ADE[i] * d.volt_ADE[i]
                                   + d.v_ext_ADE[i] * V;
                }
            }
        }
    }

    /**
     * Post-voltage PML update, skipping fused cells when fusion is active.
     */
    _postVoltageUpdatePMLWithFusion() {
        if (!this._fusionConfig) {
            this.postVoltageUpdatePML();
            return;
        }

        for (let ri = 0; ri < this.pmlRegions.length; ri++) {
            const region = this.pmlRegions[ri];
            const [sx, sy, sz] = region.startPos;
            const [nx, ny, nz] = region.numLines;
            const { vvfn, volt_flux } = region;
            const skipSet = this._fusionConfig.fusedPMLIndices.get(ri);

            for (let lx = 0; lx < nx; lx++) {
                const gx = lx + sx;
                for (let ly = 0; ly < ny; ly++) {
                    const gy = ly + sy;
                    for (let lz = 0; lz < nz; lz++) {
                        const gz = lz + sz;
                        for (let n = 0; n < 3; n++) {
                            const p = n * nx * ny * nz + lx * ny * nz + ly * nz + lz;
                            if (skipSet && skipSet.has(p)) continue; // handled by fused path
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
     * Voltage ADE update, skipping fused cells when fusion is active.
     */
    _updateVoltADEWithFusion() {
        if (!this._fusionConfig) {
            this.updateVoltADE();
            return;
        }

        const fusedIndices = this._fusionConfig.fusedADEIndices;

        for (let oi = 0; oi < this.lorentzOrders.length; oi++) {
            const order = this.lorentzOrders[oi];
            for (let di = 0; di < order.directions.length; di++) {
                const d = order.directions[di];
                const { pos_idx, v_int_ADE, v_ext_ADE, v_Lor_ADE,
                        volt_ADE, volt_Lor_ADE } = d;
                const componentStride = this.totalCells;

                for (let i = 0; i < order.numCells; i++) {
                    if (fusedIndices.has(`${oi}:${di}:${i}`)) continue; // handled by fused path

                    const fieldIdx = d.dir * componentStride + pos_idx[i];
                    const V = this.volt[fieldIdx];

                    if (order.hasLorentz) {
                        volt_Lor_ADE[i] += v_Lor_ADE[i] * volt_ADE[i];
                        volt_ADE[i] = v_int_ADE[i] * volt_ADE[i]
                                     + v_ext_ADE[i] * (V - volt_Lor_ADE[i]);
                    } else {
                        volt_ADE[i] = v_int_ADE[i] * volt_ADE[i]
                                     + v_ext_ADE[i] * V;
                    }
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // TFSF (Total-Field/Scattered-Field)
    // -----------------------------------------------------------------------

    /**
     * Configure TFSF plane wave injection.
     * @param {Object} config - {
     *   signal: Float32Array,
     *   period: number,
     *   voltagePoints: Array<{ field_idx, delay_int, delay_frac, amp }>,
     *   currentPoints: Array<{ field_idx, delay_int, delay_frac, amp }>,
     * }
     */
    configureTFSF(config) {
        this.tfsfConfig = {
            signal: config.signal,
            signalLength: config.signal.length,
            period: config.period || 0,
            voltagePoints: config.voltagePoints || [],
            currentPoints: config.currentPoints || [],
        };
    }

    /**
     * Apply TFSF voltage injection.
     */
    applyTFSFVoltage() {
        if (!this.tfsfConfig) return;
        const { signal, signalLength, period, voltagePoints } = this.tfsfConfig;
        const numTS = this.numTS;

        for (const pt of voltagePoints) {
            let d = numTS - pt.delay_int;
            if (d < 0) continue;
            if (period > 0) {
                d = d % period;
            }
            if (d >= signalLength - 1) continue;

            const delta = pt.delay_frac;
            const sig = (1.0 - delta) * signal[d] + delta * signal[d + 1];
            this.volt[pt.field_idx] += pt.amp * sig;
        }
    }

    /**
     * Apply TFSF current injection.
     */
    applyTFSFCurrent() {
        if (!this.tfsfConfig) return;
        const { signal, signalLength, period, currentPoints } = this.tfsfConfig;
        const numTS = this.numTS;

        for (const pt of currentPoints) {
            let d = numTS - pt.delay_int;
            if (d < 0) continue;
            if (period > 0) {
                d = d % period;
            }
            if (d >= signalLength - 1) continue;

            const delta = pt.delay_frac;
            const sig = (1.0 - delta) * signal[d] + delta * signal[d + 1];
            this.curr[pt.field_idx] += pt.amp * sig;
        }
    }

    // -----------------------------------------------------------------------
    // Lumped RLC Elements
    // -----------------------------------------------------------------------

    /**
     * Configure lumped RLC elements.
     * @param {Object} config - { elements: Array<{
     *   field_idx: number,    // linear index into global field
     *   direction: number,    // component (0, 1, 2)
     *   type_flag: number,    // 0=parallel, 1=series
     *   i2v: number, ilv: number,
     *   vvd: number, vv2: number, vj1: number, vj2: number,
     *   ib0: number, b1: number, b2: number,
     * }> }
     */
    configureRLC(config) {
        const n = config.elements.length;
        this.rlcElements = config.elements.map(elem => ({ ...elem }));
        this.rlcVdn = new Float32Array(n * 3);   // 3-deep history
        this.rlcJn = new Float32Array(n * 3);     // 3-deep history
        this.rlcVIl = new Float32Array(n);        // inductor current accumulator
        this._rlcRingIdx = 0;                     // ring buffer write position
    }

    /**
     * Enable or disable ring buffer mode for RLC history.
     * Ring buffer avoids physically shifting array values (Vdn[2]=Vdn[1]; Vdn[1]=Vdn[0])
     * by cycling a write index 0->1->2->0. History is accessed via (ringIdx + offset) % 3.
     *
     * @param {boolean} enabled
     */
    enableRLCRingBuffer(enabled = true) {
        this._useRingBuffer = enabled;
        this._rlcRingIdx = 0;
    }

    /**
     * RLC pre-voltage: shift Vdn history, update parallel inductor current.
     * Matches C++ DoPreVoltageUpdates in engine_ext_lumpedRLC.cpp:83-97.
     */
    preVoltageRLC() {
        if (!this.rlcElements || this.rlcElements.length === 0) return;

        if (this._useRingBuffer) {
            this._preVoltageRLCRing();
            return;
        }

        const { rlcVdn: Vdn, rlcVIl: v_Il } = this;

        for (let n = 0; n < this.rlcElements.length; n++) {
            const h0 = n * 3;
            const h1 = n * 3 + 1;
            const h2 = n * 3 + 2;

            Vdn[h2] = Vdn[h1];
            Vdn[h1] = Vdn[h0];

            const elem = this.rlcElements[n];
            if (elem.type_flag === 0) {
                v_Il[n] += elem.i2v * elem.ilv * Vdn[h1];
            }
        }
    }

    /**
     * RLC pre-voltage using ring buffer indexing.
     * Instead of shifting Vdn[2]=Vdn[1]; Vdn[1]=Vdn[0], we advance the ring index.
     * ringIdx points to the "current" (newest) slot.
     * History: current = ringIdx, prev = (ringIdx+2)%3, prev-prev = (ringIdx+1)%3
     */
    _preVoltageRLCRing() {
        const { rlcVdn: Vdn, rlcVIl: v_Il } = this;
        // Advance ring: the old "current" becomes "prev", old "prev" becomes "prev-prev"
        // New ringIdx will be where old "prev-prev" was (it's being overwritten)
        this._rlcRingIdx = (this._rlcRingIdx + 2) % 3;
        const r0 = this._rlcRingIdx; // new current slot (will be written in applyRLC)
        const r1 = (r0 + 1) % 3;     // prev (was current before advance)

        for (let n = 0; n < this.rlcElements.length; n++) {
            const base = n * 3;
            const elem = this.rlcElements[n];
            if (elem.type_flag === 0) {
                v_Il[n] += elem.i2v * elem.ilv * Vdn[base + r1];
            }
        }
    }

    /**
     * RLC apply-to-voltages: read voltage, shift Jn, series update, writeback.
     * Matches C++ Apply2Voltages in engine_ext_lumpedRLC.cpp:100-142.
     */
    applyRLC() {
        if (!this.rlcElements || this.rlcElements.length === 0) return;

        if (this._useRingBuffer) {
            this._applyRLCRing();
            return;
        }

        const { rlcVdn: Vdn, rlcJn: Jn, rlcVIl: v_Il } = this;

        for (let n = 0; n < this.rlcElements.length; n++) {
            const elem = this.rlcElements[n];
            const g = elem.direction * this.totalCells + elem.field_idx;
            const h0 = n * 3;
            const h1 = n * 3 + 1;
            const h2 = n * 3 + 2;

            Vdn[h0] = this.volt[g];

            Jn[h2] = Jn[h1];
            Jn[h1] = Jn[h0];

            if (elem.type_flag === 1) {
                const Il = v_Il[n];
                Vdn[h0] = elem.vvd * (Vdn[h0] - Il
                         + elem.vv2 * Vdn[h2]
                         + elem.vj1 * Jn[h1]
                         + elem.vj2 * Jn[h2]);

                Jn[h0] = elem.ib0 * (Vdn[h0] - Vdn[h2])
                        - elem.b1 * elem.ib0 * Jn[h1]
                        - elem.b2 * elem.ib0 * Jn[h2];

                this.volt[g] = Vdn[h0];
            }
        }
    }

    /**
     * RLC apply using ring buffer indexing.
     * Ring buffer slots: current = _rlcRingIdx, prev = (ringIdx+1)%3, prev-prev = (ringIdx+2)%3
     * For Jn, we also use a ring: advance Jn ring (same index) before writing.
     */
    _applyRLCRing() {
        const { rlcVdn: Vdn, rlcJn: Jn, rlcVIl: v_Il } = this;
        const r0 = this._rlcRingIdx;
        const r1 = (r0 + 1) % 3; // prev
        const r2 = (r0 + 2) % 3; // prev-prev

        // Jn ring also advances: new Jn current goes to r0, prev is at r1, prev-prev at r2
        // (Jn ring is advanced implicitly — we use the same ring index)

        for (let n = 0; n < this.rlcElements.length; n++) {
            const elem = this.rlcElements[n];
            const g = elem.direction * this.totalCells + elem.field_idx;
            const base = n * 3;

            Vdn[base + r0] = this.volt[g];

            // Jn: no physical shift needed, but we need prev/prev-prev
            // The old Jn[h0] from last step is now at r1, old Jn[h1] is at r2
            const Jn_prev = Jn[base + r1];
            const Jn_prevprev = Jn[base + r2];

            if (elem.type_flag === 1) {
                const Il = v_Il[n];
                Vdn[base + r0] = elem.vvd * (Vdn[base + r0] - Il
                         + elem.vv2 * Vdn[base + r2]
                         + elem.vj1 * Jn_prev
                         + elem.vj2 * Jn_prevprev);

                Jn[base + r0] = elem.ib0 * (Vdn[base + r0] - Vdn[base + r2])
                        - elem.b1 * elem.ib0 * Jn_prev
                        - elem.b2 * elem.ib0 * Jn_prevprev;

                this.volt[g] = Vdn[base + r0];
            }
        }
    }

    /**
     * @deprecated Use preVoltageRLC() + applyRLC() instead.
     */
    updateRLC() {
        this.preVoltageRLC();
        this.applyRLC();
    }

    // -----------------------------------------------------------------------
    // Mur Absorbing Boundary Condition
    // -----------------------------------------------------------------------

    /**
     * Configure Mur ABC boundary.
     * Supports per-point, per-component coefficients matching C++
     * m_Mur_Coeff_nyP(i,j) and m_Mur_Coeff_nyPP(i,j).
     *
     * Single-component (backward compatible):
     * @param {Object} config - {
     *   coeff: number|Float32Array,   // scalar (uniform) or per-point array
     *   normal_idx: Uint32Array,      // field indices at the boundary
     *   shifted_idx: Uint32Array,     // field indices one cell inward
     * }
     *
     * Dual-component (full C++ compatibility):
     * @param {Object} config - {
     *   coeff_nyP: Float32Array,       // per-point coefficients for first tangential component
     *   coeff_nyPP: Float32Array,      // per-point coefficients for second tangential component
     *   normal_idx_nyP: Uint32Array,   // field indices for nyP at boundary
     *   shifted_idx_nyP: Uint32Array,  // field indices for nyP one cell inward
     *   normal_idx_nyPP: Uint32Array,  // field indices for nyPP at boundary
     *   shifted_idx_nyPP: Uint32Array, // field indices for nyPP one cell inward
     * }
     */
    configureMur(config) {
        if (config.coeff_nyP) {
            // Dual-component mode: two tangential components per boundary face
            const n1 = config.normal_idx_nyP.length;
            const n2 = config.normal_idx_nyPP.length;
            const totalPoints = n1 + n2;

            // Concatenate into unified arrays for uniform processing
            const coeff = new Float32Array(totalPoints);
            const normal_idx = new Uint32Array(totalPoints);
            const shifted_idx = new Uint32Array(totalPoints);

            coeff.set(config.coeff_nyP, 0);
            coeff.set(config.coeff_nyPP, n1);
            normal_idx.set(config.normal_idx_nyP, 0);
            normal_idx.set(config.normal_idx_nyPP, n1);
            shifted_idx.set(config.shifted_idx_nyP, 0);
            shifted_idx.set(config.shifted_idx_nyPP, n1);

            this.murConfig = {
                coeff,
                normal_idx,
                shifted_idx,
                numPoints: totalPoints,
                saved_volt: new Float32Array(totalPoints),
                // Store split info for introspection
                numPointsNyP: n1,
                numPointsNyPP: n2,
            };
        } else {
            // Single-component mode (backward compatible)
            const numPoints = config.normal_idx.length;
            let coeff;
            if (typeof config.coeff === 'number') {
                coeff = new Float32Array(numPoints).fill(config.coeff);
            } else {
                coeff = config.coeff;
            }
            this.murConfig = {
                coeff,
                normal_idx: config.normal_idx,
                shifted_idx: config.shifted_idx,
                numPoints,
                saved_volt: new Float32Array(numPoints),
            };
        }
    }

    /**
     * Mur pre-voltage: save boundary state.
     */
    murPreVoltage() {
        if (!this.murConfig) return;
        const { coeff, normal_idx, shifted_idx, saved_volt, numPoints } = this.murConfig;

        for (let n = 0; n < numPoints; n++) {
            saved_volt[n] = this.volt[shifted_idx[n]] - coeff[n] * this.volt[normal_idx[n]];
        }
    }

    /**
     * Mur post-voltage: accumulate updated field.
     */
    murPostVoltage() {
        if (!this.murConfig) return;
        const { coeff, shifted_idx, saved_volt, numPoints } = this.murConfig;

        for (let n = 0; n < numPoints; n++) {
            saved_volt[n] += coeff[n] * this.volt[shifted_idx[n]];
        }
    }

    /**
     * Mur apply: overwrite boundary with Mur value.
     */
    murApply() {
        if (!this.murConfig) return;
        const { normal_idx, saved_volt, numPoints } = this.murConfig;

        for (let n = 0; n < numPoints; n++) {
            this.volt[normal_idx[n]] = saved_volt[n];
        }
    }

    // -----------------------------------------------------------------------
    // Steady-State Detection
    // -----------------------------------------------------------------------

    /**
     * Configure steady-state detection.
     * @param {Object} config - {
     *   probe_idx: Uint32Array,       // field indices for probe points
     *   periodSamples: number,        // samples per period
     *   threshold: number,            // convergence threshold (e.g. 1e-6)
     * }
     */
    configureSteadyState(config) {
        const numProbes = config.probe_idx.length;
        this.steadyStateConfig = {
            probe_idx: config.probe_idx,
            periodSamples: config.periodSamples,
            threshold: config.threshold || 1e-6,
            numProbes,
            currentSample: 0,
            recording: false,
            energy_period1: new Float32Array(numProbes),
            energy_period2: new Float32Array(numProbes),
        };
    }

    /**
     * Accumulate energy at probe points for steady-state detection.
     */
    accumulateEnergy() {
        if (!this.steadyStateConfig) return;
        const ss = this.steadyStateConfig;
        if (!ss.recording) return;

        for (let n = 0; n < ss.numProbes; n++) {
            const v = this.volt[ss.probe_idx[n]];
            const e = v * v;

            if (ss.currentSample < ss.periodSamples) {
                ss.energy_period1[n] += e;
            } else {
                ss.energy_period2[n] += e;
            }
        }
        ss.currentSample++;
    }

    /**
     * Check if steady-state convergence has been reached.
     * @returns {boolean} true if converged (ratio < threshold)
     */
    checkConvergence() {
        if (!this.steadyStateConfig) return false;
        const ss = this.steadyStateConfig;

        // Need both periods to be recorded
        if (ss.currentSample < 2 * ss.periodSamples) return false;

        let maxRatio = 0;
        for (let n = 0; n < ss.numProbes; n++) {
            const e1 = ss.energy_period1[n];
            const e2 = ss.energy_period2[n];
            if (Math.abs(e1) < 1e-30) continue; // avoid division by zero
            const ratio = Math.abs(e2 - e1) / Math.abs(e1);
            if (ratio > maxRatio) maxRatio = ratio;
        }
        return maxRatio < ss.threshold;
    }

    /**
     * Run one complete FDTD timestep with all extensions.
     * Order follows the priority-based execution from engine_extension.h:
     *
     * PRE-VOLTAGE:
     *   Priority +2M: Steady-state energy accumulation
     *   Priority +1M: PML pre-voltage
     *   Priority 0:   Mur pre-voltage (save boundary)
     *
     * CORE VOLTAGE UPDATE
     *
     * POST-VOLTAGE:
     *   Priority +1M: PML post-voltage
     *   Priority 0:   Lorentz/Drude ADE voltage update
     *   Priority 0:   Mur post-voltage
     *
     * APPLY TO VOLTAGES:
     *   Priority +50K: TFSF voltage injection
     *   Priority -1K:  Excitation voltage injection
     *   Priority -1K:  Mur apply (overwrite boundary)
     *   Priority -1K:  RLC voltage update
     *
     * PRE-CURRENT:
     *   Priority +1M: PML pre-current
     *
     * CORE CURRENT UPDATE
     *
     * POST-CURRENT:
     *   Priority +1M: PML post-current
     *   Lorentz/Drude ADE current update
     *
     * APPLY TO CURRENTS:
     *   Priority +50K: TFSF current injection
     *   Priority -1K:  Excitation current injection
     */
    step() {
        // === PRE-VOLTAGE ===
        this.accumulateEnergy();           // Priority +2M: steady-state
        this.preVoltageUpdatePML();        // Priority +1M: PML pre-voltage
        this.updateVoltADE();              // Priority 0: Lorentz/Drude ADE (C++ DoPreVoltageUpdates)
        this.murPreVoltage();              // Priority 0: Mur pre-voltage (C++ DoPreVoltageUpdates)
        this.preVoltageRLC();              // Priority 0: RLC history shift + v_Il (C++ DoPreVoltageUpdates)

        // === CORE VOLTAGE UPDATE ===
        this.updateVoltages();

        // === POST-VOLTAGE ===
        if (this._fusionConfig) {
            // Fused path: PML post-voltage + ADE in one pass for overlapping cells
            this._fusedPostVoltageAndADE();
            this._postVoltageUpdatePMLWithFusion();   // non-fused PML cells
            this._updateVoltADEWithFusion();          // non-fused ADE cells
        } else {
            this.postVoltageUpdatePML();   // Priority +1M: PML post-voltage
        }
        this.applyTFSFVoltage();           // Priority +50K: TFSF voltage (C++ DoPostVoltageUpdates)
        this.murPostVoltage();             // Priority 0: Mur post-voltage (C++ DoPostVoltageUpdates)

        // === APPLY TO VOLTAGES ===
        this.applyExcitation();            // Priority -1K: Excitation voltage
        this.murApply();                   // Priority 0: Mur apply (C++ Apply2Voltages)
        this.applyRLC();                   // Priority 0: RLC series update + writeback (C++ Apply2Voltages)

        // === PRE-CURRENT ===
        this.preCurrentUpdatePML();        // Priority +1M: PML pre-current
        this.updateCurrADE();              // Priority 0: Lorentz/Drude ADE current (C++ DoPreCurrentUpdates)

        // === CORE CURRENT UPDATE ===
        this.updateCurrents();

        // === POST-CURRENT ===
        this.postCurrentUpdatePML();       // Priority +1M: PML post-current
        this.applyTFSFCurrent();           // Priority +50K: TFSF current (C++ DoPostCurrentUpdates)

        // === APPLY TO CURRENTS ===
        // Excitation current injection would go here if implemented

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
     * Configure Lorentz/Drude dispersive material orders.
     */
    configureLorentz(config) {
        if (this._useGPU) {
            this._gpuEngine.configureLorentzADE(config);
        } else {
            this._cpuEngine.configureLorentz(config);
        }
    }

    /**
     * Configure TFSF plane wave injection.
     */
    configureTFSF(config) {
        if (this._useGPU) {
            this._gpuEngine.configureTFSF(config);
        } else {
            this._cpuEngine.configureTFSF(config);
        }
    }

    /**
     * Configure lumped RLC elements.
     */
    configureRLC(config) {
        if (this._useGPU) {
            this._gpuEngine.configureRLC(config);
        } else {
            this._cpuEngine.configureRLC(config);
        }
    }

    /**
     * Configure Mur ABC boundary.
     */
    configureMur(config) {
        if (this._useGPU) {
            this._gpuEngine.configureMur(config);
        } else {
            this._cpuEngine.configureMur(config);
        }
    }

    /**
     * Configure periodic boundary conditions.
     */
    configurePBC(config) {
        if (this._useGPU) {
            this._gpuEngine.configurePBC(config);
        }
        // CPU engine does not currently support PBC
    }

    /**
     * Configure steady-state detection.
     */
    configureSteadyState(config) {
        if (this._useGPU) {
            this._gpuEngine.configureSteadyState(config);
        } else {
            this._cpuEngine.configureSteadyState(config);
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
