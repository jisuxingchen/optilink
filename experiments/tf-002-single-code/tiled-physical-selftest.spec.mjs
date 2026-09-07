import {mkdirSync,writeFileSync} from 'node:fs';
import {test,expect} from '@playwright/test';

test('TF-007 separates inset acquisition robustness from nominal high-density exactness', async ({page}) => {
  await page.goto('/tiled-physical-selftest.html');
  await page.waitForFunction(() => window.__TF007_PHYSICAL_SELFTEST__?.done === true, null, {timeout: 120000});
  const result = await page.evaluate(() => window.__TF007_PHYSICAL_SELFTEST__);
  console.log(JSON.stringify(result, null, 2));
  mkdirSync('results',{recursive:true});
  writeFileSync('results/tiled-carrier-physical-selftest.json',JSON.stringify(result,null,2));

  expect(result.acquisitionPass).toBe(true);
  expect(result.densityControlPass).toBe(true);
  expect(result.pass).toBe(true);

  const stress=result.results.filter(row=>row.profile==='acquisition-stress');
  const controls=result.results.filter(row=>row.profile==='density-control');
  expect(stress).toHaveLength(4);
  expect(controls).toHaveLength(1);

  for(const scenario of stress){
    expect(scenario.orientationPass,scenario.scenario).toBe(true);
    expect(scenario.orientationErrors,scenario.scenario).toEqual([0,0,0]);
    for(const density of scenario.densities){
      expect(density.preambleAcquired,`${scenario.scenario} ${density.matrix}`).toBe(3);
      expect(density.locatorPass,`${scenario.scenario} ${density.matrix} locator`).toBe(true);
      if(density.matrix<=96){
        expect(density.preamblePass,`${scenario.scenario} ${density.matrix} exact`).toBe(true);
        expect(density.preambleErrors,`${scenario.scenario} ${density.matrix}`).toEqual([0,0,0]);
        expect(density.dynamicTested).toBe(true);
        expect(density.dynamicPass,`${scenario.scenario} ${density.matrix} dynamic`).toBe(true);
      }else{
        expect(density.dynamicTested).toBe(false);
        expect(density.dynamicPass).toBe(null);
      }
    }
  }

  for(const scenario of controls){
    expect(scenario.orientationPass,scenario.scenario).toBe(true);
    expect(scenario.orientationErrors,scenario.scenario).toEqual([0,0,0]);
    expect(
      scenario.densities.map(row=>[row.matrix,row.preamblePass,row.preambleErrors,row.dynamicPass]),
      scenario.scenario,
    ).toEqual([
      [80,true,[0,0,0],true],
      [96,true,[0,0,0],true],
      [112,true,[0,0,0],true],
      [120,true,[0,0,0],true],
    ]);
  }
});