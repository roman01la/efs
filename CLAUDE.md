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

## Adding and Testing Examples

Examples live in `app/examples.mjs` as named exports with `{ name, script }`.
To add a new example:

1. **Add the script** to `app/examples.mjs` following the existing pattern:
   ```javascript
   export const MY_EXAMPLE = {
     name: 'My Example',
     script: `
   const unit = 1e-3;
   const FDTD = new OpenEMS({ NrTS: 30000, EndCriteria: 1e-4 });
   FDTD.SetGaussExcite(f0, fc);
   FDTD.SetBoundaryCond([...]);  // PEC, PMC, MUR, PML_N, PBC
   const CSX = new ContinuousStructure();
   FDTD.SetCSX(CSX);
   // ... geometry, materials, ports, mesh ...
   return FDTD.GenerateXML();
   `
   };
   ```

2. **Register in `app/index.html`**:
   - Add to the import: `import { ..., MY_EXAMPLE } from '/app/examples.mjs';`
   - Add to `EXAMPLES` map: `my_key: MY_EXAMPLE,`
   - Add `<option value="my_key">My Example</option>` to `#example-select`

3. **Test in browser**:
   ```bash
   python3 -m http.server 8080
   agent-browser open "http://localhost:8080/app/"
   agent-browser select "@e2" "my_key"       # select from dropdown
   sleep 6                                    # wait for script compile (3s debounce)
   agent-browser eval "document.querySelector('#btn-run').click()"
   sleep 15                                   # wait for simulation
   agent-browser eval "document.querySelector('#sim-console')?.textContent"
   ```

4. **Verify**: Check console shows no errors, simulation completes, plots update.

## Architecture

- `src/webgpu-engine.mjs` — WebGPU FDTD engine (field updates, NF2FF FD accumulation, far-field compute)
- `src/nf2ff.mjs` — NF2FF near-to-far-field transform (CPU fallback)
- `app/sim-worker.js` — Web Worker orchestrating GPU/WASM hybrid simulation
- `app/ems-api.mjs` — Script API (OpenEMS/CSX wrappers for parametric examples)
- `app/examples.mjs` — Parametric example scripts (Patch Antenna, MSL Notch Filter, Helical, Rect WG, PBC Array)
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
