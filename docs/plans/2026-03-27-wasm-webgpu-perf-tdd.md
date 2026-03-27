# WASM + WebGPU Performance Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve WASM/WebGPU hot-path performance while preserving numerical correctness and API behavior via TDD regression coverage.

**Architecture:** Use operation-count/perf-structure tests first (not fragile wall-clock only), then implement low-risk high-impact optimizations in `wasm-gpu-bridge.mjs` and `webgpu-engine.mjs`. Keep dispatch order and physics outputs unchanged, and verify parity with existing CPU/WebGPU comparison tests.

**Tech Stack:** Node.js ESM tests, custom test harness in `tests/test_webgpu.mjs`, Emscripten/WASM bindings, WebGPU compute pipelines (WGSL), npm scripts.

---

## Scope and non-goals

- In scope:
  - WASM bridge copy/marshaling overhead reduction and resource cleanup safety.
  - WebGPU pipeline/module reuse and command-setup overhead reduction.
  - Regression tests proving no behavior change and no dispatch-order drift.
  - Perf guardrails using stable counters/ratios.
- Out of scope for this plan:
  - Large algorithmic rewrites (NF2FF WASM port, kernel fusion rewrite).
  - New external benchmark frameworks.

## Test strategy (TDD)

- Prefer deterministic assertions over raw timing:
  - Count calls to `device.queue.writeBuffer`, `createShaderModule`, `createBindGroup`.
  - Assert dispatch order by source and/or instrumentation.
  - Assert numerical parity against current fixtures and CPU engine comparisons.
- Keep wall-clock checks as advisory only with generous thresholds.

---

### Task 1: Add perf-regression test harness hooks

**Files:**
- Modify: `tests/test_webgpu.mjs`
- Test: `tests/test_webgpu.mjs`

**Step 1: Write the failing test**

Add sections that instrument mock device/queue counters and assert expected max counts per `iterate(1)` for:
- `queue.writeBuffer` param updates
- bind-group creation churn
- shader-module recreation on repeated configure/init

```javascript
section('Perf Guard: writeBuffer call budget');
{
  const eng = createInstrumentedEngine();
  await eng.init([8,8,8], createFreeSpaceCoefficients(8,8,8));
  await eng.iterate(1);
  assert(eng._stats.writeBufferCalls <= EXPECTED_MAX, 'writeBuffer budget');
}
```

**Step 2: Run test to verify it fails**

Run: `node tests/test_webgpu.mjs`  
Expected: FAIL in new perf-guard sections (current implementation exceeds budget).

**Step 3: Write minimal implementation**

No production changes yet. Keep only test scaffolding/helpers needed for instrumentation.

**Step 4: Run test to verify it passes/fails as expected**

Run: `node tests/test_webgpu.mjs`  
Expected: Existing tests pass, new perf guards fail.

**Step 5: Commit**

```bash
git add tests/test_webgpu.mjs
git commit -m "test(webgpu): add perf guard instrumentation and failing budgets"
```

---

### Task 2: Harden WASM bridge cleanup (no leaks on exceptions)

**Files:**
- Modify: `src/wasm-gpu-bridge.mjs`
- Test: `tests/test_webgpu.mjs`

**Step 1: Write the failing test**

Add test: when one coefficient getter throws midway, all previously-created embind vectors receive `.delete()`.

```javascript
section('WASM Bridge cleanup on extraction failure');
{
  const mock = createThrowingWasmMockAfter('getVI');
  assertThrows(() => bridge.configureFromWASM(mock));
  assert(mock._deleted.gridSize && mock._deleted.vv, 'vectors cleaned in finally');
}
```

**Step 2: Run test to verify it fails**

Run: `node tests/test_webgpu.mjs`  
Expected: FAIL because current cleanup is not in `try/finally`.

**Step 3: Write minimal implementation**

Refactor `configureFromWASM` to:
- allocate vectors
- extract data
- always cleanup in `finally`
- preserve original error propagation

**Step 4: Run test to verify it passes**

Run: `node tests/test_webgpu.mjs`  
Expected: PASS for new cleanup test; no regressions in existing bridge tests.

**Step 5: Commit**

```bash
git add src/wasm-gpu-bridge.mjs tests/test_webgpu.mjs
git commit -m "fix(wasm-bridge): ensure embind vectors are always released"
```

---

### Task 3: Reduce WASM->JS copy overhead path safely

**Files:**
- Modify: `src/wasm-gpu-bridge.mjs`
- Test: `tests/test_webgpu.mjs`

**Step 1: Write the failing test**

Add test for optimized conversion path detection:
- If vector exposes bulk-copy API/path, use it.
- Otherwise fallback to `.get(i)` loop.
- Numerical output must match exactly.

```javascript
section('WASM Bridge conversion uses fast path when available');
{
  const mock = createFastPathVectorMock();
  bridge.configureFromWASM(mock);
  assert(mock._stats.fastPathUsed === true, 'fast path selected');
}
```

**Step 2: Run test to verify it fails**

Run: `node tests/test_webgpu.mjs`  
Expected: FAIL (only slow `.get(i)` loop currently used).

**Step 3: Write minimal implementation**

Implement `_embindVectorToFloat32Array` strategy:
1. Fast path if embind vector provides direct contiguous-copy helper.
2. Fallback path keeps current element-wise behavior.
3. Keep API output unchanged.

**Step 4: Run test to verify it passes**

Run: `node tests/test_webgpu.mjs`  
Expected: PASS for new fast-path test + prior bridge tests.

**Step 5: Commit**

```bash
git add src/wasm-gpu-bridge.mjs tests/test_webgpu.mjs
git commit -m "perf(wasm-bridge): add safe bulk conversion fast path with fallback"
```

---

### Task 4: Cache shader modules/pipelines to avoid recreation churn

**Files:**
- Modify: `src/webgpu-engine.mjs`
- Test: `tests/test_webgpu.mjs`

**Step 1: Write the failing test**

Add tests asserting repeated extension configuration does not recreate identical shader modules/pipelines unnecessarily.

```javascript
section('WebGPU shader module cache');
{
  const eng = createInstrumentedEngine();
  await eng.init([8,8,8], coeffs);
  const before = eng._stats.createShaderModuleCalls;
  eng.configureLorentzADE(cfgA);
  eng.configureLorentzADE(cfgA);
  assert(eng._stats.createShaderModuleCalls - before <= EXPECTED_NEW, 'module cache hit');
}
```

**Step 2: Run test to verify it fails**

Run: `node tests/test_webgpu.mjs`  
Expected: FAIL due to duplicate `createShaderModule` calls.

**Step 3: Write minimal implementation**

In `webgpu-engine.mjs`:
- add internal maps for shader modules and pipeline descriptors
- route creation through cached helper methods
- preserve current behavior and public API

**Step 4: Run test to verify it passes**

Run: `node tests/test_webgpu.mjs`  
Expected: PASS for cache tests and existing functionality tests.

**Step 5: Commit**

```bash
git add src/webgpu-engine.mjs tests/test_webgpu.mjs
git commit -m "perf(webgpu): cache shader modules and reusable pipelines"
```

---

### Task 5: Reduce per-step uniform update overhead without changing results

**Files:**
- Modify: `src/webgpu-engine.mjs`
- Test: `tests/test_webgpu.mjs`

**Step 1: Write the failing test**

Add tests that:
- enforce writeBuffer call budget for one and many iterations.
- confirm `numTS` progression and output fields match baseline engine behavior.

```javascript
section('WebGPU params update budget with parity');
{
  const base = createReferenceEngine();
  const opt = createOptimizedEngine();
  await base.iterate(10);
  await opt.iterate(10);
  assertFieldNear(await base.getFields(), await opt.getFields(), 1e-6);
  assert(opt._stats.writeBufferCalls < base._stats.writeBufferCalls, 'fewer writes');
}
```

**Step 2: Run test to verify it fails**

Run: `node tests/test_webgpu.mjs`  
Expected: FAIL on write-buffer budget assertions.

**Step 3: Write minimal implementation**

Refactor `_updateParams`, `_updateExcParams`, `_updateTFSFParams` usage:
- update only when values changed
- batch updates at timestep boundaries
- keep same dispatch order and phase semantics

**Step 4: Run test to verify it passes**

Run: `node tests/test_webgpu.mjs`  
Expected: PASS including dispatch-order structural test.

**Step 5: Commit**

```bash
git add src/webgpu-engine.mjs tests/test_webgpu.mjs
git commit -m "perf(webgpu): minimize redundant uniform buffer writes per step"
```

---

### Task 6: Replace lazy core bind-group cache path with explicit stable bindings

**Files:**
- Modify: `src/webgpu-engine.mjs`
- Test: `tests/test_webgpu.mjs`

**Step 1: Write the failing test**

Add a regression test asserting:
- no per-step bind-group creation for stable core pipelines
- dispatch order remains unchanged

```javascript
section('Core bind groups are precreated and stable');
{
  const eng = createInstrumentedEngine();
  await eng.init([8,8,8], coeffs);
  const before = eng._stats.createBindGroupCalls;
  await eng.iterate(5);
  const after = eng._stats.createBindGroupCalls;
  assert(after - before === 0, 'no bind-group churn in iterate');
}
```

**Step 2: Run test to verify it fails**

Run: `node tests/test_webgpu.mjs`  
Expected: FAIL due to lazy `_coreBindGroupFor` creation path.

**Step 3: Write minimal implementation**

Refactor:
- pre-create required core bind groups in initialization/configure stage
- stop creating them in hot `step*` methods
- preserve behavior for special binding sets (e.g., excitation)

**Step 4: Run test to verify it passes**

Run: `node tests/test_webgpu.mjs`  
Expected: PASS, including `WebGPU Engine Dispatch Order Parity`.

**Step 5: Commit**

```bash
git add src/webgpu-engine.mjs tests/test_webgpu.mjs
git commit -m "perf(webgpu): precreate stable core bind groups for hot path"
```

---

### Task 7: End-to-end regression + benchmark gate

**Files:**
- Modify: `tests/test_wasm.mjs` (if needed for benchmark assertions/reporting)
- Modify: `tests/test_webgpu.mjs` (optional summary section)
- Modify: `STATUS.md` (record perf deltas and invariants)

**Step 1: Write the failing test**

Add a non-flaky benchmark gate based on ratio/operation counts:
- require optimized path not worse than baseline by tolerated margin
- treat hard regressions as failures

```javascript
section('Perf regression gate (non-flaky)');
{
  const r = runPerfScenario();
  assert(r.opCountOptimized <= r.opCountBaseline, 'no op-count regression');
}
```

**Step 2: Run test to verify it fails or is pending**

Run: `node tests/test_webgpu.mjs`  
Expected: initially FAIL or TODO until implementation merged.

**Step 3: Write minimal implementation**

Wire benchmark summary output and gate thresholds tied to deterministic counters first, timing second.

**Step 4: Run full verification**

Run:
- `npm run test:api`
- `npm run test:wasm`
- `npm run test:gpu`
- `npm run test:examples`
- `npm run test:count`
- `npm run bench` (record before/after numbers)

Expected: all tests pass; benchmark shows no regression and measurable hotspot improvements.

**Step 5: Commit**

```bash
git add tests/test_wasm.mjs tests/test_webgpu.mjs STATUS.md
git commit -m "test(perf): add regression gate and publish perf deltas"
```

---

## Integration checklist

- Keep dispatch order exactly aligned with existing parity section in `tests/test_webgpu.mjs`.
- Validate numerical parity after each perf refactor.
- Avoid broad catches/silent fallback; preserve explicit errors.
- Prefer small commits per task.

## Skills to apply during execution

- `@superpowers:test-driven-development` before each code change.
- `@superpowers:verification-before-completion` before completion claim.
- `@superpowers:requesting-code-review` after final task group.

