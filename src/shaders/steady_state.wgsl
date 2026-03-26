// Steady-State Detection Energy Accumulation Shader
// Accumulates E-field energy at probe points for convergence detection.
//
// Energy is accumulated into period1 or period2 buffers depending on
// the current sample index relative to the period length.

struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct SSParams {
    numProbes: u32,
    periodSamples: u32,    // samples per period
    currentSample: u32,    // sample index within recording window
    recording: u32,        // 1 if currently recording, 0 otherwise
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
