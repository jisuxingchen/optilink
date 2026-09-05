import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleChunks,
  chunkBytes,
  crc32,
  deterministicBytes,
  encodeDataFrame,
  encodeManifest,
  parseFrame,
  sha256Hex,
} from './protocol.ts';

test('data frame roundtrip preserves payload and metadata', () => {
  const payload = deterministicBytes(777, 12345);
  const encoded = encodeDataFrame({kind: 'data', sessionId: 'abc123', index: 2, totalChunks: 9, payload});
  const parsed = parseFrame(encoded);
  assert.ok(parsed);
  assert.equal(parsed.kind, 'data');
  if (parsed.kind !== 'data') return;
  assert.equal(parsed.sessionId, 'abc123');
  assert.equal(parsed.index, 2);
  assert.equal(parsed.totalChunks, 9);
  assert.deepEqual(parsed.payload, payload);
});

test('manifest roundtrip preserves benchmark metadata', () => {
  const encoded = encodeManifest({
    kind: 'manifest',
    sessionId: 'deadbeef',
    totalChunks: 10,
    totalBytes: 4096,
    chunkSize: 512,
    sha256: 'a'.repeat(64),
    fileName: 'benchmark 10 MiB.bin',
  });
  const parsed = parseFrame(encoded);
  assert.deepEqual(parsed, {
    kind: 'manifest',
    sessionId: 'deadbeef',
    totalChunks: 10,
    totalBytes: 4096,
    chunkSize: 512,
    sha256: 'a'.repeat(64),
    fileName: 'benchmark 10 MiB.bin',
  });
});

test('chunk and assembly roundtrip exact bytes', () => {
  const source = deterministicBytes(4097, 9876);
  const chunks = chunkBytes(source, 513);
  const map = new Map(chunks.map((chunk, index) => [index, chunk]));
  const reconstructed = assembleChunks(map, chunks.length, source.length);
  assert.deepEqual(reconstructed, source);
});

test('corrupted payload is rejected by frame CRC', () => {
  const payload = deterministicBytes(64, 7);
  const encoded = encodeDataFrame({kind: 'data', sessionId: 's', index: 0, totalChunks: 1, payload});
  const parts = encoded.split('|');
  const last = parts.at(-1) ?? '';
  parts[parts.length - 1] = `${last.slice(0, -1)}${last.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(parseFrame(parts.join('|')), null);
});

test('SHA-256 is stable', async () => {
  const source = deterministicBytes(1024, 42);
  const first = await sha256Hex(source);
  const second = await sha256Hex(source);
  assert.equal(first, second);
  assert.equal(first.length, 64);
});

test('CRC32 is deterministic', () => {
  const source = deterministicBytes(128, 99);
  assert.equal(crc32(source), crc32(source));
});
