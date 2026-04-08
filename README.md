# Electromagnetic Field Solver

Browser-based FDTD (Finite-Difference Time-Domain) electromagnetic simulator.
Cross-compiled openEMS to WebAssembly with a custom WebGPU compute backend
for the FDTD time-stepping loop, near-to-far-field transform, and field
energy reduction. Designs are written as JavaScript, compiled to openEMS
XML at runtime, and simulated entirely client-side.

**Live demo:** https://efs.roman01la.workers.dev

## Features

- **Parametric scripts** — define geometry, materials, mesh, ports, and
  excitation in a JavaScript editor with autocomplete and live error
  diagnostics. Pre-built examples cover patch antennas, microstrip notch
  filters, helical antennas, rectangular waveguides, UWB dipoles,
  cloverleaf circular-polarization antennas, and infinite phased arrays.
- **`param()` API** — declare tunable parameters that render as sliders,
  dropdowns, or toggles. Adjusting a control re-compiles the script and
  updates the 3D geometry preview live.
- **Sweeps** — pick a parameter, set a range and step count, and the
  runner queues sequential simulations. Results overlay automatically.
- **Trace overlay** — every simulation run is color-coded and stacked on
  the S-parameter, impedance, and radiation plots so design variations
  can be compared at a glance.
- **WebGPU FDTD engine** — ~3000 MCells/s on a modern GPU, roughly 7x
  faster than native multi-threaded openEMS on CPU.
- **NF2FF on GPU** — near-field to far-field transform runs as a compute
  shader, producing 2D polar cuts and a full 3D directivity pattern.
- **Field dump visualization** — slice through E/H field volumes in any
  plane with linear or dB scaling.
- **URL sharing** — encode the script and current parameter overrides
  into a shareable URL fragment. Falls back to IndexedDB for large configs.

## Architecture

- `src/webgpu-engine.mjs` — WebGPU FDTD engine (field updates, NF2FF DFT
  accumulation, far-field shader, energy reduction)
- `src/nf2ff.mjs` — CPU NF2FF reference implementation
- `src/ports.mjs` — Lumped, MSL, coaxial, waveguide, and rectangular
  waveguide port classes
- `src/embind_api.cpp` — C++ Embind bindings exposing operator setup and
  coefficient extraction to JavaScript
- `app/sim-worker.js` — Web Worker that orchestrates the WASM/WebGPU
  hybrid pipeline (XML parse, operator setup, GPU dispatch, probe gather,
  NF2FF, HDF5 field dump readback)
- `app/ems-api.mjs` — Script-side API (`OpenEMS`, `ContinuousStructure`,
  `Mesh`, `Property`, primitives, transforms)
- `app/examples.mjs` — Pre-built parametric example designs
- `app/geometry-viewer.mjs` — Three.js geometry preview
- `app/radiation-viewer.mjs` — 3D radiation pattern viewer
- `app/index.html` — Editor, parameter panel, sweep runner, plots,
  walkthrough
- `vendor/openEMS`, `vendor/CSXCAD` — Upstream submodules

## Build

WASM build (one-time setup, ~10 min for deps, ~2 min for the module):

```bash
npm run build:deps   # cross-compile WASM dependencies
npm run build        # build the WASM module
```

Native openEMS build (for validation against the WebGPU pipeline):

```bash
bash scripts/build-native-deps.sh
cmake -B build-native -S . -DCMAKE_BUILD_TYPE=Release
cmake --build build-native -j$(nproc)
```

## Develop

Static dev server, then open http://localhost:8080/app/:

```bash
python3 -m http.server 8080
```

The script editor auto-compiles on a 3-second debounce. Param controls
debounce a 500 ms preview recompile.

## Test

```bash
npm test              # 547 Node.js tests (WASM, API, GPU, examples)
npm run test:browser  # 52 headless Chrome WebGPU tests
npm run test:all      # everything
```

## Deploy

The Cloudflare Workers deployment serves files from `dist/`:

```bash
rsync -a --delete app/ dist/app/
rsync -a --delete src/ dist/src/
cp app/index.html dist/index.html
npx wrangler deploy
```

## `param()` API

```javascript
param(defaultValue, label, opts?)
```

Numeric slider:

```javascript
const patchW = param(32, 'Patch Width',
  { min: 20, max: 50, step: 1, unit: 'mm' });
```

Enum dropdown:

```javascript
const bc = param('MUR', 'Boundary',
  { options: ['PEC', 'PMC', 'MUR', 'PML_8'] });
```

Boolean toggle:

```javascript
const addRadome = param(false, 'Add Radome');
```

Numeric without `min`/`max` renders as static read-only text. The
`param()` function is injected into the script scope alongside `OpenEMS`
and `ContinuousStructure`; no import needed.

## Performance reference (Patch Antenna, 86×87×71 grid)

| Engine                | Time   | MCells/s |
|----------------------|-------:|---------:|
| openEMS basic (CPU)   | 119 s  | 134      |
| openEMS sse (CPU)     | 110 s  | 145      |
| openEMS multithreaded | 36 s   | 444      |
| WebGPU                | 6.2 s  | 3000     |

Setup overhead: ~1.0 s (C++ operator 932 ms, GPU init 15 ms). NF2FF
post-processing: ~30 ms (GPU accumulation + far-field).

## License

GPL-3.0 (matching upstream openEMS).
