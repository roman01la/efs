# Research vs Phase Docs Coverage Review

Date: 2026-03-26  
Source compared:
- `docs/openems-web-port-research.md`
- `docs/phases/phase-0-build-infrastructure.md`
- `docs/phases/phase-1-wasm-mvp.md`
- `docs/phases/phase-2-ts-api-visualization.md`
- `docs/phases/phase-3-webgpu-acceleration.md`
- `docs/phases/phase-4-gpu-extensions.md`
- `docs/phases/phase-5-threading-nf2ff-scale.md`
- `docs/phases/phase-6-polish-ecosystem.md`

## Summary

Phase docs cover most implementation-level scope, but several cross-cutting decisions from the research document are not explicitly captured in phases 0–6.

## Missing or under-documented items

### 1) CGAL rounding-mode correctness risk and mitigation matrix

- **What is missing:** Explicit documentation that CGAL interval arithmetic depends on runtime FP rounding mode switching not available in WASM, plus the decision framework for alternatives.
- **Research reference:** “The Rounding Mode Impasse” section and nearby mitigation bullets.
- **Suggested destination:**  
  - `phase-0-build-infrastructure.md` (porting constraint + chosen mitigation)  
  - `phase-2-ts-api-visualization.md` (geometry feature limits exposed to users)

### 2) Tiered storage strategy for large simulation outputs

- **What is missing:** Practical storage architecture detailing when to use `MEMFS`, `OPFS`, File System Access API, and IndexedDB for multi-GB outputs and persistence.
- **Research reference:** storage table and OPFS streaming guidance.
- **Suggested destination:**  
  - `phase-5-threading-nf2ff-scale.md` (large data path and dump lifecycle)  
  - `phase-6-polish-ecosystem.md` (user-facing persistence/export behavior)

### 3) Explicit numeric precision policy (f32/f64 split)

- **What is missing:** One normative policy defining precision by subsystem and why.
- **Research reference:** precision table (`f32` for FDTD/GPU fields, `f64` for DFT/FFT/S-params/NF2FF/geometry).
- **Suggested destination:**  
  - `phase-3-webgpu-acceleration.md` (GPU precision boundaries)  
  - `phase-5-threading-nf2ff-scale.md` (post-processing precision requirements)

### 4) Cross-platform tolerance policy baseline

- **What is missing:** A documented tolerance policy for WASM/native/GPU comparisons (including margin rationale).
- **Research reference:** Matlab baseline + additional cross-platform margin guidance.
- **Suggested destination:**  
  - `phase-1-wasm-mvp.md` (WASM vs native checks)  
  - `phase-3-webgpu-acceleration.md` (GPU vs WASM checks)  
  - `phase-6-polish-ecosystem.md` (regression gate definition)

### 5) Zero-copy/low-copy data transfer guidance

- **What is missing:** Recommended transfer patterns to reduce copies and memory spikes between WASM heap, JS typed arrays, and WebGPU buffers.
- **Research reference:** data movement/performance notes around browser compute architecture.
- **Suggested destination:**  
  - `phase-3-webgpu-acceleration.md` (bridge and buffer upload policy)  
  - `phase-5-threading-nf2ff-scale.md` (large-field handling)

### 6) Risk register mapping into phases

- **What is missing:** Compact risk table linking risk -> owner phase -> mitigation -> verification.
- **Research reference:** risk section (CGAL correctness, FP determinism, large output data, etc.).
- **Suggested destination:**  
  - Add a “Risk register” section in each phase doc (or a shared appendix linked by all phases).

## Coverage status

- **General verdict:** Good coverage of implementation mechanics; incomplete capture of cross-cutting constraints and decision rationale from the research document.
- **Impact:** Medium — omissions mainly affect long-term maintainability, reproducibility, and onboarding clarity rather than immediate feature delivery.
