/**
 * Playwright end-to-end test for the antenna-prop web app.
 *
 * Loads the app, selects the Patch Antenna example, runs the simulation,
 * and verifies that all result tabs (S-Parameters, Impedance, Radiation,
 * Raw Data) contain meaningful output.
 *
 * Usage: node tests/test_app_browser.mjs
 */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  PASS: ${msg}`); passed++; }
  else { console.error(`  FAIL: ${msg}`); failed++; }
}

// --- Static file server with COOP/COEP headers ---
const server = http.createServer((req, res) => {
  const fpath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  const ext = path.extname(fpath);
  const types = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.mjs': 'application/javascript', '.wasm': 'application/wasm',
    '.wgsl': 'text/plain', '.json': 'application/json',
  };
  try {
    const data = fs.readFileSync(fpath);
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found: ' + req.url);
  }
});

await new Promise(r => server.listen(0, r));
const port = server.address().port;
console.log(`Server: http://localhost:${port}`);

// --- Launch browser ---
const browser = await chromium.launch({
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
  ],
});
const page = await (await browser.newContext()).newPage();

const consoleLogs = [];
page.on('console', msg => consoleLogs.push(msg.text()));
page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

try {
  console.log('\n=== 1. Load App ===');
  await page.goto(`http://localhost:${port}/app/index.html`);
  await page.waitForSelector('#editor-textarea', { timeout: 10000 });
  assert(true, 'App loaded');
  assert(await page.isVisible('#btn-run'), 'Run button visible');
  assert(await page.isVisible('#example-select'), 'Example selector visible');

  console.log('\n=== 2. Load Patch Antenna Example ===');
  await page.selectOption('#example-select', 'patch');
  await page.click('#btn-load-example');
  const editorValue = await page.$eval('#editor-textarea', el => el.value);
  assert(editorValue.includes('<openEMS>'), 'Editor has XML content');
  assert(editorValue.includes('patch') || editorValue.includes('Patch'), 'Editor has patch antenna config');
  assert(editorValue.length > 500, `Editor XML has ${editorValue.length} chars`);

  console.log('\n=== 3. Run Simulation (WebGPU) ===');
  // Use WebGPU if available, fallback to sse-compressed
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (hasWebGPU) {
    await page.selectOption('#engine-select', 'webgpu');
    console.log('  Engine: WebGPU');
  } else {
    await page.selectOption('#engine-select', '2');
    console.log('  Engine: sse-compressed (WebGPU not available)');
  }
  await page.click('#btn-run');

  // Wait for simulation to complete (check console for "Done" or S-param plot)
  console.log('  Waiting for simulation to complete...');
  await page.waitForFunction(() => {
    const console = document.getElementById('sim-console')?.textContent || '';
    return console.includes('Done') || console.includes('ERROR') || console.includes('complete');
  }, null, { timeout: 300000 });

  const simConsole = await page.textContent('#sim-console');
  const hasError = simConsole.includes('ERROR') || simConsole.includes('failed');
  assert(!hasError, 'Simulation completed without errors');

  const statusText = await page.textContent('#status-text');
  console.log(`  Status: ${statusText}`);

  console.log('\n=== 4. Check S-Parameters Tab ===');
  await page.click('[data-tab="tab-sparam"]');
  await page.waitForTimeout(500);
  const sparamContent = await page.$eval('#plot-sparam', el => el.innerHTML);
  assert(sparamContent.includes('<svg') || sparamContent.includes('svg'), 'S-Parameters tab has SVG plot');
  assert(!sparamContent.includes('Run a simulation to see results'), 'S-Parameters tab has actual data (not placeholder)');

  // Check SVG has path elements (plot traces)
  const sparamPaths = await page.$$eval('#plot-sparam svg path', els => els.length);
  assert(sparamPaths > 0, `S-Parameters plot has ${sparamPaths} trace(s)`);

  console.log('\n=== 5. Check Impedance Tab ===');
  await page.click('[data-tab="tab-impedance"]');
  await page.waitForTimeout(500);
  const impedanceContent = await page.$eval('#plot-impedance', el => el.innerHTML);
  assert(impedanceContent.includes('<svg') || impedanceContent.includes('svg'), 'Impedance tab has SVG plot');
  assert(!impedanceContent.includes('Run a simulation to see results'), 'Impedance tab has actual data');

  const impedancePaths = await page.$$eval('#plot-impedance svg path', els => els.length);
  assert(impedancePaths > 0, `Impedance plot has ${impedancePaths} trace(s)`);

  console.log('\n=== 6. Check Radiation Tab ===');
  await page.click('[data-tab="tab-radiation"]');
  await page.waitForTimeout(500);
  const radiationContent = await page.$eval('#plot-radiation', el => el.innerHTML);
  // Radiation tab may or may not have data depending on NF2FF availability
  const hasRadiationData = radiationContent.includes('<svg') || radiationContent.includes('Dmax');
  const hasRadiationPlaceholder = radiationContent.includes('NF2FF data required');
  assert(hasRadiationData || hasRadiationPlaceholder,
    hasRadiationData ? 'Radiation tab has data' : 'Radiation tab shows placeholder (NF2FF not configured in XML example)');

  console.log('\n=== 7. Check Raw Data Tab ===');
  await page.click('[data-tab="tab-raw"]');
  await page.waitForTimeout(500);
  const rawContent = await page.textContent('#raw-data');
  assert(rawContent.length > 20, `Raw data tab has content (${rawContent.length} chars)`);
  assert(!rawContent.includes('No data yet'), 'Raw data tab has actual data');
  // Should contain probe file listings or probe data
  assert(rawContent.includes('port') || rawContent.includes('probe') || rawContent.includes('time') || rawContent.includes('0.'),
    'Raw data contains probe/time-series data');

  console.log('\n=== 8. Verify Console Output ===');
  const consoleText = await page.textContent('#sim-console');
  // The console may clear on run; check it has meaningful FDTD output instead
  assert(consoleText.length > 50, `Console has output (${consoleText.length} chars)`);
  assert(consoleText.includes('FDTD') || consoleText.includes('openEMS') || consoleText.includes('timestep'),
    'Console shows FDTD engine output');

} catch (e) {
  console.error(`\nFATAL: ${e.message}`);
  failed++;
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${'='.repeat(50)}`);
console.log(`App Browser Test: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
