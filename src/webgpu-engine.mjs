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

@compute @workgroup_size(4, 4, 4)
fn update_voltages(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let z = gid.z;
    let numLines = params.numLines;

    if (x >= numLines.x || y >= numLines.y || z >= numLines.z) {
        return;
    }

    let planeStride = params.numLines.y * params.numLines.z;
    let componentStride = params.numLines.x * planeStride;
    let baseIndex = x * planeStride + y * numLines.z + z;

    let exIdx = baseIndex;
    let eyIdx = componentStride + baseIndex;
    let ezIdx = 2u * componentStride + baseIndex;

    let hxIdx = baseIndex;
    let hyIdx = componentStride + baseIndex;
    let hzIdx = 2u * componentStride + baseIndex;

    let hzYm1Idx = select(hzIdx - numLines.z, hzIdx, y == 0u);
    let hyZm1Idx = select(hyIdx - 1u, hyIdx, z == 0u);
    let exCurl = curr[hzIdx] - curr[hzYm1Idx]
               - curr[hyIdx] + curr[hyZm1Idx];
    volt[exIdx] = vv[exIdx] * volt[exIdx] + vi[exIdx] * exCurl;

    let hxZm1Idx = select(hxIdx - 1u, hxIdx, z == 0u);
    let hzXm1Idx = select(hzIdx - planeStride, hzIdx, x == 0u);
    let eyCurl = curr[hxIdx] - curr[hxZm1Idx]
               - curr[hzIdx] + curr[hzXm1Idx];
    volt[eyIdx] = vv[eyIdx] * volt[eyIdx] + vi[eyIdx] * eyCurl;

    let hyXm1Idx = select(hyIdx - planeStride, hyIdx, x == 0u);
    let hxYm1Idx = select(hxIdx - numLines.z, hxIdx, y == 0u);
    let ezCurl = curr[hyIdx] - curr[hyXm1Idx]
               - curr[hxIdx] + curr[hxYm1Idx];
    volt[ezIdx] = vv[ezIdx] * volt[ezIdx] + vi[ezIdx] * ezCurl;
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

@compute @workgroup_size(4, 4, 4)
fn update_currents(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let z = gid.z;
    let numLines = params.numLines;

    // X is also Nx-1 because Hy/Hz curl stencils read volt at x+1.
    if (x >= numLines.x - 1u || y >= numLines.y - 1u || z >= numLines.z - 1u) {
        return;
    }

    let planeStride = params.numLines.y * params.numLines.z;
    let componentStride = params.numLines.x * planeStride;
    let baseIndex = x * planeStride + y * numLines.z + z;

    let exIdx = baseIndex;
    let eyIdx = componentStride + baseIndex;
    let ezIdx = 2u * componentStride + baseIndex;

    let hxIdx = baseIndex;
    let hyIdx = componentStride + baseIndex;
    let hzIdx = 2u * componentStride + baseIndex;

    let ezYp1Idx = ezIdx + numLines.z;
    let eyZp1Idx = eyIdx + 1u;
    let hxCurl = volt[ezIdx] - volt[ezYp1Idx]
               - volt[eyIdx] + volt[eyZp1Idx];
    curr[hxIdx] = ii_coeff[hxIdx] * curr[hxIdx] + iv_coeff[hxIdx] * hxCurl;

    let exZp1Idx = exIdx + 1u;
    let ezXp1Idx = ezIdx + planeStride;
    let hyCurl = volt[exIdx] - volt[exZp1Idx]
               - volt[ezIdx] + volt[ezXp1Idx];
    curr[hyIdx] = ii_coeff[hyIdx] * curr[hyIdx] + iv_coeff[hyIdx] * hyCurl;

    let eyXp1Idx = eyIdx + planeStride;
    let exYp1Idx = exIdx + numLines.z;
    let hzCurl = volt[eyIdx] - volt[eyXp1Idx]
               - volt[exIdx] + volt[exYp1Idx];
    curr[hzIdx] = ii_coeff[hzIdx] * curr[hzIdx] + iv_coeff[hzIdx] * hzCurl;
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

@group(1) @binding(0) var<uniform> exc: ExcParams;
@group(1) @binding(1) var<storage, read> signal: array<f32>;
@group(1) @binding(2) var<storage, read> delay: array<u32>;
@group(1) @binding(3) var<storage, read> amp: array<f32>;
@group(1) @binding(4) var<storage, read> dir: array<u32>;
@group(1) @binding(5) var<storage, read> pos: array<u32>;

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
struct MurParams {
    numPoints: u32,
    _pad: vec3<u32>,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;

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

const PBC_COPY_WGSL = /* wgsl */`
struct PBCParams {
    axis: u32,
    mode: u32,
    srcFaceIdx: u32,
    dstFaceIdx: u32,
    faceSize0: u32,
    faceSize1: u32,
    cosPhase: f32,
    sinPhase: f32,
    numLinesX: u32,
    numLinesY: u32,
    numLinesZ: u32,
    imagOffset: u32,
    solverBound0: u32,
    solverBound1: u32,
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(1) var<storage, read_write> curr: array<f32>;

@group(1) @binding(0) var<uniform> pbc: PBCParams;
@group(1) @binding(1) var<storage, read_write> imag_buf: array<f32>;

fn field_idx(n: u32, x: u32, y: u32, z: u32) -> u32 {
    let Ny = pbc.numLinesY;
    let Nz = pbc.numLinesZ;
    return n * pbc.numLinesX * Ny * Nz + x * Ny * Nz + y * Nz + z;
}

fn face_to_grid(axis: u32, faceIdx: u32, i0: u32, i1: u32) -> vec3<u32> {
    var pos: vec3<u32>;
    if (axis == 0u) {
        pos = vec3<u32>(faceIdx, i0, i1);
    } else if (axis == 1u) {
        pos = vec3<u32>(i1, faceIdx, i0);
    } else {
        pos = vec3<u32>(i0, i1, faceIdx);
    }
    return pos;
}

@compute @workgroup_size(8, 8)
fn pbc_copy(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i0 = gid.x;
    let i1 = gid.y;

    if (i0 >= pbc.solverBound0 || i1 >= pbc.solverBound1) {
        return;
    }

    let axis = pbc.axis;
    let tang0 = (axis + 1u) % 3u;
    let tang1 = (axis + 2u) % 3u;

    let srcPos = face_to_grid(axis, pbc.srcFaceIdx, i0, i1);
    let dstPos = face_to_grid(axis, pbc.dstFaceIdx, i0, i1);

    let faceLinear = i0 * pbc.faceSize1 + i1;

    if (pbc.mode == 0u) {
        let srcIdx0 = field_idx(tang0, srcPos.x, srcPos.y, srcPos.z);
        let dstIdx0 = field_idx(tang0, dstPos.x, dstPos.y, dstPos.z);
        let srcIdx1 = field_idx(tang1, srcPos.x, srcPos.y, srcPos.z);
        let dstIdx1 = field_idx(tang1, dstPos.x, dstPos.y, dstPos.z);

        if (pbc.sinPhase == 0.0) {
            volt[dstIdx0] = pbc.cosPhase * volt[srcIdx0];
            volt[dstIdx1] = pbc.cosPhase * volt[srcIdx1];
        } else {
            let imOff0 = pbc.imagOffset + faceLinear;
            let imOff1 = pbc.imagOffset + pbc.faceSize0 * pbc.faceSize1 + faceLinear;
            let srcReal0 = volt[srcIdx0];
            let srcImag0 = imag_buf[imOff0];
            volt[dstIdx0] = pbc.cosPhase * srcReal0 - pbc.sinPhase * srcImag0;
            imag_buf[imOff0] = pbc.sinPhase * srcReal0 + pbc.cosPhase * srcImag0;

            let srcReal1 = volt[srcIdx1];
            let srcImag1 = imag_buf[imOff1];
            volt[dstIdx1] = pbc.cosPhase * srcReal1 - pbc.sinPhase * srcImag1;
            imag_buf[imOff1] = pbc.sinPhase * srcReal1 + pbc.cosPhase * srcImag1;
        }
    } else {
        let srcIdx0 = field_idx(tang0, srcPos.x, srcPos.y, srcPos.z);
        let dstIdx0 = field_idx(tang0, dstPos.x, dstPos.y, dstPos.z);
        let srcIdx1 = field_idx(tang1, srcPos.x, srcPos.y, srcPos.z);
        let dstIdx1 = field_idx(tang1, dstPos.x, dstPos.y, dstPos.z);

        if (pbc.sinPhase == 0.0) {
            curr[dstIdx0] = pbc.cosPhase * curr[srcIdx0];
            curr[dstIdx1] = pbc.cosPhase * curr[srcIdx1];
        } else {
            let imBase = pbc.imagOffset + 2u * pbc.faceSize0 * pbc.faceSize1;
            let imOff0 = imBase + faceLinear;
            let imOff1 = imBase + pbc.faceSize0 * pbc.faceSize1 + faceLinear;
            let srcReal0 = curr[srcIdx0];
            let srcImag0 = imag_buf[imOff0];
            curr[dstIdx0] = pbc.cosPhase * srcReal0 - pbc.sinPhase * srcImag0;
            imag_buf[imOff0] = pbc.sinPhase * srcReal0 + pbc.cosPhase * srcImag0;

            let srcReal1 = curr[srcIdx1];
            let srcImag1 = imag_buf[imOff1];
            curr[dstIdx1] = pbc.cosPhase * srcReal1 - pbc.sinPhase * srcImag1;
            imag_buf[imOff1] = pbc.sinPhase * srcReal1 + pbc.cosPhase * srcImag1;
        }
    }
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

function apply3DWorkgroupSize(code, workgroupSize) {
    const [wgX, wgY, wgZ] = workgroupSize;
    return code.replace(
        '@compute @workgroup_size(4, 4, 4)',
        `@compute @workgroup_size(${wgX}, ${wgY}, ${wgZ})`,
    );
}

const PML_WORKGROUP_SIZE_3D = [4, 4, 4];

const NF2FF_ACCUMULATE_WGSL = /* wgsl */`
struct NF2FFParams {
    numTS: u32,
    numPoints: u32,
    Nx: u32,
    Ny: u32,
    Nz: u32,
    // Edge length buffer offsets: [primalX, primalY, primalZ, dualX, dualY, dualZ]
    elOffPX: u32,
    elOffPY: u32,
    elOffPZ: u32,
    elOffDX: u32,
    elOffDY: u32,
    elOffDZ: u32,
    _pad0: u32,
    omega: f32,
    dT: f32,
    maxTS: u32,
    windowType: u32,
    windowNorm: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32,
};

@group(0) @binding(0) var<storage, read> volt: array<f32>;
@group(0) @binding(1) var<storage, read> curr: array<f32>;
@group(0) @binding(2) var<uniform> nf2ffParams: NF2FFParams;
@group(0) @binding(3) var<storage, read> points: array<u32>;
@group(0) @binding(4) var<storage, read_write> accumE: array<f32>;
@group(0) @binding(5) var<storage, read_write> accumH: array<f32>;
@group(0) @binding(6) var<storage, read> edgeLens: array<f32>;

// Get linear field index for position (x,y,z)
fn fieldIdx(x: u32, y: u32, z: u32) -> u32 {
    return x * nf2ffParams.Ny * nf2ffParams.Nz + y * nf2ffParams.Nz + z;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pid = gid.x;
    if (pid >= nf2ffParams.numPoints) { return; }

    let ix = points[pid * 3u];
    let iy = points[pid * 3u + 1u];
    let iz = points[pid * 3u + 2u];

    let Nx = nf2ffParams.Nx;
    let Ny = nf2ffParams.Ny;
    let Nz = nf2ffParams.Nz;
    let compStride = Nx * Ny * Nz;
    let base = fieldIdx(ix, iy, iz);

    // --- E-field: CELL_INTERPOLATE (average of 4 neighbors in nP,nPP plane) ---
    // E_n = average of volt[n] at 4 positions / primalEdgeLen[n][pos_n]
    // If at last grid line in ANY direction, E = 0.
    let atBoundary = (ix >= Nx - 1u) || (iy >= Ny - 1u) || (iz >= Nz - 1u);

    var Ex: f32 = 0.0;
    var Ey: f32 = 0.0;
    var Ez: f32 = 0.0;

    if (!atBoundary) {
        // Ex: nP=y, nPP=z → average at (iy,iz), (iy+1,iz), (iy+1,iz+1), (iy,iz+1)
        let elX = edgeLens[nf2ffParams.elOffPX + ix];
        Ex = (volt[base] + volt[fieldIdx(ix, iy+1u, iz)]
            + volt[fieldIdx(ix, iy+1u, iz+1u)] + volt[fieldIdx(ix, iy, iz+1u)])
            / (4.0 * elX);

        // Ey: nP=z, nPP=x → average at (iz,ix), (iz+1,ix), (iz+1,ix+1), (iz,ix+1)
        let elY = edgeLens[nf2ffParams.elOffPY + iy];
        Ey = (volt[compStride + base] + volt[compStride + fieldIdx(ix, iy, iz+1u)]
            + volt[compStride + fieldIdx(ix+1u, iy, iz+1u)] + volt[compStride + fieldIdx(ix+1u, iy, iz)])
            / (4.0 * elY);

        // Ez: nP=x, nPP=y → average at (ix,iy), (ix+1,iy), (ix+1,iy+1), (ix,iy+1)
        let elZ = edgeLens[nf2ffParams.elOffPZ + iz];
        Ez = (volt[2u*compStride + base] + volt[2u*compStride + fieldIdx(ix+1u, iy, iz)]
            + volt[2u*compStride + fieldIdx(ix+1u, iy+1u, iz)] + volt[2u*compStride + fieldIdx(ix, iy+1u, iz)])
            / (4.0 * elZ);
    }

    // --- H-field: CELL_INTERPOLATE (linear interpolation along n direction) ---
    // H_n = lerp(curr[n][pos]/dualEl[pos_n], curr[n][pos+n]/dualEl[pos_n+1], deltaRel)
    // deltaRel = dualEl[pos_n] / (dualEl[pos_n] + dualEl[pos_n+1])
    var Hx: f32 = 0.0;
    var Hy: f32 = 0.0;
    var Hz: f32 = 0.0;

    // Hx: interpolate along x
    let dxEl0 = edgeLens[nf2ffParams.elOffDX + ix];
    if (dxEl0 > 0.0) {
        Hx = curr[base] / dxEl0;
        if (ix < Nx - 1u) {
            let dxEl1 = edgeLens[nf2ffParams.elOffDX + ix + 1u];
            let dr = dxEl0 / (dxEl0 + dxEl1);
            let HxUp = curr[fieldIdx(ix+1u, iy, iz)] / dxEl1;
            Hx = Hx * (1.0 - dr) + HxUp * dr;
        }
    }

    // Hy: interpolate along y
    let dyEl0 = edgeLens[nf2ffParams.elOffDY + iy];
    if (dyEl0 > 0.0) {
        Hy = curr[compStride + base] / dyEl0;
        if (iy < Ny - 1u) {
            let dyEl1 = edgeLens[nf2ffParams.elOffDY + iy + 1u];
            let dr = dyEl0 / (dyEl0 + dyEl1);
            let HyUp = curr[compStride + fieldIdx(ix, iy+1u, iz)] / dyEl1;
            Hy = Hy * (1.0 - dr) + HyUp * dr;
        }
    }

    // Hz: interpolate along z
    let dzEl0 = edgeLens[nf2ffParams.elOffDZ + iz];
    if (dzEl0 > 0.0) {
        Hz = curr[2u*compStride + base] / dzEl0;
        if (iz < Nz - 1u) {
            let dzEl1 = edgeLens[nf2ffParams.elOffDZ + iz + 1u];
            let dr = dzEl0 / (dzEl0 + dzEl1);
            let HzUp = curr[2u*compStride + fieldIdx(ix, iy, iz+1u)] / dzEl1;
            Hz = Hz * (1.0 - dr) + HzUp * dr;
        }
    }

    // --- DFT accumulation ---
    let omega = nf2ffParams.omega;
    let dT = nf2ffParams.dT;
    let ts = f32(nf2ffParams.numTS);

    // Windowed DFT: apply window function to suppress spectral leakage (e.g. PBC)
    var window_w: f32 = 1.0;
    if (nf2ffParams.windowType == 1u && nf2ffParams.maxTS > 1u) {
        let n_f = f32(nf2ffParams.numTS);
        let N_f = f32(nf2ffParams.maxTS - 1u);
        window_w = 0.5 * (1.0 - cos(2.0 * 3.14159265358979 * n_f / N_f));
    }
    let wdT = window_w * nf2ffParams.windowNorm * dT;

    // E at numTS * dT, H at (numTS + 0.5) * dT
    let phase_e = omega * ts * dT;
    let cos_e = cos(phase_e);
    let sin_e = sin(phase_e);
    let phase_h = omega * (ts + 0.5) * dT;
    let cos_h = cos(phase_h);
    let sin_h = sin(phase_h);

    let base_e = pid * 6u;
    accumE[base_e + 0u] += Ex * cos_e * wdT;
    accumE[base_e + 1u] += Ex * (-sin_e) * wdT;
    accumE[base_e + 2u] += Ey * cos_e * wdT;
    accumE[base_e + 3u] += Ey * (-sin_e) * wdT;
    accumE[base_e + 4u] += Ez * cos_e * wdT;
    accumE[base_e + 5u] += Ez * (-sin_e) * wdT;

    let base_h = pid * 6u;
    accumH[base_h + 0u] += Hx * cos_h * wdT;
    accumH[base_h + 1u] += Hx * (-sin_h) * wdT;
    accumH[base_h + 2u] += Hy * cos_h * wdT;
    accumH[base_h + 3u] += Hy * (-sin_h) * wdT;
    accumH[base_h + 4u] += Hz * cos_h * wdT;
    accumH[base_h + 5u] += Hz * (-sin_h) * wdT;
}
`;

const NF2FF_FARFIELD_WGSL = /* wgsl */`
struct FarFieldParams {
    numPoints: u32,
    nTheta: u32,
    nPhi: u32,
    _pad0: u32,
    k: f32,
    Z0: f32,
    radius: f32,
    _pad1: f32,
    centerX: f32,
    centerY: f32,
    centerZ: f32,
    _pad2: f32,
    fac_re: f32,
    fac_im: f32,
    _pad3: f32,
    _pad4: f32,
};

@group(0) @binding(0) var<storage, read> accumE: array<f32>;
@group(0) @binding(1) var<storage, read> accumH: array<f32>;
@group(0) @binding(2) var<storage, read> pointMeta: array<f32>;
@group(0) @binding(3) var<storage, read> thetaArr: array<f32>;
@group(0) @binding(4) var<storage, read> phiArr: array<f32>;
@group(0) @binding(5) var<uniform> params: FarFieldParams;
@group(0) @binding(6) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let angleIdx = gid.x;
    let totalAngles = params.nTheta * params.nPhi;
    if (angleIdx >= totalAngles) { return; }

    let thetaIdx = angleIdx / params.nPhi;
    let phiIdx = angleIdx % params.nPhi;
    let theta = thetaArr[thetaIdx];
    let phi = phiArr[phiIdx];

    let sinT = sin(theta);
    let cosT = cos(theta);
    let sinP = sin(phi);
    let cosP = cos(phi);
    let cosT_cosP = cosT * cosP;
    let cosT_sinP = cosT * sinP;
    let sinT_cosP = sinT * cosP;
    let sinT_sinP = sinT * sinP;

    var Nt_re: f32 = 0.0;
    var Nt_im: f32 = 0.0;
    var Np_re: f32 = 0.0;
    var Np_im: f32 = 0.0;
    var Lt_re: f32 = 0.0;
    var Lt_im: f32 = 0.0;
    var Lp_re: f32 = 0.0;
    var Lp_im: f32 = 0.0;

    let numPts = params.numPoints;
    let k = params.k;
    let cX = params.centerX;
    let cY = params.centerY;
    let cZ = params.centerZ;

    for (var pid: u32 = 0u; pid < numPts; pid = pid + 1u) {
        let metaBase = pid * 8u;
        let posX = pointMeta[metaBase + 0u];
        let posY = pointMeta[metaBase + 1u];
        let posZ = pointMeta[metaBase + 2u];
        let normalDir = u32(pointMeta[metaBase + 3u]);
        let normSign = pointMeta[metaBase + 4u];
        let area = pointMeta[metaBase + 5u];

        let eBase = pid * 6u;
        let Ex_re = accumE[eBase + 0u];
        let Ex_im = accumE[eBase + 1u];
        let Ey_re = accumE[eBase + 2u];
        let Ey_im = accumE[eBase + 3u];
        let Ez_re = accumE[eBase + 4u];
        let Ez_im = accumE[eBase + 5u];

        let hBase = pid * 6u;
        let Hx_re = accumH[hBase + 0u];
        let Hx_im = accumH[hBase + 1u];
        let Hy_re = accumH[hBase + 2u];
        let Hy_im = accumH[hBase + 3u];
        let Hz_re = accumH[hBase + 4u];
        let Hz_im = accumH[hBase + 5u];

        // Js = n x H,  Ms = -n x E
        var Js_x_re: f32 = 0.0; var Js_x_im: f32 = 0.0;
        var Js_y_re: f32 = 0.0; var Js_y_im: f32 = 0.0;
        var Js_z_re: f32 = 0.0; var Js_z_im: f32 = 0.0;
        var Ms_x_re: f32 = 0.0; var Ms_x_im: f32 = 0.0;
        var Ms_y_re: f32 = 0.0; var Ms_y_im: f32 = 0.0;
        var Ms_z_re: f32 = 0.0; var Ms_z_im: f32 = 0.0;

        if (normalDir == 0u) {
            // x-normal: n = normSign * e_x
            // Js = n x H: Js_y = -normSign*Hz, Js_z = normSign*Hy
            Js_y_re = -normSign * Hz_re; Js_y_im = -normSign * Hz_im;
            Js_z_re = normSign * Hy_re; Js_z_im = normSign * Hy_im;
            // Ms = -n x E: Ms_y = normSign*Ez, Ms_z = -normSign*Ey
            Ms_y_re = normSign * Ez_re; Ms_y_im = normSign * Ez_im;
            Ms_z_re = -normSign * Ey_re; Ms_z_im = -normSign * Ey_im;
        } else if (normalDir == 1u) {
            // y-normal: n = normSign * e_y
            // Js = n x H: Js_x = normSign*Hz, Js_z = -normSign*Hx
            Js_x_re = normSign * Hz_re; Js_x_im = normSign * Hz_im;
            Js_z_re = -normSign * Hx_re; Js_z_im = -normSign * Hx_im;
            // Ms = -n x E: Ms_x = -normSign*Ez, Ms_z = normSign*Ex
            Ms_x_re = -normSign * Ez_re; Ms_x_im = -normSign * Ez_im;
            Ms_z_re = normSign * Ex_re; Ms_z_im = normSign * Ex_im;
        } else {
            // z-normal: n = normSign * e_z
            // Js = n x H: Js_x = -normSign*Hy, Js_y = normSign*Hx
            Js_x_re = -normSign * Hy_re; Js_x_im = -normSign * Hy_im;
            Js_y_re = normSign * Hx_re; Js_y_im = normSign * Hx_im;
            // Ms = -n x E: Ms_x = normSign*Ey, Ms_y = -normSign*Ex
            Ms_x_re = normSign * Ey_re; Ms_x_im = normSign * Ey_im;
            Ms_y_re = -normSign * Ex_re; Ms_y_im = -normSign * Ex_im;
        }

        // Phase factor
        let r_cos_psi = (posX - cX) * sinT_cosP + (posY - cY) * sinT_sinP + (posZ - cZ) * cosT;
        let phase = k * r_cos_psi;
        let exp_re = cos(phase);
        let exp_im = sin(phase);
        let areaExp_re = area * exp_re;
        let areaExp_im = area * exp_im;

        // Spherical projections
        let Js_t_re = Js_x_re * cosT_cosP + Js_y_re * cosT_sinP - Js_z_re * sinT;
        let Js_t_im = Js_x_im * cosT_cosP + Js_y_im * cosT_sinP - Js_z_im * sinT;
        let Js_p_re = Js_y_re * cosP - Js_x_re * sinP;
        let Js_p_im = Js_y_im * cosP - Js_x_im * sinP;

        let Ms_t_re = Ms_x_re * cosT_cosP + Ms_y_re * cosT_sinP - Ms_z_re * sinT;
        let Ms_t_im = Ms_x_im * cosT_cosP + Ms_y_im * cosT_sinP - Ms_z_im * sinT;
        let Ms_p_re = Ms_y_re * cosP - Ms_x_re * sinP;
        let Ms_p_im = Ms_y_im * cosP - Ms_x_im * sinP;

        // Complex multiply: areaExp * Js_t -> Nt
        Nt_re += areaExp_re * Js_t_re - areaExp_im * Js_t_im;
        Nt_im += areaExp_re * Js_t_im + areaExp_im * Js_t_re;

        Np_re += areaExp_re * Js_p_re - areaExp_im * Js_p_im;
        Np_im += areaExp_re * Js_p_im + areaExp_im * Js_p_re;

        Lt_re += areaExp_re * Ms_t_re - areaExp_im * Ms_t_im;
        Lt_im += areaExp_re * Ms_t_im + areaExp_im * Ms_t_re;

        Lp_re += areaExp_re * Ms_p_re - areaExp_im * Ms_p_im;
        Lp_im += areaExp_re * Ms_p_im + areaExp_im * Ms_p_re;
    }

    // Compute E_theta, E_phi, P_rad
    let fac_re = params.fac_re;
    let fac_im = params.fac_im;
    let fZ0 = params.Z0;

    // E_theta = -factor * (Lp + Z0*Nt)
    let LpZ0Nt_re = Lp_re + fZ0 * Nt_re;
    let LpZ0Nt_im = Lp_im + fZ0 * Nt_im;
    let Et_re = -(fac_re * LpZ0Nt_re - fac_im * LpZ0Nt_im);
    let Et_im = -(fac_re * LpZ0Nt_im + fac_im * LpZ0Nt_re);

    // E_phi = factor * (Lt - Z0*Np)
    let LtZ0Np_re = Lt_re - fZ0 * Np_re;
    let LtZ0Np_im = Lt_im - fZ0 * Np_im;
    let Ep_re = fac_re * LtZ0Np_re - fac_im * LtZ0Np_im;
    let Ep_im = fac_re * LtZ0Np_im + fac_im * LtZ0Np_re;

    // P_rad = (|E_theta|^2 + |E_phi|^2) / (2 * Z0)
    let Et_mag2 = Et_re * Et_re + Et_im * Et_im;
    let Ep_mag2 = Ep_re * Ep_re + Ep_im * Ep_im;
    let P_rad = (Et_mag2 + Ep_mag2) / (2.0 * fZ0);

    let outBase = angleIdx * 5u;
    output[outBase + 0u] = P_rad;
    output[outBase + 1u] = Et_re;
    output[outBase + 2u] = Et_im;
    output[outBase + 3u] = Ep_re;
    output[outBase + 4u] = Ep_im;
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

        // Lorentz ADE state
        this.adeOrders = [];          // array of { pipeline, directions: [{ bindGroup, dispatch }] }
        this.adeCurrOrders = [];      // current ADE orders (separate pipeline)
        this.adeConfigured = false;

        // TFSF state
        this.tfsfVoltPipeline = null;
        this.tfsfCurrPipeline = null;
        this.tfsfVoltBindGroup = null;
        this.tfsfCurrBindGroup = null;
        this.tfsfParamsBuffer = null;
        this.tfsfConfigured = false;

        // RLC state
        this.rlcPipeline = null;
        this.rlcBindGroup = null;
        this.rlcConfigured = false;

        // Mur ABC state
        this.murPrePipeline = null;
        this.murPostPipeline = null;
        this.murApplyPipeline = null;
        this.murBindGroup = null;
        this.murConfigured = false;

        // PBC state
        this.pbcPipeline = null;
        this.pbcVoltRegions = [];   // array of { bindGroup, dispatch }
        this.pbcCurrRegions = [];   // array of { bindGroup, dispatch }
        this.pbcConfigured = false;
        this._pbcBuffers = [];

        // NF2FF FD accumulation state
        this._nf2ffPipeline = null;
        this._nf2ffBindGroup = null;
        this._nf2ffParamsBuffer = null;
        this._nf2ffPointsBuffer = null;
        this._nf2ffAccumEBuffer = null;
        this._nf2ffAccumHBuffer = null;
        this._nf2ffNumPoints = 0;
        this._nf2ffOmega = 0;
        this._nf2ffDT = 0;

        // Steady-state state
        this.ssPipeline = null;
        this.ssBindGroup = null;
        this.ssParamsBuffer = null;
        this.ssConfigured = false;
        this.ssCurrentSample = 0;
        this.ssRecording = false;

        // Pipelines
        this.voltagePipeline = null;
        this.currentPipeline = null;
        this.excitationPipeline = null;

        // Bind groups
        // Core bind groups are pre-created for the active buffers/pipelines and
        // lazily extended only for alternate binding signatures.
        this.voltCoeffBindGroup = null;
        this.currCoeffBindGroup = null;
        this.excBindGroup = null;

        // Workgroup size constants
        this.WG_SIZE_3D = [4, 1, 16];
        this.WG_SIZE_3D_VOLTAGE = null;
        this.WG_SIZE_3D_CURRENT = null;
        this.WG_SIZE_EXC = 256;

        this._shaderModuleCache = new Map();
        this._computePipelineCache = new Map();
        this._coreBindGroupCache = new Map();
        this._cacheDevice = null;
        this._lastParamsTS = null;
        this._lastExcParamsTS = null;
        this._lastTFSFParamsTS = null;
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
                maxStorageBuffersPerShaderStage: this.adapter.limits.maxStorageBuffersPerShaderStage,
                maxBindGroups: this.adapter.limits.maxBindGroups,
            },
        });

        this.device.lost.then((info) => {
            console.error('WebGPU device lost:', info.message);
        });
        this._invalidatePipelineCaches();

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
        this._lastParamsTS = null;
        this._coreBindGroupCache.clear();

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
        this._lastExcParamsTS = null;

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
            // Create one params buffer per mode (0-3) to avoid writeBuffer race:
            // writeBuffer is a queue operation that executes before the command buffer,
            // so multiple writeBuffer calls to the same buffer within a single
            // command encoder would all resolve to the last-written value.
            const pmlParamsBuffers = [];
            for (let mode = 0; mode < 4; mode++) {
                const buf = this.device.createBuffer({
                    size: 32,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                // Pre-write the static fields; mode will be written at dispatch time
                const data = new Uint32Array(8);
                data[0] = region.startPos[0];
                data[1] = region.startPos[1];
                data[2] = region.startPos[2];
                data[3] = mode;
                data[4] = region.numLines[0];
                data[5] = region.numLines[1];
                data[6] = region.numLines[2];
                data[7] = 0; // pad
                this.device.queue.writeBuffer(buf, 0, data);
                pmlParamsBuffers.push(buf);
            }

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

            // Create one PML bind group per mode (each references its own params buffer)
            const bindGroups = pmlParamsBuffers.map(paramsBuf =>
                this.device.createBindGroup({
                    layout: this.pmlPipeline.getBindGroupLayout(3),
                    entries: [
                        { binding: 0, resource: { buffer: paramsBuf } },
                        { binding: 1, resource: { buffer: voltFluxBuffer } },
                        { binding: 2, resource: { buffer: currFluxBuffer } },
                        { binding: 3, resource: { buffer: vvBuffer } },
                        { binding: 4, resource: { buffer: vvfoBuffer } },
                        { binding: 5, resource: { buffer: vvfnBuffer } },
                        { binding: 6, resource: { buffer: iiBuffer } },
                        { binding: 7, resource: { buffer: iifoBuffer } },
                        { binding: 8, resource: { buffer: iifnBuffer } },
                    ],
                })
            );

            const [wgX, wgY, wgZ] = PML_WORKGROUP_SIZE_3D;
            return {
                startPos: region.startPos,
                numLines: region.numLines,
                pmlParamsBuffers,
                voltFluxBuffer,
                currFluxBuffer,
                buffers: [vvBuffer, vvfoBuffer, vvfnBuffer, iiBuffer, iifoBuffer, iifnBuffer],
                bindGroups,
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

        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pmlPipeline);
        pass.setBindGroup(0, this._coreBindGroupFor(this.pmlPipeline));
        for (const region of this.pmlRegions) {
            // Use the pre-created bind group for this mode.
            // Each mode has its own params buffer with the mode value baked in,
            // avoiding the writeBuffer race condition where multiple writeBuffer
            // calls to the same buffer within a single command encoder all
            // resolve to the last-written value.
            pass.setBindGroup(3, region.bindGroups[mode]);
            pass.dispatchWorkgroups(...region.dispatch);
        }
        pass.end();
    }

    // -----------------------------------------------------------------------
    // Lorentz ADE Extension
    // -----------------------------------------------------------------------

    /**
     * Configure Lorentz/Drude ADE for GPU.
     * Each order+direction becomes a separate dispatch.
     *
     * @param {Object} config - same as CPUFDTDEngine.configureLorentz()
     */
    configureLorentzADE(config) {
        if (!this.device) throw new Error('WebGPU device not initialized.');

        // Voltage ADE pipeline (reuses the embedded LORENTZ_ADE_WGSL which has update_volt_ade)
        const voltAdePipeline = this._getOrCreateComputePipeline(
            LORENTZ_ADE_WGSL,
            'update_volt_ade'
        );

        // Current ADE pipeline — same shader structure but operates on curr buffer.
        // We reuse the same shader code but with a separate bind group pointing to curr.
        const currAdePipeline = this._getOrCreateComputePipeline(
            LORENTZ_ADE_WGSL,
            'update_volt_ade'
        );

        this.adeOrders = [];
        this.adeCurrOrders = [];

        for (const order of config.orders) {
            const voltDirs = [];
            const currDirs = [];

            for (const d of order.directions) {
                const numCells = order.numCells;

                // ADE params uniform: 4 x u32 = 16 bytes
                const adeParamsBuffer = this.device.createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                const adeParamsData = new Uint32Array([numCells, order.hasLorentz ? 1 : 0, d.dir, this.totalCells]);
                this.device.queue.writeBuffer(adeParamsBuffer, 0, adeParamsData);

                // Voltage ADE state buffers
                const voltADEBuf = this.device.createBuffer({
                    size: Math.max(numCells * 4, 4),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
                });
                const voltLorADEBuf = this.device.createBuffer({
                    size: Math.max(numCells * 4, 4),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
                });

                const vIntBuf = this._createAndUploadBuffer(d.v_int_ADE, GPUBufferUsage.STORAGE);
                const vExtBuf = this._createAndUploadBuffer(d.v_ext_ADE, GPUBufferUsage.STORAGE);
                const vLorBuf = this._createAndUploadBuffer(
                    d.v_Lor_ADE || new Float32Array(numCells), GPUBufferUsage.STORAGE);
                const posIdxBuf = this._createAndUploadBuffer(d.pos_idx, GPUBufferUsage.STORAGE);

                const voltBindGroup = this.device.createBindGroup({
                    layout: voltAdePipeline.getBindGroupLayout(1),
                    entries: [
                        { binding: 0, resource: { buffer: adeParamsBuffer } },
                        { binding: 1, resource: { buffer: voltADEBuf } },
                        { binding: 2, resource: { buffer: voltLorADEBuf } },
                        { binding: 3, resource: { buffer: vIntBuf } },
                        { binding: 4, resource: { buffer: vExtBuf } },
                        { binding: 5, resource: { buffer: vLorBuf } },
                        { binding: 6, resource: { buffer: posIdxBuf } },
                    ],
                });

                voltDirs.push({
                    bindGroup: voltBindGroup,
                    dispatch: Math.ceil(numCells / this.WG_SIZE_EXC),
                    buffers: [adeParamsBuffer, voltADEBuf, voltLorADEBuf, vIntBuf, vExtBuf, vLorBuf, posIdxBuf],
                });

                // Current ADE — same layout, different coefficient buffers
                const adeParamsBufferC = this.device.createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                this.device.queue.writeBuffer(adeParamsBufferC, 0, adeParamsData);

                const currADEBuf = this.device.createBuffer({
                    size: Math.max(numCells * 4, 4),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
                });
                const currLorADEBuf = this.device.createBuffer({
                    size: Math.max(numCells * 4, 4),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
                });

                const iIntBuf = this._createAndUploadBuffer(
                    d.i_int_ADE || new Float32Array(numCells), GPUBufferUsage.STORAGE);
                const iExtBuf = this._createAndUploadBuffer(
                    d.i_ext_ADE || new Float32Array(numCells), GPUBufferUsage.STORAGE);
                const iLorBuf = this._createAndUploadBuffer(
                    d.i_Lor_ADE || new Float32Array(numCells), GPUBufferUsage.STORAGE);

                const currBindGroup = this.device.createBindGroup({
                    layout: currAdePipeline.getBindGroupLayout(1),
                    entries: [
                        { binding: 0, resource: { buffer: adeParamsBufferC } },
                        { binding: 1, resource: { buffer: currADEBuf } },
                        { binding: 2, resource: { buffer: currLorADEBuf } },
                        { binding: 3, resource: { buffer: iIntBuf } },
                        { binding: 4, resource: { buffer: iExtBuf } },
                        { binding: 5, resource: { buffer: iLorBuf } },
                        { binding: 6, resource: { buffer: posIdxBuf } },
                    ],
                });

                currDirs.push({
                    bindGroup: currBindGroup,
                    dispatch: Math.ceil(numCells / this.WG_SIZE_EXC),
                    buffers: [adeParamsBufferC, currADEBuf, currLorADEBuf, iIntBuf, iExtBuf, iLorBuf],
                });
            }

            this.adeOrders.push({ pipeline: voltAdePipeline, directions: voltDirs });
            this.adeCurrOrders.push({ pipeline: currAdePipeline, directions: currDirs });
        }

        this.adeConfigured = true;
    }

    /**
     * Dispatch voltage ADE updates.
     * @param {GPUCommandEncoder} encoder
     */
    stepVoltADE(encoder) {
        if (!this.adeConfigured) return;
        const pass = encoder.beginComputePass();
        for (const order of this.adeOrders) {
            pass.setPipeline(order.pipeline);
            pass.setBindGroup(0, this._coreBindGroupFor(order.pipeline));
            for (const d of order.directions) {
                pass.setBindGroup(1, d.bindGroup);
                pass.dispatchWorkgroups(d.dispatch, 1, 1);
            }
        }
        pass.end();
    }

    /**
     * Dispatch current ADE updates.
     * @param {GPUCommandEncoder} encoder
     */
    stepCurrADE(encoder) {
        if (!this.adeConfigured) return;
        const pass = encoder.beginComputePass();
        for (const order of this.adeCurrOrders) {
            pass.setPipeline(order.pipeline);
            pass.setBindGroup(0, this._coreBindGroupFor(order.pipeline));
            for (const d of order.directions) {
                pass.setBindGroup(1, d.bindGroup);
                pass.dispatchWorkgroups(d.dispatch, 1, 1);
            }
        }
        pass.end();
    }

    // -----------------------------------------------------------------------
    // TFSF Extension
    // -----------------------------------------------------------------------

    /**
     * Configure TFSF plane wave injection for GPU.
     *
     * @param {Object} config - {
     *   signal: Float32Array,
     *   period: number,
     *   voltagePoints: Array<{ field_idx, delay_int, delay_frac, amp }>,
     *   currentPoints: Array<{ field_idx, delay_int, delay_frac, amp }>,
     * }
     */
    configureTFSF(config) {
        if (!this.device) throw new Error('WebGPU device not initialized.');

        const signalBuf = this._createAndUploadBuffer(config.signal, GPUBufferUsage.STORAGE);
        this._tfsfSignalLength = config.signal.length;
        this._tfsfPeriod = config.period || 0;

        // TFSF params uniform: 8 x u32 = 32 bytes
        this.tfsfParamsBuffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Voltage points
        const voltPts = config.voltagePoints || [];
        const currPts = config.currentPoints || [];
        this._tfsfNumVoltPoints = voltPts.length;
        this._tfsfNumCurrPoints = currPts.length;
        this._lastTFSFParamsTS = null;

        // Combine lower (voltage) and upper (current) points for the voltage shader
        const allVoltPts = voltPts;
        if (allVoltPts.length > 0) {
            const delayIntArr = new Uint32Array(allVoltPts.length);
            const delayFracArr = new Float32Array(allVoltPts.length);
            const ampArr = new Float32Array(allVoltPts.length);
            const fieldIdxArr = new Uint32Array(allVoltPts.length);

            for (let i = 0; i < allVoltPts.length; i++) {
                delayIntArr[i] = allVoltPts[i].delay_int;
                delayFracArr[i] = allVoltPts[i].delay_frac;
                ampArr[i] = allVoltPts[i].amp;
                fieldIdxArr[i] = allVoltPts[i].field_idx;
            }

            const delayIntBuf = this._createAndUploadBuffer(delayIntArr, GPUBufferUsage.STORAGE);
            const delayFracBuf = this._createAndUploadBuffer(delayFracArr, GPUBufferUsage.STORAGE);
            const ampBuf = this._createAndUploadBuffer(ampArr, GPUBufferUsage.STORAGE);
            const fieldIdxBuf = this._createAndUploadBuffer(fieldIdxArr, GPUBufferUsage.STORAGE);

            // Create voltage TFSF pipeline
            this.tfsfVoltPipeline = this._getOrCreateComputePipeline(
                TFSF_WGSL,
                'tfsf_apply_voltage'
            );

            this.tfsfVoltBindGroup = this.device.createBindGroup({
                layout: this.tfsfVoltPipeline.getBindGroupLayout(1),
                entries: [
                    { binding: 0, resource: { buffer: this.tfsfParamsBuffer } },
                    { binding: 1, resource: { buffer: signalBuf } },
                    { binding: 2, resource: { buffer: delayIntBuf } },
                    { binding: 3, resource: { buffer: delayFracBuf } },
                    { binding: 4, resource: { buffer: ampBuf } },
                    { binding: 5, resource: { buffer: fieldIdxBuf } },
                ],
            });
            this._ensureCoreBindGroup(this.tfsfVoltPipeline);
        }

        // Current points — reuse same shader structure (operates on volt buffer in shader,
        // but for current injection we use the same entry point with curr-mapped points)
        if (currPts.length > 0) {
            const delayIntArr = new Uint32Array(currPts.length);
            const delayFracArr = new Float32Array(currPts.length);
            const ampArr = new Float32Array(currPts.length);
            const fieldIdxArr = new Uint32Array(currPts.length);

            for (let i = 0; i < currPts.length; i++) {
                delayIntArr[i] = currPts[i].delay_int;
                delayFracArr[i] = currPts[i].delay_frac;
                ampArr[i] = currPts[i].amp;
                fieldIdxArr[i] = currPts[i].field_idx;
            }

            const delayIntBuf = this._createAndUploadBuffer(delayIntArr, GPUBufferUsage.STORAGE);
            const delayFracBuf = this._createAndUploadBuffer(delayFracArr, GPUBufferUsage.STORAGE);
            const ampBuf = this._createAndUploadBuffer(ampArr, GPUBufferUsage.STORAGE);
            const fieldIdxBuf = this._createAndUploadBuffer(fieldIdxArr, GPUBufferUsage.STORAGE);

            // For current injection, we need a separate TFSF shader that writes to curr instead of volt.
            // Reuse the TFSF_WGSL with volt binding pointing to curr buffer.
            // We create a second pipeline with the same shader but different core bind group.
            this.tfsfCurrPipeline = this._getOrCreateComputePipeline(
                TFSF_WGSL,
                'tfsf_apply_voltage'
            );

            // Create a separate TFSF params buffer for current
            this._tfsfCurrParamsBuffer = this.device.createBuffer({
                size: 32,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });

            this.tfsfCurrBindGroup = this.device.createBindGroup({
                layout: this.tfsfCurrPipeline.getBindGroupLayout(1),
                entries: [
                    { binding: 0, resource: { buffer: this._tfsfCurrParamsBuffer } },
                    { binding: 1, resource: { buffer: signalBuf } },
                    { binding: 2, resource: { buffer: delayIntBuf } },
                    { binding: 3, resource: { buffer: delayFracBuf } },
                    { binding: 4, resource: { buffer: ampBuf } },
                    { binding: 5, resource: { buffer: fieldIdxBuf } },
                ],
            });

            // Create a core bind group variant where binding 0 is curr (for current TFSF injection)
            this._tfsfCurrCoreBindGroup = this.device.createBindGroup({
                layout: this.tfsfCurrPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.currBuffer } }, // curr instead of volt
                    { binding: 1, resource: { buffer: this.currBuffer } },
                    { binding: 2, resource: { buffer: this.paramsBuffer } },
                ],
            });
        }

        this.tfsfConfigured = true;
    }

    /**
     * Update TFSF params uniform with current timestep.
     */
    _updateTFSFParams() {
        if (this._lastTFSFParamsTS === this.numTS) {
            return;
        }

        // TFSFParams: numTS(u32) + period(u32) + signalLength(u32) + numLowerPoints(u32) +
        //             numUpperPoints(u32) + pad(vec3<u32>) = 32 bytes
        const data = new Uint32Array(8);
        data[0] = this.numTS;
        data[1] = this._tfsfPeriod;
        data[2] = this._tfsfSignalLength;
        data[3] = this._tfsfNumVoltPoints; // numLowerPoints
        data[4] = 0; // numUpperPoints (handled separately)
        data[5] = 0;
        data[6] = 0;
        data[7] = 0;
        this.device.queue.writeBuffer(this.tfsfParamsBuffer, 0, data);

        if (this._tfsfCurrParamsBuffer) {
            const currData = new Uint32Array(8);
            currData[0] = this.numTS;
            currData[1] = this._tfsfPeriod;
            currData[2] = this._tfsfSignalLength;
            currData[3] = this._tfsfNumCurrPoints;
            currData[4] = 0;
            this.device.queue.writeBuffer(this._tfsfCurrParamsBuffer, 0, currData);
        }

        this._lastTFSFParamsTS = this.numTS;
    }

    /**
     * Dispatch TFSF voltage injection.
     * @param {GPUCommandEncoder} encoder
     */
    stepTFSFVoltage(encoder) {
        if (!this.tfsfConfigured || !this.tfsfVoltPipeline) return;
        this._updateTFSFParams();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.tfsfVoltPipeline);
        pass.setBindGroup(0, this._coreBindGroupFor(this.tfsfVoltPipeline));
        pass.setBindGroup(1, this.tfsfVoltBindGroup);
        pass.dispatchWorkgroups(Math.ceil(this._tfsfNumVoltPoints / this.WG_SIZE_EXC), 1, 1);
        pass.end();
    }

    /**
     * Dispatch TFSF current injection.
     * @param {GPUCommandEncoder} encoder
     */
    stepTFSFCurrent(encoder) {
        if (!this.tfsfConfigured || !this.tfsfCurrPipeline) return;
        this._updateTFSFParams();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.tfsfCurrPipeline);
        pass.setBindGroup(0, this._tfsfCurrCoreBindGroup);
        pass.setBindGroup(1, this.tfsfCurrBindGroup);
        pass.dispatchWorkgroups(Math.ceil(this._tfsfNumCurrPoints / this.WG_SIZE_EXC), 1, 1);
        pass.end();
    }

    // -----------------------------------------------------------------------
    // Lumped RLC Extension
    // -----------------------------------------------------------------------

    /**
     * Configure lumped RLC elements for GPU.
     *
     * @param {Object} config - { elements: Array<{
     *   field_idx, direction, type_flag, i2v, ilv, vvd, vv2, vj1, vj2, ib0, b1, b2
     * }> }
     */
    configureRLC(config) {
        if (!this.device) throw new Error('WebGPU device not initialized.');

        const n = config.elements.length;
        if (n === 0) return;

        // RLC params uniform: 4 x u32 = 16 bytes
        const rlcParamsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const rlcParamsData = new Uint32Array([n, this.totalCells, 0, 0]);
        this.device.queue.writeBuffer(rlcParamsBuffer, 0, rlcParamsData);

        // Pack elements into a struct-of-arrays: 12 fields per element, each field is u32 or f32.
        // RLCElement struct size: 12 * 4 = 48 bytes per element
        const elemData = new ArrayBuffer(n * 48);
        const u32View = new Uint32Array(elemData);
        const f32View = new Float32Array(elemData);
        for (let i = 0; i < n; i++) {
            const e = config.elements[i];
            const base = i * 12;
            u32View[base + 0] = e.field_idx;
            u32View[base + 1] = e.direction;
            u32View[base + 2] = e.type_flag;
            f32View[base + 3] = e.i2v;
            f32View[base + 4] = e.ilv;
            f32View[base + 5] = e.vvd;
            f32View[base + 6] = e.vv2;
            f32View[base + 7] = e.vj1;
            f32View[base + 8] = e.vj2;
            f32View[base + 9] = e.ib0;
            f32View[base + 10] = e.b1;
            f32View[base + 11] = e.b2;
        }
        const elemBuffer = this._createAndUploadBuffer(new Uint8Array(elemData), GPUBufferUsage.STORAGE);

        // State buffers: Vdn(n*3), Jn(n*3), v_Il(n)
        const vdnBuffer = this.device.createBuffer({
            size: n * 3 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        const jnBuffer = this.device.createBuffer({
            size: n * 3 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        const vilBuffer = this.device.createBuffer({
            size: n * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });

        // Create pipeline
        this.rlcPipeline = this._getOrCreateComputePipeline(
            LUMPED_RLC_WGSL,
            'update_rlc'
        );

        this.rlcBindGroup = this.device.createBindGroup({
            layout: this.rlcPipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: { buffer: rlcParamsBuffer } },
                { binding: 1, resource: { buffer: elemBuffer } },
                { binding: 2, resource: { buffer: vdnBuffer } },
                { binding: 3, resource: { buffer: jnBuffer } },
                { binding: 4, resource: { buffer: vilBuffer } },
            ],
        });
        this._ensureCoreBindGroup(this.rlcPipeline);

        this._rlcCount = n;
        this._rlcBuffers = [rlcParamsBuffer, elemBuffer, vdnBuffer, jnBuffer, vilBuffer];
        this.rlcConfigured = true;
    }

    /**
     * Dispatch RLC update (combined pre-voltage + apply in one kernel).
     * @param {GPUCommandEncoder} encoder
     */
    stepRLC(encoder) {
        if (!this.rlcConfigured) return;
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.rlcPipeline);
        pass.setBindGroup(0, this._coreBindGroupFor(this.rlcPipeline));
        pass.setBindGroup(1, this.rlcBindGroup);
        pass.dispatchWorkgroups(Math.ceil(this._rlcCount / this.WG_SIZE_EXC), 1, 1);
        pass.end();
    }

    // -----------------------------------------------------------------------
    // Mur ABC Extension
    // -----------------------------------------------------------------------

    /**
     * Configure Mur ABC boundary for GPU.
     * Supports dual-component mode (nyP + nyPP) for full C++ compatibility.
     *
     * @param {Object} config - Single component: { coeff, normal_idx, shifted_idx }
     *   Dual component: { coeff_nyP, coeff_nyPP, normal_idx_nyP, shifted_idx_nyP,
     *                      normal_idx_nyPP, shifted_idx_nyPP }
     */
    configureMur(config) {
        if (!this.device) throw new Error('WebGPU device not initialized.');

        let coeffArr, normalIdxArr, shiftedIdxArr, numPoints;

        if (config.coeff_nyP) {
            // Dual-component mode: concatenate nyP and nyPP arrays
            const n1 = config.normal_idx_nyP.length;
            const n2 = config.normal_idx_nyPP.length;
            numPoints = n1 + n2;

            coeffArr = new Float32Array(numPoints);
            normalIdxArr = new Uint32Array(numPoints);
            shiftedIdxArr = new Uint32Array(numPoints);

            coeffArr.set(config.coeff_nyP, 0);
            coeffArr.set(config.coeff_nyPP, n1);
            normalIdxArr.set(config.normal_idx_nyP, 0);
            normalIdxArr.set(config.normal_idx_nyPP, n1);
            shiftedIdxArr.set(config.shifted_idx_nyP, 0);
            shiftedIdxArr.set(config.shifted_idx_nyPP, n1);
        } else {
            // Single-component mode (backward compatible)
            numPoints = config.normal_idx.length;
            if (typeof config.coeff === 'number') {
                coeffArr = new Float32Array(numPoints).fill(config.coeff);
            } else {
                coeffArr = config.coeff;
            }
            normalIdxArr = config.normal_idx;
            shiftedIdxArr = config.shifted_idx;
        }

        // MurParams uniform: padded to 32 bytes for WebGPU minimum binding size
        const murParamsBuffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(murParamsBuffer, 0, new Uint32Array([numPoints, 0, 0, 0, 0, 0, 0, 0]));

        const normalIdxBuf = this._createAndUploadBuffer(normalIdxArr, GPUBufferUsage.STORAGE);
        const shiftedIdxBuf = this._createAndUploadBuffer(shiftedIdxArr, GPUBufferUsage.STORAGE);
        const savedVoltBuf = this.device.createBuffer({
            size: numPoints * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        const coeffBuf = this._createAndUploadBuffer(coeffArr, GPUBufferUsage.STORAGE);

        // Explicit bind group layouts (auto layout drops unused bindings per entry point)
        const murGroup0Layout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });
        const murGroup1Layout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });
        const murPipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [murGroup0Layout, murGroup1Layout],
        });

        const murModule = this._getOrCreateShaderModule(MUR_ABC_WGSL);
        this.murPrePipeline = this.device.createComputePipeline({
            layout: murPipelineLayout, compute: { module: murModule, entryPoint: 'mur_pre_voltage' },
        });
        this.murPostPipeline = this.device.createComputePipeline({
            layout: murPipelineLayout, compute: { module: murModule, entryPoint: 'mur_post_voltage' },
        });
        this.murApplyPipeline = this.device.createComputePipeline({
            layout: murPipelineLayout, compute: { module: murModule, entryPoint: 'mur_apply' },
        });

        this.murBindGroup = this.device.createBindGroup({
            layout: murGroup1Layout,
            entries: [
                { binding: 0, resource: { buffer: murParamsBuffer } },
                { binding: 1, resource: { buffer: normalIdxBuf } },
                { binding: 2, resource: { buffer: shiftedIdxBuf } },
                { binding: 3, resource: { buffer: savedVoltBuf } },
                { binding: 4, resource: { buffer: coeffBuf } },
            ],
        });
        this._murCoreBindGroup = this.device.createBindGroup({
            layout: murGroup0Layout,
            entries: [{ binding: 0, resource: { buffer: this.voltBuffer } }],
        });

        this._murNumPoints = numPoints;
        this._murBuffers = [murParamsBuffer, normalIdxBuf, shiftedIdxBuf, savedVoltBuf, coeffBuf];
        this.murConfigured = true;
    }

    /**
     * Dispatch Mur pre-voltage save.
     * @param {GPUCommandEncoder} encoder
     */
    stepMurPre(encoder) {
        if (!this.murConfigured) return;
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.murPrePipeline);
        pass.setBindGroup(0, this._murCoreBindGroup);
        pass.setBindGroup(1, this.murBindGroup);
        pass.dispatchWorkgroups(Math.ceil(this._murNumPoints / this.WG_SIZE_EXC), 1, 1);
        pass.end();
    }

    /**
     * Dispatch Mur post-voltage accumulate.
     * @param {GPUCommandEncoder} encoder
     */
    stepMurPost(encoder) {
        if (!this.murConfigured) return;
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.murPostPipeline);
        pass.setBindGroup(0, this._murCoreBindGroup);
        pass.setBindGroup(1, this.murBindGroup);
        pass.dispatchWorkgroups(Math.ceil(this._murNumPoints / this.WG_SIZE_EXC), 1, 1);
        pass.end();
    }

    /**
     * Dispatch Mur apply (overwrite boundary).
     * @param {GPUCommandEncoder} encoder
     */
    stepMurApply(encoder) {
        if (!this.murConfigured) return;
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.murApplyPipeline);
        pass.setBindGroup(0, this._murCoreBindGroup);
        pass.setBindGroup(1, this.murBindGroup);
        pass.dispatchWorkgroups(Math.ceil(this._murNumPoints / this.WG_SIZE_EXC), 1, 1);
        pass.end();
    }

    // -----------------------------------------------------------------------
    // Periodic Boundary Conditions (PBC) Extension
    // -----------------------------------------------------------------------

    /**
     * Configure periodic boundary conditions.
     *
     * @param {Object} config - {
     *   axes: Array<{
     *     axis: number,        // 0=x, 1=y, 2=z
     *     phase: number,       // Bloch phase shift [rad] (0 for simple PBC)
     *   }>
     * }
     */
    configurePBC(config) {
        if (!this.device) throw new Error('WebGPU device not initialized.');
        if (!config.axes || config.axes.length === 0) return;

        const [Nx, Ny, Nz] = this.numLines;
        const numLinesDims = [Nx, Ny, Nz];

        // Build explicit bind group layouts
        const pbcGroup0Layout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });
        const pbcGroup1Layout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });
        const pbcPipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [pbcGroup0Layout, pbcGroup1Layout],
        });

        const pbcModule = this._getOrCreateShaderModule(PBC_COPY_WGSL);
        this.pbcPipeline = this.device.createComputePipeline({
            layout: pbcPipelineLayout, compute: { module: pbcModule, entryPoint: 'pbc_copy' },
        });

        // Shared group 0 bind group with volt and curr
        this._pbcCoreBindGroup = this.device.createBindGroup({
            layout: pbcGroup0Layout,
            entries: [
                { binding: 0, resource: { buffer: this.voltBuffer } },
                { binding: 1, resource: { buffer: this.currBuffer } },
            ],
        });

        const hasBloch = config.axes.some(a => a.phase !== 0);

        // Compute total imaginary buffer size: for each axis, 4 face-sized buffers
        // (2 tangential components x 2 field types = volt tang0, volt tang1, curr tang0, curr tang1)
        let totalImagSize = 0;
        if (hasBloch) {
            for (const a of config.axes) {
                if (a.phase !== 0) {
                    const tang0 = (a.axis + 1) % 3;
                    const tang1 = (a.axis + 2) % 3;
                    const faceSize = numLinesDims[tang0] * numLinesDims[tang1];
                    totalImagSize += 4 * faceSize; // volt tang0/tang1 + curr tang0/tang1
                }
            }
        }
        // Ensure minimum buffer size (WebGPU requires at least 4 bytes)
        const imagBufSize = Math.max(totalImagSize * 4, 4);
        const imagBuffer = this.device.createBuffer({
            size: imagBufSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this.pbcVoltRegions = [];
        this.pbcCurrRegions = [];
        this._pbcBuffers = [imagBuffer];
        let imagOffset = 0;

        for (const axisConfig of config.axes) {
            const axis = axisConfig.axis;
            const phase = axisConfig.phase || 0;
            const cosPhase = Math.cos(phase);
            const sinPhase = Math.sin(phase);

            const tang0 = (axis + 1) % 3;
            const tang1 = (axis + 2) % 3;
            const faceSize0 = numLinesDims[tang0];
            const faceSize1 = numLinesDims[tang1];

            // Voltage copy: source = numLines[axis] - 2, dest = 0
            const voltSrcFace = numLinesDims[axis] - 2;
            const voltDstFace = 0;

            // Current copy: source = 0, dest = numLines[axis] - 2
            const currSrcFace = 0;
            const currDstFace = numLinesDims[axis] - 2;

            // PBCParams: 16 u32/f32 values = 64 bytes
            const createParamsBuffer = (mode, srcFace, dstFace, imagOffset, solverBound0, solverBound1) => {
                const buf = this.device.createBuffer({
                    size: 64,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                const data = new ArrayBuffer(64);
                const u32View = new Uint32Array(data);
                const f32View = new Float32Array(data);
                u32View[0] = axis;
                u32View[1] = mode;
                u32View[2] = srcFace;
                u32View[3] = dstFace;
                u32View[4] = faceSize0;
                u32View[5] = faceSize1;
                f32View[6] = cosPhase;
                f32View[7] = sinPhase;
                u32View[8] = Nx;
                u32View[9] = Ny;
                u32View[10] = Nz;
                u32View[11] = imagOffset;
                u32View[12] = solverBound0;
                u32View[13] = solverBound1;
                u32View[14] = 0; // _pad0
                u32View[15] = 0; // _pad1
                this.device.queue.writeBuffer(buf, 0, data);
                this._pbcBuffers.push(buf);
                return buf;
            };

            const axisImagOffset = (phase !== 0) ? imagOffset : 0;
            const voltParamsBuf = createParamsBuffer(0, voltSrcFace, voltDstFace, axisImagOffset, faceSize0, faceSize1);
            const currParamsBuf = createParamsBuffer(1, currSrcFace, currDstFace, axisImagOffset, faceSize0 - 1, faceSize1 - 1);

            // Advance imaginary buffer offset for next axis
            if (phase !== 0) {
                imagOffset += 4 * faceSize0 * faceSize1;
            }

            const dispatchX = Math.ceil(faceSize0 / 8);
            const dispatchY = Math.ceil(faceSize1 / 8);

            const voltBindGroup = this.device.createBindGroup({
                layout: pbcGroup1Layout,
                entries: [
                    { binding: 0, resource: { buffer: voltParamsBuf } },
                    { binding: 1, resource: { buffer: imagBuffer } },
                ],
            });

            const currBindGroup = this.device.createBindGroup({
                layout: pbcGroup1Layout,
                entries: [
                    { binding: 0, resource: { buffer: currParamsBuf } },
                    { binding: 1, resource: { buffer: imagBuffer } },
                ],
            });

            this.pbcVoltRegions.push({ bindGroup: voltBindGroup, dispatchX, dispatchY });
            this.pbcCurrRegions.push({ bindGroup: currBindGroup, dispatchX, dispatchY });
        }

        this.pbcConfigured = true;
    }

    /**
     * Dispatch PBC voltage copy (high face -> low face).
     * @param {GPUCommandEncoder} encoder
     */
    stepPBCVoltage(encoder) {
        if (!this.pbcConfigured) return;
        for (const region of this.pbcVoltRegions) {
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.pbcPipeline);
            pass.setBindGroup(0, this._pbcCoreBindGroup);
            pass.setBindGroup(1, region.bindGroup);
            pass.dispatchWorkgroups(region.dispatchX, region.dispatchY, 1);
            pass.end();
        }
    }

    /**
     * Dispatch PBC current copy (low face -> high face).
     * @param {GPUCommandEncoder} encoder
     */
    stepPBCCurrent(encoder) {
        if (!this.pbcConfigured) return;
        for (const region of this.pbcCurrRegions) {
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.pbcPipeline);
            pass.setBindGroup(0, this._pbcCoreBindGroup);
            pass.setBindGroup(1, region.bindGroup);
            pass.dispatchWorkgroups(region.dispatchX, region.dispatchY, 1);
            pass.end();
        }
    }

    // -----------------------------------------------------------------------
    // Steady-State Detection Extension
    // -----------------------------------------------------------------------

    /**
     * Configure steady-state detection for GPU.
     *
     * @param {Object} config - {
     *   probe_idx: Uint32Array,
     *   periodSamples: number,
     *   threshold: number,
     * }
     */
    configureSteadyState(config) {
        if (!this.device) throw new Error('WebGPU device not initialized.');

        const numProbes = config.probe_idx.length;

        // SSParams uniform: 4 x u32 = 16 bytes
        this.ssParamsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const probeIdxBuf = this._createAndUploadBuffer(config.probe_idx, GPUBufferUsage.STORAGE);
        const energy1Buf = this.device.createBuffer({
            size: Math.max(numProbes * 4, 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        const energy2Buf = this.device.createBuffer({
            size: Math.max(numProbes * 4, 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });

        this.ssPipeline = this._getOrCreateComputePipeline(
            STEADY_STATE_WGSL,
            'accumulate_energy'
        );

        this.ssBindGroup = this.device.createBindGroup({
            layout: this.ssPipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: { buffer: this.ssParamsBuffer } },
                { binding: 1, resource: { buffer: probeIdxBuf } },
                { binding: 2, resource: { buffer: energy1Buf } },
                { binding: 3, resource: { buffer: energy2Buf } },
            ],
        });
        this._ensureCoreBindGroup(this.ssPipeline);

        this._ssNumProbes = numProbes;
        this._ssPeriodSamples = config.periodSamples;
        this._ssThreshold = config.threshold || 1e-6;
        this._ssEnergy1Buf = energy1Buf;
        this._ssEnergy2Buf = energy2Buf;
        this._ssBuffers = [this.ssParamsBuffer, probeIdxBuf, energy1Buf, energy2Buf];
        this.ssCurrentSample = 0;
        this.ssRecording = false;
        this.ssConfigured = true;
    }

    /**
     * Update steady-state params and dispatch energy accumulation.
     * @param {GPUCommandEncoder} encoder
     */
    stepSteadyState(encoder) {
        if (!this.ssConfigured || !this.ssRecording) return;

        const data = new Uint32Array(4);
        data[0] = this._ssNumProbes;
        data[1] = this._ssPeriodSamples;
        data[2] = this.ssCurrentSample;
        data[3] = this.ssRecording ? 1 : 0;
        this.device.queue.writeBuffer(this.ssParamsBuffer, 0, data);

        const pass = encoder.beginComputePass();
        pass.setPipeline(this.ssPipeline);
        pass.setBindGroup(0, this._coreBindGroupFor(this.ssPipeline));
        pass.setBindGroup(1, this.ssBindGroup);
        pass.dispatchWorkgroups(Math.ceil(this._ssNumProbes / this.WG_SIZE_EXC), 1, 1);
        pass.end();

        this.ssCurrentSample++;
    }

    /**
     * Dispatch the voltage (E-field) update compute shader.
     * @param {GPUCommandEncoder} [encoder] - optional shared encoder
     * @returns {GPUCommandEncoder} the encoder used
     */
    stepVoltage(encoder, options = {}) {
        const ownsPass = !options.pass;
        const enc = ownsPass ? (encoder || this.device.createCommandEncoder()) : encoder;
        const [Nx, Ny, Nz] = this.numLines;
        const [wgX, wgY, wgZ] = this._getVoltage3DWorkgroupSize();
        const pass = options.pass || enc.beginComputePass();
        this._dispatchVoltageOnPass(pass, [Nx, Ny, Nz], [wgX, wgY, wgZ]);
        if (ownsPass) {
            pass.end();
        }

        if (ownsPass && !encoder) {
            this.device.queue.submit([enc.finish()]);
        }
        return enc;
    }

    /**
     * Dispatch the current (H-field) update compute shader.
     * @param {GPUCommandEncoder} [encoder] - optional shared encoder
     * @returns {GPUCommandEncoder} the encoder used
     */
    stepCurrent(encoder, options = {}) {
        const ownsPass = !options.pass;
        const enc = ownsPass ? (encoder || this.device.createCommandEncoder()) : encoder;
        const [Nx, Ny, Nz] = this.numLines;
        const [wgX, wgY, wgZ] = this._getCurrent3DWorkgroupSize();
        const pass = options.pass || enc.beginComputePass();
        this._dispatchCurrentOnPass(pass, [Nx, Ny, Nz], [wgX, wgY, wgZ]);
        if (ownsPass) {
            pass.end();
        }

        if (ownsPass && !encoder) {
            this.device.queue.submit([enc.finish()]);
        }
        return enc;
    }

    /**
     * Dispatch the excitation injection compute shader.
     * @param {GPUCommandEncoder} [encoder] - optional shared encoder
     * @returns {GPUCommandEncoder} the encoder used
     */
    applyExcitation(encoder, options = {}) {
        if (!this.excitationConfigured) return encoder;

        const ownsPass = !options.pass;
        const enc = ownsPass ? (encoder || this.device.createCommandEncoder()) : encoder;

        // Update excitation params with current timestep
        this._updateExcParams();

        const pass = options.pass || enc.beginComputePass();
        this._dispatchExcitationOnPass(pass);
        if (ownsPass) {
            pass.end();
        }

        if (ownsPass && !encoder) {
            this.device.queue.submit([enc.finish()]);
        }
        return enc;
    }

    /**
     * Dispatch a compute pass if the pipeline and bind groups are active.
     * This is a convenience helper that avoids boilerplate in iterate().
     *
     * @param {GPUCommandEncoder} encoder
     * @param {GPUComputePipeline|null} pipeline - the compute pipeline (null = skip)
     * @param {Array<GPUBindGroup|null>} bindGroups - bind groups indexed by group slot
     * @param {number[]} dispatchSize - workgroup dispatch dimensions [x, y?, z?]
     */
    dispatchIfActive(encoder, pipeline, bindGroups, dispatchSize) {
        if (!pipeline) return;
        for (const bg of bindGroups) {
            if (!bg) return;
        }

        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        for (let i = 0; i < bindGroups.length; i++) {
            pass.setBindGroup(i, bindGroups[i]);
        }
        pass.dispatchWorkgroups(...dispatchSize);
        pass.end();
    }

    _dispatchVoltageOnPass(pass, numLines = this.numLines, workgroupSize = this._getVoltage3DWorkgroupSize()) {
        const [Nx, Ny, Nz] = numLines;
        const [wgX, wgY, wgZ] = workgroupSize;
        pass.setPipeline(this.voltagePipeline);
        pass.setBindGroup(0, this._coreBindGroupFor(this.voltagePipeline));
        pass.setBindGroup(1, this.voltCoeffBindGroup);
        pass.dispatchWorkgroups(
            Math.ceil(Nx / wgX),
            Math.ceil(Ny / wgY),
            Math.ceil(Nz / wgZ),
        );
    }

    _dispatchCurrentOnPass(pass, numLines = this.numLines, workgroupSize = this._getCurrent3DWorkgroupSize()) {
        const [Nx, Ny, Nz] = numLines;
        const [wgX, wgY, wgZ] = workgroupSize;
        pass.setPipeline(this.currentPipeline);
        pass.setBindGroup(0, this._coreBindGroupFor(this.currentPipeline));
        pass.setBindGroup(2, this.currCoeffBindGroup);
        pass.dispatchWorkgroups(
            Math.ceil(Math.max(Nx - 1, 1) / wgX),
            Math.ceil(Math.max(Ny - 1, 1) / wgY),
            Math.ceil(Math.max(Nz - 1, 1) / wgZ),
        );
    }

    _dispatchExcitationOnPass(pass) {
        pass.setPipeline(this.excitationPipeline);
        pass.setBindGroup(0, this._coreBindGroupFor(this.excitationPipeline, [0, 2]));
        pass.setBindGroup(1, this.excBindGroup);
        pass.dispatchWorkgroups(
            Math.ceil(this._excCount / this.WG_SIZE_EXC),
            1,
            1,
        );
    }

    _canUseSimpleCorePassFastPath() {
        return this.excitationConfigured
            && !!this.voltagePipeline
            && !!this.currentPipeline
            && !!this.voltCoeffBindGroup
            && !!this.currCoeffBindGroup
            && (!this.excitationConfigured || (!!this.excitationPipeline && !!this.excBindGroup))
            && !this.ssRecording
            && !this.pmlConfigured
            && !this.adeConfigured
            && !this.rlcConfigured
            && !this.murConfigured
            && !this.tfsfConfigured
            && !this.pbcConfigured;
    }

    _getVoltage3DWorkgroupSize() {
        return this.WG_SIZE_3D_VOLTAGE || this.WG_SIZE_3D;
    }

    _getCurrent3DWorkgroupSize() {
        return this.WG_SIZE_3D_CURRENT || this.WG_SIZE_3D;
    }

    /**
     * Run N complete FDTD timesteps.
     * Each timestep: voltage update -> excitation -> current update -> increment numTS.
     *
     * @param {number} numSteps - number of timesteps to run
     */
    /**
     * Run N complete FDTD timesteps without GPU sync.
     * Caller must sync (via readProbeGather/computeEnergy/getFields) when needed.
     */
    iterate(numSteps) {
        for (let step = 0; step < numSteps; step++) {
            // Update uniforms BEFORE encoding so the command buffer sees correct values
            this._updateParams();
            if (this.excitationConfigured) {
                this._updateExcParams();
            }

            const encoder = this.device.createCommandEncoder();

            if (this._canUseSimpleCorePassFastPath()) {
                const pass = encoder.beginComputePass();
                this.stepVoltage(null, { pass });
                if (this.excitationConfigured) {
                    this.applyExcitation(null, { pass });
                }
                this.stepCurrent(null, { pass });
                pass.end();
                // NF2FF FD accumulation (separate pass for memory barrier)
                if (this._nf2ffPipeline) {
                    this._updateNF2FFParams(this.numTS + 1);
                    const nf2ffPass = encoder.beginComputePass();
                    nf2ffPass.setPipeline(this._nf2ffPipeline);
                    nf2ffPass.setBindGroup(0, this._nf2ffBindGroup);
                    nf2ffPass.dispatchWorkgroups(Math.ceil(this._nf2ffNumPoints / 64));
                    nf2ffPass.end();
                }
                if (this._gatherBufferedPipeline && (this.numTS + 1) % this._gatherSampleInterval === 0 && this._gatherSampleIndex < this._gatherMaxSamples) {
                    this._updateGatherSampleIndex(this._gatherSampleIndex);
                    const gatherPass = encoder.beginComputePass();
                    gatherPass.setPipeline(this._gatherBufferedPipeline);
                    gatherPass.setBindGroup(0, this._gatherBufferedBindGroup);
                    gatherPass.dispatchWorkgroups(Math.ceil(this._gatherCount / 64));
                    gatherPass.end();
                    this._gatherSampleIndex++;
                }
                this.device.queue.submit([encoder.finish()]);
                this.numTS++;
                continue;
            }

            // === PRE-VOLTAGE (C++ DoPreVoltageUpdates) ===
            this.stepSteadyState(encoder);  // Priority +2M
            this.stepPML(encoder, 0);       // Priority +1M
            this.stepVoltADE(encoder);      // Priority 0 — Lorentz/Drude ADE
            this.stepMurPre(encoder);       // Priority 0 — Mur save boundary
            this.stepRLC(encoder);          // Priority 0 — RLC (GPU: fused pre+apply kernel)

            // === CORE VOLTAGE UPDATE ===
            this.stepVoltage(encoder);

            // === POST-VOLTAGE (C++ DoPostVoltageUpdates) ===
            this.stepPML(encoder, 1);       // Priority +1M
            this.stepTFSFVoltage(encoder);  // Priority +50K
            this.stepPBCVoltage(encoder);   // PBC: copy high→low E-tangential
            this.stepMurPost(encoder);      // Priority 0 — Mur accumulate

            // === APPLY TO VOLTAGES (C++ Apply2Voltages) ===
            if (this.excitationConfigured) {
                this.applyExcitation(encoder); // Priority -1K
            }
            this.stepMurApply(encoder);     // Priority 0 — Mur boundary overwrite

            // === PRE-CURRENT (C++ DoPreCurrentUpdates) ===
            this.stepPML(encoder, 2);       // Priority +1M
            this.stepCurrADE(encoder);      // Priority 0 — Lorentz/Drude ADE

            // === CORE CURRENT UPDATE ===
            this.stepCurrent(encoder);

            // === POST-CURRENT (C++ DoPostCurrentUpdates) ===
            this.stepPML(encoder, 3);       // Priority +1M
            this.stepTFSFCurrent(encoder);  // Priority +50K
            this.stepPBCCurrent(encoder);   // PBC: copy low→high H-tangential

            // NF2FF FD accumulation (after all field updates)
            if (this._nf2ffPipeline) {
                this._updateNF2FFParams(this.numTS + 1);
                const nf2ffPass = encoder.beginComputePass();
                nf2ffPass.setPipeline(this._nf2ffPipeline);
                nf2ffPass.setBindGroup(0, this._nf2ffBindGroup);
                nf2ffPass.dispatchWorkgroups(Math.ceil(this._nf2ffNumPoints / 64));
                nf2ffPass.end();
            }
            if (this._gatherBufferedPipeline && (this.numTS + 1) % this._gatherSampleInterval === 0 && this._gatherSampleIndex < this._gatherMaxSamples) {
                this._updateGatherSampleIndex(this._gatherSampleIndex);
                const gatherPass = encoder.beginComputePass();
                gatherPass.setPipeline(this._gatherBufferedPipeline);
                gatherPass.setBindGroup(0, this._gatherBufferedBindGroup);
                gatherPass.dispatchWorkgroups(Math.ceil(this._gatherCount / 64));
                gatherPass.end();
                this._gatherSampleIndex++;
            }

            this.device.queue.submit([encoder.finish()]);
            this.numTS++;
        }
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

        // Copy both volt and curr in a single command submission
        const voltReadback = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const currReadback = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(this.voltBuffer, 0, voltReadback, 0, bufferSize);
        encoder.copyBufferToBuffer(this.currBuffer, 0, currReadback, 0, bufferSize);
        this.device.queue.submit([encoder.finish()]);

        // Map both readback buffers in parallel
        await Promise.all([
            voltReadback.mapAsync(GPUMapMode.READ),
            currReadback.mapAsync(GPUMapMode.READ),
        ]);
        const volt = new Float32Array(voltReadback.getMappedRange().slice(0));
        const curr = new Float32Array(currReadback.getMappedRange().slice(0));
        voltReadback.unmap(); voltReadback.destroy();
        currReadback.unmap(); currReadback.destroy();

        return { volt, curr };
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
     * Configure probe gather for efficient readback of only probe field indices.
     * @param {Uint32Array} indices - linear field array indices to gather
     */
    configureProbeGather(indices) {
        if (indices.length === 0) return;
        this._gatherCount = indices.length;

        // Upload index buffer
        this._gatherIndexBuffer = this._createAndUploadBuffer(
            indices, GPUBufferUsage.STORAGE);

        // Output buffer: volt + curr for each index
        const outSize = indices.length * 2 * 4; // 2 floats per index
        this._gatherOutBuffer = this.device.createBuffer({
            size: outSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        // Create gather shader
        const code = /* wgsl */ `
@group(0) @binding(0) var<storage, read> volt: array<f32>;
@group(0) @binding(1) var<storage, read> curr: array<f32>;
@group(0) @binding(2) var<storage, read> indices: array<u32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= arrayLength(&indices)) { return; }
    let idx = indices[i];
    output[i * 2u] = volt[idx];
    output[i * 2u + 1u] = curr[idx];
}`;
        const module = this.device.createShaderModule({ code });
        this._gatherPipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
        });
        this._gatherBindGroup = this.device.createBindGroup({
            layout: this._gatherPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.voltBuffer } },
                { binding: 1, resource: { buffer: this.currBuffer } },
                { binding: 2, resource: { buffer: this._gatherIndexBuffer } },
                { binding: 3, resource: { buffer: this._gatherOutBuffer } },
            ],
        });
    }

    configureProbeGatherBuffered(indices, { maxSamples, sampleInterval }) {
        if (indices.length === 0) return;
        this._gatherCount = indices.length;
        this._gatherMaxSamples = maxSamples;
        this._gatherSampleInterval = sampleInterval;
        this._gatherSampleIndex = 0;

        this._gatherIndexBuffer = this._createAndUploadBuffer(
            indices, GPUBufferUsage.STORAGE);

        const ringSize = maxSamples * indices.length * 2 * 4;
        this._gatherRingBuffer = this.device.createBuffer({
            size: ringSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        this._gatherParamsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const code = /* wgsl */ `
struct GatherParams {
    sampleIndex: u32,
    stride: u32,
    _pad0: u32,
    _pad1: u32,
};
@group(0) @binding(0) var<storage, read> volt: array<f32>;
@group(0) @binding(1) var<storage, read> curr: array<f32>;
@group(0) @binding(2) var<storage, read> indices: array<u32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;
@group(0) @binding(4) var<uniform> params: GatherParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= arrayLength(&indices)) { return; }
    let idx = indices[i];
    let base = params.sampleIndex * params.stride;
    output[base + i * 2u] = volt[idx];
    output[base + i * 2u + 1u] = curr[idx];
}`;
        const module = this.device.createShaderModule({ code });
        this._gatherBufferedPipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
        });
        this._gatherBufferedBindGroup = this.device.createBindGroup({
            layout: this._gatherBufferedPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.voltBuffer } },
                { binding: 1, resource: { buffer: this.currBuffer } },
                { binding: 2, resource: { buffer: this._gatherIndexBuffer } },
                { binding: 3, resource: { buffer: this._gatherRingBuffer } },
                { binding: 4, resource: { buffer: this._gatherParamsBuffer } },
            ],
        });
    }

    _updateGatherSampleIndex(sampleIndex) {
        if (!this._gatherParamsBuffer) return;
        const data = new Uint32Array([sampleIndex, this._gatherCount * 2, 0, 0]);
        this.device.queue.writeBuffer(this._gatherParamsBuffer, 0, data);
    }

    async readProbeGatherBuffered() {
        if (!this._gatherRingBuffer || this._gatherSampleIndex === 0) return null;
        const outSize = this._gatherSampleIndex * this._gatherCount * 2 * 4;
        const data = await this._readBuffer(this._gatherRingBuffer, outSize);
        return { data: new Float32Array(data), numSamples: this._gatherSampleIndex, stride: this._gatherCount * 2 };
    }

    /**
     * Read only the pre-configured probe field values from GPU.
     * Much faster than getFields() — reads only the needed indices.
     * @returns {Promise<Float32Array>} interleaved [volt0, curr0, volt1, curr1, ...]
     */
    async readProbeGather() {
        if (!this._gatherPipeline) return null;

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this._gatherPipeline);
        pass.setBindGroup(0, this._gatherBindGroup);
        pass.dispatchWorkgroups(Math.ceil(this._gatherCount / 64));
        pass.end();
        this.device.queue.submit([encoder.finish()]);

        const outSize = this._gatherCount * 2 * 4;
        const data = await this._readBuffer(this._gatherOutBuffer, outSize);
        return new Float32Array(data);
    }

    /**
     * Configure GPU-side NF2FF frequency-domain accumulation.
     * This creates a compute shader that accumulates the DFT of E/H fields
     * at specified surface points every timestep.
     *
     * @param {Object} config
     * @param {Uint32Array} config.surfaceIndices - flat [ix, iy, iz] triplets
     * @param {number} config.numPoints - total surface points
     * @param {number} config.omega - angular frequency (2*PI*freq)
     * @param {number} config.dT - simulation timestep
     * @param {number[]} config.gridSize - [Nx, Ny, Nz]
     */
    configureNF2FFAccumulation(config) {
        const { surfaceIndices, numPoints, omega, dT, gridSize, primalEdgeLens, dualEdgeLens,
                maxTS = 0, windowType = 0 } = config;
        if (numPoints === 0) return;

        this._nf2ffNumPoints = numPoints;
        this._nf2ffOmega = omega;
        this._nf2ffDT = dT;

        // Upload surface point indices (ix, iy, iz triplets)
        this._nf2ffPointsBuffer = this._createAndUploadBuffer(
            surfaceIndices, GPUBufferUsage.STORAGE);

        // Accumulation buffers: numPoints * 6 floats (3 components * re/im)
        const accumSize = numPoints * 6 * 4;
        this._nf2ffAccumEBuffer = this.device.createBuffer({
            size: accumSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        this._nf2ffAccumHBuffer = this.device.createBuffer({
            size: accumSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        // Edge length buffer: [primalX, primalY, primalZ, dualX, dualY, dualZ]
        const elOffsets = [0];
        for (let i = 0; i < 3; i++) elOffsets.push(elOffsets[elOffsets.length - 1] + primalEdgeLens[i].length);
        for (let i = 0; i < 3; i++) elOffsets.push(elOffsets[elOffsets.length - 1] + dualEdgeLens[i].length);
        const totalEdgeFloats = elOffsets[elOffsets.length - 1];
        const edgeLenData = new Float32Array(totalEdgeFloats);
        let elOff = 0;
        for (let i = 0; i < 3; i++) { edgeLenData.set(primalEdgeLens[i], elOff); elOff += primalEdgeLens[i].length; }
        for (let i = 0; i < 3; i++) { edgeLenData.set(dualEdgeLens[i], elOff); elOff += dualEdgeLens[i].length; }
        this._nf2ffEdgeLenBuffer = this._createAndUploadBuffer(edgeLenData, GPUBufferUsage.STORAGE);

        // Compute window normalization factor
        let windowNorm = 1.0;
        if (windowType === 1 && maxTS > 1) {
            let sum = 0;
            for (let n = 0; n < maxTS; n++) {
                sum += 0.5 * (1 - Math.cos(2 * Math.PI * n / (maxTS - 1)));
            }
            windowNorm = 1.0 / sum;
        }
        this._nf2ffMaxTS = maxTS;
        this._nf2ffWindowType = windowType;

        // Params buffer: NF2FFParams struct (80 bytes, 16-byte aligned)
        this._nf2ffParamsBuffer = this.device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const paramsData = new ArrayBuffer(80);
        const u32 = new Uint32Array(paramsData);
        const f32 = new Float32Array(paramsData);
        u32[0] = 0;                // numTS (updated each step)
        u32[1] = numPoints;
        u32[2] = gridSize[0];      // Nx
        u32[3] = gridSize[1];      // Ny
        u32[4] = gridSize[2];      // Nz
        u32[5] = elOffsets[0];     // elOffPX
        u32[6] = elOffsets[1];     // elOffPY
        u32[7] = elOffsets[2];     // elOffPZ
        u32[8] = elOffsets[3];     // elOffDX
        u32[9] = elOffsets[4];     // elOffDY
        u32[10] = elOffsets[5];    // elOffDZ
        u32[11] = 0;               // _pad0
        f32[12] = omega;
        f32[13] = dT;
        u32[14] = maxTS;           // maxTS
        u32[15] = windowType;      // windowType
        f32[16] = windowNorm;      // windowNorm
        f32[17] = 0;               // _pad1
        f32[18] = 0;               // _pad2
        f32[19] = 0;               // _pad3
        this.device.queue.writeBuffer(this._nf2ffParamsBuffer, 0, paramsData);

        // Create pipeline
        const module = this.device.createShaderModule({ code: NF2FF_ACCUMULATE_WGSL });
        this._nf2ffPipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
        });

        // Create bind group
        this._nf2ffBindGroup = this.device.createBindGroup({
            layout: this._nf2ffPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.voltBuffer } },
                { binding: 1, resource: { buffer: this.currBuffer } },
                { binding: 2, resource: { buffer: this._nf2ffParamsBuffer } },
                { binding: 3, resource: { buffer: this._nf2ffPointsBuffer } },
                { binding: 4, resource: { buffer: this._nf2ffAccumEBuffer } },
                { binding: 5, resource: { buffer: this._nf2ffAccumHBuffer } },
                { binding: 6, resource: { buffer: this._nf2ffEdgeLenBuffer } },
            ],
        });
    }

    /**
     * Update the numTS value in the NF2FF params buffer.
     * Call this before dispatching the NF2FF accumulation shader.
     * @param {number} numTS - current timestep number to use for DFT phase
     */
    _updateNF2FFParams(numTS) {
        if (!this._nf2ffParamsBuffer) return;
        const data = new Uint32Array([numTS]);
        this.device.queue.writeBuffer(this._nf2ffParamsBuffer, 0, data);
    }

    /**
     * Read back the accumulated NF2FF E and H DFT buffers from GPU.
     * @returns {Promise<{accumE: Float32Array, accumH: Float32Array}>}
     */
    async readNF2FFAccumulation() {
        if (!this._nf2ffPipeline) return null;
        const size = this._nf2ffNumPoints * 6 * 4;
        const [eData, hData] = await Promise.all([
            this._readBuffer(this._nf2ffAccumEBuffer, size),
            this._readBuffer(this._nf2ffAccumHBuffer, size),
        ]);
        return {
            accumE: new Float32Array(eData),
            accumH: new Float32Array(hData),
        };
    }

    /**
     * Compute NF2FF far-field transformation entirely on the GPU.
     * Each GPU thread handles one (theta, phi) angle pair and loops over all surface points.
     *
     * @param {Object} config
     * @param {Float32Array} config.pointMeta - 8 floats per point (posX, posY, posZ, normalDir, normSign, area, pad, pad)
     * @param {Float32Array} config.theta - theta angles in radians
     * @param {Float32Array} config.phi - phi angles in radians
     * @param {number[]} config.center - [x, y, z] phase reference center in meters
     * @param {number} config.frequency - frequency in Hz
     * @param {number} config.radius - far-field observation radius in meters
     * @param {number} config.numPoints - number of surface points
     * @returns {Promise<Float32Array>} output: 5 floats per angle (P_rad, Et_re, Et_im, Ep_re, Ep_im)
     */
    async computeNF2FFfarField(config) {
        const { pointMeta, theta, phi, center, frequency, radius, numPoints } = config;
        const C0 = 299792458;
        const Z0_val = 376.73031346177066; // sqrt(MUE0/EPS0)
        const k = 2 * Math.PI * frequency / C0;
        const nTheta = theta.length;
        const nPhi = phi.length;
        const totalAngles = nTheta * nPhi;

        // Precompute factor = j*k/(4*pi*r) * exp(-jkr)
        const fac_mag = k / (4 * Math.PI * radius);
        const fac_phase = -k * radius;
        const fac_re = fac_mag * (-Math.sin(fac_phase));
        const fac_im = fac_mag * Math.cos(fac_phase);

        // Create temporary GPU buffers
        const pointMetaBuffer = this._createAndUploadBuffer(pointMeta, GPUBufferUsage.STORAGE);
        const thetaBuffer = this._createAndUploadBuffer(theta, GPUBufferUsage.STORAGE);
        const phiBuffer = this._createAndUploadBuffer(phi, GPUBufferUsage.STORAGE);

        // Params uniform: 16 u32/f32 = 64 bytes (multiple of 16)
        const paramsData = new ArrayBuffer(64);
        const u32View = new Uint32Array(paramsData);
        const f32View = new Float32Array(paramsData);
        u32View[0] = numPoints;
        u32View[1] = nTheta;
        u32View[2] = nPhi;
        u32View[3] = 0; // _pad0
        f32View[4] = k;
        f32View[5] = Z0_val;
        f32View[6] = radius;
        f32View[7] = 0; // _pad1
        f32View[8] = center[0];
        f32View[9] = center[1];
        f32View[10] = center[2];
        f32View[11] = 0; // _pad2
        f32View[12] = fac_re;
        f32View[13] = fac_im;
        f32View[14] = 0; // _pad3
        f32View[15] = 0; // _pad4

        const paramsBuffer = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(paramsBuffer, 0, paramsData);

        // Output buffer: 5 floats per angle
        const outputSize = totalAngles * 5 * 4;
        const outputBuffer = this.device.createBuffer({
            size: outputSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        // Create pipeline
        const module = this.device.createShaderModule({ code: NF2FF_FARFIELD_WGSL });
        const pipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
        });

        // Create bind group (reuse existing accumE/accumH buffers)
        const bindGroup = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this._nf2ffAccumEBuffer } },
                { binding: 1, resource: { buffer: this._nf2ffAccumHBuffer } },
                { binding: 2, resource: { buffer: pointMetaBuffer } },
                { binding: 3, resource: { buffer: thetaBuffer } },
                { binding: 4, resource: { buffer: phiBuffer } },
                { binding: 5, resource: { buffer: paramsBuffer } },
                { binding: 6, resource: { buffer: outputBuffer } },
            ],
        });

        // Dispatch
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(totalAngles / 64));
        pass.end();
        this.device.queue.submit([encoder.finish()]);

        // Read back output
        const resultData = await this._readBuffer(outputBuffer, outputSize);
        const result = new Float32Array(resultData);

        // Destroy temporary buffers
        pointMetaBuffer.destroy();
        thetaBuffer.destroy();
        phiBuffer.destroy();
        paramsBuffer.destroy();
        outputBuffer.destroy();

        return result;
    }

    /**
     * Compute total field energy on GPU (for end-criteria check).
     * Returns sum of volt^2 + curr^2 over all cells.
     * @returns {Promise<number>}
     */
    async computeEnergy() {
        if (!this._energyPipeline) {
            this._setupEnergyReduction();
        }

        const encoder = this.device.createCommandEncoder();

        // First pass: per-workgroup partial sums
        const pass = encoder.beginComputePass();
        pass.setPipeline(this._energyPipeline);
        pass.setBindGroup(0, this._energyBindGroup);
        pass.dispatchWorkgroups(this._energyWorkgroups);
        pass.end();

        // Second pass: reduce partial sums
        const pass2 = encoder.beginComputePass();
        pass2.setPipeline(this._energyReducePipeline);
        pass2.setBindGroup(0, this._energyReduceBindGroup);
        pass2.dispatchWorkgroups(1);
        pass2.end();

        this.device.queue.submit([encoder.finish()]);

        const data = await this._readBuffer(this._energyResultBuffer, 4);
        return new Float32Array(data)[0];
    }

    _setupEnergyReduction() {
        const totalCells = this.totalCells; // Nx * Ny * Nz
        const WG_SIZE = 256;
        this._energyWorkgroups = Math.ceil(totalCells / WG_SIZE);

        // Partial sums buffer
        this._energyPartialBuffer = this.device.createBuffer({
            size: this._energyWorkgroups * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        // Final result buffer
        this._energyResultBuffer = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        // First pass: compute partial sums per workgroup
        const code1 = /* wgsl */ `
@group(0) @binding(0) var<storage, read> volt: array<f32>;
@group(0) @binding(1) var<storage, read> curr: array<f32>;
@group(0) @binding(2) var<storage, read_write> partial: array<f32>;

var<workgroup> wg_sums: array<f32, ${WG_SIZE}>;

@compute @workgroup_size(${WG_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u,
        @builtin(local_invocation_id) lid: vec3u,
        @builtin(workgroup_id) wid: vec3u) {
    let totalCells = ${totalCells}u;
    let totalElems = totalCells * 3u;
    let i = gid.x;
    var sum: f32 = 0.0;
    // Each thread sums 3 components for its cell
    if (i < totalCells) {
        for (var n = 0u; n < 3u; n = n + 1u) {
            let idx = n * totalCells + i;
            let v = volt[idx];
            let c = curr[idx];
            sum = sum + v * v + c * c;
        }
    }
    wg_sums[lid.x] = sum;
    workgroupBarrier();

    // Reduction within workgroup
    for (var s = ${WG_SIZE >> 1}u; s > 0u; s = s >> 1u) {
        if (lid.x < s) {
            wg_sums[lid.x] = wg_sums[lid.x] + wg_sums[lid.x + s];
        }
        workgroupBarrier();
    }
    if (lid.x == 0u) {
        partial[wid.x] = wg_sums[0];
    }
}`;
        const mod1 = this.device.createShaderModule({ code: code1 });
        this._energyPipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: { module: mod1, entryPoint: 'main' },
        });
        this._energyBindGroup = this.device.createBindGroup({
            layout: this._energyPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.voltBuffer } },
                { binding: 1, resource: { buffer: this.currBuffer } },
                { binding: 2, resource: { buffer: this._energyPartialBuffer } },
            ],
        });

        // Second pass: reduce partial sums to single value
        const numPartials = this._energyWorkgroups;
        const code2 = /* wgsl */ `
@group(0) @binding(0) var<storage, read> partial: array<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<f32>;

@compute @workgroup_size(1)
fn main() {
    var sum: f32 = 0.0;
    for (var i = 0u; i < ${numPartials}u; i = i + 1u) {
        sum = sum + partial[i];
    }
    result[0] = sum;
}`;
        const mod2 = this.device.createShaderModule({ code: code2 });
        this._energyReducePipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: { module: mod2, entryPoint: 'main' },
        });
        this._energyReduceBindGroup = this.device.createBindGroup({
            layout: this._energyReducePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this._energyPartialBuffer } },
                { binding: 1, resource: { buffer: this._energyResultBuffer } },
            ],
        });
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
            this.tfsfParamsBuffer, this._tfsfCurrParamsBuffer,
            this.ssParamsBuffer,
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
        // Destroy ADE buffers
        for (const order of this.adeOrders) {
            for (const d of order.directions) {
                for (const buf of (d.buffers || [])) { if (buf) buf.destroy(); }
            }
        }
        for (const order of this.adeCurrOrders) {
            for (const d of order.directions) {
                for (const buf of (d.buffers || [])) { if (buf) buf.destroy(); }
            }
        }
        // Destroy RLC buffers
        for (const buf of (this._rlcBuffers || [])) { if (buf) buf.destroy(); }
        // Destroy Mur buffers
        for (const buf of (this._murBuffers || [])) { if (buf) buf.destroy(); }
        // Destroy steady-state buffers
        for (const buf of (this._ssBuffers || [])) { if (buf) buf.destroy(); }
        // Destroy gather/energy buffers
        for (const buf of [this._gatherIndexBuffer, this._gatherOutBuffer,
                           this._gatherRingBuffer, this._gatherParamsBuffer,
                           this._energyPartialBuffer, this._energyResultBuffer]) {
            if (buf) buf.destroy();
        }
        // Destroy NF2FF buffers
        for (const buf of [this._nf2ffParamsBuffer, this._nf2ffPointsBuffer,
                           this._nf2ffAccumEBuffer, this._nf2ffAccumHBuffer,
                           this._nf2ffEdgeLenBuffer]) {
            if (buf) buf.destroy();
        }

        if (this.device) {
            this.device.destroy();
        }
        this._invalidatePipelineCaches();
        this._coreBindGroupCache.clear();
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
        if (this._lastParamsTS === this.numTS) {
            return;
        }

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
        this._lastParamsTS = this.numTS;
    }

    _updateExcParams() {
        if (this._lastExcParamsTS === this.numTS) {
            return;
        }

        // ExcParams struct: 4 x u32 = 16 bytes
        const data = new Uint32Array(4);
        data[0] = this.numTS;
        data[1] = this._excSignalLength;
        data[2] = this._excPeriod;
        data[3] = this._excCount;
        this.device.queue.writeBuffer(this.excParamsBuffer, 0, data);
        this._lastExcParamsTS = this.numTS;
    }

    async _createPipelines() {
        // Shared bind group layout for group 0 (volt, curr, params)
        // Used by all pipelines that read/write fields
        this.coreBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ],
        });

        const makeAutoLayout = (extraLayouts) => {
            // We only fix group 0; let 'auto' handle the rest
            // Actually we can't mix explicit and auto. Use full auto and create
            // per-pipeline bind groups. OR use explicit for everything.
            // Simplest: use explicit group 0 layout for all pipelines.
            return undefined; // placeholder
        };

        const voltageWGSL = apply3DWorkgroupSize(UPDATE_VOLTAGE_WGSL, this._getVoltage3DWorkgroupSize());
        const currentWGSL = apply3DWorkgroupSize(UPDATE_CURRENT_WGSL, this._getCurrent3DWorkgroupSize());

        this.voltagePipeline = await this._getOrCreateComputePipelineAsync(
            voltageWGSL,
            'update_voltages'
        );
        this.currentPipeline = await this._getOrCreateComputePipelineAsync(
            currentWGSL,
            'update_currents'
        );
        this.pmlPipeline = await this._getOrCreateComputePipelineAsync(
            UPDATE_PML_WGSL,
            'update_pml'
        );
        this.excitationPipeline = await this._getOrCreateComputePipelineAsync(
            EXCITATION_WGSL,
            'apply_excitation'
        );
    }

    _getPipelineCacheKey(code, entryPoint) {
        return `${entryPoint}\u0000${code}`;
    }

    _invalidatePipelineCaches() {
        this._shaderModuleCache.clear();
        this._computePipelineCache.clear();
        this._cacheDevice = this.device;
    }

    _syncDeviceScopedCaches() {
        if (this._cacheDevice !== this.device) {
            this._invalidatePipelineCaches();
            this._coreBindGroupCache.clear();
        }
    }

    _getOrCreateShaderModule(code) {
        this._syncDeviceScopedCaches();
        if (this._shaderModuleCache.has(code)) {
            return this._shaderModuleCache.get(code);
        }

        const module = this.device.createShaderModule({ code });
        this._shaderModuleCache.set(code, module);
        return module;
    }

    _getOrCreateComputePipeline(code, entryPoint) {
        this._syncDeviceScopedCaches();
        const key = this._getPipelineCacheKey(code, entryPoint);
        const cached = this._computePipelineCache.get(key);
        if (cached) {
            if (typeof cached.then === 'function') {
                throw new Error(`Pipeline ${entryPoint} is still initializing asynchronously`);
            }
            return cached;
        }

        const module = this._getOrCreateShaderModule(code);
        const pipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint },
        });
        this._computePipelineCache.set(key, pipeline);
        return pipeline;
    }

    async _getOrCreateComputePipelineAsync(code, entryPoint) {
        this._syncDeviceScopedCaches();
        const key = this._getPipelineCacheKey(code, entryPoint);
        const cached = this._computePipelineCache.get(key);
        if (cached) {
            return await cached;
        }

        const module = this._getOrCreateShaderModule(code);
        const pending = this.device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module, entryPoint },
        }).then((pipeline) => {
            this._computePipelineCache.set(key, pipeline);
            return pipeline;
        }).catch((error) => {
            this._computePipelineCache.delete(key);
            throw error;
        });

        this._computePipelineCache.set(key, pending);
        return await pending;
    }

    _coreBindGroupFor(pipeline, bindings) {
        const signature = this._getCoreBindGroupSignature(bindings);
        const pipelineCache = this._coreBindGroupCache.get(pipeline);
        if (pipelineCache && pipelineCache.has(signature)) {
            return pipelineCache.get(signature);
        }

        return this._ensureCoreBindGroup(pipeline, bindings);
    }

    _getCoreBindGroupSignature(bindings) {
        return (bindings || [0, 1, 2]).join(',');
    }

    _ensureCoreBindGroup(pipeline, bindings) {
        const signature = this._getCoreBindGroupSignature(bindings);
        let pipelineCache = this._coreBindGroupCache.get(pipeline);
        if (!pipelineCache) {
            pipelineCache = new Map();
            this._coreBindGroupCache.set(pipeline, pipelineCache);
        }
        if (pipelineCache.has(signature)) {
            return pipelineCache.get(signature);
        }

        const bufferMap = {
            0: this.voltBuffer,
            1: this.currBuffer,
            2: this.paramsBuffer,
        };
        const entries = (bindings || [0, 1, 2]).map(b => ({
            binding: b,
            resource: { buffer: bufferMap[b] },
        }));

        const bg = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries,
        });
        pipelineCache.set(signature, bg);
        return bg;
    }

    _createBindGroups() {
        this._coreBindGroupCache.clear();
        this._ensureCoreBindGroup(this.voltagePipeline);
        this._ensureCoreBindGroup(this.currentPipeline);
        this._ensureCoreBindGroup(this.pmlPipeline);

        // Bind Group 1: Voltage coefficients
        this.voltCoeffBindGroup = this.device.createBindGroup({
            layout: this.voltagePipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: { buffer: this.vvBuffer } },
                { binding: 1, resource: { buffer: this.viBuffer } },
            ],
        });

        // Bind Group 2: Current coefficients (current shader uses @group(2) for ii/iv)
        this.currCoeffBindGroup = this.device.createBindGroup({
            layout: this.currentPipeline.getBindGroupLayout(2),
            entries: [
                { binding: 0, resource: { buffer: this.iiBuffer } },
                { binding: 1, resource: { buffer: this.ivBuffer } },
            ],
        });
    }

    _createExcitationBindGroup() {
        this._ensureCoreBindGroup(this.excitationPipeline, [0, 2]);
        this.excBindGroup = this.device.createBindGroup({
            layout: this.excitationPipeline.getBindGroupLayout(1),
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
