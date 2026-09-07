import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeManifest, decodeManifest, manifestRepeatSchedule, type OltpManifestV1} from './oltp-manifest.ts';
import {BoundedObservationQueue} from './buffered-observation-queue.ts';
import {buildSymbolHoldPlan, theoreticalGrossBytesPerSecond} from './symbol-hold-plan.ts';

const manifest: OltpManifestV1 = {
  protocol: 'OLTP',
  version: 1,
  sessionId: 'tf007f-test-session',
  file: {
    name: 'payload.bin',
    byteLength: 10 * 1024 * 1024,
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  },
  transport: {
    tileCount: 3,
    matrixSize: 160,
    payloadBytesPerTile: 2436,
    opticalSymbolHz: 15,
    displayRefreshHz: 60,
    holdRefreshes: 4,
    fountainSourceBlockBytes: 1024,
    fountainSeed: 20260907,
  },
  flags: {compressed: false, encrypted: false, fountain: true},
};

test('OLTP manifest encodes deterministically and round-trips', () => {
  const first = encodeManifest(manifest);
  const second = encodeManifest(manifest);
  assert.deepEqual(first, second);
  assert.deepEqual(decodeManifest(first), manifest);
  assert.ok(first.length < 1024, `manifest should stay compact, got ${first.length} bytes`);
});

test('manifest is repeated periodically instead of relying on frame zero', () => {
  assert.deepEqual(manifestRepeatSchedule({dataSymbols: 120, repeatEvery: 30}), [0, 30, 60, 90, 120]);
});

test('bounded observation queue decouples capture from decode without reordering', () => {
  const queue = new BoundedObservationQueue<{sequence: number}>({capacity: 3, overflow: 'drop-oldest'});
  for (let sequence = 1; sequence <= 6; sequence += 1) queue.push({sequence});
  assert.equal(queue.dropped, 3);
  assert.deepEqual([queue.shift(), queue.shift(), queue.shift()].map(item => item?.sequence), [4, 5, 6]);
  assert.equal(queue.shift(), undefined);
});

test('3×160 symbol hold candidates preserve >100 KB/s gross at 15 Hz', () => {
  const plan10 = buildSymbolHoldPlan({displayRefreshHz: 60, desiredSymbolHz: 10});
  const plan12 = buildSymbolHoldPlan({displayRefreshHz: 60, desiredSymbolHz: 12});
  const plan15 = buildSymbolHoldPlan({displayRefreshHz: 60, desiredSymbolHz: 15});
  assert.deepEqual(plan10, {holdRefreshes: 6, actualSymbolHz: 10});
  assert.deepEqual(plan12, {holdRefreshes: 5, actualSymbolHz: 12});
  assert.deepEqual(plan15, {holdRefreshes: 4, actualSymbolHz: 15});
  assert.equal(theoreticalGrossBytesPerSecond({tileCount: 3, payloadBytesPerTile: 2436, opticalSymbolHz: 15}), 109620);
  assert.ok(theoreticalGrossBytesPerSecond({tileCount: 3, payloadBytesPerTile: 2436, opticalSymbolHz: 15}) > 100000);
});
