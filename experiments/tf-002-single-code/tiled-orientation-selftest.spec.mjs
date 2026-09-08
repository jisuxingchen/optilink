import {mkdirSync,writeFileSync} from 'node:fs';
import {test,expect} from '@playwright/test';

test('TF-007H rejects wrong-normal orientation and exactly repairs a near-exact residual tile', async ({page}) => {
  await page.goto('/tiled-orientation-selftest.html');
  await page.waitForFunction(() => window.__TF007H_ORIENTATION_SELFTEST__?.done === true, null, {timeout: 120000});
  const result = await page.evaluate(() => window.__TF007H_ORIENTATION_SELFTEST__);
  console.log(JSON.stringify(result,null,2));
  mkdirSync('results',{recursive:true});
  writeFileSync('results/tiled-carrier-orientation-selftest.json',JSON.stringify(result,null,2));
  expect(result.best.success).toBe(true);
  expect(result.best.errors).toEqual([0,0,0]);
  expect(result.best.projectionSafe).toBe(true);
  expect(result.unsafeFailedCandidate).toBe(true);
  expect(result.residualRefine.found).toBe(true);
  expect(result.residualRefine.before).toBeGreaterThan(0);
  expect(result.residualRefine.before).toBeLessThanOrEqual(64);
  expect(result.residualRefine.after).toBe(0);
  expect(result.pass).toBe(true);
});
