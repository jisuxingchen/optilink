import {mkdirSync,writeFileSync} from 'node:fs';
import {test,expect} from '@playwright/test';

test('TF-007 macro locator survives dark/background/blur/framing torture', async ({page}) => {
  await page.goto('/tiled-locator-selftest.html');
  await page.waitForFunction(() => window.__TF007_LOCATOR_TORTURE__?.done === true, null, {timeout: 120000});
  const result = await page.evaluate(() => window.__TF007_LOCATOR_TORTURE__);
  console.log(JSON.stringify(result, null, 2));
  mkdirSync('results',{recursive:true});
  writeFileSync('results/tiled-locator-torture.json',JSON.stringify(result,null,2));

  expect(result.pass).toBe(true);
  expect(result.profile).toContain('locator-only torture');
  expect(result.results).toHaveLength(16);
  expect(result.summary.scenarios).toBe(8);
  expect(result.summary.runs).toBe(16);
  expect(result.summary.passes).toBe(16);
  expect(result.summary.minScale).toBeCloseTo(0.40, 5);
  expect(result.summary.maxBlur).toBeCloseTo(2.0, 5);
  expect(result.summary.minContrast).toBeCloseTo(0.55, 5);
  expect(result.summary.maxNoise).toBe(10);

  for (const row of result.results) {
    expect(row.triplet,`${row.name} seed=${row.seed} triplet`).toBe(true);
    expect(row.componentCount,`${row.name} seed=${row.seed} components`).toBeGreaterThanOrEqual(3);
    expect(row.centerErrorRatio,`${row.name} seed=${row.seed} center`).toBeLessThanOrEqual(0.12);
    expect(row.sideErrorRatio,`${row.name} seed=${row.seed} scale`).toBeLessThanOrEqual(0.12);
    expect(row.spacingError,`${row.name} seed=${row.seed} spacing`).toBeLessThanOrEqual(0.08);
    expect(row.locatorMs,`${row.name} seed=${row.seed} runtime`).toBeLessThanOrEqual(150);
  }
});
