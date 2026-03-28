# CLAUDE.md

openEMS FDTD electromagnetic solver running client-side via WebAssembly + WebGPU.

## Build

```bash
npm run build:deps    # one-time: cross-compile WASM dependencies (~10 min)
npm run build         # build WASM module (~2 min)
```

Native openEMS (for comparison/validation):
```bash
bash scripts/build-native-deps.sh
cmake -B build-native -S . -DCMAKE_BUILD_TYPE=Release
cmake --build build-native -j$(nproc)
```

## Dev Server

```bash
python3 -m http.server 8080    # serve from project root
# App at http://localhost:8080/app/
```

## Tests

```bash
npm test              # 787 tests (Node.js)
npm run test:browser  # 52 headless Chrome WebGPU tests
npm run test:all      # everything
```

## Running Simulation in Browser via agent-browser CLI

```bash
# Open the app
agent-browser open "http://localhost:8080/app/"

# Find and click the Run button
agent-browser snapshot -i -c | grep "Run"
agent-browser click "@e3"    # ref may vary, check snapshot output

# Wait for completion (~25-35s for patch antenna)
sleep 35

# Capture timing and results from the console log panel
agent-browser snapshot -c | grep "\[timing\]"

# Get browser console output (includes WASM stderr)
agent-browser console | grep "\[timing\]"
```

The simulation worker logs `[timing]` prefixed lines for each pipeline stage.

## Running Native openEMS

```bash
# Run with a simulation XML file
./build-native/openEMS sim.xml --engine=sse

# Available engines: basic, sse, multithreaded
./build-native/openEMS sim.xml --engine=basic
./build-native/openEMS sim.xml --engine=multithreaded

# NF2FF post-processing (reads HDF5 field dumps)
./build-native/nf2ff/nf2ff nf2ff.xml
```

To generate XML from the app's parametric examples for native runs, use the
`ems-api.mjs` classes (OpenEMS, ContinuousStructure) in a Node.js script —
they generate XML strings without WASM.

## Architecture

- `src/webgpu-engine.mjs` — WebGPU FDTD engine (field updates, NF2FF FD accumulation, far-field compute)
- `src/nf2ff.mjs` — NF2FF near-to-far-field transform (CPU fallback)
- `app/sim-worker.js` — Web Worker orchestrating GPU/WASM hybrid simulation
- `app/ems-api.mjs` — Script API (OpenEMS/CSX wrappers for parametric examples)
- `app/examples.mjs` — Parametric example scripts (Patch Antenna, MSL Notch Filter, etc.)
- `src/embind_api.cpp` — WASM C++ bindings (operator setup, coefficient extraction)
- `vendor/openEMS/` — Upstream openEMS C++ source (submodule)
- `vendor/CSXCAD/` — Upstream CSXCAD geometry library (submodule)

## Performance Reference (Patch Antenna, 86x87x71 grid)

```
Setup:     ~1.0s  (C++ operator: 932ms, GPU init: 15ms)
FDTD loop: ~6.2s  (WebGPU, ~2500 MCells/s)
NF2FF:     ~30ms  (GPU accumulation + far-field)

Native comparison:
  basic:          119s  (134 MCells/s)
  sse:            110s  (145 MCells/s)
  multithreaded:   36s  (444 MCells/s)
  WebGPU:         6.2s  (2508 MCells/s, 5.5x faster than native MT)
```
