import test from 'node:test';
import assert from 'node:assert/strict';
import {modelBufferedThroughput, minimumDecodeSymbolsPerSecondForGoodput} from './buffered-throughput-model.ts';

test('buffering preserves capture but does not falsely inflate E2E goodput', () => {
  const model = modelBufferedThroughput({
    totalSymbols: 150,
    bytesPerSymbol: 3028 * 3,
    captureSymbolHz: 15,
    decodeSymbolsPerSecond: 5,
  });
  assert.equal(model.captureSeconds, 10);
  assert.equal(model.decodedDuringCapture, 50);
  assert.equal(model.backlogSymbols, 100);
  assert.equal(model.postCaptureDecodeSeconds, 20);
  assert.equal(model.e2eSeconds, 30);
  assert.equal(model.opticalCaptureIngressBytesPerSecond, 136260);
  assert.equal(model.e2eNetGoodputUpperBoundBytesPerSecond, 45420);
});

test('candidate density translates into an explicit minimum decode rate for 100 KB/s', () => {
  const target = 100000;
  assert.ok(Math.abs(minimumDecodeSymbolsPerSecondForGoodput({targetBytesPerSecond: target, bytesPerSymbol: 2436 * 3}) - 13.6836) < 0.001);
  assert.ok(Math.abs(minimumDecodeSymbolsPerSecondForGoodput({targetBytesPerSecond: target, bytesPerSymbol: 3028 * 3}) - 11.0084) < 0.001);
  assert.ok(Math.abs(minimumDecodeSymbolsPerSecondForGoodput({targetBytesPerSecond: target, bytesPerSymbol: 3684 * 3}) - 9.0481) < 0.001);
  assert.ok(Math.abs(minimumDecodeSymbolsPerSecondForGoodput({targetBytesPerSecond: target, bytesPerSymbol: 6036 * 3}) - 5.5224) < 0.001);
});
