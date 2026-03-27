// GPU Probe Shader — reads field values at specific grid positions
// and computes voltage/current line integrals directly on the GPU.
//
// Each probe is a 1D line integral: sum of field values along one axis.
// Output: one f32 value per probe.

struct ProbeParams {
    numProbes: u32,
    Nx: u32,
    Ny: u32,
    Nz: u32,
};

// Probe definition: start/stop grid coordinates + sign (+1 or -1)
struct ProbeDef {
    startX: u32,
    startY: u32,
    startZ: u32,
    stopX: u32,
    stopY: u32,
    stopZ: u32,
    component: u32,   // 0=x, 1=y, 2=z — which field component to integrate
    sign: f32,         // +1.0 or -1.0 (integration direction)
};

@group(0) @binding(0) var<storage, read> volt: array<f32>;
@group(0) @binding(1) var<storage, read> curr: array<f32>;
@group(0) @binding(2) var<uniform> params: ProbeParams;
@group(0) @binding(3) var<storage, read> probes: array<ProbeDef>;
@group(0) @binding(4) var<storage, read_write> results: array<f32>;

@compute @workgroup_size(64)
fn probe_fields(@builtin(global_invocation_id) gid: vec3<u32>) {
    let probeIdx = gid.x;
    if (probeIdx >= params.numProbes) {
        return;
    }

    let p = probes[probeIdx];
    let Nx = params.Nx;
    let Ny = params.Ny;
    let Nz = params.Nz;
    let stride = Nx * Ny * Nz;

    var sum: f32 = 0.0;

    // 1D line integral along the axis that differs between start and stop
    if (p.startX != p.stopX) {
        let lo = min(p.startX, p.stopX);
        let hi = max(p.startX, p.stopX);
        for (var x = lo; x < hi; x++) {
            let idx = p.component * stride + x * Ny * Nz + p.startY * Nz + p.startZ;
            sum += volt[idx];
        }
    } else if (p.startY != p.stopY) {
        let lo = min(p.startY, p.stopY);
        let hi = max(p.startY, p.stopY);
        for (var y = lo; y < hi; y++) {
            let idx = p.component * stride + p.startX * Ny * Nz + y * Nz + p.startZ;
            sum += volt[idx];
        }
    } else if (p.startZ != p.stopZ) {
        let lo = min(p.startZ, p.stopZ);
        let hi = max(p.startZ, p.stopZ);
        for (var z = lo; z < hi; z++) {
            let idx = p.component * stride + p.startX * Ny * Nz + p.startY * Nz + z;
            sum += volt[idx];
        }
    }

    results[probeIdx] = sum * p.sign;
}
