/**
 * TF-012 r18 — EVIDENCE QUALITY: optical chunk identity, abort semantics, scheduler timing.
 *
 * WHY THIS FILE EXISTS
 *
 * The r17 physical run was a harness SUCCESS (SETUP pre-flight worked: camera ready →
 * static chunk0 confirmed → 5.14 s window → gate READY) but its evidence had three holes:
 *
 *   1. `decodedChunkIndexes: []` in every step, even with `uniqueReceived = 4`. The
 *      receiver exposed `receivedUniqueCount` and `missingIndices()` but no
 *      `receivedIndices()`, so the phone's guarded call always fell back to `[]` — and the
 *      static-step invariant ("a static step must only ever accept chunk 0") could never
 *      fire. A3's "246 successful decodes, +1 unique chunk" could not be explained.
 *   2. The final JSON said `finishedAtIso` 14:11:59.772Z and `startedAtIso` 14:12:01.236Z:
 *      a PO Stop produced a finish time in the PAST, and the reason/source existed only in
 *      the phone's log (`abortedReason` / `abortDetail` were never published).
 *   3. A1 ran +2.6 s, A2 +1.1 s and A3 +30.5 s over plan, with a 19.3 s command→confirmation
 *      wait against a configured 5 s deadline. Every deadline in the machine is checked on
 *      a tick, so a stalled tick loop silently converts a 25 s step into 55 s of different
 *      evidence — and nothing in the artefact said so.
 *
 * These tests pin the fixes:
 *   1  receivedIndices() returns sorted unique optical chunk indexes
 *   2  decodedChunkIndexes is no longer permanently empty
 *   3  a static step fails if ANY accepted optical chunk index != 0
 *   4  the per-chunk accepted-decode histogram is correct (duplicates included)
 *   5  a PO abort records the REAL abort instant
 *   6  finishedAt >= startedAt for every final result, whatever ended the run
 *   7  the abort source and reason are explicit
 *   8  tick interval statistics are correct
 *   9  a synthetic long tick gap is detected
 *  10  a timing-invalid step is flagged (and does not silently rank)
 *  11  the confirmation overshoot is recorded
 *  12  the step overshoot is recorded
 *  13  the SETUP frozen FPS is interval-derived, never a live/UI window value
 *  14  no network payload/oracle path is introduced
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {
  SINGLE_BASELINE_MATRIX,
  SingleCodeBaselineReceiver,
  buildSingleBaselineTransfer,
  packSingleBaselineChunk,
} from './single-baseline.ts';
import {decodeFrameCellsV1} from '../optigrid-v1.ts';
import {
  TF012_AUTO_TIMING_STALL_THRESHOLD_MS,
  Tf012AutoTickTracker,
  tf012AutoChunkDecodeDelta,
  validateTf012AutoControlMessage,
} from './index.ts';
import {createFakePeer, runAutoPlan} from './tf012-auto-fake-peer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS = join(HERE, '..', '..', '..');
const MINI = join(EXPERIMENTS, 'tf-008-wechat-mini-receiver-poc');
const PAGE_JS = readFileSync(join(MINI, 'pages', 'index', 'index.js'), 'utf8');
const ADAPTER_JS = readFileSync(join(MINI, 'utils', 'tf012-auto.js'), 'utf8');
const miniRequire = createRequire(import.meta.url);
const autoAdapter = miniRequire(join(MINI, 'utils', 'tf012-auto.js')) as Record<string, any>;

const transfer = buildSingleBaselineTransfer();

/** A decoded OptiGrid frame carrying one baseline chunk payload (local, no camera). */
function frameFor(chunkIndex: number) {
  const decoded = decodeFrameCellsV1(transfer.frames[chunkIndex], SINGLE_BASELINE_MATRIX);
  assert.ok(decoded, `chunk ${chunkIndex} must round-trip through OptiGrid v1`);
  return decoded;
}

/** A decoded frame carrying a DIFFERENT transfer's payload (identity mismatch path). */
function foreignFrame(chunkIndex: number) {
  const bytes = new Uint8Array(10240);
  const payload = packSingleBaselineChunk({
    fileName: 'other.txt',
    fileId: 99,
    fileSha256Bytes: new Uint8Array(32).fill(7),
    totalFileBytes: 10240,
    totalChunks: 16,
    chunkIndex,
    chunkDataBytes: 640,
    data: bytes.subarray(0, 640),
  });
  return {payload, sequence: 0} as unknown as ReturnType<typeof frameFor>;
}

// ---------------------------------------------------------------------------
// 1, 4 — the receiver's new optical APIs
// ---------------------------------------------------------------------------

test('r18 chunk identity 1: receivedIndices() returns sorted UNIQUE optical indexes', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(1000);
  assert.deepEqual(receiver.receivedIndices(), [], 'nothing accepted yet');
  assert.equal(receiver.receivedUniqueCount, 0);

  for (const index of [4, 4, 9, 0, 4]) receiver.ingestDecoded(frameFor(index), 1000);

  assert.deepEqual(receiver.receivedIndices(), [0, 4, 9], 'sorted, unique, duplicates collapsed');
  assert.equal(receiver.receivedUniqueCount, 3, 'the count agrees with the list');
  // The list must be a COPY: a caller mutating it cannot corrupt the receiver.
  const copy = receiver.receivedIndices();
  copy.push(15);
  assert.deepEqual(receiver.receivedIndices(), [0, 4, 9], 'the receiver keeps its own state');
});

test('r18 chunk identity 4: the per-chunk decode histogram counts duplicates and foreigners', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(1000);
  assert.deepEqual(receiver.decodedChunkCounts(), {}, 'no decodes yet');

  receiver.ingestDecoded(frameFor(0), 1000);
  receiver.ingestDecoded(frameFor(0), 1001);
  receiver.ingestDecoded(frameFor(0), 1002);
  receiver.ingestDecoded(frameFor(5), 1003);
  receiver.ingestDecoded(frameFor(5), 1004);
  receiver.ingestDecoded(foreignFrame(2), 1005);

  // Every decode is attributed, including repeats of an already-held chunk and decodes of
  // a different transfer: "the camera resolved this index" is the measurement.
  assert.deepEqual(receiver.decodedChunkCounts(), {'0': 3, '2': 1, '5': 2});
  assert.deepEqual(receiver.receivedIndices(), [0, 5], 'foreign decodes are not stored');
  assert.equal(receiver.receivedUniqueCount, 2);

  // Interval deltas are per-index and only report POSITIVE gains.
  assert.deepEqual(
    tf012AutoChunkDecodeDelta({'0': 3, '5': 2}, {'0': 7, '2': 1, '5': 2}),
    {'0': 4, '2': 1},
    'gained decodes only: a chunk that gained nothing is not reported',
  );
  assert.deepEqual(tf012AutoChunkDecodeDelta({'0': 3}, {'0': 3}), {}, 'no gain, no entry');
});

// ---------------------------------------------------------------------------
// 2 — the phone + orchestrator actually carry the indexes
// ---------------------------------------------------------------------------

test('r18 chunk identity 2: frozen steps carry real optical chunk identities', () => {
  const peer = runAutoPlan();
  const a1 = peer.frozen.find((step) => step.stepId === 'A1');
  const a2 = peer.frozen.find((step) => step.stepId === 'A2');

  // A1 is static chunk 0: the ACCEPTED list (absolute) must say so. In r17 this was `[]`.
  assert.deepEqual(a1?.receiver.decodedChunkIndexes, [0], 'A1 accepted chunk 0 — and says so');
  // The whole-step window starts at the metric reset, i.e. BEFORE the first decode, so
  // its delta carries the index; the measurement window opens at confirmation and may
  // legitimately already contain it.
  assert.deepEqual(a1?.stepInterval.decodedChunkIndexes, [0], 'the whole step saw chunk 0 arrive');
  assert.ok(Object.keys(a1?.stepInterval.acceptedDecodeCountByChunkIndex ?? {}).length > 0,
    'the histogram attributes A1 decodes to a concrete index');
  assert.equal(a1?.stepInterval.acceptedDecodeCountByChunkIndex['1'], undefined,
    'and nothing to chunk 1');

  assert.ok(a2 && Object.keys(a2.interval.acceptedDecodeCountByChunkIndex).length > 0,
    'A2 attributes its decodes to concrete chunk indexes');
  assert.ok((a2?.receiver.decodedChunkIndexes.length ?? 0) > 1, 'A2 accepted several chunks');

  // The phone must ASK the receiver for both signals (no silent `[]` fallback only).
  assert.match(PAGE_JS, /receivedIndices\(\)/u, 'the phone reads accepted indexes');
  assert.match(PAGE_JS, /decodedChunkCounts\(\)/u, 'the phone reads the per-chunk histogram');
  assert.match(PAGE_JS, /acceptedDecodeCountByChunkIndex/u, 'and forwards it to the harness');
  // Derived from the LOCAL optical receiver, never from sender telemetry: the sample
  // builder must not touch the auto runner or the control socket.
  const sampleBody = PAGE_JS.slice(PAGE_JS.indexOf('autoStepReceiverSample()'), PAGE_JS.indexOf('autoResetMetrics()'));
  assert.ok(!/autoRunner|client\.|socket/u.test(sampleBody),
    'the receiver sample never reads the control channel');
});

// ---------------------------------------------------------------------------
// 3 — the static invariant is now armed
// ---------------------------------------------------------------------------

test('r18 invariant 3: a static step fails if the camera accepts any chunk other than 0', () => {
  // SETUP itself: the carrier shows chunk 3 while the plan asks for static chunk 0.
  const peer = runAutoPlan({staticDecode: 'other', maxTicks: 80});
  const result = peer.finalResult();
  assert.equal(result?.status, 'STATIC_INVARIANT_VIOLATION',
    'r17 could not detect this at all (decodedChunkIndexes was always empty)');
  assert.equal(result?.abort?.source, 'HARNESS');
  assert.match(String(result?.abort?.detail), /chunk 3/u);
  // The invariant fires as soon as the wrong chunk is accepted, which is why no frozen
  // step and no setup window exists for this run.
  const setupCheck = result?.validity.checks.find((check) => check.id === 'static_setup_invariant');
  assert.equal(setupCheck?.ok, false, 'the SETUP invariant is never a rubber stamp');
  assert.equal(peer.frozen.length, 0, 'nothing is measured on a carrier showing the wrong chunk');
});

test('r18 invariant 3b: A1 fails when the WRONG chunk arrives only after SETUP', () => {
  const options = {staticDecode: 'chunk0' as const, maxTicks: 200};
  const peer = createFakePeer(options);
  // Run until the setup gate has passed and A1 is under way, then change what the carrier
  // shows: the A1 invariant must catch it even though chunk 0 was already accepted.
  let flipped = false;
  for (let index = 0; index < 200 && !peer.finalResult(); index += 1) {
    peer.tick(1);
    if (!flipped && peer.frozen.length === 0
      && peer.progress.at(-1)?.stepId === 'A1' && peer.progress.at(-1)?.phase === 'STEP') {
      (options as {staticDecode: string}).staticDecode = 'other';
      flipped = true;
    }
  }
  const result = peer.finalResult();
  assert.equal(flipped, true, 'A1 was reached before the carrier changed');
  assert.equal(result?.status, 'STATIC_INVARIANT_VIOLATION');
  assert.match(String(result?.abort?.detail), /A1 is STATIC chunk0 but chunk 3 was/u);
  assert.equal(peer.frozen.length, 0, 'A1 is not frozen as if it were a valid static step');
});

// ---------------------------------------------------------------------------
// 5-7 — abort semantics
// ---------------------------------------------------------------------------

test('r18 abort 5+7: a PO Stop records the real instant, the source and the reason', () => {
  const peer = createFakePeer({abortAtTick: 20, abortReason: 'STOPPED_BY_PO', maxTicks: 60});
  peer.runUntilFinal();

  const result = peer.finalResult();
  assert.equal(result?.status, 'ABORTED');
  assert.ok(result?.abort, 'the abort record is published');
  assert.equal(result?.abort?.source, 'PO_STOP', 'the analyst never has to infer this');
  assert.equal(result?.abort?.reason, 'STOPPED_BY_PO');
  assert.equal(result?.abort?.detail, 'STOPPED_BY_PO');

  const abortedAt = Date.parse(String(result?.abort?.abortedAtIso));
  const requestedAt = Date.parse(String(result?.timeline.requestedAtIso));
  const stopTickAt = peer.abortTick() == null ? 0 : requestedAt + (peer.tickIndex() * 500);
  assert.ok(abortedAt > requestedAt,
    'the abort instant is AFTER the tap — r17 wrote a finish time BEFORE the start');
  assert.ok(abortedAt >= stopTickAt - 500 && abortedAt <= stopTickAt + 2000,
    `the abort instant is the real stop time, not the request time (${result?.abort?.abortedAtIso})`);

  // A PO stop still tells the carrier to stop, and the machine observes whether it did.
  assert.ok(peer.actions().includes('STOP'), 'STOP is sent to the sender');
  assert.ok(result?.abort?.stopSentAtIso, 'the STOP instant is recorded');
  assert.equal(result?.abort?.stopTelemetryConfirmed, true,
    'telemetry confirmed broadcasting=false inside the post-abort window');
  assert.ok(result?.abort?.stopTelemetryObservedAtIso, 'with the observing instant');
});

test('r18 abort 6: finishedAt >= startedAt for EVERY kind of ending', () => {
  const endings = {
    complete: runAutoPlan(),
    po_stop: (() => { const peer = createFakePeer({abortAtTick: 20, maxTicks: 60}); peer.runUntilFinal(); return peer; })(),
    setup_not_ready: runAutoPlan({ready: false, maxTicks: 200}),
    camera_not_ready: runAutoPlan({cameraStartsAfterTicks: 999, maxTicks: 90}),
    sender_not_confirmed: runAutoPlan({initialMode: 'cyclic', obeyMode: false, maxTicks: 120}),
  };
  for (const [label, peer] of Object.entries(endings)) {
    const result = peer.finalResult();
    assert.ok(result, `${label}: the run produced a result`);
    const started = Date.parse(String(result?.startedAtIso));
    const finished = Date.parse(String(result?.finishedAtIso));
    assert.ok(Number.isFinite(started) && Number.isFinite(finished), `${label}: both parsed`);
    assert.ok(finished >= started, `${label}: finishedAt ${result?.finishedAtIso} >= startedAt ${result?.startedAtIso}`);
    assert.ok(finished >= Date.parse(String(result?.timeline.requestedAtIso)), `${label}: never before the tap`);
  }
  assert.equal(endings.complete.finalResult()?.status, 'COMPLETE');
  assert.equal(endings.complete.finalResult()?.abort, null, 'COMPLETE carries no abort record');
  assert.equal(endings.setup_not_ready.finalResult()?.abort?.source, 'HARNESS');
  assert.equal(endings.camera_not_ready.finalResult()?.abort?.source, 'CAMERA');
  assert.equal(endings.sender_not_confirmed.finalResult()?.abort?.source, 'SENDER');
});

// ---------------------------------------------------------------------------
// 8-10 — scheduler statistics and the stall rule
// ---------------------------------------------------------------------------

test('r18 timing 8: tick interval statistics are correct', () => {
  const tracker = new Tf012AutoTickTracker();
  assert.deepEqual(tracker.stats(), {
    tickCount: 0, tickIntervalAvgMs: null, tickIntervalP50Ms: null, tickIntervalP95Ms: null,
    tickIntervalMaxMs: null, largestTickGapMs: null,
    largestTickGapStartedAtIso: null, largestTickGapEndedAtIso: null,
  }, 'a scope with no ticks reports nulls, not zeros');

  tracker.note(0);
  tracker.note(250);
  tracker.note(500);
  tracker.note(750);
  const steady = tracker.stats();
  assert.equal(steady.tickCount, 3, 'the first tick has no interval');
  assert.equal(steady.tickIntervalAvgMs, 250);
  assert.equal(steady.tickIntervalP50Ms, 250);
  assert.equal(steady.tickIntervalP95Ms, 250);
  assert.equal(steady.tickIntervalMaxMs, 250);
  assert.equal(steady.largestTickGapMs, 250);
  assert.equal(tracker.integrity().valid, true, 'a steady 250 ms loop is healthy');

  // A skewed sample set: p50 and p95 must differ from the average.
  const skewed = new Tf012AutoTickTracker();
  [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 5000].forEach((at) => skewed.note(at));
  const stats = skewed.stats();
  assert.equal(stats.tickCount, 9);
  assert.ok((stats.tickIntervalMaxMs ?? 0) === 3000, 'the outlier is the max');
  assert.ok((stats.tickIntervalP95Ms ?? 0) > 250, 'p95 reflects the tail');
  assert.ok((stats.tickIntervalAvgMs ?? 0) > (stats.tickIntervalP50Ms ?? 0), 'the mean is pulled up');
  assert.equal(skewed.integrity().reason, 'ORCHESTRATOR_STALL', 'and the stall is named');
  assert.equal(skewed.integrity().thresholdMs, TF012_AUTO_TIMING_STALL_THRESHOLD_MS);

  tracker.reset();
  assert.equal(tracker.stats().tickCount, 0, 'reset clears the scope');
});

test('r18 timing 9: a synthetic 12 s stall is detected in the run AND in the step', () => {
  const clean = runAutoPlan();
  assert.equal(clean.finalResult()?.timingIntegrity.valid, true, 'a clean run is valid');
  assert.equal(clean.finalResult()?.scheduler.tickIntervalMaxMs, 500, 'the fake ticks every 500 ms');

  const stalled = runAutoPlan({
    stallMs: 12000,
    // Late in A1, so the stalled tick is the one that ends the step: the plan says 10 s,
    // the machine observes ~10 s + the gap.
    stallOn: (progress) => progress.stepId === 'A1' && progress.phase === 'STEP'
      && progress.remainingMs <= 2000,
    maxTicks: 400,
  });
  const result = stalled.finalResult();
  assert.equal(stalled.stalls.length, 1, 'one stall was injected');
  assert.equal(result?.timingIntegrity.valid, false, 'the run is timing-invalid');
  assert.equal(result?.timingIntegrity.reason, 'ORCHESTRATOR_STALL');
  assert.ok((result?.scheduler.largestTickGapMs ?? 0) >= 12000, 'the gap is measured');
  assert.ok(result?.scheduler.largestTickGapStartedAtIso && result?.scheduler.largestTickGapEndedAtIso,
    'with both bounds recorded');
  assert.ok((result?.scheduler.tickIntervalMaxMs ?? 0) >= 12000);
});

test('r18 timing 10: a timing-invalid step is flagged instead of ranking normally', () => {
  const stalled = runAutoPlan({
    stallMs: 12000,
    stallOn: (progress) => progress.stepId === 'A1' && progress.phase === 'STEP'
      && progress.remainingMs <= 2000,
    maxTicks: 400,
  });
  const a1 = stalled.frozen.find((step) => step.stepId === 'A1');
  const a2 = stalled.frozen.find((step) => step.stepId === 'A2');
  assert.equal(a1?.timingIntegrity.valid, false, 'A1 carries the stall');
  assert.equal(a1?.timingIntegrity.reason, 'ORCHESTRATOR_STALL');
  assert.ok((a1?.timingIntegrity.largestTickGapMs ?? 0) >= 12000);
  assert.equal(a2?.timingIntegrity.valid, true, 'A2 is unaffected and stays rankable');
  assert.ok((a1?.tickStats.tickCount ?? 0) > 0, 'per-step tick statistics are frozen');

  // A clean run stays rankable end to end.
  const clean = runAutoPlan();
  assert.equal(clean.frozen.every((step) => step.timingIntegrity.valid), true);
  assert.equal(clean.finalResult()?.timingIntegrity.valid, true);
});

// ---------------------------------------------------------------------------
// 11-12 — overshoots
// ---------------------------------------------------------------------------

test('r18 timing 11: the confirmation overshoot is recorded when a stall delays the tick', () => {
  const clean = runAutoPlan();
  assert.equal(clean.frozen.every((step) => step.confirmationOvershootMs === 0), true,
    'confirmations inside the deadline have no overshoot');
  assert.equal(clean.frozen[0]?.confirmationDeadlineMs, 5000);

  const stalled = runAutoPlan({
    stallMs: 18000,
    // Mid-A2: the tick that confirms A2 arrives long after the 5 s deadline.
    stallOn: (progress) => progress.phase === 'CONFIRMING' && progress.stepId === 'A2',
    maxTicks: 400,
  });
  const a2 = stalled.frozen.find((step) => step.stepId === 'A2');
  assert.ok((a2?.confirmationOvershootMs ?? 0) > 0,
    'the late tick that confirmed A2 is reported as an overshoot');
  assert.ok(Date.parse(String(a2?.confirmationObservedAtIso)) > Date.parse(String(a2?.confirmationRequestedAtIso)));
  assert.equal(a2?.confirmationRequestedAtIso, a2?.requestedAtIso, 'requested = commands issued');
});

test('r18 timing 12: the step overshoot is recorded for every step', () => {
  const clean = runAutoPlan();
  for (const step of clean.frozen) {
    assert.equal(step.stepPlannedDurationMs, step.plannedDurationMs);
    assert.ok(step.stepMeasuredDurationMs >= step.actualDurationMs, 'the whole step covers the window');
    assert.equal(step.stepOvershootMs, Math.max(0, step.stepMeasuredDurationMs - step.stepPlannedDurationMs));
    assert.ok(step.stepOvershootMs <= 4000, `${step.stepId} is close to plan (${step.stepOvershootMs} ms)`);
  }
  const stalled = runAutoPlan({
    stallMs: 12000,
    stallOn: (progress) => progress.stepId === 'A1' && progress.phase === 'STEP'
      && progress.remainingMs <= 2000,
    maxTicks: 400,
  });
  const a1 = stalled.frozen.find((step) => step.stepId === 'A1');
  assert.ok((a1?.stepOvershootMs ?? 0) >= 10000, 'the stalled step overshot its plan by the stall');
  // A4 records its pause overshoot explicitly (null for non-A4 steps).
  const a4 = clean.frozen.find((step) => step.stepId === 'A4');
  assert.ok(a4?.pauseRequestedAtIso && a4?.pauseConfirmedAtIso, 'A4 pause bounds are recorded');
  assert.equal(a4?.pauseOvershootMs, 0, 'and the pause landed inside its deadline');
  assert.equal(clean.frozen.find((step) => step.stepId === 'A1')?.pauseOvershootMs, null);
});

// ---------------------------------------------------------------------------
// 13 — SETUP FPS evidence consistency
// ---------------------------------------------------------------------------

test('r18 setup 13: the frozen setup evidence uses interval-derived FPS', () => {
  // The fake reports a deliberately absurd 1000 FPS UI-window artefact (the r13 bug).
  const peer = runAutoPlan({windowFps: 1000});
  const gate = peer.finalResult()?.setupGate;
  assert.ok(gate?.evidenceWindow, 'the gate window is present');
  const window = gate!.evidenceWindow!;
  const seconds = window.durationMs / 1000;
  assert.ok(Math.abs((gate!.evidence.callbackFps ?? 0) - window.cameraFrames / seconds) < 0.5,
    `the gate FPS is derived from the window (${gate!.evidence.callbackFps} vs ${window.cameraFrames / seconds})`);
  assert.ok(Math.abs((gate!.evidence.processingFps ?? 0) - window.processedFrames / seconds) < 0.5);
  assert.notEqual(gate!.evidence.callbackFps, 1000, 'the UI-window artefact never reaches frozen evidence');
  // Frozen STEP evidence already had this property; assert it stays true.
  for (const step of peer.frozen) {
    const intervalSeconds = step.interval.durationMs / 1000;
    assert.ok(Math.abs((step.receiver.callbackFps ?? 0) - step.interval.cameraFramesDelta / intervalSeconds) < 0.01,
      `${step.stepId}: step FPS stays interval-derived`);
    assert.notEqual(step.receiver.callbackFps, 1000);
  }
});

// ---------------------------------------------------------------------------
// 14 — no network payload / oracle path
// ---------------------------------------------------------------------------

test('r18 regression 14: the new evidence adds no network payload or oracle path', () => {
  const peer = runAutoPlan();
  const result = peer.finalResult();
  assert.equal(result?.networkPayloadPath, 'NONE');
  // The run still passes the Mini Program's dedicated lab-result validator (payload-shaped
  // keys are refused there), and the strict control validator is unchanged.
  const check = autoAdapter.validateAutoLabResult({
    type: 'lab-result',
    run: {...result, kind: 'tf012-auto-physical'},
  });
  assert.equal(check.ok, true, `the frozen run must stay uploadable: ${check.reason}`);
  const smuggled = autoAdapter.validateAutoLabResult({
    type: 'lab-result',
    run: {kind: 'tf012-auto-physical', runId: 'r', networkPayloadPath: 'NONE', chunkPayload: 'AAAA'},
  });
  assert.equal(smuggled.ok, false, 'a payload-shaped key is still refused');
  assert.equal(validateTf012AutoControlMessage({
    type: 'command', action: 'TELEMETRY', runId: 'r', mode: 'static', chunkIndex: 0, chunkBase64: 'AA',
  }).ok, false, 'the control validator is not loosened for the new fields');

  // The new signals are LOCAL: neither the adapter nor the page gained a network API, and
  // the histogram/index fields are read from the receiver object only.
  assert.ok(!/[^.\w]fetch\s*\(/u.test(ADAPTER_JS), 'adapter: no fetch');
  assert.ok(!/https?:\/\//u.test(ADAPTER_JS), 'adapter: no HTTP URL');
  assert.ok(ADAPTER_JS.includes('cameraStatus'), 'the adapter still relays the camera probe');
  assert.ok(PAGE_JS.includes('Network payload path: NONE'), 'the page still declares the path');
});
