import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFrameCellsV1, payloadCapacityForMatrixV1} from './optigrid-v1.ts';
import {binaryCellsToTwoBitObservation} from './packed-cell-buffer.ts';
import {decodePackedOptiGridV1} from './deferred-optigrid-decoder.ts';

test('custom deferred decoder reconstructs cached OptiGrid payload without platform QR APIs', () => {
  const matrixSize = 192;
  const payload = new Uint8Array(payloadCapacityForMatrixV1(matrixSize));
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 17 + 91) & 255;
  const cells = encodeFrameCellsV1(matrixSize, 0x10203040, payload);
  const observation = binaryCellsToTwoBitObservation(cells);
  const result = decodePackedOptiGridV1(observation, matrixSize);
  assert.ok(result.decoded);
  assert.equal(result.thresholdLevel, 2);
  assert.equal(result.attempts, 1);
  assert.equal(result.decoded.sequence, 0x10203040);
  assert.deepEqual(result.decoded.payload, payload);
});
