# Project Status — openEMS Web Port

**Last updated:** 2026-03-26

## Overview

Porting the openEMS electromagnetic FDTD solver to run entirely client-side in a browser using WebAssembly and WebGPU. Phases 0-4 complete. 599 tests, 0 failures.

## Test Summary

```
node tests/test_wasm.mjs           # 35 tests  — WASM FDTD + fixtures
node tests/test_api.mjs            # 252 tests — TS API, ports, visualization
node tests/test_webgpu.mjs         # 272 tests — CPU FDTD reference, extensions
node tests/test_webgpu_browser.mjs # 40 tests  — Real GPU: shaders, GPU-vs-CPU comparison
                                   # 599 total, 0 failures
```

## GPU vs CPU Numerical Accuracy

After 20 timesteps on 8x8x8 grid with identical coefficients and excitation:
- Voltage max diff: **2.384e-7** (f32 machine epsilon = 1.19e-7)
- Current max diff: **1.192e-7**
- Energy match: GPU=14.647, CPU=14.647

With PML (15 steps, 10x10x10, 2-cell PML at z-max): max diff **2.384e-7**.

GPU and CPU produce identical results within f32 rounding. Per the research doc (Section 9), f32 is correct for FDTD field updates (matches native openEMS `FDTD_FLOAT`). Post-processing (DFT, S-parameters) uses f64 in JavaScript to avoid phase error accumulation.

---

## Phase 4: GPU Extensions — COMPLETE

All FDTD extensions ported as WGSL compute shaders with CPU reference implementations. 17-phase timestep dispatch matching C++ engine_extension.h priorities.

### WGSL Shaders (9 total in `src/shaders/`)

| Shader | Purpose | Dispatch |
|---|---|---|
| `update_voltage.wgsl` | E-field update (3 components, boundary shift) | Dense 3D (4,4,4) |
| `update_current.wgsl` | H-field update (3 components, Nx-1/Ny-1/Nz-1) | Dense 3D (4,4,4) |
| `excitation.wgsl` | Sparse source injection | 1D (256) |
| `update_pml.wgsl` | UPML 4-mode (pre/post voltage/current) | Dense 3D (4,4,4) |
| `lorentz_ade.wgsl` | Lorentz/Drude ADE with hasLorentz flag | Sparse 1D (256) |
| `tfsf.wgsl` | TFSF plane wave with fractional delay | Sparse 1D (256) |
| `lumped_rlc.wgsl` | Parallel/series RLC, 3-deep history | Sparse 1D (256) |
| `mur_abc.wgsl` | Mur ABC, per-point coefficients, 3 entry points | Sparse 1D (256) |
| `steady_state.wgsl` | Energy accumulation for convergence | Sparse 1D (256) |

### CPU Reference Engine (`src/webgpu-fdtd.mjs`)

`CPUFDTDEngine` with 17-phase step() matching C++ hook priorities:
```
PRE-VOLTAGE:  steadyState → PML → Lorentz ADE → Mur save → RLC shift
CORE VOLTAGE
POST-VOLTAGE: PML → TFSF → Mur accumulate
APPLY VOLTAGE: excitation → Mur apply → RLC series
PRE-CURRENT:  PML → Lorentz ADE current
CORE CURRENT
POST-CURRENT: PML → TFSF current
```

### WebGPU Engine (`src/webgpu-engine.mjs`)

Full GPU dispatch for all extensions. Per-pipeline bind group cache (`_coreBindGroupFor`). PML uses 4 separate params buffers per mode. `dispatchIfActive()` helper. Per-step submission for correct uniform state.

---

## Phase 3: WebGPU Acceleration — COMPLETE

### Key Components

| Component | File | Description |
|---|---|---|
| WebGPUEngine | `webgpu-engine.mjs` | GPU init, buffer management, pipeline creation, dispatch |
| CPUFDTDEngine | `webgpu-fdtd.mjs` | JS reference matching C++ engine.cpp exactly |
| WebGPUFDTD | `webgpu-fdtd.mjs` | Hybrid: tries GPU, falls back to CPU |
| WASMGPUBridge | `wasm-gpu-bridge.mjs` | Extracts coefficients from WASM, configures GPU/CPU engines |

### Embind Coefficient Extraction

`getGridSize()`, `getVV()`, `getVI()`, `getII()`, `getIV()` exposed via `openEMS_Accessor` helper class (accesses protected `FDTD_Op` without modifying vendor code).

---

## Phase 2: TypeScript API & Visualization — COMPLETE

### Simulation API (`src/simulation.mjs`)

Configuration: `setExcitation`, `setBoundaryConditions`, `setGrid`, `smoothGrid`
Properties: `addMetal`, `addMaterial`, `addProbe`
Primitives: `addBox`, `addCylinder`, `addCylindricalShell`, `addCurve`, `addSphere`, `addSphericalShell`, `addPolygon`, `addLinPoly`, `addRotPoly`, `addWire`
Ports: `addLumpedPort`, `addMSLPort`, `addWaveGuidePort`, `addRectWaveGuidePort`
NF2FF: `createNF2FFBox`
Output: `toXML()`, `run()`

### Port Classes (`src/ports.mjs`)

| Port | Probes | Features |
|---|---|---|
| LumpedPort | 1V + 1I | R>0 lumped, R=0 metal, calcPort S-params |
| MSLPort | 3V + 2I | Beta/ZL, feedShift, measPlaneShift, feedR |
| WaveguidePort | 1V + 1I (mode-matched) | E/H weight functions, kc, beta/ZL |
| RectWGPort | (extends WaveguidePort) | Auto TE mode functions from a, b, modeName |

### Analysis (`src/analysis.mjs`)

Constants, DFT, complex arithmetic, probe parsing, peak finding, S-parameter computation.

### Visualization Data (`src/visualization.mjs`)

Pure data transforms (no rendering): `prepareSParamData`, `prepareSmithData`, `prepareRadiationPattern`, `prepareImpedanceData`, `prepareTimeDomainData`.

### Automesh (`src/automesh.mjs`)

`meshHintFromBox`, `meshCombine`, `meshEstimateCflTimestep`, `smoothMeshLines`.

### NF2FF (`src/nf2ff.mjs`)

`createNF2FFBox` (6 E/H dump boxes), `NF2FFBox`, `NF2FFResult`. Far-field computation deferred to Phase 5.

---

## Phase 1: WASM CPU MVP — COMPLETE

WASM module: `openems.js` (121 KB) + `openems.wasm` (3.2 MB). Runs FDTD simulations in browser/Node.js. 35 tests validate cavity resonance, coax impedance, dipole field probes.

## Phase 0: Build Infrastructure — COMPLETE

Emscripten cross-compilation of openEMS + CSXCAD + all dependencies (Boost 1.86, HDF5 1.14.6, TinyXML, fparser). CGAL/VTK disabled for WASM. Reference fixtures from native build.

---

## Phases 5-6: Not Started

| Phase | Description | Status |
|---|---|---|
| 5 | Multi-threading, NF2FF far-field, memory64, cylindrical coords | Not started |
| 6 | Browser UI, examples, URL sharing, deployment | Not started |

## Build Commands

```bash
bash scripts/build-wasm-deps.sh    # One-time: cross-compile dependencies (~10 min)
bash scripts/build-wasm.sh         # Build WASM module (~2 min)
node tests/test_wasm.mjs           # WASM tests
node tests/test_api.mjs            # API tests
node tests/test_webgpu.mjs         # CPU FDTD + extension tests
node tests/test_webgpu_browser.mjs # Browser WebGPU tests (requires Chrome)
```

## File Manifest

### Source (20 files)
```
src/embind_api.cpp          — Embind wrapper (C++ → JS API)
src/simulation.mjs          — Simulation class (XML generation, run)
src/ports.mjs               — Port classes (Lumped, MSL, Waveguide, RectWG)
src/analysis.mjs            — DFT, S-params, complex math, constants
src/automesh.mjs            — Mesh generation utilities
src/nf2ff.mjs               — NF2FF recording box
src/types.mjs               — TypeScript-style type definitions
src/visualization.mjs       — Visualization data preparation
src/webgpu-engine.mjs       — WebGPU engine (buffers, pipelines, dispatch)
src/webgpu-fdtd.mjs         — CPU reference engine + hybrid fallback
src/wasm-gpu-bridge.mjs     — WASM coefficient extraction → GPU/CPU engines
src/shaders/*.wgsl          — 9 WGSL compute shaders
```

### Tests (6 files + fixtures)
```
tests/test_wasm.mjs         — 35 tests (WASM FDTD + physics validation)
tests/test_api.mjs          — 252 tests (TS API, ports, visualization)
tests/test_webgpu.mjs       — 272 tests (CPU FDTD, extensions, dispatch order)
tests/test_webgpu_browser.mjs — Runner for headless Chrome GPU tests
tests/webgpu/index.html     — 40 browser tests (shader compilation, GPU-vs-CPU)
tests/generate_fixtures.py  — Reference data generator
tests/fixtures/             — Cavity, coax, dipole reference data
```

## Toolchain

| Tool | Version |
|---|---|
| Emscripten | 4.0.21 |
| CMake | 4.3.0 |
| Boost | 1.86.0 |
| HDF5 | 1.14.6 |
| Chrome | 146 (headless WebGPU) |
| Playwright | 1.58.2 |
