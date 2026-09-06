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

async function collectFrontier(page, mode) {
  await page.goto(`/carrier-frontier.html?autorun=${mode}`);
  await page.waitForFunction(() => window.__carrierFrontierResult?.status === 'complete' || window.__carrierFrontierResult?.status === 'error', null, {timeout: 330_000});
  const result = await page.evaluate(() => window.__carrierFrontierResult);
  await mkdir('results', {recursive: true});
  await writeFile(`results/carrier-frontier-${mode}.json`, JSON.stringify(result, null, 2));
  console.log(`TF-005 frontier ${mode} selected:`, JSON.stringify(result.selected, null, 2));
  console.log(`TF-005 frontier ${mode} >=100KB/s:`, JSON.stringify(result.stableAtOrAbove100KBps, null, 2));
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

function assertFrontierIsolation(result) {
  assertIsolation(result);
  expect(result.isolation.senderFrameObjectsPassedToReceiver).toBe(false);
  expect(result.isolation.geometryStateDerivedFromReceiverPixelsOnly).toBe(true);
  expect(result.pipeline).toBe('acquisition -> tracking -> fast decode');
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

test('TF-005 tracked quick gate separates acquisition from sustained decode', async ({page}) => {
  const result = await collectFrontier(page, 'quick');
  assertFrontierIsolation(result);
  expect(result.rows.length).toBeGreaterThanOrEqual(18);
  expect(result.rows.some(row => row.validRatio >= 0.99 && row.acquisitionCount >= 1), 'at least one tracked carrier must acquire and decode perfectly').toBe(true);
  expect(result.rows.some(row => row.trackedFrames >= 4), 'tracking must actually reuse receiver-derived geometry across frames').toBe(true);
  expect(result.rows.some(row => row.validRatio >= 0.99 && row.fastDecodeP95Ms > 0 && row.acquisitionP95Ms > row.fastDecodeP95Ms), 'at least one stable point should make sustained decode cheaper than acquisition').toBe(true);
});

test('TF-005 frontier sweep maps 120-240 and 24-60 Hz before phone testing', async ({page}) => {
  const result = await collectFrontier(page, 'frontier');
  assertFrontierIsolation(result);
  expect(result.rows.length, 'frontier sweep should collect the full matrix').toBeGreaterThanOrEqual(160);
  expect(result.ranking.length).toBeGreaterThanOrEqual(50);
  expect(result.rows.some(row => row.matrixSize === 240), 'frontier must include 240x240').toBe(true);
  expect(result.rows.some(row => row.targetHz === 60), 'frontier must include 60 Hz').toBe(true);
  expect(result.rows.some(row => row.renderPixels === 720) && result.rows.some(row => row.renderPixels === 960), 'frontier must compare sender raster sizes').toBe(true);
  expect(result.rows.some(row => row.validRatio >= 0.99 && row.trackedFrames >= 4), 'frontier must retain at least one stable tracked point').toBe(true);
});
