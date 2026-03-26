// WebGPU FDTD Engine
// Implements the core FDTD update equations as WebGPU compute shaders.
// Derived from openEMS engine.cpp voltage/current update loops.

// WGSL shader source is embedded as string literals to avoid file loading.

const UPDATE_VOLTAGE_WGSL = /* wgsl */`
struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(1) var<storage, read_write> curr: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<storage, read> vv: array<f32>;
@group(1) @binding(1) var<storage, read> vi: array<f32>;

fn idx(n: u32, x: u32, y: u32, z: u32) -> u32 {
    let Ny = params.numLines.y;
    let Nz = params.numLines.z;
    return n * params.numLines.x * Ny * Nz + x * Ny * Nz + y * Nz + z;
}

fn idx_ym1(n: u32, x: u32, y: u32, z: u32) -> u32 {
    if (y == 0u) {
        return idx(n, x, y, z);
    }
    return idx(n, x, y - 1u, z);
}

fn idx_zm1(n: u32, x: u32, y: u32, z: u32) -> u32 {
    if (z == 0u) {
        return idx(n, x, y, z);
    }
    return idx(n, x, y, z - 1u);
}

fn idx_xm1(n: u32, x: u32, y: u32, z: u32) -> u32 {
    if (x == 0u) {
        return idx(n, x, y, z);
    }
    return idx(n, x - 1u, y, z);
}

@compute @workgroup_size(4, 4, 4)
fn update_voltages(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let z = gid.z;

    if (x >= params.numLines.x || y >= params.numLines.y || z >= params.numLines.z) {
        return;
    }

    let ex_idx = idx(0u, x, y, z);
    let ex_curl = curr[idx(2u, x, y, z)] - curr[idx_ym1(2u, x, y, z)]
                - curr[idx(1u, x, y, z)] + curr[idx_zm1(1u, x, y, z)];
    volt[ex_idx] = vv[ex_idx] * volt[ex_idx] + vi[ex_idx] * ex_curl;

    let ey_idx = idx(1u, x, y, z);
    let ey_curl = curr[idx(0u, x, y, z)] - curr[idx_zm1(0u, x, y, z)]
                - curr[idx(2u, x, y, z)] + curr[idx_xm1(2u, x, y, z)];
    volt[ey_idx] = vv[ey_idx] * volt[ey_idx] + vi[ey_idx] * ey_curl;

    let ez_idx = idx(2u, x, y, z);
    let ez_curl = curr[idx(1u, x, y, z)] - curr[idx_xm1(1u, x, y, z)]
                - curr[idx(0u, x, y, z)] + curr[idx_ym1(0u, x, y, z)];
    volt[ez_idx] = vv[ez_idx] * volt[ez_idx] + vi[ez_idx] * ez_curl;
}
`;

const UPDATE_CURRENT_WGSL = /* wgsl */`
struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(1) var<storage, read_write> curr: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(2) @binding(0) var<storage, read> ii_coeff: array<f32>;
@group(2) @binding(1) var<storage, read> iv_coeff: array<f32>;

fn idx(n: u32, x: u32, y: u32, z: u32) -> u32 {
    let Ny = params.numLines.y;
    let Nz = params.numLines.z;
    return n * params.numLines.x * Ny * Nz + x * Ny * Nz + y * Nz + z;
}

@compute @workgroup_size(4, 4, 4)
fn update_currents(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let z = gid.z;

    // X is also Nx-1 because Hy/Hz curl stencils read volt at x+1.
    if (x >= params.numLines.x - 1u || y >= params.numLines.y - 1u || z >= params.numLines.z - 1u) {
        return;
    }

    let hx_idx = idx(0u, x, y, z);
    let hx_curl = volt[idx(2u, x, y, z)] - volt[idx(2u, x, y + 1u, z)]
                - volt[idx(1u, x, y, z)] + volt[idx(1u, x, y, z + 1u)];
    curr[hx_idx] = ii_coeff[hx_idx] * curr[hx_idx] + iv_coeff[hx_idx] * hx_curl;

    let hy_idx = idx(1u, x, y, z);
    let hy_curl = volt[idx(0u, x, y, z)] - volt[idx(0u, x, y, z + 1u)]
                - volt[idx(2u, x, y, z)] + volt[idx(2u, x + 1u, y, z)];
    curr[hy_idx] = ii_coeff[hy_idx] * curr[hy_idx] + iv_coeff[hy_idx] * hy_curl;

    let hz_idx = idx(2u, x, y, z);
    let hz_curl = volt[idx(1u, x, y, z)] - volt[idx(1u, x + 1u, y, z)]
                - volt[idx(0u, x, y, z)] + volt[idx(0u, x, y + 1u, z)];
    curr[hz_idx] = ii_coeff[hz_idx] * curr[hz_idx] + iv_coeff[hz_idx] * hz_curl;
}
`;

const UPDATE_PML_WGSL = /* wgsl */`
struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct PMLParams {
    startPos: vec3<u32>,
    mode: u32,
    numLines: vec3<u32>,
    _pad: u32,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(1) var<storage, read_write> curr: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(3) @binding(0) var<uniform> pml: PMLParams;
@group(3) @binding(1) var<storage, read_write> volt_flux: array<f32>;
@group(3) @binding(2) var<storage, read_write> curr_flux: array<f32>;
@group(3) @binding(3) var<storage, read> pml_vv: array<f32>;
@group(3) @binding(4) var<storage, read> pml_vvfo: array<f32>;
@group(3) @binding(5) var<storage, read> pml_vvfn: array<f32>;
@group(3) @binding(6) var<storage, read> pml_ii: array<f32>;
@group(3) @binding(7) var<storage, read> pml_iifo: array<f32>;
@group(3) @binding(8) var<storage, read> pml_iifn: array<f32>;

fn idx(n: u32, x: u32, y: u32, z: u32) -> u32 {
    let Ny = params.numLines.y;
    let Nz = params.numLines.z;
    return n * params.numLines.x * Ny * Nz + x * Ny * Nz + y * Nz + z;
}

fn pml_idx(n: u32, lx: u32, ly: u32, lz: u32) -> u32 {
    let Ny = pml.numLines.y;
    let Nz = pml.numLines.z;
    return n * pml.numLines.x * Ny * Nz + lx * Ny * Nz + ly * Nz + lz;
}

@compute @workgroup_size(4, 4, 4)
fn update_pml(@builtin(global_invocation_id) gid: vec3<u32>) {
    let lx = gid.x;
    let ly = gid.y;
    let lz = gid.z;

    if (lx >= pml.numLines.x || ly >= pml.numLines.y || lz >= pml.numLines.z) {
        return;
    }

    let gx = lx + pml.startPos.x;
    let gy = ly + pml.startPos.y;
    let gz = lz + pml.startPos.z;

    let mode = pml.mode;

    for (var n = 0u; n < 3u; n++) {
        let p = pml_idx(n, lx, ly, lz);
        let g = idx(n, gx, gy, gz);

        if (mode == 0u) {
            let f_help = pml_vv[p] * volt[g] - pml_vvfo[p] * volt_flux[p];
            volt[g] = volt_flux[p];
            volt_flux[p] = f_help;
        } else if (mode == 1u) {
            let f_help = volt_flux[p];
            volt_flux[p] = volt[g];
            volt[g] = f_help + pml_vvfn[p] * volt_flux[p];
        } else if (mode == 2u) {
            let f_help = pml_ii[p] * curr[g] - pml_iifo[p] * curr_flux[p];
            curr[g] = curr_flux[p];
            curr_flux[p] = f_help;
        } else if (mode == 3u) {
            let f_help = curr_flux[p];
            curr_flux[p] = curr[g];
            curr[g] = f_help + pml_iifn[p] * curr_flux[p];
        }
    }
}
`;

const EXCITATION_WGSL = /* wgsl */`
struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct ExcParams {
    numTS: u32,
    signalLength: u32,
    period: u32,
    numExcitations: u32,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(1) var<storage, read_write> curr: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(4) @binding(0) var<uniform> exc: ExcParams;
@group(4) @binding(1) var<storage, read> signal: array<f32>;
@group(4) @binding(2) var<storage, read> delay: array<u32>;
@group(4) @binding(3) var<storage, read> amp: array<f32>;
@group(4) @binding(4) var<storage, read> dir: array<u32>;
@group(4) @binding(5) var<storage, read> pos: array<u32>;

@compute @workgroup_size(256)
fn apply_excitation(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= exc.numExcitations) {
        return;
    }

    var exc_pos: i32 = i32(exc.numTS) - i32(delay[n]);
    if (exc_pos < 0) {
        exc_pos = 0;
    }
    if (exc.period > 0u) {
        exc_pos = exc_pos % i32(exc.period);
    }
    if (exc_pos >= i32(exc.signalLength)) {
        return;
    }

    let component_offset = dir[n] * params.numLines.x * params.numLines.y * params.numLines.z;
    let field_idx = component_offset + pos[n];
    volt[field_idx] = volt[field_idx] + amp[n] * signal[u32(exc_pos)];
}
`;

const LORENTZ_ADE_WGSL = /* wgsl */`
struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct ADEParams {
    numCells: u32,
    hasLorentz: u32,
    direction: u32,
    componentStride: u32,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> ade: ADEParams;
@group(1) @binding(1) var<storage, read_write> volt_ADE: array<f32>;
@group(1) @binding(2) var<storage, read_write> volt_Lor_ADE: array<f32>;
@group(1) @binding(3) var<storage, read> v_int_ADE: array<f32>;
@group(1) @binding(4) var<storage, read> v_ext_ADE: array<f32>;
@group(1) @binding(5) var<storage, read> v_Lor_ADE: array<f32>;
@group(1) @binding(6) var<storage, read> pos_idx: array<u32>;

@compute @workgroup_size(256)
fn update_volt_ade(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= ade.numCells) {
        return;
    }

    let field_idx = ade.direction * ade.componentStride + pos_idx[i];
    let V = volt[field_idx];

    if (ade.hasLorentz == 1u) {
        volt_Lor_ADE[i] += v_Lor_ADE[i] * volt_ADE[i];
        volt_ADE[i] = v_int_ADE[i] * volt_ADE[i]
                     + v_ext_ADE[i] * (V - volt_Lor_ADE[i]);
    } else {
        volt_ADE[i] = v_int_ADE[i] * volt_ADE[i]
                     + v_ext_ADE[i] * V;
    }
}
`;

const TFSF_WGSL = /* wgsl */`
struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct TFSFParams {
    numTS: u32,
    period: u32,
    signalLength: u32,
    numLowerPoints: u32,
    numUpperPoints: u32,
    _pad: vec3<u32>,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> tfsf: TFSFParams;
@group(1) @binding(1) var<storage, read> signal: array<f32>;
@group(1) @binding(2) var<storage, read> delay_int: array<u32>;
@group(1) @binding(3) var<storage, read> delay_frac: array<f32>;
@group(1) @binding(4) var<storage, read> amp: array<f32>;
@group(1) @binding(5) var<storage, read> field_idx: array<u32>;

@compute @workgroup_size(256)
fn tfsf_apply_voltage(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    let totalPoints = tfsf.numLowerPoints + tfsf.numUpperPoints;
    if (n >= totalPoints) {
        return;
    }

    var d: i32 = i32(tfsf.numTS) - i32(delay_int[n]);
    if (d < 0) {
        return;
    }
    if (tfsf.period > 0u) {
        d = d % i32(tfsf.period);
    }
    if (d >= i32(tfsf.signalLength) - 1) {
        return;
    }

    let delta = delay_frac[n];
    let sig = (1.0 - delta) * signal[u32(d)] + delta * signal[u32(d) + 1u];

    volt[field_idx[n]] += amp[n] * sig;
}
`;

const LUMPED_RLC_WGSL = /* wgsl */`
struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct RLCParams {
    numElements: u32,
    componentStride: u32,
    _pad: vec2<u32>,
};

struct RLCElement {
    field_idx: u32,
    direction: u32,
    type_flag: u32,
    i2v: f32,
    ilv: f32,
    vvd: f32,
    vv2: f32,
    vj1: f32,
    vj2: f32,
    ib0: f32,
    b1: f32,
    b2: f32,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> rlc: RLCParams;
@group(1) @binding(1) var<storage, read> elements: array<RLCElement>;
@group(1) @binding(2) var<storage, read_write> Vdn: array<f32>;
@group(1) @binding(3) var<storage, read_write> Jn: array<f32>;
@group(1) @binding(4) var<storage, read_write> v_Il: array<f32>;

@compute @workgroup_size(256)
fn update_rlc(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= rlc.numElements) {
        return;
    }

    let elem = elements[n];
    let g = elem.direction * rlc.componentStride + elem.field_idx;

    let h0 = n * 3u;
    let h1 = n * 3u + 1u;
    let h2 = n * 3u + 2u;

    Vdn[h2] = Vdn[h1];
    Vdn[h1] = Vdn[h0];
    Jn[h2] = Jn[h1];
    Jn[h1] = Jn[h0];

    Vdn[h0] = volt[g];

    if (elem.type_flag == 0u) {
        v_Il[n] += elem.i2v * elem.ilv * Vdn[h1];
    } else {
        let Il = v_Il[n];
        Vdn[h0] = elem.vvd * (Vdn[h0] - Il
                 + elem.vv2 * Vdn[h2]
                 + elem.vj1 * Jn[h1]
                 + elem.vj2 * Jn[h2]);

        Jn[h0] = elem.ib0 * (Vdn[h0] - Vdn[h2])
                - elem.b1 * elem.ib0 * Jn[h1]
                - elem.b2 * elem.ib0 * Jn[h2];

        volt[g] = Vdn[h0];
    }
}
`;

const MUR_ABC_WGSL = /* wgsl */`
struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct MurParams {
    numPoints: u32,
    _pad: vec3<u32>,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> mur: MurParams;
@group(1) @binding(1) var<storage, read> normal_idx: array<u32>;
@group(1) @binding(2) var<storage, read> shifted_idx: array<u32>;
@group(1) @binding(3) var<storage, read_write> saved_volt: array<f32>;
@group(1) @binding(4) var<storage, read> coeff: array<f32>;

@compute @workgroup_size(256)
fn mur_pre_voltage(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= mur.numPoints) {
        return;
    }
    saved_volt[n] = volt[shifted_idx[n]] - coeff[n] * volt[normal_idx[n]];
}

@compute @workgroup_size(256)
fn mur_post_voltage(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= mur.numPoints) {
        return;
    }
    saved_volt[n] += coeff[n] * volt[shifted_idx[n]];
}

@compute @workgroup_size(256)
fn mur_apply(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= mur.numPoints) {
        return;
    }
    volt[normal_idx[n]] = saved_volt[n];
}
`;

const STEADY_STATE_WGSL = /* wgsl */`
struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct SSParams {
    numProbes: u32,
    periodSamples: u32,
    currentSample: u32,
    recording: u32,
};

@group(0) @binding(0) var<storage, read> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> ss: SSParams;
@group(1) @binding(1) var<storage, read> probe_idx: array<u32>;
@group(1) @binding(2) var<storage, read_write> energy_period1: array<f32>;
@group(1) @binding(3) var<storage, read_write> energy_period2: array<f32>;

@compute @workgroup_size(256)
fn accumulate_energy(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= ss.numProbes || ss.recording == 0u) {
        return;
    }

    let v = volt[probe_idx[n]];
    let e = v * v;

    if (ss.currentSample < ss.periodSamples) {
        energy_period1[n] += e;
    } else {
        energy_period2[n] += e;
    }
}
`;

/**
 * WebGPU FDTD Engine.
 *
 * Manages GPU buffers for field arrays and operator coefficients,
 * creates compute pipelines, and dispatches the FDTD update kernels.
 */
export class WebGPUEngine {
    constructor() {
        this.device = null;
        this.adapter = null;
        this.numLines = null; // [Nx, Ny, Nz]
        this.numTS = 0;
        this.totalCells = 0;

        // GPU buffers
        this.voltBuffer = null;
        this.currBuffer = null;
        this.vvBuffer = null;
        this.viBuffer = null;
        this.iiBuffer = null;
        this.ivBuffer = null;
        this.paramsBuffer = null;

        // PML buffers and state
        this.pmlRegions = [];       // array of { buffers, dispatch, ... }
        this.pmlPipeline = null;
        this.pmlConfigured = false;

        // Excitation buffers
        this.excParamsBuffer = null;
        this.excSignalBuffer = null;
        this.excDelayBuffer = null;
        this.excAmpBuffer = null;
        this.excDirBuffer = null;
        this.excPosBuffer = null;
        this.excitationConfigured = false;

        // Pipelines
        this.voltagePipeline = null;
        this.currentPipeline = null;
        this.excitationPipeline = null;

        // Bind groups
        this.coreBindGroup = null;
        this.voltCoeffBindGroup = null;
        this.currCoeffBindGroup = null;
        this.excBindGroup = null;

        // Workgroup size constants
        this.WG_SIZE_3D = [4, 4, 4];
        this.WG_SIZE_EXC = 256;
    }

    /**
     * Initialize WebGPU adapter and device.
     * @returns {Promise<boolean>} true if WebGPU is available
     */
    async initGPU() {
        if (typeof navigator === 'undefined' || !navigator.gpu) {
            return false;
        }

        this.adapter = await navigator.gpu.requestAdapter({
            powerPreference: 'high-performance',
        });
        if (!this.adapter) {
            return false;
        }

        this.device = await this.adapter.requestDevice({
            requiredLimits: {
                maxStorageBufferBindingSize: this.adapter.limits.maxStorageBufferBindingSize,
                maxBufferSize: this.adapter.limits.maxBufferSize,
                maxComputeWorkgroupsPerDimension: this.adapter.limits.maxComputeWorkgroupsPerDimension,
            },
        });

        this.device.lost.then((info) => {
            console.error('WebGPU device lost:', info.message);
        });

        return true;
    }

    /**
     * Initialize the engine with grid dimensions and operator coefficients.
     *
     * @param {number[]} gridSize - [Nx, Ny, Nz] grid dimensions
     * @param {object} coefficients - { vv, vi, ii, iv } Float32Arrays of size 3*Nx*Ny*Nz
     */
    async init(gridSize, coefficients) {
        if (!this.device) {
            throw new Error('WebGPU device not initialized. Call initGPU() first.');
        }

        this.numLines = gridSize;
        const [Nx, Ny, Nz] = gridSize;
        this.totalCells = Nx * Ny * Nz;
        const bufferSize = 3 * this.totalCells * 4; // 3 components * cells * f32
        this.numTS = 0;

        // Create field buffers (read-write, initially zeroed)
        this.voltBuffer = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        this.currBuffer = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });

        // Create coefficient buffers (read-only after upload)
        this.vvBuffer = this._createAndUploadBuffer(coefficients.vv, GPUBufferUsage.STORAGE);
        this.viBuffer = this._createAndUploadBuffer(coefficients.vi, GPUBufferUsage.STORAGE);
        this.iiBuffer = this._createAndUploadBuffer(coefficients.ii, GPUBufferUsage.STORAGE);
        this.ivBuffer = this._createAndUploadBuffer(coefficients.iv, GPUBufferUsage.STORAGE);

        // Create uniform buffer for grid params
        // Layout: vec3<u32> numLines (12 bytes) + u32 numTS (4) + vec3<i32> shift (12) + u32 pad (4) = 32 bytes
        this.paramsBuffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._updateParams();

        // Create compute pipelines
        await this._createPipelines();

        // Create bind groups
        this._createBindGroups();
    }

    /**
     * Configure excitation sources.
     *
     * @param {object} excitation - {
     *   signal: Float32Array,    // excitation signal waveform
     *   delay: Uint32Array,      // delay for each excitation point
     *   amp: Float32Array,       // amplitude for each excitation point
     *   dir: Uint32Array,        // component direction (0,1,2) per point
     *   pos: Uint32Array,        // packed linear position per point (x*Ny*Nz + y*Nz + z)
     *   period: number,          // signal period (0 = non-periodic)
     * }
     */
    configureExcitation(excitation) {
        if (!this.device) {
            throw new Error('WebGPU device not initialized.');
        }

        const numExc = excitation.amp.length;

        // ExcParams uniform: 4 x u32 = 16 bytes
        this.excParamsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.excSignalBuffer = this._createAndUploadBuffer(excitation.signal, GPUBufferUsage.STORAGE);
        this.excDelayBuffer = this._createAndUploadBuffer(excitation.delay, GPUBufferUsage.STORAGE);
        this.excAmpBuffer = this._createAndUploadBuffer(excitation.amp, GPUBufferUsage.STORAGE);
        this.excDirBuffer = this._createAndUploadBuffer(excitation.dir, GPUBufferUsage.STORAGE);
        this.excPosBuffer = this._createAndUploadBuffer(excitation.pos, GPUBufferUsage.STORAGE);

        this._excSignalLength = excitation.signal.length;
        this._excPeriod = excitation.period || 0;
        this._excCount = numExc;

        this.excitationConfigured = true;

        // Recreate excitation bind group
        this._createExcitationBindGroup();
    }

    /**
     * Configure PML regions for absorbing boundary conditions.
     *
     * @param {Object[]} pmlRegions - array of PML region configs, each with:
     *   startPos, numLines, vv, vvfo, vvfn, ii, iifo, iifn (Float32Arrays)
     */
    configurePML(pmlRegions) {
        if (!this.device) {
            throw new Error('WebGPU device not initialized.');
        }

        this.pmlRegions = pmlRegions.map(region => {
            const [nx, ny, nz] = region.numLines;
            const pmlTotal = 3 * nx * ny * nz;
            const fluxSize = pmlTotal * 4; // bytes

            // PML params uniform: 8 x u32 = 32 bytes
            // startPos(3) + mode(1) + numLines(3) + pad(1)
            const pmlParamsBuffer = this.device.createBuffer({
                size: 32,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });

            const voltFluxBuffer = this.device.createBuffer({
                size: fluxSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            });
            const currFluxBuffer = this.device.createBuffer({
                size: fluxSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            });

            const vvBuffer = this._createAndUploadBuffer(region.vv, GPUBufferUsage.STORAGE);
            const vvfoBuffer = this._createAndUploadBuffer(region.vvfo, GPUBufferUsage.STORAGE);
            const vvfnBuffer = this._createAndUploadBuffer(region.vvfn, GPUBufferUsage.STORAGE);
            const iiBuffer = this._createAndUploadBuffer(region.ii, GPUBufferUsage.STORAGE);
            const iifoBuffer = this._createAndUploadBuffer(region.iifo, GPUBufferUsage.STORAGE);
            const iifnBuffer = this._createAndUploadBuffer(region.iifn, GPUBufferUsage.STORAGE);

            // Create PML bind group
            const bindGroup = this.device.createBindGroup({
                layout: this.pmlPipeline.getBindGroupLayout(3),
                entries: [
                    { binding: 0, resource: { buffer: pmlParamsBuffer } },
                    { binding: 1, resource: { buffer: voltFluxBuffer } },
                    { binding: 2, resource: { buffer: currFluxBuffer } },
                    { binding: 3, resource: { buffer: vvBuffer } },
                    { binding: 4, resource: { buffer: vvfoBuffer } },
                    { binding: 5, resource: { buffer: vvfnBuffer } },
                    { binding: 6, resource: { buffer: iiBuffer } },
                    { binding: 7, resource: { buffer: iifoBuffer } },
                    { binding: 8, resource: { buffer: iifnBuffer } },
                ],
            });

            const [wgX, wgY, wgZ] = this.WG_SIZE_3D;
            return {
                startPos: region.startPos,
                numLines: region.numLines,
                pmlParamsBuffer,
                voltFluxBuffer,
                currFluxBuffer,
                buffers: [vvBuffer, vvfoBuffer, vvfnBuffer, iiBuffer, iifoBuffer, iifnBuffer],
                bindGroup,
                dispatch: [
                    Math.ceil(nx / wgX),
                    Math.ceil(ny / wgY),
                    Math.ceil(nz / wgZ),
                ],
            };
        });

        this.pmlConfigured = true;
    }

    /**
     * Dispatch the PML compute shader for a given mode and region.
     * @param {GPUCommandEncoder} encoder
     * @param {number} mode - 0=pre-volt, 1=post-volt, 2=pre-curr, 3=post-curr
     */
    stepPML(encoder, mode) {
        if (!this.pmlConfigured) return;

        for (const region of this.pmlRegions) {
            // Update PML params uniform with current mode
            const data = new Uint32Array(8);
            data[0] = region.startPos[0];
            data[1] = region.startPos[1];
            data[2] = region.startPos[2];
            data[3] = mode;
            data[4] = region.numLines[0];
            data[5] = region.numLines[1];
            data[6] = region.numLines[2];
            data[7] = 0; // pad
            this.device.queue.writeBuffer(region.pmlParamsBuffer, 0, data);

            const pass = encoder.beginComputePass();
            pass.setPipeline(this.pmlPipeline);
            pass.setBindGroup(0, this.coreBindGroup);
            pass.setBindGroup(3, region.bindGroup);
            pass.dispatchWorkgroups(...region.dispatch);
            pass.end();
        }
    }

    /**
     * Dispatch the voltage (E-field) update compute shader.
     * @param {GPUCommandEncoder} [encoder] - optional shared encoder
     * @returns {GPUCommandEncoder} the encoder used
     */
    stepVoltage(encoder) {
        const enc = encoder || this.device.createCommandEncoder();
        const [Nx, Ny, Nz] = this.numLines;
        const [wgX, wgY, wgZ] = this.WG_SIZE_3D;

        const pass = enc.beginComputePass();
        pass.setPipeline(this.voltagePipeline);
        pass.setBindGroup(0, this.coreBindGroup);
        pass.setBindGroup(1, this.voltCoeffBindGroup);
        pass.dispatchWorkgroups(
            Math.ceil(Nx / wgX),
            Math.ceil(Ny / wgY),
            Math.ceil(Nz / wgZ),
        );
        pass.end();

        if (!encoder) {
            this.device.queue.submit([enc.finish()]);
        }
        return enc;
    }

    /**
     * Dispatch the current (H-field) update compute shader.
     * @param {GPUCommandEncoder} [encoder] - optional shared encoder
     * @returns {GPUCommandEncoder} the encoder used
     */
    stepCurrent(encoder) {
        const enc = encoder || this.device.createCommandEncoder();
        const [Nx, Ny, Nz] = this.numLines;
        const [wgX, wgY, wgZ] = this.WG_SIZE_3D;

        const pass = enc.beginComputePass();
        pass.setPipeline(this.currentPipeline);
        pass.setBindGroup(0, this.coreBindGroup);
        pass.setBindGroup(2, this.currCoeffBindGroup);
        pass.dispatchWorkgroups(
            Math.ceil(Math.max(Nx - 1, 1) / wgX),
            Math.ceil(Math.max(Ny - 1, 1) / wgY),
            Math.ceil(Math.max(Nz - 1, 1) / wgZ),
        );
        pass.end();

        if (!encoder) {
            this.device.queue.submit([enc.finish()]);
        }
        return enc;
    }

    /**
     * Dispatch the excitation injection compute shader.
     * @param {GPUCommandEncoder} [encoder] - optional shared encoder
     * @returns {GPUCommandEncoder} the encoder used
     */
    applyExcitation(encoder) {
        if (!this.excitationConfigured) return encoder;

        const enc = encoder || this.device.createCommandEncoder();

        // Update excitation params with current timestep
        this._updateExcParams();

        const pass = enc.beginComputePass();
        pass.setPipeline(this.excitationPipeline);
        pass.setBindGroup(0, this.coreBindGroup);
        pass.setBindGroup(4, this.excBindGroup);
        pass.dispatchWorkgroups(
            Math.ceil(this._excCount / this.WG_SIZE_EXC),
            1,
            1,
        );
        pass.end();

        if (!encoder) {
            this.device.queue.submit([enc.finish()]);
        }
        return enc;
    }

    /**
     * Run N complete FDTD timesteps.
     * Each timestep: voltage update -> excitation -> current update -> increment numTS.
     *
     * @param {number} numSteps - number of timesteps to run
     */
    async iterate(numSteps) {
        const BATCH_SIZE = 32;
        const commandBuffers = [];

        for (let step = 0; step < numSteps; step++) {
            const encoder = this.device.createCommandEncoder();

            this.stepPML(encoder, 0); // pre-voltage PML
            this.stepVoltage(encoder);
            this.stepPML(encoder, 1); // post-voltage PML

            if (this.excitationConfigured) {
                this.applyExcitation(encoder);
            }

            this.stepPML(encoder, 2); // pre-current PML
            this.stepCurrent(encoder);
            this.stepPML(encoder, 3); // post-current PML

            commandBuffers.push(encoder.finish());
            this.numTS++;
            this._updateParams();

            if (this.excitationConfigured) {
                this._updateExcParams();
            }

            if (commandBuffers.length >= BATCH_SIZE || step === numSteps - 1) {
                this.device.queue.submit(commandBuffers);
                commandBuffers.length = 0;
            }
        }

        await this.device.queue.onSubmittedWorkDone();
    }

    /**
     * Read field values at specific grid positions back to CPU.
     *
     * @param {Array<{component: number, x: number, y: number, z: number}>} positions
     * @returns {Promise<Float32Array>} field values at requested positions
     */
    async readProbe(positions) {
        const fields = await this.getFields();
        const voltData = fields.volt;
        const currData = fields.curr;

        const [Nx, Ny, Nz] = this.numLines;
        const results = new Float32Array(positions.length * 2); // volt + curr per position

        for (let i = 0; i < positions.length; i++) {
            const { component: n, x, y, z } = positions[i];
            const linearIdx = n * Nx * Ny * Nz + x * Ny * Nz + y * Nz + z;
            results[i * 2] = voltData[linearIdx];
            results[i * 2 + 1] = currData[linearIdx];
        }
        return results;
    }

    /**
     * Read all field data back from GPU to CPU.
     * @returns {Promise<{volt: Float32Array, curr: Float32Array}>}
     */
    async getFields() {
        const bufferSize = 3 * this.totalCells * 4;

        // Read voltage data
        const voltData = await this._readBuffer(this.voltBuffer, bufferSize);

        // Read current data
        const currData = await this._readBuffer(this.currBuffer, bufferSize);

        return {
            volt: new Float32Array(voltData),
            curr: new Float32Array(currData),
        };
    }

    /**
     * Upload field data to GPU (for restoring state or testing).
     * @param {Float32Array} volt - voltage field data
     * @param {Float32Array} curr - current field data
     */
    uploadFields(volt, curr) {
        this.device.queue.writeBuffer(this.voltBuffer, 0, volt);
        this.device.queue.writeBuffer(this.currBuffer, 0, curr);
    }

    /**
     * Destroy all GPU resources.
     */
    destroy() {
        const buffers = [
            this.voltBuffer, this.currBuffer,
            this.vvBuffer, this.viBuffer, this.iiBuffer, this.ivBuffer,
            this.paramsBuffer,
            this.excParamsBuffer, this.excSignalBuffer,
            this.excDelayBuffer, this.excAmpBuffer,
            this.excDirBuffer, this.excPosBuffer,
        ];
        for (const buf of buffers) {
            if (buf) buf.destroy();
        }
        // Destroy PML buffers
        for (const region of this.pmlRegions) {
            if (region.pmlParamsBuffer) region.pmlParamsBuffer.destroy();
            if (region.voltFluxBuffer) region.voltFluxBuffer.destroy();
            if (region.currFluxBuffer) region.currFluxBuffer.destroy();
            for (const buf of (region.buffers || [])) {
                if (buf) buf.destroy();
            }
        }
        if (this.device) {
            this.device.destroy();
        }
    }

    // --- Private helpers ---

    _createAndUploadBuffer(data, usage) {
        const buffer = this.device.createBuffer({
            size: data.byteLength,
            usage: usage | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        const mapped = buffer.getMappedRange();
        if (data instanceof Float32Array) {
            new Float32Array(mapped).set(data);
        } else if (data instanceof Uint32Array) {
            new Uint32Array(mapped).set(data);
        } else {
            new Uint8Array(mapped).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
        buffer.unmap();
        return buffer;
    }

    async _readBuffer(gpuBuffer, size) {
        // Create a temporary readback buffer each time since we cannot
        // mapAsync a buffer that is already mapped.
        const readback = this.device.createBuffer({
            size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(gpuBuffer, 0, readback, 0, size);
        this.device.queue.submit([encoder.finish()]);

        await readback.mapAsync(GPUMapMode.READ);
        const data = readback.getMappedRange().slice(0);
        readback.unmap();
        readback.destroy();
        return data;
    }

    _updateParams() {
        // Params struct: vec3<u32> numLines (12) + u32 numTS (4) + vec3<i32> shift (12) + u32 _pad (4) = 32
        const data = new ArrayBuffer(32);
        const u32View = new Uint32Array(data);
        const i32View = new Int32Array(data);
        u32View[0] = this.numLines[0]; // Nx
        u32View[1] = this.numLines[1]; // Ny
        u32View[2] = this.numLines[2]; // Nz
        u32View[3] = this.numTS;
        i32View[4] = 0; // shift x
        i32View[5] = 0; // shift y
        i32View[6] = 0; // shift z
        u32View[7] = 0; // padding
        this.device.queue.writeBuffer(this.paramsBuffer, 0, data);
    }

    _updateExcParams() {
        // ExcParams struct: 4 x u32 = 16 bytes
        const data = new Uint32Array(4);
        data[0] = this.numTS;
        data[1] = this._excSignalLength;
        data[2] = this._excPeriod;
        data[3] = this._excCount;
        this.device.queue.writeBuffer(this.excParamsBuffer, 0, data);
    }

    async _createPipelines() {
        // Voltage update pipeline
        const voltShaderModule = this.device.createShaderModule({
            code: UPDATE_VOLTAGE_WGSL,
        });
        this.voltagePipeline = await this.device.createComputePipelineAsync({
            layout: 'auto',
            compute: {
                module: voltShaderModule,
                entryPoint: 'update_voltages',
            },
        });

        // Current update pipeline
        const currShaderModule = this.device.createShaderModule({
            code: UPDATE_CURRENT_WGSL,
        });
        this.currentPipeline = await this.device.createComputePipelineAsync({
            layout: 'auto',
            compute: {
                module: currShaderModule,
                entryPoint: 'update_currents',
            },
        });

        // PML pipeline
        const pmlShaderModule = this.device.createShaderModule({
            code: UPDATE_PML_WGSL,
        });
        this.pmlPipeline = await this.device.createComputePipelineAsync({
            layout: 'auto',
            compute: {
                module: pmlShaderModule,
                entryPoint: 'update_pml',
            },
        });

        // Excitation pipeline
        const excShaderModule = this.device.createShaderModule({
            code: EXCITATION_WGSL,
        });
        this.excitationPipeline = await this.device.createComputePipelineAsync({
            layout: 'auto',
            compute: {
                module: excShaderModule,
                entryPoint: 'apply_excitation',
            },
        });
    }

    _createBindGroups() {
        // Bind Group 0: Core FDTD (shared by E and H shaders)
        this.coreBindGroup = this.device.createBindGroup({
            layout: this.voltagePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.voltBuffer } },
                { binding: 1, resource: { buffer: this.currBuffer } },
                { binding: 2, resource: { buffer: this.paramsBuffer } },
            ],
        });

        // Bind Group 1: Voltage coefficients
        this.voltCoeffBindGroup = this.device.createBindGroup({
            layout: this.voltagePipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: { buffer: this.vvBuffer } },
                { binding: 1, resource: { buffer: this.viBuffer } },
            ],
        });

        // Bind Group 2: Current coefficients
        this.currCoeffBindGroup = this.device.createBindGroup({
            layout: this.currentPipeline.getBindGroupLayout(2),
            entries: [
                { binding: 0, resource: { buffer: this.iiBuffer } },
                { binding: 1, resource: { buffer: this.ivBuffer } },
            ],
        });
    }

    _createExcitationBindGroup() {
        this.excBindGroup = this.device.createBindGroup({
            layout: this.excitationPipeline.getBindGroupLayout(4),
            entries: [
                { binding: 0, resource: { buffer: this.excParamsBuffer } },
                { binding: 1, resource: { buffer: this.excSignalBuffer } },
                { binding: 2, resource: { buffer: this.excDelayBuffer } },
                { binding: 3, resource: { buffer: this.excAmpBuffer } },
                { binding: 4, resource: { buffer: this.excDirBuffer } },
                { binding: 5, resource: { buffer: this.excPosBuffer } },
            ],
        });
    }
}

// Export shader sources for testing/validation
export {
    UPDATE_VOLTAGE_WGSL, UPDATE_CURRENT_WGSL, UPDATE_PML_WGSL, EXCITATION_WGSL,
    LORENTZ_ADE_WGSL, TFSF_WGSL, LUMPED_RLC_WGSL, MUR_ABC_WGSL, STEADY_STATE_WGSL,
};
