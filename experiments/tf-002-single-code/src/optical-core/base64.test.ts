import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bytesToBase64, base64ToBytes} from './base64.ts';

const enc = new TextEncoder();

test('base64 known vectors', () => {
  assert.equal(bytesToBase64(new Uint8Array(0)), '');
  assert.equal(bytesToBase64(enc.encode('f')), 'Zg==');
  assert.equal(bytesToBase64(enc.encode('fo')), 'Zm8=');
  assert.equal(bytesToBase64(enc.encode('foo')), 'Zm9v');
  assert.equal(bytesToBase64(enc.encode('foob')), 'Zm9vYg==');
  assert.equal(bytesToBase64(enc.encode('fooba')), 'Zm9vYmE=');
  assert.equal(bytesToBase64(enc.encode('foobar')), 'Zm9vYmFy');
});

test('base64 round-trip across lengths', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 6, 7, 63, 64, 65, 127, 511, 512, 513, 4096]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = (i * 131 + 7) & 255;
    const decoded = base64ToBytes(bytesToBase64(bytes));
    assert.deepEqual(Array.from(decoded), Array.from(bytes), `round-trip length ${len}`);
  }
});

test('base64 rejects invalid input', () => {
  assert.throws(() => base64ToBytes('@@@'));
});
