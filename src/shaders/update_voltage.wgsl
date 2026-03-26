// FDTD Voltage (E-field) Update Compute Shader
// Implements the voltage update equations from openEMS engine.cpp lines 133-163.
//
// Memory layout: ArrayNIJK — N-I-J-K ordering where N=component(0-2), I=X, J=Y, K=Z
// addr(n,i,j,k) = n*Nx*Ny*Nz + i*Ny*Nz + j*Nz + k
//
// Voltage loop bounds: X [0,Nx), Y [0,Ny), Z [0,Nz)

struct Params {
    numLines: vec3<u32>,    // grid dimensions (Nx, Ny, Nz)
    numTS: u32,             // current timestep
    shift: vec3<i32>,       // boundary shift flags (unused in simplified boundary)
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

// Neighbor access with boundary shift handling.
// When the index is 0, the neighbor wraps to self (zeroing the curl difference).
// This matches the C++ shift[] logic: shift[n] = pos[n] (nonzero when pos > 0).
fn idx_ym1(n: u32, x: u32, y: u32, z: u32) -> u32 {
    if (y == 0u) {
        return idx(n, x, y, z);  // self-reference at boundary
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

    // Ex update: dHz/dy - dHy/dz
    // Ex[x,y,z] = vv[0,x,y,z] * Ex[x,y,z] + vi[0,x,y,z] * (Hz[x,y,z] - Hz[x,y-1,z] - Hy[x,y,z] + Hy[x,y,z-1])
    let ex_idx = idx(0u, x, y, z);
    let ex_curl = curr[idx(2u, x, y, z)] - curr[idx_ym1(2u, x, y, z)]
                - curr[idx(1u, x, y, z)] + curr[idx_zm1(1u, x, y, z)];
    volt[ex_idx] = vv[ex_idx] * volt[ex_idx] + vi[ex_idx] * ex_curl;

    // Ey update: dHx/dz - dHz/dx
    // Ey[x,y,z] = vv[1,x,y,z] * Ey[x,y,z] + vi[1,x,y,z] * (Hx[x,y,z] - Hx[x,y,z-1] - Hz[x,y,z] + Hz[x-1,y,z])
    let ey_idx = idx(1u, x, y, z);
    let ey_curl = curr[idx(0u, x, y, z)] - curr[idx_zm1(0u, x, y, z)]
                - curr[idx(2u, x, y, z)] + curr[idx_xm1(2u, x, y, z)];
    volt[ey_idx] = vv[ey_idx] * volt[ey_idx] + vi[ey_idx] * ey_curl;

    // Ez update: dHy/dx - dHx/dy
    // Ez[x,y,z] = vv[2,x,y,z] * Ez[x,y,z] + vi[2,x,y,z] * (Hy[x,y,z] - Hy[x-1,y,z] - Hx[x,y,z] + Hx[x,y-1,z])
    let ez_idx = idx(2u, x, y, z);
    let ez_curl = curr[idx(1u, x, y, z)] - curr[idx_xm1(1u, x, y, z)]
                - curr[idx(0u, x, y, z)] + curr[idx_ym1(0u, x, y, z)];
    volt[ez_idx] = vv[ez_idx] * volt[ez_idx] + vi[ez_idx] * ez_curl;
}
