/**
 * WASM loader for Node.js.
 * Loads the Emscripten-compiled openEMS module in Node.js context.
 */

import { createRequire } from 'module';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const wasmDir = resolve(projectRoot, 'build-wasm');

let cachedModule = null;

/**
 * Load the WASM module in Node.js.
 * @param {{ onPrintErr?: (msg: string) => void }} opts
 * @returns {Promise<object>} Emscripten module instance
 */
export async function loadWASM({ onPrintErr } = {}) {
  if (cachedModule) return cachedModule;

  const jsPath = resolve(wasmDir, 'openems.js');
  if (!existsSync(jsPath)) {
    throw new Error(
      `WASM build not found at ${wasmDir}. Run 'npm run build' first.`
    );
  }

  // The Emscripten glue JS detects Node.js via ENVIRONMENT_IS_NODE
  // and uses require('fs') + __dirname for file loading.
  const require_ = createRequire(jsPath);

  // Dynamic import of the CJS module
  const { default: createOpenEMS } = await import(jsPath);

  cachedModule = await createOpenEMS({
    locateFile: (path) => resolve(wasmDir, path),
    printErr: onPrintErr || ((text) => process.stderr.write(text + '\n')),
  });

  return cachedModule;
}
