import {mkdir, writeFile} from 'node:fs/promises';
import {expect, test} from '@playwright/test';

test('TF-005 quick carrier bench is pixel-isolated and clean-channel stable', async ({page}) => {
  await page.goto('/carrier-bench.html?autorun=quick');
  await page.waitForFunction(() => window.__carrierBenchResult?.status === 'complete' || window.__carrierBenchResult?.status === 'error', null, {timeout: 170_000});
  const result = await page.evaluate(() => window.__carrierBenchResult);
  expect(result.status, result.error || 'carrier bench failed').toBe('complete');
  expect(result.isolation.receiverInput).toBe('ImageData pixels only');
  expect(result.isolation.senderPayloadPassedToReceiver).toBe(false);
  expect(result.isolation.senderCellsPassedToReceiver).toBe(false);
  expect(result.isolation.benchmarkOracleSeparatedFromReceiver).toBe(true);

  for (const carrier of ['standard-qr', 'optigrid-v0', 'optigrid-v1']) {
    const clean = result.rows.filter(row => row.carrier === carrier && row.scenario === 'clean');
    expect(clean.length, `missing clean rows for ${carrier}`).toBeGreaterThan(0);
    expect(Math.max(...clean.map(row => row.validRatio)), `${carrier} has no stable clean pixel roundtrip`).toBeGreaterThanOrEqual(0.99);
  }

  expect(result.rows.reduce((sum, row) => sum + row.oracleMismatches, 0), 'decoded pixels must reproduce sender payload exactly').toBe(0);

  await mkdir('results', {recursive: true});
  await writeFile('results/carrier-bench-headless.json', JSON.stringify(result, null, 2));
  console.log('TF-005 selected candidates:', JSON.stringify(result.selected, null, 2));
});
