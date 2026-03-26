# Design Compliance Review

Date: 2026-03-26
Scope: `STATUS.md` and all files under `docs/`, checked against current implementation in `src/`, `tests/`, `scripts/`, and `vendor/`.
Reviewer: GitHub Copilot CLI

## Executive summary

The codebase is partially compliant with the documented overall design and phase plans.

- Strong compliance: Phases 0, 1, and 3.
- Partial compliance: Phases 2 and 5.
- Significant deviation risk: Phase 4 (WebGPU extension ordering parity).
- Mostly not implemented: Phase 6 (polish/ecosystem backlog items).

Several quantitative claims in `STATUS.md` appear stronger than what is explicitly enforced by code/tests in-repo.

## Overall design compliance

| Area | Status | Notes |
|---|---|---|
| WASM + WebGPU hybrid architecture | Implemented | `src/webgpu-fdtd.mjs`, `src/webgpu-engine.mjs`, `src/wasm-gpu-bridge.mjs` |
| Build/dependency infrastructure | Implemented (with caveats) | Scripts and CMake flow exist; some hard-exit paths remain in vendor code |
| WASM API MVP | Implemented | Embind wrapper and lifecycle functions in `src/embind_api.cpp` |
| TypeScript/Python API parity | Partial | Core API exists, but full mirror not complete |
| WebGPU core solver | Implemented | Core kernels, CPU reference, bridge, and tests present |
| GPU extension parity/order | Partial (high risk) | Dispatch/order deviations versus phase doc expectations |
| Threading + NF2FF + SAR + scale | Partial | Core pieces present; some design-level API/operational gaps remain |
| Ecosystem polish | Mostly missing | IDE/share/deployment ecosystem largely not implemented |

## Phase-by-phase review

### Phase 0 — Build Infrastructure

Status: **Done (with caveats)**

Implemented:
- Build scripts: `scripts/build-wasm-deps.sh`, `scripts/build-wasm.sh`, `scripts/build-wasm64.sh`, `scripts/build-native-deps.sh`
- Root build integration: `CMakeLists.txt`
- Vendor disables/guards for optional components (CGAL/VTK): `vendor/CSXCAD/CMakeLists.txt`, `vendor/openEMS/CMakeLists.txt`
- Fixtures available: `tests/fixtures/*`

Gaps/deviations:
- Residual `exit()` paths in vendor code may still be problematic for browser/WASM robustness.

Risk: **Medium**

### Phase 1 — WASM CPU MVP

Status: **Done**

Implemented:
- Embind wrapper and simulation lifecycle API: `src/embind_api.cpp`
- WASM runtime path via JS API: `src/simulation.mjs`
- WASM test suite coverage: `tests/test_wasm.mjs`

Gaps/deviations:
- API shape is wrapper-centric vs exact low-level method mirror from docs.
- Fixed XML temp path (`/tmp/sim.xml`) can collide in concurrent scenarios.

Risk: **Low/Medium**

### Phase 2 — TypeScript API & Visualization

Status: **Partial**

Implemented:
- Simulation config/XML generation: `src/simulation.mjs`
- Port classes: `src/ports.mjs`
- Analysis, automesh, visualization helpers: `src/analysis.mjs`, `src/automesh.mjs`, `src/visualization.mjs`
- NF2FF + SAR modules: `src/nf2ff.mjs`, `src/sar.mjs`
- API tests: `tests/test_api.mjs`

Gaps/deviations:
- `readFromXML()` is stubbed/throws in `src/simulation.mjs`
- Full CSXCAD parity from phase spec is not fully implemented as runtime API.

Risk: **Medium/High**

### Phase 3 — WebGPU Acceleration

Status: **Done**

Implemented:
- WebGPU engine and shader orchestration: `src/webgpu-engine.mjs`
- CPU reference engine/hybrid fallback: `src/webgpu-fdtd.mjs`
- WASM bridge extraction: `src/wasm-gpu-bridge.mjs`
- Shader suite: `src/shaders/*.wgsl`
- Coverage via Node and browser suites: `tests/test_webgpu.mjs`, `tests/test_webgpu_browser.mjs`, `tests/webgpu/index.html`

Gaps/deviations:
- Some parameter-level differences from docs (e.g., workgroup/dispatch details) need explicit parity confirmation.

Risk: **Medium**

### Phase 4 — GPU Extensions

Status: **Partial (high-risk)**

Implemented:
- Extension shader modules and related support paths exist (Lorentz, TFSF, RLC, Mur, steady-state, PML/excitation paths).

Gaps/deviations:
- Dispatch/phase ordering in WebGPU iteration flow appears to diverge from documented C++ priority expectations.
- No explicit golden-order test ensuring exact extension phase parity.

Risk: **High**

### Phase 5 — Threading, NF2FF, Scale

Status: **Partial**

Implemented:
- pthread-related build flags/config are present.
- Multithread-related engine selection path exists.
- NF2FF/SAR/HDF5 support present in source and tests.
- wasm64 build script exists.

Gaps/deviations:
- Some doc-level API behaviors (e.g., worker/progress-oriented NF2FF design) are not fully reflected in current implementation.

Risk: **Medium**

### Phase 6 — Polish & Ecosystem

Status: **Not done**

Implemented:
- Minimal supporting pieces only.

Missing:
- Example gallery/tutorial porting pipeline
- IDE/editor workflow features
- URL-sharing flow
- Deployment hardening checklist items
- Monitoring/telemetry/autosave ecosystem

Risk: **High**

## Unsupported or weakly supported `STATUS.md` claims

- “Phases 0–5 complete” is overstated given documented gaps in Phases 2/4/5.
- Exact test counts and perfect pass state are not proven here without a fresh validated run.
- “Bit-identical” engine equivalence is stronger than current visible tolerance-style testing.
- Fixed performance ratio statements are benchmark claims, not continuously enforced acceptance gates.

## Top actionable fixes

1. Add explicit extension-order parity tests for Phase 4.
2. Reconcile `WebGPUEngine` dispatch sequence with documented/C++ extension priorities.
3. Implement `Simulation.readFromXML()` fully.
4. Either implement missing CSX API parity or narrow docs/STATUS claims.
5. Remove/contain remaining vendor `exit()` paths in WASM-relevant code paths.
6. Replace fixed `/tmp/sim.xml` with per-run unique temp path.
7. Make test-count and status assertions reproducible in CI artifacts.
8. Add strict checks for any “bit-identical” or exact-diff claims.
9. Clarify NF2FF threading/worker model in docs or code.
10. Reclassify Phase 6 as planned/in-progress unless implemented.

## Confidence and assumptions

Confidence: **Medium-high**  
Assumptions:
- Static audit only (no full build/test rerun performed in this document generation step).
- Compliance measured strictly against repository docs as requirements baseline.
