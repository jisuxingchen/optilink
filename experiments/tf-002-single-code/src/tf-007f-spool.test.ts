import test from 'node:test';
import assert from 'node:assert/strict';
import {ObservationSpool, estimatePackedObservationBytes} from './observation-spool.ts';

function obs(captureId: number, fingerprint: string, quality: number, byteLength = 100) {
  return {captureId, capturedAtMs: captureId * 10, fingerprint, quality, bytes: new Uint8Array(byteLength).fill(captureId & 255)};
}

test('spool keeps best repeated observation and preserves capture order for deferred decode', () => {
  const spool = new ObservationSpool({maxBytes: 1000});
  spool.add(obs(1, 'A', 0.5));
  spool.add(obs(2, 'A', 0.8));
  spool.add(obs(3, 'B', 0.4));
  spool.add(obs(4, 'B', 0.3));
  spool.add(obs(5, 'C', 0.9));
  assert.equal(spool.size, 3);
  assert.equal(spool.replaced, 1);
  assert.deepEqual(spool.drain().map(item => [item.captureId, item.fingerprint]), [[2, 'A'], [3, 'B'], [5, 'C']]);
});

test('spool enforces a byte budget explicitly instead of relying on GC', () => {
  const spool = new ObservationSpool({maxBytes: 250});
  spool.add(obs(1, 'A', 1, 100));
  spool.add(obs(2, 'B', 1, 100));
  spool.add(obs(3, 'C', 1, 100));
  assert.equal(spool.evicted, 1);
  assert.equal(spool.storedBytes, 200);
  assert.deepEqual(spool.drain().map(item => item.fingerprint), ['B', 'C']);
});

test('4-bit packed 3×160 observation is small enough for practical deferred decode', () => {
  const bytes = estimatePackedObservationBytes({tileCount: 3, matrixSize: 160, bitsPerCell: 4});
  assert.equal(bytes, 38400);
  // 100 seconds at 15 unique optical symbols/s, one retained observation/symbol.
  assert.equal(bytes * 1500, 57_600_000);
  assert.ok(bytes * 1500 < 64 * 1024 * 1024);
});
