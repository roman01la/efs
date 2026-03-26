/**
 * Validate that test suite counts match STATUS.md claims.
 * Run after `npm test` to verify reproducibility.
 *
 * Usage: npm run test:count
 * (expects npm test output piped or run beforehand)
 */

import { execSync } from 'node:child_process';

const suites = [
  { name: 'test:wasm', cmd: 'node tests/test_wasm.mjs', expectedMin: 101 },
  { name: 'test:api', cmd: 'node tests/test_api.mjs', expectedMin: 326 },
  { name: 'test:gpu', cmd: 'node tests/test_webgpu.mjs', expectedMin: 288 },
];

let allOk = true;

for (const suite of suites) {
  try {
    const output = execSync(suite.cmd, {
      encoding: 'utf-8',
      timeout: 120000,
      cwd: new URL('..', import.meta.url).pathname,
    });

    // Extract test count from summary line
    const passMatch = output.match(/(\d+)\s*passed/i)
      || output.match(/Passed:\s*(\d+)/i);
    const totalMatch = output.match(/Total:\s*(\d+)/i)
      || output.match(/Results:\s*(\d+)\s*passed/i);
    const failMatch = output.match(/(\d+)\s*failed/i)
      || output.match(/Failed:\s*(\d+)/i);

    const passed = passMatch ? parseInt(passMatch[1]) : 0;
    const failed = failMatch ? parseInt(failMatch[1]) : 0;
    const total = totalMatch ? parseInt(totalMatch[1]) : passed + failed;

    if (failed > 0) {
      console.error(`FAIL: ${suite.name} has ${failed} test failures`);
      allOk = false;
    } else if (passed < suite.expectedMin) {
      console.error(`FAIL: ${suite.name} ran ${passed} tests, expected >= ${suite.expectedMin}`);
      allOk = false;
    } else {
      console.log(`OK:   ${suite.name} — ${passed} tests passed (expected >= ${suite.expectedMin})`);
    }
  } catch (e) {
    console.error(`FAIL: ${suite.name} — execution error: ${e.message}`);
    allOk = false;
  }
}

if (!allOk) {
  console.error('\nTest count validation FAILED');
  process.exit(1);
} else {
  console.log('\nTest count validation PASSED');
}
