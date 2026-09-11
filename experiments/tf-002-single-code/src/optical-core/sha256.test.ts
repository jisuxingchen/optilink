import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sha256, sha256Hex} from './sha256.ts';

const enc = new TextEncoder();

test('SHA-256 known vectors', () => {
  assert.equal(sha256Hex(enc.encode('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(enc.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('SHA-256 digest length and multi-block padding', () => {
  const bytes = new Uint8Array(1000);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 13) & 255;
  const digest = sha256(bytes);
  assert.equal(digest.length, 32);
  assert.equal(sha256Hex(bytes), sha256Hex(bytes)); // deterministic
  assert.match(sha256Hex(bytes), /^[0-9a-f]{64}$/);
});
