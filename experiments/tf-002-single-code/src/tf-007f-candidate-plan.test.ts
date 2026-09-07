import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTf007fCandidatePlan} from './tf-007f-candidate-plan.ts';

test('TF-007F plan keeps 96 control and adds low-rate high-capacity candidates', () => {
  const plan = buildTf007fCandidatePlan(60);
  const control = plan.find(item => item.matrixSize === 96);
  assert.ok(control);
  assert.equal(control.role, 'control');
  assert.equal(control.actualSymbolHz, 15);
  assert.equal(control.holdRefreshes, 4);

  const p160 = plan.find(item => item.matrixSize === 160 && item.actualSymbolHz === 15);
  const p176 = plan.find(item => item.matrixSize === 176 && item.actualSymbolHz === 15);
  const p192 = plan.find(item => item.matrixSize === 192 && item.actualSymbolHz === 15);
  assert.equal(p160?.payloadBytesPerTile, 2436);
  assert.equal(p160?.theoreticalGrossBytesPerSecond, 109620);
  assert.equal(p176?.payloadBytesPerTile, 3028);
  assert.equal(p176?.theoreticalGrossBytesPerSecond, 136260);
  assert.equal(p192?.payloadBytesPerTile, 3684);
  assert.equal(p192?.theoreticalGrossBytesPerSecond, 165780);
  assert.ok((p176?.theoreticalGrossBytesPerSecond ?? 0) > 120000, '176 should preserve margin above 100 KB/s');
  assert.ok((p192?.theoreticalGrossBytesPerSecond ?? 0) > 150000, '192 should provide a high-margin desktop candidate');
});
