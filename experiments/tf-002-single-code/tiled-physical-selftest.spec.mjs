import {test,expect} from '@playwright/test';

test('TF-007 physical pipeline survives camera orientation normalization and pixel-only decode', async ({page}) => {
  await page.goto('/tiled-physical-selftest.html');
  await page.waitForFunction(() => window.__TF007_PHYSICAL_SELFTEST__?.done === true, null, {timeout: 120000});
  const result = await page.evaluate(() => window.__TF007_PHYSICAL_SELFTEST__);
  console.log(JSON.stringify(result, null, 2));
  expect(result.pass).toBe(true);
  expect(result.results).toHaveLength(4);
  for (const scenario of result.results) {
    expect(scenario.trainingPass, scenario.scenario).toBe(true);
    expect(scenario.trainingErrors, scenario.scenario).toEqual([0,0,0]);
    expect(scenario.dynamic.map(row => [row.matrix,row.pass]), scenario.scenario).toEqual([[80,true],[96,true],[112,true],[120,true]]);
  }
});