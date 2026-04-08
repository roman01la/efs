/**
 * Tests for src/url-share.mjs
 *
 * Runs in Node.js. Tests the base64url encoding/decoding and
 * round-trip encode/decode logic. Browser-only APIs (CompressionStream,
 * IndexedDB) are tested with polyfills/mocks where possible.
 *
 * Usage: node app/test-url-share.mjs
 */

import { bytesToBase64url, base64urlToBytes } from '../src/url-share.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

function assertEq(a, b, msg) {
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

// ---- Test 1: base64url round-trip ----
console.log('\n=== Test: base64url round-trip ===');
{
  const input = new Uint8Array([0, 1, 2, 255, 254, 128, 63, 62, 61]);
  const encoded = bytesToBase64url(input);
  const decoded = base64urlToBytes(encoded);

  assert(encoded.indexOf('+') === -1, 'No + in base64url output');
  assert(encoded.indexOf('/') === -1, 'No / in base64url output');
  assert(encoded.indexOf('=') === -1, 'No = padding in base64url output');
  assertEq(decoded.length, input.length, 'Round-trip preserves length');

  let match = true;
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== decoded[i]) { match = false; break; }
  }
  assert(match, 'Round-trip preserves all bytes');
}

// ---- Test 2: base64url with empty input ----
console.log('\n=== Test: base64url empty input ===');
{
  const empty = new Uint8Array(0);
  const encoded = bytesToBase64url(empty);
  assertEq(encoded, '', 'Empty input encodes to empty string');
  const decoded = base64urlToBytes(encoded);
  assertEq(decoded.length, 0, 'Empty string decodes to empty array');
}

// ---- Test 3: base64url with various padding lengths ----
console.log('\n=== Test: base64url padding variants ===');
{
  // Length 1 (needs 3 padding chars in standard base64)
  const a1 = new Uint8Array([42]);
  assertEq(base64urlToBytes(bytesToBase64url(a1))[0], 42, '1-byte round-trip');

  // Length 2 (needs 2 padding chars)
  const a2 = new Uint8Array([42, 99]);
  const d2 = base64urlToBytes(bytesToBase64url(a2));
  assert(d2[0] === 42 && d2[1] === 99, '2-byte round-trip');

  // Length 3 (needs 1 padding char)
  const a3 = new Uint8Array([42, 99, 200]);
  const d3 = base64urlToBytes(bytesToBase64url(a3));
  assert(d3[0] === 42 && d3[1] === 99 && d3[2] === 200, '3-byte round-trip');
}

// ---- Test 4: base64url with URL-unsafe base64 characters ----
console.log('\n=== Test: base64url URL-safe characters ===');
{
  // Bytes that produce + and / in standard base64
  const tricky = new Uint8Array([251, 239, 190, 63, 255]);
  const encoded = bytesToBase64url(tricky);
  assert(!encoded.includes('+'), 'No + in encoded output for tricky bytes');
  assert(!encoded.includes('/'), 'No / in encoded output for tricky bytes');

  const decoded = base64urlToBytes(encoded);
  let ok = true;
  for (let i = 0; i < tricky.length; i++) {
    if (tricky[i] !== decoded[i]) ok = false;
  }
  assert(ok, 'Tricky bytes round-trip correctly');
}

// ---- Test 5: Compression round-trip (browser API, skip if unavailable) ----
console.log('\n=== Test: Compression round-trip ===');
{
  let hasCompression = false;
  try {
    // Node 18+ may have CompressionStream via web streams
    hasCompression = typeof globalThis.CompressionStream === 'function';
  } catch (e) { /* nope */ }

  if (hasCompression) {
    const { encodeConfig, decodeConfig } = await import('../src/url-share.mjs');
    const xml = '<openEMS><FDTD NumberOfTimesteps="1000"/></openEMS>';
    const fragment = await encodeConfig(xml);
    assert(fragment.startsWith('config='), 'encodeConfig returns config= prefix');

    const decoded = await decodeConfig(fragment);
    assertEq(decoded.script, xml, 'Round-trip through compress/decompress preserves XML');
    assertEq(decoded.paramOverrides, null, 'No param overrides for plain script encoding');

    // Test with param overrides
    const overrides = { 'Frequency': 2.4e9, 'Width': 30 };
    const fragment2 = await encodeConfig(xml, overrides);
    const decoded2 = await decodeConfig(fragment2);
    assertEq(decoded2.script, xml, 'Round-trip with overrides preserves script');
    assertEq(JSON.stringify(decoded2.paramOverrides), JSON.stringify(overrides), 'Round-trip preserves param overrides');
  } else {
    console.log('  SKIP: CompressionStream not available in this Node.js version');
  }
}

// ---- Test 6: shareConfig auto-selection logic (mock) ----
console.log('\n=== Test: shareConfig auto-selection (logic check) ===');
{
  // Test the logic: short configs should use config=, long ones should use id=
  // We test this by checking encodeConfig output length
  let hasCompression = typeof globalThis.CompressionStream === 'function';

  if (hasCompression) {
    const { encodeConfig } = await import('../src/url-share.mjs');

    // Short XML
    const shortXml = '<openEMS><FDTD/></openEMS>';
    const shortFragment = await encodeConfig(shortXml);
    assert(shortFragment.length < 2000, `Short XML encodes under 2000 chars (${shortFragment.length})`);

    // Very long XML (repeat to make it big, though deflate may still compress well)
    let longXml = '<openEMS>';
    for (let i = 0; i < 200; i++) {
      longXml += `<Property_${i} Name="prop_${i}" Value="${Math.random()}"><Box X="${i}" Y="${i}" Z="${i}"/></Property_${i}>`;
    }
    longXml += '</openEMS>';
    const longFragment = await encodeConfig(longXml);
    console.log(`  INFO: Long XML (${longXml.length} chars) encodes to ${longFragment.length} chars`);
    assert(longFragment.length > 100, 'Long XML produces non-trivial encoded output');
  } else {
    console.log('  SKIP: CompressionStream not available');
  }
}

// ---- Test 7: IndexedDB mock test ----
console.log('\n=== Test: IndexedDB (mock) ===');
{
  // IndexedDB is not available in Node.js, so we just verify the functions exist
  const mod = await import('../src/url-share.mjs');
  assert(typeof mod.saveToIndexedDB === 'function', 'saveToIndexedDB is exported');
  assert(typeof mod.loadFromIndexedDB === 'function', 'loadFromIndexedDB is exported');
  assert(typeof mod.shareConfig === 'function', 'shareConfig is exported');
  assert(typeof mod.loadSharedConfig === 'function', 'loadSharedConfig is exported');
  console.log('  INFO: IndexedDB tests require a browser environment.');
}

// ---- Summary ----
console.log(`\n${'='.repeat(50)}`);
console.log(`URL Share Tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
