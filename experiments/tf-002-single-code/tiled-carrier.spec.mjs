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

test('TF-007 multi-seed soak measures >100 KB/s-capable layouts without assuming they pass', async ({page}) => {
  const result = await collect(page, 'soak');
  assertIsolation(result);
  expect(result.rows.length).toBe(9);
  expect(result.rows.every(row => row.attemptedFrames === 20), 'soak must use 20 independent optical frames per scenario').toBe(true);
  expect(result.rows.some(row => row.theoreticalGrossBytesPerSecond > 100000), 'soak must include monochrome layouts with >100 KB/s gross capacity').toBe(true);
  expect(result.rows.some(row => row.tileCount >= 3), 'soak must exercise spatial parallelism beyond two tiles').toBe(true);
});
