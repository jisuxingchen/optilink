/**
 * TF-012 r7 — Stage B operating window: efficiency metrics.
 *
 * WHY THIS FILE EXISTS
 *
 * The r6 Stage A ladder came back NON-MONOTONIC:
 *
 *   1500 PASS · 750 anomalous FAIL · 333 PASS · 150 PASS · 75 PASS (best) ·
 *   33 PASS but collapsed
 *
 * A single "successfulDecodes / decodeAttempts" view cannot explain that, because
 * PER-FRAME DECODER CORRECTNESS and WHOLE-FILE COLLECTION EFFICIENCY are different
 * things. At 75 ms the phone decoded 356 frames successfully to collect 16 unique
 * chunks — a unique yield near 4 %. These tests pin both views separately, and pin
 * the guards that stop a 0-denominator run from being reported as a 0 % result.
 *
 * Nothing here decides PASS. PASS remains 16/16 unique + missing == [] +
 * 10240 bytes + SHA-256 MATCH on a real phone.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_BASELINE_HOLD_MS_LADDER,
  SINGLE_BASELINE_HOLD_MS_PRESETS,
  SINGLE_BASELINE_MATRIX,
  SINGLE_BASELINE_STAGE_B_LADDER,
  SINGLE_BASELINE_TOTAL_CHUNKS,
  SingleCodeBaselineReceiver,
  buildSingleBaselineTransfer,
  renderSingleBaselineFrame,
  singleBaselineEfficiency,
} from './single-baseline.ts';

const transfer = buildSingleBaselineTransfer();

// ---------------------------------------------------------------------------
// 1. Stage B ladder + presets
// ---------------------------------------------------------------------------

test('Stage B ladder is exactly 100/90/75/60/50/40 ms', () => {
  assert.deepEqual(Array.from(SINGLE_BASELINE_STAGE_B_LADDER), [100, 90, 75, 60, 50, 40]);
});

test('Stage B deliberately excludes 125 ms and 80 ms', () => {
  for (const excluded of [125, 80]) {
    assert.ok(
      !(SINGLE_BASELINE_STAGE_B_LADDER as readonly number[]).includes(excluded),
      excluded + ' ms is only introduced if Stage B results justify it',
    );
  }
});

test('the PO preset list merges Stage A and Stage B once each, descending', () => {
  const presets = Array.from(SINGLE_BASELINE_HOLD_MS_PRESETS);
  // Every Stage A and every Stage B value is selectable on the phone.
  for (const value of SINGLE_BASELINE_HOLD_MS_LADDER) assert.ok(presets.includes(value), 'Stage A ' + value);
  for (const value of SINGLE_BASELINE_STAGE_B_LADDER) assert.ok(presets.includes(value), 'Stage B ' + value);
  // No duplicates, strictly descending (slowest first).
  assert.equal(new Set(presets).size, presets.length, 'no duplicate presets');
  for (let i = 1; i < presets.length; i += 1) {
    assert.ok(presets[i - 1] > presets[i], 'presets descend: ' + presets[i - 1] + ' > ' + presets[i]);
  }
  // 75 ms appears once even though both ladders contain it.
  assert.equal(presets.filter((value) => value === 75).length, 1);
});

// ---------------------------------------------------------------------------
// 2. theoreticalCameraFramesPerCode — a sampling OPPORTUNITY count
// ---------------------------------------------------------------------------

test('theoretical CameraFrames per code matches callbackFps × holdMs / 1000', () => {
  const at30 = (holdMs: number): number | null => singleBaselineEfficiency({
    callbackFps: 30,
    holdMs,
    decodeAttempts: 0,
    successfulDecodes: 0,
    crcFailures: 0,
    locateFailures: 0,
    duplicates: 0,
    uniqueReceived: 0,
  }).theoreticalCameraFramesPerCode;

  // The ratios quoted in the Stage A interpretation, at a 30 FPS camera cadence.
  assert.equal(at30(100), 3, '100 ms ≈ 3.0 frames/code');
  assert.equal(at30(90), 2.7);
  assert.equal(at30(75), 2.25, '75 ms ≈ 2.25 frames/code');
  assert.equal(at30(60), 1.8, '60 ms ≈ 1.8 frames/code');
  assert.equal(at30(50), 1.5, '50 ms ≈ 1.5 frames/code');
  assert.equal(at30(40), 1.2, '40 ms ≈ 1.2 frames/code');
  assert.equal(at30(33), 0.99, '33 ms ≈ 1.0 frames/code — sender cadence meets camera cadence');

  // The measured 75 ms reference: 29.98 FPS × 75 ms.
  const measured = singleBaselineEfficiency({
    callbackFps: 29.98,
    holdMs: 75,
    decodeAttempts: 1,
    successfulDecodes: 1,
    crcFailures: 0,
    locateFailures: 0,
    duplicates: 0,
    uniqueReceived: 0,
  }).theoreticalCameraFramesPerCode;
  assert.equal(measured, 2.249);
});

test('frames per code is null, never 0 or Infinity, when the inputs are unusable', () => {
  const base = {
    callbackFps: 30,
    holdMs: 75,
    decodeAttempts: 10,
    successfulDecodes: 10,
    crcFailures: 0,
    locateFailures: 0,
    duplicates: 0,
    uniqueReceived: 1,
  };
  assert.equal(singleBaselineEfficiency({...base, callbackFps: 0}).theoreticalCameraFramesPerCode, null);
  assert.equal(singleBaselineEfficiency({...base, callbackFps: Number.NaN}).theoreticalCameraFramesPerCode, null);
  assert.equal(singleBaselineEfficiency({...base, holdMs: 0}).theoreticalCameraFramesPerCode, null);
  assert.equal(singleBaselineEfficiency({...base, holdMs: -75}).theoreticalCameraFramesPerCode, null);
});

// ---------------------------------------------------------------------------
// 3. Stage A measured ratios — recorded exactly, not smoothed
// ---------------------------------------------------------------------------

type StageARow = {
  holdMs: number;
  callbackFps: number;
  decodeAttempts: number;
  successfulDecodes: number;
  crcFailures: number;
  locateFailures: number;
  uniqueReceived: number;
  // `yield` is null where the denominator is 0 (0/0 is undefined, not 0 %).
  expected: {success: number; crc: number; locate: number; yield: number | null};
};

const STAGE_A_ROWS: StageARow[] = [
  // 1500 ms — PASS
  {holdMs: 1500, callbackFps: 29.98, decodeAttempts: 1970, successfulDecodes: 1674, crcFailures: 295, locateFailures: 1, uniqueReceived: 16, expected: {success: 0.8497, crc: 0.1497, locate: 0.0005, yield: 0.0096}},
  // 750 ms — ANOMALOUS / OUTLIER CANDIDATE: ZERO successful decodes with 586 attempts.
  {holdMs: 750, callbackFps: 29.98, decodeAttempts: 586, successfulDecodes: 0, crcFailures: 583, locateFailures: 3, uniqueReceived: 0, expected: {success: 0, crc: 0.9949, locate: 0.0051, yield: null}},
  // 333 ms — PASS
  {holdMs: 333, callbackFps: 29.98, decodeAttempts: 701, successfulDecodes: 607, crcFailures: 94, locateFailures: 0, uniqueReceived: 16, expected: {success: 0.8659, crc: 0.1341, locate: 0, yield: 0.0264}},
  // 150 ms — PASS
  {holdMs: 150, callbackFps: 29.98, decodeAttempts: 1033, successfulDecodes: 806, crcFailures: 223, locateFailures: 4, uniqueReceived: 16, expected: {success: 0.7803, crc: 0.2159, locate: 0.0039, yield: 0.0199}},
  // 75 ms — PASS, best Net Goodput
  {holdMs: 75, callbackFps: 29.98, decodeAttempts: 398, successfulDecodes: 356, crcFailures: 42, locateFailures: 0, uniqueReceived: 16, expected: {success: 0.8945, crc: 0.1055, locate: 0, yield: 0.0449}},
  // 33 ms — PASS but performance collapse
  {holdMs: 33, callbackFps: 29.98, decodeAttempts: 3281, successfulDecodes: 2226, crcFailures: 1048, locateFailures: 7, uniqueReceived: 16, expected: {success: 0.6785, crc: 0.3194, locate: 0.0021, yield: 0.0072}},
];

test('every Stage A ratio is reproducible from the measured counters', () => {
  for (const row of STAGE_A_ROWS) {
    const efficiency = singleBaselineEfficiency({
      callbackFps: row.callbackFps,
      holdMs: row.holdMs,
      decodeAttempts: row.decodeAttempts,
      successfulDecodes: row.successfulDecodes,
      crcFailures: row.crcFailures,
      locateFailures: row.locateFailures,
      duplicates: 0,
      uniqueReceived: row.uniqueReceived,
    });
    const label = row.holdMs + ' ms';
    assert.equal(efficiency.decodeSuccessRatio, row.expected.success, label + ' decodeSuccessRatio');
    assert.equal(efficiency.crcFailureRatio, row.expected.crc, label + ' crcFailureRatio');
    assert.equal(efficiency.locateFailureRatio, row.expected.locate, label + ' locateFailureRatio');
    assert.equal(efficiency.newUniqueChunkYield, row.expected.yield, label + ' newUniqueChunkYield');
  }
});

test('the 750 ms run records a REAL zero, not missing data', () => {
  const row = STAGE_A_ROWS.find((candidate) => candidate.holdMs === 750)!;
  const efficiency = singleBaselineEfficiency({
    callbackFps: row.callbackFps,
    holdMs: row.holdMs,
    decodeAttempts: row.decodeAttempts,
    successfulDecodes: row.successfulDecodes,
    crcFailures: row.crcFailures,
    locateFailures: row.locateFailures,
    duplicates: 0,
    uniqueReceived: row.uniqueReceived,
  });
  // 586 decode attempts really happened and every one of them failed. That is a
  // measured 0, and it must not be confused with "no data" (null).
  assert.equal(efficiency.decodeSuccessRatio, 0);
  assert.notEqual(efficiency.decodeSuccessRatio, null);
  // 0 unique chunks / 0 successful decodes is UNDEFINED, not 0 %. Reporting 0 %
  // would imply the receiver decoded frames and learned nothing from them; in
  // this run it never decoded a single frame.
  assert.equal(efficiency.newUniqueChunkYield, null, '0/0 yield is undefined, not 0 %');
  assert.equal(
    efficiency.crcFailureRatio! + efficiency.locateFailureRatio! + 0.0003 >= 1,
    true,
    'at 750 ms nearly every attempt failed at the CRC, so CRC failure dominates',
  );
});

test('per-frame correctness and whole-file collection efficiency are different things', () => {
  const best = STAGE_A_ROWS.find((candidate) => candidate.holdMs === 75)!;
  const collapsed = STAGE_A_ROWS.find((candidate) => candidate.holdMs === 33)!;
  const bestEfficiency = singleBaselineEfficiency({
    callbackFps: best.callbackFps,
    holdMs: best.holdMs,
    decodeAttempts: best.decodeAttempts,
    successfulDecodes: best.successfulDecodes,
    crcFailures: best.crcFailures,
    locateFailures: best.locateFailures,
    duplicates: 0,
    uniqueReceived: best.uniqueReceived,
  });
  const collapsedEfficiency = singleBaselineEfficiency({
    callbackFps: collapsed.callbackFps,
    holdMs: collapsed.holdMs,
    decodeAttempts: collapsed.decodeAttempts,
    successfulDecodes: collapsed.successfulDecodes,
    crcFailures: collapsed.crcFailures,
    locateFailures: collapsed.locateFailures,
    duplicates: 0,
    uniqueReceived: collapsed.uniqueReceived,
  });

  // 75 ms: the decoder is healthy (>85 % of attempts decode) …
  assert.ok(bestEfficiency.decodeSuccessRatio! > 0.85, '75 ms decode success is high');
  assert.equal(bestEfficiency.locateFailureRatio, 0, '75 ms locate failures are zero');
  assert.ok(bestEfficiency.crcFailureRatio! < 0.15, '75 ms CRC failures are modest');
  // … yet it needed 356 successful decodes to collect 16 unique chunks.
  assert.ok(bestEfficiency.newUniqueChunkYield! < 0.05, '75 ms unique yield is very low');
  assert.ok(
    bestEfficiency.newUniqueChunkYield! < collapsedEfficiency.newUniqueChunkYield! * 7,
    '75 ms yields far more unique data per successful decode than 33 ms',
  );

  // 33 ms degrades BOTH views: lower per-frame correctness and lower yield.
  assert.ok(collapsedEfficiency.decodeSuccessRatio! < bestEfficiency.decodeSuccessRatio!, '33 ms decodes worse');
  assert.ok(collapsedEfficiency.crcFailureRatio! > bestEfficiency.crcFailureRatio!, '33 ms CRC-rejects more');
  assert.ok(collapsedEfficiency.decodeSuccessRatio! > 0.5, '33 ms is degraded, NOT broken');
});

// ---------------------------------------------------------------------------
// 4. Guards — a 0-denominator run has no ratio at all
// ---------------------------------------------------------------------------

test('a run with no decode attempts reports no ratio instead of 0 %', () => {
  const efficiency = singleBaselineEfficiency({
    callbackFps: 29.98,
    holdMs: 75,
    decodeAttempts: 0,
    successfulDecodes: 0,
    crcFailures: 0,
    locateFailures: 0,
    duplicates: 0,
    uniqueReceived: 0,
  });
  assert.equal(efficiency.decodeSuccessRatio, null);
  assert.equal(efficiency.crcFailureRatio, null);
  assert.equal(efficiency.locateFailureRatio, null);
  // Zero successful decodes cannot yield unique chunks — there is no ratio.
  assert.equal(efficiency.newUniqueChunkYield, null);
  assert.equal(efficiency.duplicateRatio, null);
  // Frames per code does not depend on decode counters, so it still exists.
  assert.equal(efficiency.theoreticalCameraFramesPerCode, 2.249);
});

test('duplicate ratio is reported against successful decodes, never against attempts', () => {
  const efficiency = singleBaselineEfficiency({
    callbackFps: 29.98,
    holdMs: 75,
    decodeAttempts: 398,
    successfulDecodes: 356,
    crcFailures: 42,
    locateFailures: 0,
    duplicates: 340,
    uniqueReceived: 16,
  });
  assert.equal(efficiency.duplicateRatio, 0.9551, '340 / 356');
  assert.notEqual(efficiency.duplicateRatio, Number(340 / 398), 'duplicates are NOT divided by attempts');
  assert.equal(efficiency.newUniqueChunkYield, 0.0449);
});

// ---------------------------------------------------------------------------
// 5. End to end: the metrics come from the real receiver counters
// ---------------------------------------------------------------------------

test('a complete physical-shaped run reports healthy efficiency from real counters', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  const HOLD_MS = 75;
  const FRAMES_PER_CHUNK = 3; // ≈2.25 theoretical, rounded up here for the fixture
  const FIRST_CHUNK = 5;
  let clock = 0;

  for (let step = 0; step < SINGLE_BASELINE_TOTAL_CHUNKS * 2 && !receiver.complete; step += 1) {
    const chunkIndex = (FIRST_CHUNK + step) % SINGLE_BASELINE_TOTAL_CHUNKS;
    const frame = renderSingleBaselineFrame(transfer.frames[chunkIndex], SINGLE_BASELINE_MATRIX, {
      width: 720,
      height: 720,
      fill: 0.72,
    }) as {width: number; height: number; data: Uint8ClampedArray};
    for (let frameIndex = 0; frameIndex < FRAMES_PER_CHUNK; frameIndex += 1) {
      receiver.ingestFrame(frame, SINGLE_BASELINE_MATRIX, clock);
      clock += 10;
      if (receiver.complete) break;
    }
  }

  assert.equal(receiver.complete, true);
  assert.equal(receiver.receivedUniqueCount, 16);
  assert.equal(receiver.metrics.locateFailures, 0);
  assert.equal(receiver.metrics.crcFailures, 0);
  assert.ok(receiver.metrics.duplicateChunks > 0, 'the duplicate path really ran');

  const elapsedMs = receiver.metrics.allChunksMs;
  const callbackFps = (receiver.metrics.cameraFrames * 1000) / elapsedMs;
  const efficiency = singleBaselineEfficiency({
    callbackFps,
    holdMs: HOLD_MS,
    decodeAttempts: receiver.metrics.decodeAttempts,
    successfulDecodes: receiver.metrics.decodeSuccess,
    crcFailures: receiver.metrics.crcFailures,
    locateFailures: receiver.metrics.locateFailures,
    duplicates: receiver.metrics.duplicateChunks,
    uniqueReceived: receiver.receivedUniqueCount,
  });

  assert.equal(efficiency.decodeSuccessRatio, 1, 'every attempt decoded in this clean fixture');
  assert.equal(efficiency.crcFailureRatio, 0);
  assert.equal(efficiency.locateFailureRatio, 0);
  // 16 unique chunks out of ~48 successful decodes.
  assert.ok(efficiency.newUniqueChunkYield! > 0.3 && efficiency.newUniqueChunkYield! < 0.4);
  assert.ok(efficiency.theoreticalCameraFramesPerCode! > 0);
  assert.ok(efficiency.duplicateRatio! > 0.6, 'most successful decodes re-observed held chunks');
});
