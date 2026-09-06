import {mkdir, writeFile} from 'node:fs/promises';
import {expect, test} from '@playwright/test';

async function collect(page, mode) {
  await page.goto(`/carrier-bench.html?autorun=${mode}`);
  await page.waitForFunction(() => window.__carrierBenchResult?.status === 'complete' || window.__carrierBenchResult?.status === 'error', null, {timeout: 170_000});
  const result = await page.evaluate(() => window.__carrierBenchResult);
  await mkdir('results', {recursive: true});
  await writeFile(`results/carrier-bench-${mode}.json`, JSON.stringify(result, null, 2));
  console.log(`TF-005 ${mode} summary:`, JSON.stringify({rowCount: result.rows.length, selected: result.selected}, null, 2));
  return result;
}

async function collectFrontier(page, mode) {
  await page.goto(`/carrier-frontier.html?autorun=${mode}`);
  await page.waitForFunction(() => window.__carrierFrontierResult?.status === 'complete' || window.__carrierFrontierResult?.status === 'error', null, {timeout: 330_000});
  const result = await page.evaluate(() => window.__carrierFrontierResult);
  await mkdir('results', {recursive: true});
  await writeFile(`results/carrier-frontier-${mode}.json`, JSON.stringify(result, null, 2));
  console.log(`TF-005 frontier ${mode} summary:`, JSON.stringify({
    rowCount: result.rows.length,
    selected: result.selected,
    stableAtOrAbove100KBps: result.stableAtOrAbove100KBps,
  }, null, 2));
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
  expect(result.sampling).toBe('subpixel bilinear 5-point majority');
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

test('TF-005 high-density soak selects measured robust >100 KB/s pixel-sim candidates', async ({page}) => {
  const result = await collectFrontier(page, 'soak');
  assertFrontierIsolation(result);
  expect(result.rows.length, 'soak must cover 160/200/240 across clean/mild/stress').toBe(9);
  expect(result.rows.every(row => row.attemptedFrames === 48), 'every soak row must exercise 48 independently-seeded frames').toBe(true);
  expect(result.rows.reduce((sum, row) => sum + row.oracleMismatches, 0), 'soak must never silently decode wrong payload').toBe(0);

  const winners = result.stableAtOrAbove100KBps;
  expect(winners.length, 'soak must retain at least two measured >100 KB/s candidates instead of assuming a specific density wins').toBeGreaterThanOrEqual(2);
  expect(winners.some(row => row.matrixSize === 160 && row.targetHz === 60), '160x160 @60 is the conservative high-density gate and must remain stable').toBe(true);
  expect(winners.some(row => row.matrixSize === 240 && row.targetHz === 60), '240x240 @60 must retain the high-capacity pixel-sim margin through soak').toBe(true);

  // 200x200 @960 is intentionally not asserted as a winner: the 48-frame
  // stress soak exposed a raster/alignment resonance that the earlier 6-frame
  // sweep did not. Preserve that evidence rather than weakening the channel.
  const stress200 = result.rows.find(row => row.matrixSize === 200 && row.scenario === 'stress');
  expect(stress200, 'soak must keep measuring the 200x200 stress point').toBeTruthy();
  expect(stress200.oracleMismatches).toBe(0);
});
