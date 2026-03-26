# Project Status — openEMS Web Port

**Last updated:** 2026-03-26

## Overview

openEMS electromagnetic FDTD solver running entirely client-side in a browser via WebAssembly and WebGPU. All 7 phases (0-6) complete.

## Quick Start

```bash
npm run build:deps    # one-time: cross-compile dependencies (~10 min)
npm run build         # build WASM module (~2 min)
npm test              # run all tests (667 tests)
npm run test:browser  # headless Chrome WebGPU tests (52 tests)
```

## Test Suite

```
npm test                 # 715 tests — all Node.js suites
  npm run test:wasm      # 101 — WASM FDTD, native comparison, engine equivalence, HDF5
  npm run test:api       # 326 — simulation API, ports, NF2FF, SAR, readFromXML, visualization
  npm run test:gpu       # 288 — CPU FDTD reference, extensions, dispatch order parity
npm run test:browser     #  52 — Chrome headless: shaders, GPU-vs-CPU, benchmarks
npm run test:browser:all # 207 — unified browser suite: all modules in Chrome
npm run test:count       # validate test counts match STATUS.md
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

Engine equivalence: basic vs SSE vs SSE-compressed = **bit-identical** (enforced: maxAbsDiff=0 in tests).
MT vs basic energy: ratio = **1.000000**.
GPU vs CPU: max diff **2.4e-7** (f32 precision limit).

## Phases

### Phase 6: Polish & Ecosystem — COMPLETE

- 3 ported examples: Patch Antenna, MSL Notch Filter, Rect Waveguide
  - Each with standalone HTML page, SVG plots, validation test
- Browser UX shell (`app/index.html`): 3-panel editor/simulation/results
  - Example selector, engine type picker, run/stop, console log
  - S-parameter and impedance SVG plots, tabbed results
- URL sharing (`src/url-share.mjs`): deflate+base64url for small configs,
  IndexedDB fallback for large configs, back/forward navigation

### Phase 5: Threading, NF2FF, Scale — COMPLETE

- Emscripten pthreads: basic/sse/multithreaded engines validated
- NF2FF: far-field computation with cylindrical mesh + PEC/PMC mirrors (synchronous JS; parallelization at application layer via Web Workers)
- SAR: local + averaged (IEEE 62704/C95.3/Simple), Newton-Raphson box sizing
- Memory64: wasm64 build, 8GB max memory, zero performance overhead
- HDF5 reading: readHDF5Mesh/TDField/FDField via Embind
- Kernel fusion: RLC ring buffer, PML+ADE overlap detection

### Phase 4: GPU Extensions — COMPLETE

9 WGSL shaders, 16-phase GPU timestep dispatch matching C++ priorities.
GPU RLC uses a single fused kernel (vs 2 CPU phases); dispatch order parity tested.
All extensions on GPU: Lorentz ADE, TFSF, lumped RLC, Mur ABC, steady-state.
PML: 4 separate params buffers per mode. Mur: per-point dual-component coefficients.

### Phase 3: WebGPU Acceleration — COMPLETE

WebGPU engine with per-pipeline bind groups. GPU-vs-CPU verified to f32 precision.
CPU reference engine matches C++ engine.cpp exactly. Hybrid fallback.
WASM-to-GPU bridge: coefficient extraction via Embind.

### Phase 2: TypeScript API — COMPLETE

Simulation class with 10 primitive types, 4 port classes, XML generation.
XML round-trip via `readFromXML()`. NF2FF box creation + far-field computation.
Automesh. Analysis utilities. Visualization data preparation. SAR post-processing.
Native CSXCAD bindings via Embind: ContinuousStructure, CSRectGrid, all property
and primitive classes exposed to JS. Direct CSX path (skip XML round-trip) via
`setCSX()` + `loadFDTDSettings()`.

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
  csxcad_bindings.cpp     — CSXCAD native API exposed via Embind
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
  url-share.mjs           — URL sharing (deflate+base64url, IndexedDB fallback)
  shaders/                — 9 WGSL compute shaders

app/
  index.html              — 3-panel browser UX shell (editor/simulation/results)
  examples.mjs            — pre-built XML configs for 3 examples

examples/
  patch_antenna.mjs       — Patch antenna example (port of Simple_Patch_Antenna.py)
  patch_antenna.html      — standalone HTML page with SVG plots
  msl_notch_filter.mjs    — MSL notch filter example (port of MSL_NotchFilter.py)
  msl_notch_filter.html   — standalone HTML page with SVG plots
  rect_waveguide.mjs      — Rect waveguide example (port of Rect_Waveguide.py)
  rect_waveguide.html     — standalone HTML page with SVG plots

tests/
  test_wasm.mjs           — 101 tests (WASM, native comparison, engines, HDF5)
  test_api.mjs            — 326 tests (API, ports, NF2FF, SAR, readFromXML, visualization)
  test_webgpu.mjs         — 288 tests (CPU FDTD, extensions, dispatch order parity)
  validate_test_counts.mjs — CI test-count validation
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
