import {mkdir, writeFile} from 'node:fs/promises';
import {expect, test} from '@playwright/test';

test('TF-007 temporal bench measures rolling-shutter loss without payload shortcuts', async ({page}) => {
  await page.goto('/tiled-temporal.html?autorun=1');
  await page.waitForFunction(() => window.__tiledTemporalResult?.status === 'complete' || window.__tiledTemporalResult?.status === 'error', null, {timeout: 350_000});
  const result = await page.evaluate(() => window.__tiledTemporalResult);
  await mkdir('results', {recursive: true});
  await writeFile('results/tiled-temporal.json', JSON.stringify(result, null, 2));
  console.log('TF-007 temporal summary:', JSON.stringify({selected: result.selected}, null, 2));

  expect(result.status, result.error || 'temporal bench failed').toBe('complete');
  expect(result.isolation.receiverInput).toBe('ImageData pixels only');
  expect(result.isolation.senderPayloadPassedToReceiver).toBe(false);
  expect(result.isolation.senderCellsPassedToReceiver).toBe(false);
  expect(result.isolation.senderFrameObjectsPassedToReceiver).toBe(false);
  expect(result.isolation.senderExactGeometryPassedToReceiver).toBe(false);
  expect(result.rows.length).toBe(12);
  expect(result.rows.every(row => row.cameraFrames === 30)).toBe(true);
  expect(result.rows.reduce((sum, row) => sum + row.oracleMismatches, 0)).toBe(0);
  expect(result.rows.some(row => row.readoutFraction === 0 && row.validTileRatio >= 0.99), 'zero-readout spatial control should retain an exact candidate').toBe(true);
  expect(result.rows.some(row => row.readoutFraction > 0 && row.mixedCameraFrames > 0), 'rolling-shutter profiles must actually generate mixed optical frames').toBe(true);
});
