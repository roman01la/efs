# Phase 5: Multi-threading, NF2FF & Scale

## Multi-threaded Engine

### Domain Decomposition (engine_multithread.cpp)

The multi-threaded engine uses 1D domain decomposition along the X-axis via `CalcStartStopLines()`. Each thread is assigned a contiguous range of X lines to process.

- `boost::thread_group` manages `m_numThreads` worker threads
- Three barriers synchronize execution:
  - `m_startBarrier` — launches a timestep across all workers
  - `m_stopBarrier` — signals timestep completion
  - `m_IterateBarrier` — per-step synchronization within the update loop

### Iteration Flow

**Main thread (IterateTS):**
1. Set `m_iterTS` (number of sub-iterations)
2. `m_startBarrier.wait()` — release workers
3. `m_stopBarrier.wait()` — wait for completion

**Worker loop (per thread):**
1. `m_startBarrier.wait()`
2. For each `iterTS`:
   - `UpdateVoltages(start, stop)`
   - `m_IterateBarrier.wait()`
   - `DoPostVoltage()`
   - `m_IterateBarrier.wait()`
   - `UpdateCurrents(start, stop_h)`
   - `m_IterateBarrier.wait()`
   - `DoPostCurrent()`
   - `m_IterateBarrier.wait()`
3. `m_stopBarrier.wait()`

The last thread uses `stop_h = stop - 1` for current updates (boundary condition), while other threads use `stop_h = stop`.

Extension hooks receive `threadID` for per-thread slicing. `Denormal::Disable()` is called per thread to avoid floating-point denormal penalties.

### Operator_Multithread (operator_multithread.cpp)

- Extends `Operator_SSE_Compressed`
- Parallel EC (equivalent circuit) calculation with `CalcEC`/`CalcPEC` barriers
- Thread count determined by `boost::thread::hardware_concurrency()`

## NF2FF Computation

### Public API (nf2ff.cpp, nf2ff_calc.cpp)

```
nf2ff(freq, theta, phi, center, numThreads)
AnalyseFile(E_file, H_file)
SetRadius(radius)
SetMirror(type, direction, position)
GetETheta() / GetEPhi()
GetRadPower()
GetMaxDirectivity()
Write2HDF5(filename)
```

### AnalyseFile Flow

1. Read mesh from HDF5
2. Detect FD or TD data
3. If TD: apply DFT to convert to frequency domain
4. Call `AddPlane` for each frequency

### AddPlane Algorithm

1. Determine surface normal direction
2. Compute equivalent currents: `Js = n x H`, `Ms = -n x E`
3. Apply cylindrical coordinate transform if needed
4. Assign theta angle ranges to threads
5. Each thread computes radiation integral over its range
6. Aggregate results
7. Compute far-field quantities

### Radiation Integral

For each (theta, phi) observation angle, sum over the surface:

```
sum += area * exp(jk * r_dot * cos_psi) * Js_or_Ms_projected
```

Producing four components: `Nt`, `Np`, `Lt`, `Lp` (theta/phi projections of electric and magnetic currents).

### Far-Field Computation

```
factor = jk / (4*pi*r) * exp(-jkr)
E_theta = -factor * (Lp + Z0 * Nt)
E_phi   =  factor * (Lt - Z0 * Np)
P_rad   = 0.5 * (|E_theta|^2 + |E_phi|^2) / Z0
Dmax    = P_max * 4*pi*r^2 / P_rad
```

### Threading

- `boost::thread_group` + `boost::barrier`
- Threads process assigned theta angle ranges in parallel
- Mirror support: PEC/PMC mirrors multiply field components by +/-1

## Cylindrical Coordinates

### Operator_Cylinder (operator_cylinder.cpp)

- Coordinate names: rho, alpha, z
- Closed alpha mesh wrapping (periodicity at alpha boundaries)
- R=0 singularity handling: conservative timestep (`m_TimeStepVar = 1`)
- Node width: multiplied by radius for alpha direction
- Area: sector formula `A = (delta_alpha / 2) * (r2^2 - r1^2)`
- Material queries apply alpha wrapping
- `Engine_Cylinder` inherits `Engine_Multithread` — no special update equations needed

### Cylindrical Multigrid (operator_cylindermultigrid.cpp)

- Nested `Operator_Cylinder` for inner (fine) grid
- 2:1 alpha refinement (skip every other line)
- Interpolation coefficients for field transfer at the grid boundary
- Recursive nesting supported up to depth 20
- Outer region uses multithreading; inner grid runs separately

## SAR Calculation

### Field Accumulation (processfields_sar.cpp)

- Frequency-domain accumulation via DFT of E-field and J-field
- Cell properties: volume, density, conductivity from material query

### SAR Formulas (sar_calculation.cpp)

- **Local SAR:** `P = 0.5 * sigma * |E|^2` or `P = 0.5 * E . J`, then `SAR = P / density`
- **Averaged SAR:** cubical volume averaging with mass target (1g or 10g)
- **Methods:** `IEEE_62704` (strict), `IEEE_C95_3`, `Simple`
- `FindFittingCubicalMass`: Newton-Raphson iteration to find appropriate box size for target mass

## Field Dumps

- **TD:** `CalcField()` writes HDF5 per timestep under `/FieldData/TD/NNNNNNNN/` with `@time` attribute
- **FD:** DFT accumulation `exp(-j*2*pi*f*t) * field * dt * interval`, stored as complex. Output options:
  - HDF5: real/imag arrays per frequency
  - VTK: 21 phase snapshots + magnitude + phase

## Emscripten Pthreads Configuration

For the WebAssembly build, multi-threading maps to Web Workers via Emscripten's pthreads support:

- Compile with `-pthread` and link with `-sPTHREAD_POOL_SIZE=N`
- `SharedArrayBuffer` required (needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers)
- Thread count should be configurable at runtime; default to `navigator.hardwareConcurrency`
- Barrier-based synchronization translates directly to pthreads barriers
- Stack size per thread: 2MB default, configurable via `-sDEFAULT_PTHREAD_STACK_SIZE`
- Proxy-to-pthread mode (`-sPROXY_TO_PTHREAD`) keeps the main browser thread responsive

### Considerations

- Not all browsers support SharedArrayBuffer (Safari added support in 15.2)
- Fallback to single-threaded engine when pthreads unavailable
- Memory growth with threads requires `-sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=4GB`
- Thread pool warm-up: pre-create workers on initialization to avoid latency on first simulation

## NF2FF API Design

The WebAssembly NF2FF module should expose a clean JavaScript API:

```typescript
interface NF2FFOptions {
  frequencies: number[];
  theta: number[];       // observation angles in radians
  phi: number[];
  center?: [number, number, number];
  numThreads?: number;
  radius?: number;
  mirror?: { type: 'PEC' | 'PMC'; direction: number; position: number };
}

interface NF2FFResult {
  Etheta: Complex2DArray;   // [freq][angle]
  Ephi: Complex2DArray;
  Prad: number[];           // per frequency
  Dmax: number[];           // per frequency
}

function computeNF2FF(
  eFieldFile: ArrayBuffer,  // HDF5 surface field data
  hFieldFile: ArrayBuffer,
  options: NF2FFOptions
): Promise<NF2FFResult>;
```

- Run in a dedicated worker to avoid blocking the UI
- Stream progress updates via `postMessage` (current frequency index, percent complete)
- HDF5 data passed as `ArrayBuffer` to avoid filesystem overhead

## Cylindrical Coordinate Considerations

When porting cylindrical coordinates to WebAssembly:

- The multigrid nesting (up to depth 20) may increase memory usage significantly; enforce limits for the browser environment
- R=0 singularity handling must preserve numerical stability with 32-bit floats if using SSE-equivalent SIMD
- Alpha wrapping logic is index arithmetic only — no special WASM consideration
- Sector area formula uses standard math; verify precision with `f64` operations

## Storage Strategy

Simulation outputs can range from small probe files to multi-GB field dumps. A tiered storage architecture prevents memory exhaustion and enables persistence.

| Storage Layer | Technology | Capacity | Persistence | Use Case |
|---|---|---|---|---|
| WASM Heap (MEMFS) | Emscripten virtual FS | 4 GB (wasm32) / 16 GB (memory64) | Volatile | Active simulation field arrays, probe output |
| Origin Private File System (OPFS) | Browser API | Quota-based (GB+) | Persistent | HDF5 result files, field dumps between sessions |
| File System Access API | Browser API | Unlimited (user disk) | Persistent | Streaming large results directly to user's disk |
| IndexedDB | Browser API | ~50 MB practical | Persistent | Simulation metadata, small config/parameter files |

**Policy:** MEMFS holds only active simulation state. Large HDF5 field dumps should stream to OPFS or File System Access API, bypassing the WASM heap size limit. IndexedDB is reserved for lightweight metadata and simulation parameters.

---

## Post-Processing Precision Requirements

All post-processing computations (DFT accumulation, S-parameter extraction, NF2FF radiation integrals, SAR calculation) must use f64 arithmetic. Phase errors from millions of timesteps and distance-dependent phase progression in NF2FF demand double precision. The FDTD engine may run in f32, but values must be promoted to f64 at the point of post-processing ingestion. See Phase 3 "Numeric Precision Policy" for the full precision split.

---

## Large-Field Handling and Thread Data Sharing

For multi-threaded field operations (NF2FF surface integration, SAR volume averaging), use `SharedArrayBuffer` to share field data across Web Workers without copying. This requires Cross-Origin Isolation headers (`COOP: same-origin`, `COEP: require-corp`).

**Transfer pattern:** The main thread allocates field arrays in a `SharedArrayBuffer`. Worker threads receive typed array views (`Float64Array` for post-processing, `Float32Array` for FDTD fields) over the shared buffer via `postMessage`. No data copying occurs; workers operate on the same memory with barrier-based synchronization (matching the native `boost::barrier` pattern).

When `SharedArrayBuffer` is unavailable, fall back to single-threaded post-processing or use `postMessage` with transferable `ArrayBuffer` (move semantics, not copy).

---

## SAR Post-Processing Design

SAR computation is a post-processing step that can run after the FDTD simulation completes:

- **Input:** frequency-domain E-field and J-field data (from DFT accumulation), material property map
- **Output:** 3D SAR distribution, peak local SAR, peak averaged SAR values
- **Averaged SAR** is the most expensive step — cubical volume search with Newton-Raphson sizing
- For the web version:
  - Provide SAR as an optional post-processing module (not everyone needs it)
  - IEEE_62704 method is the recommended default
  - Volume averaging can be parallelized per voxel row using the same thread pool
  - Results displayed as a color-mapped slice viewer overlaid on the geometry
  - Export SAR data as downloadable HDF5 or JSON

---

## Risk Register

| Risk | Mitigation | Verification |
|------|------------|--------------|
| Thread pool exhaustion | Cap pool size at `navigator.hardwareConcurrency`; queue excess work | Stress test with concurrent NF2FF + SAR requests |
| Large output data (multi-GB dumps) | Stream to OPFS or File System Access API; never hold full dump in MEMFS | Field dump test with >1 GB output completes without OOM |
| Browser memory limits | Enforce grid size limits in API; use memory64 for large grids | Automated memory budget check before simulation start |
| SharedArrayBuffer unavailability | Fall back to single-threaded post-processing; detect at init | Test suite runs in both threaded and single-threaded modes |
| FP determinism in multi-threaded reduction | Use deterministic summation order per thread; verify against single-threaded | NF2FF multi-thread vs single-thread result within f64 epsilon |
