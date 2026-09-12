/**
 * TF-012 r14 — CONTROL-PLANE CORRECTNESS AND EVIDENCE QUALITY.
 *
 * WHY THIS FILE EXISTS
 *
 * The r13 physical run reported COMPLETE while the PC sender was never under auto-test
 * control: every frozen step carried the DEFAULT sender sample (`broadcasting:false`,
 * `cursor:null`) and the two "static chunk0" steps decoded 10 and 9 unique chunks. The
 * harness could not tell the difference between "the sender obeyed" and "nobody was
 * listening", and it started measuring before any state was confirmed.
 *
 * These tests pin the fixes:
 *   1  a run cannot start without a sender HELLO
 *   2  HELLO alone is not enough: fresh telemetry is required
 *   3  stale telemetry blocks the start
 *   4  SETUP begins only after fresh sender telemetry arrives
 *   5  the step timer starts only after the requested state is confirmed
 *   6  a static step aborts when uniqueReceived > 1
 *   7  a static step aborts when a chunk other than 0 is decoded
 *   8  A2 requires cyclic + holdMs 5000 confirmation
 *   9  A3 requires cyclic + holdMs 1000 confirmation
 *  10  A4's PAUSE requires telemetry to confirm paused=true
 *  11  STOP is sent after A5
 *  12  STOP confirmation is required before COMPLETE
 *  13  RUN_COMPLETE follows STOP
 *  14  the sender is left stopped after completion
 *  15  the final status cannot be overwritten by connection updates
 *  16  step-scoped FPS cannot reproduce the 1000 FPS artefact
 *  17  A4's before/during metrics are real interval deltas
 *  18  the final JSON stays local when the upload fails
 *  19  the lab-result uses a dedicated validator (the control validator is NOT weakened)
 *  20  no payload/frame/chunk bytes traverse the control channel
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {
  TF012_AUTO_ALLOWED_FIELDS,
  tf012AutoForbiddenFieldHits,
  tf012AutoStep,
  tf012AutoExpectedSenderState,
  tf012AutoSenderStateMismatch,
  validateTf012AutoControlMessage,
} from './tf012-auto-plan.ts';
import {TF012_AUTO_TELEMETRY_FRESH_MS} from './tf012-auto-orchestrator.ts';
import {createFakePeer, runAutoPlan} from './tf012-auto-fake-peer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS = join(HERE, '..', '..', '..');
const MINI = join(EXPERIMENTS, 'tf-008-wechat-mini-receiver-poc');
const PAGE_JS_PATH = join(MINI, 'pages', 'index', 'index.js');
const PAGE_JS = readFileSync(PAGE_JS_PATH, 'utf8');
const miniRequire = createRequire(import.meta.url);
const autoAdapter = miniRequire(join(MINI, 'utils', 'tf012-auto.js')) as Record<string, any>;

/** Index of the first command with this action, or -1. */
function indexOfAction(peer: ReturnType<typeof createFakePeer>, action: string): number {
  return peer.commands.findIndex((message) => String(message.action) === action);
}

/** Index of the STEP_COMPLETE for a step id, or -1. */
function indexOfStepComplete(peer: ReturnType<typeof createFakePeer>, stepId: string): number {
  return peer.commands.findIndex((message) => String(message.action) === 'STEP_COMPLETE'
    && String(message.stepId) === stepId);
}

// ---------------------------------------------------------------------------
// 1-4 — handshake and telemetry freshness
// ---------------------------------------------------------------------------

test('r14 handshake: a run cannot start without a sender HELLO', () => {
  const peer = createFakePeer({hello: false});
  peer.tick(30);

  assert.equal(peer.finalResult(), null, 'no run may finish without a sender peer');
  assert.equal(peer.commands.length, 0, 'not one control message may be sent');
  assert.equal(peer.frozen.length, 0);

  const last = peer.progress.at(-1);
  assert.equal(last?.phase, 'WAITING_FOR_SENDER');
  assert.equal(last?.senderHello, false);
  assert.equal(last?.senderConfirmed, false);
});

test('r14 handshake: HELLO alone is not enough — fresh telemetry is required', () => {
  const peer = createFakePeer({hello: true, telemetry: false});
  peer.tick(30);

  const last = peer.progress.at(-1);
  assert.equal(last?.senderHello, true, 'the hello itself was received');
  assert.equal(last?.telemetryAgeMs, null, 'but no telemetry ever arrived');
  assert.equal(last?.telemetryFresh, false);
  assert.equal(peer.commands.length, 0, 'the run must not begin on a hello alone');
  assert.equal(peer.finalResult(), null);
});

test('r14 handshake: stale telemetry blocks the start', () => {
  const peer = createFakePeer({telemetryAgeMs: TF012_AUTO_TELEMETRY_FRESH_MS + 1});
  peer.tick(30);

  const last = peer.progress.at(-1);
  assert.ok((last?.telemetryAgeMs ?? 0) > TF012_AUTO_TELEMETRY_FRESH_MS);
  assert.equal(last?.telemetryFresh, false);
  assert.equal(peer.commands.length, 0, 'stale telemetry must not unlock the run');
});

test('r14 handshake: SETUP begins only once fresh sender telemetry arrives', () => {
  const peer = createFakePeer({telemetry: false});
  peer.tick(10);
  assert.equal(peer.commands.length, 0, 'still waiting for the sender');

  // The sender finally reports in: only NOW may SETUP begin.
  peer.setTelemetryAt(peer.now());
  peer.tick(1);
  assert.equal(peer.progress.at(-1)?.phase, 'SETUP', 'SETUP starts on fresh telemetry');
  assert.equal(peer.commands[0]?.action, 'SET_MODE');
  assert.equal(peer.commands[0]?.stepId, 'SETUP');
  assert.equal(peer.commands[1]?.action, 'START');

  // A sender that goes silent mid-setup must not be able to complete the run: the
  // telemetry-loss guard ends it by name instead of letting it run blind.
  const abandoned = createFakePeer({staleAfterTick: 2, maxTicks: 60});
  abandoned.tick(60);
  assert.equal(abandoned.finalResult()?.status, 'SENDER_STATE_NOT_CONFIRMED');
  assert.match(String(abandoned.finalResult()?.validity.checks
    .find((check) => check.id === 'confirm_A1')?.detail ?? 'lost'), /lost|never/);
  assert.equal(abandoned.frozen.length, 0, 'a silent sender yields no evidence at all');
});

// ---------------------------------------------------------------------------
// 5 — the measurement timer starts only after confirmation
// ---------------------------------------------------------------------------

test('r14 confirmation: the step timer starts only after the sender proves its state', () => {
  const delayTicks = 4;
  const delayMs = delayTicks * 500;
  const peer = runAutoPlan({confirmationDelayTicks: delayTicks});
  // A2 is the first step whose requested state DIFFERS from the previous step (cyclic
  // after static), so it is the one that must wait for the sender.
  const a2 = peer.frozen.find((result) => result.stepId === 'A2');
  assert.ok(a2, 'A2 must be frozen');

  const requestedAt = Date.parse(a2.requestedAtIso);
  const confirmedAt = Date.parse(a2.confirmedAtIso);
  assert.ok(confirmedAt - requestedAt >= delayMs,
    `confirmation must lag the request by >= ${delayMs} ms (was ${confirmedAt - requestedAt})`);
  assert.equal(a2.senderConfirmed, true);
  // The timer measures the CONFIRMED window, not the request window.
  assert.equal(a2.actualDurationMs, a2.plannedDurationMs);
  assert.equal(a2.finishedAtIso, new Date(confirmedAt + a2.plannedDurationMs).toISOString());

  // And a sender that never proves the state aborts the run by name.
  const stubborn = runAutoPlan({obeyMode: false, maxTicks: 200});
  assert.equal(stubborn.finalResult()?.status, 'SENDER_STATE_NOT_CONFIRMED');
  // The static steps happen to match the stubborn sender's real state, so A1 is the last
  // step that may be measured; the first CYCLIC request is where it must stop.
  assert.deepEqual(stubborn.frozen.map((result) => result.stepId), ['A1']);
  const failed = stubborn.finalResult()?.validity.checks.find((check) => check.id === 'confirm_A2');
  assert.equal(failed?.ok, false);
  assert.match(failed?.detail ?? '', /mode is static, requested cyclic/);
  assert.equal(stubborn.actions().includes('STOP'), true);
});

// ---------------------------------------------------------------------------
// 6 + 7 — the static optical invariant
// ---------------------------------------------------------------------------

test('r14 static invariant: a static step aborts when uniqueReceived > 1', () => {
  const peer = runAutoPlan({staticDecode: 'many', maxTicks: 200});

  assert.equal(peer.finalResult()?.status, 'STATIC_INVARIANT_VIOLATION');
  assert.equal(peer.frozen.length, 0, 'the violating step must not be frozen');
  const check = peer.finalResult()?.validity.checks.find((entry) => entry.id === 'static_A1_invariant');
  assert.equal(check?.ok, false);
  // The abort happens at the FIRST static step after the gate, and it stops the sender.
  assert.equal(peer.commands.some((message) => String(message.stepId) === 'A2'), false,
    'no later step may run once the invariant is broken');
  assert.equal(peer.actions().includes('STOP'), true, 'the sender must be stopped');
});

test('r14 static invariant: a static step aborts when a chunk other than 0 is decoded', () => {
  const peer = runAutoPlan({staticDecode: 'other', maxTicks: 200});

  assert.equal(peer.finalResult()?.status, 'STATIC_INVARIANT_VIOLATION');
  const reason = peer.finalResult()?.status;
  assert.equal(reason, 'STATIC_INVARIANT_VIOLATION');
  assert.equal(peer.frozen.length, 0);
});

test('r14 static invariant: a healthy static step only ever sees chunk 0', () => {
  const peer = runAutoPlan();
  for (const id of ['A1', 'A5']) {
    const step = peer.frozen.find((result) => result.stepId === id);
    assert.ok(step, `${id} must be frozen`);
    // The WHOLE step is policed, including frames that arrived before confirmation.
    assert.deepEqual(step.stepInterval.decodedChunkIndexes, [0],
      `${id} is STATIC chunk0, so the whole step may only observe chunk 0`);
    assert.equal(step.stepInterval.uniqueReceivedDelta, 1);
    assert.equal(step.mode, 'static');
    assert.equal(peer.finalResult()?.validity.checks
      .find((check) => check.id === `static_${id}_invariant`)?.ok, true);
  }
});

// ---------------------------------------------------------------------------
// 8 + 9 — A2 / A3 require their own holdMs to be confirmed
// ---------------------------------------------------------------------------

test('r14 confirmation: A2 requires cyclic + holdMs 5000 to be confirmed', () => {
  const peer = runAutoPlan({obeyHoldMs: false, maxTicks: 200});
  assert.equal(peer.finalResult()?.status, 'SENDER_STATE_NOT_CONFIRMED');
  const check = peer.finalResult()?.validity.checks.find((entry) => entry.id === 'confirm_A2');
  assert.equal(check?.ok, false);
  assert.match(check?.detail ?? '', /holdMs is null, requested 5000/);
  assert.equal(peer.frozen.some((result) => result.stepId === 'A2'), false);

  // The matcher used by BOTH ends agrees, so the PC panel and the phone cannot disagree.
  const expected = tf012AutoExpectedSenderState(tf012AutoStep('A2'));
  assert.equal(expected.mode, 'cyclic');
  assert.equal(expected.holdMs, 5000);
  assert.equal(tf012AutoSenderStateMismatch({
    mode: 'cyclic', holdMs: 5000, cursor: 7, paused: false, broadcasting: true,
  }, expected), null);
  assert.match(String(tf012AutoSenderStateMismatch({
    mode: 'cyclic', holdMs: 1000, cursor: 7, paused: false, broadcasting: true,
  }, expected)), /holdMs is 1000, requested 5000/);
});

test('r14 confirmation: A3 requires cyclic + holdMs 1000 to be confirmed', () => {
  const peer = runAutoPlan();
  const a3 = peer.frozen.find((result) => result.stepId === 'A3');
  assert.ok(a3);
  assert.equal(a3.senderConfirmed, true);
  assert.equal(a3.sender.mode, 'cyclic', 'A3 froze only after the sender was cyclic');
  assert.equal(a3.sender.holdMs, 1000, 'A3 froze only after holdMs 1000 was live');
  assert.equal(a3.senderStateRequested, 'CYCLIC 1000 ms');
  assert.equal(peer.commands.filter((message) => String(message.action) === 'SET_HOLD_MS'
    && String(message.stepId) === 'A3')[0]?.holdMs, 1000);
  // A cyclic step legitimately sees more than one chunk — that is NOT a violation.
  assert.ok(a3.interval.decodedChunkIndexes.length > 1);
});

// ---------------------------------------------------------------------------
// 10 — A4's PAUSE must be confirmed
// ---------------------------------------------------------------------------

test('r14 A4: PAUSE requires telemetry to confirm paused=true', () => {
  const peer = runAutoPlan();
  const a4 = peer.frozen.find((result) => result.stepId === 'A4');
  assert.ok(a4);
  assert.equal(a4.duringPause?.sender.paused, true, 'the frozen carrier is the confirmed state');
  assert.equal(a4.beforePause?.sender.paused, false);
  const pause = peer.commands.find((message) => String(message.action) === 'PAUSE');
  assert.equal(pause?.chunkIndex, a4.beforePause?.sender.cursor,
    'PAUSE reports the cursor it actually froze');
  const progress = peer.progress.at(-1);
  assert.equal(progress?.pauseConfirmed, true);

  // A sender that ignores PAUSE must abort instead of freezing a moving carrier.
  const stubborn = runAutoPlan({obeyPause: false, maxTicks: 300});
  assert.equal(stubborn.finalResult()?.status, 'SENDER_STATE_NOT_CONFIRMED');
  const check = stubborn.finalResult()?.validity.checks.find((entry) => entry.id === 'confirm_A4_pause');
  assert.equal(check?.ok, false);
  assert.match(check?.detail ?? '', /paused=true/);
  assert.equal(stubborn.frozen.some((result) => result.stepId === 'A4'), false);
});

// ---------------------------------------------------------------------------
// 11-14 — the completion lifecycle
// ---------------------------------------------------------------------------

test('r14 completion: STOP is sent after A5, RUN_COMPLETE follows it, and the sender ends stopped', () => {
  const peer = runAutoPlan();
  const final = peer.finalResult();
  assert.equal(final?.status, 'COMPLETE');

  const a5Complete = indexOfStepComplete(peer, 'A5');
  const stop = indexOfAction(peer, 'STOP');
  const complete = indexOfAction(peer, 'RUN_COMPLETE');
  assert.ok(a5Complete >= 0 && stop >= 0 && complete >= 0);
  assert.ok(stop > a5Complete, 'STOP must come after A5 is frozen');
  assert.ok(complete > stop, 'RUN_COMPLETE must come after STOP');
  assert.equal(peer.actions().filter((action) => action === 'STOP').length, 1,
    'a clean run stops the sender exactly once');

  // 14 — the carrier is really off after completion, both in the fake peer and in the
  // sender's own defensive RUN_COMPLETE handling.
  assert.equal(peer.sender.broadcasting, false);
  assert.equal(peer.sender.paused, false);
  assert.equal(final?.timeline.stopConfirmedAtIso != null, true);
  assert.equal(final?.validity.checks.find((check) => check.id === 'stop_confirmed')?.ok, true);
});

test('r14 completion: STOP confirmation is required before COMPLETE', () => {
  const peer = runAutoPlan({obeyStop: false, maxTicks: 300});
  const final = peer.finalResult();

  assert.equal(final?.status, 'STOP_NOT_CONFIRMED');
  assert.equal(final?.validity.valid, false);
  assert.equal(final?.validity.checks.find((check) => check.id === 'stop_confirmed')?.ok, false);
  assert.equal(peer.sender.broadcasting, true, 'the simulator never stopped, so the run cannot claim success');
  // All five steps did run and are preserved — the failure is only the shutdown.
  assert.equal(peer.frozen.length, 5);
  assert.equal(indexOfAction(peer, 'RUN_COMPLETE'), -1, 'no COMPLETE may be announced');
  assert.equal(indexOfAction(peer, 'RUN_ABORTED') > -1, true);
  assert.match(String(peer.commands.find((message) => String(message.action) === 'RUN_ABORTED')?.reason ?? ''),
    /STOP_NOT_CONFIRMED/);
});

// ---------------------------------------------------------------------------
// 15 — the final status cannot be overwritten
// ---------------------------------------------------------------------------

test('r14 phone UI: the run status and the control status are separate fields', () => {
  // Source-level invariant: the control-channel handler must not touch the run verdict.
  const handler = PAGE_JS.slice(PAGE_JS.indexOf('onStatus: (status) => this.setData('));
  const handlerBody = handler.slice(0, handler.indexOf('}'));
  assert.ok(handler.indexOf('autoControlStatus') > 0, 'the handler updates the control status');
  assert.equal(handlerBody.includes('autoRunStatus'), false,
    'the connection handler must never write the run status');

  // Behavioural check through the shipped page: a finished run stays visible while the
  // channel is still reported online.
  const store = new Map<string, unknown>();
  (globalThis as unknown as Record<string, unknown>).wx = {
    setStorageSync: (key: string, value: unknown) => store.set(key, value),
    getStorageSync: (key: string) => (store.has(key) ? store.get(key) : ''),
    removeStorageSync: (key: string) => store.delete(key),
    setClipboardData: () => {},
    showToast: () => {},
    showModal: () => {},
    env: {USER_DATA_PATH: '/tmp'},
  };
  let captured: Record<string, any> | null = null;
  (globalThis as unknown as Record<string, unknown>).Page = (config: Record<string, any>) => { captured = config; };
  miniRequire(PAGE_JS_PATH);
  assert.ok(captured, 'Page() was called');
  const config = captured as unknown as Record<string, any>;
  const ctx: Record<string, any> = Object.assign(Object.create(null), config);
  ctx.data = JSON.parse(JSON.stringify(config.data));
  ctx.setData = (patch: Record<string, unknown>) => { Object.assign(ctx.data, patch); };

  Object.assign(ctx.data, ctx.autoProgressPatch({
    phase: 'DONE', status: 'COMPLETE', stepId: 'A5', label: 'Step A5 / 5', stepIndex: 5,
    stepCount: 5, remainingMs: 0, paused: false, senderConnected: true, senderHello: true,
    telemetryAgeMs: 12, telemetryFresh: true, requested: 'STATIC chunk0', senderConfirmed: true,
    senderMismatch: null, pauseRequested: true, pauseConfirmed: true, frozenCursor: 3, holdMs: null,
  }));
  assert.match(ctx.data.autoRunStatus, /COMPLETE/);

  // A later connection update (exactly what the runner's onStatus writes).
  Object.assign(ctx.data, {
    autoConnected: true,
    autoControlStatus: 'Control: ONLINE / 控制通道在线',
  });
  assert.match(ctx.data.autoRunStatus, /COMPLETE/, 'the verdict survives the connection update');
  assert.match(ctx.data.autoControlStatus, /ONLINE/);

  // A waiting run says so on both lines.
  Object.assign(ctx.data, ctx.autoProgressPatch({
    phase: 'WAITING_FOR_SENDER', status: 'WAITING_FOR_SENDER', stepId: null,
    label: 'WAITING FOR PC SENDER', stepIndex: 0, stepCount: 5, remainingMs: 0, paused: false,
    senderConnected: false, senderHello: false, telemetryAgeMs: null, telemetryFresh: false,
    requested: '—', senderConfirmed: false, senderMismatch: null, pauseRequested: false,
    pauseConfirmed: false, frozenCursor: null, holdMs: null,
  }));
  assert.match(ctx.data.autoRunStatus, /WAITING FOR PC SENDER/);
  assert.match(ctx.data.autoHandshake, /WAITING FOR PC SENDER/);
});

// ---------------------------------------------------------------------------
// 16 — step-scoped FPS
// ---------------------------------------------------------------------------

test('r14 FPS: frozen evidence is step-scoped and cannot inherit the 1000 FPS artefact', () => {
  // The r13 physical JSON contained callbackFps = 1000, produced by dividing a tiny
  // UI-window denominator. Feed exactly that artefact into the receiver sample and prove
  // the frozen result replaces it with a step-scoped measurement.
  const peer = runAutoPlan({windowFps: 1000});

  for (const result of peer.frozen) {
    assert.equal(result.receiver.callbackFps, result.interval.callbackFps,
      `${result.stepId}: the frozen receiver must carry the step-scoped FPS`);
    assert.equal(result.receiver.processingFps, result.interval.processingFps);
    assert.notEqual(result.receiver.callbackFps, 1000, `${result.stepId} must not keep 1000 FPS`);
    assert.ok((result.receiver.callbackFps ?? 0) > 0 && (result.receiver.callbackFps ?? 0) <= 120,
      `${result.stepId}: step-scoped FPS must be physical (was ${result.receiver.callbackFps})`);
    const seconds = result.interval.durationMs / 1000;
    assert.equal(result.interval.callbackFps,
      result.interval.cameraFramesDelta / seconds);
  }
  // A2 runs 25 s at 30 camera FPS, which is what the step-scoped number reports.
  const a2 = peer.frozen.find((result) => result.stepId === 'A2');
  assert.equal(a2?.interval.callbackFps, 30);
});

// ---------------------------------------------------------------------------
// 17 — A4 interval deltas
// ---------------------------------------------------------------------------

test('r14 A4: before/during metrics are independent interval deltas', () => {
  const peer = runAutoPlan();
  const a4 = peer.frozen.find((result) => result.stepId === 'A4');
  assert.ok(a4?.beforePause && a4?.duringPause);

  const before = a4.beforePause.interval;
  const during = a4.duringPause.interval;
  // 5 s of cyclic, then 10 s frozen — measured, not assumed.
  assert.equal(before.durationMs, tf012AutoStep('A4').runMs);
  assert.equal(during.durationMs, tf012AutoStep('A4').pauseMs);
  assert.equal(before.durationMs + during.durationMs <= a4.actualDurationMs, true);
  assert.ok(before.cameraFramesDelta > 0 && during.cameraFramesDelta > 0,
    'a frozen carrier still receives camera frames — that is the A4 question');
  assert.ok(during.successfulDecodesDelta > 0,
    'the whole point of A4 is that decoding continues while the frame is frozen');
  // Deltas of the SAME counters, and the two intervals plus the confirmation lag are the
  // only things in the step: neither interval is the cumulative step total.
  assert.ok(before.successfulDecodesDelta + during.successfulDecodesDelta <= a4.stepInterval.successfulDecodesDelta);
  assert.ok(before.successfulDecodesDelta < a4.stepInterval.successfulDecodesDelta);
  assert.ok(during.successfulDecodesDelta < a4.stepInterval.successfulDecodesDelta,
    'duringPause must be an interval, not the whole-step cumulative counter');
  assert.equal(before.durationMs + during.durationMs < a4.stepInterval.durationMs, true);
  // Each interval has its own FPS, computed from its own deltas.
  assert.equal(before.callbackFps, before.cameraFramesDelta / (before.durationMs / 1000));
  assert.equal(during.callbackFps, during.cameraFramesDelta / (during.durationMs / 1000));
});

// ---------------------------------------------------------------------------
// 18 + 19 — result delivery
// ---------------------------------------------------------------------------

test('r14 result: a failed upload never costs the run, and the lab-result has its own validator', () => {
  // 19a — the dedicated validator accepts a real run result...
  const run = {
    kind: 'tf012-auto-physical',
    networkPayloadPath: 'NONE',
    runId: 'tf012-1789226096012',
    buildId: 'tf012-r14-test',
    planVersion: 'tf012-auto-v1',
    status: 'COMPLETE',
    validity: {valid: true, checks: []},
    steps: [{stepId: 'A1', interval: {successfulDecodesDelta: 12}}],
  };
  assert.equal(autoAdapter.validateAutoLabResult({type: 'lab-result', run}).ok, true);

  // ...rejects a result that carries a payload-shaped key...
  assert.equal(autoAdapter.validateAutoLabResult({
    type: 'lab-result',
    run: {...run, chunkPayload: 'AAEC'},
  }).ok, false);
  // ...rejects a non-NONE payload path, an unknown kind and a missing run...
  assert.equal(autoAdapter.validateAutoLabResult({
    type: 'lab-result', run: {...run, networkPayloadPath: 'WEBSOCKET'},
  }).ok, false);
  assert.equal(autoAdapter.validateAutoLabResult({type: 'lab-result', run: {...run, kind: 'other'}}).ok, false);
  assert.equal(autoAdapter.validateAutoLabResult({type: 'lab-result'}).ok, false);
  assert.equal(autoAdapter.validateAutoLabResult({type: 'command', action: 'START'}).ok, false);

  // 19b — and the CONTROL validator is NOT weakened to accommodate it. This is the exact
  // r13 bug: `publish()` rejected the lab-result and the run JSON never left the phone.
  assert.equal(validateTf012AutoControlMessage({type: 'lab-result', run}).ok, false);
  assert.match(String(validateTf012AutoControlMessage({type: 'lab-result', run}).reason),
    /unexpected message type lab-result/);

  // 19c — the client routes them down different paths: control through the schema,
  // results through the dedicated validator, and it reports which one failed.
  const sent: string[] = [];
  const socket = {
    onOpen: (handler: () => void) => { socket.open = handler; },
    onMessage: () => {},
    onClose: () => {},
    onError: () => {},
    send: (options: {data: string}) => { sent.push(options.data); },
    open: null as null | (() => void),
    close: () => {},
  };
  (globalThis as unknown as Record<string, unknown>).wx = {
    ...(globalThis as unknown as Record<string, any>).wx,
    connectSocket: () => socket,
  };
  const client = autoAdapter.createControlClient({url: 'wss://example/lab', token: '', onLog: () => {}});
  assert.equal(client.publishResult({type: 'lab-result', run}), false, 'not connected yet');
  client.connect();
  socket.open?.();
  assert.equal(client.publish({type: 'lab-result', run}), false,
    'the control path must keep rejecting a result envelope');
  assert.match(String(client.status().lastError), /unexpected message type lab-result/);
  assert.equal(client.publishResult({type: 'lab-result', run}), true);
  assert.equal(JSON.parse(sent.at(-1) ?? '{}').type, 'lab-result');
  client.close();

  // 18 — and the page keeps the final JSON locally whatever happens to the upload.
  const store = new Map<string, unknown>();
  (globalThis as unknown as Record<string, unknown>).wx = {
    setStorageSync: (key: string, value: unknown) => store.set(key, value),
    getStorageSync: (key: string) => (store.has(key) ? store.get(key) : ''),
    removeStorageSync: (key: string) => store.delete(key),
    setClipboardData: () => {},
    showToast: () => {},
    showModal: () => {},
    env: {USER_DATA_PATH: '/tmp'},
  };
  let captured: Record<string, any> | null = null;
  (globalThis as unknown as Record<string, unknown>).Page = (config: Record<string, any>) => { captured = config; };
  delete miniRequire.cache[miniRequire.resolve(PAGE_JS_PATH)];
  miniRequire(PAGE_JS_PATH);
  assert.ok(captured, 'Page() was called');
  const config = captured as unknown as Record<string, any>;
  const ctx: Record<string, any> = Object.assign(Object.create(null), config);
  ctx.data = JSON.parse(JSON.stringify(config.data));
  ctx.setData = (patch: Record<string, unknown>) => { Object.assign(ctx.data, patch); };
  ctx.appendLog = () => {};

  ctx.onAutoRunResult({...run, steps: [], stepsCompleted: 5, stepsPlanned: 5,
    timeline: {stopConfirmedAtIso: 'x'}, setupGate: {label: 'SETUP READY', reasons: []}});
  ctx.onAutoUploadStatus('failed');
  assert.equal(ctx.data.autoFinalJsonReady, 'YES', 'the JSON exists even though the upload failed');
  assert.match(ctx.data.autoResultUpload, /failed/);
  const local = JSON.parse(ctx.data.autoFinalJson);
  assert.equal(local.runId, run.runId);
  assert.equal(local.resultUpload, 'failed');
  ctx.onAutoUploadStatus('success');
  assert.equal(JSON.parse(ctx.data.autoFinalJson).resultUpload, 'success');
});

// ---------------------------------------------------------------------------
// 20 — no payload over the control channel
// ---------------------------------------------------------------------------

test('r14 control channel: nothing the harness emits can carry payload or an oracle', () => {
  const peer = runAutoPlan();

  for (const message of peer.commands) {
    const check = validateTf012AutoControlMessage(message);
    assert.equal(check.ok, true, `illegal control message: ${check.reason}`);
    assert.deepEqual(tf012AutoForbiddenFieldHits(message), [],
      `${String(message.action)} carries a payload-shaped field`);
    for (const [key, value] of Object.entries(message)) {
      if (typeof value === 'string' && key !== 'reason') {
        assert.ok(value.length <= 180, `${String(message.action)}.${key} exceeded the string budget`);
      }
    }
  }
  // Message shapes are exactly the plan: no step may smuggle an extra field.
  for (const message of peer.commands) {
    const allowed = new Set(TF012_AUTO_ALLOWED_FIELDS[String(message.action) as keyof typeof TF012_AUTO_ALLOWED_FIELDS]);
    for (const key of Object.keys(message)) {
      assert.equal(allowed.has(key), true, `${key} is not allowed on ${String(message.action)}`);
    }
  }
  // And the run states the payload path explicitly.
  assert.equal(peer.finalResult()?.networkPayloadPath, 'NONE');
});

test('r14 completion: RUN_COMPLETE stops the sender surface defensively', () => {
  // The browser sender must stop on RUN_COMPLETE even if the STOP message were lost, so
  // the PO never has to press Stop after a finished run. Pinned in the browser suite
  // (which can actually drive the page) and asserted here as a source invariant.
  const SENDER_SPEC = readFileSync(join(EXPERIMENTS, 'tf-002-single-code', 'single-baseline-sender.spec.ts'), 'utf8');
  assert.match(SENDER_SPEC, /r14 completion: RUN_COMPLETE stops the sender/,
    'the browser suite must pin the defensive stop');
  const SENDER_MAIN = readFileSync(
    join(EXPERIMENTS, 'tf-002-single-code', 'src', 'tf012-auto-sender-client.ts'), 'utf8');
  assert.match(SENDER_MAIN, /case 'RUN_COMPLETE':[\s\S]{0,400}?surface\.sample\(\)\.broadcasting\) surface\.stop\(\)/,
    'RUN_COMPLETE must stop the carrier if it is still broadcasting');
});
