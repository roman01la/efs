// TFSF (Total-Field/Scattered-Field) Plane Wave Injection Shader
// Implements voltage and current injection from openEMS engine_ext_tfsf.cpp.
//
// Sparse dispatch over boundary injection points.
// Linear interpolation with fractional delay for sub-cell accuracy.

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

    // Compute delay position
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
