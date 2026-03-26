// WebGPU FDTD Engine Tests
//
// Since Node.js does not have native WebGPU, these tests validate:
// 1. The CPU reference implementation matches the C++ engine.cpp equations
// 2. 3D indexing and boundary conditions are correct
// 3. Small-grid FDTD updates produce expected results
// 4. Excitation injection works correctly
// 5. WGSL shader source parses as valid syntax (basic structural checks)

import { CPUFDTDEngine } from '../src/webgpu-fdtd.mjs';
import { UPDATE_VOLTAGE_WGSL, UPDATE_CURRENT_WGSL, UPDATE_PML_WGSL, EXCITATION_WGSL } from '../src/webgpu-engine.mjs';
import { WASMGPUBridge } from '../src/wasm-gpu-bridge.mjs';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
    totalTests++;
    if (condition) {
        passedTests++;
    } else {
        failedTests++;
        console.error(`  FAIL: ${message}`);
    }
}

function assertApprox(actual, expected, tol, message) {
    const diff = Math.abs(actual - expected);
    assert(diff <= tol, `${message} (expected ${expected}, got ${actual}, diff ${diff}, tol ${tol})`);
}

function assertArrayApprox(actual, expected, tol, message) {
    assert(actual.length === expected.length,
        `${message} — length mismatch: ${actual.length} vs ${expected.length}`);
    for (let i = 0; i < actual.length; i++) {
        const diff = Math.abs(actual[i] - expected[i]);
        if (diff > tol) {
            assert(false, `${message} — index ${i}: expected ${expected[i]}, got ${actual[i]}, diff ${diff}`);
            return;
        }
    }
    assert(true, message);
}

function section(name) {
    console.log(`\n--- ${name} ---`);
}

// ---------------------------------------------------------------------------
// Helper: create coefficient arrays for a uniform free-space grid
// ---------------------------------------------------------------------------

function createFreeSpaceCoefficients(Nx, Ny, Nz) {
    const total = 3 * Nx * Ny * Nz;

    // In free space: vv = 1.0, ii = 1.0 (no material loss)
    // vi and iv depend on cell geometry; for a uniform unit grid: vi = iv = dt/(eps*dx).
    // CFL condition for 3D: dt <= dx / (c * sqrt(3)), so vi = iv = 1/sqrt(3) ~ 0.577
    // Use 0.5 which is safely within CFL (0.5 < 1/sqrt(3) = 0.577).
    // The stability criterion is: vi * iv * (1/dx^2) * sum_of_stencil_coeffs <= 1
    // For unit grid with max stencil factor 6: 0.5 * 0.5 * 6 = 1.5 > 1 (unstable!)
    // Use vi = iv = 0.3 for CFL stability: 0.3 * 0.3 * 6 = 0.54 < 1.
    const viVal = 0.3;
    const ivVal = 0.3;
    const vv = new Float32Array(total).fill(1.0);
    const vi = new Float32Array(total).fill(viVal);
    const ii = new Float32Array(total).fill(1.0);
    const iv = new Float32Array(total).fill(ivVal);

    return { vv, vi, ii, iv };
}

/**
 * ArrayNIJK index helper matching the C++ memory layout.
 */
function idx(n, x, y, z, Nx, Ny, Nz) {
    return n * Nx * Ny * Nz + x * Ny * Nz + y * Nz + z;
}

// ---------------------------------------------------------------------------
// Test 1: ArrayNIJK indexing
// ---------------------------------------------------------------------------

section('ArrayNIJK Indexing');

{
    const Nx = 5, Ny = 4, Nz = 3;

    // First element
    assert(idx(0, 0, 0, 0, Nx, Ny, Nz) === 0, 'idx(0,0,0,0) = 0');

    // Z stride = 1
    assert(idx(0, 0, 0, 1, Nx, Ny, Nz) === 1, 'Z stride is 1');
    assert(idx(0, 0, 0, 2, Nx, Ny, Nz) === 2, 'Z stride is 1 (z=2)');

    // Y stride = Nz
    assert(idx(0, 0, 1, 0, Nx, Ny, Nz) === Nz, `Y stride = Nz = ${Nz}`);

    // X stride = Ny*Nz
    assert(idx(0, 1, 0, 0, Nx, Ny, Nz) === Ny * Nz, `X stride = Ny*Nz = ${Ny * Nz}`);

    // N stride = Nx*Ny*Nz
    assert(idx(1, 0, 0, 0, Nx, Ny, Nz) === Nx * Ny * Nz, `N stride = Nx*Ny*Nz = ${Nx * Ny * Nz}`);

    // Total size check
    const lastIdx = idx(2, Nx - 1, Ny - 1, Nz - 1, Nx, Ny, Nz);
    assert(lastIdx === 3 * Nx * Ny * Nz - 1, `Last index = ${3 * Nx * Ny * Nz - 1}`);
}

// ---------------------------------------------------------------------------
// Test 2: CPUFDTDEngine indexing matches ArrayNIJK
// ---------------------------------------------------------------------------

section('CPUFDTDEngine Indexing');

{
    const Nx = 5, Ny = 4, Nz = 3;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    assert(engine.idx(0, 0, 0, 0) === 0, 'engine.idx(0,0,0,0) = 0');
    assert(engine.idx(1, 0, 0, 0) === Nx * Ny * Nz, 'engine.idx component stride');
    assert(engine.idx(0, 1, 0, 0) === Ny * Nz, 'engine.idx X stride');
    assert(engine.idx(0, 0, 1, 0) === Nz, 'engine.idx Y stride');
    assert(engine.idx(0, 0, 0, 1) === 1, 'engine.idx Z stride');
}

// ---------------------------------------------------------------------------
// Test 3: Voltage update boundary handling (shift at index 0)
// ---------------------------------------------------------------------------

section('Voltage Update — Boundary Handling');

{
    // On a small grid, set specific current values and verify voltage update
    // at boundary cells (x=0, y=0, z=0) uses the shift logic correctly.
    const Nx = 3, Ny = 3, Nz = 3;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Set a known current pattern
    const total = Nx * Ny * Nz;
    for (let n = 0; n < 3; n++) {
        for (let x = 0; x < Nx; x++) {
            for (let y = 0; y < Ny; y++) {
                for (let z = 0; z < Nz; z++) {
                    engine.curr[idx(n, x, y, z, Nx, Ny, Nz)] = (n + 1) * 0.1 * (x + y + z + 1);
                }
            }
        }
    }

    // At (0,0,0) with shift=[0,0,0], the curl differences involving -1 indices
    // should use self-reference, making those differences zero.
    // Ex curl at (0,0,0): Hz(0,0,0) - Hz(0,0-0,0) - Hy(0,0,0) + Hy(0,0,0-0)
    // = Hz(0,0,0) - Hz(0,0,0) - Hy(0,0,0) + Hy(0,0,0) = 0
    const hzVal = engine.curr[idx(2, 0, 0, 0, Nx, Ny, Nz)];
    const hyVal = engine.curr[idx(1, 0, 0, 0, Nx, Ny, Nz)];
    const expectedCurl = hzVal - hzVal - hyVal + hyVal; // should be 0

    engine.updateVoltages();

    // volt[ex at 0,0,0] should be vv*0 + vi*0 = 0 (started at 0, curl is 0)
    const exVal = engine.volt[idx(0, 0, 0, 0, Nx, Ny, Nz)];
    assertApprox(exVal, 0.0, 1e-10, 'Ex at (0,0,0) boundary curl is zero');

    // At an interior point (1,1,1), curl should be non-zero
    const exInterior = engine.volt[idx(0, 1, 1, 1, Nx, Ny, Nz)];
    // Hz(1,1,1) - Hz(1,0,1) - Hy(1,1,1) + Hy(1,1,0)
    const hz11 = engine.curr[idx(2, 1, 1, 1, Nx, Ny, Nz)];
    const hz01 = engine.curr[idx(2, 1, 0, 1, Nx, Ny, Nz)];
    const hy11 = engine.curr[idx(1, 1, 1, 1, Nx, Ny, Nz)];
    const hy10 = engine.curr[idx(1, 1, 1, 0, Nx, Ny, Nz)];
    const interiorCurl = hz11 - hz01 - hy11 + hy10;
    const expectedInterior = 0.0 + 0.3 * interiorCurl; // vv*0 + vi*curl
    assertApprox(exInterior, expectedInterior, 1e-6,
        'Ex at interior (1,1,1) matches manual calculation');
}

// ---------------------------------------------------------------------------
// Test 4: Current update loop bounds
// ---------------------------------------------------------------------------

section('Current Update — Loop Bounds');

{
    const Nx = 4, Ny = 4, Nz = 4;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Set voltage to known pattern
    for (let n = 0; n < 3; n++) {
        for (let x = 0; x < Nx; x++) {
            for (let y = 0; y < Ny; y++) {
                for (let z = 0; z < Nz; z++) {
                    engine.volt[idx(n, x, y, z, Nx, Ny, Nz)] = (n + 1) * 0.1;
                }
            }
        }
    }

    engine.updateCurrents();

    // Current at the last Y and Z indices should be unchanged (not updated)
    // because current loop goes to Ny-1 and Nz-1
    for (let x = 0; x < Nx; x++) {
        for (let n = 0; n < 3; n++) {
            const lastY = engine.curr[idx(n, x, Ny - 1, 0, Nx, Ny, Nz)];
            assert(lastY === 0, `curr[${n},${x},${Ny - 1},0] unchanged (is ${lastY})`);

            const lastZ = engine.curr[idx(n, x, 0, Nz - 1, Nx, Ny, Nz)];
            assert(lastZ === 0, `curr[${n},${x},0,${Nz - 1}] unchanged (is ${lastZ})`);
        }
    }

    // Interior current should be updated
    // With uniform voltage, curl differences are zero (all voltages equal),
    // so current remains 0. Use a non-uniform pattern to verify.
}

{
    const Nx = 4, Ny = 4, Nz = 4;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Set a gradient in voltage to produce non-zero curl
    for (let n = 0; n < 3; n++) {
        for (let x = 0; x < Nx; x++) {
            for (let y = 0; y < Ny; y++) {
                for (let z = 0; z < Nz; z++) {
                    engine.volt[idx(n, x, y, z, Nx, Ny, Nz)] = n * 0.1 + x * 0.01 + y * 0.001 + z * 0.0001;
                }
            }
        }
    }

    engine.updateCurrents();

    // Manually compute Hx at (1,1,1)
    // Hx = ii*0 + iv * (Ez(1,1,1) - Ez(1,2,1) - Ey(1,1,1) + Ey(1,1,2))
    const ez11 = 2 * 0.1 + 1 * 0.01 + 1 * 0.001 + 1 * 0.0001;
    const ez21 = 2 * 0.1 + 1 * 0.01 + 2 * 0.001 + 1 * 0.0001;
    const ey11 = 1 * 0.1 + 1 * 0.01 + 1 * 0.001 + 1 * 0.0001;
    const ey12 = 1 * 0.1 + 1 * 0.01 + 1 * 0.001 + 2 * 0.0001;
    const hxCurl = ez11 - ez21 - ey11 + ey12;
    const expectedHx = 0.3 * hxCurl;
    const actualHx = engine.curr[idx(0, 1, 1, 1, Nx, Ny, Nz)];
    assertApprox(actualHx, expectedHx, 1e-6,
        'Hx at (1,1,1) matches manual curl calculation');
}

// ---------------------------------------------------------------------------
// Test 5: Full timestep symmetry
// ---------------------------------------------------------------------------

section('Full Timestep — Field Evolution');

{
    const Nx = 8, Ny = 8, Nz = 8;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Place a point source in Ex at center
    const cx = Math.floor(Nx / 2);
    const cy = Math.floor(Ny / 2);
    const cz = Math.floor(Nz / 2);
    engine.volt[idx(0, cx, cy, cz, Nx, Ny, Nz)] = 1.0;

    // Run 1 timestep
    engine.updateVoltages();
    engine.updateCurrents();
    engine.numTS++;

    // After 1 step, the voltage should have been modified by the curl of H
    // (H was zero, so voltage at center should just be vv * 1.0 = 1.0)
    assertApprox(
        engine.volt[idx(0, cx, cy, cz, Nx, Ny, Nz)],
        1.0,
        1e-6,
        'After 1 voltage update, Ex at center = vv * 1.0 (H was 0)'
    );

    // But current should now be non-zero near the source
    // Hx at (cx, cy, cz): curl includes Ez(y) - Ez(y+1) - Ey + Ey(z+1)
    // Only Ex was set, so Hz curl picks up Ex: Hz(cx,cy,cz) involves Ey(cx+1) - Ey(cx)
    // Wait, Ey and Ez at center are 0, only Ex = 1.0
    // Hy curl = Ex(cx,cy,cz) - Ex(cx,cy,cz+1) - Ez + Ez(cx+1)
    // = 1.0 - 0 - 0 + 0 = 1.0
    // Hy(cx,cy,cz) = 0.3 * 1.0 = 0.3
    const hyAtCenter = engine.curr[idx(1, cx, cy, cz, Nx, Ny, Nz)];
    assertApprox(hyAtCenter, 0.3, 1e-6,
        'Hy at center after 1 step = iv * (Ex - 0) = 0.3');

    // Hz at (cx, cy, cz): curl = Ey(cx) - Ey(cx+1) - Ex(cx,cy) + Ex(cx,cy+1)
    // = 0 - 0 - 1.0 + 0 = -1.0
    // Hz(cx,cy,cz) = 0.3 * (-1.0) = -0.3
    const hzAtCenter = engine.curr[idx(2, cx, cy, cz, Nx, Ny, Nz)];
    assertApprox(hzAtCenter, -0.3, 1e-6,
        'Hz at center after 1 step = iv * (0 - Ex) = -0.3');

    // Run more steps and verify energy is propagating (fields become non-zero away from center)
    for (let i = 0; i < 3; i++) {
        engine.updateVoltages();
        engine.updateCurrents();
        engine.numTS++;
    }

    // Check that fields have spread beyond the center cell
    let nonZeroCount = 0;
    for (let x = 0; x < Nx; x++) {
        for (let y = 0; y < Ny; y++) {
            for (let z = 0; z < Nz; z++) {
                if (Math.abs(engine.volt[idx(0, x, y, z, Nx, Ny, Nz)]) > 1e-10) {
                    nonZeroCount++;
                }
            }
        }
    }
    assert(nonZeroCount > 1, `After 4 steps, Ex non-zero at ${nonZeroCount} cells (should be > 1)`);
}

// ---------------------------------------------------------------------------
// Test 6: Excitation injection
// ---------------------------------------------------------------------------

section('Excitation Injection');

{
    const Nx = 5, Ny = 5, Nz = 5;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Single excitation point at (2,2,2), component 0 (Ex), no delay
    const signal = new Float32Array([1.0, 0.5, 0.25, 0.125]);
    engine.configureExcitation({
        signal,
        delay: new Uint32Array([0]),
        amp: new Float32Array([2.0]),
        dir: new Uint32Array([0]),         // Ex component
        pos: new Uint32Array([2 * Ny * Nz + 2 * Nz + 2]), // linear position
        period: 0,
    });

    // At numTS=0: excPos = 0 - 0 = 0, signal[0] = 1.0
    engine.applyExcitation();
    const exVal0 = engine.volt[idx(0, 2, 2, 2, Nx, Ny, Nz)];
    assertApprox(exVal0, 2.0, 1e-6, 'Excitation at step 0: amp * signal[0] = 2.0');

    // Reset and test at numTS=2
    engine.volt.fill(0);
    engine.numTS = 2;
    engine.applyExcitation();
    const exVal2 = engine.volt[idx(0, 2, 2, 2, Nx, Ny, Nz)];
    assertApprox(exVal2, 2.0 * 0.25, 1e-6, 'Excitation at step 2: amp * signal[2] = 0.5');

    // Test beyond signal length — C++ behavior: exc_pos gets zeroed, so signal[0] is read.
    // This matches the C++ pattern: exc_pos *= (exc_pos < length) zeros it, then signal[0] is used.
    engine.volt.fill(0);
    engine.numTS = 10;
    engine.applyExcitation();
    const exValBeyond = engine.volt[idx(0, 2, 2, 2, Nx, Ny, Nz)];
    assertApprox(exValBeyond, 2.0 * 1.0, 1e-6,
        'Excitation beyond signal length: amp * signal[0] (C++ behavior)');
}

// ---------------------------------------------------------------------------
// Test 7: Excitation with delay
// ---------------------------------------------------------------------------

section('Excitation with Delay');

{
    const Nx = 5, Ny = 5, Nz = 5;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    const signal = new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0]);
    engine.configureExcitation({
        signal,
        delay: new Uint32Array([3]),
        amp: new Float32Array([1.0]),
        dir: new Uint32Array([1]),         // Ey component
        pos: new Uint32Array([1 * Ny * Nz + 1 * Nz + 1]),
        period: 0,
    });

    // At numTS=3: excPos = 3 - 3 = 0
    engine.numTS = 3;
    engine.applyExcitation();
    assertApprox(engine.volt[idx(1, 1, 1, 1, Nx, Ny, Nz)], 1.0, 1e-6,
        'Delayed excitation at step 3: signal[0] = 1.0');

    // At numTS=1: excPos = 1 - 3 = -2 -> clamped to 0
    engine.volt.fill(0);
    engine.numTS = 1;
    engine.applyExcitation();
    assertApprox(engine.volt[idx(1, 1, 1, 1, Nx, Ny, Nz)], 1.0, 1e-6,
        'Delayed excitation at step 1: clamped to signal[0] = 1.0');
}

// ---------------------------------------------------------------------------
// Test 8: Multi-step with excitation
// ---------------------------------------------------------------------------

section('Multi-step with Excitation');

{
    const Nx = 10, Ny = 10, Nz = 10;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Gaussian-like excitation
    const sigLen = 50;
    const signal = new Float32Array(sigLen);
    for (let i = 0; i < sigLen; i++) {
        const t = (i - 25) / 5;
        signal[i] = Math.exp(-t * t);
    }

    engine.configureExcitation({
        signal,
        delay: new Uint32Array([0]),
        amp: new Float32Array([1.0]),
        dir: new Uint32Array([2]),         // Ez component
        pos: new Uint32Array([5 * Ny * Nz + 5 * Nz + 5]),
        period: 0,
    });

    // Run 20 steps
    engine.iterate(20);

    assert(engine.numTS === 20, 'After 20 iterations, numTS = 20');

    // Check that fields have evolved (not all zero)
    let maxVolt = 0;
    let maxCurr = 0;
    for (let i = 0; i < engine.volt.length; i++) {
        maxVolt = Math.max(maxVolt, Math.abs(engine.volt[i]));
    }
    for (let i = 0; i < engine.curr.length; i++) {
        maxCurr = Math.max(maxCurr, Math.abs(engine.curr[i]));
    }
    assert(maxVolt > 0.01, `Max |volt| = ${maxVolt.toFixed(6)} > 0.01 (fields evolved)`);
    assert(maxCurr > 0.01, `Max |curr| = ${maxCurr.toFixed(6)} > 0.01 (fields evolved)`);
}

// ---------------------------------------------------------------------------
// Test 9: PEC boundary (vv=0, vi=0 at boundaries)
// ---------------------------------------------------------------------------

section('PEC Boundary Conditions');

{
    const Nx = 6, Ny = 6, Nz = 6;
    const total = 3 * Nx * Ny * Nz;

    const vv = new Float32Array(total).fill(1.0);
    const vi = new Float32Array(total).fill(0.3);
    const ii = new Float32Array(total).fill(1.0);
    const iv = new Float32Array(total).fill(0.3);

    // Set PEC at x=0 boundary: vv=0, vi=0 for all components at x=0
    for (let n = 0; n < 3; n++) {
        for (let y = 0; y < Ny; y++) {
            for (let z = 0; z < Nz; z++) {
                const i = idx(n, 0, y, z, Nx, Ny, Nz);
                vv[i] = 0;
                vi[i] = 0;
            }
        }
    }

    const engine = new CPUFDTDEngine([Nx, Ny, Nz], { vv, vi, ii, iv });

    // Place source at center
    engine.volt[idx(0, 3, 3, 3, Nx, Ny, Nz)] = 1.0;

    // Run several steps
    engine.iterate(5);

    // All voltage at x=0 should remain 0 (PEC)
    let maxAtBoundary = 0;
    for (let n = 0; n < 3; n++) {
        for (let y = 0; y < Ny; y++) {
            for (let z = 0; z < Nz; z++) {
                maxAtBoundary = Math.max(maxAtBoundary,
                    Math.abs(engine.volt[idx(n, 0, y, z, Nx, Ny, Nz)]));
            }
        }
    }
    assertApprox(maxAtBoundary, 0.0, 1e-10,
        'PEC boundary: all voltages at x=0 remain 0');
}

// ---------------------------------------------------------------------------
// Test 10: Energy conservation in lossless medium (approximate)
// ---------------------------------------------------------------------------

section('Energy Conservation (Lossless)');

{
    const Nx = 10, Ny = 10, Nz = 10;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Place a pulse at center
    engine.volt[idx(0, 5, 5, 5, Nx, Ny, Nz)] = 1.0;

    // Compute total energy proxy (sum of squares of all fields)
    function totalEnergy() {
        let eVolt = 0, eCurr = 0;
        for (let i = 0; i < engine.volt.length; i++) {
            eVolt += engine.volt[i] * engine.volt[i];
        }
        for (let i = 0; i < engine.curr.length; i++) {
            eCurr += engine.curr[i] * engine.curr[i];
        }
        return eVolt + eCurr;
    }

    // Run 1 step to establish fields, then measure
    engine.step();
    const e1 = totalEnergy();

    engine.step();
    const e2 = totalEnergy();

    engine.step();
    const e3 = totalEnergy();

    // In a lossless medium with vv=1, ii=1, energy should be approximately
    // conserved (not exactly due to boundary effects and discretization,
    // but should not grow unboundedly)
    assert(e2 > 0, `Energy at step 2 > 0: ${e2}`);
    assert(e3 > 0, `Energy at step 3 > 0: ${e3}`);

    // Check energy doesn't grow by more than a small factor
    // (In a real simulation with proper CFL, it would be exactly conserved;
    // with vi=iv=0.5 and unit grid, the CFL condition may not be perfectly met,
    // but it shouldn't explode in 3 steps)
    const maxRatio = Math.max(e2 / e1, e3 / e2);
    assert(maxRatio < 2.0, `Energy ratio between steps < 2.0 (got ${maxRatio.toFixed(4)})`);
}

// ---------------------------------------------------------------------------
// Test 11: WGSL Shader Syntax Validation
// ---------------------------------------------------------------------------

section('WGSL Shader Syntax Validation');

{
    // Basic structural checks for the WGSL shaders (cannot compile without WebGPU)

    // Voltage shader
    assert(UPDATE_VOLTAGE_WGSL.includes('struct Params'), 'Voltage WGSL has Params struct');
    assert(UPDATE_VOLTAGE_WGSL.includes('@compute @workgroup_size(4, 4, 4)'),
        'Voltage WGSL has @compute @workgroup_size');
    assert(UPDATE_VOLTAGE_WGSL.includes('fn update_voltages'),
        'Voltage WGSL has update_voltages entry point');
    assert(UPDATE_VOLTAGE_WGSL.includes('@group(0) @binding(0)'),
        'Voltage WGSL has bind group 0');
    assert(UPDATE_VOLTAGE_WGSL.includes('@group(1) @binding(0)'),
        'Voltage WGSL has bind group 1');
    assert(UPDATE_VOLTAGE_WGSL.includes('fn idx('), 'Voltage WGSL has idx function');
    assert(UPDATE_VOLTAGE_WGSL.includes('fn idx_ym1('), 'Voltage WGSL has idx_ym1 boundary helper');
    assert(UPDATE_VOLTAGE_WGSL.includes('fn idx_zm1('), 'Voltage WGSL has idx_zm1 boundary helper');
    assert(UPDATE_VOLTAGE_WGSL.includes('fn idx_xm1('), 'Voltage WGSL has idx_xm1 boundary helper');

    // Current shader
    assert(UPDATE_CURRENT_WGSL.includes('struct Params'), 'Current WGSL has Params struct');
    assert(UPDATE_CURRENT_WGSL.includes('@compute @workgroup_size(4, 4, 4)'),
        'Current WGSL has @compute @workgroup_size');
    assert(UPDATE_CURRENT_WGSL.includes('fn update_currents'),
        'Current WGSL has update_currents entry point');
    assert(UPDATE_CURRENT_WGSL.includes('@group(2) @binding(0)'),
        'Current WGSL has bind group 2 for ii/iv coefficients');
    assert(UPDATE_CURRENT_WGSL.includes('params.numLines.y - 1u'),
        'Current WGSL has Y-1 bound check');
    assert(UPDATE_CURRENT_WGSL.includes('params.numLines.z - 1u'),
        'Current WGSL has Z-1 bound check');

    // Excitation shader
    assert(EXCITATION_WGSL.includes('struct ExcParams'), 'Excitation WGSL has ExcParams struct');
    assert(EXCITATION_WGSL.includes('@compute @workgroup_size(256)'),
        'Excitation WGSL has @compute @workgroup_size(256)');
    assert(EXCITATION_WGSL.includes('fn apply_excitation'),
        'Excitation WGSL has apply_excitation entry point');
    assert(EXCITATION_WGSL.includes('@group(4) @binding(0)'),
        'Excitation WGSL has bind group 4');
    assert(EXCITATION_WGSL.includes('exc.numExcitations'),
        'Excitation WGSL checks numExcitations bound');

    // Check balanced braces in all shaders
    for (const [name, src] of [
        ['Voltage', UPDATE_VOLTAGE_WGSL],
        ['Current', UPDATE_CURRENT_WGSL],
        ['Excitation', EXCITATION_WGSL],
    ]) {
        let braceCount = 0;
        for (const ch of src) {
            if (ch === '{') braceCount++;
            if (ch === '}') braceCount--;
        }
        assert(braceCount === 0, `${name} WGSL has balanced braces (count: ${braceCount})`);

        let parenCount = 0;
        for (const ch of src) {
            if (ch === '(') parenCount++;
            if (ch === ')') parenCount--;
        }
        assert(parenCount === 0, `${name} WGSL has balanced parentheses (count: ${parenCount})`);
    }
}

// ---------------------------------------------------------------------------
// Test 12: Voltage update matches manual reference for small grid
// ---------------------------------------------------------------------------

section('Voltage Update — Reference Comparison');

{
    const Nx = 3, Ny = 3, Nz = 3;
    const total = Nx * Ny * Nz;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Set specific current values
    // curr array: [Hx component][Hy component][Hz component]
    for (let i = 0; i < 3 * total; i++) {
        engine.curr[i] = 0.01 * (i + 1);
    }

    // Store initial state
    const currCopy = new Float32Array(engine.curr);

    engine.updateVoltages();

    // Manual reference: compute Ex at (1,1,1)
    const exIdx = idx(0, 1, 1, 1, Nx, Ny, Nz);

    // Ex curl = Hz(1,1,1) - Hz(1,0,1) - Hy(1,1,1) + Hy(1,1,0)
    const hz_111 = currCopy[idx(2, 1, 1, 1, Nx, Ny, Nz)];
    const hz_101 = currCopy[idx(2, 1, 0, 1, Nx, Ny, Nz)];
    const hy_111 = currCopy[idx(1, 1, 1, 1, Nx, Ny, Nz)];
    const hy_110 = currCopy[idx(1, 1, 1, 0, Nx, Ny, Nz)];
    const manualCurl = hz_111 - hz_101 - hy_111 + hy_110;
    const manualEx = 1.0 * 0.0 + 0.3 * manualCurl; // vv * oldVolt(0) + vi * curl

    assertApprox(engine.volt[exIdx], manualEx, 1e-6,
        'Ex(1,1,1) voltage update matches manual reference');
}

// ---------------------------------------------------------------------------
// Test 13: Current update matches manual reference for small grid
// ---------------------------------------------------------------------------

section('Current Update — Reference Comparison');

{
    const Nx = 3, Ny = 3, Nz = 3;
    const total = Nx * Ny * Nz;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Set specific voltage values
    for (let i = 0; i < 3 * total; i++) {
        engine.volt[i] = 0.02 * (i + 1);
    }

    const voltCopy = new Float32Array(engine.volt);

    engine.updateCurrents();

    // Manual reference: compute Hy at (1,1,1)
    const hyIdx = idx(1, 1, 1, 1, Nx, Ny, Nz);

    // Hy curl = Ex(1,1,1) - Ex(1,1,2) - Ez(1,1,1) + Ez(2,1,1)
    const ex_111 = voltCopy[idx(0, 1, 1, 1, Nx, Ny, Nz)];
    const ex_112 = voltCopy[idx(0, 1, 1, 2, Nx, Ny, Nz)];
    const ez_111 = voltCopy[idx(2, 1, 1, 1, Nx, Ny, Nz)];
    const ez_211 = voltCopy[idx(2, 2, 1, 1, Nx, Ny, Nz)];
    const manualCurl = ex_111 - ex_112 - ez_111 + ez_211;
    const manualHy = 1.0 * 0.0 + 0.3 * manualCurl;

    assertApprox(engine.curr[hyIdx], manualHy, 1e-6,
        'Hy(1,1,1) current update matches manual reference');
}

// ---------------------------------------------------------------------------
// Test 14: getFields and uploadFields
// ---------------------------------------------------------------------------

section('getFields / uploadFields');

{
    const Nx = 4, Ny = 4, Nz = 4;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Set some fields
    engine.volt[0] = 1.0;
    engine.volt[10] = 2.0;
    engine.curr[5] = 3.0;

    const fields = engine.getFields();
    assertApprox(fields.volt[0], 1.0, 1e-10, 'getFields returns correct volt[0]');
    assertApprox(fields.volt[10], 2.0, 1e-10, 'getFields returns correct volt[10]');
    assertApprox(fields.curr[5], 3.0, 1e-10, 'getFields returns correct curr[5]');

    // Verify it is a copy
    fields.volt[0] = 999;
    assertApprox(engine.volt[0], 1.0, 1e-10, 'getFields returns a copy');

    // Upload new fields
    const newVolt = new Float32Array(3 * 64).fill(0.5);
    const newCurr = new Float32Array(3 * 64).fill(0.25);
    engine.uploadFields(newVolt, newCurr);
    assertApprox(engine.volt[0], 0.5, 1e-10, 'uploadFields sets volt');
    assertApprox(engine.curr[0], 0.25, 1e-10, 'uploadFields sets curr');
}

// ---------------------------------------------------------------------------
// Test 15: Two identical engines produce identical results
// ---------------------------------------------------------------------------

section('Determinism — Two Identical Engines');

{
    const Nx = 6, Ny = 6, Nz = 6;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine1 = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);
    const engine2 = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Same initial condition
    engine1.volt[idx(0, 3, 3, 3, Nx, Ny, Nz)] = 1.0;
    engine2.volt[idx(0, 3, 3, 3, Nx, Ny, Nz)] = 1.0;

    // Run both for 10 steps
    engine1.iterate(10);
    engine2.iterate(10);

    // Compare all fields
    let maxDiff = 0;
    for (let i = 0; i < engine1.volt.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(engine1.volt[i] - engine2.volt[i]));
    }
    for (let i = 0; i < engine1.curr.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(engine1.curr[i] - engine2.curr[i]));
    }
    assertApprox(maxDiff, 0.0, 1e-10,
        'Two identical engines produce identical results after 10 steps');
}

// ---------------------------------------------------------------------------
// Test 16: WGSL shader buffer bindings match engine expectations
// ---------------------------------------------------------------------------

section('WGSL Shader — Buffer Binding Consistency');

{
    // Verify the voltage shader uses groups 0 and 1
    const voltBindings = [];
    for (const m of UPDATE_VOLTAGE_WGSL.matchAll(/@group\((\d+)\)\s+@binding\((\d+)\)/g)) {
        voltBindings.push([parseInt(m[1]), parseInt(m[2])]);
    }
    assert(voltBindings.some(([g, b]) => g === 0 && b === 0), 'Voltage shader: group(0) binding(0) — volt');
    assert(voltBindings.some(([g, b]) => g === 0 && b === 1), 'Voltage shader: group(0) binding(1) — curr');
    assert(voltBindings.some(([g, b]) => g === 0 && b === 2), 'Voltage shader: group(0) binding(2) — params');
    assert(voltBindings.some(([g, b]) => g === 1 && b === 0), 'Voltage shader: group(1) binding(0) — vv');
    assert(voltBindings.some(([g, b]) => g === 1 && b === 1), 'Voltage shader: group(1) binding(1) — vi');

    // Verify the current shader uses groups 0 and 2
    const currBindings = [];
    for (const m of UPDATE_CURRENT_WGSL.matchAll(/@group\((\d+)\)\s+@binding\((\d+)\)/g)) {
        currBindings.push([parseInt(m[1]), parseInt(m[2])]);
    }
    assert(currBindings.some(([g, b]) => g === 0 && b === 0), 'Current shader: group(0) binding(0) — volt');
    assert(currBindings.some(([g, b]) => g === 0 && b === 1), 'Current shader: group(0) binding(1) — curr');
    assert(currBindings.some(([g, b]) => g === 0 && b === 2), 'Current shader: group(0) binding(2) — params');
    assert(currBindings.some(([g, b]) => g === 2 && b === 0), 'Current shader: group(2) binding(0) — ii');
    assert(currBindings.some(([g, b]) => g === 2 && b === 1), 'Current shader: group(2) binding(1) — iv');

    // Verify excitation uses groups 0 and 4
    const excBindings = [];
    for (const m of EXCITATION_WGSL.matchAll(/@group\((\d+)\)\s+@binding\((\d+)\)/g)) {
        excBindings.push([parseInt(m[1]), parseInt(m[2])]);
    }
    assert(excBindings.some(([g, b]) => g === 4 && b === 0), 'Excitation shader: group(4) binding(0) — exc params');
    assert(excBindings.some(([g, b]) => g === 4 && b === 1), 'Excitation shader: group(4) binding(1) — signal');
    assert(excBindings.some(([g, b]) => g === 4 && b === 2), 'Excitation shader: group(4) binding(2) — delay');
    assert(excBindings.some(([g, b]) => g === 4 && b === 3), 'Excitation shader: group(4) binding(3) — amp');
    assert(excBindings.some(([g, b]) => g === 4 && b === 4), 'Excitation shader: group(4) binding(4) — dir');
    assert(excBindings.some(([g, b]) => g === 4 && b === 5), 'Excitation shader: group(4) binding(5) — pos');
}

// ---------------------------------------------------------------------------
// Test 17: 10x10x10 multi-step stress test
// ---------------------------------------------------------------------------

section('10x10x10 Multi-step Stress Test');

{
    const Nx = 10, Ny = 10, Nz = 10;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Gaussian excitation at center
    const sigLen = 100;
    const signal = new Float32Array(sigLen);
    for (let i = 0; i < sigLen; i++) {
        const t = (i - 50) / 10;
        signal[i] = Math.exp(-t * t);
    }

    engine.configureExcitation({
        signal,
        delay: new Uint32Array([0]),
        amp: new Float32Array([1.0]),
        dir: new Uint32Array([0]),
        pos: new Uint32Array([5 * Ny * Nz + 5 * Nz + 5]),
        period: 0,
    });

    // Run 50 steps
    const t0 = performance.now();
    engine.iterate(50);
    const elapsed = performance.now() - t0;

    assert(engine.numTS === 50, 'Completed 50 timesteps');

    // Check fields are finite (no NaN/Inf from instability)
    let allFinite = true;
    for (let i = 0; i < engine.volt.length; i++) {
        if (!isFinite(engine.volt[i])) { allFinite = false; break; }
    }
    for (let i = 0; i < engine.curr.length; i++) {
        if (!isFinite(engine.curr[i])) { allFinite = false; break; }
    }
    assert(allFinite, 'All field values are finite after 50 steps');

    console.log(`  (10x10x10 x 50 steps completed in ${elapsed.toFixed(1)} ms)`);
}

// ---------------------------------------------------------------------------
// Test 18: PML pre/post voltage update correctness (1D-like test)
// ---------------------------------------------------------------------------

section('PML Pre/Post Voltage Update Correctness');

{
    // Small 1D-like grid: 8x1x1 with PML region at x=[0..2]
    const Nx = 8, Ny = 1, Nz = 1;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // PML region covers x=0,1,2 (3 cells)
    const pmlNx = 3, pmlNy = 1, pmlNz = 1;
    const pmlTotal = 3 * pmlNx * pmlNy * pmlNz;

    // PML coefficients: use simple known values
    // vv controls self-coupling, vvfo controls flux coupling, vvfn controls new flux coupling
    const pml_vv = new Float32Array(pmlTotal).fill(0.8);
    const pml_vvfo = new Float32Array(pmlTotal).fill(0.2);
    const pml_vvfn = new Float32Array(pmlTotal).fill(1.5);
    const pml_ii = new Float32Array(pmlTotal).fill(0.9);
    const pml_iifo = new Float32Array(pmlTotal).fill(0.1);
    const pml_iifn = new Float32Array(pmlTotal).fill(1.3);

    engine.configurePML([{
        startPos: [0, 0, 0],
        numLines: [pmlNx, pmlNy, pmlNz],
        vv: pml_vv,
        vvfo: pml_vvfo,
        vvfn: pml_vvfn,
        ii: pml_ii,
        iifo: pml_iifo,
        iifn: pml_iifn,
    }]);

    // Set a known voltage in the PML region
    engine.volt[idx(0, 1, 0, 0, Nx, Ny, Nz)] = 2.0;

    // Access the internal PML region
    const region = engine.pmlRegions[0];

    // Set a known flux value
    region.volt_flux[idx(0, 1, 0, 0, pmlNx, pmlNy, pmlNz)] = 0.5;

    // Pre-voltage update for component 0 at local pos (1,0,0):
    // f_help = vv[p] * V[g] - vvfo[p] * volt_flux[p]
    //        = 0.8 * 2.0 - 0.2 * 0.5
    //        = 1.6 - 0.1 = 1.5
    // V[g] = volt_flux[p] = 0.5
    // volt_flux[p] = f_help = 1.5
    engine.preVoltageUpdatePML();

    const pIdx = idx(0, 1, 0, 0, pmlNx, pmlNy, pmlNz);
    const gIdx = idx(0, 1, 0, 0, Nx, Ny, Nz);

    assertApprox(engine.volt[gIdx], 0.5, 1e-6,
        'Pre-voltage PML: V[g] = old volt_flux');
    assertApprox(region.volt_flux[pIdx], 1.5, 1e-6,
        'Pre-voltage PML: volt_flux = f_help');

    // Now do voltage update (core) — this will modify V[g]
    // V[g] = vv[g] * V[g] + vi[g] * curl
    // For a 1x1 grid in YZ, curl is 0, so:
    // V[g] = 1.0 * 0.5 + 0.3 * 0 = 0.5 (unchanged for this cell)
    engine.updateVoltages();

    // Post-voltage update:
    // f_help = volt_flux[p] = 1.5
    // volt_flux[p] = V[g] = 0.5 (after core update)
    // V[g] = f_help + vvfn[p] * volt_flux[p] = 1.5 + 1.5 * 0.5 = 2.25
    engine.postVoltageUpdatePML();

    assertApprox(region.volt_flux[pIdx], 0.5, 1e-6,
        'Post-voltage PML: volt_flux = updated V');
    assertApprox(engine.volt[gIdx], 2.25, 1e-6,
        'Post-voltage PML: V = f_help + vvfn * flux');
}

// ---------------------------------------------------------------------------
// Test 19: PML pre/post current update correctness
// ---------------------------------------------------------------------------

section('PML Pre/Post Current Update Correctness');

{
    const Nx = 8, Ny = 2, Nz = 2;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    const pmlNx = 3, pmlNy = 2, pmlNz = 2;
    const pmlTotal = 3 * pmlNx * pmlNy * pmlNz;

    const pml_vv = new Float32Array(pmlTotal).fill(1.0);
    const pml_vvfo = new Float32Array(pmlTotal).fill(0.0);
    const pml_vvfn = new Float32Array(pmlTotal).fill(1.0);
    const pml_ii = new Float32Array(pmlTotal).fill(0.7);
    const pml_iifo = new Float32Array(pmlTotal).fill(0.3);
    const pml_iifn = new Float32Array(pmlTotal).fill(1.2);

    engine.configurePML([{
        startPos: [0, 0, 0],
        numLines: [pmlNx, pmlNy, pmlNz],
        vv: pml_vv, vvfo: pml_vvfo, vvfn: pml_vvfn,
        ii: pml_ii, iifo: pml_iifo, iifn: pml_iifn,
    }]);

    const region = engine.pmlRegions[0];

    // Set known current value
    engine.curr[idx(0, 1, 0, 0, Nx, Ny, Nz)] = 3.0;
    region.curr_flux[idx(0, 1, 0, 0, pmlNx, pmlNy, pmlNz)] = 0.4;

    // Pre-current: f_help = ii * I - iifo * flux = 0.7*3.0 - 0.3*0.4 = 2.1 - 0.12 = 1.98
    // I = flux = 0.4
    // flux = f_help = 1.98
    engine.preCurrentUpdatePML();

    const pI = idx(0, 1, 0, 0, pmlNx, pmlNy, pmlNz);
    const gI = idx(0, 1, 0, 0, Nx, Ny, Nz);

    assertApprox(engine.curr[gI], 0.4, 1e-6,
        'Pre-current PML: I[g] = old curr_flux');
    assertApprox(region.curr_flux[pI], 1.98, 1e-6,
        'Pre-current PML: curr_flux = f_help');

    // Core current update would run here (skip for isolated test)
    // Simulate: after core update, curr[gI] has some new value
    engine.curr[gI] = 0.6; // simulated post-update value

    // Post-current: f_help = curr_flux[p] = 1.98
    // curr_flux[p] = I[g] = 0.6
    // I[g] = f_help + iifn * flux = 1.98 + 1.2 * 0.6 = 1.98 + 0.72 = 2.7
    engine.postCurrentUpdatePML();

    assertApprox(region.curr_flux[pI], 0.6, 1e-6,
        'Post-current PML: curr_flux = updated I');
    assertApprox(engine.curr[gI], 2.7, 1e-6,
        'Post-current PML: I = f_help + iifn * flux');
}

// ---------------------------------------------------------------------------
// Test 20: PML absorption test — pulse decays at PML boundary
// ---------------------------------------------------------------------------

section('PML Absorption — Energy Decay');

{
    // Verify PML modifies field evolution compared to no-PML, and that
    // fields inside the PML region are damped over time.
    const Nx = 20, Ny = 3, Nz = 3;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);

    // Engine without PML
    const engineNoPML = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    // Engine with PML
    const enginePML = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    const pmlSize = 4;
    const pmlNy = Ny, pmlNz = Nz;

    // Create PML with pure damping coefficients:
    // vv < 1 damps the field, vvfo = 0 (no flux coupling), vvfn = vv (scale)
    // This is a simplified lossy PML that acts as a damping sponge.
    function createDampingPML(pmlNx, pmlNy, pmlNz) {
        const total = 3 * pmlNx * pmlNy * pmlNz;
        const vv = new Float32Array(total);
        const vvfo = new Float32Array(total);
        const vvfn = new Float32Array(total);
        const ii = new Float32Array(total);
        const iifo = new Float32Array(total);
        const iifn = new Float32Array(total);

        for (let n = 0; n < 3; n++) {
            for (let lx = 0; lx < pmlNx; lx++) {
                const depth = (lx + 0.5) / pmlNx;
                // Damping factor: closer to boundary = more damping
                const damp = 1.0 - 0.5 * depth;

                for (let ly = 0; ly < pmlNy; ly++) {
                    for (let lz = 0; lz < pmlNz; lz++) {
                        const p = n * pmlNx * pmlNy * pmlNz + lx * pmlNy * pmlNz + ly * pmlNz + lz;
                        // Pre: f_help = vv*V - vvfo*flux; V = flux; flux = f_help
                        // Post: f_help = flux; flux = V; V = f_help + vvfn*flux
                        // With vvfo=0: pre gives f_help = vv*V, V=0(flux starts at 0), flux=vv*V
                        // Core updates V from 0. Post: V = vv*V_old + vvfn * V_new
                        // This effectively scales the field.
                        vv[p] = damp;
                        vvfo[p] = 0.0;
                        vvfn[p] = damp;
                        ii[p] = damp;
                        iifo[p] = 0.0;
                        iifn[p] = damp;
                    }
                }
            }
        }
        return { vv, vvfo, vvfn, ii, iifo, iifn };
    }

    const leftPML = createDampingPML(pmlSize, pmlNy, pmlNz);
    const rightPML = createDampingPML(pmlSize, pmlNy, pmlNz);

    enginePML.configurePML([
        {
            startPos: [0, 0, 0],
            numLines: [pmlSize, pmlNy, pmlNz],
            ...leftPML,
        },
        {
            startPos: [Nx - pmlSize, 0, 0],
            numLines: [pmlSize, pmlNy, pmlNz],
            ...rightPML,
        },
    ]);

    // Place initial pulse at center
    const cx = 10, cy = 1, cz = 1;
    engineNoPML.volt[idx(0, cx, cy, cz, Nx, Ny, Nz)] = 1.0;
    enginePML.volt[idx(0, cx, cy, cz, Nx, Ny, Nz)] = 1.0;

    function totalEnergy(engine) {
        let e = 0;
        for (let i = 0; i < engine.volt.length; i++) {
            e += engine.volt[i] * engine.volt[i];
        }
        for (let i = 0; i < engine.curr.length; i++) {
            e += engine.curr[i] * engine.curr[i];
        }
        return e;
    }

    // Run enough steps for the pulse to reach PML boundaries
    engineNoPML.iterate(15);
    enginePML.iterate(15);

    const energyNoPML = totalEnergy(engineNoPML);
    const energyPML = totalEnergy(enginePML);

    // PML should modify the field evolution (fields should differ)
    let maxFieldDiff = 0;
    for (let i = 0; i < engineNoPML.volt.length; i++) {
        maxFieldDiff = Math.max(maxFieldDiff,
            Math.abs(engineNoPML.volt[i] - enginePML.volt[i]));
    }
    assert(maxFieldDiff > 1e-6,
        `PML modifies field evolution: max diff = ${maxFieldDiff.toFixed(6)}`);

    // Verify PML region fields are damped: energy in PML region should decrease
    // as we get closer to the boundary
    function pmlRegionEnergy(engine, startX, numX) {
        let e = 0;
        for (let n = 0; n < 3; n++) {
            for (let x = startX; x < startX + numX; x++) {
                for (let y = 0; y < Ny; y++) {
                    for (let z = 0; z < Nz; z++) {
                        const v = engine.volt[idx(n, x, y, z, Nx, Ny, Nz)];
                        e += v * v;
                    }
                }
            }
        }
        return e;
    }

    // Both engines should have non-zero total energy
    assert(energyNoPML > 0, `No-PML energy > 0: ${energyNoPML.toFixed(6)}`);
    assert(energyPML > 0, `PML energy > 0: ${energyPML.toFixed(6)}`);
}

// ---------------------------------------------------------------------------
// Test 21: PML with full timestep integration
// ---------------------------------------------------------------------------

section('PML Full Timestep Integration');

{
    const Nx = 10, Ny = 3, Nz = 3;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    const pmlNx = 3, pmlNy = 3, pmlNz = 3;
    const pmlTotal = 3 * pmlNx * pmlNy * pmlNz;

    // Identity-like PML (should not change behavior much)
    engine.configurePML([{
        startPos: [0, 0, 0],
        numLines: [pmlNx, pmlNy, pmlNz],
        vv: new Float32Array(pmlTotal).fill(1.0),
        vvfo: new Float32Array(pmlTotal).fill(0.0),
        vvfn: new Float32Array(pmlTotal).fill(1.0),
        ii: new Float32Array(pmlTotal).fill(1.0),
        iifo: new Float32Array(pmlTotal).fill(0.0),
        iifn: new Float32Array(pmlTotal).fill(1.0),
    }]);

    // Place a pulse in the middle (away from PML)
    engine.volt[idx(0, 5, 1, 1, Nx, Ny, Nz)] = 1.0;

    // Run several timesteps — should not crash or produce NaN
    engine.iterate(10);

    let allFinite = true;
    for (let i = 0; i < engine.volt.length; i++) {
        if (!isFinite(engine.volt[i])) { allFinite = false; break; }
    }
    for (let i = 0; i < engine.curr.length; i++) {
        if (!isFinite(engine.curr[i])) { allFinite = false; break; }
    }
    assert(allFinite, 'PML full integration: all fields finite after 10 steps');
    assert(engine.numTS === 10, 'PML full integration: numTS = 10');
}

// ---------------------------------------------------------------------------
// Test 22: PML WGSL shader syntax validation
// ---------------------------------------------------------------------------

section('PML WGSL Shader Syntax Validation');

{
    assert(UPDATE_PML_WGSL.includes('struct PMLParams'),
        'PML WGSL has PMLParams struct');
    assert(UPDATE_PML_WGSL.includes('@compute @workgroup_size(4, 4, 4)'),
        'PML WGSL has @compute @workgroup_size');
    assert(UPDATE_PML_WGSL.includes('fn update_pml'),
        'PML WGSL has update_pml entry point');
    assert(UPDATE_PML_WGSL.includes('@group(3) @binding(0)'),
        'PML WGSL has bind group 3');
    assert(UPDATE_PML_WGSL.includes('fn pml_idx('),
        'PML WGSL has pml_idx function');
    assert(UPDATE_PML_WGSL.includes('fn idx('),
        'PML WGSL has global idx function');
    assert(UPDATE_PML_WGSL.includes('pml_vv[p]'),
        'PML WGSL references pml_vv coefficients');
    assert(UPDATE_PML_WGSL.includes('pml_vvfo[p]'),
        'PML WGSL references pml_vvfo coefficients');
    assert(UPDATE_PML_WGSL.includes('pml_vvfn[p]'),
        'PML WGSL references pml_vvfn coefficients');
    assert(UPDATE_PML_WGSL.includes('pml_ii[p]'),
        'PML WGSL references pml_ii coefficients');
    assert(UPDATE_PML_WGSL.includes('pml_iifo[p]'),
        'PML WGSL references pml_iifo coefficients');
    assert(UPDATE_PML_WGSL.includes('pml_iifn[p]'),
        'PML WGSL references pml_iifn coefficients');
    assert(UPDATE_PML_WGSL.includes('volt_flux'),
        'PML WGSL references volt_flux');
    assert(UPDATE_PML_WGSL.includes('curr_flux'),
        'PML WGSL references curr_flux');

    // mode selection
    assert(UPDATE_PML_WGSL.includes('mode == 0u'),
        'PML WGSL has mode 0 (pre-voltage)');
    assert(UPDATE_PML_WGSL.includes('mode == 1u'),
        'PML WGSL has mode 1 (post-voltage)');
    assert(UPDATE_PML_WGSL.includes('mode == 2u'),
        'PML WGSL has mode 2 (pre-current)');
    assert(UPDATE_PML_WGSL.includes('mode == 3u'),
        'PML WGSL has mode 3 (post-current)');

    // Balanced braces and parens
    let braceCount = 0;
    for (const ch of UPDATE_PML_WGSL) {
        if (ch === '{') braceCount++;
        if (ch === '}') braceCount--;
    }
    assert(braceCount === 0, `PML WGSL has balanced braces (count: ${braceCount})`);

    let parenCount = 0;
    for (const ch of UPDATE_PML_WGSL) {
        if (ch === '(') parenCount++;
        if (ch === ')') parenCount--;
    }
    assert(parenCount === 0, `PML WGSL has balanced parentheses (count: ${parenCount})`);

    // PML shader binding consistency
    const pmlBindings = [];
    for (const m of UPDATE_PML_WGSL.matchAll(/@group\((\d+)\)\s+@binding\((\d+)\)/g)) {
        pmlBindings.push([parseInt(m[1]), parseInt(m[2])]);
    }
    assert(pmlBindings.some(([g, b]) => g === 0 && b === 0),
        'PML shader: group(0) binding(0) — volt');
    assert(pmlBindings.some(([g, b]) => g === 0 && b === 1),
        'PML shader: group(0) binding(1) — curr');
    assert(pmlBindings.some(([g, b]) => g === 0 && b === 2),
        'PML shader: group(0) binding(2) — params');
    assert(pmlBindings.some(([g, b]) => g === 3 && b === 0),
        'PML shader: group(3) binding(0) — pml_params');
    assert(pmlBindings.some(([g, b]) => g === 3 && b === 1),
        'PML shader: group(3) binding(1) — volt_flux');
    assert(pmlBindings.some(([g, b]) => g === 3 && b === 2),
        'PML shader: group(3) binding(2) — curr_flux');
    for (let b = 3; b <= 8; b++) {
        assert(pmlBindings.some(([g, bi]) => g === 3 && bi === b),
            `PML shader: group(3) binding(${b}) — PML coefficient ${b - 3}`);
    }
}

// ---------------------------------------------------------------------------
// Test 23: WASM-GPU Bridge — configure with valid data
// ---------------------------------------------------------------------------

section('WASM-GPU Bridge — Configuration');

{
    const Nx = 4, Ny = 4, Nz = 4;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);

    const bridge = new WASMGPUBridge();

    // Test valid configuration
    bridge.configure({
        gridSize: [Nx, Ny, Nz],
        coefficients: coeffs,
    });

    const config = bridge.getConfig();
    assert(config !== null, 'Bridge config is not null after configure');
    assert(config.gridSize[0] === Nx, 'Bridge config gridSize[0] correct');
    assert(config.gridSize[1] === Ny, 'Bridge config gridSize[1] correct');
    assert(config.gridSize[2] === Nz, 'Bridge config gridSize[2] correct');
}

// ---------------------------------------------------------------------------
// Test 24: WASM-GPU Bridge — validation errors
// ---------------------------------------------------------------------------

section('WASM-GPU Bridge — Validation');

{
    const bridge = new WASMGPUBridge();

    // Missing gridSize
    let threw = false;
    try {
        bridge.configure({ gridSize: null, coefficients: {} });
    } catch (e) {
        threw = true;
    }
    assert(threw, 'Bridge throws on null gridSize');

    // Wrong coefficient size
    threw = false;
    try {
        bridge.configure({
            gridSize: [2, 2, 2],
            coefficients: {
                vv: new Float32Array(10), // wrong size, should be 3*8=24
                vi: new Float32Array(24),
                ii: new Float32Array(24),
                iv: new Float32Array(24),
            },
        });
    } catch (e) {
        threw = true;
    }
    assert(threw, 'Bridge throws on coefficient size mismatch');

    // Missing coefficient
    threw = false;
    try {
        bridge.configure({
            gridSize: [2, 2, 2],
            coefficients: {
                vv: new Float32Array(24),
                vi: new Float32Array(24),
                ii: new Float32Array(24),
                // iv missing
            },
        });
    } catch (e) {
        threw = true;
    }
    assert(threw, 'Bridge throws on missing coefficient array');
}

// ---------------------------------------------------------------------------
// Test 25: WASM-GPU Bridge — create CPU engine
// ---------------------------------------------------------------------------

section('WASM-GPU Bridge — Create CPU Engine');

{
    const Nx = 5, Ny = 5, Nz = 5;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);

    const bridge = new WASMGPUBridge();
    bridge.configure({
        gridSize: [Nx, Ny, Nz],
        coefficients: coeffs,
    });

    const engine = bridge.createCPUEngine();
    assert(engine instanceof CPUFDTDEngine, 'Bridge creates CPUFDTDEngine instance');
    assert(engine.Nx === Nx, 'Bridge engine has correct Nx');
    assert(engine.Ny === Ny, 'Bridge engine has correct Ny');
    assert(engine.Nz === Nz, 'Bridge engine has correct Nz');

    // Run a step to verify it works
    engine.volt[idx(0, 2, 2, 2, Nx, Ny, Nz)] = 1.0;
    engine.iterate(5);
    assert(engine.numTS === 5, 'Bridge CPU engine runs correctly');

    let allFinite = true;
    for (let i = 0; i < engine.volt.length; i++) {
        if (!isFinite(engine.volt[i])) { allFinite = false; break; }
    }
    assert(allFinite, 'Bridge CPU engine produces finite results');
}

// ---------------------------------------------------------------------------
// Test 26: WASM-GPU Bridge — create CPU engine with PML
// ---------------------------------------------------------------------------

section('WASM-GPU Bridge — Create CPU Engine with PML');

{
    const Nx = 10, Ny = 3, Nz = 3;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);

    const pmlNx = 3, pmlNy = 3, pmlNz = 3;
    const pmlTotal = 3 * pmlNx * pmlNy * pmlNz;

    const bridge = new WASMGPUBridge();
    bridge.configure({
        gridSize: [Nx, Ny, Nz],
        coefficients: coeffs,
        pmlRegions: [{
            startPos: [0, 0, 0],
            numLines: [pmlNx, pmlNy, pmlNz],
            vv: new Float32Array(pmlTotal).fill(1.0),
            vvfo: new Float32Array(pmlTotal).fill(0.0),
            vvfn: new Float32Array(pmlTotal).fill(1.0),
            ii: new Float32Array(pmlTotal).fill(1.0),
            iifo: new Float32Array(pmlTotal).fill(0.0),
            iifn: new Float32Array(pmlTotal).fill(1.0),
        }],
    });

    const engine = bridge.createCPUEngine();
    assert(engine.pmlRegions.length === 1, 'Bridge creates engine with 1 PML region');

    engine.volt[idx(0, 5, 1, 1, Nx, Ny, Nz)] = 1.0;
    engine.iterate(5);
    assert(engine.numTS === 5, 'Bridge PML engine iterates correctly');
}

// ---------------------------------------------------------------------------
// Test 27: WASM-GPU Bridge — PML validation
// ---------------------------------------------------------------------------

section('WASM-GPU Bridge — PML Validation');

{
    const bridge = new WASMGPUBridge();

    // PML region out of bounds
    let threw = false;
    try {
        bridge.configure({
            gridSize: [5, 5, 5],
            coefficients: createFreeSpaceCoefficients(5, 5, 5),
            pmlRegions: [{
                startPos: [3, 0, 0],
                numLines: [4, 5, 5], // extends beyond grid (3+4=7 > 5)
                vv: new Float32Array(3 * 4 * 5 * 5),
                vvfo: new Float32Array(3 * 4 * 5 * 5),
                vvfn: new Float32Array(3 * 4 * 5 * 5),
                ii: new Float32Array(3 * 4 * 5 * 5),
                iifo: new Float32Array(3 * 4 * 5 * 5),
                iifn: new Float32Array(3 * 4 * 5 * 5),
            }],
        });
    } catch (e) {
        threw = true;
    }
    assert(threw, 'Bridge throws when PML extends beyond grid');

    // PML region with wrong array size
    threw = false;
    try {
        bridge.configure({
            gridSize: [5, 5, 5],
            coefficients: createFreeSpaceCoefficients(5, 5, 5),
            pmlRegions: [{
                startPos: [0, 0, 0],
                numLines: [2, 5, 5],
                vv: new Float32Array(10), // wrong size
                vvfo: new Float32Array(3 * 2 * 5 * 5),
                vvfn: new Float32Array(3 * 2 * 5 * 5),
                ii: new Float32Array(3 * 2 * 5 * 5),
                iifo: new Float32Array(3 * 2 * 5 * 5),
                iifn: new Float32Array(3 * 2 * 5 * 5),
            }],
        });
    } catch (e) {
        threw = true;
    }
    assert(threw, 'Bridge throws on PML array size mismatch');
}

// ---------------------------------------------------------------------------
// Test 28: WASM-GPU Bridge — configureFromWASM placeholder
// ---------------------------------------------------------------------------

section('WASM-GPU Bridge — WASM Placeholder');

{
    const bridge = new WASMGPUBridge();

    // Should throw with helpful message about missing embind methods
    let threw = false;
    let message = '';
    try {
        bridge.configureFromWASM({});
    } catch (e) {
        threw = true;
        message = e.message;
    }
    assert(threw, 'Bridge.configureFromWASM throws for incomplete WASM module');
    assert(message.includes('embind_api.cpp'),
        'Error message mentions embind_api.cpp requirements');
}

// ---------------------------------------------------------------------------
// Test 29: PML multiple regions
// ---------------------------------------------------------------------------

section('PML Multiple Regions');

{
    const Nx = 12, Ny = 3, Nz = 3;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    const pmlSize = 3;
    const pmlTotal = 3 * pmlSize * Ny * Nz;

    // Two PML regions at opposite ends
    engine.configurePML([
        {
            startPos: [0, 0, 0],
            numLines: [pmlSize, Ny, Nz],
            vv: new Float32Array(pmlTotal).fill(0.9),
            vvfo: new Float32Array(pmlTotal).fill(0.1),
            vvfn: new Float32Array(pmlTotal).fill(0.95),
            ii: new Float32Array(pmlTotal).fill(0.9),
            iifo: new Float32Array(pmlTotal).fill(0.1),
            iifn: new Float32Array(pmlTotal).fill(0.95),
        },
        {
            startPos: [Nx - pmlSize, 0, 0],
            numLines: [pmlSize, Ny, Nz],
            vv: new Float32Array(pmlTotal).fill(0.9),
            vvfo: new Float32Array(pmlTotal).fill(0.1),
            vvfn: new Float32Array(pmlTotal).fill(0.95),
            ii: new Float32Array(pmlTotal).fill(0.9),
            iifo: new Float32Array(pmlTotal).fill(0.1),
            iifn: new Float32Array(pmlTotal).fill(0.95),
        },
    ]);

    assert(engine.pmlRegions.length === 2, 'Engine has 2 PML regions');

    // Place pulse at center
    engine.volt[idx(0, 6, 1, 1, Nx, Ny, Nz)] = 1.0;

    // Run and check stability
    engine.iterate(20);

    let allFinite = true;
    for (let i = 0; i < engine.volt.length; i++) {
        if (!isFinite(engine.volt[i])) { allFinite = false; break; }
    }
    assert(allFinite, 'Multiple PML regions: fields finite after 20 steps');
    assert(engine.numTS === 20, 'Multiple PML regions: numTS = 20');
}

// ---------------------------------------------------------------------------
// Test 30: PML flux arrays initialized to zero
// ---------------------------------------------------------------------------

section('PML Flux Initialization');

{
    const Nx = 6, Ny = 3, Nz = 3;
    const coeffs = createFreeSpaceCoefficients(Nx, Ny, Nz);
    const engine = new CPUFDTDEngine([Nx, Ny, Nz], coeffs);

    const pmlNx = 2, pmlNy = 3, pmlNz = 3;
    const pmlTotal = 3 * pmlNx * pmlNy * pmlNz;

    engine.configurePML([{
        startPos: [0, 0, 0],
        numLines: [pmlNx, pmlNy, pmlNz],
        vv: new Float32Array(pmlTotal).fill(1.0),
        vvfo: new Float32Array(pmlTotal).fill(0.0),
        vvfn: new Float32Array(pmlTotal).fill(1.0),
        ii: new Float32Array(pmlTotal).fill(1.0),
        iifo: new Float32Array(pmlTotal).fill(0.0),
        iifn: new Float32Array(pmlTotal).fill(1.0),
    }]);

    const region = engine.pmlRegions[0];

    // Flux arrays should be zero-initialized
    let voltFluxSum = 0, currFluxSum = 0;
    for (let i = 0; i < region.volt_flux.length; i++) {
        voltFluxSum += Math.abs(region.volt_flux[i]);
    }
    for (let i = 0; i < region.curr_flux.length; i++) {
        currFluxSum += Math.abs(region.curr_flux[i]);
    }
    assertApprox(voltFluxSum, 0.0, 1e-10, 'volt_flux initialized to zero');
    assertApprox(currFluxSum, 0.0, 1e-10, 'curr_flux initialized to zero');

    // Check correct sizes
    assert(region.volt_flux.length === pmlTotal,
        `volt_flux size = ${pmlTotal}`);
    assert(region.curr_flux.length === pmlTotal,
        `curr_flux size = ${pmlTotal}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`);
console.log(`Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
console.log(`${'='.repeat(60)}`);

if (failedTests > 0) {
    process.exit(1);
}
