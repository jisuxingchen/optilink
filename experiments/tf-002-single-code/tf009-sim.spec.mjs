/**
 * TF-009 browser pixel end-to-end reconstruction regression (SIMULATION ONLY).
 *
 * Drives the real standalone file sender through a headless browser, captures
 * rendered pixels, runs the shared receive core (orientation → preamble →
 * Manifest → fountain symbols → reconstruction), and verifies SHA-256.
 *
 * Writes machine-readable evidence to artifacts/tf009-sim/latest.json.
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

test('TF-009 browser pixel reconstruction: real sender → pixels → orientation → Manifest → symbols → SHA-256 match', async ({page}) => {
  await page.goto('/tf009-sim-harness.html');
  await page.waitForFunction(
    () => (window.__TF009_SIM__ && (window.__TF009_SIM__.done === true || window.__TF009_SIM__.error)) === true,
    null,
    {timeout: 180_000},
  );
  const result = await page.evaluate(() => window.__TF009_SIM__);
  console.log(JSON.stringify(result, null, 2));

  expect(result.done, JSON.stringify(result && result.error)).toBe(true);
  expect(result.error, 'harness error').toBeUndefined();

  // Oracle boundary + network boundary.
  expect(result.networkPayloadPath).toBe('NONE');
  expect(result.oracleInputs).toEqual([]);

  // Orientation + Manifest recovered through pixels.
  expect(result.orientation.locked).toBe(true);
  expect(result.orientation.support).toBe('triplet');
  expect(result.orientation.exactTiles).toBe(3);
  expect(result.manifest.protocol).toBe('OLTP');
  expect(result.manifest.file.byteLength).toBe(64 * 1024);

  // Reconstruction: size + SHA-256 exact match against the OPTICAL manifest.
  expect(result.reconstruction.reconstructedSize).toBe(64 * 1024);
  expect(result.reconstruction.shaMatch).toBe(true);
  expect(result.reconstruction.reconstructedSha256).toBe(result.reconstruction.manifestSha256);
  expect(result.reconstruction.reconstructedSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.reconstruction.solvedBlocks).toBe(result.reconstruction.totalBlocks);

  // Post-decode cross-check against the known source (assertion only, read from
  // the sender AFTER reconstruction — never part of the acquisition path).
  const sourceSha = await page.evaluate(() => {
    const frame = document.getElementById('senderFrame');
    const win = frame && frame.contentWindow;
    return win && win.__TF009_SENDER__ ? win.__TF009_SENDER__.payload.sha256 : null;
  });
  expect(sourceSha, 'sender source sha available for assertion').toBeTruthy();
  expect(result.reconstruction.reconstructedSha256).toBe(sourceSha);

  // Simulated reconstructed throughput (bytes / total simulated transfer time).
  const totalSeconds = result.timings.totalMs / 1000;
  const throughputBps = totalSeconds > 0 ? (result.reconstruction.reconstructedSize / totalSeconds) : 0;

  const artifact = {
    evidenceClass: 'SIMULATED BROWSER PIXEL END-TO-END RECONSTRUCTION',
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(),
    senderEntry: result.senderEntry,
    receiverPipeline: result.receiverPipeline,
    networkPayloadPath: result.networkPayloadPath,
    oracleInputs: result.oracleInputs,
    sourcePayloadSize: 64 * 1024,
    sourceSha256: sourceSha,
    reconstructedSize: result.reconstruction.reconstructedSize,
    reconstructedSha256: result.reconstruction.reconstructedSha256,
    shaMatch: result.reconstruction.shaMatch,
    orientation: result.orientation,
    manifest: result.manifest,
    frameStats: result.frameStats,
    reconstruction: {
      solvedBlocks: result.reconstruction.solvedBlocks,
      totalBlocks: result.reconstruction.totalBlocks,
    },
    timings: result.timings,
    simulatedReconstructedThroughputBytesPerSecond: Math.round(throughputBps),
    note: 'SIMULATION EVIDENCE ONLY. Not physical raw optical ingress. Not Net Goodput.',
  };

  mkdirSync('artifacts/tf009-sim', {recursive: true});
  writeFileSync('artifacts/tf009-sim/latest.json', JSON.stringify(artifact, null, 2));
  console.log('artifact written to artifacts/tf009-sim/latest.json');
});
