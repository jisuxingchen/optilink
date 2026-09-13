/**
 * TF-012 r4 — Single-Code Baseline protocol + receiver logic tests (pure Node).
 *
 * Covers the baseline acceptance items that do not need a camera:
 *  1  deterministic 10 KiB source
 *  2  exact chunk count
 *  3  exact per-chunk payload capacity
 *  4  metadata roundtrip
 *  5  arbitrary-start receiver
 *  6  duplicate chunk handling
 *  7  shuffled chunk order
 *  8  missing-chunk completion
 *  9  final-last-missing-index
 * 10  exact reconstruction (10240 bytes)
 * 11  SHA-256 exact
 * 12  UTF-8 display decode
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_BASELINE_CHUNK_DATA_BYTES,
  SINGLE_BASELINE_FILE_BYTES,
  SINGLE_BASELINE_FILE_NAME,
  SINGLE_BASELINE_MATRIX,
  SINGLE_BASELINE_META_BYTES,
  SINGLE_BASELINE_META_FIXED_BYTES,
  SINGLE_BASELINE_META_LAYOUT,
  SINGLE_BASELINE_OPTIGRID_CAPACITY_BYTES,
  SINGLE_BASELINE_PAYLOAD_BYTES,
  SINGLE_BASELINE_RECONSTRUCTION_METHOD,
  SINGLE_BASELINE_TOTAL_CHUNKS,
  SingleCodeBaselineReceiver,
  buildSingleBaselineTransfer,
  packSingleBaselineChunk,
  parseSingleBaselineChunk,
  singleBaselineFileBytes,
  singleBaselinePreviewText,
  utf8Bytes,
  utf8String,
} from './single-baseline.ts';
import {sha256Hex} from './sha256.ts';
import {decodeFrameCellsV1, encodeFrameCellsV1, payloadCapacityForMatrixV1} from '../optigrid-v1.ts';

const transfer = buildSingleBaselineTransfer();

/** Build a fake decoded OptiGrid frame carrying one baseline chunk payload. */
function frameFor(chunkIndex: number) {
  const payload = transfer.payloads[chunkIndex];
  const cells = transfer.frames[chunkIndex];
  const decoded = decodeFrameCellsV1(cells, SINGLE_BASELINE_MATRIX);
  assert.ok(decoded, 'chunk ' + chunkIndex + ' must round-trip through OptiGrid v1');
  assert.deepEqual(Array.from(decoded.payload), Array.from(payload));
  return decoded;
}

test('1 · G1 deterministic 10 KiB file source', () => {
  const a = singleBaselineFileBytes();
  const b = singleBaselineFileBytes();
  assert.equal(a.length, SINGLE_BASELINE_FILE_BYTES);
  assert.equal(a.length, 10240);
  assert.equal(sha256Hex(a), sha256Hex(b), 'source generation is deterministic');
  assert.equal(sha256Hex(a), transfer.fileSha256Hex);
  const text = utf8String(a);
  assert.equal(text.length, 10240, 'ASCII source: 1 byte per character');
  assert.ok(text.startsWith('OptiLink Physical Transfer Baseline'));
  assert.equal(text.slice(63, 64), '\n', 'first line is exactly 64 bytes');
  assert.ok(text.includes('\nSingle-Code Cyclic Optical Broadcast Baseline'));
  assert.ok(text.includes('line 000001 '));
  assert.ok(text.endsWith('\n'));
  assert.equal(text.split('\n').length, 161, '160 lines + trailing newline split');
  for (let i = 0; i < a.length; i += 1) assert.ok(a[i] < 0x80, 'source is ASCII (deterministic bytes)');
});

test('2 · G2 exact chunk count', () => {
  assert.equal(transfer.totalChunks, 16);
  assert.equal(SINGLE_BASELINE_TOTAL_CHUNKS, 16);
  assert.equal(transfer.frames.length, 16);
  assert.equal(transfer.payloads.length, 16);
  assert.equal(SINGLE_BASELINE_FILE_BYTES / SINGLE_BASELINE_CHUNK_DATA_BYTES, 16, 'exact division');
  for (const payload of transfer.payloads) assert.equal(payload.length, SINGLE_BASELINE_PAYLOAD_BYTES);
});

test('3 · G2/G3 exact per-chunk payload capacity', () => {
  assert.equal(SINGLE_BASELINE_MATRIX, 96);
  assert.equal(payloadCapacityForMatrixV1(96), 708, 'OptiGrid v1 matrix-96 payload capacity');
  assert.equal(SINGLE_BASELINE_OPTIGRID_CAPACITY_BYTES, 708);
  assert.equal(SINGLE_BASELINE_META_BYTES, 66, 'metadata bytes for a 16-byte file name');
  assert.equal(SINGLE_BASELINE_META_BYTES, SINGLE_BASELINE_META_FIXED_BYTES + SINGLE_BASELINE_FILE_NAME.length);
  assert.equal(SINGLE_BASELINE_META_FIXED_BYTES, 50);
  assert.equal(SINGLE_BASELINE_META_LAYOUT.length, 11, 'documented metadata layout has 11 fields');
  assert.equal(SINGLE_BASELINE_CHUNK_DATA_BYTES, 640);
  assert.equal(SINGLE_BASELINE_PAYLOAD_BYTES, 706);
  assert.ok(
    SINGLE_BASELINE_PAYLOAD_BYTES <= SINGLE_BASELINE_OPTIGRID_CAPACITY_BYTES,
    'chunk payload must fit OptiGrid v1 capacity (706 <= 708)',
  );
  assert.equal(SINGLE_BASELINE_OPTIGRID_CAPACITY_BYTES - SINGLE_BASELINE_PAYLOAD_BYTES, 2, 'capacity slack = 2 bytes');
  assert.equal(transfer.capacitySlackBytes, 2);
  // The encoder refuses anything above capacity.
  assert.throws(
    () => encodeFrameCellsV1(96, 1, new Uint8Array(709)),
    /exceeds OptiGrid v1 96 capacity 708/u,
  );
});

test('4 · G3 metadata roundtrip', () => {
  for (let index = 0; index < transfer.totalChunks; index += 1) {
    const parsed = parseSingleBaselineChunk(transfer.payloads[index]);
    assert.ok(parsed.ok, 'payload ' + index + ' parses');
    const meta = parsed.chunk.meta;
    assert.equal(meta.protocol, 'SB');
    assert.equal(meta.version, 1);
    assert.equal(meta.reconstructionMethod, SINGLE_BASELINE_RECONSTRUCTION_METHOD);
    assert.equal(meta.reconstructionMethodId, 0);
    assert.equal(meta.fileId, transfer.fileId);
    assert.equal(meta.fileName, SINGLE_BASELINE_FILE_NAME);
    assert.equal(meta.totalFileBytes, SINGLE_BASELINE_FILE_BYTES);
    assert.equal(meta.totalChunks, SINGLE_BASELINE_TOTAL_CHUNKS);
    assert.equal(meta.chunkIndex, index);
    assert.equal(meta.chunkDataBytes, SINGLE_BASELINE_CHUNK_DATA_BYTES);
    assert.equal(meta.fileSha256, transfer.fileSha256Hex);
    assert.deepEqual(Array.from(parsed.chunk.data), Array.from(transfer.fileBytes.subarray(index * 640, (index + 1) * 640)));
  }
  // Corrupted / hostile payloads are rejected, never silently accepted.
  const badMagic = Uint8Array.from(transfer.payloads[0]);
  badMagic[0] = 0x00;
  assert.equal(parseSingleBaselineChunk(badMagic).ok, false);
  const badIndex = Uint8Array.from(transfer.payloads[15]);
  badIndex[16] = 16;
  const rejected = parseSingleBaselineChunk(badIndex);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok === false ? rejected.reason : '', 'chunk-index-out-of-range');
  assert.throws(
    () => packSingleBaselineChunk({
      fileName: SINGLE_BASELINE_FILE_NAME,
      fileId: transfer.fileId,
      fileSha256Bytes: transfer.fileSha256Bytes,
      totalFileBytes: transfer.totalFileBytes,
      totalChunks: 16,
      chunkIndex: 16,
      chunkDataBytes: 640,
      data: new Uint8Array(640),
    }),
    /chunkIndex out of range/u,
    'the packer refuses an out-of-range chunk index',
  );
  const truncated = parseSingleBaselineChunk(transfer.payloads[0].subarray(0, 700));
  assert.equal(truncated.ok, false);
});

test('5 · G8/G10 arbitrary-start receiver (join mid-cycle)', () => {
  for (const start of [0, 3, 7, 11, 15]) {
    const receiver = new SingleCodeBaselineReceiver();
    receiver.begin(1000);
    for (let step = 0; step < 32; step += 1) {
      const index = (start + step) % SINGLE_BASELINE_TOTAL_CHUNKS;
      if (receiver.complete) break;
      receiver.ingestDecoded(frameFor(index), 1000 + step * 10);
    }
    assert.ok(receiver.complete, 'start=' + start + ' completes without sender restart');
    const result = receiver.reconstruct();
    assert.ok(result);
    assert.equal(result.bytes.length, 10240);
    assert.equal(result.sha256Hex, transfer.fileSha256Hex);
    assert.equal(result.match, true);
  }
});

test('6 · G8/G9 duplicate chunks are ignored and counted', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  assert.equal(receiver.ingestDecoded(frameFor(4), 0), 'stored');
  assert.equal(receiver.ingestDecoded(frameFor(4), 1), 'duplicate');
  assert.equal(receiver.ingestDecoded(frameFor(4), 2), 'duplicate');
  assert.equal(receiver.ingestDecoded(frameFor(9), 3), 'stored');
  assert.equal(receiver.receivedUniqueCount, 2);
  assert.equal(receiver.duplicateCount, 2);
  assert.deepEqual(receiver.missingIndices(), [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]);
});

test('7 · G8 shuffled chunk order still reconstructs exactly', () => {
  const order = [15, 2, 8, 0, 12, 5, 1, 14, 3, 9, 11, 6, 13, 4, 10, 7];
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  order.forEach((index, i) => assert.equal(receiver.ingestDecoded(frameFor(index), i), 'stored'));
  assert.ok(receiver.complete);
  const result = receiver.reconstruct();
  assert.ok(result && result.match);
});

test('8 · G10 missing-chunk completion is blocked until ALL unique chunks arrive', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  for (let index = 0; index < 15; index += 1) receiver.ingestDecoded(frameFor(index), index);
  assert.equal(receiver.complete, false);
  assert.equal(receiver.reconstruct(), null, 'reconstruction must refuse an incomplete transfer');
  assert.deepEqual(receiver.missingIndices(), [15]);
  assert.equal(receiver.ingestDecoded(frameFor(15), 15), 'stored');
  assert.equal(receiver.complete, true);
});

test('9 · G10 the last missing chunk may be any index (not the last one)', () => {
  for (const missing of [0, 5, 11, 15]) {
    const receiver = new SingleCodeBaselineReceiver();
    receiver.begin(0);
    for (let index = 0; index < 16; index += 1) {
      if (index === missing) continue;
      assert.equal(receiver.ingestDecoded(frameFor(index), index), 'stored');
      if (index < 15) assert.equal(receiver.complete, false, 'incomplete while ' + missing + ' is missing');
    }
    assert.equal(receiver.stage, 'receiving');
    assert.equal(receiver.ingestDecoded(frameFor(missing), 99), 'stored');
    assert.equal(receiver.complete, true);
  }
});

test('10 · G11 reconstruction is exactly 10240 bytes by CONCAT_BY_INDEX', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  for (let index = 15; index >= 0; index -= 1) receiver.ingestDecoded(frameFor(index), index);
  const result = receiver.reconstruct();
  assert.ok(result);
  assert.equal(result.bytes.length, 10240);
  assert.equal(receiver.reconstructionMethod, 'CONCAT_BY_INDEX');
  assert.deepEqual(Array.from(result.bytes), Array.from(transfer.fileBytes), 'byte-exact reconstruction');
});

test('11 · G12 SHA-256 exact match against chunk metadata', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  for (let index = 0; index < 16; index += 1) receiver.ingestDecoded(frameFor(index), index);
  const result = receiver.reconstruct();
  assert.ok(result);
  assert.equal(result.match, true);
  assert.equal(result.sha256Hex, transfer.fileSha256Hex);
  assert.equal(result.sha256Hex, sha256Hex(singleBaselineFileBytes()));
  assert.match(result.sha256Hex, /^[0-9a-f]{64}$/u);
  assert.equal(receiver.stage, 'complete');

  // A tampered chunk must produce a MISMATCH, never a false PASS.
  const tampered = new SingleCodeBaselineReceiver();
  tampered.begin(0);
  for (let index = 0; index < 16; index += 1) tampered.ingestDecoded(frameFor(index), index);
  const stored = tampered.received.get(7);
  assert.ok(stored);
  stored[0] = stored[0] ^ 0xff;
  const bad = tampered.reconstruct();
  assert.ok(bad);
  assert.equal(bad.match, false);
  assert.equal(tampered.stage, 'error');
});

test('12 · G13 UTF-8 display decode of the reconstructed content', () => {
  const bytes = singleBaselineFileBytes();
  assert.equal(utf8String(bytes).length, 10240);
  const preview = singleBaselinePreviewText(bytes, 4);
  assert.ok(preview.head.startsWith('OptiLink Physical Transfer Baseline'));
  assert.ok(preview.tail.includes('line 000157'));
  assert.equal(preview.lines, 161);
  // UTF-8 helpers handle non-ASCII without TextEncoder/TextDecoder.
  const sample = '单码基线 · baseline-10k.txt';
  assert.equal(utf8String(utf8Bytes(sample)), sample);
  assert.deepEqual(Array.from(utf8Bytes('A')), [0x41]);
  assert.deepEqual(Array.from(utf8Bytes('单')), [0xe5, 0x8d, 0x95]);
  assert.equal(utf8String(Uint8Array.from([0xe5, 0x8d, 0x95])), '单');
});

test('13 · G9 a foreign fileId is ignored and counted (session is not switched)', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  receiver.ingestDecoded(frameFor(0), 0);
  const foreignPayload = packSingleBaselineChunk({
    fileName: 'other.txt',
    fileId: (transfer.fileId ^ 0xffffffff) >>> 0,
    fileSha256Bytes: new Uint8Array(32).fill(0xab),
    totalFileBytes: 1280,
    totalChunks: 2,
    chunkIndex: 0,
    chunkDataBytes: 640,
    data: new Uint8Array(640).fill(7),
  });
  const foreign = decodeFrameCellsV1(
    encodeFrameCellsV1(SINGLE_BASELINE_MATRIX, 1, foreignPayload),
    SINGLE_BASELINE_MATRIX,
  );
  assert.ok(foreign);
  assert.equal(receiver.ingestDecoded(foreign, 1), 'foreign');
  assert.equal(receiver.activeFileId, transfer.fileId, 'active transfer identity is unchanged');
  assert.equal(receiver.totalChunks, 16);
  assert.equal(receiver.metrics.foreignChunkRejects, 1);
  assert.equal(receiver.receivedUniqueCount, 1);
});

test('14 · G9 receiver stops ingest once all unique chunks are received', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  for (let index = 0; index < 16; index += 1) receiver.ingestDecoded(frameFor(index), index);
  assert.equal(receiver.stage, 'reconstructing');
  assert.equal(receiver.ingestDecoded(frameFor(0), 100), 'ignored-complete');
  assert.equal(receiver.metrics.postCompleteFrames, 1);
  const result = receiver.reconstruct();
  assert.ok(result && result.match);
  assert.equal(receiver.ingestDecoded(frameFor(1), 101), 'ignored-complete');
  assert.equal(receiver.metrics.postCompleteFrames, 2);
});

test('15 · G12 receiver reports timing and metric fields used by the Mini Program UI', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  receiver.ingestDecoded(frameFor(11), 500);
  assert.equal(receiver.metrics.firstChunkMs, 500, 'time to first valid chunk');
  for (let index = 0; index < 16; index += 1) if (index !== 11) receiver.ingestDecoded(frameFor(index), 500 + index);
  assert.equal(receiver.metrics.allChunksMs, 515, 'time to all chunks');
  const result = receiver.reconstruct(2000);
  assert.ok(result);
  assert.equal(result.expectedSha256, transfer.fileSha256Hex);
  assert.ok(receiver.metrics.reconstructMs >= 0);
  assert.ok(receiver.metrics.shaMs >= 0);
  assert.equal(receiver.metrics.uniqueChunks, 16);
});

test('16 · sender cyclic broadcast model keeps the chunk order stable', () => {
  const emitted: number[] = [];
  let cursor = 0;
  for (let i = 0; i < 36; i += 1) {
    emitted.push(cursor);
    cursor = (cursor + 1) % SINGLE_BASELINE_TOTAL_CHUNKS;
  }
  assert.deepEqual(emitted.slice(0, 16), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(emitted.slice(16, 32), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(emitted[32], 0, 'cycle restarts at chunk 0');
});
