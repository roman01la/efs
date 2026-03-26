// Lorentz/Drude Dispersive Material ADE (Auxiliary Differential Equation) Shader
// Implements voltage and current ADE updates from openEMS engine_ext_lorentzmaterial.cpp.
//
// Sparse 1D dispatch over dispersive cells.
// hasLorentz flag selects Lorentz pole (with accumulator) vs pure Drude mode.

struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct ADEParams {
    numCells: u32,       // number of dispersive cells for this order+direction
    hasLorentz: u32,     // 1 if Lorentz pole present, 0 for pure Drude
    direction: u32,      // field component (0=x, 1=y, 2=z)
    componentStride: u32, // Nx*Ny*Nz for indexing into global field
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
        // Lorentz pole: accumulate before updating ADE
        volt_Lor_ADE[i] += v_Lor_ADE[i] * volt_ADE[i];
        volt_ADE[i] = v_int_ADE[i] * volt_ADE[i]
                     + v_ext_ADE[i] * (V - volt_Lor_ADE[i]);
    } else {
        // Pure Drude: no Lorentz accumulator
        volt_ADE[i] = v_int_ADE[i] * volt_ADE[i]
                     + v_ext_ADE[i] * V;
    }
}

// Current ADE update - structurally identical, operates on curr buffer
// In a full implementation this would be a separate entry point with curr bindings
