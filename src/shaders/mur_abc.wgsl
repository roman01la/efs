// Mur Absorbing Boundary Condition Shader
// Implements first-order Mur ABC from openEMS engine_ext_mur_abc.cpp.
//
// Three entry points: pre_voltage (save), post_voltage (accumulate), apply (overwrite).
// Sparse dispatch over boundary face cells.
// Per-point coefficients matching C++ m_Mur_Coeff_nyP(i,j).

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
