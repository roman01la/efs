# Phase 1: WASM CPU MVP

## Embind API Surface

Expose the following from `openems.h` via Emscripten Embind:

### Core Simulation Lifecycle

```cpp
#include <emscripten/bind.h>
#include "openems.h"

using namespace emscripten;

EMSCRIPTEN_BINDINGS(openems) {
  class_<openEMS>("openEMS")
    .constructor<>()

    // Core lifecycle
    .function("ParseFDTDSetup", &openEMS::ParseFDTDSetup)   // string file -> bool
    .function("SetupFDTD",      &openEMS::SetupFDTD)         // -> int (0=success, 1=no sim, 2=op error, 3=csx error)
    .function("RunFDTD",        &openEMS::RunFDTD)            // -> void

    // Library arguments (Python bindings use this for engine selection, etc.)
    .function("SetLibraryArguments", &openEMS::SetLibraryArguments) // vector<string>

    // Configuration
    .function("SetNumberOfTimeSteps",    &openEMS::SetNumberOfTimeSteps)
    .function("SetEndCriteria",          &openEMS::SetEndCriteria)
    .function("SetOverSampling",         &openEMS::SetOverSampling)
    .function("SetCellConstantMaterial", &openEMS::SetCellConstantMaterial)
    .function("SetCylinderCoords",       &openEMS::SetCylinderCoords)
    .function("SetTimeStepMethod",       &openEMS::SetTimeStepMethod)
    .function("SetTimeStep",             &openEMS::SetTimeStep)
    .function("SetTimeStepFactor",       &openEMS::SetTimeStepFactor)
    .function("SetMaxTime",              &openEMS::SetMaxTime)
    .function("SetNumberOfThreads",      &openEMS::SetNumberOfThreads)

    // Boundary conditions
    .function("Set_BC_Type",      &openEMS::Set_BC_Type)      // (idx, type)
    .function("Set_BC_PML",       &openEMS::Set_BC_PML)       // (idx, size)
    .function("Set_Mur_PhaseVel", &openEMS::Set_Mur_PhaseVel) // (idx, val)

    // Excitation signals
    .function("SetGaussExcite",   &openEMS::SetGaussExcite)   // (f0, fc)
    .function("SetSinusExcite",   &openEMS::SetSinusExcite)   // (f0)
    .function("SetDiracExcite",   &openEMS::SetDiracExcite)   // (fmax)
    .function("SetStepExcite",    &openEMS::SetStepExcite)     // (fmax)
    .function("SetCustomExcite",  &openEMS::SetCustomExcite);  // (str, f0, fmax)

  // Engine type enum
  enum_<openEMS::EngineType>("EngineType")
    .value("Basic",          openEMS::EngineType_Basic)          // 0
    .value("SSE",            openEMS::EngineType_SSE)            // 1
    .value("SSE_Compressed", openEMS::EngineType_SSE_Compressed) // 2
    .value("Multithreaded",  openEMS::EngineType_Multithreaded); // 3 (default)
}
```

### Engine Selection Chain

`openems.cpp` `SetupOperator()` dispatches on the engine type:

- `EngineType_SSE` -> `Operator_sse::New()` -> `FDTD_Op->CreateEngine()`
- Default is `Multithreaded`. Set via `--engine=sse` arg passed through `SetLibraryArguments`.
- For WASM MVP, target `EngineType_Basic` or `EngineType_SSE` (no pthreads needed).

### XML Parsing

`TiXmlDocument` loads the XML file and finds `<openEMS><FDTD>`. Attributes parsed:

- `NumberOfTimesteps`, `endCriteria`, `OverSampling`, `CylinderCoords`, `MaxTime`, `CellConstantMaterial`
- Boundary conditions from `xmin`, `xmax`, `ymin`, `ymax`, `zmin`, `zmax` attributes
- PML detected by `"PML_N"` string prefix (e.g. `"PML_8"`)

## I/O: Probe File Format

Probe output files are **plain ASCII TSV** with header comments prefixed by `%`.

- Written to CWD-relative paths
- Filename derived from probe name in XML
- Frequency-domain output files have `_FD` suffix

Example probe output:

```
% time/s    voltage/V
1.234e-12   0.00567
2.468e-12   0.01134
...
```

### MEMFS File Access from JavaScript

```typescript
// Write XML input into Emscripten virtual filesystem
FS.writeFile('/sim/cavity.xml', xmlContent);

// Run simulation
const ems = new Module.openEMS();
ems.ParseFDTDSetup('/sim/cavity.xml');
const rc = ems.SetupFDTD();
if (rc === 0) {
  ems.RunFDTD();
}

// Read probe results from MEMFS
const probeData = FS.readFile('/sim/Et_probe.tsv', { encoding: 'utf8' });
const fdData = FS.readFile('/sim/Et_probe_FD.tsv', { encoding: 'utf8' });

// Parse TSV (skip % comment lines)
function parseProbe(tsv: string): { time: Float64Array; values: Float64Array } {
  const lines = tsv.split('\n').filter(l => !l.startsWith('%') && l.trim());
  const time = new Float64Array(lines.length);
  const values = new Float64Array(lines.length);
  lines.forEach((line, i) => {
    const [t, v] = line.split('\t').map(Number);
    time[i] = t;
    values[i] = v;
  });
  return { time, values };
}
```

## Physical Constants

| Constant | Symbol | Value |
|----------|--------|-------|
| Speed of light | c0 | 299792458 m/s |
| Permeability of free space | mu0 | 4*pi*1e-7 H/m |
| Permittivity of free space | eps0 | 1/(mu0*c0^2) F/m |
| Impedance of free space | Z0 | sqrt(mu0/eps0) ~ 376.73 Ohm |

## Validation Test Cases

### Test 1: Rectangular Cavity Resonator

**Setup:**
- Dimensions: a=5e-2 m, b=2e-2 m, d=6e-2 m
- Mesh: 26 x 11 x 32 cells
- Frequency range: 1-10 GHz
- Excitation: Gaussian, f0=fc=4.5 GHz
- Timesteps: 20000, endCriteria: 1e-6
- Boundary: all PEC (type 0)

**Analytical resonance frequencies:**

| Mode  | Frequency (GHz) |
|-------|-----------------|
| TE101 | 3.46            |
| TE102 | 7.44            |
| TE201 | 6.94            |
| TE202 | 10.27           |
| TM110 | 6.06            |
| TM111 | 8.84            |

**Tolerances:**
- TE modes: +/- 0.13%
- TM modes: -0.25% / +0%
- Minimum amplitudes: 60% (TE), 27% (TM)
- Outer max threshold: 17%

### Test 2: Coaxial Transmission Line

**Setup:**
- Length: 1000, r_i=100, r_ai=230, r_aa=240
- Mesh resolution: 5
- Frequency range: 0-1 GHz
- Timesteps: 5000
- Boundary: PML_8 on z-max

**Expected:**
- Z0 = sqrt(mu0/eps0) / (2*pi) * ln(230/100) ~ 52.3 Ohm

**Tolerances:** +3% / -1%

### Test 3: Field Probes (Dipole)

**Setup:**
- Drawing unit: 1e-6
- f_max: 1e9
- Dipole length: lambda/50
- Mesh extent: +/- 20 * dipole_length
- Timesteps: 10000
- Boundary: Mur ABC

**Tolerances:**
- Time difference: < 1e-13
- Amplitude difference: < 1e-7

## Tolerance Policy

WASM-vs-native comparisons must account for floating-point differences arising from f32/f64 accumulation order, WASM SIMD vs native SSE minor variations, and browser transcendental function implementations.

**Baseline:** Matlab test tolerances from upstream openEMS (cavity TE freq +/-0.13%, coax Z0 +3%/-1%, field probe amplitude < 1e-7).

**Cross-platform margin:** Add 10% on top of Matlab baselines for WASM-vs-native comparison. For example, if Matlab tolerance is 0.13%, the WASM comparison threshold is 0.143%.

**Absolute thresholds for probe-level comparison:**

| Metric | Threshold | Notes |
|--------|-----------|-------|
| maxAbsDiff (time-domain) | 1e-12 | Accounts for f64 rounding in timestep accumulation |
| maxRelDiff (frequency peaks) | Matlab tolerance * 1.1 | 10% margin over analytical tolerance |
| Amplitude floor | Per-test minimum | Peaks below floor are excluded from frequency checks |

Tests that exceed these thresholds indicate a porting regression rather than acceptable FP variation.

## Test Harness Structure

```typescript
// test/wasm-mvp.test.ts
import { describe, it, expect } from 'vitest';

interface OpenEMSModule {
  openEMS: new () => OpenEMSInstance;
  FS: typeof FS;
}

interface OpenEMSInstance {
  ParseFDTDSetup(file: string): boolean;
  SetupFDTD(): number;
  RunFDTD(): void;
  SetLibraryArguments(args: string[]): void;
  SetNumberOfTimeSteps(n: number): void;
  SetEndCriteria(c: number): void;
  SetGaussExcite(f0: number, fc: number): void;
  Set_BC_Type(idx: number, type: number): void;
  Set_BC_PML(idx: number, size: number): void;
}

// Physical constants
const C0 = 299792458;
const MUE0 = 4e-7 * Math.PI;
const EPS0 = 1 / (MUE0 * C0 * C0);
const Z0 = Math.sqrt(MUE0 / EPS0);

let Module: OpenEMSModule;

beforeAll(async () => {
  Module = await import('../build/openems.js');
});

describe('Cavity Resonator', () => {
  it('should detect TE101 mode at 3.46 GHz within 0.13%', async () => {
    const { FS } = Module;
    FS.writeFile('/sim/cavity.xml', generateCavityXML({
      a: 5e-2, b: 2e-2, d: 6e-2,
      mesh: [26, 11, 32],
      f0: 4.5e9, fc: 4.5e9,
      nrTS: 20000, endCrit: 1e-6,
      bc: [0, 0, 0, 0, 0, 0], // all PEC
    }));

    const ems = new Module.openEMS();
    ems.ParseFDTDSetup('/sim/cavity.xml');
    expect(ems.SetupFDTD()).toBe(0);
    ems.RunFDTD();

    const fd = parseProbe(FS.readFile('/sim/Et_probe_FD.tsv', { encoding: 'utf8' }));
    const te101 = findPeak(fd, 3.0e9, 4.0e9);
    expect(te101.freq).toBeCloseTo(3.46e9, 3.46e9 * 0.0013);
    expect(te101.amplitude).toBeGreaterThan(0.60);
  });

  it('should detect TM110 mode at 6.06 GHz within 0.25%', async () => {
    // ... similar structure
  });
});

describe('Coaxial Line', () => {
  it('should compute Z0 ~ 52.3 Ohm within +3%/-1%', async () => {
    // Setup coax XML with PML_8 on z-max
    // Parse, setup, run
    // Read port voltage/current probes
    // Compute Z0 from V/I ratio
    const expectedZ0 = Z0 / (2 * Math.PI) * Math.log(230 / 100);
    // expect(computedZ0).toBeBetween(expectedZ0 * 0.99, expectedZ0 * 1.03);
  });
});

describe('Field Probes', () => {
  it('should match analytical dipole fields', async () => {
    // Setup dipole XML with Mur ABC
    // Compare time-domain probe output to analytical
    // expect(timeDiff).toBeLessThan(1e-13);
    // expect(ampDiff).toBeLessThan(1e-7);
  });
});

// Utilities
function generateCavityXML(params: CavityParams): string { /* ... */ }
function parseProbe(tsv: string) { /* ... */ }
function findPeak(fd: ProbeData, fmin: number, fmax: number) { /* ... */ }
```
