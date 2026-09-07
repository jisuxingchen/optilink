import test from 'node:test';
import assert from 'node:assert/strict';
import {StableFingerprintGate} from './stable-fingerprint-gate.ts';

const fp = (bits: string) => Uint8Array.from([...bits].map(value => value === '1' ? 1 : 0));

test('stable fingerprint gate emits one observation per held symbol and ignores transition states', () => {
  const gate = new StableFingerprintGate({requiredStableFrames: 2, maxHammingRatio: 0.10});
  const frames = [
    fp('00000000'), fp('00000000'), fp('00000000'), // symbol A -> one capture
    fp('01010101'),                                  // transition, only one frame
    fp('11110000'), fp('11110000'), fp('11110000'), // symbol B -> one capture
    fp('11110001'), fp('11110000'),                  // small camera noise, no duplicate capture
  ];
  const captures: number[] = [];
  frames.forEach((frame, index) => { if (gate.consider(frame).capture) captures.push(index); });
  assert.deepEqual(captures, [1, 5]);
});

test('materially different stable symbol emits again without sender timing metadata', () => {
  const gate = new StableFingerprintGate({requiredStableFrames: 2, maxHammingRatio: 0.05});
  assert.equal(gate.consider(fp('00000000')).capture, false);
  assert.equal(gate.consider(fp('00000000')).capture, true);
  assert.equal(gate.consider(fp('11111111')).capture, false);
  assert.equal(gate.consider(fp('11111111')).capture, true);
});
