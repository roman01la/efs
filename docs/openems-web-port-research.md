# openEMS Web Port — Comprehensive Research

## Goal

Port openEMS to run entirely client-side in a browser, leveraging WASM and WebGPU to minimize additional code.

## Key Principles

1. **Maximum Performance**: memory64 for scale, WASM SIMD for CPU acceleration, WebGPU for massive parallelization of the EC-FDTD stencils
2. **Maximum Correctness**: IEEE 754 determinism, f64 for post-processing, geometric predicate validation
3. **Minimized Custom Code**: compile existing C++ dependencies via Emscripten rather than rewriting in JS/TS

---

## 1. Subsystem Portability Assessment

### 1.1 FDTD Core (operator.cpp, engine.cpp, excitation.cpp)

**Verdict: WASM-READY**

- Pure C++ with standard memory allocation (`new`/`delete`)
- No POSIX-specific system calls in the core
- `std::ofstream` for debug output (works via Emscripten MEMFS)
- `Excitation` uses `fparser` for expression parsing — no OS dependencies
- The main time-stepping loop (`IterateTS`, `UpdateVoltages`, `UpdateCurrents`) is fully portable

### 1.2 SSE Engine (engine_sse.cpp, operator_sse.cpp)

**Verdict: WASM-READY with SIMD128**

- Uses GCC/Clang vector attributes as primary SIMD path:
  ```cpp
  typedef float v4sf __attribute__ ((vector_size (16)));
  union f4vector { v4sf v; float f[4]; };
  ```
- This maps cleanly to WASM SIMD128 via Emscripten's `-msimd128` flag
- Emscripten supports SSE/SSE2 intrinsics — the `_mm_add_ps`, `_mm_mul_ps` etc. used in MSVC fallback path are also supported
- Aligned memory allocation uses `posix_memalign()` — Emscripten's libc provides this

**SSE-to-WASM SIMD mapping quality:**

| SSE Operation | WASM SIMD Support |
|---|---|
| SSE arithmetic (add, mul, sub, div) | Native |
| SSE2 integer/float ops | ~60-65% native |
| SSE3 horizontal ops | Emulated |
| SSSE3 | Mostly emulated |

For FDTD (float add/mul/load/store), the coverage is excellent.

### 1.3 SSE Compressed Engine

**Verdict: WASM-READY** — same SIMD considerations as SSE engine, uses `std::vector<f4vector>` with aligned allocator.

### 1.4 Multithreaded Engine (engine_multithread.cpp)

**Verdict: PORTABLE with effort**

- Uses `boost::thread`, `boost::barrier`, `boost::thread::hardware_concurrency()`
- Uses `gettimeofday()` from `<sys/time.h>` (Emscripten provides polyfill)
- Emscripten supports pthreads mapped to Web Workers + SharedArrayBuffer
- **Deployment requirement**: Cross-Origin Isolation headers required:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```
- **Critical**: Use `-sPROXY_TO_PTHREAD` flag to move the entire C++ `main()` to a worker thread. Without this, synchronous `pthread_create` on the main browser thread can deadlock because the browser must return to the event loop to spawn workers.
- Alternative: compile single-threaded (use SSE or Basic engine instead)

### 1.5 MPI Engine

**Verdict: NOT PORTABLE** — Remove entirely. No browser MPI standard exists.

### 1.6 Cylindrical Operator/Engine

**Verdict: WASM-READY** — Pure math transformations. Inherits from Multithread operator, so needs single-thread fallback or pthreads emulation.

### 1.7 Extensions (FDTD/extensions/)

| Extension | WASM Status | Notes |
|---|---|---|
| Excitation | READY | Pure numerical, sparse storage |
| UPML (PML) | READY with caveat | Uses `setlocale()` (stub it) and `fparser` |
| Lorentz/Drude material | READY | Pure ADE numerical computation |
| TFSF (plane wave) | READY | Pure numerical, delay tables |
| Lumped RLC | READY | Pure circuit model coefficients |
| Mur ABC | READY | Pure boundary computation |
| Absorbing BC | READY | Pure boundary computation |
| Conducting sheet | READY | Pure numerical |
| Steady-state | READY | Frequency accumulation |
| Cylinder extensions | READY | Coordinate transforms |

The extension system is cleanly architected — hook-based with virtual methods and priority ordering. All extensions are pure computational with no system dependencies beyond what the base operator/engine require.

**One issue**: `operator_ext_upml.cpp` calls `setlocale(LC_NUMERIC, "en_US.UTF-8")` for fparser decimal parsing. This needs to be removed or stubbed in WASM.

### 1.8 Processing Subsystem (Common/)

| Component | Computation | I/O | WASM Status |
|---|---|---|---|
| Processing (base) | N/A | `std::ofstream` | Needs I/O abstraction |
| ProcessVoltage | Line integrals | Via parent | Computation: READY |
| ProcessCurrent | Surface integrals | Via parent | Computation: READY |
| ProcessFieldProbe | Point sampling | Via parent | Computation: READY |
| ProcessFields_TD | Field dumps | HDF5 + VTK writers | Needs replacement |
| ProcessFields_FD | DFT accumulation | HDF5 + VTK writers | Needs replacement |
| ProcessFields_SAR | SAR calculation | HDF5 + VTK writers | Needs replacement |
| ProcessModeMatch | Mode matching | Via parent | Computation: READY |

**Key insight**: All computational logic is WASM-ready. The blocker is exclusively the I/O layer (HDF5/VTK file writers). An abstraction layer that writes to in-memory buffers instead of files would unblock the entire subsystem.

### 1.9 NF2FF (Near-Field to Far-Field)

**Verdict: PORTABLE with I/O replacement**

- Computation kernel (`nf2ff_calc.cpp`) is pure math: surface current calculation, radiation integrals, phase progression
- Uses `boost::thread` for parallel angle computation — needs pthreads emulation or single-thread fallback
- I/O: reads/writes HDF5 files — needs h5wasm or in-memory alternative
- Standalone executable (`nf2ff/main.cpp`) — not needed for web port; embed as library call

### 1.10 Array Library & Memory

**Verdict: WASM-READY**

- `tools/arraylib/` — contiguous multi-dimensional arrays with RAII. Pure C++.
- Aligned allocator uses `posix_memalign` (Unix) / `_mm_malloc` (Windows) — Emscripten libc covers both
- `tools/array_ops.h` — SIMD vector types use GCC vector attributes, same as SSE engine
- `tools/AdrOp.h` — grid indexing utility, pure math

---

## 2. Dependency Analysis

### 2.1 Dependency Tree

```
openEMS
├── CSXCAD (geometry/structure definition)
│   ├── fparser (math expression parsing)
│   ├── TinyXML (XML parsing)
│   ├── HDF5 (data I/O)
│   ├── CGAL (computational geometry — polyhedra, AABB trees)
│   ├── VTK (visualization output)
│   └── Boost (various)
├── fparser (direct use in excitation/PML)
├── TinyXML (simulation config parsing)
├── HDF5 (field dump I/O)
├── Boost
│   ├── thread (multithreading) — OPTIONAL
│   ├── date_time, chrono (timing)
│   ├── serialization
│   ├── program_options (CLI) — NOT NEEDED for library
│   └── system
├── VTK (visualization output)
└── MPI (optional) — REMOVE
```

### 2.2 Per-Dependency WASM Assessment

| Dependency | Required | WASM Status | Strategy |
|---|---|---|---|
| **TinyXML** | Yes | READY | Pure C++, compiles with Emscripten as-is |
| **fparser** | Yes | LIKELY READY | C++ math parser, needs validation |
| **HDF5** | Yes | SOLVED | Use [libhdf5-wasm](https://github.com/usnistgov/libhdf5-wasm) (pre-compiled WASM libs from NIST) or [h5wasm](https://github.com/usnistgov/h5wasm) |
| **Boost (header-only)** | Yes | READY | Spirit, MPL, Geometry headers work in Emscripten |
| **Boost.Thread** | Optional | PROBLEMATIC | Either use Emscripten pthreads or compile out threading |
| **Boost.ProgramOptions** | CLI only | NOT NEEDED | Stub or remove for library/web mode |
| **VTK** | For output | DUAL STRATEGY | VTK has an active WASM port (`vtk.wasm`) for C++ data processing; use `vtk.js` for browser rendering. Alternatively replace with Three.js for lighter weight. |
| **CGAL** | Via CSXCAD | VERY HARD | Heavy template library. Only needed for polyhedron geometry primitives |
| **MPI** | Optional | REMOVE | `WITH_MPI=OFF` |

### 2.3 CSXCAD — The Hardest Dependency

CSXCAD is the geometry/structure definition library. It depends on CGAL, VTK, HDF5, TinyXML, Boost, and fparser.

**CGAL** is the primary concern — it's a massive header-only C++ template library used for:
- `CSPrimPolyhedron` — polyhedron geometry (CGAL Polyhedron_3, AABB trees)
- Computational geometry operations (intersections, containment tests)

**The Rounding Mode Impasse**: Even if CGAL compiles to WASM, there is a deeper correctness problem. CGAL's interval arithmetic relies on hardware FP rounding mode switching (round toward +∞/-∞) to bound errors in geometric predicates. **WASM only supports round-to-nearest-even** — there is no mechanism to change rounding modes. Without this, CGAL's standard kernels can produce incorrect results: crashing geometry, non-physical intersections, non-watertight meshes.

Mitigation strategies if CGAL is needed:
- **Software rounding emulation** via `nextafter()` — correct but significantly slower than hardware rounding
- **Exact constructions kernel** (`Exact_predicates_exact_constructions_kernel`) — bypasses rounding entirely via rational arithmetic, but massive memory/CPU cost
- **Rounding-mode-free kernels** — CGAL contributors have developed static-filter-based predicates that don't need hardware rounding. This is the best path if CGAL must be ported.

However, since CGAL is only used for `CSPrimPolyhedron` (point-in-polyhedron via AABB tree ray casting), and this can be disabled with a ~20-line conditional compilation patch, the rounding mode issue is **avoidable for most antenna simulations**.

**Options:**
1. **Port CSXCAD to WASM with CGAL stubbed out** — disable polyhedron support, keep simpler primitives (boxes, cylinders, polygons, curves). Most antenna simulations don't need polyhedra. ~20-line patch.
2. **Port CSXCAD with CGAL rounding-mode-free kernels** — use CGAL's static-filter predicates that avoid hardware rounding. Preserves polyhedron support but requires careful validation of geometric correctness.
3. **Reimplement CSXCAD geometry in JS/TS** — the primitive types (box, sphere, cylinder, polygon, curve, wire) are geometrically simple. Only reimplement what's needed.
4. **Use OpenCASCADE.js** — mature WASM port of OpenCASCADE CAD kernel. Could replace CSXCAD's geometry ops but would need an adapter layer.

---

## 3. WebGPU for FDTD Acceleration

### 3.1 Why WebGPU

The FDTD Yee grid update is a classic stencil computation — each cell reads its neighbors to compute the next timestep. This maps perfectly to GPU compute shaders:

- Each GPU thread handles one or more Yee cells
- E-field update: `E[n+1] = VV*E[n] + VI*(curl H)`
- H-field update: `H[n+1] = II*H[n] + IV*(curl E)`
- 3D dispatch via `@builtin(global_invocation_id)` maps to (i,j,k) grid indices

### 3.2 WGSL Feasibility

WGSL supports everything needed:
- `f32` arithmetic (FDTD standard precision)
- `vec3<f32>`, `vec4<f32>` for field components
- Storage buffers with `read` and `read_write` access
- Workgroup shared memory for stencil tile optimization
- Workgroup barriers for synchronization

Example E-field update kernel structure:
```wgsl
@group(0) @binding(0) var<storage, read_write> Ex: array<f32>;
@group(0) @binding(1) var<storage, read_write> Ey: array<f32>;
@group(0) @binding(2) var<storage, read> Hz: array<f32>;
@group(0) @binding(3) var<storage, read> Hy: array<f32>;
@group(0) @binding(4) var<storage, read> VV: array<f32>;  // coefficients
@group(0) @binding(5) var<storage, read> VI: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn updateE(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x; let j = gid.y; let k = gid.z;
    let idx = i + j * Nx + k * Nx * Ny;
    // Yee curl difference + coefficient multiply
    Ex[idx] = VV[idx] * Ex[idx] + VI[idx] * (Hz[idx] - Hz[idx - Nx] - Hy[idx] + Hy[idx - Nx*Ny]);
}
```

### 3.3 WebGPU Buffer Limits

| Limit | Value | Impact |
|---|---|---|
| `maxStorageBufferBindingSize` | 128 MiB per binding | Split field components across bindings |
| `maxBufferSize` | 256 MB (requestable higher) | Desktop GPUs: several GB |
| Bind groups | 4 groups, 8+ bindings each | Enough for all field components + coefficients |

**Grid size estimates:**

| Grid | Cells | Memory (6 fields, f32) | Fits 128 MiB/binding? |
|---|---|---|---|
| 100^3 | 1M | 24 MB | Yes (4 MB per component) |
| 200^3 | 8M | 192 MB | Yes (32 MB per component) |
| 300^3 | 27M | 648 MB | Yes (108 MB per component) |
| 400^3 | 64M | 1.5 GB | Tight (256 MB per component) |

With 6 field components split across separate bindings, grids up to ~300^3 fit comfortably. Material coefficients add another ~4 arrays.

### 3.4 Kernel Fusion for Dispersive Materials

A key optimization for WebGPU: rather than running separate compute passes for ADE (Auxiliary Differential Equation) polarization current updates, **fuse them into the main E-field update shader**. This reduces memory traffic — one read, all updates, one write per cell.

| Material Model | Application | Update Complexity | WebGPU Strategy |
|---|---|---|---|
| Drude | Plasmas, metals | High (extra ODE) | Fuse with E-field kernel |
| Lorentz | Resonant dielectrics | High (2nd order ODE) | Extra storage for polarization state, fused update |
| Debye | Biological tissues | Medium | Single-pole recursion, fused update |

Without fusion, each dispersive material type would require an additional compute pass with full grid read/write. Fusion eliminates this overhead at the cost of larger, more complex shaders.

### 3.5 WebGPU Performance Expectations

- WebGPU runs on native Vulkan/Metal/D3D12 backends — approaches native GPU performance for large grids
- Fixed ~3-4ms dispatch overhead per compute pass (insignificant for large grids)
- Async-only API — need to design around `mapAsync` for readback
- **No f64 support** — fine for FDTD (single precision is standard)
- Estimated: **2-5x slower than native CUDA** for optimized stencil code, primarily due to dispatch overhead and limited memory management

### 3.6 Existing Browser FDTD Work

- **WebGL-FDTD** (github.com/timdrysdale/webgl-fdtd) — 2D only, uses fragment shader hacks, unmaintained since 2016
- **cemsim.com** — commercial browser EM tool, closed source
- **No WebGPU FDTD implementations exist** — this would be novel

---

## 4. Architecture Options

### Option A: Pure WASM (CPU)

Compile openEMS C++ core to WASM via Emscripten.

```
[Browser JS] → [Emscripten Bindings] → [openEMS WASM]
                                              ↓
                                    FDTD engine (SSE→SIMD128)
                                              ↓
                                    [Results in MEMFS/memory]
                                              ↓
                                    [JS visualization (Three.js)]
```

**Pros:**
- Minimal new code — reuse existing C++ directly
- All physics extensions work as-is
- fparser, TinyXML, HDF5 all compile to WASM

**Cons:**
- CPU-bound: 1.3-1.8x slower than native
- Single-threaded unless pthreads enabled (requires COOP/COEP headers)
- 4 GB memory limit (or 16 GB with Memory64, Chrome 133+/Firefox 134+)

### Option B: WebGPU Compute (GPU)

Rewrite FDTD update kernels in WGSL, keep setup/orchestration in WASM.

```
[Browser JS] → [WASM: geometry, meshing, setup] → [WebGPU: FDTD time-stepping]
                                                          ↓
                                                  GPU field updates
                                                          ↓
                                                  [JS visualization]
```

**Pros:**
- 10-100x faster than CPU for large grids
- GPU memory separate from WASM 4 GB limit
- Direct GPU→render pipeline (no readback for visualization)

**Cons:**
- Must rewrite all FDTD kernels in WGSL (6 field update equations + extensions)
- Each extension (PML, dispersive materials, TFSF, etc.) needs a WGSL shader
- 128 MiB per-binding limit requires data splitting
- Async API requires architectural rethink
- No existing WebGPU FDTD to build on

### Option C: Hybrid (Recommended)

WASM for everything except the hot loop; WebGPU for field updates.

```
[Browser JS/TS UI]
       ↓
[WASM (Emscripten)]
  ├── CSXCAD: geometry definition
  ├── Operator: coefficient computation, meshing
  ├── Excitation: signal generation
  ├── NF2FF: post-processing
  └── Processing: probe/dump logic
       ↓
[WebGPU Compute]
  ├── E-field update kernel
  ├── H-field update kernel
  ├── PML auxiliary field updates
  ├── Dispersive material ADE updates
  ├── Excitation injection
  └── Source/boundary kernels
       ↓
[Three.js + WebGPU Renderer]
  └── Real-time field visualization
```

**Pros:**
- Minimizes new code: only FDTD inner loop rewritten as WGSL
- All setup, post-processing, geometry reused from C++
- GPU acceleration where it matters most (>95% of runtime is field updates)
- Can fall back to WASM CPU engine if WebGPU unavailable

**Cons:**
- CPU↔GPU data transfer overhead for probes/dumps each timestep
- Two codepaths to maintain (WASM fallback + WebGPU primary)

---

## 5. WASM Compilation Strategy

### 5.1 Emscripten Build Configuration

```cmake
if (EMSCRIPTEN)
    set(WITH_MPI OFF)
    add_definitions(-DEMSCRIPTEN_BUILD)

    # SIMD support
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -msimd128")

    # Threading (optional — requires COOP/COEP headers on deployment)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -pthread")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency")
    # Move main() off browser main thread to avoid pthread deadlocks
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -sPROXY_TO_PTHREAD")

    # Memory — use memory64 for professional-scale grids
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -sALLOW_MEMORY_GROWTH=1")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -sMAXIMUM_MEMORY=8GB")
    # Uncomment for memory64 (Chrome 133+, Firefox 134+):
    # set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -sMEMORY64=1")

    # Embind for JS API
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} --bind")

    # Filesystem
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -sFORCE_FILESYSTEM=1")
endif()
```

### 5.2 Engine Selection for WASM

| Engine | WASM Viable | Recommended |
|---|---|---|
| Basic | Yes | Fallback only (no SIMD) |
| SSE | Yes (via SIMD128) | **Primary CPU engine** |
| SSE Compressed | Yes (via SIMD128) | For memory-constrained cases |
| Multithreaded | Yes (with pthreads) | If COOP/COEP available |
| MPI | No | Remove |

### 5.3 Required Code Changes (Minimal)

1. **Remove `setlocale()` call** in `operator_ext_upml.cpp`
2. **Stub or guard `Denormal::Disable()`** — uses `_mm_setcsr()`, already guarded by `BOOST_ARCH_X86`
3. **Replace `exit()` calls** in engine error paths with exceptions
4. **Conditional VTK includes** — guard with `#ifndef EMSCRIPTEN_BUILD`
5. **I/O abstraction** — route Processing output to memory buffers instead of files
6. **Add Embind/Emval API** — expose `openEMS::ParseFDTDSetup`, `SetupFDTD`, `RunFDTD` to JS

### 5.4 Linking HDF5

Use NIST's pre-compiled WASM libraries:
```
libhdf5-wasm: libhdf5.a, libhdf5_hl.a, libhdf5_cpp.a (Emscripten-compiled)
```
Link against these instead of system HDF5. HDF5 file ops use Emscripten's MEMFS — files exist in memory, can be read/written from JS via `FS.readFile()`/`FS.writeFile()`.

---

## 6. Data Lifecycle and Browser Storage

### 6.1 Tiered Storage Strategy

EM simulations generate multi-GB output. Managing this in the browser sandbox requires a layered approach:

| Storage Layer | Technology | Capacity | Persistence | Use Case |
|---|---|---|---|---|
| WASM Heap (MEMFS) | Emscripten virtual FS | 4 GB (wasm32) / 16 GB (memory64) | Volatile | Active simulation field arrays |
| Origin Private File System (OPFS) | Browser API | Quota-based (GB+) | Persistent | HDF5 result files, field dumps between sessions |
| File System Access API | Browser API | Unlimited (user disk) | Persistent | Streaming large results directly to user's disk |
| IndexedDB (IDBFS) | Browser API | ~50 MB practical | Persistent | Small config files, simulation parameters |

**Key insight**: Use OPFS or the File System Access API for streaming simulation results. This bypasses the WASM heap size limit — the engine can write HDF5 files that persist between sessions and exceed browser RAM. MEMFS should only hold active simulation state.

### 6.2 WorkerFS for Input

Emscripten's WorkerFS provides read-only access to `File`/`Blob` objects in Web Workers **without copying into memory**. Use this for loading large input geometry or mesh files without doubling memory usage.

---

## 7. Visualization Replacement

### 7.1 VTK Strategy

VTK has two web paths: `vtk.wasm` (C++ VTK compiled to WASM for data processing) and `vtk.js` (JS reimplementation for rendering). The recommended split: use vtk.wasm internally if needed for data processing, vtk.js or Three.js for browser rendering.

Alternatively, for a lighter-weight approach, replace VTK entirely:

| VTK Feature | Browser Alternative |
|---|---|
| Rectilinear grid rendering | Three.js `BufferGeometry` with custom shaders |
| Volume rendering | Three.js volume rendering or VTK.js |
| Isosurface extraction | Marching cubes in JS/WASM |
| Vector field visualization | Three.js arrows/streamlines |
| File export | Download ArrayBuffer as binary blob |

**VTK.js** (kitware.github.io/vtk-js/) is a JavaScript reimplementation of VTK for the web — could be used for scientific viz features if needed.

### 7.2 In-Situ Visualization

A major advantage of the WebGPU architecture: **real-time in-situ visualization**. Rather than saving a massive HDF5 file and post-processing it, the simulation provides a live view of field propagation as it happens. This tighter feedback loop is invaluable for engineers optimizing antenna designs or PCB layouts.

### 7.3 Real-time Field Visualization

With WebGPU, field data already lives on the GPU. Render directly:
1. WebGPU compute shader updates fields
2. Same buffers fed to WebGPU render pipeline
3. 2D slice visualization or 3D volume rendering
4. No GPU→CPU→GPU roundtrip

---

## 8. JS↔WASM↔WebGPU Interop

### 8.1 Minimizing Boundary Crossings

Every call from JS into WASM, or from WASM into a WebGPU API, incurs overhead. A simulation loop making thousands of small calls per timestep will be dominated by this cost.

**Batching strategy**: Give the WASM engine a command to run N timesteps before returning control to JS. Never call into WASM per-cell or per-field-component.

| Interop Method | Overhead | Recommended Use |
|---|---|---|
| Raw WASM Exports | Lowest | Internal engine calls |
| WebIDL | Low | Core numerical interfaces |
| Embind | Moderate | High-level control, UI binding |
| Web Workers (message passing) | High | Coarse-grained task parallelism |

### 8.2 Zero-Copy Data Transfer

**Critical**: Use typed array views (`Float32Array`) of the WASM heap (via `HEAPF32`) to pass data to WebGPU. Never serialize to JSON or JS arrays — benchmarks show a **1000x overhead** for serialization vs. raw pointer passing.

For WebGPU uploads, use `device.queue.writeBuffer()` pointing directly at the WASM heap region. The browser can perform this copy in a background thread, avoiding simulation loop stalls.

### 8.3 Progressive Enhancement

The port must implement a fallback chain:
1. **WebGPU compute** — primary path, maximum performance
2. **WASM SIMD + pthreads** — CPU fallback with multi-threading
3. **WASM SIMD single-threaded** — if SharedArrayBuffer unavailable
4. **WASM basic** — minimum viable, any browser with WASM support

---

## 9. Numerical Correctness

### 9.1 WASM Floating-Point Determinism

WASM's FP model is strictly deterministic for basic operations (add, sub, mul, div). However:
- **Transcendental functions** (`sin`, `cos`, `exp`) can vary across browser implementations
- **GPU calculations** (WebGPU) can have minor variations across hardware/drivers
- **f16 (half-precision)** is available in WebGPU but must NOT be used for FDTD — insufficient dynamic range

### 9.2 Precision Strategy

| Domain | Precision | Rationale |
|---|---|---|
| FDTD field updates | f32 | Standard for FDTD, sufficient dynamic range |
| Material coefficients | f32 | Computed once in WASM, uploaded to GPU |
| Frequency-domain transforms (DFT/FFT) | **f64 in WASM** | Phase errors accumulate over millions of timesteps |
| S-parameter extraction | **f64 in WASM** | Requires high precision for port voltage/current ratios |
| NF2FF radiation integrals | f64 in WASM | Phase progression over large distances |
| Geometry predicates (CSXCAD) | f64 | Standard for computational geometry |

### 9.3 Cross-Verification

The port must include a "bit-identical" verification mode for small simulations to confirm the WASM engine produces identical results to the native desktop version. Test suite should cover:
- Basic Yee cell update (vacuum)
- PML absorption
- Dispersive material (Drude, Lorentz, Debye)
- Lumped RLC elements
- Port S-parameter extraction
- NF2FF radiation patterns

### 9.4 Geometric Predicate Validation

If CGAL is ported (rather than stubbed out), specific tests are needed for:
- Nearly-coincident vertices
- High-aspect-ratio triangles
- Complex boolean operations on solids
- Watertightness checks (prerequisite for stable FDTD)

If static filters in CGAL's rounding-mode-free kernels are insufficient, fall back to exact constructions for the geometry setup phase (this is one-time cost, not per-timestep).

---

## 10. TypeScript API Surface

### 10.1 Embind-Exposed API

The CSXCAD and openEMS classes should be exposed via Embind, mirroring the existing Python/Matlab API:

```typescript
const FDTD = new openEMS({ NrTS: 1e4, EndCriteria: 1e-4 });
FDTD.SetCSX(CSX);
FDTD.AddLumpedPort({
  port_nr: 1, R: 50,
  start: [10, 0, -2], stop: [10, 0, 2],
  p_dir: 'z', excite: 1
});
await FDTD.Run('/tmp/simulation_path');
```

This familiarity reduces the learning curve for existing openEMS users.

### 10.2 Web Ecosystem Integration

- **Interactive tutorials**: Documentation with live simulation snippets users can modify and run in-browser
- **URL sharing**: Share simulation setups and results via URL for academic collaboration
- **ML integration**: Generate training datasets for antenna parameter estimation using TensorFlow.js or WebNN

---

## 11. Verification and Testing Strategy

The native openEMS project has no C++ unit tests. All testing is done via Matlab/Octave integration tests in `TESTSUITE/` that run full simulations and compare results against analytical solutions or cross-engine consistency. The web port needs a TS/JS test harness that validates against the same physics.

### 11.1 Existing Test Cases

| Test | File | What It Validates | Validation Method |
|---|---|---|---|
| Engine equivalence | `enginetests/cavity.m` | All 4 engine types produce identical results | Bit-identical E/H field dumps and probe data across basic, sse, sse-compressed, multithreaded |
| Cavity resonance | `combinedtests/cavity.m` | PEC rectangular cavity (5×2×6 cm) resonant frequencies | Analytical: `f = c₀/(2π) * sqrt((mπ/a)² + (nπ/b)² + (lπ/d)²)` for TE/TM modes |
| Coaxial impedance | `combinedtests/Coax.m` | Coaxial transmission line characteristic impedance | Analytical: `Z₀ = sqrt(μ₀/ε₀) * ln(r_outer/r_inner) / (2π)` |
| Field probes | `probes/fieldprobes.m` | E/H field probes match HDF5 field dump data at same coordinates | Self-consistency: probe vs dump at same point |

### 11.2 Tolerances (from Matlab test scripts)

**Cavity resonance:**
- TE modes: frequency ±0.13%, minimum relative amplitude 60%
- TM modes: frequency -0.25%/+0%, minimum relative amplitude 27%
- Outside resonance: maximum relative amplitude 17%

**Coaxial impedance:**
- Upper error: +3%
- Lower error: -1%

**Field probes:**
- Maximum time difference: 1e-13 s
- Maximum relative amplitude difference: 1e-7
- Minimum E-field amplitude: 5e-3
- Minimum H-field amplitude: 1e-7

### 11.3 Reference Data Generation

Run native openEMS for each test case and capture outputs:

1. **Probe time-series** — voltage/current CSV files (already produced by openEMS)
2. **Analytical reference values** — computed from formulas, not simulation:
   - Cavity: TE101, TE102, TE201, TE202, TM110, TM111 frequencies
   - Coax: Z₀ from closed-form expression
3. **HDF5 field dumps** — for engine equivalence and field probe tests

Store as **JSON fixtures** for browser consumption (not HDF5 — simpler to load):
```typescript
interface ProbeData {
  t: number[];    // time points
  val: number[];  // field values
}

interface CavityReference {
  dimensions: { a: number; b: number; d: number };
  modes: { name: string; f_analytical: number }[];
  tolerances: {
    te_freq_rel: number;
    tm_freq_lower_rel: number;
    tm_freq_upper_rel: number;
    te_min_amplitude: number;
    tm_min_amplitude: number;
    outer_max_amplitude: number;
  };
}

interface CoaxReference {
  r_inner: number;
  r_outer: number;
  Z0_analytical: number;
  upper_error: number;  // 0.03
  lower_error: number;  // 0.01
}
```

### 11.4 TS Test Harness

Port the two Matlab helper functions directly:

**`checkFrequency`** — port of `TESTSUITE/helperscripts/check_frequency.m`:
- Takes frequency array, value array, upper/lower frequency bounds, relative amplitude threshold, and mode ('inside'|'outside')
- 'inside': verifies peak within frequency band exceeds threshold
- 'outside': verifies peak within frequency band stays below threshold

**`checkLimits`** — port of `TESTSUITE/helperscripts/check_limits.m`:
- Takes impedance array, upper limit, lower limit
- Verifies all values within bounds

### 11.5 Test Matrix for Web Port

| Test | WASM CPU | WebGPU | Validation |
|---|---|---|---|
| Cavity resonance (TE/TM) | Run simulation, FFT probe data, check frequencies | Same | Analytical formula ±tolerances |
| Coax impedance | Run simulation, compute Z=V/I in freq domain | Same | Analytical Z₀ ±3%/-1% |
| Field probe consistency | Run simulation, compare probe vs dump | Same | Self-consistency < 1e-7 relative |
| Engine equivalence | Basic vs SSE (SIMD128) | N/A | Bit-identical or within-tolerance |
| WASM vs WebGPU | Run same case on both | Run same case on both | Cross-compare within f32 tolerance |
| WASM vs Native | Compare against stored reference | Compare against stored reference | Within tolerance (accounts for FP differences) |

### 11.6 Generating Reference Fixtures

The workflow for generating test fixtures:

1. Build native openEMS on desktop
2. Run each test case with `--engine=basic` (deterministic reference)
3. Extract probe data from CSV files, field data from HDF5
4. Compute analytical values from formulas
5. Package as JSON: `tests/fixtures/{cavity,coax,fieldprobes}.json`
6. Commit fixtures to the repo — these are the ground truth

For WASM-vs-native comparison, the tolerance should be relaxed slightly beyond the Matlab tolerances to account for:
- f32 vs f64 accumulation differences
- WASM SIMD vs native SSE minor variations
- Browser transcendental function implementation differences

Recommended: use Matlab tolerances as a baseline, add a 10% margin for cross-platform comparison.

---

## 12. Performance Expectations

### 12.1 WASM CPU Performance

| Metric | Value |
|---|---|
| vs Native (no SIMD) | 1.3-1.8x slower |
| vs Native (with SIMD128) | 1.2-1.5x slower |
| vs Native (with pthreads) | ~1.5x slower per thread, scales with core count |
| Max practical grid (4 GB) | ~200^3 with PML and materials |
| Max practical grid (Memory64, 16 GB) | ~350^3 |

### 12.2 WebGPU Compute Performance

| Metric | Value |
|---|---|
| vs WASM CPU (large grid) | 10-100x faster |
| vs Native CUDA | 2-5x slower |
| Dispatch overhead | ~3-4ms per pass |
| Optimal grid size | 100^3 to 300^3 |
| Max grid (GPU VRAM dependent) | ~500^3 on 8 GB GPU |

### 12.3 Practical Grid Sizes for Browser

| Use Case | Grid Size | Memory | Platform |
|---|---|---|---|
| 2D antenna pattern | 1000x1000 | ~48 MB | Any browser |
| Small 3D antenna | 100^3 | ~150 MB with PML | Any browser |
| Medium 3D antenna | 200^3 | ~1.2 GB with PML | Desktop browser |
| Large 3D structure | 300^3 | ~4 GB with PML | Desktop + Memory64 |

---

## 13. Effort Estimates by Component

### 13.1 Minimal Viable Product (WASM CPU only)

| Task | Effort | Description |
|---|---|---|
| Emscripten CMake setup | Low | Build config, conditional compilation |
| Stub VTK output | Low | Guard VTK includes, disable VTK writer |
| Link libhdf5-wasm | Low | Replace system HDF5 with WASM version |
| Compile fparser to WASM | Low | Validate compilation, fix issues |
| Compile TinyXML to WASM | Trivial | Pure C++, should work as-is |
| CSXCAD WASM (no CGAL) | Medium | Disable polyhedron support, compile rest |
| Embind JS API | Medium | Expose setup/run/probe methods |
| I/O memory abstraction | Medium | Route processing output to buffers |
| Boost thread handling | Low | Disable or use Emscripten pthreads |
| JS/TS frontend | Medium | Simulation setup UI, parameter entry |
| Three.js visualization | Medium | Field rendering, geometry display |

### 13.2 WebGPU Acceleration (on top of MVP)

| Task | Effort | Description |
|---|---|---|
| WGSL E/H field update kernels | Medium | 6 update equations as compute shaders |
| WGSL PML kernels | Medium | Auxiliary field updates |
| WGSL excitation injection | Low | Source injection shader |
| WGSL dispersive material ADE (fused) | Medium | Lorentz/Drude/Debye fused into E-field kernel |
| GPU buffer management | Medium | Allocation, upload coefficients, readback |
| CPU↔GPU synchronization | Medium | Probe readback, timestep coordination |
| GPU-direct visualization | Medium | Render from compute buffers |

---

## 14. Risk Summary

| Risk | Severity | Mitigation |
|---|---|---|
| CGAL rounding mode correctness | High | Disable polyhedron support (~20-line patch), or use rounding-mode-free kernels |
| Boost.Thread in WASM | Medium | Use Emscripten pthreads or single-thread mode |
| 4 GB WASM memory limit | Medium | Memory64 (Chrome 133+), or limit grid sizes |
| WebGPU 128 MiB buffer limit | Low | Split field components across bindings |
| fparser WASM compilation | Low | Likely works, fallback: JS expression evaluator |
| Browser COOP/COEP for threads | Low | Document deployment requirements |
| WebGPU browser support | Low | All major browsers support WebGPU (2024+) |
| FP determinism (transcendentals, GPU) | Medium | Cross-verify against native; f64 for post-processing |
| JS↔WASM interop overhead | Medium | Batch timesteps, use HEAPF32 typed array views, never serialize |
| Large output data (multi-GB dumps) | Low | Use OPFS or File System Access API to stream to disk |

---

## 15. Implementation Phases

**Architecture**: Hybrid WASM + WebGPU with progressive enhancement fallback (WebGPU → WASM SIMD+pthreads → WASM SIMD → WASM basic).

---

### Phase 0 — Build Infrastructure & Reference Data

**Goal**: Establish the Emscripten build pipeline and generate native reference data for all subsequent validation.

**Deliverable**: openEMS + CSXCAD compile to WASM (even if not yet functional end-to-end). Test fixtures committed to repo.

| Step | Task | Details |
|---|---|---|
| 0.1 | **Emscripten CMake toolchain** | Create `CMakeLists.txt` modifications for Emscripten: set `WITH_MPI=OFF`, add `-DEMSCRIPTEN_BUILD`, `-msimd128`, `-sALLOW_MEMORY_GROWTH=1`, `-sFORCE_FILESYSTEM=1`, `--bind` |
| 0.2 | **CSXCAD: disable CGAL** | Patch CSXCAD CMakeLists.txt: `find_package(CGAL)` optional. Add `#ifdef HAVE_CGAL` guards around `CSPrimPolyhedron.cpp`, `CSPrimPolyhedronReader.cpp`, and factory lines in `ContinuousStructure.cpp` (~20 lines) |
| 0.3 | **CSXCAD: disable VTK** | Guard VTK includes/usage with `#ifndef EMSCRIPTEN_BUILD`. VTK is used for `CSPrimPolyhedronReader` (STL/PLY import) and visualization output — neither needed for WASM MVP |
| 0.4 | **Compile dependencies to WASM** | TinyXML (should work as-is), fparser (validate, fix if needed), Boost headers (header-only subset) |
| 0.5 | **Link libhdf5-wasm** | Integrate NIST's pre-compiled `libhdf5.a`, `libhdf5_hl.a` for Emscripten. Verify HDF5 read/write works via MEMFS |
| 0.6 | **Stub remaining blockers** | Remove `setlocale()` in `operator_ext_upml.cpp`. Guard `Denormal::Disable()` (already guarded by `BOOST_ARCH_X86`). Replace `exit()` calls with exceptions. Stub `boost::program_options` |
| 0.7 | **First WASM compilation** | Get openEMS + CSXCAD to compile to `.wasm`/`.js` with Emscripten. Doesn't need to run correctly yet — goal is zero compile errors |
| 0.8 | **Generate reference fixtures** | Build native openEMS. Run cavity, coax, fieldprobe tests with `--engine=basic`. Extract probe CSVs and analytical values. Package as `tests/fixtures/*.json` |

**Exit criteria**: `emcmake cmake` and `emmake make` succeed. Reference fixtures committed.

---

### Phase 1 — WASM CPU MVP

**Goal**: Run a complete FDTD simulation in the browser. Single-threaded, SSE engine via SIMD128. Prove end-to-end correctness.

**Deliverable**: Browser page that accepts simulation XML, runs openEMS in WASM, returns probe data. Passes all reference tests.

| Step | Task | Details |
|---|---|---|
| 1.1 | **Embind API surface** | Expose minimal C++ API to JS via Embind: `openEMS::SetLibraryArguments()`, `ParseFDTDSetup()`, `SetupFDTD()`, `RunFDTD()`. Expose probe data extraction methods |
| 1.2 | **I/O abstraction** | Route `Processing` output to MEMFS in-memory files. JS reads results via `FS.readFile()`. No changes to C++ Processing classes — MEMFS handles it transparently |
| 1.3 | **Engine selection** | Force `EngineType_SSE` (maps to WASM SIMD128). Disable multithreaded and MPI engine paths with `#ifdef` |
| 1.4 | **End-to-end test: cavity** | Write XML for cavity test (from Matlab script parameters). Run in WASM. Extract probe data. Verify TE/TM resonant frequencies against analytical values. Port `checkFrequency()` to TS |
| 1.5 | **End-to-end test: coax** | Same for coaxial line. Verify Z₀ against analytical. Port `checkLimits()` to TS |
| 1.6 | **End-to-end test: field probes** | Run dipole simulation. Verify probe-vs-dump consistency |
| 1.7 | **WASM vs native cross-check** | Compare WASM probe output against Phase 0 reference fixtures. Verify within tolerance (Matlab tolerances + 10% margin) |
| 1.8 | **Basic JS harness** | Minimal HTML page: load WASM module, write XML to MEMFS, call `RunFDTD()`, read probe results, display time-series plot |

**Exit criteria**: All 3 test cases pass in browser. WASM output matches native reference within tolerance.

---

### Phase 2 — TypeScript API & Visualization

**Goal**: Replace Matlab/Python scripting with a TS API. Add 3D geometry and field visualization.

**Deliverable**: Users can define simulations in TypeScript, run them, and visualize results — all in browser.

| Step | Task | Details |
|---|---|---|
| 2.1 | **TS simulation API** | TypeScript wrapper around Embind API mirroring Python/Matlab conventions: `openEMS({ NrTS, EndCriteria })`, `FDTD.SetCSX()`, `FDTD.AddLumpedPort()`, `FDTD.Run()` |
| 2.2 | **CSXCAD TS bindings** | Expose geometry primitives: `InitCSX()`, `AddBox()`, `AddCylinder()`, `AddMetal()`, `AddMaterial()`, `DefineRectGrid()`, `AddExcitation()`, `AddProbe()`, `AddDump()` |
| 2.3 | **Port types** | Implement port definitions in TS (matching `python/openEMS/ports.py`): `LumpedPort`, `CoaxialPort`, `MSLPort`, `CPWPort`, `WaveguidePort` |
| 2.4 | **Geometry visualization** | Three.js or vtk.js: render CSXCAD primitives (boxes, cylinders, polygons) in 3D. Color by material type. Show mesh grid overlay |
| 2.5 | **Probe result plots** | Time-domain and frequency-domain plotting of voltage/current probes. FFT implementation in TS (or use existing lib). S-parameter display |
| 2.6 | **Field dump visualization** | Read HDF5 field dumps from MEMFS. Display 2D slices (E/H magnitude) as heatmaps on Three.js planes. Time-step animation |
| 2.7 | **OPFS persistence** | Stream large HDF5 results to Origin Private File System for persistence across sessions. Allow download as file |

**Exit criteria**: Full simulation workflow in browser: define geometry in TS → run → visualize fields and S-parameters.

---

### Phase 3 — WebGPU Acceleration

**Goal**: Offload FDTD time-stepping to GPU. 10-100x speedup for the computational inner loop.

**Deliverable**: WebGPU compute path for field updates. WASM handles setup/post-processing. Falls back to WASM CPU if WebGPU unavailable.

| Step | Task | Details |
|---|---|---|
| 3.1 | **GPU buffer architecture** | Design buffer layout: separate `GPUBuffer` per field component (Ex, Ey, Ez, Hx, Hy, Hz) + coefficient arrays (VV, VI, II, IV). Use `STORAGE \| COPY_SRC` for fields, `STORAGE` read-only for coefficients |
| 3.2 | **WGSL E-field update kernel** | Compute shader for 3 E-field components. 3D dispatch `@workgroup_size(8, 8, 1)`. Each invocation updates one Yee cell using stencil neighbors |
| 3.3 | **WGSL H-field update kernel** | Same for 3 H-field components |
| 3.4 | **Coefficient upload** | After WASM `Operator::SetupFDTD()` computes VV/VI/II/IV arrays, upload from WASM heap to GPU via `device.queue.writeBuffer()` using `Float32Array` view of `HEAPF32` (zero-copy) |
| 3.5 | **WGSL PML kernel** | Uniaxial PML auxiliary field updates. Separate compute pass with PML-region-only dispatch |
| 3.6 | **WGSL excitation injection** | Compute shader that adds excitation signal to field values at source locations. Signal value passed as uniform per timestep |
| 3.7 | **Timestep loop orchestration** | JS/TS orchestrator: batch N timesteps as sequential compute passes (H-update → E-update → PML → excitation per step). Use `device.queue.submit()` once per batch. Return to event loop between batches for UI responsiveness |
| 3.8 | **Probe readback** | Periodic `mapAsync` of small probe buffers (single-cell values) to extract voltage/current data. Only every Nth timestep to minimize sync overhead |
| 3.9 | **GPU-direct visualization** | Bind field storage buffers directly to render pipeline. 2D slice visualization as textured quad, reading field data in fragment shader. No GPU→CPU→GPU roundtrip |
| 3.10 | **Fallback detection** | Feature-detect WebGPU at startup. If unavailable (or insufficient limits), fall back to WASM CPU path from Phase 1 |
| 3.11 | **WebGPU vs WASM cross-validation** | Run cavity/coax tests on both paths. Compare probe results within f32 tolerance |

**Exit criteria**: WebGPU path passes all reference tests. Measurable speedup over WASM CPU for 100^3+ grids. Graceful fallback works.

---

### Phase 4 — Dispersive Materials & Advanced Extensions on GPU

**Goal**: Port remaining physics extensions to WebGPU. Full feature parity with native openEMS for common use cases.

**Deliverable**: Dispersive materials, TFSF, lumped RLC, Mur ABC all functional on GPU path.

| Step | Task | Details |
|---|---|---|
| 4.1 | **WGSL Lorentz/Drude ADE (fused)** | Fuse ADE polarization current updates into E-field update kernel. Extra storage buffers for polarization state. Single read-compute-write pass per cell |
| 4.2 | **WGSL Debye ADE (fused)** | Same fusion pattern for Debye single-pole recursion |
| 4.3 | **WGSL TFSF plane wave** | Compute shader for Total-Field/Scattered-Field injection. Delay table as storage buffer. Excitation signal lookup per cell |
| 4.4 | **WGSL lumped RLC** | Sparse element update — only dispatch for cells containing RLC loads. Use index buffer for positions |
| 4.5 | **WGSL Mur ABC** | Boundary condition update kernel. Dispatch only on boundary faces |
| 4.6 | **WGSL conducting sheet** | Thin conducting sheet model as coefficient modification |
| 4.7 | **Extension composition** | Handle simulations using multiple extensions simultaneously. Manage bind group assignments across extensions. Ensure correct execution ordering (matching C++ priority system) |
| 4.8 | **Dispersive material tests** | Create test cases with known dispersive material responses. Cross-validate WASM CPU vs WebGPU |

**Exit criteria**: Simulations with dispersive materials, plane wave sources, and lumped elements produce correct results on GPU path.

---

### Phase 5 — Multi-threading, NF2FF & Scale

**Goal**: Add CPU multi-threading fallback, near-field to far-field post-processing, and memory64 for large grids.

**Deliverable**: Professional-grade solver covering most antenna design workflows.

| Step | Task | Details |
|---|---|---|
| 5.1 | **Emscripten pthreads** | Enable `-pthread -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency`. Move `main()` to worker thread. Requires COOP/COEP headers on deployment |
| 5.2 | **Multithreaded engine in WASM** | Enable `EngineType_Multithreaded` path. Boost.Thread → Emscripten pthreads. Verify thread synchronization works via SharedArrayBuffer |
| 5.3 | **NF2FF in WASM** | Compile `nf2ff/` to WASM. Expose via Embind: `nf2ff(frequencies, theta, phi)`, `AnalyseFile()`, `GetETheta()`, `GetRadPower()`, `GetMaxDirectivity()` |
| 5.4 | **NF2FF single-threaded** | Replace `boost::thread` in `nf2ff_calc.cpp` with sequential loop (or use Emscripten pthreads if Phase 5.1 done) |
| 5.5 | **Radiation pattern visualization** | 3D polar plot of far-field pattern in Three.js. 2D cuts (E-plane, H-plane). Directivity display |
| 5.6 | **memory64** | Enable `-sMEMORY64=1` for grids exceeding 4 GB. Test with 200^3+ grids. Benchmark memory64 performance overhead |
| 5.7 | **Cylindrical coordinates** | Validate cylindrical operator/engine in WASM. Test with cylindrical cavity or ring antenna |
| 5.8 | **SAR calculation** | Validate `ProcessFields_SAR` in WASM for biomedical applications |

**Exit criteria**: Multi-threaded CPU fallback works. NF2FF produces correct radiation patterns. Memory64 enables 300^3+ grids.

---

### Phase 6 — Polish & Ecosystem

**Goal**: Production-quality browser application. Developer experience, documentation, sharing.

| Step | Task | Details |
|---|---|---|
| 6.1 | **Browser IDE** | Monaco editor integration for TypeScript simulation scripts. Syntax highlighting, autocomplete for openEMS/CSXCAD API |
| 6.2 | **Example library** | Port key Matlab examples to TS: patch antenna, dipole, microstrip filter, coaxial connector, waveguide |
| 6.3 | **Interactive tutorials** | Live documentation with runnable simulation snippets |
| 6.4 | **URL sharing** | Serialize simulation setup as URL-encoded state. Share via link |
| 6.5 | **File import/export** | Import existing openEMS XML files. Export results as HDF5 (via h5wasm) or CSV download. Import/export CSXCAD geometry |
| 6.6 | **Performance dashboard** | Show grid size, memory usage, timesteps/sec, estimated time remaining. WebGPU vs CPU indicator |
| 6.7 | **Progressive enhancement** | Detect capabilities at startup: WebGPU → WASM SIMD+pthreads → WASM SIMD → WASM basic. Show capability level to user |
| 6.8 | **Cross-browser testing** | Validate on Chrome, Firefox, Safari. Document any browser-specific limitations |
| 6.9 | **Deployment documentation** | COOP/COEP header requirements for pthreads. HTTPS requirement. Minimum browser versions. GPU requirements for WebGPU |

**Exit criteria**: Production-ready application deployable as static site. Works across major browsers with graceful degradation.

---

### Phase Dependency Graph

```
Phase 0 (Build + Fixtures)
    │
    ▼
Phase 1 (WASM CPU MVP) ◄── correctness gate: all tests pass
    │
    ├──────────────────┐
    ▼                  ▼
Phase 2 (TS API)    Phase 3 (WebGPU)
    │                  │
    │                  ▼
    │              Phase 4 (GPU Extensions)
    │                  │
    └──────┬───────────┘
           ▼
       Phase 5 (Threading, NF2FF, Scale)
           │
           ▼
       Phase 6 (Polish & Ecosystem)
```

Phase 2 and Phase 3 can proceed **in parallel** after Phase 1. Phase 4 depends on Phase 3. Phase 5 depends on both Phase 2 and Phase 4. Phase 6 depends on Phase 5.

The critical path is: **0 → 1 → 3 → 4 → 5 → 6**. Phase 2 (TS API/visualization) runs on a parallel track and merges before Phase 5.
