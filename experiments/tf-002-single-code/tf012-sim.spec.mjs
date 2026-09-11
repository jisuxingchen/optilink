/**
 * TF-012 real-time software frame-cadence stress test (SIMULATION ONLY).
 * Drives the real standalone broadcast sender, runs the bounded
 * producer/consumer pipeline at 15/20/30 FPS, and writes machine-readable
 * evidence to artifacts/tf012-sim/latest.json.
 */
import {execSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {test, expect} from '@playwright/test';

function gitHead() {
  try {
    return execSync('git rev-parse HEAD', {encoding: 'utf8'}).trim();
  } catch {
    return 'unknown';
  }
}

test('TF-012 real-time frame-cadence stress (15/20/30 FPS, bounded pipeline)', async ({page}) => {
  await page.goto('/tf012-sim-harness.html');
  await page.waitForFunction(
    () => (window.__TF012_SIM__ && (window.__TF012_SIM__.done === true || window.__TF012_SIM__.error)) === true,
    null,
    {timeout: 600_000},
  );
  const result = await page.evaluate(() => window.__TF012_SIM__);
  console.log(JSON.stringify(result, null, 2));

  expect(result.done, JSON.stringify(result && result.error)).toBe(true);
  expect(result.error, 'harness error').toBeUndefined();
  expect(result.networkPayloadPath).toBe('NONE');
  expect(result.oracleInputs).toEqual([]);

  // Phase 3: beacon gate has zero false positives / negatives.
  expect(result.beaconGate.falsePositives, 'beacon gate false positives').toBe(0);
  expect(result.beaconGate.falseNegatives, 'beacon gate false negatives').toBe(0);
  expect(result.beaconGate.nonBeaconSamples).toBeGreaterThan(0);
  expect(result.beaconGate.beaconSamples).toBeGreaterThan(0);

  // Phase 1: budget inventory present with per-stage summaries.
  for (const key of ['wrapMs', 'beaconProbeAcceptMs', 'beaconProbeRejectMs', 'orientationFiducialMs', 'preambleLockMs', 'manifestDecodeMs', 'dynamicDecodeMs', 'checkpointMs', 'reconstructMs', 'sha256Ms']) {
    expect(result.budgetInventory[key], `budget inventory ${key}`).toBeTruthy();
    expect(result.budgetInventory[key].n, `budget inventory ${key} n`).toBeGreaterThan(0);
  }

  // Phase 7: three cadence runs, all complete with exact SHA and bounded queue.
  const runs = result.fpsRuns;
  expect(runs.length).toBe(3);
  const fpsSet = new Set(runs.map(r => r.targetFps));
  for (const fps of [15, 20, 30]) expect(fpsSet.has(fps), `run at ${fps} FPS`).toBe(true);
  for (const r of runs) {
    expect(r.complete, `${r.targetFps} FPS completes`).toBe(true);
    expect(r.shaMatch, `${r.targetFps} FPS shaMatch`).toBe(true);
    expect(r.reconstructedSha).toMatch(/^[0-9a-f]{64}$/);
    expect(r.maxQueueDepth, `${r.targetFps} FPS bounded queue`).toBeLessThanOrEqual(1);
    expect(r.producerFrames, `${r.targetFps} FPS producer`).toBeGreaterThan(0);
    expect(r.processedFrames, `${r.targetFps} FPS processed`).toBeGreaterThan(0);
    expect(typeof r.usefulSymbolRate, `${r.targetFps} useful symbol rate`).toBe('number');
  }

  expect(result.summary.allComplete).toBe(true);
  expect(result.summary.allShaMatch).toBe(true);
  expect(result.summary.allBounded).toBe(true);

  const artifact = {
    evidenceClass: 'SIMULATED REAL-TIME FRAME-CADENCE STRESS',
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(),
    senderEntry: result.senderEntry,
    replayEvery: result.replayEvery,
    acquisitionBeacon: result.acquisitionBeacon,
    boundedModel: result.boundedModel,
    networkPayloadPath: result.networkPayloadPath,
    oracleInputs: result.oracleInputs,
    beaconGate: result.beaconGate,
    budgetInventory: result.budgetInventory,
    fpsRuns: result.fpsRuns,
    summary: result.summary,
    timings: result.timings,
    note: 'SIMULATION EVIDENCE ONLY. Not physical raw optical ingress. Not Net Goodput.',
  };

  mkdirSync('artifacts/tf012-sim', {recursive: true});
  writeFileSync('artifacts/tf012-sim/latest.json', JSON.stringify(artifact, null, 2));
  console.log('artifact written to artifacts/tf012-sim/latest.json');
});
