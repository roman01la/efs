// Periodic Boundary Condition (PBC) Copy Shader
// Copies tangential field components between boundary faces with optional
// Bloch/Floquet phase rotation.
//
// For voltage (E-field): copy from high face to low face after voltage update.
// For current (H-field): copy from low face to high face after current update.
//
// Tangential components for axis a: (a+1)%3 and (a+2)%3
//
// When sinPhase == 0: simple copy (zero phase PBC).
// When sinPhase != 0: Bloch exp(j*phi) rotation using auxiliary imaginary buffers:
//   dst_real = cos*src_real - sin*src_imag
//   dst_imag = sin*src_real + cos*src_imag

struct PBCParams {
    axis: u32,          // 0=x, 1=y, 2=z
    mode: u32,          // 0=voltage, 1=current
    srcFaceIdx: u32,    // grid index of source face along axis
    dstFaceIdx: u32,    // grid index of destination face along axis
    faceSize0: u32,     // size along tangential direction 0
    faceSize1: u32,     // size along tangential direction 1
    cosPhase: f32,
    sinPhase: f32,
    numLinesX: u32,
    numLinesY: u32,
    numLinesZ: u32,
    imagOffset: u32,    // offset into shared imaginary buffer for this axis
    solverBound0: u32,  // copy bound for tangential direction 0
    solverBound1: u32,  // copy bound for tangential direction 1
    _pad0: u32,
    _pad1: u32,         // pad to 64 bytes (16-byte alignment)
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(1) var<storage, read_write> curr: array<f32>;

@group(1) @binding(0) var<uniform> pbc: PBCParams;
@group(1) @binding(1) var<storage, read_write> imag_buf: array<f32>;

fn field_idx(n: u32, x: u32, y: u32, z: u32) -> u32 {
    let Ny = pbc.numLinesY;
    let Nz = pbc.numLinesZ;
    return n * pbc.numLinesX * Ny * Nz + x * Ny * Nz + y * Nz + z;
}

// Map 2D face coordinates (i0, i1) to 3D grid coordinates for a given axis and face index
fn face_to_grid(axis: u32, faceIdx: u32, i0: u32, i1: u32) -> vec3<u32> {
    // Tangential directions: tang0 = (axis+1)%3, tang1 = (axis+2)%3
    var pos: vec3<u32>;
    if (axis == 0u) {
        pos = vec3<u32>(faceIdx, i0, i1);
    } else if (axis == 1u) {
        pos = vec3<u32>(i1, faceIdx, i0);
    } else {
        pos = vec3<u32>(i0, i1, faceIdx);
    }
    return pos;
}

@compute @workgroup_size(8, 8)
fn pbc_copy(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i0 = gid.x;
    let i1 = gid.y;

    if (i0 >= pbc.solverBound0 || i1 >= pbc.solverBound1) {
        return;
    }

    let axis = pbc.axis;
    let tang0 = (axis + 1u) % 3u;
    let tang1 = (axis + 2u) % 3u;

    let srcPos = face_to_grid(axis, pbc.srcFaceIdx, i0, i1);
    let dstPos = face_to_grid(axis, pbc.dstFaceIdx, i0, i1);

    // Face linear index for imaginary buffer
    let faceLinear = i0 * pbc.faceSize1 + i1;

    if (pbc.mode == 0u) {
        // Voltage mode: copy tangential E-fields
        let srcIdx0 = field_idx(tang0, srcPos.x, srcPos.y, srcPos.z);
        let dstIdx0 = field_idx(tang0, dstPos.x, dstPos.y, dstPos.z);
        let srcIdx1 = field_idx(tang1, srcPos.x, srcPos.y, srcPos.z);
        let dstIdx1 = field_idx(tang1, dstPos.x, dstPos.y, dstPos.z);

        if (pbc.sinPhase == 0.0) {
            // Simple copy (zero phase)
            volt[dstIdx0] = pbc.cosPhase * volt[srcIdx0];
            volt[dstIdx1] = pbc.cosPhase * volt[srcIdx1];
        } else {
            // Bloch rotation
            let imOff0 = pbc.imagOffset + faceLinear;
            let imOff1 = pbc.imagOffset + pbc.faceSize0 * pbc.faceSize1 + faceLinear;
            let srcReal0 = volt[srcIdx0];
            let srcImag0 = imag_buf[imOff0];
            volt[dstIdx0] = pbc.cosPhase * srcReal0 - pbc.sinPhase * srcImag0;
            imag_buf[imOff0] = pbc.sinPhase * srcReal0 + pbc.cosPhase * srcImag0;

            let srcReal1 = volt[srcIdx1];
            let srcImag1 = imag_buf[imOff1];
            volt[dstIdx1] = pbc.cosPhase * srcReal1 - pbc.sinPhase * srcImag1;
            imag_buf[imOff1] = pbc.sinPhase * srcReal1 + pbc.cosPhase * srcImag1;
        }
    } else {
        // Current mode: copy tangential H-fields
        let srcIdx0 = field_idx(tang0, srcPos.x, srcPos.y, srcPos.z);
        let dstIdx0 = field_idx(tang0, dstPos.x, dstPos.y, dstPos.z);
        let srcIdx1 = field_idx(tang1, srcPos.x, srcPos.y, srcPos.z);
        let dstIdx1 = field_idx(tang1, dstPos.x, dstPos.y, dstPos.z);

        if (pbc.sinPhase == 0.0) {
            curr[dstIdx0] = pbc.cosPhase * curr[srcIdx0];
            curr[dstIdx1] = pbc.cosPhase * curr[srcIdx1];
        } else {
            let imBase = pbc.imagOffset + 2u * pbc.faceSize0 * pbc.faceSize1;
            let imOff0 = imBase + faceLinear;
            let imOff1 = imBase + pbc.faceSize0 * pbc.faceSize1 + faceLinear;
            let srcReal0 = curr[srcIdx0];
            let srcImag0 = imag_buf[imOff0];
            curr[dstIdx0] = pbc.cosPhase * srcReal0 - pbc.sinPhase * srcImag0;
            imag_buf[imOff0] = pbc.sinPhase * srcReal0 + pbc.cosPhase * srcImag0;

            let srcReal1 = curr[srcIdx1];
            let srcImag1 = imag_buf[imOff1];
            curr[dstIdx1] = pbc.cosPhase * srcReal1 - pbc.sinPhase * srcImag1;
            imag_buf[imOff1] = pbc.sinPhase * srcReal1 + pbc.cosPhase * srcImag1;
        }
    }
}
