import {mkdirSync,writeFileSync} from 'node:fs';
import {test,expect} from '@playwright/test';

test('TF-007F buffers stable optical observations and decodes them later', async ({page}) => {
  await page.goto('/tiled-buffered-selftest.html');
  await page.waitForFunction(() => window.__TF007F_BUFFERED_SELFTEST__?.done === true, null, {timeout: 180000});
  const result = await page.evaluate(() => window.__TF007F_BUFFERED_SELFTEST__);
  console.log(JSON.stringify(result, null, 2));
  mkdirSync('results',{recursive:true});
  writeFileSync('results/tiled-carrier-buffered-selftest.json',JSON.stringify(result,null,2));

  expect(result.pass).toBe(true);
  expect(result.evidenceClass).toBe('pixel-domain-buffered-transport-simulation');
  expect(result.trainingErrors).toEqual([0,0,0]);
  expect(result.captures).toBe(12);
  expect(result.fullSamples).toBe(12);
  expect(result.transitionCaptures).toBe(0);
  expect(result.decodedTiles).toBe(36);
  expect(result.decodedSymbols).toBe(12);
  expect(result.oracleMismatches).toBe(0);
  expect(result.holdRefreshes).toBe(4);
  expect(result.theoreticalGrossBytesPerSecond).toBe(136260);
  expect(result.theoreticalGrossBytesPerSecond).toBeGreaterThan(120000);
});
