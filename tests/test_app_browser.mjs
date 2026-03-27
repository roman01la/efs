/**
 * Playwright end-to-end tests for the antenna-prop UX shell (app/index.html).
 *
 * Tests all interactive features: layout, examples, XML validation, engine
 * selection, simulation run, result plots, tab switching, URL sharing, and
 * console output.
 *
 * Usage: node tests/test_app_browser.mjs
 *
 * Requires: npx playwright install chromium (one-time)
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wgsl': 'text/plain',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css': 'text/css',
  '.h5': 'application/octet-stream',
};

function startServer(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      let filePath = join(ROOT, url.pathname === '/' ? '/app/index.html' : url.pathname);

      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const ext = extname(filePath);
      const mime = MIME_TYPES[ext] || 'application/octet-stream';

      const headers = {
        'Content-Type': mime,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      };

      try {
        const content = readFileSync(filePath);
        res.writeHead(200, headers);
        res.end(content);
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
    });

    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---- Test framework ----
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}

async function main() {
  const port = 9877;
  const server = await startServer(port);
  const BASE = `http://127.0.0.1:${port}`;
  console.log(`App test server running on ${BASE}`);

  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch (e) {
    console.log('Installing Playwright chromium...');
    const { execSync } = await import('node:child_process');
    execSync('npx playwright install chromium', { stdio: 'inherit' });
    const pw = await import('playwright');
    chromium = pw.chromium;
  }

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      // Hardware-accelerated GPU & WebGPU
      '--enable-gpu',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer',
      '--use-angle=metal',
      '--use-gl=angle',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      '--enable-dawn-features=allow_unsafe_apis',
      '--no-sandbox',
      // Ensure hardware compositing in headless
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
    ],
  });

  const context = await browser.newContext();
  // Grant clipboard permissions for Share tests
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  try {
    // ================================================================
    // 1. Layout and initial state
    // ================================================================
    console.log('\n=== Test: Layout and Initial State ===');
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      // 3 panels present
      assert(await page.$('#panel-editor') !== null, 'Editor panel exists');
      assert(await page.$('#panel-sim') !== null, 'Simulation panel exists');
      assert(await page.$('#panel-results') !== null, 'Results panel exists');

      // Header
      const title = await page.textContent('header h1');
      assert(title === 'antenna-prop', 'Header title is antenna-prop');

      // Editor textarea is empty
      const editorValue = await page.$eval('#editor-textarea', el => el.value);
      assert(editorValue === '', 'Editor is initially empty');

      // Status shows Idle
      const status = await page.textContent('#status-text');
      assert(status === 'Idle', 'Initial status is Idle');

      // 4 result tabs present
      const tabs = await page.$$('.tab-btn');
      assert(tabs.length === 4, 'Four result tabs present');

      // S-Parameters tab is active by default
      const activeTab = await page.$eval('.tab-btn.active', el => el.dataset.tab);
      assert(activeTab === 'tab-sparam', 'S-Parameters tab active by default');

      // Engine selector has options
      const engineOpts = await page.$$eval('#engine-select option', opts => opts.map(o => o.value));
      assert(engineOpts.includes('2'), 'Engine selector has sse-compressed option');

      // Run button enabled, Stop button disabled
      const runDisabled = await page.$eval('#btn-run', el => el.disabled);
      const stopDisabled = await page.$eval('#btn-stop', el => el.disabled);
      assert(!runDisabled, 'Run button is enabled');
      assert(stopDisabled, 'Stop button is disabled');

      await page.close();
    }

    // ================================================================
    // 2. Example loading
    // ================================================================
    console.log('\n=== Test: Example Loading ===');
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      // Select and load Patch Antenna
      await page.selectOption('#example-select', 'patch');
      await page.click('#btn-load-example');
      const editorValue = await page.$eval('#editor-textarea', el => el.value);
      assert(editorValue.includes('<openEMS>'), 'Patch antenna XML loaded into editor');
      assert(editorValue.includes('ground') || editorValue.includes('patch') || editorValue.includes('PML'), 'Editor contains Patch antenna config');

      // Console should log the load
      const consoleText = await page.textContent('#sim-console');
      assert(consoleText.includes('Loaded example'), 'Console shows example loaded');

      // Load MSL example
      await page.selectOption('#example-select', 'msl');
      await page.click('#btn-load-example');
      const mslValue = await page.$eval('#editor-textarea', el => el.value);
      assert(mslValue.includes('MSL') || mslValue.includes('stub') || mslValue.includes('Notch') || mslValue.includes('<openEMS>'), 'MSL example loads');

      // Load Waveguide example
      await page.selectOption('#example-select', 'waveguide');
      await page.click('#btn-load-example');
      const wgValue = await page.$eval('#editor-textarea', el => el.value);
      assert(wgValue.includes('<openEMS>'), 'Waveguide example loads');

      await page.close();
    }

    // ================================================================
    // 3. XML validation
    // ================================================================
    console.log('\n=== Test: XML Validation ===');
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      // Type invalid XML
      await page.fill('#editor-textarea', '<broken><xml');
      await page.waitForTimeout(100);
      const errorVisible = await page.$eval('#editor-error', el => el.classList.contains('visible'));
      assert(errorVisible, 'Error shown for invalid XML');

      // Type valid XML
      await page.fill('#editor-textarea', '<openEMS><FDTD/></openEMS>');
      await page.waitForTimeout(100);
      const errorHidden = await page.$eval('#editor-error', el => !el.classList.contains('visible'));
      assert(errorHidden, 'Error hidden for valid XML');

      // Clear editor
      await page.fill('#editor-textarea', '');
      await page.waitForTimeout(100);
      const errorGone = await page.$eval('#editor-error', el => !el.classList.contains('visible'));
      assert(errorGone, 'Error hidden when editor is empty');

      await page.close();
    }

    // ================================================================
    // 4. Tab switching
    // ================================================================
    console.log('\n=== Test: Tab Switching ===');
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      // Click Impedance tab
      await page.click('.tab-btn[data-tab="tab-impedance"]');
      let activeTab = await page.$eval('.tab-btn.active', el => el.dataset.tab);
      let visibleContent = await page.$eval('#tab-impedance', el => el.classList.contains('active'));
      assert(activeTab === 'tab-impedance', 'Impedance tab becomes active');
      assert(visibleContent, 'Impedance content is visible');

      // Click Radiation tab
      await page.click('.tab-btn[data-tab="tab-radiation"]');
      activeTab = await page.$eval('.tab-btn.active', el => el.dataset.tab);
      assert(activeTab === 'tab-radiation', 'Radiation tab becomes active');

      // Click Raw Data tab
      await page.click('.tab-btn[data-tab="tab-raw"]');
      activeTab = await page.$eval('.tab-btn.active', el => el.dataset.tab);
      assert(activeTab === 'tab-raw', 'Raw Data tab becomes active');

      // Click back to S-Parameters
      await page.click('.tab-btn[data-tab="tab-sparam"]');
      activeTab = await page.$eval('.tab-btn.active', el => el.dataset.tab);
      assert(activeTab === 'tab-sparam', 'S-Parameters tab re-activated');

      // Only one tab content visible at a time
      const activeContents = await page.$$('.tab-content.active');
      assert(activeContents.length === 1, 'Only one tab content visible at a time');

      await page.close();
    }

    // ================================================================
    // 5. Empty editor run attempt
    // ================================================================
    console.log('\n=== Test: Empty Editor Run ===');
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      await page.click('#btn-run');
      await page.waitForTimeout(200);
      const consoleText = await page.textContent('#sim-console');
      assert(consoleText.includes('empty'), 'Console shows error for empty editor');

      // Status should still be Idle (run didn't start)
      const status = await page.textContent('#status-text');
      assert(status === 'Idle', 'Status stays Idle on empty editor');

      await page.close();
    }

    // ================================================================
    // 6. Stop button
    // ================================================================
    console.log('\n=== Test: Stop Button ===');
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      // Stop is disabled initially
      const disabled = await page.$eval('#btn-stop', el => el.disabled);
      assert(disabled, 'Stop button disabled initially');

      await page.close();
    }

    // ================================================================
    // 7. Run simulation (WASM sse-compressed) — full pipeline
    // ================================================================
    console.log('\n=== Test: Run Simulation (WASM) ===');
    {
      const page = await context.newPage();
      page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
      });
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      // Load waveguide example (fastest of the three)
      await page.selectOption('#example-select', 'waveguide');
      await page.click('#btn-load-example');

      // Select sse-compressed engine
      await page.selectOption('#engine-select', '2');

      // Click Run
      await page.click('#btn-run');

      // Wait for simulation to complete (up to 180s)
      await page.waitForFunction(
        () => {
          const s = document.getElementById('status-text').textContent;
          return s === 'Done' || s === 'Error';
        },
        { timeout: 180000 },
      );

      // Status checks
      const status = await page.textContent('#status-text');
      assert(status === 'Done', 'Status shows Done after simulation');

      const ts = await page.textContent('#status-ts');
      assert(parseInt(ts) > 0, `Timestep count > 0 (got ${ts})`);

      const elapsed = await page.textContent('#status-elapsed');
      assert(elapsed.includes('s'), 'Elapsed time displayed');

      // Console log checks
      const consoleText = await page.textContent('#sim-console');
      assert(consoleText.includes('WASM module loaded'), 'Console: WASM loaded');
      assert(consoleText.includes('Loading XML config'), 'Console: loading XML');
      assert(consoleText.includes('Setting up FDTD'), 'Console: setting up FDTD');
      assert(consoleText.includes('Simulation complete'), 'Console: simulation complete');
      assert(consoleText.includes('S-parameter plot updated'), 'Console: S-param plot');

      // S-parameter SVG plot rendered
      const sparamSvg = await page.$('#plot-sparam svg');
      assert(sparamSvg !== null, 'S-parameter SVG plot rendered');

      // Check SVG has data path (not just axes)
      const sparamPaths = await page.$$eval('#plot-sparam svg path', paths => paths.length);
      assert(sparamPaths >= 1, `S-param plot has ${sparamPaths} data paths`);

      // Check S-param plot title
      const sparamTitle = await page.$eval('#plot-sparam svg', svg => svg.innerHTML);
      assert(sparamTitle.includes('S11'), 'S-param plot title contains S11');

      // Impedance SVG plot rendered (via setTimeout, may need brief wait)
      await page.waitForTimeout(200);
      const impedanceSvg = await page.$('#plot-impedance svg');
      assert(impedanceSvg !== null, 'Impedance SVG plot rendered');

      // Impedance plot has 2 traces (Re(Z) and Im(Z))
      const impedancePaths = await page.$$eval('#plot-impedance svg path', paths => paths.length);
      assert(impedancePaths >= 2, `Impedance plot has ${impedancePaths} data paths (expect >= 2)`);

      // Check impedance plot has legend
      const impedanceSvgHtml = await page.$eval('#plot-impedance svg', svg => svg.innerHTML);
      assert(impedanceSvgHtml.includes('Re(Z)'), 'Impedance plot has Re(Z) legend');
      assert(impedanceSvgHtml.includes('Im(Z)'), 'Impedance plot has Im(Z) legend');

      // Raw Data tab has content
      await page.click('.tab-btn[data-tab="tab-raw"]');
      const rawData = await page.textContent('#raw-data');
      assert(rawData.includes('port_ut'), 'Raw data shows voltage probe');
      assert(rawData.includes('port_it'), 'Raw data shows current probe');

      // Run button re-enabled after completion
      const runDisabled = await page.$eval('#btn-run', el => el.disabled);
      assert(!runDisabled, 'Run button re-enabled after completion');

      // Stop button disabled after completion
      const stopDisabled = await page.$eval('#btn-stop', el => el.disabled);
      assert(stopDisabled, 'Stop button disabled after completion');

      await page.close();
    }

    // ================================================================
    // 8. URL sharing round-trip
    // ================================================================
    console.log('\n=== Test: URL Sharing ===');
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      // Type a small XML config
      const testXml = '<openEMS><FDTD NumberOfTimesteps="10"/></openEMS>';
      await page.fill('#editor-textarea', testXml);

      // Click share
      await page.click('#btn-share');
      await page.waitForTimeout(500);

      // Console should confirm share
      const consoleText = await page.textContent('#sim-console');
      assert(consoleText.includes('Shareable URL copied'), 'Share URL copied to clipboard');

      // Read the clipboard URL
      const clipboardUrl = await page.evaluate(() => navigator.clipboard.readText());
      assert(clipboardUrl.includes('#config='), 'Clipboard URL contains config fragment');

      // Navigate to the shared URL in a new page
      const page2 = await context.newPage();
      // Extract the hash fragment from the full URL
      const hashIdx = clipboardUrl.indexOf('#');
      const hashFragment = hashIdx >= 0 ? clipboardUrl.slice(hashIdx) : '';
      await page2.goto(`${BASE}/app/index.html${hashFragment}`, { waitUntil: 'domcontentloaded' });
      await page2.waitForTimeout(500);

      // Editor should be populated with the shared config
      const restoredXml = await page2.$eval('#editor-textarea', el => el.value);
      assert(restoredXml.includes('<openEMS>'), 'Shared config restored in new page');
      assert(restoredXml.includes('NumberOfTimesteps'), 'Shared config contains original attributes');

      // Console should mention URL load
      const console2 = await page2.textContent('#sim-console');
      assert(console2.includes('Config loaded from URL'), 'Console confirms URL config load');

      await page2.close();
      await page.close();
    }

    // ================================================================
    // 9. URL sharing with tab state
    // ================================================================
    console.log('\n=== Test: URL Tab State Persistence ===');
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      // Switch to Impedance tab
      await page.click('.tab-btn[data-tab="tab-impedance"]');
      await page.fill('#editor-textarea', '<openEMS/>');
      await page.click('#btn-share');
      await page.waitForTimeout(500);

      const clipboardUrl = await page.evaluate(() => navigator.clipboard.readText());
      assert(clipboardUrl.includes('tab=tab-impedance'), 'Share URL encodes active tab');

      // Navigate to URL with tab param
      const page2 = await context.newPage();
      const hashIdx = clipboardUrl.indexOf('#');
      const hashFragment = hashIdx >= 0 ? clipboardUrl.slice(hashIdx) : '';
      await page2.goto(`${BASE}/app/index.html${hashFragment}`, { waitUntil: 'domcontentloaded' });
      await page2.waitForTimeout(500);

      const activeTab = await page2.$eval('.tab-btn.active', el => el.dataset.tab);
      assert(activeTab === 'tab-impedance', 'Tab state restored from URL');

      await page2.close();
      await page.close();
    }

    // ================================================================
    // 10. Engine selector auto-detection
    // ================================================================
    console.log('\n=== Test: Engine Selector ===');
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      const selectedEngine = await page.$eval('#engine-select', el => el.value);
      const hasWebGPU = await page.evaluate(() => !!navigator.gpu);

      if (hasWebGPU) {
        assert(selectedEngine === 'webgpu', 'WebGPU selected when available');
      } else {
        assert(selectedEngine === '2', 'sse-compressed selected when no WebGPU');
        const options = await page.$$eval('#engine-select option', opts => opts.map(o => o.value));
        assert(!options.includes('webgpu'), 'WebGPU option removed when not available');
      }

      await page.close();
    }

    // ================================================================
    // 11. Simulation with patch antenna (NF2FF radiation pattern)
    // ================================================================
    console.log('\n=== Test: Patch Antenna with NF2FF ===');
    {
      const page = await context.newPage();
      page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`);
      });
      page.setDefaultTimeout(300000);
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      await page.selectOption('#example-select', 'patch');
      await page.click('#btn-load-example');
      await page.selectOption('#engine-select', '2');
      await page.click('#btn-run');

      await page.waitForFunction(
        () => {
          const s = document.getElementById('status-text').textContent;
          return s === 'Done' || s === 'Error';
        },
        { timeout: 300000 },
      );

      const status = await page.textContent('#status-text');
      assert(status === 'Done', 'Patch antenna simulation completes');

      const consoleText = await page.textContent('#sim-console');
      assert(consoleText.includes('S-parameter plot updated'), 'Patch S-param plot rendered');

      // Patch antenna XML example has no NF2FF dump boxes — verify no NF2FF crash
      // (NF2FF only activates when XML includes DumpBox elements that create HDF5 files)
      assert(!consoleText.includes('NF2FF computation failed'), 'No NF2FF error (no dump boxes in XML)');

      await page.close();
    }

    // ================================================================
    // 12. Error handling — invalid XML run
    // ================================================================
    console.log('\n=== Test: Invalid XML Run ===');
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      // Type XML that parses but is not a valid simulation config
      await page.fill('#editor-textarea', '<openEMS><FDTD NumberOfTimesteps="10"><Excitation Type="0" f0="1e9" fc="0.5e9"/><BoundaryCond xmin="0" xmax="0" ymin="0" ymax="0" zmin="0" zmax="0"/></FDTD><ContinuousStructure CoordSystem="0"><RectilinearGrid DeltaUnit="1"><XLines>0</XLines><YLines>0</YLines><ZLines>0</ZLines></RectilinearGrid><Properties/></ContinuousStructure></openEMS>');
      await page.selectOption('#engine-select', '0');
      await page.click('#btn-run');

      // Wait for error or done
      await page.waitForFunction(
        () => {
          const s = document.getElementById('status-text').textContent;
          return s === 'Error' || s === 'Done';
        },
        { timeout: 30000 },
      );

      // Should show error (grid with 1 line per axis is invalid)
      const status = await page.textContent('#status-text');
      const consoleText = await page.textContent('#sim-console');
      assert(status === 'Error' || consoleText.includes('Error'), 'Error reported for degenerate grid');

      // Run button should be re-enabled
      const runDisabled = await page.$eval('#btn-run', el => el.disabled);
      assert(!runDisabled, 'Run button re-enabled after error');

      await page.close();
    }

    // ================================================================
    // 13. Responsive layout (narrow viewport)
    // ================================================================
    console.log('\n=== Test: Responsive Layout ===');
    {
      const page = await context.newPage();
      await page.setViewportSize({ width: 600, height: 800 });
      await page.goto(`${BASE}/app/index.html`, { waitUntil: 'domcontentloaded' });

      // All panels should still be visible (stacked in single column)
      const editor = await page.$eval('#panel-editor', el => el.offsetHeight > 0);
      const sim = await page.$eval('#panel-sim', el => el.offsetHeight > 0);
      const results = await page.$eval('#panel-results', el => el.offsetHeight > 0);
      assert(editor, 'Editor panel visible at 600px width');
      assert(sim, 'Simulation panel visible at 600px width');
      assert(results, 'Results panel visible at 600px width');

      await page.close();
    }

  } finally {
    await browser.close();
    server.close();
  }

  // ---- Summary ----
  console.log(`\n${'='.repeat(60)}`);
  console.log(`App browser tests: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
