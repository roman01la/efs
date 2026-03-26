# Project Status — openEMS Web Port

**Last updated:** 2026-03-26

## Overview

openEMS electromagnetic FDTD solver running entirely client-side in a browser via WebAssembly and WebGPU. Phases 0-5 complete. 667 Node.js tests + 52 browser GPU tests, 0 failures.

## Quick Start

```bash
npm run build:deps    # one-time: cross-compile dependencies (~10 min)
npm run build         # build WASM module (~2 min)
npm test              # run all tests (667 tests)
npm run test:browser  # headless Chrome WebGPU tests (52 tests)
```

## Test Suite

```
npm test                 # 667 tests — all Node.js suites
  npm run test:wasm      #  99 — WASM FDTD, native comparison, engine equivalence, HDF5
  npm run test:api       # 285 — simulation API, ports, NF2FF, SAR, visualization
  npm run test:gpu       # 283 — CPU FDTD reference, extensions, dispatch order
npm run test:browser     #  52 — Chrome headless: shaders, GPU-vs-CPU, benchmarks
npm run test:browser:all # 207 — unified browser suite: all modules in Chrome
npm run test:all         # everything
```

## Performance (Chrome 146, Apple Silicon)

```
Grid   | WebGPU | WASM SSEc | WASM SSE | WASM64 SSE | Native MT | Native SSE
-------|--------|-----------|----------|------------|-----------|----------
16^3   |   92   |   177     |  105     |   133      |   280     |   196
32^3   |  401   |   277     |  150     |   151      |   290     |   184
64^3   | 1325   |   282     |  147     |   151      |   316     |   175
(MCells/s)
```

- **WebGPU at 64^3: 4.2x faster than native multithreaded C++**
- WASM SSE-compressed: 282 MC/s = 89% of native MT
- WASM64 SSE: zero overhead vs WASM32 SSE

## Correctness: Native C++ vs WASM (sample-by-sample)

```
Simulation | Probe     | Samples | Max Abs Diff | Max Rel Diff
-----------|-----------|---------|--------------|-------------
Cavity     | Voltage   |   6,667 |    3.8e-10   |   0.2%
Coax       | Voltage   |     667 |    3.5e-10   |   5.7e-6
Coax       | Current   |     667 |    3.9e-12   |   9.0e-7
Dipole     | E-field   |      24 |    8.2e-9    |   1.9e-5
Dipole     | H-field   |      24 |    2.8e-11   |   1.6e-4
```

Engine equivalence: basic vs SSE vs SSE-compressed = **bit-identical** (diff=0.000).
MT vs basic energy: ratio = **1.000000**.
GPU vs CPU: max diff **2.4e-7** (f32 precision limit).

## Phases

### Phase 5: Threading, NF2FF, Scale — COMPLETE

- Emscripten pthreads: basic/sse/multithreaded engines validated
- NF2FF: far-field computation with cylindrical mesh + PEC/PMC mirrors
- SAR: local + averaged (IEEE 62704/C95.3/Simple), Newton-Raphson box sizing
- Memory64: wasm64 build, 8GB max memory, zero performance overhead
- HDF5 reading: readHDF5Mesh/TDField/FDField via Embind
- Kernel fusion: RLC ring buffer, PML+ADE overlap detection

### Phase 4: GPU Extensions — COMPLETE

9 WGSL shaders, 17-phase timestep dispatch matching C++ priorities.
All extensions on GPU: Lorentz ADE, TFSF, lumped RLC, Mur ABC, steady-state.
PML: 4 separate params buffers per mode. Mur: per-point dual-component coefficients.

### Phase 3: WebGPU Acceleration — COMPLETE

WebGPU engine with per-pipeline bind groups. GPU-vs-CPU verified to f32 precision.
CPU reference engine matches C++ engine.cpp exactly. Hybrid fallback.
WASM-to-GPU bridge: coefficient extraction via Embind.

### Phase 2: TypeScript API — COMPLETE

Simulation class with 10 primitive types, 4 port classes, XML generation.
NF2FF box creation + far-field computation. Automesh. Analysis utilities.
Visualization data preparation. SAR post-processing.

### Phase 1: WASM CPU MVP — COMPLETE

Embind API: configure, loadXML, setup, run, readFile, listFiles, getGridSize, getVV/VI/II/IV.
HDF5 field reading: readHDF5Mesh, readHDF5TDField, readHDF5FDField.

### Phase 0: Build Infrastructure — COMPLETE

Emscripten cross-compilation. CGAL/VTK disabled. 4 dependency build scripts.
Reference fixtures: cavity, coax, dipole, engine comparison.

## File Manifest

```
src/
  embind_api.cpp          — C++ Embind wrapper + HDF5 reading
  simulation.mjs          — Simulation class, XML generation
  ports.mjs               — LumpedPort, MSLPort, WaveguidePort, RectWGPort
  analysis.mjs            — DFT, S-params, complex math, constants
  automesh.mjs            — mesh generation, CFL timestep
  nf2ff.mjs               — NF2FF far-field, cylindrical mesh, mirrors, HDF5 reading
  sar.mjs                 — SAR local + averaged (3 IEEE methods)
  types.mjs               — TypeScript-style type definitions
  visualization.mjs       — data preparation (S-param, Smith, radiation, impedance)
  webgpu-engine.mjs       — WebGPU engine (buffers, pipelines, dispatch)
  webgpu-fdtd.mjs         — CPU reference engine + hybrid fallback
  wasm-gpu-bridge.mjs     — WASM coefficient extraction → GPU/CPU engines
  shaders/                — 9 WGSL compute shaders

tests/
  test_wasm.mjs           — 99 tests (WASM, native comparison, engines, HDF5)
  test_api.mjs            — 285 tests (API, ports, NF2FF, SAR, visualization)
  test_webgpu.mjs         — 283 tests (CPU FDTD, extensions, dispatch order)
  test_webgpu_browser.mjs — Playwright runner for Chrome GPU tests
  webgpu/index.html       — 52 browser tests (shaders, GPU-vs-CPU, benchmarks)
  browser/all-tests.html  — 207 unified browser tests
  browser/run-all.mjs     — Playwright runner for unified suite
  generate_fixtures.py    — reference data generator
  bench_native.py         — native C++ benchmark
  fixtures/               — cavity, coax, dipole, engine comparison, native benchmark

scripts/
  build-wasm.sh           — build WASM32 module
  build-wasm-deps.sh      — cross-compile dependencies
  build-wasm64.sh         — build WASM64 (memory64) module
  build-native-deps.sh    — build native dependencies
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
| Node.js | 24.14.0 |
