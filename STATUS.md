# Project Status — openEMS Web Port

**Last updated:** 2026-03-26

## Overview

Porting the openEMS electromagnetic FDTD solver to run entirely client-side in a browser using WebAssembly and WebGPU.

## Phase 3: WebGPU Acceleration — COMPLETE

FDTD update equations implemented as WGSL compute shaders with PML support, CPU reference engine, and WASM-to-GPU bridge. 179 tests pass.

### WGSL Shaders (`src/shaders/`)

| Shader | Purpose | Workgroup |
|---|---|---|
| `update_voltage.wgsl` | E-field update (3 components, boundary shift handling) | (4,4,4) |
| `update_current.wgsl` | H-field update (3 components, Nx-1/Ny-1/Nz-1 bounds) | (4,4,4) |
| `excitation.wgsl` | Sparse source injection (delay, period, signal lookup) | (256,1,1) |
| `update_pml.wgsl` | UPML pre/post voltage/current (4 modes via uniform) | (4,4,4) |

### Engine Classes (`src/`)

| Class | File | Description |
|---|---|---|
| `WebGPUEngine` | `webgpu-engine.mjs` | Full GPU engine: buffer management, pipeline creation, batched dispatch (32 cmd buffers/submit), PML support |
| `CPUFDTDEngine` | `webgpu-fdtd.mjs` | JavaScript reference implementation matching engine.cpp exactly, with PML |
| `WebGPUFDTD` | `webgpu-fdtd.mjs` | Hybrid: tries WebGPU, falls back to CPU |
| `WASMGPUBridge` | `wasm-gpu-bridge.mjs` | Transfers coefficients from WASM heap to GPU/CPU engines, validates PML regions |

### Test Coverage (179 tests)

Indexing, boundary conditions, loop bounds, timestep evolution, excitation (delay, periodic, past-signal), PEC boundaries, energy conservation, WGSL syntax validation, PML pre/post updates, PML absorption, bridge configuration, multi-region PML, 10x10x10 stress test, determinism.

---

## Phase 2: TypeScript API & Visualization — COMPLETE

High-level simulation API mirroring the Python openEMS/CSXCAD interface. 177 tests pass.

### API Surface

| Module | File | Exports |
|---|---|---|
| Simulation | `simulation.mjs` | `Simulation` class — configure, setExcitation, setBoundaryConditions, setGrid, addMetal, addMaterial, addBox, addCylinder, addCylindricalShell, addCurve, addLumpedPort, addMSLPort, addWaveGuidePort, addRectWaveGuidePort, addProbe, createNF2FFBox, toXML, run |
| Ports | `ports.mjs` | `Port`, `LumpedPort`, `MSLPort`, `WaveguidePort`, `RectWGPort` — geometry creation, probe naming, calcPort with S-parameter extraction |
| Analysis | `analysis.mjs` | C0/MUE0/EPS0/Z0, dftTime2Freq, dftMagnitude, complexDivide/Multiply/Conj/Abs, parseProbe, findPeaks, calcSParam |
| NF2FF | `nf2ff.mjs` | `createNF2FFBox` (6 E/H dump boxes), `NF2FFBox`, `NF2FFResult` |
| Automesh | `automesh.mjs` | meshHintFromBox, meshCombine, meshEstimateCflTimestep, smoothMeshLines |
| Types | `types.mjs` | Vec3, BoundaryType, ExcitationType, OpenEMSConfig, PortResult, NF2FFResult |

### Port Types

| Port | Probes | Features |
|---|---|---|
| LumpedPort | 1 voltage + 1 current | R>0 lumped, R=0 metal short, calcPort S-params |
| MSLPort | 3 voltage (A/B/C) + 2 current | Beta/ZL extraction, feedShift, measPlaneShift, feedR |
| WaveguidePort | 1 voltage + 1 current (mode-matched) | E/H weight functions, kc, beta/ZL |
| RectWGPort | (extends WaveguidePort) | Auto TE mode functions from a, b, modeName |

---

## Phase 1: WASM CPU MVP — COMPLETE

openEMS runs end-to-end in the browser via WebAssembly. 35 tests pass covering cavity resonance, coaxial impedance, and dipole field probes.

### WASM Module

| File | Size | Description |
|---|---|---|
| `build-wasm/openems.js` | 121 KB | Emscripten JS glue (modularized, web+node) |
| `build-wasm/openems.wasm` | 3.2 MB | WebAssembly binary |

### Embind API (`src/embind_api.cpp`)

| Method | Description |
|---|---|
| `configure(engineType, numTimesteps, endCriteria)` | Set engine (0=basic), timesteps, convergence |
| `loadXML(xmlString)` | Write XML to MEMFS, parse FDTD setup |
| `setup()` | Initialize operator and engine, returns 0 on success |
| `run()` | Execute FDTD time-stepping |
| `readFile(path)` | Read file from MEMFS as string |
| `listFiles(dir)` | List files in MEMFS directory |

### Test Suite (`tests/test_wasm.mjs`)

**35 tests, 0 failures.**

| Test Group | Tests | What It Validates |
|---|---|---|
| DFT Utility | 2 | Sinusoid peak detection, impedance calculation |
| Cavity Resonator (fixture) | 11 | TM110/TM111 resonances ±0.25% of analytical, peak-to-mode matching |
| Coaxial Line (fixture) | 1 | Z₀ = 50.49–50.77 Ω within +3%/-1% of analytical 49.94 Ω |
| Dipole Field Probes (fixture) | 7 | E/H probes above amplitude thresholds, field symmetry |
| WASM Module | 6 | Module loading, API method availability |
| WASM Cavity Simulation | 8 | Live XML→FDTD→probe→spectrum validation in WASM |

### Performance

- Basic engine: ~123 MCells/s in WASM (Node.js)
- Cavity simulation (9,152 cells, 20,000 steps): 1.5 seconds

### Reference Fixtures (`tests/fixtures/`)

| Fixture | Probes | Signal |
|---|---|---|
| `cavity/` | ut1z (voltage, 6667 samples) | TM modes at 8.05, 8.44 GHz |
| `coax/` | ut1 (voltage, 2501), it1 (current, 2501) | Z₀ ≈ 50.6 Ω |
| `dipole/` | et1, et2 (E-field), ht1, ht2 (H-field), 239 samples each | E max ~6e-3 V/m, H max ~1.9e-6 A/m |
| `constants.json` | — | C₀, μ₀, ε₀, Z₀ |

---

## Phase 0: Build Infrastructure & Reference Data — COMPLETE

### WASM Static Libraries

| Library | Size | Path |
|---|---|---|
| libCSXCAD.a | 697 KB | `build-wasm/vendor/CSXCAD/src/libCSXCAD.a` |
| libopenEMS.a | 1.9 MB | `build-wasm/vendor/openEMS/libopenEMS.a` |
| libnf2ff.a | 315 KB | `build-wasm/vendor/openEMS/nf2ff/libnf2ff.a` |

### WASM Dependencies (`deps/wasm/lib/`)

| Library | Version |
|---|---|
| libboost_{thread,program_options,chrono,date_time,serialization,system}.a | 1.86.0 |
| libhdf5.a, libhdf5_hl.a | 1.14.6 |
| libtinyxml.a | 2.6.2 |
| libfparser.a | 4.5.2 |

### Source Code Modifications

**CSXCAD** (7 files):

| File | Change |
|---|---|
| `CMakeLists.txt` | CGAL optional via `DISABLE_CGAL`, VTK optional via `DISABLE_VTK` |
| `src/CMakeLists.txt` | Polyhedron sources conditional on CGAL, STATIC lib for Emscripten |
| `src/ContinuousStructure.cpp` | `#ifndef CSXCAD_NO_CGAL` guards on polyhedron includes and factory |
| `src/CSPrimitives.h` | `#ifndef CSXCAD_NO_CGAL` guards on polyhedron forward declarations and casts |
| `src/CSTransform.cpp` | `#ifndef NO_VTK` guard on vtkMatrix4x4, inline 4x4 matrix inversion fallback, `std::ostream` fix |
| `src/CSPropDiscMaterial.cpp` | `#ifndef NO_VTK` guard on VTK includes and CreatePolyDataModel |
| `src/CSPropDiscMaterial.h` | `#ifndef NO_VTK` guard on vtkPolyData forward decl and method |

**openEMS** (11 files):

| File | Change |
|---|---|
| `CMakeLists.txt` | VTK optional, Emscripten flags, STATIC lib, skip binary, CSXCAD subdirectory support |
| `FDTD/operator.h` | `#ifndef NO_VTK` guard on dump method declarations |
| `FDTD/operator.cpp` | `#ifndef NO_VTK` guard on VTK includes, dump methods, debug call sites |
| `FDTD/operator_cylindermultigrid.h/.cpp` | `#ifndef NO_VTK` guard on DumpPEC2File |
| `FDTD/operator_mpi.h/.cpp` | `#ifndef NO_VTK` guard on dump overrides |
| `nf2ff/CMakeLists.txt` | STATIC lib for Emscripten, skip nf2ff_bin |
| `openems.cpp` | `#ifndef NO_VTK` guard on vtkVersion.h and version print |
| `tools/vtk_file_writer.h` | Full stub class with no-op methods when `NO_VTK` defined |
| `tools/vtk_file_writer.cpp` | Entire implementation wrapped in `#ifndef NO_VTK` |

**New files:**

| File | Purpose |
|---|---|
| `CMakeLists.txt` (root) | Top-level build with WASM target linking all libraries |
| `src/embind_api.cpp` | Embind wrapper exposing openEMS to JavaScript |
| `scripts/build-wasm-deps.sh` | Cross-compiles TinyXML, fparser, HDF5, Boost for WASM |
| `scripts/build-native-deps.sh` | Builds TinyXML, fparser natively |
| `scripts/build-wasm.sh` | Invokes emcmake/emmake with correct paths |
| `tests/generate_fixtures.py` | Generates reference fixtures from native openEMS |
| `tests/test_wasm.mjs` | Node.js test suite (35 tests) |

### Build Commands

```bash
# Build WASM dependencies (one-time, ~10 min)
bash scripts/build-wasm-deps.sh

# Build openEMS WASM module
bash scripts/build-wasm.sh

# Run tests
node tests/test_wasm.mjs

# Generate reference fixtures (requires native build)
python3 tests/generate_fixtures.py
```

### Known Issues

1. **HDF5 WASM build** requires `-DFE_INVALID=0` workaround for Emscripten's incomplete `<fenv.h>`.
2. **Boost address model**: Worked around with `-DBoost_NO_BOOST_CMAKE=ON`.
3. **`exit()` calls** (51 across 11 files) not yet replaced with exceptions. Emscripten handles them but the WASM module is destroyed on exit.
4. **VTK stub**: `Write()` returns false, causing harmless "can't dump to file" warnings.
5. **XML format**: Radius/ShellWidth are attributes (not child elements), Weight X/Y/Z are attributes on the Weight element. The openEMS XML format is undocumented — learned through C++ source reading.

---

## Phases 4-6: Not Started

| Phase | Description | Status |
|---|---|---|
| 4 | GPU Extensions (dispersive materials, TFSF, RLC) | Not started |
| 5 | Multi-threading, NF2FF, Scale | Not started |
| 6 | Polish & Ecosystem | Not started |

## Documentation

| Document | Path |
|---|---|
| Research & architecture | `docs/openems-web-port-research.md` |
| Phase 0-6 plans | `docs/phases/phase-{0..6}-*.md` |
| openEMS summary | `vendor/openEMS/SUMMARY.md` |

## Toolchain

| Tool | Version |
|---|---|
| Emscripten | 4.0.21 |
| CMake | 4.3.0 |
| Boost | 1.86.0 |
| HDF5 | 1.14.6 |
| TinyXML | 2.6.2 |
| fparser | 4.5.2 |
| CGAL | 6.1.1 (native only, disabled for WASM) |
| VTK | 9.4.2 (native only, disabled for WASM) |
