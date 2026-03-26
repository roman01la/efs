// UPML (Uniaxial Perfectly Matched Layer) Compute Shaders
// Implements the PML update equations from openEMS engine_ext_upml.cpp.
//
// The PML update is split into 4 phases controlled by the mode uniform:
//   mode 0: pre-voltage  — transform voltage fields before core voltage update
//   mode 1: post-voltage — restore and combine after core voltage update
//   mode 2: pre-current  — transform current fields before core current update
//   mode 3: post-current — restore and combine after core current update
//
// PML arrays are indexed locally within the PML region.
// Global field arrays use the global grid indexing.

struct Params {
    numLines: vec3<u32>,    // global grid dimensions (Nx, Ny, Nz)
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct PMLParams {
    startPos: vec3<u32>,   // PML region start in global grid
    mode: u32,             // 0=pre-volt, 1=post-volt, 2=pre-curr, 3=post-curr
    numLines: vec3<u32>,   // PML region size
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

// Global field index: addr(n, x, y, z) in the full grid
fn idx(n: u32, x: u32, y: u32, z: u32) -> u32 {
    let Ny = params.numLines.y;
    let Nz = params.numLines.z;
    return n * params.numLines.x * Ny * Nz + x * Ny * Nz + y * Nz + z;
}

// PML local index: addr(n, lx, ly, lz) within PML region
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
            // Pre-voltage: f_help = vv * V - vvfo * flux; V = flux; flux = f_help
            let f_help = pml_vv[p] * volt[g] - pml_vvfo[p] * volt_flux[p];
            volt[g] = volt_flux[p];
            volt_flux[p] = f_help;
        } else if (mode == 1u) {
            // Post-voltage: f_help = flux; flux = V; V = f_help + vvfn * flux
            let f_help = volt_flux[p];
            volt_flux[p] = volt[g];
            volt[g] = f_help + pml_vvfn[p] * volt_flux[p];
        } else if (mode == 2u) {
            // Pre-current: f_help = ii * I - iifo * flux; I = flux; flux = f_help
            let f_help = pml_ii[p] * curr[g] - pml_iifo[p] * curr_flux[p];
            curr[g] = curr_flux[p];
            curr_flux[p] = f_help;
        } else if (mode == 3u) {
            // Post-current: f_help = flux; flux = I; I = f_help + iifn * flux
            let f_help = curr_flux[p];
            curr_flux[p] = curr[g];
            curr[g] = f_help + pml_iifn[p] * curr_flux[p];
        }
    }
}
