import {mkdir, writeFile} from 'node:fs/promises';
import {expect, test} from '@playwright/test';

async function collect(page, mode) {
  await page.goto(`/carrier-bench.html?autorun=${mode}`);
  await page.waitForFunction(() => window.__carrierBenchResult?.status === 'complete' || window.__carrierBenchResult?.status === 'error', null, {timeout: 170_000});
  const result = await page.evaluate(() => window.__carrierBenchResult);
  await mkdir('results', {recursive: true});
  await writeFile(`results/carrier-bench-${mode}.json`, JSON.stringify(result, null, 2));
  console.log(`TF-005 ${mode} rows:`, JSON.stringify(result.rows, null, 2));
  console.log(`TF-005 ${mode} selected:`, JSON.stringify(result.selected, null, 2));
  return result;
}

function assertIsolation(result) {
  expect(result.status, result.error || 'carrier bench failed').toBe('complete');
  expect(result.isolation.receiverInput).toBe('ImageData pixels only');
  expect(result.isolation.senderPayloadPassedToReceiver).toBe(false);
  expect(result.isolation.senderCellsPassedToReceiver).toBe(false);
  expect(result.isolation.benchmarkOracleSeparatedFromReceiver).toBe(true);
  expect(result.rows.reduce((sum, row) => sum + row.oracleMismatches, 0), 'decoded pixels must reproduce sender payload exactly').toBe(0);
}

function bestRatio(result, carrier, scenario) {
  const rows = result.rows.filter(row => row.carrier === carrier && row.scenario === scenario);
  expect(rows.length, `missing ${scenario} rows for ${carrier}`).toBeGreaterThan(0);
  return Math.max(...rows.map(row => row.validRatio));
}

test('TF-005 quick bench preserves pixel isolation and finds a stable custom carrier', async ({page}) => {
  const result = await collect(page, 'quick');
  assertIsolation(result);

  // Standard QR is a calibration baseline, not the TF-005 winner. The pixel
  // channel intentionally includes rasterization/resampling, so it only needs
  // to remain measurably decodable rather than artificially perfect.
  expect(bestRatio(result, 'standard-qr', 'clean'), 'QR baseline should remain decodable from camera pixels').toBeGreaterThanOrEqual(0.5);

  // Custom-carrier development is allowed to proceed only when a candidate is
  // deterministic in the clean channel. v1 must also survive the mild channel
  // before it can be selected for a future physical test.
  expect(bestRatio(result, 'optigrid-v0', 'clean'), 'v0 must have at least one deterministic clean configuration').toBeGreaterThanOrEqual(0.99);
  expect(bestRatio(result, 'optigrid-v1', 'clean'), 'v1 must have at least one deterministic clean configuration').toBeGreaterThanOrEqual(0.99);
  expect(bestRatio(result, 'optigrid-v1', 'mild'), 'v1 must survive the mild pixel channel').toBeGreaterThanOrEqual(0.99);
});

test('TF-005 full sweep collects broad pixel-channel evidence', async ({page}) => {
  const result = await collect(page, 'full');
  assertIsolation(result);
  expect(result.rows.length, 'full sweep should collect a broad candidate matrix').toBeGreaterThanOrEqual(80);
  expect(result.ranking.length).toBeGreaterThan(10);
  expect(bestRatio(result, 'optigrid-v1', 'clean')).toBeGreaterThanOrEqual(0.99);
});
