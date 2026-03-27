# Documentation Coverage Gap Analysis

## Executive Summary

Research doc (`openems-web-port-research.md`) contains **29 substantive topics/constraints NOT adequately covered** in phase docs (0-6). Most critical gaps are in numerical correctness strategy, CGAL geometry constraints, data lifecycle architecture, and GPU performance considerations.

---

## HIGH-PRIORITY GAPS (Require immediate design decision)

### 1. CGAL Rounding Mode Correctness Crisis
- **What**: CGAL's geometric predicates rely on hardware rounding-toward-±∞. WASM only supports round-to-nearest, risking incorrect geometry/crashes.
- **Where in research**: Section 2.3 "The Rounding Mode Impasse" + mitigation strategies
- **In phases**: Phase 0 chooses one option (disable polyhedra) without documenting tradeoffs
- **Missing**: Decision doc explaining why this choice, fallback paths, validation tests
- **Suggested destination**: Phase 0 new section "Geometry Architecture Decision"
- **Related gaps**: Geometric predicate validation (9.4), AABB tree implementation

### 2. IEEE 754 Determinism & Precision Strategy
- **What**: WASM FP deterministic but transcendentals vary. Must use f64 for DFT/FFT/S-parameters/NF2FF/geometry; f32 for FDTD.
- **Where in research**: Section 9 "Numerical Correctness" (9.1-9.3)
- **In phases**: Not explicitly documented anywhere
- **Missing**: Precision policy table, cross-verification procedures, tolerance margins for cross-platform comparison
- **Suggested destination**: New file `docs/architecture/numerical-correctness.md` referenced by Phase 1
- **Impact**: HIGH — correctness across browsers depends on this

### 3. Tiered Storage Architecture (MEMFS/OPFS/FileSystem API)
- **What**: Multi-GB output requires: MEMFS for active sim (4/16GB limit), OPFS for persistent HDF5 (GB+ capacity), File System Access API for streaming, IndexedDB for configs.
- **Where in research**: Section 6.1-6.2 "Data Lifecycle and Browser Storage"
- **In phases**: Only IndexedDB mentioned in Phase 6 for URL fragment fallback
- **Missing**: Complete storage strategy doc, OPFS integration path, streaming architecture
- **Suggested destination**: New file `docs/architecture/data-lifecycle.md` + Phase 2 (OPFS integration) + Phase 6 (export features)
- **Impact**: MEDIUM-HIGH — enables simulations with multi-GB output

---

## MEDIUM-PRIORITY GAPS (Design considerations affecting phases)

### 4. GPU Buffer Limits & Split Strategy
- **What**: WebGPU 128 MiB per-binding limit requires splitting field components across bindings. Different strategies for different grid sizes.
- **Where in research**: Section 3.3 table (100^3 to 400^3 grid estimates + MiB calculations)
- **In phases**: Phase 3 mentions bind groups but no explicit splitting strategy/examples
- **Suggested destination**: Phase 3 new subsection "GPU Buffer Management & Grid Size Limits"

### 5. SAR Calculation (Incomplete in phases)
- **What**: Complete IEEE 62704 algorithm, Averaged SAR cubical volume averaging, Newton-Raphson box sizing, 1g/10g mass targets
- **Where in research**: Section 5.5 "SAR Post-Processing Design" + equations
- **In phases**: Phase 5.8 mentions validation only, no algorithm detail
- **Suggested destination**: Phase 5 new section OR separate `docs/sars/` file with detailed equations

### 6. In-Situ Real-Time Field Visualization
- **What**: WebGPU fields stay on GPU; render directly without GPU↔CPU→GPU. Live field propagation view during simulation.
- **Where in research**: Section 7.2-7.3 + 8.2 "Real-time Field Visualization"
- **In phases**: Not mentioned in Phase 2 (viz) or Phase 3 (GPU)
- **Suggested destination**: Phase 3 architectural decision section OR Phase 2 (mention as WebGPU-era opportunity)

### 7. Zero-Copy Data Transfer Best Practice
- **What**: Use HEAPF32 typed array views, never serialize to JSON (1000x overhead). GPU writeBuffer() from WASM region for background copy.
- **Where in research**: Section 8.2 "Zero-Copy Data Transfer"
- **In phases**: Not documented
- **Suggested destination**: Phase 3 performance best practices section

### 8. PROXY_TO_PTHREAD Criticality
- **What**: `-sPROXY_TO_PTHREAD` mandatory to avoid browser main-thread deadlock. Moves C++ main() to worker thread.
- **Where in research**: Section 1.4 (marked critical)
- **In phases**: Phase 5.1 mentions flag but downplays criticality
- **Suggested destination**: Phase 5 pthreads section with BOLD warning

### 9. Memory64 Performance Overhead
- **What**: `-sMEMORY64=1` enables 16GB+. Performance overhead should be measured. Practical 300^3+ grids with PML.
- **Where in research**: Section 5.3 & 12.1
- **In phases**: Phase 5.6 mentions flag, no benchmark guidance
- **Suggested destination**: Phase 5 benchmarking section with memory64 metrics

### 10. Cross-Origin Isolation Deployment
- **What**: `COOP: same-origin` + `COEP: require-corp` headers required for SharedArrayBuffer (pthreads).
- **Where in research**: Section 1.4
- **In phases**: Mentioned in build flags comment, not separated as deployment concern
- **Suggested destination**: Phase 6 new section "Deployment Checklist" with exact headers

---

## LOWER-PRIORITY GAPS (Technical details, not blocking)

### 11-15. GPU Compute Specifics
- GPU atomics limitation (no f32 atomic add): Phase 3 excitation caveats needed
- Kernel fusion strategy (performance rationale): Phase 4 doc
- Probe readback batching (N-timestep strategy): Phase 3 performance tuning
- Steady-state detection extension: Phase 4 (if GPU port needed)
- Cylinder multigrid depth limit: Phase 5 constraint doc

### 16-20. Storage & I/O Architecture
- WorkerFS for zero-duplication input: Phase 1 I/O architecture
- File System Access API streaming: Phase 2/6 result export
- Geometric predicate validation: Phase 1 test matrix
- Point-in-polyhedron AABB: Phase 4 (if CGAL ported later)
- Testing tolerance margin strategy (Matlab + 10%): Phase 0 testing doc

### 21-25. Lesser Constraints
- Transcendental function variation: Phase 1/6 cross-browser testing
- f16 prohibition in FDTD: Phase 1 constraints doc
- Denormal::Disable() per-thread: Phase 5 note
- Reference fixture generation workflow: Phase 0 procedure doc
- Production hardening baseline: Phase 6 checklist

### 26-29. Ecosystem Details
- Example priority tiers (v1/v2/v3): Phase 6 backlog clarification
- Bit-identical verification mode: Phase 1 test harness
- Batch timestep orchestration details: Phase 3 tuning
- CGAL rounding mode mitigation decision tree: Phase 0 decision doc

---

## GAP SUMMARY TABLE

| Category | Count | Severity | Key Destination(s) |
|----------|-------|----------|-------------------|
| Geometry/Correctness | 3 | HIGH | Phase 0, 1 |
| Numerical Precision | 4 | HIGH | New architecture doc |
| Storage & Lifecycle | 3 | MEDIUM-HIGH | New data-lifecycle doc |
| GPU Constraints | 4 | MEDIUM | Phase 3, 4 |
| Multithreading/Deploy | 4 | MEDIUM | Phase 5, 6 |
| SAR & Extensions | 3 | MEDIUM | Phase 4, 5 |
| Performance Tuning | 2 | MEDIUM | Phase 3 |
| Visualization | 1 | MEDIUM | Phase 2 or 3 |
| Testing | 2 | MEDIUM | Phase 0, 1 |
| Ecosystem | 4 | LOW | Phase 6 |
| **TOTAL** | **29 gaps** | | |

---

## COVERAGE VERDICT

✅ **Phase docs cover 70% of research scope** (architecture decisions, build steps, API design)
❌ **Missing 30% (29 topics)** — design rationale, constraints, performance trade-offs, deployment concerns

### What's Well-Covered
- Build infrastructure (Phase 0)
- Core FDTD update equations (Phases 1, 3)
- GPU shaders and kernels (Phases 3, 4)
- TS/API design (Phase 2)
- NF2FF algorithm (Phase 5)
- Examples and UX (Phase 6)

### Critical Gaps Requiring Fixes
1. **Numerical correctness strategy** — no precision policy documented
2. **CGAL/geometry decision** — chosen but not justified
3. **Data lifecycle** — multi-GB output strategy missing
4. **GPU performance** — buffer limits and batch sizing vague
5. **Deployment** — COOP/COEP headers not documented as prerequisite

---

## RECOMMENDED ACTIONS

### Create 3 New Architecture Docs
1. `docs/architecture/numerical-correctness.md`
   - Precision policy (f32 FDTD, f64 post-proc)
   - Cross-verification procedures
   - Tolerance margins (Matlab + 10%)
   - Transcendental function handling

2. `docs/architecture/data-lifecycle.md`
   - MEMFS/OPFS/FileSystem API strategy
   - WorkerFS input handling
   - Large result streaming
   - IndexedDB for configs

3. `docs/architecture/gpu-constraints.md`
   - Buffer limits (128 MiB per binding)
   - Grid size table with memory
   - Probe readback batching strategy
   - Zero-copy best practices

### Update Existing Phase Docs
- **Phase 0**: Add "Geometry Decision" and "Precision Policy" sections; link architecture docs
- **Phase 3**: Add "GPU Buffer Management", "Performance Tuning", "Zero-Copy Strategy" sections
- **Phase 5**: Add bold PROXY_TO_PTHREAD warning; memory64 benchmarking section
- **Phase 6**: Add "Production Checklist" with COOP/COEP headers, HTTPS, browser matrix

### Generate Documentation
- Reference fixture generation script/procedure (Phase 0)
- Tolerance margin policy document (Phase 0/1)
- Example priority tiers explicitly (Phase 6)

---

## FILES ANALYZED

Research: `docs/openems-web-port-research.md` (959 lines)
Phases: 
- `docs/phases/phase-0-build-infrastructure.md` (25.7 KB)
- `docs/phases/phase-1-wasm-mvp.md` (278 lines)
- `docs/phases/phase-2-ts-api-visualization.md` (525 lines)
- `docs/phases/phase-3-webgpu-acceleration.md` (568 lines)
- `docs/phases/phase-4-gpu-extensions.md` (21.2 KB)
- `docs/phases/phase-5-threading-nf2ff-scale.md` (217 lines)
- `docs/phases/phase-6-polish-ecosystem.md` (158 lines)

