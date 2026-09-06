import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calibrationPayload,
  decodeFrameCells,
  encodeFrameCells,
  payloadCapacityForMatrix,
  reservedScore,
} from './optigrid.ts';

for (const matrixSize of [64, 80, 96, 120, 160]) {
  test(`OptiGrid ${matrixSize} perfect-matrix roundtrip`, () => {
    const capacity = payloadCapacityForMatrix(matrixSize);
    assert.ok(capacity > 0);
    const sequence = 0x12340000 + matrixSize;
    const payload = calibrationPayload(sequence, capacity);
    const cells = encodeFrameCells(matrixSize, sequence, payload);
    assert.equal(cells.length, matrixSize * matrixSize);
    assert.equal(reservedScore(cells, matrixSize), 1);
    const decoded = decodeFrameCells(cells, matrixSize);
    assert.ok(decoded);
    assert.equal(decoded.sequence, sequence >>> 0);
    assert.equal(decoded.matrixSize, matrixSize);
    assert.deepEqual(decoded.payload, payload);
  });
}

test('OptiGrid CRC rejects a data-cell bit flip', () => {
  const matrixSize = 96;
  const payload = calibrationPayload(42, payloadCapacityForMatrix(matrixSize));
  const cells = encodeFrameCells(matrixSize, 42, payload);
  const interiorIndex = 20 * matrixSize + 20;
  cells[interiorIndex] ^= 1;
  assert.equal(decodeFrameCells(cells, matrixSize), null);
});
