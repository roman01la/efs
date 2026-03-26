// Lumped RLC Element Update Shader
// Implements discrete circuit components from openEMS engine_ext_lumpedRLC.cpp.
//
// Sparse dispatch over RLC elements.
// 3-deep history buffers (Vdn, Jn), parallel vs series mode flag.

struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
    _pad: u32,
};

struct RLCParams {
    numElements: u32,
    componentStride: u32,  // Nx*Ny*Nz
    _pad: vec2<u32>,
};

struct RLCElement {
    field_idx: u32,
    direction: u32,
    type_flag: u32,    // 0=parallel, 1=series
    i2v: f32,
    ilv: f32,
    vvd: f32,
    vv2: f32,
    vj1: f32,
    vj2: f32,
    ib0: f32,
    b1: f32,
    b2: f32,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> rlc: RLCParams;
@group(1) @binding(1) var<storage, read> elements: array<RLCElement>;
@group(1) @binding(2) var<storage, read_write> Vdn: array<f32>;    // [numElements * 3]
@group(1) @binding(3) var<storage, read_write> Jn: array<f32>;     // [numElements * 3]
@group(1) @binding(4) var<storage, read_write> v_Il: array<f32>;   // [numElements]

@compute @workgroup_size(256)
fn update_rlc(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= rlc.numElements) {
        return;
    }

    let elem = elements[n];
    let g = elem.direction * rlc.componentStride + elem.field_idx;

    // History buffer indices: [n*3 + 0] = current, [n*3 + 1] = prev, [n*3 + 2] = prev-prev
    let h0 = n * 3u;
    let h1 = n * 3u + 1u;
    let h2 = n * 3u + 2u;

    // Shift history: [2] <- [1], [1] <- [0]
    Vdn[h2] = Vdn[h1];
    Vdn[h1] = Vdn[h0];
    Jn[h2] = Jn[h1];
    Jn[h1] = Jn[h0];

    // Read current field value as Vdn[0]
    Vdn[h0] = volt[g];

    if (elem.type_flag == 0u) {
        // Parallel RLC
        v_Il[n] += elem.i2v * elem.ilv * Vdn[h1];
        // Parallel modifies the voltage through the operator coefficients;
        // the inductor current feeds back into the next voltage update.
    } else {
        // Series RLC
        let Il = v_Il[n];
        Vdn[h0] = elem.vvd * (Vdn[h0] - Il
                 + elem.vv2 * Vdn[h2]
                 + elem.vj1 * Jn[h1]
                 + elem.vj2 * Jn[h2]);

        // Update current J
        Jn[h0] = elem.ib0 * (Vdn[h0] - Vdn[h2])
                - elem.b1 * elem.ib0 * Jn[h1]
                - elem.b2 * elem.ib0 * Jn[h2];

        // Write back modified voltage
        volt[g] = Vdn[h0];
    }
}
