/**
 * Run WebGPU tests in a headless Chrome browser via Playwright.
 *
 * Usage: node tests/test_webgpu_browser.mjs
 *
 * Requires: npx playwright install chromium (one-time)
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { dirname } from 'node:path';
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
};

function startServer(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let filePath = join(ROOT, req.url === '/' ? '/tests/webgpu/index.html' : req.url);

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

async function main() {
  const port = 9876;
  const server = await startServer(port);
  console.log(`Test server running on http://127.0.0.1:${port}`);

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
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=metal',
      '--disable-gpu-sandbox',
      '--enable-dawn-features=allow_unsafe_apis',
      '--no-sandbox',
    ],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', (msg) => {
    const text = msg.text();
    console.log(text);
  });

  page.on('pageerror', (err) => {
    console.error(`Page error: ${err.message}`);
  });

  const testPage = process.argv[2] || '/tests/webgpu/index.html';
  console.log(`Navigating to http://127.0.0.1:${port}${testPage}`);
  await page.goto(`http://127.0.0.1:${port}${testPage}`, {
    waitUntil: 'domcontentloaded',
  });

  const results = await page.waitForFunction(
    () => window.__TEST_RESULTS__?.done === true,
    { timeout: 60000 },
  ).then(() => page.evaluate(() => window.__TEST_RESULTS__));

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Browser WebGPU: ${results.passed} passed, ${results.failed} failed`);

  await browser.close();
  server.close();

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
