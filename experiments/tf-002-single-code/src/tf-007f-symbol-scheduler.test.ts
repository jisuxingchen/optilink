import test from 'node:test';
import assert from 'node:assert/strict';
import {SymbolObservationScheduler} from './symbol-observation-scheduler.ts';

test('60 fps camera yields about one stable observation per 15 Hz optical symbol', () => {
  const scheduler = new SymbolObservationScheduler({sessionStartMs: 0, symbolHz: 15});
  const captured: number[] = [];
  for (let frame = 0; frame < 60; frame += 1) {
    const timestampMs = frame * (1000 / 60);
    const decision = scheduler.consider(timestampMs);
    if (decision.capture) captured.push(decision.symbolIndex);
  }
  assert.deepEqual(captured, Array.from({length: 15}, (_, index) => index));
});

test('scheduler exposes skipped symbols instead of hiding a capture stall', () => {
  const scheduler = new SymbolObservationScheduler({sessionStartMs: 0, symbolHz: 15});
  assert.equal(scheduler.consider(40).capture, true); // symbol 0 center
  const afterStall = scheduler.consider(240); // symbol 3 after center
  assert.equal(afterStall.capture, true);
  assert.equal(afterStall.symbolIndex, 3);
  assert.equal(afterStall.skippedSymbols, 2);
});
