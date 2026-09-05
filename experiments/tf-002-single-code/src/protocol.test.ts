import test from 'node:test';
import assert from 'node:assert/strict';

import {FountainDecoder, FountainEncoder, FountainPlan} from './fountain.ts';
import {
  assembleChunks,
  chunkBytes,
  crc32,
  deterministicBytes,
  encodeDataFrame,
  encodeFountainDataFrame,
  encodeFountainManifest,
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
  const encoded = encodeManifest({kind: 'manifest', sessionId: 'deadbeef', totalChunks: 10, totalBytes: 4096, chunkSize: 512, sha256: 'a'.repeat(64), fileName: 'benchmark 10 MiB.bin'});
  const parsed = parseFrame(encoded);
  assert.deepEqual(parsed, {kind: 'manifest', sessionId: 'deadbeef', totalChunks: 10, totalBytes: 4096, chunkSize: 512, sha256: 'a'.repeat(64), fileName: 'benchmark 10 MiB.bin'});
});

test('fountain manifest and symbol frames roundtrip', () => {
  const manifest = encodeFountainManifest({
    kind: 'fountain-manifest',
    sessionId: '0123456789abcdef',
    sourceBlocks: 42,
    totalBytes: 12345,
    blockSize: 300,
    sha256: 'b'.repeat(64),
    fileName: 'fountain 1 MiB.bin',
    fountainSeed: 0x89abcdef,
  });
  assert.deepEqual(parseFrame(manifest), {
    kind: 'fountain-manifest',
    sessionId: '0123456789abcdef',
    sourceBlocks: 42,
    totalBytes: 12345,
    blockSize: 300,
    sha256: 'b'.repeat(64),
    fileName: 'fountain 1 MiB.bin',
    fountainSeed: 0x89abcdef,
  });

  const payload = deterministicBytes(300, 77);
  const symbol = encodeFountainDataFrame({kind: 'fountain', sessionId: '0123456789abcdef', symbolId: 99, sourceBlocks: 42, payload});
  const parsed = parseFrame(symbol);
  assert.ok(parsed);
  assert.equal(parsed.kind, 'fountain');
  if (parsed.kind !== 'fountain') return;
  assert.equal(parsed.symbolId, 99);
  assert.equal(parsed.sourceBlocks, 42);
  assert.deepEqual(parsed.payload, payload);
});

test('chunk and assembly roundtrip exact bytes', () => {
  const source = deterministicBytes(4097, 9876);
  const chunks = chunkBytes(source, 513);
  const map = new Map(chunks.map((chunk, index) => [index, chunk]));
  const reconstructed = assembleChunks(map, chunks.length, source.length);
  assert.deepEqual(reconstructed, source);
});

test('fountain plan is deterministic and systematic first', () => {
  const first = new FountainPlan(256, 0x12345678);
  const second = new FountainPlan(256, 0x12345678);
  assert.deepEqual(first.indicesFor(17), [17]);
  assert.deepEqual(first.indicesFor(300), second.indicesFor(300));
  assert.ok(first.indicesFor(300).length >= 1);
});

test('fountain decoder reconstructs exact bytes through deterministic 45% symbol loss', () => {
  const source = deterministicBytes(65536, 0x13572468);
  const blockSize = 256;
  const seed = 0x12345678;
  const encoder = new FountainEncoder(source, blockSize, seed);
  const decoder = new FountainDecoder(encoder.sourceCount, blockSize, seed);

  for (let symbolId = 0; symbolId < encoder.sourceCount * 4 && !decoder.complete; symbolId += 1) {
    const keep = ((symbolId * 37 + 11) % 100) < 55;
    if (!keep) continue;
    decoder.addSymbol(symbolId, encoder.symbol(symbolId));
  }

  assert.equal(decoder.complete, true);
  assert.deepEqual(decoder.reconstruct(source.length), source);
  assert.ok(decoder.acceptedSymbols >= encoder.sourceCount);
});

test('duplicate fountain symbols do not change solved state', () => {
  const source = deterministicBytes(1024, 9);
  const encoder = new FountainEncoder(source, 128, 123);
  const decoder = new FountainDecoder(encoder.sourceCount, 128, 123);
  const payload = encoder.symbol(0);
  assert.equal(decoder.addSymbol(0, payload), 'accepted');
  const solved = decoder.solvedCount;
  assert.equal(decoder.addSymbol(0, payload), 'duplicate');
  assert.equal(decoder.solvedCount, solved);
  assert.equal(decoder.duplicateSymbols, 1);
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
