/**
 * URL sharing utilities for antenna-prop.
 *
 * Encodes/decodes simulation XML configs into URL fragments
 * using Compression Streams API (deflate) + base64url encoding.
 * Falls back to IndexedDB for configs that exceed URL length limits.
 */

const DB_NAME = 'antenna-prop-configs';
const DB_VERSION = 1;
const STORE_NAME = 'configs';
const URL_FRAGMENT_LIMIT = 2000;

// ---- Base64url helpers ----

/**
 * Encode a Uint8Array to base64url string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode a base64url string to Uint8Array.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function base64urlToBytes(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---- Compression helpers ----

/**
 * Compress a string using deflate via CompressionStream API.
 * @param {string} text
 * @returns {Promise<Uint8Array>}
 */
export async function deflateCompress(text) {
  const encoder = new TextEncoder();
  const input = encoder.encode(text);
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(input);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

/**
 * Decompress a deflated Uint8Array back to string.
 * @param {Uint8Array} compressed
 * @returns {Promise<string>}
 */
export async function deflateDecompress(compressed) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  let result = '';
  for (const c of chunks) {
    result += decoder.decode(c, { stream: true });
  }
  result += decoder.decode();
  return result;
}

// ---- Public API ----

/**
 * Encode a config (script + optional param overrides) into a URL fragment value.
 * Returns the fragment string: `config=<base64url(deflate(payload))>`
 * If paramOverrides is a non-empty object, payload is JSON `{ s, p }`;
 * otherwise payload is the raw script string (backward compatible).
 * @param {string} xmlString
 * @param {Object|null} [paramOverrides]
 * @returns {Promise<string>}
 */
export async function encodeConfig(xmlString, paramOverrides) {
  let payload;
  if (paramOverrides && typeof paramOverrides === 'object' && Object.keys(paramOverrides).length > 0) {
    payload = JSON.stringify({ s: xmlString, p: paramOverrides });
  } else {
    payload = xmlString;
  }
  const compressed = await deflateCompress(payload);
  const encoded = bytesToBase64url(compressed);
  return `config=${encoded}`;
}

/**
 * Decode a config from a URL fragment string.
 * Expects `config=<base64url(deflate(payload))>` format.
 * Returns `{ script, paramOverrides }` where paramOverrides is an object or null.
 * Backward compatible: if payload is not JSON with `.s`, treats it as raw script.
 * @param {string} fragment - the hash fragment (without leading #)
 * @returns {Promise<{script: string, paramOverrides: Object|null}>}
 */
export async function decodeConfig(fragment) {
  const params = new URLSearchParams(fragment);
  const encoded = params.get('config');
  if (!encoded) throw new Error('No config= found in fragment');
  const compressed = base64urlToBytes(encoded);
  const text = await deflateDecompress(compressed);
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.s === 'string') {
      return { script: obj.s, paramOverrides: obj.p || null };
    }
  } catch (_) {
    // Not JSON — old format (raw script text)
  }
  return { script: text, paramOverrides: null };
}

// ---- IndexedDB helpers ----

/**
 * Open the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Save an XML config to IndexedDB.
 * @param {string} id - unique identifier
 * @param {string} xmlString
 * @returns {Promise<void>}
 */
export async function saveToIndexedDB(id, xmlString) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ id, xml: xmlString, timestamp: Date.now() });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Load an XML config from IndexedDB.
 * @param {string} id
 * @returns {Promise<string|null>}
 */
export async function loadFromIndexedDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => {
      db.close();
      resolve(req.result ? req.result.xml : null);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/**
 * Generate a UUID v4.
 * @returns {string}
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Auto-select sharing method: URL fragment for small configs, IndexedDB for large.
 * Returns the URL hash string to use (without leading #).
 * @param {string} xmlString
 * @param {Object|null} [paramOverrides] - optional param overrides to encode
 * @returns {Promise<string>} fragment string (e.g. "config=..." or "id=...")
 */
export async function shareConfig(xmlString, paramOverrides) {
  const fragment = await encodeConfig(xmlString, paramOverrides);
  if (fragment.length < URL_FRAGMENT_LIMIT) {
    return fragment;
  }
  // Too large for URL, store in IndexedDB
  const id = generateUUID();
  await saveToIndexedDB(id, xmlString);
  return `id=${id}`;
}

/**
 * Load a shared config from the current URL hash.
 * Handles both `#config=...` and `#id=...` formats.
 * @returns {Promise<{script: string, paramOverrides: Object|null}|null>}
 */
export async function loadSharedConfig() {
  const hash = typeof location !== 'undefined' ? location.hash : '';
  if (!hash || hash.length <= 1) return null;

  const fragment = hash.slice(1); // remove leading #
  const params = new URLSearchParams(fragment);

  if (params.has('config')) {
    return decodeConfig(fragment);
  }

  if (params.has('id')) {
    const id = params.get('id');
    const xml = await loadFromIndexedDB(id);
    return xml ? { script: xml, paramOverrides: null } : null;
  }

  return null;
}
