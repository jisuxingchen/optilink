import {mkdirSync,writeFileSync} from 'node:fs';
import {test,expect} from '@playwright/test';

test('TF-007 physical pipeline survives camera orientation normalization and same-density optical preamble calibration', async ({page}) => {
  await page.goto('/tiled-physical-selftest.html');
  await page.waitForFunction(() => window.__TF007_PHYSICAL_SELFTEST__?.done === true, null, {timeout: 120000});
  const result = await page.evaluate(() => window.__TF007_PHYSICAL_SELFTEST__);
  console.log(JSON.stringify(result, null, 2));
  mkdirSync('results',{recursive:true});
  writeFileSync('results/tiled-carrier-physical-selftest.json',JSON.stringify(result,null,2));
  expect(result.pass).toBe(true);
  expect(result.results).toHaveLength(4);
  for (const scenario of result.results) {
    expect(scenario.orientationPass, scenario.scenario).toBe(true);
    expect(scenario.orientationErrors, scenario.scenario).toEqual([0,0,0]);
    expect(
      scenario.densities.map(row => [row.matrix,row.preamblePass,row.preambleErrors,row.dynamicPass]),
      scenario.scenario,
    ).toEqual([
      [80,true,[0,0,0],true],
      [96,true,[0,0,0],true],
      [112,true,[0,0,0],true],
      [120,true,[0,0,0],true],
    ]);
  }
});
