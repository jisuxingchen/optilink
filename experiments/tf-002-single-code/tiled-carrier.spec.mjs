import {mkdir, writeFile} from 'node:fs/promises';
import {expect, test} from '@playwright/test';

async function collect(page, mode) {
  await page.goto(`/tiled-carrier.html?autorun=${mode}`);
  await page.waitForFunction(() => window.__tiledCarrierResult?.status === 'complete' || window.__tiledCarrierResult?.status === 'error', null, {timeout: 350_000});
  const result = await page.evaluate(() => window.__tiledCarrierResult);
  await mkdir('results', {recursive: true});
  await writeFile(`results/tiled-carrier-${mode}.json`, JSON.stringify(result, null, 2));
  console.log(`TF-007 ${mode} summary:`, JSON.stringify({rows: result.rows.length, selected: result.selected, stableAtOrAbove100KBps: result.stableAtOrAbove100KBps}, null, 2));
  return result;
}

function assertIsolation(result) {
  expect(result.status, result.error || 'TF-007 failed').toBe('complete');
  expect(result.frame).toEqual({width: 1920, height: 1080, orientation: 'landscape'});
  expect(result.isolation.receiverInput).toBe('ImageData pixels only');
  expect(result.isolation.senderPayloadPassedToReceiver).toBe(false);
  expect(result.isolation.senderCellsPassedToReceiver).toBe(false);
  expect(result.isolation.senderFrameObjectsPassedToReceiver).toBe(false);
  expect(result.isolation.senderExactGeometryPassedToReceiver).toBe(false);
  expect(result.isolation.benchmarkOracleSeparatedFromReceiver).toBe(true);
  expect(result.rows.reduce((sum, row) => sum + row.oracleMismatches, 0), 'CRC-valid optical decodes must never silently return the wrong payload').toBe(0);
}

test('TF-007 quick gate exercises full-frame independent tiled decode', async ({page}) => {
  const result = await collect(page, 'quick');
  assertIsolation(result);
  expect(result.rows.length).toBeGreaterThanOrEqual(10);
  expect(result.rows.some(row => row.tileCount === 1 && row.matrixSize === 80 && row.scenario === 'clean' && row.validRatio >= 0.99), 'single-tile reference must remain deterministic in clean pixels').toBe(true);
  expect(result.rows.some(row => row.tileCount >= 2 && row.validRatio >= 0.99 && row.trackedTiles > 0), 'at least one multi-tile point must acquire and then reuse pixel-derived locks').toBe(true);
});

test('TF-007 broad sweep maps 1-4 tiles, 80/96 cells and 24-60 Hz', async ({page}) => {
  const result = await collect(page, 'full');
  assertIsolation(result);
  expect(result.rows.length).toBe(96);
  for (const tiles of [1, 2, 3, 4]) expect(result.rows.some(row => row.tileCount === tiles), `missing ${tiles}-tile rows`).toBe(true);
  for (const matrix of [80, 96]) expect(result.rows.some(row => row.matrixSize === matrix), `missing ${matrix} matrix rows`).toBe(true);
  for (const hz of [24, 30, 45, 60]) expect(result.rows.some(row => row.targetHz === hz), `missing ${hz} Hz rows`).toBe(true);
  expect(result.rows.some(row => row.scenario === 'stress')).toBe(true);
});

test('TF-007 multi-seed soak measures >100 KB/s-capable layouts without assuming they pass', async ({page}) => {
  const result = await collect(page, 'soak');
  assertIsolation(result);
  expect(result.rows.length).toBe(9);
  expect(result.rows.every(row => row.attemptedFrames === 20), 'soak must use 20 independent optical frames per scenario').toBe(true);
  expect(result.rows.some(row => row.theoreticalGrossBytesPerSecond > 100000), 'soak must include monochrome layouts with >100 KB/s gross capacity').toBe(true);
  expect(result.rows.some(row => row.tileCount >= 3), 'soak must exercise spatial parallelism beyond two tiles').toBe(true);
});

test('TF-007 physical v2 orientation model decodes portrait and inverted camera rasters from pixels', async ({page}) => {
  await page.goto('/tiled-physical-selftest.html');
  await page.waitForFunction(() => window.__TF007_PHYSICAL_SELFTEST__?.done === true, null, {timeout: 120_000});
  const result = await page.evaluate(() => window.__TF007_PHYSICAL_SELFTEST__);
  console.log('TF-007 physical pipeline self-test:', JSON.stringify(result, null, 2));
  expect(result.pass).toBe(true);
  expect(result.results).toHaveLength(4);
  for (const scenario of result.results) {
    expect(scenario.trainingPass, scenario.scenario).toBe(true);
    expect(scenario.trainingErrors, scenario.scenario).toEqual([0, 0, 0]);
    expect(scenario.dynamic.map(row => [row.matrix, row.pass]), scenario.scenario).toEqual([[80, true], [96, true], [112, true], [120, true]]);
  }
});
