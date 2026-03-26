# Phase 3: WebGPU Acceleration

## Overview

This phase implements the core FDTD update equations as WebGPU compute shaders, replacing the CPU engine with GPU-accelerated kernels. The design is derived directly from the openEMS engine source code (`engine.cpp`, `operator.h`, `engine_sse.cpp`).

---

## Core FDTD Update Equations

### Voltage (E-field) Update

From `engine.cpp` lines 133-163:

```
Ex[x,y,z] = vv[0,x,y,z] * Ex[x,y,z] + vi[0,x,y,z] * (Hz[x,y,z] - Hz[x,y-1,z] - Hy[x,y,z] + Hy[x,y,z-1])
Ey[x,y,z] = vv[1,x,y,z] * Ey[x,y,z] + vi[1,x,y,z] * (Hx[x,y,z] - Hx[x,y,z-1] - Hz[x,y,z] + Hz[x-1,y,z])
Ez[x,y,z] = vv[2,x,y,z] * Ez[x,y,z] + vi[2,x,y,z] * (Hy[x,y,z] - Hy[x-1,y,z] - Hx[x,y,z] + Hx[x,y-1,z])
```

Loop bounds: X in `[0, numLines[0])`, Y in `[0, numLines[1])`, Z in `[0, numLines[2])`.

Uses `shift[]` array for boundary handling when any index is 0 (wraps neighbor access to avoid underflow).

### Current (H-field) Update

From `engine.cpp` lines 187-217:

```
Hx[x,y,z] = ii[0,x,y,z] * Hx[x,y,z] + iv[0,x,y,z] * (Ez[x,y,z] - Ez[x,y+1,z] - Ey[x,y,z] + Ey[x,y,z+1])
Hy[x,y,z] = ii[1,x,y,z] * Hy[x,y,z] + iv[1,x,y,z] * (Ex[x,y,z] - Ex[x,y,z+1] - Ez[x,y,z] + Ez[x+1,y,z])
Hz[x,y,z] = ii[2,x,y,z] * Hz[x,y,z] + iv[2,x,y,z] * (Ey[x,y,z] - Ey[x+1,y,z] - Ex[x,y,z] + Ex[x,y+1,z])
```

Loop bounds: X in `[0, numLines[0])`, Y in `[0, numLines[1]-1)`, Z in `[0, numLines[2]-1)`.

Note the asymmetry: current loops exclude the last row in Y and Z because the curl stencil reads `+1` neighbors.

---

## Memory Layout

### ArrayNIJK Format

From `operator.h`:

- 4D array with N-I-J-K ordering where N=component (0-2), I=X, J=Y, K=Z
- Strides: `stride[0] = Nx*Ny*Nz` (component), `stride[1] = Ny*Nz` (X), `stride[2] = Nz` (Y), `stride[3] = 1` (Z)
- Linear address: `addr(n,i,j,k) = n*Nx*Ny*Nz + i*Ny*Nz + j*Nz + k`
- Z is the innermost dimension (stride=1), which is favorable for GPU coalesced access

### Coefficient Arrays

From `operator.h` lines 364-367:

| Array | Purpose |
|-------|---------|
| `vv_ptr` | Voltage self-coupling (material loss) |
| `vi_ptr` | Voltage curl-coupling (permittivity) |
| `ii_ptr` | Current self-coupling (material loss) |
| `iv_ptr` | Current curl-coupling (permeability) |

All are `ArrayNIJK<FDTD_FLOAT>` with identical layout.

---

## GPU Buffer Layout

### Buffer Assignments

```
// Field buffers — read/write
Buffer 0: volt     — E-field components [3 * Nx * Ny * Nz] f32
Buffer 1: curr     — H-field components [3 * Nx * Ny * Nz] f32

// Coefficient buffers — read-only after upload
Buffer 2: vv       — voltage self-coupling  [3 * Nx * Ny * Nz] f32
Buffer 3: vi       — voltage curl-coupling   [3 * Nx * Ny * Nz] f32
Buffer 4: ii       — current self-coupling   [3 * Nx * Ny * Nz] f32
Buffer 5: iv       — current curl-coupling   [3 * Nx * Ny * Nz] f32

// Uniform buffer
Buffer 6: params   — grid dimensions, timestep index, shift flags
```

### Uniform Parameters Structure

```wgsl
struct Params {
    numLines: vec3<u32>,    // grid dimensions (Nx, Ny, Nz)
    numTS: u32,             // current timestep
    shift: vec3<i32>,       // boundary shift flags
    _pad: u32,
};
```

### Bind Group Assignments

```
Bind Group 0 — Core FDTD (shared by E and H shaders):
  @binding(0) volt:   storage<read_write>
  @binding(1) curr:   storage<read_write>
  @binding(2) params: uniform

Bind Group 1 — Voltage coefficients:
  @binding(0) vv: storage<read>
  @binding(1) vi: storage<read>

Bind Group 2 — Current coefficients:
  @binding(0) ii: storage<read>
  @binding(1) iv: storage<read>

Bind Group 3 — PML (see PML section):
  @binding(0) pml_params:  uniform
  @binding(1) volt_flux:   storage<read_write>
  @binding(2) curr_flux:   storage<read_write>
  @binding(3) pml_vv:      storage<read>
  @binding(4) pml_vvfo:    storage<read>
  @binding(5) pml_vvfn:    storage<read>
  @binding(6) pml_ii:      storage<read>
  @binding(7) pml_iifo:    storage<read>
  @binding(8) pml_iifn:    storage<read>

Bind Group 4 — Excitation:
  @binding(0) exc_params:   uniform
  @binding(1) exc_signal:   storage<read>
  @binding(2) exc_delay:    storage<read>
  @binding(3) exc_amp:      storage<read>
  @binding(4) exc_dir:      storage<read>
  @binding(5) exc_pos:      storage<read>
```

---

## WGSL Shader Code

### Voltage (E-field) Update Shader

```wgsl
struct Params {
    numLines: vec3<u32>,
    numTS: u32,
    shift: vec3<i32>,
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
// When the index is 0, shift[] controls whether the neighbor wraps
// (shift=0 means the subtracted neighbor is the same cell, zeroing the diff).
fn idx_ym1(n: u32, x: u32, y: u32, z: u32) -> u32 {
    if (y == 0u) {
        return idx(n, x, y, z);  // self-reference when at boundary
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

@compute @workgroup_size(4, 4, 16)
fn update_voltages(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let z = gid.z;

    if (x >= params.numLines.x || y >= params.numLines.y || z >= params.numLines.z) {
        return;
    }

    // Ex update: dHz/dy - dHy/dz
    let ex_idx = idx(0u, x, y, z);
    let ex_curl = curr[idx(2u, x, y, z)] - curr[idx_ym1(2u, x, y, z)]
                - curr[idx(1u, x, y, z)] + curr[idx_zm1(1u, x, y, z)];
    volt[ex_idx] = vv[ex_idx] * volt[ex_idx] + vi[ex_idx] * ex_curl;

    // Ey update: dHx/dz - dHz/dx
    let ey_idx = idx(1u, x, y, z);
    let ey_curl = curr[idx(0u, x, y, z)] - curr[idx_zm1(0u, x, y, z)]
                - curr[idx(2u, x, y, z)] + curr[idx_xm1(2u, x, y, z)];
    volt[ey_idx] = vv[ey_idx] * volt[ey_idx] + vi[ey_idx] * ey_curl;

    // Ez update: dHy/dx - dHx/dy
    let ez_idx = idx(2u, x, y, z);
    let ez_curl = curr[idx(1u, x, y, z)] - curr[idx_xm1(1u, x, y, z)]
                - curr[idx(0u, x, y, z)] + curr[idx_ym1(0u, x, y, z)];
    volt[ez_idx] = vv[ez_idx] * volt[ez_idx] + vi[ez_idx] * ez_curl;
}
```

### Current (H-field) Update Shader

```wgsl
@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(1) var<storage, read_write> curr: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(2) @binding(0) var<storage, read> ii: array<f32>;
@group(2) @binding(1) var<storage, read> iv: array<f32>;

@compute @workgroup_size(4, 4, 16)
fn update_currents(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let z = gid.z;

    // Current loops have tighter bounds: Y < numLines.y-1, Z < numLines.z-1
    if (x >= params.numLines.x || y >= params.numLines.y - 1u || z >= params.numLines.z - 1u) {
        return;
    }

    // Hx update: dEz/dy - dEy/dz  (note sign convention: y+1 subtracted)
    let hx_idx = idx(0u, x, y, z);
    let hx_curl = volt[idx(2u, x, y, z)] - volt[idx(2u, x, y + 1u, z)]
                - volt[idx(1u, x, y, z)] + volt[idx(1u, x, y, z + 1u)];
    curr[hx_idx] = ii[hx_idx] * curr[hx_idx] + iv[hx_idx] * hx_curl;

    // Hy update: dEx/dz - dEz/dx
    let hy_idx = idx(1u, x, y, z);
    let hy_curl = volt[idx(0u, x, y, z)] - volt[idx(0u, x, y, z + 1u)]
                - volt[idx(2u, x, y, z)] + volt[idx(2u, x + 1u, y, z)];
    curr[hy_idx] = ii[hy_idx] * curr[hy_idx] + iv[hy_idx] * hy_curl;

    // Hz update: dEy/dx - dEx/dy
    let hz_idx = idx(2u, x, y, z);
    let hz_curl = volt[idx(1u, x, y, z)] - volt[idx(1u, x + 1u, y, z)]
                - volt[idx(0u, x, y, z)] + volt[idx(0u, x, y + 1u, z)];
    curr[hz_idx] = ii[hz_idx] * curr[hz_idx] + iv[hz_idx] * hz_curl;
}
```

### Dispatch Dimensions

```
Voltage update:
  workgroup_size = (4, 4, 16)
  dispatch = (ceil(Nx/4), ceil(Ny/4), ceil(Nz/16))

Current update:
  workgroup_size = (4, 4, 16)
  dispatch = (ceil(Nx/4), ceil((Ny-1)/4), ceil((Nz-1)/16))
```

The workgroup size of `(4, 4, 16)` = 256 threads, which is a common sweet spot. Z=16 exploits the stride-1 innermost dimension for coalesced memory access.

---

## PML Shader

From `engine_ext_upml.cpp`. The UPML uses 6 coefficient arrays and 2 auxiliary flux arrays per field type. The update is split into pre- and post-voltage (and current) phases.

### PML Uniform Parameters

```wgsl
struct PMLParams {
    startPos: vec3<u32>,   // m_StartPos[3] — PML region start
    numLines: vec3<u32>,   // m_numLines[3] — PML region size
    _pad: vec2<u32>,
};
```

### PML Pre-Voltage Shader

```wgsl
@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(3) @binding(0) var<uniform> pml: PMLParams;
@group(3) @binding(1) var<storage, read_write> volt_flux: array<f32>;
@group(3) @binding(3) var<storage, read> pml_vv: array<f32>;
@group(3) @binding(4) var<storage, read> pml_vvfo: array<f32>;

// PML local index to linear address within PML region
fn pml_idx(n: u32, x: u32, y: u32, z: u32) -> u32 {
    let Ny = pml.numLines.y;
    let Nz = pml.numLines.z;
    return n * pml.numLines.x * Ny * Nz + x * Ny * Nz + y * Nz + z;
}

@compute @workgroup_size(4, 4, 16)
fn pml_pre_voltage(@builtin(global_invocation_id) gid: vec3<u32>) {
    let lx = gid.x;
    let ly = gid.y;
    let lz = gid.z;

    if (lx >= pml.numLines.x || ly >= pml.numLines.y || lz >= pml.numLines.z) {
        return;
    }

    let gx = lx + pml.startPos.x;
    let gy = ly + pml.startPos.y;
    let gz = lz + pml.startPos.z;

    // For each component n = 0, 1, 2:
    for (var n = 0u; n < 3u; n++) {
        let p = pml_idx(n, lx, ly, lz);
        let g = idx(n, gx, gy, gz);  // global field index

        // f_help = vv * V - vvfo * flux
        let f_help = pml_vv[p] * volt[g] - pml_vvfo[p] * volt_flux[p];
        // V = flux (save old flux into field for post-step recovery)
        volt[g] = volt_flux[p];
        // flux = f_help
        volt_flux[p] = f_help;
    }
}
```

### PML Post-Voltage Shader

```wgsl
@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(3) @binding(0) var<uniform> pml: PMLParams;
@group(3) @binding(1) var<storage, read_write> volt_flux: array<f32>;
@group(3) @binding(5) var<storage, read> pml_vvfn: array<f32>;

@compute @workgroup_size(4, 4, 16)
fn pml_post_voltage(@builtin(global_invocation_id) gid: vec3<u32>) {
    let lx = gid.x;
    let ly = gid.y;
    let lz = gid.z;

    if (lx >= pml.numLines.x || ly >= pml.numLines.y || lz >= pml.numLines.z) {
        return;
    }

    let gx = lx + pml.startPos.x;
    let gy = ly + pml.startPos.y;
    let gz = lz + pml.startPos.z;

    for (var n = 0u; n < 3u; n++) {
        let p = pml_idx(n, lx, ly, lz);
        let g = idx(n, gx, gy, gz);

        // f_help = flux (which was the old flux, now in volt_flux)
        let f_help = volt_flux[p];
        // flux = V (the newly updated voltage from core kernel)
        volt_flux[p] = volt[g];
        // V = f_help + vvfn * flux
        volt[g] = f_help + pml_vvfn[p] * volt_flux[p];
    }
}
```

### PML Current Shaders

Identical structure to the voltage PML shaders but operating on `curr` and `curr_flux` arrays with `pml_ii`, `pml_iifo`, `pml_iifn` coefficients. The dispatch region may differ since current loops have tighter bounds.

---

## Excitation Shader

From `engine_ext_excitation.cpp` lines 34-59. Excitation is a sparse operation: a list of N excitation points, each injecting a signal amplitude into a specific field component at a specific grid position.

### Excitation Shader

```wgsl
struct ExcParams {
    numTS: u32,
    signalLength: u32,
    period: u32,
    numExcitations: u32,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(4) @binding(0) var<uniform> exc: ExcParams;
@group(4) @binding(1) var<storage, read> signal: array<f32>;
@group(4) @binding(2) var<storage, read> delay: array<u32>;
@group(4) @binding(3) var<storage, read> amp: array<f32>;
@group(4) @binding(4) var<storage, read> dir: array<u32>;     // component direction (0,1,2)
@group(4) @binding(5) var<storage, read> pos: array<u32>;     // packed linear position (x*Ny*Nz + y*Nz + z)

@compute @workgroup_size(256)
fn apply_excitation(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= exc.numExcitations) {
        return;
    }

    // Compute excitation position in signal array
    var exc_pos: i32 = i32(exc.numTS) - i32(delay[n]);

    // Clamp and modulo for periodic signals
    if (exc_pos < 0) {
        return;
    }
    if (exc.period > 0u) {
        exc_pos = exc_pos % i32(exc.period);
    }
    if (exc_pos >= i32(exc.signalLength)) {
        return;
    }

    // Inject: V[dir][pos] += amp * signal[exc_pos]
    let component_offset = dir[n] * params.numLines.x * params.numLines.y * params.numLines.z;
    let field_idx = component_offset + pos[n];

    // Atomic add for safety (multiple excitations could target same cell)
    // Note: WebGPU lacks atomicAdd for f32; use a single-thread-per-cell
    // guarantee or fall back to CPU for overlapping excitations.
    volt[field_idx] += amp[n] * signal[u32(exc_pos)];
}
```

Dispatch: `(ceil(numExcitations / 256), 1, 1)`

**Note on atomics:** WGSL does not support `atomicAdd` on `f32`. If multiple excitation points can target the same cell, either:
1. Sort excitations by target cell and use a serial reduction pass.
2. Use `atomic<u32>` with float-as-int CAS loop.
3. Guarantee no collisions via the excitation setup (typical for most antenna simulations).

---

## Timestep Orchestration

From `engine.cpp` lines 267-286. Each timestep requires a precise sequence of shader dispatches with barriers between phases.

### Pseudocode

```javascript
async function runTimestep(device, encoder, pipelines, bindGroups) {
    // 1. Pre-voltage extensions (PML pre-voltage, etc.)
    {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines.pmlPreVoltage);
        pass.setBindGroup(0, bindGroups.core);
        pass.setBindGroup(3, bindGroups.pml);
        pass.dispatchWorkgroups(pmlDispatchX, pmlDispatchY, pmlDispatchZ);
        pass.end();
    }

    // 2. Core voltage update
    {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines.updateVoltages);
        pass.setBindGroup(0, bindGroups.core);
        pass.setBindGroup(1, bindGroups.voltCoeffs);
        pass.dispatchWorkgroups(voltDispatchX, voltDispatchY, voltDispatchZ);
        pass.end();
    }

    // 3. Post-voltage extensions (PML post-voltage)
    {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines.pmlPostVoltage);
        pass.setBindGroup(0, bindGroups.core);
        pass.setBindGroup(3, bindGroups.pml);
        pass.dispatchWorkgroups(pmlDispatchX, pmlDispatchY, pmlDispatchZ);
        pass.end();
    }

    // 4. Apply excitation to voltages
    {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines.applyExcitation);
        pass.setBindGroup(0, bindGroups.core);
        pass.setBindGroup(4, bindGroups.excitation);
        pass.dispatchWorkgroups(excDispatch, 1, 1);
        pass.end();
    }

    // 5. Pre-current extensions (PML pre-current)
    {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines.pmlPreCurrent);
        pass.setBindGroup(0, bindGroups.core);
        pass.setBindGroup(3, bindGroups.pml);
        pass.dispatchWorkgroups(pmlDispatchX, pmlDispatchY, pmlDispatchZ);
        pass.end();
    }

    // 6. Core current update
    {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines.updateCurrents);
        pass.setBindGroup(0, bindGroups.core);
        pass.setBindGroup(2, bindGroups.currCoeffs);
        pass.dispatchWorkgroups(currDispatchX, currDispatchY, currDispatchZ);
        pass.end();
    }

    // 7. Post-current extensions (PML post-current)
    {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines.pmlPostCurrent);
        pass.setBindGroup(0, bindGroups.core);
        pass.setBindGroup(3, bindGroups.pml);
        pass.dispatchWorkgroups(pmlDispatchX, pmlDispatchY, pmlDispatchZ);
        pass.end();
    }

    // 8. Apply excitation to currents (if needed)
    // ... same pattern as step 4 but targeting curr buffer

    // 9. Update timestep uniform
    // Write (numTS + 1) to the params uniform buffer

    // Submit all commands as a single command buffer
    device.queue.submit([encoder.finish()]);

    // For multi-timestep batching: repeat steps 1-9 in the same encoder
    // before submitting. This amortizes submit overhead.
}
```

### Batching Strategy

WebGPU command submission has non-trivial overhead. For maximum throughput:

1. **Batch N timesteps** into a single command buffer (N = 10-50 depending on grid size).
2. Update the `numTS` uniform between steps using `writeBuffer` or a dynamic offset.
3. Only read back field data when needed (probes, convergence checks) rather than every step.
4. Use `device.queue.onSubmittedWorkDone()` to pipeline CPU work during GPU execution.

### Memory Budget

For a grid of dimensions `Nx * Ny * Nz`:

| Buffer | Size (bytes) |
|--------|-------------|
| volt | `3 * Nx * Ny * Nz * 4` |
| curr | `3 * Nx * Ny * Nz * 4` |
| vv, vi, ii, iv | `3 * Nx * Ny * Nz * 4` each |
| PML flux (x2) | `3 * PML_vol * 4` each |
| PML coeffs (x6) | `3 * PML_vol * 4` each |
| **Total (no PML)** | **`24 * Nx * Ny * Nz * 4`** |

Example: 200x200x200 grid = 192M cells across all arrays = ~768 MB. Fits within typical GPU VRAM (2-8 GB).

---

## Numeric Precision Policy

| Domain | Precision | Rationale |
|--------|-----------|-----------|
| FDTD field updates (E/H) | f32 | Standard for FDTD; sufficient dynamic range for stencil operations |
| Material coefficients (VV/VI/II/IV) | f32 | Computed once in WASM (f64), truncated to f32 for GPU upload |
| DFT / FFT accumulation | f64 (WASM CPU) | Phase errors accumulate over millions of timesteps; f32 is insufficient |
| S-parameter extraction | f64 (WASM CPU) | Port voltage/current ratios require high precision |
| NF2FF radiation integrals | f64 (WASM CPU) | Phase progression over large distances demands f64 |
| Geometry predicates (CSXCAD) | f64 (WASM CPU) | Standard for computational geometry correctness |

**Boundary:** The GPU operates exclusively in f32. All post-processing that reads GPU field data back to WASM (probe sampling, DFT accumulation, S-parameter computation, NF2FF) must promote values to f64 immediately upon readback.

---

## GPU vs CPU Tolerance

WebGPU compute shaders operate in f32, which has a machine epsilon of ~1.19e-7 (practical precision limit ~2.4e-7 for accumulated operations). When cross-validating GPU results against WASM CPU (also f32 for FDTD), differences should be within a few ULP.

**Thresholds for GPU-vs-WASM comparison:**

| Metric | Threshold | Notes |
|--------|-----------|-------|
| Per-cell field difference | < 1e-5 relative | Accounts for f32 multiply-add ordering differences |
| Probe time-series | Within f32 tolerance of WASM path | Same Matlab baselines as Phase 1, no additional margin needed |
| Frequency-domain peaks | Same tolerance as WASM-vs-native | DFT is done in f64 on CPU regardless of engine |

---

## Data Transfer Policy

Field data moves through three domains: WASM heap, JS typed arrays, and GPU buffers. Unnecessary copies waste memory and stall the simulation loop.

**Transfer patterns:**
- **WASM heap to GPU (coefficient upload):** Use `Float32Array` view of `HEAPF32` directly with `device.queue.writeBuffer()`. The browser can perform this copy on a background thread. Never serialize to JSON or JS arrays (1000x overhead).
- **GPU to WASM (probe readback):** Use `GPUBuffer.mapAsync()` + `getMappedRange()` to obtain an `ArrayBuffer`, then create a typed array view. Copy only the probe cells needed, not the entire field.
- **Batched timesteps:** Encode N timesteps (10-50) into a single command buffer before `queue.submit()`. Only read back field data when needed (probes, convergence checks), not every step.

---

## SSE-to-GPU Translation Notes

From `engine_sse.cpp`:

The SSE engine packs 4 Z-values into `f4vector` (128-bit SSE). The GPU shader naturally supersedes this: the `(4,4,16)` workgroup processes 16 Z-values per thread row, and the GPU's SIMD width (32 on NVIDIA, 64 on AMD) provides wider parallelism than SSE's 4-wide.

The SSE boundary handling at `pos[2]=0` (manual shift of last vector element) is replaced by the `idx_zm1` helper function in the shader, which returns a self-reference index at the boundary.

No special vectorization is needed in WGSL; the GPU compiler handles this internally.

---

## Risk Register

| Risk | Mitigation | Verification |
|------|------------|--------------|
| WebGPU device loss (TDR, tab switch) | Detect `device.lost` promise; re-create device and re-upload buffers; resume from last checkpoint | Automated device-loss injection test |
| FP determinism across GPU vendors | Accept f32-level variation; validate against WASM CPU reference within tolerance | GPU-vs-WASM cross-validation suite (cavity, coax) |
| Browser memory limits (128 MiB/binding) | Split field components across multiple bindings; validate grid size at setup | Grid size >200^3 tested; memory budget assertion |
| Large field readback stalls | Read only probe cells per step; full-field readback only on demand | Timestep throughput benchmark with/without readback |
