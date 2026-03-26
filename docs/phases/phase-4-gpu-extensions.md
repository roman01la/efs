# Phase 4: GPU Extensions

## Overview

This phase ports the openEMS engine extensions to WebGPU compute shaders. Each extension runs as a separate kernel dispatched at the correct point in the timestep sequence, following the priority-based execution order from `engine_extension.h`.

---

## Extension Priority and Execution Order

From `engine_extension.h`:

| Extension | Priority | Hook Phase |
|-----------|----------|------------|
| Steady-state detection | +2,000,000 | Pre-voltage |
| UPML (PML absorber) | +1,000,000 | Pre/Post-voltage, Pre/Post-current |
| Cylinder extension | +100,000 | Pre/Post-voltage, Pre/Post-current |
| TFSF (Total-Field/Scattered-Field) | +50,000 | Apply2Voltages, Apply2Current |
| Default extensions | 0 | varies |
| Excitation | -1,000 | Apply2Voltages, Apply2Current |
| Cylinder multigrid | -3,000 | Pre/Post-voltage, Pre/Post-current |

Higher priority executes first within each hook phase. The hooks in execution order per timestep are:

1. `DoPreVoltageUpdates()`
2. Core voltage update
3. `DoPostVoltageUpdates()`
4. `Apply2Voltages()`
5. `DoPreCurrentUpdates()`
6. Core current update
7. `DoPostCurrentUpdates()`
8. `Apply2Current()`

---

## Lorentz/Drude Dispersive Materials (ADE Method)

From `engine_ext_lorentzmaterial.cpp`.

### Algorithm

The Auxiliary Differential Equation (ADE) method models frequency-dependent materials (Lorentz poles, Drude metals, conducting sheets) via auxiliary polarization current variables updated alongside the main FDTD fields.

For each dispersion order `o`, direction `n`, sparse position `i`:

**With Lorentz pole:**
```
volt_Lor_ADE[o][n][i] += v_Lor_ADE[o][n][i] * volt_ADE[o][n][i]
volt_ADE[o][n][i] = v_int_ADE[o][n][i] * volt_ADE[o][n][i]
                   + v_ext_ADE[o][n][i] * (V[n, pos] - volt_Lor_ADE[o][n][i])
```

**Without Lorentz (Drude):**
```
volt_ADE[o][n][i] = v_int_ADE[o][n][i] * volt_ADE[o][n][i]
                   + v_ext_ADE[o][n][i] * V[n, pos]
```

Same pattern for currents with `i_int_ADE`, `i_ext_ADE`, `i_Lor_ADE` coefficients.

**Coefficient derivation** from circuit parameters:
- `L_D`, `R_D` from plasma frequency and relaxation time
- `C_L` from Lorentz resonance frequency
- `v_int = (2*L_D - dT*R_D) / (2*L_D + dT*R_D)`
- `v_ext = dT / (L_D + dT*R_D/2) * VI` (where VI is the grid coupling coefficient)

### Data Structure Layout

```wgsl
struct LorentzParams {
    numOrders: u32,          // number of dispersion orders
    numCells: array<u32>,    // per-order count of dispersive cells
    hasLorentz: array<u32>,  // per-order flag: 1 if Lorentz pole present
    _pad: u32,
};
```

Per dispersion order, per direction:

| Buffer | Shape | Description |
|--------|-------|-------------|
| `volt_ADE[o][n]` | `[numCells[o]]` | Auxiliary E-field polarization |
| `volt_Lor_ADE[o][n]` | `[numCells[o]]` | Lorentz accumulator |
| `v_int_ADE[o][n]` | `[numCells[o]]` | Integration coefficient |
| `v_ext_ADE[o][n]` | `[numCells[o]]` | External coupling coefficient |
| `v_Lor_ADE[o][n]` | `[numCells[o]]` | Lorentz coupling coefficient |
| `pos_idx[o][n]` | `[numCells[o]]` | Linear index into global field array |

### WGSL Kernel: Lorentz/Drude Voltage ADE

```wgsl
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
```

Dispatch: `(ceil(numCells / 256), 1, 1)` per order per direction.

### Kernel Fusion Strategy for Dispersive Materials

When a simulation has multiple dispersion orders applied to overlapping cells, fusing them avoids redundant global memory reads of the voltage field:

1. **Single-order common case:** One kernel per direction, dispatched as above.
2. **Multi-order fusion:** Pack all orders for the same cell into a single thread. Requires reindexing so that cells shared across orders are grouped together. The fused kernel reads `V` once, updates all ADE variables for that cell, then moves on.
3. **Conducting sheet special case:** Always 2-pole. Use a specialized 2-iteration unrolled kernel that avoids the order loop overhead.

---

## TFSF (Total-Field/Scattered-Field)

From `engine_ext_tfsf.cpp`.

### Algorithm

TFSF injects a known incident plane wave at a rectangular boundary, separating the domain into a total-field interior and scattered-field exterior.

**Delay lookup with interpolation:**
```
m_DelayLookup[n] = (numTS - n) % period    // clamped to signal length
```

**Voltage injection at lower/upper boundary planes:**
```
V[nP, pos] += (1 - delta) * amp * signal[delay] + delta * amp * signal[delay + 1]
```

Where `delta` is the fractional delay for sub-cell interpolation, `nP` is the polarization direction, and `amp` is the local amplitude accounting for material and geometric factors.

Same pattern for currents at `boundary - 1` positions.

### WGSL Kernel: TFSF Voltage Injection

```wgsl
struct TFSFParams {
    numTS: u32,
    period: u32,
    signalLength: u32,
    numLowerPoints: u32,  // injection points on lower boundary
    numUpperPoints: u32,  // injection points on upper boundary
    _pad: vec3<u32>,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> tfsf: TFSFParams;
@group(1) @binding(1) var<storage, read> signal: array<f32>;
@group(1) @binding(2) var<storage, read> delay_int: array<u32>;   // integer part of delay
@group(1) @binding(3) var<storage, read> delay_frac: array<f32>;  // fractional part (delta)
@group(1) @binding(4) var<storage, read> amp: array<f32>;
@group(1) @binding(5) var<storage, read> field_idx: array<u32>;   // target field linear index

@compute @workgroup_size(256)
fn tfsf_apply_voltage(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    let totalPoints = tfsf.numLowerPoints + tfsf.numUpperPoints;
    if (n >= totalPoints) {
        return;
    }

    // Compute delay position
    var d: i32 = i32(tfsf.numTS) - i32(delay_int[n]);
    if (d < 0) {
        return;
    }
    if (tfsf.period > 0u) {
        d = d % i32(tfsf.period);
    }
    if (d >= i32(tfsf.signalLength) - 1) {
        return;
    }

    let delta = delay_frac[n];
    let sig = (1.0 - delta) * signal[u32(d)] + delta * signal[u32(d) + 1u];

    volt[field_idx[n]] += amp[n] * sig;
}
```

Dispatch: `(ceil(totalPoints / 256), 1, 1)`

The current injection kernel is structurally identical, operating on the `curr` buffer with separate amplitude and index arrays for the H-field boundary points.

---

## Lumped RLC Elements

From `engine_ext_lumpedRLC.cpp`.

### Algorithm

Lumped elements embed discrete circuit components (resistors, inductors, capacitors) into FDTD cells.

**Parallel RLC:**
```
v_Il += i2v * ilv * Vdn[1]
```

**Series RLC (IIR filter form):**
```
Vdn[0] = vvd * (Vdn[0] - Il + vv2 * Vdn[2] + vj1 * Jn[1] + vj2 * Jn[2])
```

**Current history update (J):**
```
Jn[0] = ib0 * (Vdn[0] - Vdn[2]) - b1 * ib0 * Jn[1] - b2 * ib0 * Jn[2]
```

Uses 3-deep history buffers for both `Vdn` (voltage difference) and `Jn` (current). Each timestep shifts: `Vdn[2] = Vdn[1]; Vdn[1] = Vdn[0]` and `Jn[2] = Jn[1]; Jn[1] = Jn[0]`.

### Data Structure Layout

```wgsl
struct RLCElement {
    field_idx: u32,    // linear index into global field array
    direction: u32,    // component (0, 1, 2)
    type_flag: u32,    // 0=parallel, 1=series

    // Parallel coefficients
    i2v: f32,
    ilv: f32,

    // Series coefficients
    vvd: f32,
    vv2: f32,
    vj1: f32,
    vj2: f32,
    ib0: f32,
    b1: f32,
    b2: f32,
};
```

Per-element state (read/write):

| Buffer | Shape | Description |
|--------|-------|-------------|
| `Vdn` | `[numElements * 3]` | Voltage difference history (ring buffer of depth 3) |
| `Jn` | `[numElements * 3]` | Current history (ring buffer of depth 3) |
| `v_Il` | `[numElements]` | Inductor current accumulator (parallel) |

### WGSL Kernel: Lumped RLC

```wgsl
struct RLCParams {
    numElements: u32,
    componentStride: u32,  // Nx*Ny*Nz
    _pad: vec2<u32>,
};

@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> rlc: RLCParams;
@group(1) @binding(1) var<storage, read> elements: array<RLCElement>;
@group(1) @binding(2) var<storage, read_write> Vdn: array<f32>;    // [numElements * 3]
@group(1) @binding(3) var<storage, read_write> Jn: array<f32>;     // [numElements * 3]
@group(1) @binding(4) var<storage, read_write> v_Il: array<f32>;   // [numElements]

// RLCElement struct matches the host-side layout
struct RLCElement {
    field_idx: u32,
    direction: u32,
    type_flag: u32,
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
```

### Sparse Dispatch Pattern

RLC elements are sparse (typically tens to hundreds of cells in a million-cell grid). The kernel dispatches only `ceil(numElements / 256)` workgroups. Each thread handles one element via indirection through `field_idx`. This avoids wasting GPU threads on non-RLC cells.

---

## Mur Absorbing Boundary Condition

From `engine_ext_mur_abc.cpp`.

### Algorithm

First-order Mur ABC at a single boundary face. Three-phase update:

**Pre-voltage (save boundary state):**
```
m_volt_nyP = V[shifted_pos] - Coeff * V[normal_pos]
```

**Post-voltage (incorporate updated field):**
```
m_volt_nyP += Coeff * V[shifted_pos_after_update]
```

**Apply:**
```
SetVolt(boundary_pos, m_volt_nyP)
```

Where `Coeff = (c * dT - dSpace) / (c * dT + dSpace)`.

### Data Structure Layout

```wgsl
struct MurParams {
    numPoints: u32,        // number of boundary face cells
    coeff: f32,            // (c*dT - dSpace) / (c*dT + dSpace)
    _pad: vec2<u32>,
};
```

Per boundary face:

| Buffer | Shape | Description |
|--------|-------|-------------|
| `normal_idx` | `[numPoints]` | Field indices at the boundary |
| `shifted_idx` | `[numPoints]` | Field indices one cell inward |
| `saved_volt` | `[numPoints]` | Saved boundary state between phases |

### WGSL Kernels: Mur ABC

```wgsl
@group(0) @binding(0) var<storage, read_write> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> mur: MurParams;
@group(1) @binding(1) var<storage, read> normal_idx: array<u32>;
@group(1) @binding(2) var<storage, read> shifted_idx: array<u32>;
@group(1) @binding(3) var<storage, read_write> saved_volt: array<f32>;

@compute @workgroup_size(256)
fn mur_pre_voltage(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= mur.numPoints) {
        return;
    }
    // Save: shifted - Coeff * normal
    saved_volt[n] = volt[shifted_idx[n]] - mur.coeff * volt[normal_idx[n]];
}

@compute @workgroup_size(256)
fn mur_post_voltage(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= mur.numPoints) {
        return;
    }
    // Add: Coeff * shifted (after core update)
    saved_volt[n] += mur.coeff * volt[shifted_idx[n]];
}

@compute @workgroup_size(256)
fn mur_apply(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= mur.numPoints) {
        return;
    }
    // Overwrite boundary with Mur value
    volt[normal_idx[n]] = saved_volt[n];
}
```

### Sparse Dispatch Pattern

Mur ABC operates on a 2D boundary face: `Ny * Nz` cells for an X-boundary, etc. Dispatch: `(ceil(numPoints / 256), 1, 1)`. This is a thin slice of the full grid, so the kernel is lightweight.

---

## Conducting Sheet Model

Extends the Lorentz/Drude ADE with a 2-pole model. The conducting sheet is parameterized by an optimized ladder network that approximates the sheet impedance across the frequency band.

### Implementation

Uses the same `update_volt_ade` kernel as Lorentz/Drude but always with:
- 2 dispersion orders (poles)
- Lorentz flag enabled for both orders
- Coefficients derived from ladder network optimization rather than material physics

No separate kernel is needed; the Lorentz kernel handles this case with `numOrders = 2` and `hasLorentz = 1`.

---

## Steady-State Detection

From the steady-state extension. Runs at highest priority (+2,000,000) in the pre-voltage hook.

### Algorithm

1. Record E-field magnitude at designated probe points over 2 signal periods.
2. Compute energy change ratio: `|E_period2 - E_period1| / |E_period1|`.
3. If ratio < threshold (typically 1e-6), declare convergence and stop.

### WGSL Kernel: Energy Accumulation

```wgsl
struct SSParams {
    numProbes: u32,
    periodSamples: u32,    // samples per period
    currentSample: u32,    // sample index within recording window
    recording: u32,        // 1 if currently recording, 0 otherwise
};

@group(0) @binding(0) var<storage, read> volt: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<uniform> ss: SSParams;
@group(1) @binding(1) var<storage, read> probe_idx: array<u32>;
@group(1) @binding(2) var<storage, read_write> energy_period1: array<f32>;
@group(1) @binding(3) var<storage, read_write> energy_period2: array<f32>;

@compute @workgroup_size(256)
fn accumulate_energy(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    if (n >= ss.numProbes || ss.recording == 0u) {
        return;
    }

    let v = volt[probe_idx[n]];
    let e = v * v;

    if (ss.currentSample < ss.periodSamples) {
        energy_period1[n] += e;
    } else {
        energy_period2[n] += e;
    }
}
```

The convergence check (ratio computation and threshold comparison) runs on the CPU after reading back the energy buffers. This is infrequent (once per period) and does not need a GPU kernel.

---

## Full Timestep Dispatch Order with Extensions

Combining all extensions in priority order:

```javascript
function encodeTimestep(encoder, pipelines, bindGroups) {
    // === PRE-VOLTAGE ===
    // Priority +2M: Steady-state energy accumulation
    dispatchIfActive(encoder, pipelines.ssAccumulate, bindGroups.steadyState);

    // Priority +1M: PML pre-voltage
    dispatchIfActive(encoder, pipelines.pmlPreVoltage, bindGroups.pml);

    // Priority 0: Mur pre-voltage (save boundary)
    dispatchIfActive(encoder, pipelines.murPreVoltage, bindGroups.mur);

    // === CORE VOLTAGE UPDATE ===
    dispatch(encoder, pipelines.updateVoltages, bindGroups.core);

    // === POST-VOLTAGE ===
    // Priority +1M: PML post-voltage
    dispatchIfActive(encoder, pipelines.pmlPostVoltage, bindGroups.pml);

    // Priority 0: Lorentz/Drude ADE voltage update (per order, per direction)
    for (const [order, dir] of adeVoltageKernels) {
        dispatchIfActive(encoder, pipelines.voltADE[order][dir],
                         bindGroups.ade[order][dir]);
    }

    // Priority 0: Mur post-voltage
    dispatchIfActive(encoder, pipelines.murPostVoltage, bindGroups.mur);

    // === APPLY TO VOLTAGES ===
    // Priority +50K: TFSF voltage injection
    dispatchIfActive(encoder, pipelines.tfsfVoltage, bindGroups.tfsf);

    // Priority -1K: Excitation voltage injection
    dispatchIfActive(encoder, pipelines.excitationVoltage, bindGroups.excitation);

    // Priority -1K: Mur apply (overwrite boundary)
    dispatchIfActive(encoder, pipelines.murApply, bindGroups.mur);

    // Priority -1K: RLC voltage update
    dispatchIfActive(encoder, pipelines.rlcUpdate, bindGroups.rlc);

    // === PRE-CURRENT ===
    // Priority +1M: PML pre-current
    dispatchIfActive(encoder, pipelines.pmlPreCurrent, bindGroups.pml);

    // === CORE CURRENT UPDATE ===
    dispatch(encoder, pipelines.updateCurrents, bindGroups.core);

    // === POST-CURRENT ===
    // Priority +1M: PML post-current
    dispatchIfActive(encoder, pipelines.pmlPostCurrent, bindGroups.pml);

    // Lorentz/Drude ADE current update
    for (const [order, dir] of adeCurrentKernels) {
        dispatchIfActive(encoder, pipelines.currADE[order][dir],
                         bindGroups.ade[order][dir]);
    }

    // === APPLY TO CURRENTS ===
    // Priority +50K: TFSF current injection
    dispatchIfActive(encoder, pipelines.tfsfCurrent, bindGroups.tfsf);

    // Priority -1K: Excitation current injection
    dispatchIfActive(encoder, pipelines.excitationCurrent, bindGroups.excitation);
}
```

### dispatchIfActive Helper

```javascript
function dispatchIfActive(encoder, pipeline, bindGroup) {
    if (!pipeline || !bindGroup) return;  // extension not present

    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline.pipeline);
    for (let i = 0; i < bindGroup.groups.length; i++) {
        pass.setBindGroup(i, bindGroup.groups[i]);
    }
    pass.dispatchWorkgroups(...pipeline.dispatchSize);
    pass.end();
}
```

---

## Kernel Fusion Opportunities

### Dispersive Material Fusion

When Lorentz/Drude ADE cells overlap with PML regions, the PML post-voltage and ADE update can be fused into a single kernel that:

1. Reads the voltage once.
2. Applies PML post-voltage correction.
3. Updates all ADE orders for that cell.
4. Writes the voltage once.

This reduces global memory bandwidth by 2x for cells in dispersive PML regions.

### Mur + Excitation Fusion

The Mur apply phase and excitation injection both modify voltage values. If the Mur boundary does not overlap with excitation points (typical), they can be dispatched in the same compute pass without barriers.

### RLC History Shift Optimization

The 3-deep history buffers (`Vdn`, `Jn`) can use a ring buffer index instead of physically shifting values. A single `u32` uniform tracks the current write position, eliminating 4 memory writes per element per timestep.

---

## Summary of GPU Kernels

| Kernel | Dispatch Size | Data Pattern | Phase |
|--------|--------------|--------------|-------|
| `update_voltages` | `(Nx/4, Ny/4, Nz/16)` | Dense 3D | Core |
| `update_currents` | `(Nx/4, (Ny-1)/4, (Nz-1)/16)` | Dense 3D | Core |
| `pml_pre_voltage` | `(Px/4, Py/4, Pz/16)` | Dense 3D (PML region) | Pre-volt |
| `pml_post_voltage` | Same as above | Dense 3D (PML region) | Post-volt |
| `pml_pre_current` | Same as above | Dense 3D (PML region) | Pre-curr |
| `pml_post_current` | Same as above | Dense 3D (PML region) | Post-curr |
| `update_volt_ade` | `(numCells/256, 1, 1)` | Sparse 1D | Post-volt |
| `update_curr_ade` | `(numCells/256, 1, 1)` | Sparse 1D | Post-curr |
| `tfsf_apply_voltage` | `(numPoints/256, 1, 1)` | Sparse 1D | Apply2Volt |
| `tfsf_apply_current` | `(numPoints/256, 1, 1)` | Sparse 1D | Apply2Curr |
| `apply_excitation` | `(numExc/256, 1, 1)` | Sparse 1D | Apply2Volt/Curr |
| `update_rlc` | `(numElems/256, 1, 1)` | Sparse 1D | Apply2Volt |
| `mur_pre_voltage` | `(numFace/256, 1, 1)` | Sparse 1D (2D face) | Pre-volt |
| `mur_post_voltage` | Same as above | Sparse 1D (2D face) | Post-volt |
| `mur_apply` | Same as above | Sparse 1D (2D face) | Apply2Volt |
| `accumulate_energy` | `(numProbes/256, 1, 1)` | Sparse 1D | Pre-volt |
