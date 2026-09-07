import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFrameCellsV1, encodeFrameCellsV1, payloadCapacityForMatrixV1} from './optigrid-v1.ts';
import {binaryCellsFromPacked, binaryCellsToTwoBitObservation, packedBytesForCells} from './packed-cell-buffer.ts';

test('2-bit packed cell observation preserves an OptiGrid payload for deferred decode', () => {
  const matrixSize = 176;
  const payload = new Uint8Array(payloadCapacityForMatrixV1(matrixSize));
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 73 + 19) & 255;
  const cells = encodeFrameCellsV1(matrixSize, 0x12345678, payload);
  const packed = binaryCellsToTwoBitObservation(cells);
  assert.equal(packed.packed.length, packedBytesForCells(matrixSize * matrixSize));
  const decoded = decodeFrameCellsV1(binaryCellsFromPacked(packed, 2), matrixSize);
  assert.ok(decoded);
  assert.equal(decoded.sequence, 0x12345678);
  assert.deepEqual(decoded.payload, payload);
});

test('3×176 at one 2-bit observation per optical symbol stays around 35 MB for a 100-second capture', () => {
  const perTile = packedBytesForCells(176 * 176);
  const bytes = perTile * 3 * 15 * 100;
  assert.equal(perTile, 7744);
  assert.equal(bytes, 34_848_000);
  assert.ok(bytes < 40 * 1024 * 1024);
});
