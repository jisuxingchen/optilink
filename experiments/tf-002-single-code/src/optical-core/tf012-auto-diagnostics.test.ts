/**
 * TF-012 r19 — DIAGNOSTIC EVIDENCE: per-phase timing, camera timing, sampling geometry,
 * failed-frame fingerprints, and the static probe.
 *
 * WHY THIS FILE EXISTS
 *
 * The r18 physical run failed SETUP with 111/111 CRC failures while the locator locked
 * 111/111 and the geometry read healthy (309.73 px, 3.226 px/cell, reserved 0.966,
 * contrast 171.83). Two independent problems were exposed:
 *
 *   1. TIMING. SETUP planned ~5 s and took 9.554 s, while the run-wide largest tick gap
 *      (26.993 s) belonged to the STOP/abort tail. One run-wide number cannot separate a
 *      SETUP stall from a STOPPING stall, and nothing recorded whether camera-frame
 *      processing was starving the orchestrator's timer loop.
 *   2. DECODE. Nothing recorded WHICH sampling geometry the CRC stage actually used, nor
 *      whether repeated failures produced the SAME raw bits (a stable sampling-phase bias)
 *      or different bits every time (noise/motion).
 *
 * These tests pin the instrumentation that answers both, with no change to the locator,
 * OptiGrid, CRC, matrix, chunk size or rendering:
 *   1  per-phase tick statistics exist for every phase, SETUP and STOPPING separated
 *   2  a stall is attributed to the PHASE it happened in
 *   3  camera callback intervals and processing durations are measured per step
 *   4  the processing duty ratio is derived, not guessed
 *   5  the CRC stage records the sampling geometry it used
 *   6  repeated identical failures collapse to ONE fingerprint with a high count
 *   7  varying failures produce many distinct fingerprints
 *   8  stable-bit analysis reports how many bits never changed
 *   9  the static probe runs one 10 s static step and is marked as a probe
 *  10  the probe carries the same evidence blocks as the sweep
 *  11  no network payload/oracle path is introduced
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
  renderSingleBaselineFrame,
} from './single-baseline.ts';
import {Tf012AutoCameraTimingTracker} from './tf012-auto-camera-timing.ts';
import {
  TF012_AUTO_PROBE_STEPS,
  TF012_AUTO_PROBE_STEP,
  TF012_AUTO_STEP_COUNT,
  tf012AutoCameraTimingDelta,
} from './index.ts';
import {emptyCameraTiming} from './tf012-auto-orchestrator.ts';
import {createFakePeer, runAutoPlan} from './tf012-auto-fake-peer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS = join(HERE, '..', '..', '..');
const MINI = join(EXPERIMENTS, 'tf-008-wechat-mini-receiver-poc');
const PAGE_JS = readFileSync(join(MINI, 'pages', 'index', 'index.js'), 'utf8');
const ADAPTER_JS = readFileSync(join(MINI, 'utils', 'tf012-auto.js'), 'utf8');
const miniRequire = createRequire(import.meta.url);
const autoAdapter = miniRequire(join(MINI, 'utils', 'tf012-auto.js')) as Record<string, any>;

const transfer = buildSingleBaselineTransfer();

/** Render one camera frame of chunk 0, optionally with `corrupt` data cells flipped. */
function renderChunk0(corrupt: number, seed = 1): {width: number; height: number; data: Uint8ClampedArray} {
  const cells = Uint8Array.from(transfer.frames[0]!);
  // Flip PAYLOAD-area cells only: the border, the reserved pattern and the header stay
  // intact, so the locator still locks and the CRC is the stage that rejects — the exact
  // physical situation this diagnostic exists for (locator PASS, CRC FAIL).
  let state = seed;
  for (let index = 0; index < corrupt; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const row = 40 + (state % 30);
    const column = 40 + ((state >>> 7) % 30);
    const at = row * SINGLE_BASELINE_MATRIX + column;
    cells[at] = cells[at] ? 0 : 1;
  }
  return renderSingleBaselineFrame(cells, SINGLE_BASELINE_MATRIX, {
    width: 720, height: 1280, fill: 0.7,
  });
}

// ---------------------------------------------------------------------------
// 1-2 — per-phase scheduler timing
// ---------------------------------------------------------------------------

test('r19 phase timing 1: every phase carries its own tick statistics', () => {
  const peer = runAutoPlan();
  const result = peer.finalResult();
  const phases = result?.phaseTiming ?? [];
  const byName = new Map(phases.map((entry) => [entry.phase, entry]));

  for (const name of ['WAITING_FOR_SENDER', 'WAITING_FOR_CAMERA', 'CONFIRMING_SETUP', 'SETUP', 'A1', 'A2', 'A3', 'A4', 'A5', 'STOPPING']) {
    const entry = byName.get(name);
    assert.ok(entry, `phase ${name} is reported`);
    assert.ok(entry?.actualDurationMs != null && entry.actualDurationMs >= 0, `${name} has a duration`);
  }
  // Phases that span several ticks report their tick statistics; a one-tick phase reports
  // zero MEASURED intervals (the opening tick has none), which is why the wait states are
  // checked for presence only here.
  for (const name of ['SETUP', 'A1', 'A2', 'A3', 'A4', 'A5']) {
    assert.ok((byName.get(name)?.tickCount ?? 0) > 0, `${name} recorded ticks`);
  }
  // The plan is reported where the plan defines one, and not invented elsewhere.
  assert.equal(byName.get('SETUP')?.plannedDurationMs, 5000);
  assert.equal(byName.get('A1')?.plannedDurationMs, 10000);
  assert.equal(byName.get('A4')?.plannedDurationMs, 15000);
  assert.equal(byName.get('STOPPING')?.plannedDurationMs, null);
  assert.equal(byName.get('WAITING_FOR_SENDER')?.plannedDurationMs, null);
  for (const entry of phases) {
    if (entry.plannedDurationMs == null) {
      assert.equal(entry.overshootMs, null, `${entry.phase} has no plan, so no overshoot`);
    } else {
      assert.equal(entry.overshootMs, Math.max(0, entry.actualDurationMs - entry.plannedDurationMs));
    }
  }
  // Each phase is its own scope: the tick counts together cannot exceed the run total by more
  // than the boundary ticks, and the run-level stats still exist.
  assert.ok((result?.scheduler.tickCount ?? 0) > 0);
  assert.equal(result?.probe, false, 'the sweep is not a probe');
});

test('r19 phase timing 2: a stall is attributed to the phase it happened in', () => {
  // Stall late in SETUP: SETUP must be flagged, STOPPING must not.
  const peer = runAutoPlan({
    stallMs: 12000,
    stallOn: (progress) => progress.phase === 'SETUP' && progress.remainingMs <= 1000,
    maxTicks: 400,
  });
  const byName = new Map((peer.finalResult()?.phaseTiming ?? []).map((entry) => [entry.phase, entry]));
  const setup = byName.get('SETUP');
  const stopping = byName.get('STOPPING');
  assert.equal(setup?.timingValid, false, 'the SETUP phase carries the stall');
  assert.ok((setup?.largestTickGapMs ?? 0) >= 12000);
  assert.ok((setup?.overshootMs ?? 0) >= 10000, `SETUP overshot its 5 s plan (${setup?.overshootMs} ms)`);
  assert.equal(stopping?.timingValid, true, 'STOPPING is clean: the stall was NOT attributed to it');
  assert.equal(stopping?.overshootMs, null, 'and STOPPING has no plan to overshoot');
});

// ---------------------------------------------------------------------------
// 3-4 — camera callback and processing timing
// ---------------------------------------------------------------------------

test('r19 camera timing 3: callback intervals and processing durations are measured', () => {
  const tracker = new Tf012AutoCameraTimingTracker();
  assert.deepEqual(tracker.snapshot(), {
    callbackCount: 0, callbackIntervalAvgMs: null, callbackIntervalP50Ms: null,
    callbackIntervalP95Ms: null, callbackIntervalMaxMs: null,
    processCount: 0, processSumMs: 0, processDurationAvgMs: null,
    processDurationP50Ms: null, processDurationP95Ms: null, processDurationMaxMs: null,
  }, 'an empty tracker reports nulls, not zeros');

  tracker.note(1000, 10);
  tracker.note(1030, 20);
  tracker.note(1060, 30);
  tracker.note(1120, 90);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.callbackCount, 3, 'the first frame has no interval');
  assert.equal(snapshot.callbackIntervalMaxMs, 60, 'the widest gap is kept');
  assert.ok(Math.abs((snapshot.callbackIntervalAvgMs ?? 0) - 40) < 1e-9);
  assert.equal(snapshot.processCount, 4);
  assert.equal(snapshot.processSumMs, 150);
  assert.equal(snapshot.processDurationMaxMs, 90);
  assert.equal(snapshot.processDurationP50Ms, 25);
  tracker.reset();
  assert.equal(tracker.snapshot().callbackCount, 0, 'reset clears the window');

  // The orchestrator freezes the window's camera timing into every step.
  const peer = runAutoPlan({frameProcessingMs: 40});
  const a1 = peer.frozen.find((step) => step.stepId === 'A1');
  assert.ok((a1?.cameraTiming.callbackCount ?? 0) > 0, 'A1 reports camera callbacks');
  assert.equal(a1?.cameraTiming.processDurationAvgMs, 40, 'and their processing cost');
  assert.ok((a1?.cameraTiming.callbackIntervalMaxMs ?? 0) > 0, 'with the widest callback gap');
});

test('r19 camera timing 4: the processing duty ratio is derived from measured time', () => {
  const delta = tf012AutoCameraTimingDelta(
    emptyCameraTiming(),
    {...emptyCameraTiming(), callbackCount: 10, processCount: 10, processSumMs: 500,
      processDurationAvgMs: 50, processDurationMaxMs: 120},
    1000,
  );
  assert.equal(delta.processingDutyRatio, 0.5, 'half the interval was spent inside processing');
  assert.equal(delta.processDurationAvgMs, 50);
  assert.equal(delta.callbackIntervalAvgMs, 100, '10 callbacks in 1000 ms');
  assert.equal(
    tf012AutoCameraTimingDelta(emptyCameraTiming(), emptyCameraTiming(), 0).processingDutyRatio,
    null, 'no interval, no ratio');
  // A single long frame is compared against the orchestrator gap, not against FPS: the raw
  // numbers travel, so no exposure or quality claim is derived here.
  assert.match(PAGE_JS, /processingDutyRatio/u, 'the phone shows the duty ratio');
  assert.match(PAGE_JS, /autoCameraTiming\.note\(/u, 'the phone feeds the timing tracker');
});

// ---------------------------------------------------------------------------
// 5-8 — sampling geometry and failed-frame fingerprints (all local)
// ---------------------------------------------------------------------------

test('r19 decode 5+6: a rejected frame records its geometry and its fingerprint', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(1000);

  // A clean chunk 0: accepted, geometry recorded on the SUCCESS side.
  const good = renderChunk0(0);
  receiver.ingestFrame(good, SINGLE_BASELINE_MATRIX, 1000);
  assert.equal(receiver.metrics.decodeSuccess, 1, 'the clean frame decodes');
  const geometry = receiver.geometryDiagnostics();
  assert.ok(geometry.success, 'the accepted frame reports the geometry it was decoded with');
  assert.ok((geometry.success?.boundingBox.width ?? 0) > 100, 'with a real bounding box');
  assert.ok((geometry.success?.pixelsPerCell ?? 0) > 2, 'and its sampling scale');
  assert.equal(typeof geometry.success?.phaseX, 'number');
  assert.equal(typeof geometry.success?.rotation, 'number');
  assert.ok((geometry.success?.candidates ?? 0) > 0, 'candidate count is reported');
  assert.ok((geometry.success?.secondSeedScore ?? -1) >= 0, 'and the second-best seed score');

  // The SAME corruption twice: one fingerprint, seen twice.
  const broken = renderChunk0(40, 7);
  receiver.ingestFrame(broken, SINGLE_BASELINE_MATRIX, 1100);
  receiver.ingestFrame(broken, SINGLE_BASELINE_MATRIX, 1200);
  const diagnostics = receiver.crcFailureDiagnostics();
  assert.equal(diagnostics.failedFrames, 2, 'both broken frames were rejected');
  assert.equal(diagnostics.analysedFrames, 2);
  assert.equal(diagnostics.distinctFingerprints, 1,
    'identical sampling produces ONE fingerprint — the stable-bias signal');
  assert.equal(diagnostics.topFingerprintCount, 2);
  assert.ok(diagnostics.topFingerprint, 'the fingerprint is reported');
  assert.ok(diagnostics.crcMismatchFrames >= 1, 'the CRC stage is named as the rejecting stage');
  assert.ok(receiver.geometryDiagnostics().failure, 'and the rejected geometry is kept');
  assert.ok((receiver.geometryDiagnostics().failure?.refinementScore ?? 0) > 0);
});

test('r19 decode 7+8: varying failures produce many fingerprints and few stable bits', () => {
  const stable = new SingleCodeBaselineReceiver();
  stable.begin(1000);
  const same = renderChunk0(40, 7);
  for (let index = 0; index < 4; index += 1) stable.ingestFrame(same, SINGLE_BASELINE_MATRIX, 1000 + index);
  const stableDiagnostics = stable.crcFailureDiagnostics();
  assert.equal(stableDiagnostics.distinctFingerprints, 1);
  assert.ok((stableDiagnostics.stableBitCount ?? 0) > 0,
    'a repeating failure leaves many bits identical across frames');
  assert.equal(stableDiagnostics.meanBitFlipVsPrevious, 0, 'and no bit flips between them');

  const varying = new SingleCodeBaselineReceiver();
  varying.begin(1000);
  for (let index = 0; index < 4; index += 1) {
    varying.ingestFrame(renderChunk0(40 + index * 7, index + 1), SINGLE_BASELINE_MATRIX, 1000 + index);
  }
  const varyingDiagnostics = varying.crcFailureDiagnostics();
  assert.ok(varyingDiagnostics.distinctFingerprints > 1,
    'different sampling produces different fingerprints — the noise signal');
  assert.ok((varyingDiagnostics.meanBitFlipVsPrevious ?? 0) > 0,
    'and the mean bit-flip count is non-zero');
  assert.ok((varyingDiagnostics.stableBitCount ?? Number.MAX_SAFE_INTEGER)
    <= (stableDiagnostics.stableBitCount ?? 0),
  'varying frames share no more bits than identical frames');
});

// ---------------------------------------------------------------------------
// 9-10 — the static diagnostic probe
// ---------------------------------------------------------------------------

test('r19 probe 9: the static probe is one 10 s static chunk-0 step', () => {
  assert.equal(TF012_AUTO_PROBE_STEPS.length, 1, 'one step, no sweep');
  assert.equal(TF012_AUTO_PROBE_STEP.mode, 'static');
  assert.equal(TF012_AUTO_PROBE_STEP.chunkIndex, 0);
  assert.equal(TF012_AUTO_PROBE_STEP.holdMs, null, 'no cyclic hold time');
  assert.equal(TF012_AUTO_PROBE_STEP.durationMs, 10000);
  assert.equal(Object.isFrozen(TF012_AUTO_PROBE_STEP), true, 'immutable like the shipped plan');
  assert.equal(TF012_AUTO_STEP_COUNT, 5, 'the A1..A5 sweep is untouched');

  const peer = createFakePeer({steps: TF012_AUTO_PROBE_STEPS, probe: true, maxTicks: 400});
  peer.runUntilFinal();
  const result = peer.finalResult();
  assert.equal(result?.probe, true, 'the artefact says it is a probe');
  assert.equal(result?.stepsPlanned, 1);
  assert.equal(result?.steps.length, 1, 'exactly one frozen step');
  assert.equal(result?.steps[0]?.stepId, 'A1');
  assert.equal(result?.steps[0]?.mode, 'static');
  assert.equal(result?.status, 'COMPLETE');
  assert.ok(peer.actions().includes('STOP'), 'and the carrier is stopped afterwards');
  // The probe runs through the same pre-flight as the sweep.
  assert.ok(result?.timeline.cameraReadyAtIso, 'camera pre-flight ran');
  assert.ok(result?.timeline.setupConfirmedAtIso, 'static chunk0 was confirmed');
});

test('r19 probe 10: the probe carries the same evidence blocks as the sweep', () => {
  const peer = createFakePeer({
    steps: TF012_AUTO_PROBE_STEPS, probe: true, maxTicks: 400,
    failureFingerprint: 'cafebabe', failureStableBits: 6000, failureMeanBitFlip: 3,
  });
  peer.runUntilFinal();
  const step = peer.finalResult()?.steps[0];
  assert.ok(step?.cameraTiming, 'camera timing is frozen');
  assert.ok(step?.crcDiagnostics, 'CRC-failure diagnostics are frozen');
  assert.ok(step?.geometry, 'sampling geometry is frozen');
  assert.ok(step?.timingIntegrity, 'timing integrity is frozen');
  assert.ok(step?.tickStats, 'tick statistics are frozen');
  assert.deepEqual(step?.interval.decodedChunkIndexes, [], 'chunk 0 was already held before the window');
  assert.ok(Object.keys(step?.stepInterval.acceptedDecodeCountByChunkIndex ?? {}).length > 0,
    'the per-chunk histogram is present');
  assert.ok((peer.finalResult()?.phaseTiming.length ?? 0) >= 5,
    'per-phase timing is present for the probe too');
});

// ---------------------------------------------------------------------------
// 11 — no oracle / no payload
// ---------------------------------------------------------------------------

test('r19 regression 11: the diagnostics add no network payload or oracle path', () => {
  const peer = runAutoPlan({frameProcessingMs: 30});
  const result = peer.finalResult();
  assert.equal(result?.networkPayloadPath, 'NONE');
  const check = autoAdapter.validateAutoLabResult({
    type: 'lab-result',
    run: {...result, kind: 'tf012-auto-physical'},
  });
  assert.equal(check.ok, true, `the frozen run must stay uploadable: ${check.reason}`);

  // Every r19 field is a LOCAL measurement. The raw failure bits never leave the receiver:
  // the sample carries a fingerprint and counters, and the frozen JSON carries no bit array.
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes('rawBytes'), 'raw sampled bits are not frozen into the artefact');
  assert.ok(serialised.includes('fingerprintHistogram'), 'only fingerprint→count evidence travels');
  assert.ok(!/[^.\w]fetch\s*\(/u.test(ADAPTER_JS), 'adapter: no fetch');
  assert.ok(!/https?:\/\//u.test(ADAPTER_JS), 'adapter: no HTTP URL');
  assert.ok(PAGE_JS.includes('Network payload path: NONE'), 'the page still declares the path');
  // The receiver APIs that produce the evidence are local too.
  const receiverSource = readFileSync(join(HERE, 'single-baseline.ts'), 'utf8');
  for (const api of ['crcFailureDiagnostics()', 'geometryDiagnostics()', 'receivedIndices()', 'decodedChunkCounts()']) {
    assert.ok(receiverSource.includes(api), `receiver exposes ${api}`);
  }
});
