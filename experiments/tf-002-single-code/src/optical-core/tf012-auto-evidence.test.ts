/**
 * TF-012 r20 — EVIDENCE INTEGRITY: phase-boundary timing and per-frame rotation.
 *
 * WHY THIS FILE EXISTS
 *
 * The second r19 physical probe produced this artefact (runId tf012-1789317109842, buildId
 * tf012-r19-40d803f, status SETUP_NOT_READY):
 *
 *   SETUP: tickCount 0, largestTickGapMs null, actualDurationMs 35911, planned 5000,
 *          timingValid TRUE
 *
 * Two instrumentation defects, both about WHEN a phase is considered finished:
 *
 *   1. FALSE-VALID TIMING. `timingValid` was derived from MEASURED tick gaps only. A phase
 *      that received NO interior tick at all has no measured gap, so a 30.9 s overshoot on a
 *      5 s plan was reported as valid. "No measurable gap" is not "no stall".
 *   2. PHASE SCOPE CLOSED ON THE NEXT TICK. The phase trackers were closed by whichever tick
 *      next observed a different phase, so everything between a real transition and the next
 *      tick — including a whole abort and STOP-observation tail — was charged to the phase
 *      that had already ended. r19's SETUP absorbed ~26 s it never spent.
 *
 * And one evidence gap: `frameRotationIndex` is the rotation of ONE lock. Two r19 probes
 * reported rotation 1 then 3 with the code in the SAME image position, which is orientation
 * instability — but a single index cannot show whether that was one flip or a per-frame
 * oscillation. The rotation histogram counts a rotation per FRAME, split by outcome.
 *
 * Nothing in this file changes the locator, rotation selection, refinement, sampling phase,
 * OptiGrid, CRC, matrix size, chunk size or rendering. It changes when a phase is closed and
 * what is measured about it, locally.
 *
 *   1  a phase is closed at the instant of its transition, not at the next tick
 *   2  later abort/STOP time is never charged to a phase that already ended
 *   3  a planned phase with no interior tick that overshot is NO_TICKS_DURING_PLANNED_PHASE
 *   4  a measured gap over the 1500 ms threshold is ORCHESTRATOR_STALL, and outranks overshoot
 *   5  the run-level verdict names the invalid phases and a healthy run names none
 *   6  `plannedTicks` is derived from the plan and the host cadence
 *   7  per-frame rotation histogram: stable orientation
 *   8  per-frame rotation histogram: unstable orientation
 *   9  outcomes are separated (accepted / crc-failed) and unlocated frames carry no rotation
 *  10  the SETUP gate evidence freezes the histogram
 *  11  the probe evidence freezes the histogram
 *  12  frozen evidence is a deep copy of the host sample
 *  13  no network payload path, no oracle, and the guards still refuse payload-shaped keys
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {
  SingleBaselineRotationTracker,
  emptyRotationDiagnostics,
  type SingleBaselineRotationDiagnostics,
} from './single-baseline.ts';
import {
  TF012_AUTO_PHASE_MIN_EXPECTED_TICKS,
  TF012_AUTO_PHASE_OVERSHOOT_TOLERANCE_MS,
  TF012_AUTO_TICK_CADENCE_MS,
  TF012_AUTO_TIMING_STALL_THRESHOLD_MS,
  tf012AutoWorstTimingReason,
  type Tf012AutoPhaseTiming,
} from './tf012-auto-orchestrator.ts';
import {TF012_AUTO_PROBE_STEPS} from './index.ts';
import {createFakePeer, runAutoPlan} from './tf012-auto-fake-peer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS = join(HERE, '..', '..', '..');
const MINI = join(EXPERIMENTS, 'tf-008-wechat-mini-receiver-poc');
const PAGE_JS = readFileSync(join(MINI, 'pages', 'index', 'index.js'), 'utf8');
const ADAPTER_JS = readFileSync(join(MINI, 'utils', 'tf012-auto.js'), 'utf8');
const miniRequire = createRequire(import.meta.url);
const autoAdapter = miniRequire(join(MINI, 'utils', 'tf012-auto.js')) as Record<string, any>;

/** Phase entries of a frozen run, keyed by phase name. */
function phasesOf(result: {phaseTiming?: Tf012AutoPhaseTiming[]} | null): Map<string, Tf012AutoPhaseTiming> {
  return new Map((result?.phaseTiming ?? []).map((entry) => [entry.phase, entry]));
}

// ---------------------------------------------------------------------------
// 1-2 — a phase ends when it ends, not when a tick notices
// ---------------------------------------------------------------------------

test('r20 phase boundary 1: a phase is closed at its transition, so a later abort cannot inflate it', () => {
  // The r19 defect, reproduced synthetically: the machine is aborted 20 s AFTER the setup
  // window closed. In r19 the abort instant was charged to SETUP (35 911 ms against a 5 s
  // plan, while its own evidence window was 9 520 ms) because SETUP stayed "open" until the
  // next tick that happened to run.
  let ticksInsideA1 = 0;
  const peer = createFakePeer({
    maxTicks: 400,
    inject: ({now, orchestrator, commands}) => {
      // A1's commands exist only after the SETUP->A1 transition has happened.
      if (commands.filter((message) => String(message.action) === 'START').length < 2) return;
      ticksInsideA1 += 1;
      if (ticksInsideA1 !== 4) return;
      // Abort at a wall-clock instant that is NOT a tick: exactly what a PO Stop looks like
      // between two timer callbacks.
      orchestrator.abort('r20 phase-boundary test', {source: 'PO_STOP', nowMs: now + 20000});
    },
  });
  peer.runUntilFinal();
  const byName = phasesOf(peer.finalResult());
  const setup = byName.get('SETUP');
  const a1 = byName.get('A1');

  assert.ok(setup && a1, 'both phases are reported');
  // SETUP lasted its own window (5 s plan, detected on the next 500 ms cadence).
  assert.ok((setup?.actualDurationMs ?? 0) <= 6000,
    `SETUP must not absorb the later abort: ${setup?.actualDurationMs} ms`);
  assert.ok((setup?.actualDurationMs ?? 0) >= 4500, 'and it is still measured');
  assert.ok((a1?.actualDurationMs ?? 0) >= 20000,
    `the injected 20 s tail belongs to the phase that was running: ${a1?.actualDurationMs} ms`);
  // The phase that was running is the one that is flagged.
  assert.equal(setup?.timingValid, true, 'SETUP keeps its own clean verdict');
  assert.equal(a1?.timingValid, false, 'A1 carries the overshoot');
  const invalid = peer.finalResult()?.timingIntegrity.invalidPhases ?? [];
  assert.ok(invalid.includes('A1'), `A1 is named as invalid (${invalid.join(', ')})`);
  assert.ok(!invalid.includes('SETUP'), 'SETUP is not');
});

test('r20 phase boundary 2: a planned phase with no interior tick that overshot is not valid', () => {
  // THE r19 defect: tickCount 0, largestTickGapMs null, actualDurationMs 35 911 vs a 5 000 ms
  // plan, reported `timingValid: true`. Reproduced by aborting on the very first tick that
  // can see A1, at an instant 90 s away: A1 receives no tick at all and overshoots hugely.
  const peer = createFakePeer({
    maxTicks: 400,
    inject: ({now, orchestrator, commands}) => {
      if (commands.filter((message) => String(message.action) === 'START').length < 2) return;
      orchestrator.abort('r20 no-tick overshoot test', {source: 'PO_STOP', nowMs: now + 90000});
    },
  });
  peer.runUntilFinal();
  const byName = phasesOf(peer.finalResult());
  const a1 = byName.get('A1');

  assert.equal(a1?.tickCount, 0, 'no tick fell inside the phase');
  assert.equal(a1?.largestTickGapMs, null, 'so no gap could be measured — the r19 blind spot');
  assert.ok((a1?.overshootMs ?? 0) > TF012_AUTO_PHASE_OVERSHOOT_TOLERANCE_MS,
    `it overshot by far more than the tolerance (${a1?.overshootMs} ms)`);
  assert.ok((a1?.plannedTicks ?? 0) >= TF012_AUTO_PHASE_MIN_EXPECTED_TICKS, 'the plan expected ticks');
  assert.equal(a1?.timingValid, false, 'a phase with no interior tick is NOT valid');
  assert.equal(a1?.timingReason, 'NO_TICKS_DURING_PLANNED_PHASE');
  assert.equal(peer.finalResult()?.timingIntegrity.valid, false, 'and the run says so');
});

// ---------------------------------------------------------------------------
// 3-5 — verdicts
// ---------------------------------------------------------------------------

test('r20 verdict 3: a measured gap above the threshold is a stall, and outranks overshoot', () => {
  // 12 s stall inside SETUP: the phase both STALLS and overshoots its 5 s plan. The stall is
  // the root cause and must be the reported reason.
  const peer = runAutoPlan({
    stallMs: 12000,
    stallOn: (progress) => progress.phase === 'SETUP' && progress.remainingMs <= 1000,
    maxTicks: 400,
  });
  const setup = phasesOf(peer.finalResult()).get('SETUP');
  assert.ok((setup?.largestTickGapMs ?? 0) > TF012_AUTO_TIMING_STALL_THRESHOLD_MS,
    'the gap is measured');
  assert.ok((setup?.overshootMs ?? 0) > TF012_AUTO_PHASE_OVERSHOOT_TOLERANCE_MS,
    'and it also overshot');
  assert.equal(setup?.timingReason, 'ORCHESTRATOR_STALL', 'the cause is named, not the symptom');
  assert.equal(setup?.timingValid, false);
  assert.ok((peer.finalResult()?.timingIntegrity.invalidPhases ?? []).includes('SETUP'));
  assert.equal(peer.finalResult()?.timingIntegrity.reason, 'ORCHESTRATOR_STALL');
  // The severity order itself: stall beats overshoot, and OK loses to everything.
  assert.equal(tf012AutoWorstTimingReason('PHASE_OVERSHOOT', 'ORCHESTRATOR_STALL'), 'ORCHESTRATOR_STALL');
  assert.equal(tf012AutoWorstTimingReason('OK', 'NO_TICKS_DURING_PLANNED_PHASE'), 'NO_TICKS_DURING_PLANNED_PHASE');
  assert.equal(tf012AutoWorstTimingReason('OK', 'OK'), 'OK');
});

test('r20 verdict 4: a clean run reports every phase valid and names no invalid phase', () => {
  // The rules must not fire on a healthy run: an overshoot verdict that also triggers on
  // ordinary scheduler jitter would be as useless as the r19 false-valid.
  const peer = runAutoPlan();
  const result = peer.finalResult();
  assert.equal(result?.status, 'COMPLETE');
  for (const entry of result?.phaseTiming ?? []) {
    assert.equal(entry.timingReason, 'OK', `${entry.phase} is clean (${entry.actualDurationMs} ms)`);
    assert.equal(entry.timingValid, true, `${entry.phase} is valid`);
    if (entry.plannedDurationMs != null) {
      assert.ok(entry.overshootMs! <= TF012_AUTO_PHASE_OVERSHOOT_TOLERANCE_MS,
        `${entry.phase} is within tolerance (${entry.overshootMs} ms over)`);
    }
  }
  assert.deepEqual(result?.timingIntegrity.invalidPhases, [], 'no phase is named');
  assert.equal(result?.timingIntegrity.valid, true);
  assert.equal(result?.timingIntegrity.reason, 'OK');
  // Every phase is still bounded by the run itself.
  for (const entry of result?.phaseTiming ?? []) {
    assert.ok(entry.actualDurationMs <= (result?.scheduler.tickCount ?? 0) * 500 + 60000);
  }
});

test('r20 verdict 5: plannedTicks is derived from the plan and the host cadence', () => {
  const peer = runAutoPlan();
  const byName = phasesOf(peer.finalResult());
  const setup = byName.get('SETUP');
  const a1 = byName.get('A1');
  assert.equal(setup?.plannedTicks, Math.round(5000 / TF012_AUTO_TICK_CADENCE_MS));
  assert.equal(a1?.plannedTicks, Math.round(10000 / TF012_AUTO_TICK_CADENCE_MS));
  assert.equal(byName.get('STOPPING')?.plannedTicks, null, 'a phase with no plan expects nothing');
  assert.equal(byName.get('WAITING_FOR_SENDER')?.plannedTicks, null);
  // A planned phase always expects at least one tick, however short the plan.
  for (const entry of peer.finalResult()?.phaseTiming ?? []) {
    if (entry.plannedDurationMs != null) {
      assert.ok((entry.plannedTicks ?? 0) >= 1, `${entry.phase} expects at least one tick`);
    }
  }
});

// ---------------------------------------------------------------------------
// 6-9 — the per-frame rotation histogram
// ---------------------------------------------------------------------------

test('r20 rotation 6: a stable orientation collapses to one bucket and no transitions', () => {
  const tracker = new SingleBaselineRotationTracker();
  for (let frame = 0; frame < 100; frame += 1) tracker.note(3, 'accepted');
  const diagnostics = tracker.diagnostics();
  assert.deepEqual(diagnostics.rotations, {'3': 100}, 'one bucket, 100 frames');
  assert.deepEqual(diagnostics.accepted, {'3': 100});
  assert.deepEqual(diagnostics.crcFailures, {}, 'no rejections');
  assert.equal(diagnostics.framesCounted, 100);
  assert.equal(diagnostics.transitions, 0, 'the orientation never changed');
  assert.equal(diagnostics.dominantRotation, 3);
  assert.equal(diagnostics.dominantRotationRatio, 1);
  assert.equal(diagnostics.lastRotation, 3);
});

test('r20 rotation 7: an alternating orientation is visible as spread buckets and transitions', () => {
  // The physical r19 signature: rotation 1 in one probe, 3 in the next, with the code in the
  // same image position. Per-frame counting shows whether that is one flip or an oscillation.
  const tracker = new SingleBaselineRotationTracker();
  for (let frame = 0; frame < 100; frame += 1) tracker.note(frame % 2 === 0 ? 1 : 3, 'crc-failed');
  const diagnostics = tracker.diagnostics();
  assert.deepEqual(diagnostics.rotations, {'1': 50, '3': 50});
  assert.equal(diagnostics.transitions, 99, 'every consecutive frame differs');
  assert.equal(diagnostics.dominantRotation, 1, 'a tie resolves to the lowest index');
  assert.equal(diagnostics.dominantRotationRatio, 0.5);
  assert.equal(diagnostics.lastRotation, 3, 'the last frame is still reported as-is');
  // A single flip between two stable stretches is a different animal: 2 transitions.
  const flip = new SingleBaselineRotationTracker();
  for (let frame = 0; frame < 100; frame += 1) flip.note(frame < 60 ? 1 : 3, 'crc-failed');
  assert.equal(flip.diagnostics().transitions, 1, 'one change, counted once');
  assert.deepEqual(flip.diagnostics().rotations, {'1': 60, '3': 40});
});

test('r20 rotation 8: outcomes are separated and unlocated frames carry no rotation', () => {
  const tracker = new SingleBaselineRotationTracker();
  tracker.note(0, 'accepted');
  tracker.note(0, 'crc-failed');
  tracker.note(0, 'crc-failed');
  tracker.note(2, 'accepted');
  tracker.noteUnlocated();
  tracker.noteUnlocated();
  const diagnostics = tracker.diagnostics();
  assert.deepEqual(diagnostics.rotations, {'0': 3, '2': 1}, 'every frame that reached the decoder');
  assert.deepEqual(diagnostics.accepted, {'0': 1, '2': 1});
  assert.deepEqual(diagnostics.crcFailures, {'0': 2}, 'rejections are their own histogram');
  assert.equal(diagnostics.framesCounted, 4);
  assert.equal(diagnostics.unlocatedFrames, 2, 'frames with no lock are counted, not guessed');
  assert.equal(diagnostics.framesCounted + diagnostics.unlocatedFrames, 6, 'nothing is lost');
  // Accepted + rejected always reconstructs the total.
  const total = Object.values(diagnostics.rotations).reduce((sum, count) => sum + count, 0);
  assert.equal(total, diagnostics.framesCounted);
  // A reset returns the empty shape exactly.
  tracker.reset();
  assert.deepEqual(tracker.diagnostics(), emptyRotationDiagnostics());
});

// ---------------------------------------------------------------------------
// 10-12 — the histogram is frozen into the evidence
// ---------------------------------------------------------------------------

test('r20 freeze 9: the frozen SETUP gate evidence carries the rotation histogram', () => {
  const peer = runAutoPlan({rotationSequence: [3], frameProcessingMs: 25});
  const result = peer.finalResult();
  const evidence = result?.setupGate.evidence;
  const histogram: SingleBaselineRotationDiagnostics | undefined = evidence?.rotations;
  assert.ok(histogram, 'the frozen setup evidence has a rotation block');
  assert.ok(histogram.framesCounted > 0, 'frames were counted');
  assert.deepEqual(histogram.rotations, {'3': histogram.framesCounted}, 'a stable orientation 3');
  assert.equal(histogram.transitions, 0);
  assert.equal(histogram.dominantRotation, 3);
  assert.equal(histogram.dominantRotationRatio, 1);
  // The frozen sample is WINDOW-CONSISTENT: it is the end of the setup window, so the
  // counters cannot exceed what the window itself recorded.
  assert.ok(histogram.framesCounted <= (evidence?.processedFrames ?? 0) + 1,
    'no more counted frames than the window processed');
});

test('r20 freeze 10: the frozen probe step carries the rotation histogram', () => {
  const peer = createFakePeer({
    steps: TF012_AUTO_PROBE_STEPS, probe: true, maxTicks: 400, rotationSequence: [1, 3],
  });
  peer.runUntilFinal();
  const step = peer.finalResult()?.steps[0];
  const histogram = step?.receiver.rotations;
  assert.ok(histogram, 'the probe step froze a rotation block');
  assert.ok((histogram?.framesCounted ?? 0) > 0, 'frames reached the decoder inside the step');
  assert.deepEqual(Object.keys(histogram?.rotations ?? {}).sort(), ['1', '3'],
    'an alternating orientation is visible as two buckets');
  assert.equal(histogram?.transitions, (histogram?.framesCounted ?? 0) - 1,
    'the sequence changes on every consecutive frame');
  assert.ok([1, 3].includes(histogram?.lastRotation ?? -1),
    `the last counted frame is the reported index (${histogram?.lastRotation})`);
  // The step scope is its own: the reset at the step boundary started it.
  assert.equal(histogram?.unlocatedFrames, 0, 'the fake locks every frame it delivers');
  assert.equal(peer.finalResult()?.probe, true);
  assert.equal(peer.finalResult()?.steps.length, 1);
});

test('r20 freeze 11: frozen evidence is a deep copy of the host sample', () => {
  // Object-valued evidence must be copied, or the frozen artefact keeps mutating after the
  // run (the r18 aliasing defect, now also applying to the rotation histogram).
  const peer = runAutoPlan({rotationSequence: [3]});
  const step = peer.finalResult()?.steps[0];
  const before = JSON.stringify(step?.receiver.rotations);
  assert.ok(before && before.length > 2, 'the frozen block is not empty');
  // Mutate the live host objects the way a sloppy host would.
  peer.receiver.rotations.rotations['99'] = 1234;
  peer.receiver.rotations.framesCounted = 99999;
  const after = JSON.stringify(step?.receiver.rotations);
  assert.equal(after, before, 'the frozen evidence did not move');
  assert.ok(!after.includes('"99"'), 'and no key from the live object leaked in');
});

// ---------------------------------------------------------------------------
// 13 — no oracle, no payload
// ---------------------------------------------------------------------------

test('r20 regression 12: the new evidence adds no network payload or oracle path', () => {
  const peer = runAutoPlan({rotationSequence: [1, 3]});
  const result = peer.finalResult();
  assert.equal(result?.networkPayloadPath, 'NONE');
  // The run still passes the Mini Program's persisted-result guard, and the control
  // validator is unchanged. `plannedTicks` is deliberately NOT named "expected…": that
  // fragment is refused by the guard, and weakening the guard for a diagnostic is the wrong
  // trade.
  const check = autoAdapter.validateAutoLabResult({
    type: 'lab-result',
    run: {...result, kind: 'tf012-auto-physical'},
  });
  assert.equal(check.ok, true, `the frozen run must stay uploadable: ${check.reason}`);
  const smuggled = autoAdapter.validateAutoLabResult({
    type: 'lab-result',
    run: {kind: 'tf012-auto-physical', runId: 'r', networkPayloadPath: 'NONE', expectedBits: 'AA'},
  });
  assert.equal(smuggled.ok, false, 'payload-shaped keys are still refused');
  // Everything the rotation block reports is local receiver state, and no frame content,
  // sender payload or oracle crosses into it.
  const histogram = JSON.stringify(result?.steps[0]?.receiver.rotations ?? {});
  for (const forbidden of ['rawBytes', 'payload', 'base64', 'oracle', 'sender']) {
    assert.ok(!histogram.includes(forbidden), `the histogram carries no ${forbidden}`);
  }
  // The receiver API behind it is local, and both hosts map it.
  const receiverSource = readFileSync(join(HERE, 'single-baseline.ts'), 'utf8');
  assert.ok(receiverSource.includes('rotationDiagnostics()'), 'the receiver exposes it');
  assert.ok(PAGE_JS.includes('receiver.rotationDiagnostics()'), 'the phone maps it');
  assert.ok(ADAPTER_JS.length > 0);
  assert.ok(!/[^.\w]fetch\s*\(/u.test(ADAPTER_JS), 'adapter: no fetch');
  assert.ok(!/https?:\/\//u.test(ADAPTER_JS), 'adapter: no HTTP URL');
});
