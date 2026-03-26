/**
 * Run an example test in a headless browser with hardware acceleration.
 * Usage: node examples/run_browser_test.mjs [patch|msl|waveguide]
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const example = process.argv[2] || 'msl';

const pages = {
  patch: '/examples/patch_antenna.html',
  msl: '/examples/msl_notch_filter_gpu.html',
  waveguide: '/examples/rect_waveguide.html',
};

const pagePath = pages[example];
if (!pagePath) {
  console.error(`Unknown example: ${example}. Use: patch, msl, waveguide`);
  process.exit(1);
}

// Simple static file server with COOP/COEP headers
const server = http.createServer((req, res) => {
  const fpath = path.join(ROOT, req.url);
  const ext = path.extname(fpath);
  const types = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.mjs': 'application/javascript', '.wasm': 'application/wasm',
    '.wgsl': 'text/plain',
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
console.log(`Running: ${example} (${pagePath})`);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer',
    // Use real GPU if available, fall back to SwiftShader
    '--enable-gpu',
    '--ignore-gpu-blocklist',
  ],
});

const page = await (await browser.newContext()).newPage();
page.on('console', msg => console.log(msg.text()));
page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

await page.goto(`http://localhost:${port}${pagePath}`);
await page.click('#runBtn');

// Wait up to 10 minutes
try {
  await page.waitForFunction(() => {
    const log = document.getElementById('log')?.textContent || '';
    return log.includes('Done.') || log.includes('ERROR');
  }, null, { timeout: 600000 });
} catch {
  console.error('TIMEOUT — simulation did not complete in 10 minutes');
}

await browser.close();
server.close();
