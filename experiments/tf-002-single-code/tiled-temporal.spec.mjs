import {mkdir, writeFile} from 'node:fs/promises';
import {expect, test} from '@playwright/test';

test('TF-007 combined spatial + rolling-shutter diagnostic preserves failure evidence without silent corruption', async ({page}) => {
  await page.goto('/tiled-temporal.html?autorun=1');
  await page.waitForFunction(() => window.__tiledTemporalResult?.status === 'complete' || window.__tiledTemporalResult?.status === 'error', null, {timeout: 350_000});
  const result = await page.evaluate(() => window.__tiledTemporalResult);
  await mkdir('results', {recursive: true});
  await writeFile('results/tiled-temporal.json', JSON.stringify(result, null, 2));
  console.log('TF-007 combined-stress diagnostic summary:', JSON.stringify({selected: result.selected}, null, 2));

  expect(result.status, result.error || 'combined temporal diagnostic failed to execute').toBe('complete');
  expect(result.temporalModel.spatialProfile).toBe('combined-stress');
  expect(result.isolation.receiverInput).toBe('ImageData pixels only');
  expect(result.isolation.senderPayloadPassedToReceiver).toBe(false);
  expect(result.isolation.senderCellsPassedToReceiver).toBe(false);
  expect(result.isolation.senderFrameObjectsPassedToReceiver).toBe(false);
  expect(result.isolation.senderExactGeometryPassedToReceiver).toBe(false);
  expect(result.rows.length).toBe(12);
  expect(result.rows.every(row => row.cameraFrames === 60)).toBe(true);
  expect(result.rows.reduce((sum, row) => sum + row.oracleMismatches, 0), 'extreme synthetic stress may reject frames but must never silently decode wrong payload').toBe(0);
  expect(result.rows.some(row => row.readoutFraction > 0 && row.mixedCameraFrames > 0), 'rolling-shutter profiles must actually generate mixed optical frames').toBe(true);
  expect(result.rows.some(row => row.validTiles > 0), 'diagnostic must retain at least one measurable optical path so acquisition collapse is quantified rather than total harness failure').toBe(true);
});
