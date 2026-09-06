import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeFrameCellsV1,
  encodeFrameCellsV1,
  payloadCapacityForMatrixV1,
  reservedScoreV1,
} from './optigrid-v1.ts';

function payload(length: number): Uint8Array {
  return Uint8Array.from({length}, (_, index) => (index * 73 + 19) & 0xff);
}

for (const size of [48, 64, 80, 96, 120, 160]) {
  test(`OptiGrid v1 ${size} roundtrip`, () => {
    const capacity = payloadCapacityForMatrixV1(size);
    assert.ok(capacity > 0);
    const source = payload(Math.min(capacity, 512));
    const cells = encodeFrameCellsV1(size, 0x12345678, source);
    assert.equal(reservedScoreV1(cells, size), 1);
    const decoded = decodeFrameCellsV1(cells, size);
    assert.ok(decoded);
    assert.equal(decoded.sequence, 0x12345678);
    assert.deepEqual(decoded.payload, source);
  });
}

test('OptiGrid v1 rejects payload corruption through CRC', () => {
  const size = 80;
  const cells = encodeFrameCellsV1(size, 42, payload(200));
  const inner = 10 * size + 10;
  cells[inner + 160] ^= 1;
  assert.equal(decodeFrameCellsV1(cells, size), null);
});
