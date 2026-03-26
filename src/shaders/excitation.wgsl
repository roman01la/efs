// FDTD Excitation (Source Injection) Compute Shader
// Implements voltage excitation from openEMS engine_ext_excitation.cpp lines 34-59.
//
// This is a sparse operation: iterates over a list of excitation points,
// each injecting amp * signal[timestep - delay] into a specific field component.

struct Params {
    numLines: vec3<u32>,    // grid dimensions (Nx, Ny, Nz)
    numTS: u32,             // current timestep
    shift: vec3<i32>,       // boundary shift flags
    _pad: u32,
};

struct ExcParams {
    numTS: u32,             // current timestep for excitation
    signalLength: u32,      // length of the excitation signal array
    period: u32,            // signal period (0 = non-periodic)
    numExcitations: u32,    // number of excitation points
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(1) var<storage, read_write> curr: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> exc: ExcParams;
@group(1) @binding(1) var<storage, read> signal: array<f32>;
@group(1) @binding(2) var<storage, read> delay: array<u32>;
@group(1) @binding(3) var<storage, read> amp: array<f32>;
@group(1) @binding(4) var<storage, read> dir: array<u32>;     // component direction (0,1,2)
@group(1) @binding(5) var<storage, read> pos: array<u32>;     // packed linear position (x*Ny*Nz + y*Nz + z)

@compute @workgroup_size(256)
fn apply_excitation(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= exc.numExcitations) {
        return;
    }

    // Compute excitation position in signal array
    // Matches C++: exc_pos = numTS - (int)delay[n]
    var exc_pos: i32 = i32(exc.numTS) - i32(delay[n]);

    // exc_pos *= (exc_pos > 0) — clamp negative to 0
    if (exc_pos < 0) {
        exc_pos = 0;
    }

    // Handle periodic signals: exc_pos %= period
    if (exc.period > 0u) {
        exc_pos = exc_pos % i32(exc.period);
    }

    // exc_pos *= (exc_pos < length) — zero out if past signal end (matches C++)
    if (exc_pos >= i32(exc.signalLength)) {
        exc_pos = 0;
    }

    // Inject: V[dir][pos] += amp * signal[exc_pos]
    let component_offset = dir[n] * params.numLines.x * params.numLines.y * params.numLines.z;
    let field_idx = component_offset + pos[n];

    volt[field_idx] = volt[field_idx] + amp[n] * signal[u32(exc_pos)];
}
