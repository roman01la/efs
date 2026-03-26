# Phase 6: Polish & Ecosystem

## Goal and scope

Phase 6 focuses on productization of the existing engine stack: reproducible examples, a usable browser workflow, and shareable simulation state.

### Mandatory for Phase 6 completion

1. **Examples v1:** `Patch_Antenna`, `MSL`, `Rect_Waveguide` with validation tests.
2. **UX shell:** editor/simulation/results workflow with local URL sharing.

### Out of scope for Phase 6 completion

- Full cloud sharing backend
- Full IDE feature parity with desktop tools
- Porting all tutorials/examples from upstream at once
- Hard production SLA/observability program (kept as follow-up backlog)

## Milestone plan (execution order)

### Milestone A — Examples v1 (mandatory)

Deliverables:
- Port 3 examples:
  - `Patch_Antenna`
  - `MSL`
  - `Rect_Waveguide`
- For each example:
  - Loadable config (XML or JSON->XML)
  - Run + post-processing path
  - Short explanatory guide
  - Baseline validation test

Acceptance criteria:
- Example runs end-to-end in browser/WASM.
- Validation metrics within tolerance:
  - S11 / Zin / mode metrics are within predefined thresholds.
- Each example has a deterministic test case in automated test suite.

Dependencies:
- Stable Simulation API (`simulation.mjs`, ports, analysis, nf2ff).
- Existing fixture/test utilities.

### Milestone B — UX shell (mandatory)

Deliverables:
- **Editor panel:** XML editing + basic validation feedback.
- **Simulation panel:** run/stop, progress/status, console output.
- **Results panel:** S-parameter, impedance, NF2FF outputs already supported by APIs.
- **Layout:** three-panel responsive layout with tabbed results.
- **Local URL sharing v1:**
  - `#config=<base64url(deflate(xml))>` for compact configs
  - `#id=<local-id>` backed by IndexedDB for large configs

Acceptance criteria:
- User can open/edit/run/view results without leaving one workflow.
- Copy-link reproduces same config and selected result view.
- Back/forward navigation restores state from fragment changes.

Dependencies:
- Milestone A examples for smoke/regression checks.
- Browser storage and compression utility integration.

## Phase 6 backlog (non-blocking follow-up)

### Expanded examples

Priority 2:
- `Patch_Antenna_Array`, `Helix`, `CPW_Line`, `Coax`

Priority 3:
- `Metamaterial_PlaneWave_Drude`, `directional_coupler`, `PML_reflection_analysis`

Additional candidate set:
- Antennas: `infDipol`, `Bi_Quad_Antenna`, `inverted_f`
- Waveguides: `Circ_Waveguide`
- Transmission lines: `MSL_Losses`, `Stripline`, `Finite_Stripline`
- Other: `PlaneWave`, `LumpedElement`, `resistance_sheet`

### Production hardening baseline

- Build: optimized WASM, compression, asset fingerprinting.
- Security/runtime headers: COOP/COEP/CSP, HTTPS.
- Browser compatibility policy + single-thread fallback behavior.
- Performance ergonomics: streaming compile, worker usage, lazy-load heavy modules.
- Reliability checks: regression, browser matrix, leak checks, benchmark tracking.
- Documentation pack: getting started, API reference, FAQ, changelog.

## Persistence and Export Behavior

Users expect simulation results to survive page reloads and to be downloadable. The storage tiers defined in Phase 5 surface here as user-facing behavior:

- **Auto-save:** Active simulation results (probe data, S-parameters) are persisted to OPFS automatically. Reopening the app restores the last session's results.
- **Export:** Users can download HDF5 field dumps, probe CSVs, and NF2FF results via the File System Access API (with a fallback to `<a download>` for browsers that lack it).
- **Config sharing:** Small configs use URL fragment encoding (`#config=<base64url(deflate(xml))>`). Large configs fall back to IndexedDB with `#id=<local-id>`.

---

## Regression Gate Definition

All examples (Milestone A) and upstream test cases must pass within the tolerance policy defined in Phase 1. The regression gate runs in CI on every merge to main:

- WASM-vs-native comparison within Matlab baselines + 10% margin.
- GPU-vs-WASM comparison within f32 tolerance (see Phase 3).
- No example result may drift beyond its golden-result baseline.

A failure in any gate blocks the merge. Tolerance thresholds are codified in `tests/fixtures/*/reference.json`.

---

## Reference data and formats

### Patch antenna reference (primary demo)

| Parameter | Value |
|---|---|
| Patch size | 32.86 x 41.37 mm |
| Substrate | FR4, epsilon_r = 3.38 |
| Substrate thickness | 1.524 mm |
| Ground plane | 60 x 60 mm |
| Feed | Lumped port, 50 ohm, x = -5.5 mm, z-dir |
| Excitation | Gaussian, 0-6 GHz |
| Max timesteps | 30000 |
| End criteria | 1e-5 |

Outputs: S11, Zin, NF2FF (`Prad`, `Dmax`, efficiency).

### XML structure (openEMS)

```xml
<openEMS>
  <FDTD NumberOfTimesteps="..." endCriteria="...">
    <Excitation Type="..." .../>
    <BoundaryCond xmin="..." xmax="..." ymin="..." ymax="..." zmin="..." zmax="..."/>
  </FDTD>
  <ContinuousStructure>
    <RectilinearGrid DeltaUnit="...">
      <XLines>...</XLines>
      <YLines>...</YLines>
      <ZLines>...</ZLines>
    </RectilinearGrid>
    <Properties>...</Properties>
  </ContinuousStructure>
</openEMS>
```

Boundary types: `0=PEC`, `1=PMC`, `2=MUR`, `3=PML` (+ PML cell counts).

### Probe and field data references

- ReadUI probe files are ASCII TSV with `%` comment headers.
- HDF5 layout used by post-processing:
  - `/Mesh/*`
  - `/FieldData/TD/*`
  - `/FieldData/FD/*`

## Analysis parity requirements

Target formulas and workflows to preserve:

- `calcPort` dispatch by port type (`Lumped`, `TL`, `WG`).
- `calcLumpedPort` decomposition:
  - `uf_inc = 0.5 * (u + i * Z)`
  - `if_inc = 0.5 * (i + u / Z)`
  - `uf_ref = u - uf_inc`
  - `if_ref = i - if_inc`
- `FFT_time2freq`: uniform `dt`, zero-padding, FFT scaling, single-sided spectrum, phase correction.
- `CalcNF2FF`: run NF2FF computation, read `E_theta`, `E_phi`, `Prad`, `Dmax`.

## Risks and mitigations

- **Risk:** Example results drift from reference after API/engine changes.  
  **Mitigation:** keep golden-result regression tests tied to Milestone A.

- **Risk:** URL fragment size limits for large configs.  
  **Mitigation:** automatic fallback to IndexedDB (`#id=`).

- **Risk:** UI responsiveness on larger runs.
  **Mitigation:** worker execution path and progressive status updates.

## Risk Register

| Risk | Phase Owner | Mitigation | Verification |
|------|-------------|------------|--------------|
| CGAL correctness (polyhedron geometry) | Phase 0 | Disabled via `-DCSXCAD_NO_CGAL` | Build succeeds without CGAL; no polyhedron tests expected |
| FP determinism (cross-platform) | Phase 1 | Matlab baselines + 10% margin; f64 for post-processing | WASM-vs-native and GPU-vs-WASM tolerance suites pass |
| Large output data (multi-GB) | Phase 5 | OPFS/File System Access API streaming; MEMFS for active state only | Field dump >1 GB completes without OOM |
| Browser memory limits | Phase 5 | Grid size validation; memory64 for large grids | Automated budget check before simulation |
| Thread pool exhaustion | Phase 5 | Cap at `hardwareConcurrency`; work queue overflow handling | Stress test with concurrent operations |
| WebGPU device loss | Phase 3 | Detect `device.lost`; re-create and resume from checkpoint | Device-loss injection test passes |
