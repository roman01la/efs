// GPU Probe Shader — voltage line integrals and current surface integrals.
// Matches openEMS ProcessVoltage::CalcIntegral and ProcessCurrent::CalcIntegral.

struct ProbeParams {
    numProbes: u32,
    Nx: u32,
    Ny: u32,
    Nz: u32,
};

// 48 bytes per probe (12 x u32, aligned to 16)
struct ProbeDef {
    startX: u32, startY: u32, startZ: u32,
    stopX: u32,  stopY: u32,  stopZ: u32,
    normDir: u32,    // voltage: integration direction; current: surface normal
    sign: f32,       // +1 or -1
    probeType: u32,  // 0=voltage, 1=current
    insideFlags: u32,// bits: 0-2 = start_inside[x,y,z], 3-5 = stop_inside[x,y,z]
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<storage, read> volt: array<f32>;
@group(0) @binding(1) var<storage, read> curr: array<f32>;
@group(0) @binding(2) var<uniform> params: ProbeParams;
@group(0) @binding(3) var<storage, read> probes: array<ProbeDef>;
@group(0) @binding(4) var<storage, read_write> results: array<f32>;

fn vidx(n: u32, x: u32, y: u32, z: u32) -> u32 {
    return n * params.Nx * params.Ny * params.Nz + x * params.Ny * params.Nz + y * params.Nz + z;
}

fn startInside(flags: u32, dim: u32) -> bool { return (flags & (1u << dim)) != 0u; }
fn stopInside(flags: u32, dim: u32) -> bool  { return (flags & (8u << dim)) != 0u; }

@compute @workgroup_size(64)
fn probe_fields(@builtin(global_invocation_id) gid: vec3<u32>) {
    let pid = gid.x;
    if (pid >= params.numProbes) { return; }

    let p = probes[pid];
    var sum: f32 = 0.0;

    if (p.probeType == 0u) {
        // === VOLTAGE PROBE: 1D line integral of E-field ===
        // sum GetVolt(n, x, y, z) along the varying dimension
        // Matches Engine_Interface_FDTD::CalcVoltageIntegral
        let n = p.normDir;
        if (p.startX != p.stopX) {
            let lo = min(p.startX, p.stopX);
            let hi = max(p.startX, p.stopX);
            for (var x = lo; x < hi; x++) {
                sum += volt[vidx(n, x, p.startY, p.startZ)];
            }
            if (p.startX > p.stopX) { sum = -sum; }
        } else if (p.startY != p.stopY) {
            let lo = min(p.startY, p.stopY);
            let hi = max(p.startY, p.stopY);
            for (var y = lo; y < hi; y++) {
                sum += volt[vidx(n, p.startX, y, p.startZ)];
            }
            if (p.startY > p.stopY) { sum = -sum; }
        } else if (p.startZ != p.stopZ) {
            let lo = min(p.startZ, p.stopZ);
            let hi = max(p.startZ, p.stopZ);
            for (var z = lo; z < hi; z++) {
                sum += volt[vidx(n, p.startX, p.startY, z)];
            }
            if (p.startZ > p.stopZ) { sum = -sum; }
        }
    } else {
        // === CURRENT PROBE: 2D surface integral (Ampere's law) ===
        // Integrates H-field (curr) around the perimeter of a rectangular surface.
        // Matches ProcessCurrent::CalcIntegral exactly.
        let nd = p.normDir;
        let f = p.insideFlags;

        if (nd == 0u) {
            // normDir=X: surface in YZ plane
            // +y-curr along right edge (x=stop, z=start)
            if (stopInside(f, 0u) && startInside(f, 2u)) {
                for (var i = p.startY + 1u; i <= p.stopY; i++) {
                    sum += curr[vidx(1u, p.stopX, i, p.startZ)];
                }
            }
            // +z-curr along top edge (x=stop, y=stop)
            if (stopInside(f, 0u) && stopInside(f, 1u)) {
                for (var i = p.startZ + 1u; i <= p.stopZ; i++) {
                    sum += curr[vidx(2u, p.stopX, p.stopY, i)];
                }
            }
            // -y-curr along left edge (x=start, z=stop)
            if (startInside(f, 0u) && stopInside(f, 2u)) {
                for (var i = p.startY + 1u; i <= p.stopY; i++) {
                    sum -= curr[vidx(1u, p.startX, i, p.stopZ)];
                }
            }
            // -z-curr along bottom edge (x=start, y=start)
            if (startInside(f, 0u) && startInside(f, 1u)) {
                for (var i = p.startZ + 1u; i <= p.stopZ; i++) {
                    sum -= curr[vidx(2u, p.startX, p.startY, i)];
                }
            }
        } else if (nd == 1u) {
            // normDir=Y: surface in XZ plane
            // +z-curr (x=start, y=start)
            if (startInside(f, 0u) && startInside(f, 1u)) {
                for (var i = p.startZ + 1u; i <= p.stopZ; i++) {
                    sum += curr[vidx(2u, p.startX, p.startY, i)];
                }
            }
            // +x-curr (y=stop, z=stop)
            if (stopInside(f, 1u) && stopInside(f, 2u)) {
                for (var i = p.startX + 1u; i <= p.stopX; i++) {
                    sum += curr[vidx(0u, i, p.stopY, p.stopZ)];
                }
            }
            // -z-curr (x=stop, y=stop)
            if (stopInside(f, 0u) && stopInside(f, 1u)) {
                for (var i = p.startZ + 1u; i <= p.stopZ; i++) {
                    sum -= curr[vidx(2u, p.stopX, p.stopY, i)];
                }
            }
            // -x-curr (y=start, z=start)
            if (startInside(f, 1u) && startInside(f, 2u)) {
                for (var i = p.startX + 1u; i <= p.stopX; i++) {
                    sum -= curr[vidx(0u, i, p.startY, p.startZ)];
                }
            }
        } else {
            // normDir=Z: surface in XY plane
            // +x-curr (y=start, z=start)
            if (startInside(f, 1u) && startInside(f, 2u)) {
                for (var i = p.startX + 1u; i <= p.stopX; i++) {
                    sum += curr[vidx(0u, i, p.startY, p.startZ)];
                }
            }
            // +y-curr (x=stop, z=start)
            if (stopInside(f, 0u) && startInside(f, 2u)) {
                for (var i = p.startY + 1u; i <= p.stopY; i++) {
                    sum += curr[vidx(1u, p.stopX, i, p.startZ)];
                }
            }
            // -x-curr (y=stop, z=stop)
            if (stopInside(f, 1u) && stopInside(f, 2u)) {
                for (var i = p.startX + 1u; i <= p.stopX; i++) {
                    sum -= curr[vidx(0u, i, p.stopY, p.stopZ)];
                }
            }
            // -y-curr (x=start, z=stop)
            if (startInside(f, 0u) && stopInside(f, 2u)) {
                for (var i = p.startY + 1u; i <= p.stopY; i++) {
                    sum -= curr[vidx(1u, p.startX, i, p.stopZ)];
                }
            }
        }
    }

    results[pid] = sum * p.sign;
}
