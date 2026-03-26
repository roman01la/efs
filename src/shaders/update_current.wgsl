// FDTD Current (H-field) Update Compute Shader
// Implements the current update equations from openEMS engine.cpp lines 187-217.
//
// Memory layout: ArrayNIJK — N-I-J-K ordering where N=component(0-2), I=X, J=Y, K=Z
// addr(n,i,j,k) = n*Nx*Ny*Nz + i*Ny*Nz + j*Nz + k
//
// Current loop bounds: X [0,Nx), Y [0,Ny-1), Z [0,Nz-1)
// One fewer in Y and Z because the curl stencil reads +1 neighbors.

struct Params {
    numLines: vec3<u32>,    // grid dimensions (Nx, Ny, Nz)
    numTS: u32,             // current timestep
    shift: vec3<i32>,       // boundary shift flags
    _pad: u32,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(1) var<storage, read_write> curr: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(2) @binding(0) var<storage, read> ii: array<f32>;
@group(2) @binding(1) var<storage, read> iv: array<f32>;

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

    // Current loops have tighter bounds: X < Nx-1, Y < Ny-1, Z < Nz-1
    // X is also one fewer because Hy/Hz curl stencils read volt at x+1.
    // Matches C++: UpdateCurrents(0, numLines[0]-1)
    if (x >= params.numLines.x - 1u || y >= params.numLines.y - 1u || z >= params.numLines.z - 1u) {
        return;
    }

    // Hx update: dEz/dy - dEy/dz (note sign convention: y+1 subtracted)
    // Hx[x,y,z] = ii[0,x,y,z] * Hx[x,y,z] + iv[0,x,y,z] * (Ez[x,y,z] - Ez[x,y+1,z] - Ey[x,y,z] + Ey[x,y,z+1])
    let hx_idx = idx(0u, x, y, z);
    let hx_curl = volt[idx(2u, x, y, z)] - volt[idx(2u, x, y + 1u, z)]
                - volt[idx(1u, x, y, z)] + volt[idx(1u, x, y, z + 1u)];
    curr[hx_idx] = ii[hx_idx] * curr[hx_idx] + iv[hx_idx] * hx_curl;

    // Hy update: dEx/dz - dEz/dx
    // Hy[x,y,z] = ii[1,x,y,z] * Hy[x,y,z] + iv[1,x,y,z] * (Ex[x,y,z] - Ex[x,y,z+1] - Ez[x,y,z] + Ez[x+1,y,z])
    let hy_idx = idx(1u, x, y, z);
    let hy_curl = volt[idx(0u, x, y, z)] - volt[idx(0u, x, y, z + 1u)]
                - volt[idx(2u, x, y, z)] + volt[idx(2u, x + 1u, y, z)];
    curr[hy_idx] = ii[hy_idx] * curr[hy_idx] + iv[hy_idx] * hy_curl;

    // Hz update: dEy/dx - dEx/dy
    // Hz[x,y,z] = ii[2,x,y,z] * Hz[x,y,z] + iv[2,x,y,z] * (Ey[x,y,z] - Ey[x+1,y,z] - Ex[x,y,z] + Ex[x,y+1,z])
    let hz_idx = idx(2u, x, y, z);
    let hz_curl = volt[idx(1u, x, y, z)] - volt[idx(1u, x + 1u, y, z)]
                - volt[idx(0u, x, y, z)] + volt[idx(0u, x, y + 1u, z)];
    curr[hz_idx] = ii[hz_idx] * curr[hz_idx] + iv[hz_idx] * hz_curl;
}
