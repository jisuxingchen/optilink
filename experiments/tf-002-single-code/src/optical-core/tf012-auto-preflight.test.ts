/**
 * TF-012 r17 — AUTO-TEST PRE-FLIGHT AND SETUP SEQUENCING.
 *
 * WHY THIS FILE EXISTS
 *
 * A physical r15b run reported SETUP_NOT_READY — an OPTICAL verdict — while the same
 * phone was decoding STATIC chunk 0 at 97.95% with reservedPatternScore 0.998, contrast
 * 175 and 0 locate failures. The camera was fine. The HARNESS was not:
 *
 *   - nothing proved the camera was acquiring frames before the 5 s setup window opened;
 *   - the page could be in a mode whose receiver the gate does not read (the baseline
 *     counters stay at zero while the camera is perfectly live);
 *   - SETUP was timed from the COMMAND, not from proof that the sender obeyed it, so the
 *     window could close before the carrier had even switched to static chunk 0;
 *   - metrics were reset at command issue, so the window's baseline was not the state
 *     the gate was actually measuring;
 *   - the failure modal re-read LIVE counters (4000+ decodes) next to a gate verdict of
 *     zero, from different windows, with nothing labelling the difference.
 *
 * These tests pin the fix:
 *   1  Auto Test one-tap starts the camera if it is not already running
 *   2  SETUP cannot begin before callbackActive
 *   3  SETUP cannot begin before fresh camera frames exist
 *   4  sender-ready but camera-not-ready remains WAITING_FOR_CAMERA
 *   5  camera-ready but sender-not-ready remains WAITING_FOR_SENDER
 *   6  SETUP commands are sent only when the prerequisites are ready
 *   7  the setup timer starts only after static chunk 0 is CONFIRMED
 *   8  setup confirmation requires mode=static, cursor=0, broadcasting=true, paused=false
 *   9  the metric reset happens at measurement start, not at command issue
 *  10  the setup gate sees post-confirmation frames only
 *  11  a zero-frame setup window is CAMERA_NOT_READY, never SETUP_NOT_READY
 *  12  the setup evidence shown on the phone is exactly the sample the gate used
 *  13  A1-A5 semantics are unchanged (full-plan control run)
 *  14  no network payload path is added
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {
  TF012_AUTO_SETUP_STEP,
  tf012AutoExpectedSenderState,
  tf012AutoSenderStateMismatch,
  validateTf012AutoControlMessage,
} from './tf012-auto-plan.ts';
import {
  TF012_AUTO_CAMERA_FRAME_FRESH_MS,
  TF012_AUTO_CAMERA_MIN_BASELINE_FRAMES,
  TF012_AUTO_CAMERA_MIN_FRAMES,
  tf012AutoCameraReadiness,
} from './tf012-auto-orchestrator.ts';
import {createFakePeer, runAutoPlan} from './tf012-auto-fake-peer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS = join(HERE, '..', '..', '..');
const MINI = join(EXPERIMENTS, 'tf-008-wechat-mini-receiver-poc');
const PAGE_JS_PATH = join(MINI, 'pages', 'index', 'index.js');
const PAGE_JS = readFileSync(PAGE_JS_PATH, 'utf8');
const PAGE_WXML = readFileSync(join(MINI, 'pages', 'index', 'index.wxml'), 'utf8');
const ADAPTER_JS = readFileSync(join(MINI, 'utils', 'tf012-auto.js'), 'utf8');

// ---------------------------------------------------------------------------
// Mini Program page harness: enough `wx` to run the real onAutoTest() in Node.
// ---------------------------------------------------------------------------

interface PhonePage {
  data: Record<string, any>;
  [key: string]: any;
}

interface LoadedPhone {
  page: PhonePage;
  modals: string[];
  toasts: string[];
}

function loadPhonePage(): LoadedPhone {
  const modals: string[] = [];
  const toasts: string[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.wx = {
    showToast: (options: {title?: string}) => { toasts.push(String(options && options.title)); },
    showModal: (options: {title?: string; content?: string}) => {
      modals.push(`${String(options && options.title)}\n${String(options && options.content)}`);
    },
    createCameraContext: () => ({
      onCameraFrame: () => ({
        start: (options: {success?: () => void}) => { options.success?.(); },
        stop: () => undefined,
      }),
    }),
    connectSocket: () => {
      const socket: Record<string, any> = {
        sent: [],
        onOpen: (callback: () => void) => { socket.openCb = callback; },
        onMessage: (callback: (event: unknown) => void) => { socket.messageCb = callback; },
        onClose: (callback: () => void) => { socket.closeCb = callback; },
        onError: (callback: () => void) => { socket.errorCb = callback; },
        send: (payload: unknown) => { socket.sent.push(payload); },
        close: () => undefined,
      };
      return socket;
    },
    setStorageSync: () => undefined,
    getStorageSync: () => '',
    removeStorageSync: () => undefined,
  };
  let captured: Record<string, any> | null = null;
  globals.Page = (config: Record<string, any>) => { captured = config; };
  const require2 = createRequire(import.meta.url);
  delete require2.cache[require2.resolve(PAGE_JS_PATH)];
  require2(PAGE_JS_PATH);
  assert.ok(captured, 'Page() was called');
  const page = captured as unknown as PhonePage;
  // A real page instance: methods are called with `this` bound to the page, and setData
  // merges into data exactly as the platform does.
  const instance: PhonePage = Object.create(page);
  instance.data = JSON.parse(JSON.stringify(page.data)) as Record<string, any>;
  instance.setData = (patch: Record<string, unknown>) => { Object.assign(instance.data, patch); };
  return {page: instance, modals, toasts};
}

// ---------------------------------------------------------------------------
// 1 — one tap prepares the phone: baseline mode + camera
// ---------------------------------------------------------------------------

test('r17 preflight 1: Auto Test one-tap starts the camera and selects baseline mode', () => {
  const {page, toasts} = loadPhonePage();
  assert.equal(page.data.mode, 'receive', 'the page starts in receive mode');
  assert.equal(page.data.running, false, 'and with the camera stopped');
  page.data.autoControlUrl = 'ws://127.0.0.1:5173/lab';
  page.frameListener = null;

  const order: string[] = [];
  const originalSetMode = page.setMode;
  page.setMode = (mode: string) => { order.push(`mode:${mode}`); return originalSetMode.call(page, mode); };
  const originalStartCamera = page.startCamera;
  page.startCamera = () => { order.push('startCamera'); return originalStartCamera.call(page); };

  page.onAutoTest();

  try {
    assert.deepEqual(order, ['mode:baseline', 'startCamera'],
      'the tap switches the receiver to single-code baseline and starts the camera, in that order');
    assert.equal(page.data.mode, 'baseline', 'the page now runs the pipeline the gate reads');
    assert.ok(page.frameListener, 'the camera frame listener was created');
    assert.equal(toasts.length, 0, 'no configuration toast: one tap is enough');
    assert.ok(page.autoRunner, 'the runner was created after the pre-flight');
    assert.equal(page.autoRunner.isRunning(), true, 'and it is running');

    // The adapter really is wired to the camera probe (else the orchestrator can never
    // leave WAITING_FOR_CAMERA).
    const camera = page.autoCameraStatus();
    assert.equal(camera.listening, true);
    assert.equal(typeof camera.framesReceived, 'number');
    assert.equal(typeof camera.baselineFrames, 'number');
    assert.equal(camera.lastFrameAt, null, 'no frame has arrived yet');
  } finally {
    page.autoRunner.dispose();
  }
});

test('r17 preflight 1b: a second tap while a run is active does not restart anything', () => {
  const {page, toasts} = loadPhonePage();
  page.data.autoControlUrl = 'ws://127.0.0.1:5173/lab';
  page.onAutoTest();
  try {
    const runner = page.autoRunner;
    page.onAutoTest();
    assert.equal(page.autoRunner, runner, 'the same runner is still in charge');
    assert.equal(toasts.length, 1, 'the second tap only explains why nothing happened');
    assert.match(toasts[0], /already running/i);
  } finally {
    page.autoRunner.dispose();
  }
});

// ---------------------------------------------------------------------------
// 2-5 — the pre-flight gate itself
// ---------------------------------------------------------------------------

test('r17 preflight 2: SETUP cannot begin before a CameraFrame callback has fired', () => {
  const peer = createFakePeer({cameraCallbackActive: false});
  peer.tick(12);

  const last = peer.progress.at(-1);
  assert.equal(last?.phase, 'WAITING_FOR_CAMERA', 'the camera is not "ready" without a callback');
  assert.equal(last?.cameraReady, false);
  assert.equal(peer.commands.length, 0, 'not one control message may be sent');
  assert.match(String(last?.cameraDetail), /callback/i, 'the UI is told exactly why');
});

test('r17 preflight 3: SETUP cannot begin before fresh camera frames exist', () => {
  // The camera is delivering, but only AFTER the wait begins (cameraStartsAfterTicks),
  // so the readiness rule must count frames from the run, not from history.
  const peer = createFakePeer({cameraStartsAfterTicks: 4, maxTicks: 8});
  peer.tick(3);
  assert.equal(peer.progress.at(-1)?.phase, 'WAITING_FOR_CAMERA', 'no frames yet');
  assert.equal(peer.commands.length, 0);
  assert.match(String(peer.progress.at(-1)?.cameraDetail), /frames since the run started|no camera frame/i);

  peer.tick(3);
  assert.notEqual(peer.progress.at(-1)?.phase, 'WAITING_FOR_CAMERA', 'frames arriving unlock SETUP');
});

test('r17 preflight 3b: frames that never reach the baseline pipeline are not acquisition', () => {
  // The r15b signature: the page is NOT running the single-code receiver, so it delivers
  // camera frames all day while the pipeline the gate reads stays at zero.
  const peer = createFakePeer({cameraFeedsBaseline: false, maxTicks: 40});
  peer.runUntilFinal();

  const result = peer.finalResult();
  assert.equal(result?.status, 'CAMERA_NOT_READY', 'named as an acquisition fault');
  assert.equal(result?.steps.length, 0, 'no step may be measured');
  assert.deepEqual(peer.actions(), ['STOP', 'RUN_ABORTED'],
    'no SETUP command is issued; only the abort lifecycle (STOP then RUN_ABORTED)');
  assert.equal(peer.resets.length, 0, 'no setup window ever opened');
});

test('r17 preflight 4: sender-ready but camera-not-ready stays in WAITING_FOR_CAMERA', () => {
  const peer = createFakePeer({cameraStartsAfterTicks: 99, maxTicks: 4});
  peer.tick(4);

  const last = peer.progress.at(-1);
  assert.equal(last?.senderHello, true, 'the sender peer IS ready');
  assert.equal(last?.telemetryFresh, true, 'with fresh telemetry');
  assert.equal(last?.phase, 'WAITING_FOR_CAMERA', 'and the run still waits for the camera');
  assert.equal(peer.commands.length, 0);
});

test('r17 preflight 5: camera-ready but sender-not-ready stays in WAITING_FOR_SENDER', () => {
  const peer = createFakePeer({telemetry: false, maxTicks: 6});
  peer.tick(6);

  const last = peer.progress.at(-1);
  assert.equal(last?.phase, 'WAITING_FOR_SENDER', 'the sender comes first');
  assert.equal(last?.cameraReady, false, 'the camera was never probed');
  assert.equal(peer.commands.length, 0, 'the camera cannot unlock a run by itself');
});

test('r17 preflight 5b: the camera wait itself times out as CAMERA_NOT_READY', () => {
  const peer = createFakePeer({cameraStartsAfterTicks: 999, maxTicks: 80});
  peer.runUntilFinal();

  const result = peer.finalResult();
  assert.equal(result?.status, 'CAMERA_NOT_READY');
  assert.equal(result?.steps.length, 0, 'nothing was measured');
  assert.ok(!peer.actions().includes('SET_MODE'), 'a camera that never starts costs no SETUP command');
  assert.match(String(result?.setupGate.evidenceWindow), /null/,
    'no setup window exists, so none is reported: absence is stated, not invented');
});

test('r17 preflight 6: SETUP commands are sent only once every prerequisite is ready', () => {
  // The fake delivers 3 frames per tick, so the 5-frame rule is met on the tick after the
  // camera becomes live. Nothing may be sent before that.
  const peer = createFakePeer({cameraStartsAfterTicks: 1, maxTicks: 6});
  peer.tick(1);
  assert.equal(peer.commands.length, 0, 'still waiting for acquisition');
  assert.equal(peer.progress.at(-1)?.cameraReady, false);

  peer.tick(2);
  const last = peer.progress.at(-1);
  assert.equal(last?.cameraReady, true, 'acquisition is proven');
  assert.equal(peer.commands[0]?.action, 'SET_MODE', 'and only then does the first command go out');
  assert.equal(peer.commands[0]?.stepId, 'SETUP');
  assert.equal(peer.commands[0]?.mode, 'static');
  assert.equal(peer.commands[0]?.chunkIndex, 0);
  assert.equal(peer.commands[1]?.action, 'START');
  assert.equal(peer.actions().includes('RESUME'), false, 'a running sender needs no resume');
});

// ---------------------------------------------------------------------------
// 7-9 — SETUP uses the SAME confirmation discipline as A1..A5
// ---------------------------------------------------------------------------

test('r17 setup 7: the setup window opens on CONFIRMATION, never on command issue', () => {
  // A sender left CYCLING by the previous session: it can only prove "static chunk 0"
  // after SET_MODE lands, which the fake delays by `confirmationDelayTicks`.
  const delayTicks = 3;
  const peer = createFakePeer({
    initialMode: 'cyclic', cameraStartsAfterTicks: 1, confirmationDelayTicks: delayTicks, maxTicks: 200,
  });
  peer.tick(1);
  assert.equal(peer.commands.length, 0, 'still waiting for acquisition');
  assert.equal(peer.progress.at(-1)?.cameraReady, false);

  // Advance to the moment the SETUP request goes out and inspect the state AT that
  // moment: the request must not have opened anything.
  let guard = 0;
  while (!peer.actions().includes('SET_MODE') && guard < 8) { peer.tick(1); guard += 1; }
  assert.equal(peer.actions().includes('SET_MODE'), true, 'the request went out');
  assert.equal(peer.progress.at(-1)?.setupConfirmed, false, 'but nothing is confirmed yet');
  assert.notEqual(peer.progress.at(-1)?.phase, 'SETUP', 'so the setup window is NOT open');
  assert.equal(peer.resets.length, 0, 'and no metric reset has happened');
  assert.match(String(peer.progress.at(-1)?.senderMismatch), /mode/i,
    'the phone can see exactly why it is waiting');

  peer.tick(delayTicks + 4);
  assert.equal(peer.progress.at(-1)?.setupConfirmed, true, 'the sender proved static chunk0');
  assert.equal(peer.progress.at(-1)?.phase, 'SETUP', 'the window is open now');
  assert.equal(peer.progress.at(-1)?.setupWindowOpen, true);
  assert.equal(peer.progress.at(-1)?.stepId, 'SETUP');
  assert.match(String(peer.progress.at(-1)?.cameraDetail), /live:/, 'and the camera is reported live');

  // The countdown is measured from CONFIRMATION: its first observed value is the full
  // setup duration, not the remainder left over from command issue.
  const firstSetup = peer.progress.find((entry) => entry.phase === 'SETUP');
  assert.equal(firstSetup?.remainingMs, 5000, 'the setup window starts at its full length');
});

test('r17 setup 8: setup confirmation requires static chunk0, running, not paused', () => {
  const expected = tf012AutoExpectedSenderState(TF012_AUTO_SETUP_STEP);
  assert.deepEqual(expected, {mode: 'static', holdMs: null, cursor: 0, paused: false, broadcasting: true},
    'SETUP pins mode=static, cursor=0, broadcasting=true, paused=false');

  const healthy = {mode: 'static', holdMs: null, cursor: 0, paused: false, broadcasting: true} as const;
  assert.equal(tf012AutoSenderStateMismatch(healthy, expected), null, 'a real static chunk0 sender confirms');
  assert.match(String(tf012AutoSenderStateMismatch({...healthy, mode: 'cyclic'}, expected)), /mode/i);
  assert.match(String(tf012AutoSenderStateMismatch({...healthy, cursor: 3}, expected)), /cursor/i);
  assert.match(String(tf012AutoSenderStateMismatch({...healthy, broadcasting: false}, expected)), /not broadcasting/i);
  assert.match(String(tf012AutoSenderStateMismatch({...healthy, paused: true}, expected)), /paused/i);

  // End-to-end: a sender that ignores SET_MODE keeps cycling and SETUP can never open.
  const peer = createFakePeer({initialMode: 'cyclic', obeyMode: false, maxTicks: 60});
  peer.runUntilFinal();
  const result = peer.finalResult();
  assert.equal(result?.status, 'SENDER_STATE_NOT_CONFIRMED');
  assert.equal(result?.steps.length, 0, 'no step was measured on an unconfirmed sender');
  assert.equal(peer.progress.some((entry) => entry.phase === 'SETUP'), false,
    'the setup window never opened');
  assert.equal(peer.resets.length, 0, 'and no metrics were reset for a window that never opened');
});

test('r17 setup 9: the metric reset happens at measurement start, not at command issue', () => {
  const delayTicks = 3;
  const peer = createFakePeer({
    initialMode: 'cyclic', cameraStartsAfterTicks: 1, confirmationDelayTicks: delayTicks, maxTicks: 30,
  });
  peer.tick(1);
  // Walk to the SETUP request, then prove the reset had NOT happened yet.
  let guard = 0;
  while (!peer.actions().includes('SET_MODE') && guard < 8) { peer.tick(1); guard += 1; }
  const commandTick = peer.tickOfAction('SET_MODE');
  assert.ok(commandTick >= 0, 'SETUP was requested');
  assert.equal(peer.resets.length, 0, 'no reset at command issue');

  peer.tick(delayTicks + 4);
  assert.equal(peer.resets.length, 1, 'exactly one reset when the window opened');
  assert.ok(peer.resets[0]!.tickIndex > commandTick,
    `reset happened on tick ${peer.resets[0]!.tickIndex}, after the command on tick ${commandTick}`);
  assert.equal(peer.progress.at(-1)?.phase, 'SETUP');
});

// ---------------------------------------------------------------------------
// 10-11 — window scoping and the zero-frame case
// ---------------------------------------------------------------------------

test('r17 setup 10: the gate is evaluated over post-confirmation frames only', () => {
  // The carrier is ALREADY broadcasting when the run starts (a leftover session), so the
  // receiver accumulates hundreds of frames before SETUP is even requested.
  const peer = createFakePeer({broadcastingAtStart: true, cameraStartsAfterTicks: 1, maxTicks: 200});
  peer.tick(2);
  const preSetupFrames = peer.receiver.cameraFrames;
  assert.ok(preSetupFrames > 0, 'frames were decoded before the setup window existed');

  peer.runUntilFinal();
  const result = peer.finalResult();
  assert.equal(result?.status, 'COMPLETE', 'the run completed');
  const window = result?.setupGate.evidenceWindow;
  assert.ok(window, 'the gate carries its evidence window');
  assert.ok(window.cameraFrames > 0, 'the window counted its own frames');
  assert.ok(window.cameraFrames < preSetupFrames + window.cameraFrames,
    'the window is a delta, not a cumulative counter');
  assert.ok(window.finishedAtIso >= window.startedAtIso, 'the window bounds are ordered');
  assert.ok(window.durationMs >= 5000, `the window spans the setup hold (${String(window.durationMs)} ms)`);
  // The window starts when the sender was CONFIRMED, not when the commands were issued.
  assert.ok(String(result?.timeline.setupConfirmedAtIso) >= String(result?.timeline.setupRequestedAtIso),
    'confirmation follows the request');
  assert.equal(result?.timeline.setupStartedAtIso, result?.timeline.setupConfirmedAtIso,
    'the measurement window opens at confirmation');
});

test('r17 setup 11: a zero-frame setup window is CAMERA_NOT_READY, not SETUP_NOT_READY', () => {
  // Acquisition is proven live, then the receiver stops producing frames mid-setup: the
  // gate would report "no valid decode yet" — an optics verdict for a camera fault.
  const peer = createFakePeer({cameraStartsAfterTicks: 1, receiverFramesStopAfterTicks: 4, maxTicks: 60});
  peer.runUntilFinal();

  const result = peer.finalResult();
  assert.equal(result?.status, 'CAMERA_NOT_READY', 'named as the acquisition fault it is');
  assert.equal(result?.setupGate.ready, false);
  assert.ok(result?.setupGate.evidenceWindow, 'the empty window is still reported');
  assert.equal(result?.setupGate.evidenceWindow?.cameraFrames, 0);
  assert.match(result?.setupGate.reasons.join(';') ?? '', /no camera frames/,
    'the gate says the window was empty rather than blaming the optics');
  assert.equal(result?.steps.length, 0, 'A1 must not run on an empty setup window');
  assert.equal(peer.frozen.length, 0, 'nothing is frozen');
});

// ---------------------------------------------------------------------------
// 12 — what the phone shows IS what the gate used
// ---------------------------------------------------------------------------

test('r17 ui 12: the phone displays the gate window, not live counters', () => {
  const {page, modals} = loadPhonePage();
  const result = {
    runId: 'run-r17-ui',
    status: 'SETUP_NOT_READY',
    stepsCompleted: 0,
    stepsPlanned: 5,
    validity: {valid: false, checks: [{id: 'sender_hello', ok: true, detail: 'ok'}]},
    timeline: {stopConfirmedAtIso: null},
    setupGate: {
      ready: false,
      label: 'SETUP NOT READY / 取景条件未就绪',
      reasons: ['no valid decode yet'],
      evidenceWindow: {
        startedAtIso: '2026-09-13T10:00:00.000Z',
        finishedAtIso: '2026-09-13T10:00:05.000Z',
        durationMs: 5000,
        cameraFrames: 0, processedFrames: 0, decodeAttempts: 0, successfulDecodes: 0,
        crcFailures: 0, locateFailures: 0, uniqueReceived: 0,
        observedCodeWidthPx: 0, pixelsPerCell: 0, reservedPatternScore: 0,
        contrast: 0, frameRotationIndex: 0,
      },
      evidence: {cameraFrames: 0},
    },
  };
  page.onAutoRunResult(result);

  assert.match(page.data.autoSetupWindowSpan, /2026-09-13T10:00:00\.000Z → 2026-09-13T10:00:05\.000Z \(5000 ms\)/,
    'the window is labelled with its own span');
  assert.match(page.data.autoSetupWindowCounters, /frames=0 .*ok=0/);
  assert.match(page.data.autoSetupWindowOptics, /codePx=0 .*reserved=0/);
  assert.equal(modals.length, 1, 'the PO is told about the failure');
  assert.ok(modals[0].includes('2026-09-13T10:00:00.000Z'), 'the modal names the window');
  assert.ok(modals[0].includes('frames=0'), 'and shows the window counters, not live ones');
  assert.ok(modals[0].includes('no valid decode yet'), 'with the gate reasons verbatim');
  // The live grid keeps its own explicit label so the two windows are never confused.
  assert.match(PAGE_WXML, /LIVE counters \(since last reset\)/);
  assert.match(PAGE_WXML, /SETUP window \(gate evidence\)/);
  assert.match(PAGE_WXML, /autoSetupWindowCounters/);
  assert.match(PAGE_WXML, /autoPrereqCamera/);
});

test('r17 ui 12b: the phone tells an acquisition fault apart from an optics fault', () => {
  const {page, modals} = loadPhonePage();
  page.onAutoRunResult({
    runId: 'run-r17-ui-2',
    status: 'CAMERA_NOT_READY',
    stepsCompleted: 0,
    stepsPlanned: 5,
    validity: {valid: false, checks: []},
    timeline: {},
    setupGate: {ready: false, label: 'SETUP NOT READY / 取景条件未就绪', reasons: ['setup window received no camera frames'], evidenceWindow: null},
  });
  assert.equal(modals.length, 1);
  assert.match(modals[0], /CAMERA NOT READY/);
  assert.match(modals[0], /setup window received no camera frames/);
  assert.match(modals[0], /page mode=/);
});

// ---------------------------------------------------------------------------
// 13 — A1-A5 semantics unchanged
// ---------------------------------------------------------------------------

test('r17 regression 13: the full plan still completes with unchanged A1-A5 semantics', () => {
  const peer = runAutoPlan();
  const result = peer.finalResult();
  assert.equal(result?.status, 'COMPLETE');
  assert.equal(result?.validity.valid, true);
  assert.deepEqual(peer.frozen.map((step) => step.stepId), ['A1', 'A2', 'A3', 'A4', 'A5']);
  assert.equal(peer.progress.at(-1)?.phase, 'DONE');
  assert.equal(result?.networkPayloadPath, 'NONE');

  const a4 = peer.frozen.find((step) => step.stepId === 'A4');
  assert.ok(a4?.beforePause && a4?.duringPause, 'A4 keeps its before/during pause split');
  assert.equal(a4?.sender.paused, true, 'A4 still freezes the carrier');
  const a2 = peer.frozen.find((step) => step.stepId === 'A2');
  assert.equal(a2?.sender.holdMs, 5000, 'A2 still runs at its planned hold time');
  assert.equal(a2?.senderConfirmed, true, 'and is still confirmed by telemetry');
  assert.ok(peer.commands.some((message) => String(message.action) === 'STOP'), 'STOP is still sent');
});

// ---------------------------------------------------------------------------
// 14 — no network payload path
// ---------------------------------------------------------------------------

test('r17 regression 14: the pre-flight adds no network payload path', () => {
  const peer = runAutoPlan();
  assert.equal(peer.finalResult()?.networkPayloadPath, 'NONE');
  // The camera probe is local counters + a host timestamp: no fetch, no HTTP, no blobs.
  assert.ok(!/[^.\w]fetch\s*\(/u.test(ADAPTER_JS), 'the adapter adds no fetch()');
  assert.ok(!/https?:\/\//u.test(ADAPTER_JS), 'the adapter adds no HTTP URL');
  assert.match(ADAPTER_JS, /cameraStatus/u, 'the adapter relays the camera probe');
  // A SETUP command remains a strict control envelope: payload-shaped fields are still
  // refused by the SAME validator the relay and both endpoints use.
  const smuggled = validateTf012AutoControlMessage({
    type: 'command', action: 'SET_MODE', runId: 'r', stepId: 'SETUP', mode: 'static', chunkIndex: 0,
    payloadBase64: 'AAAA',
  });
  assert.equal(smuggled.ok, false, 'a payload-shaped SETUP command is rejected');
});

// ---------------------------------------------------------------------------
// The readiness rule itself, as a pure function
// ---------------------------------------------------------------------------

test('r17 rule: camera readiness counts post-run frames, freshness and pipeline feed', () => {
  const baseline = {framesReceived: 100, baselineFrames: 100};
  const ready = tf012AutoCameraReadiness({
    listening: true, callbackActive: true, framesReceived: 100 + TF012_AUTO_CAMERA_MIN_FRAMES,
    baselineFrames: 100 + TF012_AUTO_CAMERA_MIN_BASELINE_FRAMES, lastFrameAt: 1000,
  }, 1100, baseline);
  assert.equal(ready.ready, true, 'fresh frames in the pipeline are acquisition');

  const stale = tf012AutoCameraReadiness({
    listening: true, callbackActive: true, framesReceived: 200, baselineFrames: 200, lastFrameAt: 0,
  }, TF012_AUTO_CAMERA_FRAME_FRESH_MS + 5, baseline);
  assert.equal(stale.ready, false);
  assert.match(stale.reasons.join(';'), /ms old/, 'a stale newest frame is not live acquisition');

  const history = tf012AutoCameraReadiness({
    listening: true, callbackActive: true, framesReceived: 100, baselineFrames: 100, lastFrameAt: 1050,
  }, 1100, baseline);
  assert.equal(history.ready, false);
  assert.match(history.reasons.join(';'), /since the run started/,
    'frames delivered before the run do not count');
});
