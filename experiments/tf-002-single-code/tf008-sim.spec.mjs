/**
 * TF-008 PC/browser pixel simulation regression (SIMULATION EVIDENCE ONLY).
 *
 * Drives the real sender page through a headless browser, captures the rendered
 * sender framebuffer as pixels, wraps it into the Mini Program's portrait camera
 * geometry (720x1280 RGBA) in all four placements, and runs the SAME
 * acquireOrientation() optical-core path the Mini Program uses.
 *
 * Writes machine-readable evidence to artifacts/tf008-sim/latest.json.
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

const PRIMARY = ['A-native-letterbox', 'B-rotate180-letterbox', 'C-rotateCW-content', 'D-rotateCCW-content'];

test('TF-008 browser pixel simulation: real sender → portrait camera frames → 3/3 exact orientation', async ({page}) => {
  await page.goto('/tf008-sim-harness.html');
  await page.waitForFunction(
    () => (window.__TF008_SIM__ && (window.__TF008_SIM__.done === true || window.__TF008_SIM__.error)) === true,
    null,
    {timeout: 180_000},
  );
  const result = await page.evaluate(() => window.__TF008_SIM__);

  console.log(JSON.stringify(result, null, 2));

  // The harness must have actually completed (no render/capture failure).
  expect(result.done, JSON.stringify(result && result.error)).toBe(true);
  expect(result.error, 'harness error').toBeUndefined();

  // Real sender page was used, no coordinator, rendered pixels only.
  expect(result.senderEntry).toBe('/tf-008-orientation-sender.html');
  expect(result.noCoordinatorConfirmed).toBe(true);
  expect(result.capture.method).toContain('getImageData');
  expect(result.capture.width).toBe(1920);
  expect(result.capture.height).toBe(1080);
  expect(result.networkPayloadPath).toBe('NONE');
  expect(result.oracleInputs).toEqual([]);

  // Primary transform matrix (Task 4 acceptance): 3/3 exact, trusted triplet.
  const byId = new Map(result.cases.map((c) => [c.id, c]));
  for (const id of PRIMARY) {
    const c = byId.get(id);
    expect(c, `missing case ${id}`).toBeTruthy();
    const r = c.result;
    expect(r.pass, `${id} pass flag`).toBe(true);
    expect(r.selectedTransform, `${id} selectedTransform`).toBe(c.expectedTransform);
    expect(r.validTripletMarkerCount, `${id} 3 macro markers`).toBe(3);
    expect(r.detectedMarkerComponentCount, `${id} dark components`).toBeGreaterThanOrEqual(3);
    expect(r.tripletValid, `${id} tripletValid`).toBe(true);
    expect(r.support, `${id} support`).toBe('triplet');
    expect(r.lockMode, `${id} lockMode`).toBe('triplet-seeded');
    expect(r.exactTiles, `${id} exactTiles`).toBe(3);
    expect(r.tileCount, `${id} tileCount`).toBe(3);
    expect(r.locked, `${id} locked`).toBe(true);
    expect(r.projection, `${id} projection`).toBe(true);
    expect(r.bitErrors, `${id} bitErrors`).toEqual([0, 0, 0]);
  }

  // Robustness variants (non-primary) must still lock 3/3 exact on the trusted
  // triplet; only their selectedTransform is not asserted (framing perturbation).
  for (const c of result.cases) {
    if (PRIMARY.includes(c.id)) continue;
    const r = c.result;
    expect(r.locked, `${c.id} locked`).toBe(true);
    expect(r.exactTiles, `${c.id} exactTiles`).toBe(3);
    expect(r.tripletValid, `${c.id} tripletValid`).toBe(true);
    expect(r.support, `${c.id} support`).toBe('triplet');
    expect(r.bitErrors, `${c.id} bitErrors`).toEqual([0, 0, 0]);
  }

  // Primary cases must be 3/3 exact overall.
  expect(result.summary.primaryPassed).toBe(4);

  // Artifact output (SIMULATION EVIDENCE ONLY).
  const artifact = {
    evidenceClass: 'SIMULATED BROWSER PIXEL TF-008 ACQUISITION',
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(),
    senderEntry: result.senderEntry,
    capture: result.capture,
    inputFrame: result.inputFrame,
    networkPayloadPath: result.networkPayloadPath,
    oracleInputs: result.oracleInputs,
    summary: result.summary,
    cases: result.cases.map((c) => ({
      case: c.id,
      placement: c.placement,
      inputFrameSize: result.inputFrame.width + 'x' + result.inputFrame.height,
      expectedTransform: c.expectedTransform,
      selectedTransform: c.result.selectedTransform,
      orientationMode: c.result.orientationMode,
      detectedMarkerComponentCount: c.result.detectedMarkerComponentCount,
      validTripletMarkerCount: c.result.validTripletMarkerCount,
      tripletValid: c.result.tripletValid,
      support: c.result.support,
      lockMode: c.result.lockMode,
      exactTiles: c.result.exactTiles,
      tileCount: c.result.tileCount,
      projection: c.result.projection,
      locked: c.result.locked,
      bitErrors: c.result.bitErrors,
      transformCandidates: c.result.transformCandidates,
      profile: c.result.profile,
      wallMs: c.result.wallMs,
      pass: c.result.pass,
    })),
    timingNote: 'DESKTOP / SIMULATION timing only — not representative of phone performance.',
  };

  mkdirSync('artifacts/tf008-sim', {recursive: true});
  writeFileSync('artifacts/tf008-sim/latest.json', JSON.stringify(artifact, null, 2));
  console.log('artifact written to artifacts/tf008-sim/latest.json');
});
