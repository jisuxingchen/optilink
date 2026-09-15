/**
 * TF-012 r21 — MINIMAL RECEIVE MODE.
 *
 * WHY THIS FILE EXISTS
 *
 * The r13–r20 Mini Program became a diagnostic harness. It is the right instrument while
 * the physics is being diagnosed, and it is the wrong DEFAULT: every run paid for a SETUP
 * gate, an A1–A5 plan, a static probe, per-phase scheduler telemetry, camera timing,
 * failure fingerprints, sampling geometry and a rotation histogram — and the physical
 * runs measured a processing duty ratio of ~99.7 %, i.e. the JS thread was busy nearly
 * the whole time.
 *
 * r21 makes the MINIMAL path the default:
 *
 *   open → camera auto-starts → tap ONE button → receive → PASS/FAIL → copy result
 *
 *   CameraFrame → locate → sample → CRC → chunk → dedupe → reconstruct → SHA-256
 *
 * and moves the entire harness behind ADVANCED DIAGNOSTICS (off by default).
 *
 * This file proves the 13 required properties, and it proves the PASS through the REAL
 * pipeline: the SHARED transfer is rendered to camera frames and pushed through the page's
 * own frame callback, so the locator, the decoder, the chunk store, the reconstruction and
 * the SHA-256 are the shipped implementations — nothing is stubbed into agreement.
 *
 *   1  normal mode does not instantiate the auto orchestrator
 *   2  normal mode does not compute fingerprint diagnostics
 *   3  normal mode does not compute the rotation histogram
 *   4  normal mode UI updates are throttled and change-gated
 *   5  the simple receive PASSes immediately on 16/16 + SHA MATCH
 *   6  no unnecessary fixed-duration wait after PASS
 *   7  the timeout FAILs
 *   8  RUN AGAIN resets correctly
 *   9  the static decode check PASSes immediately at N decodes
 *  10  the result JSON is small and contains only allowed fields
 *  11  advanced mode still works when explicitly enabled
 *  12  networkPayloadPath remains NONE
 *  13  no network payload/oracle path is introduced
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {
  SINGLE_BASELINE_MATRIX,
  buildSingleBaselineTransfer,
  renderSingleBaselineFrame,
} from './single-baseline.ts';
import {TF012_AUTO_RECEIVER_ROLE, TF012_AUTO_SENDER_ROLE} from './index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS = join(HERE, '..', '..', '..');
const MINI = join(EXPERIMENTS, 'tf-008-wechat-mini-receiver-poc');
const PAGE_JS_PATH = join(MINI, 'pages', 'index', 'index.js');
const PAGE_JS = readFileSync(PAGE_JS_PATH, 'utf8');
const PAGE_WXML = readFileSync(join(MINI, 'pages', 'index', 'index.wxml'), 'utf8');
const SIMPLE_JS_PATH = join(MINI, 'utils', 'tf012-simple.js');
const SIMPLE_JS = readFileSync(SIMPLE_JS_PATH, 'utf8');
const miniRequire = createRequire(import.meta.url);
const simpleMode = miniRequire(SIMPLE_JS_PATH) as Record<string, any>;

const transfer = buildSingleBaselineTransfer();

/** The 16 camera frames of the 10 KiB baseline transfer, ready for the frame callback. */
function transferFrames(): Array<{width: number; height: number; data: ArrayBuffer}> {
  return transfer.frames.map((cells) => {
    const frame = renderSingleBaselineFrame(Uint8Array.from(cells), SINGLE_BASELINE_MATRIX, {
      width: 720, height: 1280, fill: 0.7,
    });
    return {width: frame.width, height: frame.height, data: frame.data.buffer as ArrayBuffer};
  });
}

/** A frame the locator cannot lock: exercises the pipeline without decoding anything. */
function blankFrame(): {width: number; height: number; data: ArrayBuffer} {
  return {width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).buffer};
}

interface Harness {
  page: Record<string, any>;
  clips: string[];
  toasts: string[];
  socketSent: () => string[];
  deliver: (message: unknown) => void;
  openSocket: () => void;
  feed: (frame?: {width: number; height: number; data: ArrayBuffer}) => void;
  tick: (times?: number) => void;
  advance: (ms: number) => void;
  setDataCount: () => number;
  lastPatchKeys: () => number;
  restore: () => void;
}

/**
 * Load the shipped page with a `wx` stub and a deterministic clock. The page's own
 * `Date.now()` drives run timing, so the harness owns the clock and nothing sleeps.
 */
function harness(): Harness {
  const store = new Map<string, unknown>();
  const clips: string[] = [];
  const toasts: string[] = [];
  const setDataCalls: Array<Record<string, unknown>> = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  const realNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let clock = 1_700_000_000_000;
  let frameCallback: ((frame: unknown) => void) | null = null;
  let socket: Record<string, any> | null = null;

  globals.wx = {
    createCameraContext: () => ({
      onCameraFrame: (callback: (frame: unknown) => void) => {
        frameCallback = callback;
        return {start: (options?: {success?: () => void}) => options?.success?.(), stop: () => undefined};
      },
    }),
    connectSocket: () => {
      const instance: Record<string, any> = {
        sent: [],
        onOpen: (callback: () => void) => { instance.openCb = callback; },
        onMessage: (callback: (event: {data: string}) => void) => { instance.messageCb = callback; },
        onClose: (callback: () => void) => { instance.closeCb = callback; },
        onError: (callback: () => void) => { instance.errorCb = callback; },
        send: (payload: {data: string}) => { instance.sent.push(String(payload.data)); },
        close: () => undefined,
      };
      socket = instance;
      return instance;
    },
    getSystemInfoSync: () => ({
      version: '8.0.0', SDKVersion: '3.0.0', platform: 'android', system: 'Android 13',
      model: 'node-test', brand: 'node', pixelRatio: 3, screenWidth: 1080, screenHeight: 2400,
    }),
    getNetworkType: (options?: {success?: (res: {networkType: string}) => void}) =>
      options?.success?.({networkType: 'wifi'}),
    getSetting: (options?: {success?: (res: unknown) => void}) =>
      options?.success?.({authSetting: {'scope.camera': true}}),
    setStorageSync: (key: string, value: unknown) => store.set(key, value),
    getStorageSync: (key: string) => (store.has(key) ? store.get(key) : ''),
    removeStorageSync: (key: string) => store.delete(key),
    setClipboardData: (options: {data: string; success?: () => void}) => {
      clips.push(String(options.data));
      options.success?.();
    },
    showToast: (options?: {title?: string}) => toasts.push(String(options?.title)),
    showModal: (options?: {title?: string; content?: string; success?: (res: {confirm: boolean}) => void}) => {
      options?.success?.({confirm: true});
    },
    env: {USER_DATA_PATH: '/tmp'},
  };
  // No wx.getPerformance: clockMs() then equals Date.now(), which this harness owns.
  Date.now = () => clock;
  // The page installs its UI tick in onLoad. Intercept it for the WHOLE harness lifetime
  // (restored in restore()) — a real interval would keep the test process alive forever,
  // and the tests drive the tick explicitly so the cadence is deterministic.
  let timerId = 0;
  const intervals = new Set<number>();
  globalThis.setInterval = ((callback: () => void) => {
    void callback;
    timerId += 1;
    intervals.add(timerId);
    return timerId;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { intervals.delete(id); }) as unknown as typeof clearInterval;

  let captured: Record<string, any> | null = null;
  globals.Page = (config: Record<string, any>) => { captured = config; };
  const require2 = createRequire(import.meta.url);
  delete require2.cache[require2.resolve(PAGE_JS_PATH)];
  require2(PAGE_JS_PATH);
  assert.ok(captured, 'Page() was called');

  const config = captured as unknown as Record<string, any>;
  const page: Record<string, any> = Object.assign(Object.create(null), config);
  page.data = JSON.parse(JSON.stringify(config.data));
  page.setData = (patch: Record<string, unknown>) => {
    setDataCalls.push({...patch});
    Object.assign(page.data, patch);
  };

  const load = (): void => {
    page.onLoad();
    page.onReady();
    page.onInitDone({detail: {maxZoom: 5}});
  };
  load();

  return {
    page,
    clips,
    toasts,
    socketSent: () => (socket ? [...socket.sent] : []),
    deliver: (message: unknown) => {
      if (socket && typeof socket.messageCb === 'function') {
        socket.messageCb({data: JSON.stringify(message)});
      }
    },
    openSocket: () => {
      if (socket && typeof socket.openCb === 'function') socket.openCb();
    },
    feed: (frame) => {
      assert.ok(frameCallback, 'the camera frame listener is installed');
      frameCallback(frame ?? blankFrame());
    },
    tick: (times = 1) => {
      for (let index = 0; index < times; index += 1) page.onTick();
    },
    advance: (ms) => { clock += ms; },
    setDataCount: () => setDataCalls.length,
    lastPatchKeys: () => (setDataCalls.length > 0
      ? Object.keys(setDataCalls[setDataCalls.length - 1]!).length
      : 0),
    restore: () => {
      Date.now = realNow;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      if (page.autoRunner && typeof page.autoRunner.dispose === 'function') page.autoRunner.dispose();
      if (page.simpleClient && typeof page.simpleClient.close === 'function') page.simpleClient.close();
      delete (globals as Record<string, unknown>).wx;
      delete (globals as Record<string, unknown>).Page;
    },
  };
}

/** Count every call of one receiver method, without changing what it returns. */
function spyOn(object: Record<string, any>, method: string, counts: Record<string, number>): void {
  const original = object[method];
  assert.equal(typeof original, 'function', `${method} exists on the receiver`);
  object[method] = (...args: unknown[]) => {
    counts[method] = (counts[method] ?? 0) + 1;
    return original.apply(object, args);
  };
}

// ---------------------------------------------------------------------------
// 1 — the default path never builds the diagnostic harness
// ---------------------------------------------------------------------------

test('r21 default 1: normal mode does not instantiate the auto orchestrator', () => {
  const h = harness();
  try {
    assert.equal(h.page.data.showAdvanced, false, 'advanced diagnostics is OFF by default');
    assert.ok(!h.page.autoRunner, 'onLoad built no auto runner');
    // The camera really is running (auto-start), which is what makes the default one-tap.
    assert.equal(h.page.data.running, true, 'the camera auto-started');
    assert.equal(h.page.frameListener != null, true, 'and the frame listener is live');

    h.page.onSimpleStart();
    assert.ok(!h.page.autoRunner, 'a minimal run builds no auto runner');
    // A control channel is allowed (presence + telemetry only) — an orchestrator is not.
    h.openSocket();
    h.deliver({type: 'peer', event: 'hello', role: TF012_AUTO_SENDER_ROLE});
    h.deliver({type: 'command', action: 'TELEMETRY', runId: null, mode: 'cyclic', cursor: 3, broadcasting: true});
    assert.ok(!h.page.autoRunner, 'a full handshake still builds no orchestrator');
    assert.equal(h.page.data.simpleSenderLabel, 'CONNECTED / 已连接', 'the peer notice reaches the UI');

    // And the source proves it: the simple path has no runner/orchestrator/socket I/O.
    const region = PAGE_JS.slice(
      PAGE_JS.indexOf('  simpleCounters() {'), PAGE_JS.indexOf('  autoStepReceiverSample() {'));
    assert.ok(region.length > 1000, 'the simple block is present');
    for (const forbidden of ['createAutoTestRunner', 'createTf012AutoOrchestrator', 'startProbe', 'autoRunner']) {
      assert.ok(!region.includes(forbidden), `the simple path must not reference ${forbidden}`);
    }
    // The default UI shows no harness field at all.
    const view = PAGE_WXML.slice(PAGE_WXML.indexOf('class="simple"'), PAGE_WXML.indexOf('BACK TO SIMPLE RECEIVE'));
    assert.ok(view.length > 200, 'the minimal view is present');
    for (const forbidden of ['A1', 'SETUP', 'phaseTiming', 'autoSetupWindowCounters', 'G7', 'holdMsDeclared']) {
      assert.ok(!view.includes(forbidden), `the minimal view must not show ${forbidden}`);
    }
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 2-3 — no diagnostics are computed on the default path
// ---------------------------------------------------------------------------

test('r21 default 2: normal mode does not compute fingerprint diagnostics', () => {
  const h = harness();
  try {
    h.page.onSimpleStart();
    const counts: Record<string, number> = {};
    const receiver = h.page.baselineReceiver;
    for (const method of ['crcFailureDiagnostics', 'geometryDiagnostics', 'decodedChunkCounts', 'receivedIndices']) {
      spyOn(receiver, method, counts);
    }
    h.page.onSimpleStart();
    // Reset creates a NEW receiver: spy on the one the run actually uses.
    const runReceiver = h.page.baselineReceiver;
    if (runReceiver !== receiver) {
      for (const method of ['crcFailureDiagnostics', 'geometryDiagnostics', 'decodedChunkCounts', 'receivedIndices']) {
        spyOn(runReceiver, method, counts);
      }
    }
    for (let index = 0; index < 40; index += 1) h.feed();
    h.tick(5);
    h.page.simpleResultPayload();
    assert.deepEqual(counts, {}, 'the default path never asks for diagnostic evidence');
    const diag = h.page.baselineReceiver.crcFailureDiagnostics();
    const geometry = h.page.baselineReceiver.geometryDiagnostics();
    assert.equal(diag.failedFrames, 0, 'failure fingerprints were not accumulated internally');
    assert.equal(diag.analysedFrames, 0, 'no raw failure ring was retained');
    assert.equal(geometry.failure, null, 'no diagnostic failure geometry was retained');
    assert.equal(geometry.success, null, 'no diagnostic success geometry was retained');
    // It still counted frames and decode attempts — the cheap counters the minimal UI shows.
    assert.ok(h.page.data.simpleDecode.includes('OK'), 'the cheap counters still reach the UI');
  } finally {
    h.restore();
  }
});

test('r21 default 3: normal mode does not compute the rotation histogram', () => {
  const h = harness();
  try {
    h.page.onSimpleStart();
    const counts: Record<string, number> = {};
    spyOn(h.page.baselineReceiver, 'rotationDiagnostics', counts);
    for (let index = 0; index < 20; index += 1) h.feed();
    h.tick(3);
    const payload = h.page.simpleResultPayload();
    assert.deepEqual(counts, {}, 'rotationDiagnostics is never called by the default path');
    const rotationDiag = h.page.baselineReceiver.rotationDiagnostics();
    assert.equal(rotationDiag.framesCounted, 0, 'rotation histogram is not accumulated internally');
    assert.equal(rotationDiag.unlocatedFrames, 0, 'unlocated-frame histogram is also disabled');
    const serialised = JSON.stringify(payload);
    for (const forbidden of ['rotations', 'dominantRotation', 'transitions', 'fingerprint', 'stableBit', 'phaseTiming']) {
      assert.ok(!serialised.includes(forbidden), `the small result carries no ${forbidden}`);
    }
    // The rotation INDEX is a cheap receiver metric and stays available as one number.
    assert.ok('rotation' in payload, 'the single rotation index is still reported');
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 4 — throttled, change-gated UI
// ---------------------------------------------------------------------------

test('r21 default 4: normal mode UI updates are throttled and change-gated', (t) => {
  const h = harness();
  try {
    h.page.onSimpleStart();
    h.feed();  // the first frame flips `callbackActive` once, by design
    const afterFirstFrame = h.setDataCount();
    for (let index = 0; index < 40; index += 1) h.feed();
    assert.equal(h.setDataCount(), afterFirstFrame, 'no setData per camera frame');
    const updatesAfterFrames = h.page.data.simpleUiUpdates;

    h.page.onTick();
    assert.ok(h.setDataCount() - afterFirstFrame <= 1, 'a tick publishes at most ONE patch');
    h.page.onTick();
    const afterTwoTicks = h.setDataCount();
    h.page.onTick();  // identical clock and identical counters
    assert.equal(h.setDataCount(), afterTwoTicks,
      'a tick whose values did not change costs no setData at all');
    assert.ok(h.page.data.simpleUiUpdates >= updatesAfterFrames, 'updates are counted, not silent');

    // The cadence itself: the page must refresh at or below 4 Hz.
    const period = Number(/const UI_REFRESH_MS = (\d+)/u.exec(PAGE_JS)?.[1]);
    assert.ok(Number.isFinite(period), 'the UI period is a declared constant');
    assert.ok(period >= 1000 / simpleMode.SIMPLE_MAX_UI_HZ,
      `UI_REFRESH_MS ${period} ms must stay at or below ${simpleMode.SIMPLE_MAX_UI_HZ} Hz`);

    // MEASURED BEFOR/AFTER (local UI payload only — never a physical throughput claim):
    // the normal-mode patch is a handful of fields, while the r13–r20 advanced baseline
    // panel publishes the full evidence set every tick. Both are measured on the same page.
    h.page.onSimpleStart();
    h.page.onTick();
    const normalPatchKeys = h.lastPatchKeys();
    h.page.onSimpleToggleAdvanced();
    h.page.setMode('baseline');
    h.page.onTick();
    const advancedPatchKeys = h.lastPatchKeys();
    assert.ok(normalPatchKeys > 0 && normalPatchKeys <= 16,
      `the minimal patch stays small (${normalPatchKeys} fields)`);
    assert.ok(advancedPatchKeys > normalPatchKeys,
      `the advanced panel is larger (${advancedPatchKeys} vs ${normalPatchKeys} fields)`);
    t.diagnostic('r21 measured: normal-mode UI patch ' + normalPatchKeys
      + ' fields vs advanced baseline patch ' + advancedPatchKeys + ' fields,'
      + ' at ' + period + ' ms (<= ' + simpleMode.SIMPLE_MAX_UI_HZ + ' Hz), '
      + '0 diagnostic receiver calls per frame');
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 5-6 — event-driven completion
// ---------------------------------------------------------------------------

test('r21 receive 5: the minimal receive PASSes on 16/16 + SHA MATCH through the real pipeline', () => {
  const h = harness();
  try {
    h.page.onSimpleStart();
    assert.equal(h.page.data.simpleStatus, 'RECEIVING');
    h.advance(3000);
    for (const frame of transferFrames()) h.feed(frame);

    assert.equal(h.page.data.simpleResult, 'PASS', 'the run PASSed through the real decoder');
    assert.equal(h.page.simple.reason, 'sha-match');
    assert.equal(h.page.data.simpleResultClass, 'ok');
    assert.equal(h.page.data.simpleProgress, '16 / 16');
    assert.equal(h.page.data.simplePassSha, 'SHA-256 MATCH');
    assert.equal(h.page.data.simplePassBytes, '10240 B');

    const payload = h.page.simpleResultPayload();
    assert.equal(payload.status, 'PASS');
    assert.equal(payload.uniqueReceived, 16);
    assert.equal(payload.totalChunks, 16);
    assert.equal(payload.assembledBytes, 10240);
    assert.equal(payload.fileLength, 10240);
    assert.equal(payload.shaResult, 'MATCH');
    assert.equal(payload.sha256, payload.manifestSha256, 'the two local digests agree');
    assert.equal(payload.successfulDecodes, 16, 'every frame the locator locked decoded');
    assert.equal(payload.crcFailures, 0);
    assert.equal(payload.locateFailures, 0);

    // The frozen gate must not be redefined by self-consistent optical metadata.
    // A 1-chunk/640 B transfer with its own matching digest is NOT this baseline.
    const wrongChunks = simpleMode.simpleRun('receive', 0);
    const wrongChunkVerdict = simpleMode.simpleDecision(wrongChunks, {
      uniqueReceived: 1, totalChunks: 1, assembledBytes: 640, fileLength: 640, shaResult: 'MATCH',
    }, 100);
    assert.equal(wrongChunkVerdict.status, 'FAIL');
    assert.equal(wrongChunkVerdict.reason, 'baseline-total-chunks');

    // Nor may metadata keep 16 chunks but redefine the file size.
    const wrongBytes = simpleMode.simpleRun('receive', 0);
    const wrongByteVerdict = simpleMode.simpleDecision(wrongBytes, {
      uniqueReceived: 16, totalChunks: 16, assembledBytes: 9600, fileLength: 9600, shaResult: 'MATCH',
    }, 100);
    assert.equal(wrongByteVerdict.status, 'FAIL');
    assert.equal(wrongByteVerdict.reason, 'baseline-file-bytes');

    // "If PASS occurs in 3 s: finish in 3 s" — the elapsed time is the REAL run length.
    assert.ok(payload.elapsedMs >= 3000 && payload.elapsedMs < 4000,
      `elapsed ${payload.elapsedMs} ms must be the real time, not a plan`);
  } finally {
    h.restore();
  }
});

test('r21 receive 6: no unnecessary fixed-duration wait after PASS', () => {
  const h = harness();
  try {
    h.page.onSimpleStart();
    h.advance(1500);
    for (const frame of transferFrames()) h.feed(frame);
    assert.equal(h.page.data.simpleResult, 'PASS');
    const verdictAt = h.page.simple.finishedAt;
    const processedAtVerdict = h.page.baselineFramesProcessed;

    // 25 s later (well past the run, still inside the 30 s bound) nothing may change.
    h.advance(25000);
    h.tick(3);
    assert.equal(h.page.simple.finishedAt, verdictAt, 'the verdict instant never moves');
    assert.equal(h.page.data.simpleResult, 'PASS', 'and the verdict is not re-decided');
    assert.equal(h.page.simpleResultPayload().elapsedMs, 1500,
      'the frozen elapsed time is the PASS instant, not the tick at +26.5 s');

    // Frames after the verdict are dropped: the phone stops paying for decoding.
    const dropped = h.page.simpleAfterFinishFrames;
    h.feed(transferFrames()[0]);
    h.feed(transferFrames()[1]);
    assert.equal(h.page.simpleAfterFinishFrames, dropped + 2, 'post-verdict frames are dropped');
    assert.equal(h.page.baselineFramesProcessed, processedAtVerdict, 'and never ingested');

    // The decision function itself refuses to decide twice.
    const again = simpleMode.simpleDecision(
      {kind: 'receive', startedAt: 0, finished: true, finishedAt: verdictAt, timeoutMs: 30000, totalChunks: 16, fileBytes: 10240},
      {uniqueReceived: 1, totalChunks: 16}, 60000);
    assert.equal(again, null, 'a finished run can never produce a second verdict');
  } finally {
    h.restore();
  }
});

test('r21 receive 7: the run FAILs at its bound when it never completes', () => {
  const h = harness();
  try {
    h.page.onSimpleStart();
    h.feed();
    // Just inside the bound: still running, and NOT failed early.
    h.advance(simpleMode.SIMPLE_RECEIVE_TIMEOUT_MS - 1);
    h.tick();
    assert.equal(h.page.data.simpleResult, 'RECEIVING', 'no premature verdict');
    // At the bound the run FAILs — a camera that stopped delivering still ends the run.
    h.advance(1);
    h.tick();
    assert.equal(h.page.data.simpleResult, 'FAIL');
    assert.equal(h.page.data.simpleResultClass, 'bad');
    assert.equal(h.page.simple.reason, 'receive-timeout');
    assert.match(h.page.data.simpleDetail, /timeout/i);
    assert.ok(h.page.data.simpleDetail.includes('30 s'), 'the detail names the bound');
    assert.equal(h.page.simpleResultPayload().status, 'FAIL');

    // And the decision unit: null before the bound, FAIL at it, exactly once.
    const run = simpleMode.simpleRun('receive', 0);
    assert.equal(simpleMode.simpleDecision(run, {uniqueReceived: 3, totalChunks: 16}, 29999), null);
    const verdict = simpleMode.simpleDecision(run, {uniqueReceived: 3, totalChunks: 16}, 30000);
    assert.equal(verdict.status, 'FAIL');
    assert.equal(verdict.reason, 'receive-timeout');
    assert.equal(verdict.elapsedMs, 30000);
  } finally {
    h.restore();
  }
});

test('r21 receive 8: RUN AGAIN resets the run, the receiver and the verdict', () => {
  const h = harness();
  try {
    h.page.onSimpleStart();
    const first = h.page.simple;
    for (const frame of transferFrames()) h.feed(frame);
    assert.equal(h.page.data.simpleResult, 'PASS');
    assert.ok(h.page.simpleAfterFinishFrames >= 0);

    h.advance(1000);
    h.page.onSimpleAgain();
    assert.notEqual(h.page.simple, first, 'a new run object');
    assert.equal(h.page.simple.startedAt, first.startedAt + 1000, 'it starts at the new instant');
    assert.equal(h.page.data.simpleStatus, 'RECEIVING');
    assert.equal(h.page.data.simpleResult, 'RECEIVING');
    assert.equal(h.page.data.simpleResultClass, 'pending');
    assert.equal(h.page.data.simpleProgress, '0 / 16', 'progress is reset');
    assert.equal(h.page.data.simplePassBytes, '—');
    assert.equal(h.page.data.simplePassSha, '—');
    assert.equal(h.page.simpleAfterFinishFrames, 0, 'the drop counter is reset');
    assert.equal(h.page.baselineReceiver.receivedUniqueCount, 0, 'the chunk store is empty again');
    assert.equal(h.page.baselineResult, null, 'the previous reconstruction is gone');

    // It really receives again, from scratch.
    h.advance(2000);
    for (const frame of transferFrames()) h.feed(frame);
    assert.equal(h.page.data.simpleResult, 'PASS', 'the second run PASSes too');
    assert.equal(h.page.simpleResultPayload().elapsedMs, 2000, 'with its OWN elapsed time');
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 9 — the small static alignment check
// ---------------------------------------------------------------------------

test('r21 static 9: the static decode check PASSes immediately at N decodes', () => {
  const h = harness();
  try {
    h.page.onSimpleStaticCheck();
    assert.equal(h.page.simpleKind, 'static', 'a static check is its own run kind');
    assert.equal(h.page.data.simpleStatus, 'RECEIVING');

    // Not enough decodes yet, and the bound has not passed: no verdict.
    h.page.baselineReceiver.metrics.decodeSuccess = simpleMode.SIMPLE_STATIC_MIN_DECODES - 1;
    h.advance(1200);
    h.tick();
    assert.equal(h.page.data.simpleResult, 'RECEIVING', 'nine decodes is not a PASS');

    // The tenth decode PASSes at once — 1.2 s, not the 5 s bound.
    h.page.baselineReceiver.metrics.decodeSuccess = simpleMode.SIMPLE_STATIC_MIN_DECODES;
    h.advance(1);
    h.tick();
    assert.equal(h.page.data.simpleResult, 'PASS');
    assert.equal(h.page.simple.reason, 'static-decodes');
    assert.match(h.page.data.simpleDetail, /static alignment OK/);
    const payload = h.page.simpleResultPayload();
    assert.equal(payload.elapsedMs, 1201, 'the static check ends on the decode, not on the timer');
    assert.ok(payload.elapsedMs < simpleMode.SIMPLE_STATIC_TIMEOUT_MS);

    // The decision unit: PASS at the threshold, FAIL at the 5 s bound.
    const run = simpleMode.simpleRun('static', 0);
    assert.equal(simpleMode.simpleDecision(run, {successfulDecodes: 9}, 4999), null);
    assert.equal(simpleMode.simpleDecision(run, {successfulDecodes: 10}, 100).reason, 'static-decodes');
    assert.equal(simpleMode.simpleDecision(run, {successfulDecodes: 2}, 5000).reason, 'static-timeout');

    // A static check does not require 16/16 and does not touch the transfer.
    const fresh = harness();
    try {
      fresh.page.onSimpleStaticCheck();
      fresh.page.baselineReceiver.metrics.decodeSuccess = 10;
      fresh.tick();
      assert.equal(fresh.page.data.simpleResult, 'PASS');
      assert.equal(fresh.page.baselineReceiver.receivedUniqueCount, 0, 'no chunks were needed');
    } finally {
      fresh.restore();
    }
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// 10-13 — the small result, advanced mode, and the network policy
// ---------------------------------------------------------------------------

test('r21 result 10: the result JSON is small and contains only allowed fields', () => {
  const h = harness();
  try {
    h.page.onSimpleStart();
    for (const frame of transferFrames()) h.feed(frame);
    const payload = h.page.simpleResultPayload();
    const allowed = [
      'buildId', 'mode', 'status', 'reason', 'startedAtIso', 'finishedAtIso', 'elapsedMs',
      'cameraFrames', 'decodeAttempts', 'successfulDecodes', 'crcFailures', 'locateFailures',
      'uniqueReceived', 'totalChunks', 'assembledBytes', 'fileLength',
      'receivedChunkIndexes', 'missingChunkIndexes', 'decodedChunkCounts',
      'metadataRejects', 'foreignChunkRejects', 'duplicateChunks',
      'sha256', 'manifestSha256', 'shaResult',
      'observedCodeWidthPx', 'pixelsPerCell', 'contrast', 'rotation',
      'networkPayloadPath',
    ];
    assert.deepEqual(Object.keys(payload).sort(), allowed.slice().sort(), 'exactly the allowed fields');
    for (const [key, value] of Object.entries(payload)) {
      assert.ok(value === null || typeof value !== 'object', `${key} is a scalar (no diagnostic tree)`);
    }
    const text = JSON.stringify(payload);
    assert.ok(text.length < 1800, `the result stays small (${text.length} chars)`);
    assert.equal(payload.mode, 'simple-receive');
    assert.equal(payload.receivedChunkIndexes, '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15');
    assert.equal(payload.missingChunkIndexes, '');
    assert.match(String(payload.decodedChunkCounts), /(?:^|,)0:\\d+(?:,|$)/u);
    assert.equal(payload.metadataRejects, 0);
    assert.equal(payload.foreignChunkRejects, 0);
    assert.equal(payload.buildId, h.page.data.buildId);
    // Field names must not look like a payload/oracle channel to the lab's guards.
    const guards = ['payload', 'filebytes', 'filecontent', 'filedata', 'chunkbytes',
      'framebytes', 'imagedata', 'bitmap', 'reconstructed', 'oracle', 'expected'];
    for (const key of Object.keys(payload)) {
      if (key.toLowerCase() === 'networkpayloadpath') continue;
      for (const fragment of guards) {
        assert.ok(!key.toLowerCase().includes(fragment), `${key} must not contain ${fragment}`);
      }
    }
    // COPY RESULT copies exactly this small artefact (never the r13–r20 mega-JSON).
    h.page.onSimpleCopy();
    assert.equal(h.clips.length, 1, 'COPY RESULT filled the clipboard');
    const copied = JSON.parse(h.clips[0]);
    assert.deepEqual(Object.keys(copied).sort(), allowed.slice().sort());
    assert.equal(copied.status, 'PASS');
  } finally {
    h.restore();
  }
});

test('r21 advanced 11: advanced diagnostics still work when explicitly enabled', () => {
  const h = harness();
  try {
    assert.equal(h.page.data.showAdvanced, false);
    h.page.onSimpleToggleAdvanced();
    assert.equal(h.page.data.showAdvanced, true, 'the toggle turns the harness on');
    assert.equal(h.page.data.showDiagnostics, true, 'and reveals the evidence panels');
    assert.equal(typeof h.page.baselineReceiver.setDiagnosticsEnabled, 'function',
      'the shipped receiver exposes the diagnostics gate');

    // With advanced on, the full periodic panel runs again (r13–r20 unchanged) — and it
    // dispatches by MODE, exactly as before.
    let baselineTicks = 0;
    let receiveTicks = 0;
    const originalBaseline = h.page.onBaselineTick;
    const originalReceive = h.page.onReceiveTick;
    h.page.onBaselineTick = () => { baselineTicks += 1; return originalBaseline.call(h.page); };
    h.page.onReceiveTick = () => { receiveTicks += 1; return originalReceive.call(h.page); };
    assert.equal(h.page.data.mode, 'receive', 'the page is still in its default mode');
    h.page.onTick();
    assert.equal(receiveTicks, 1, 'the advanced tick runs for the active mode');
    assert.equal(baselineTicks, 0, 'and only for the active mode');
    h.page.setMode('baseline');
    h.page.onTick();
    assert.equal(baselineTicks, 1, 'the baseline panel runs in baseline mode');

    // ...and in NORMAL mode neither of them runs at all.
    h.page.onSimpleToggleAdvanced();
    assert.equal(h.page.data.showAdvanced, false);
    const advancedTicks = baselineTicks + receiveTicks;
    h.page.onTick();
    h.page.onTick();
    assert.equal(baselineTicks + receiveTicks, advancedTicks,
      'no advanced panel runs while advanced diagnostics is off');
    h.page.onBaselineTick = originalBaseline;
    h.page.onReceiveTick = originalReceive;

    // The harness entry points switch it on by themselves.
    const fresh = harness();
    try {
      fresh.page.data.autoControlUrl = 'ws://127.0.0.1:5173/lab';
      fresh.page.onAutoTest();
      assert.equal(fresh.page.data.showAdvanced, true, 'the A1..A5 sweep turns advanced on');
      assert.equal(fresh.page.data.showDiagnostics, true);
      assert.ok(fresh.page.autoRunner, 'and the r13..r20 harness still runs');
      assert.equal(fresh.page.autoRunner.isRunning(), true);
      // The r21 additions did not touch the diagnostic path's own gating.
      assert.equal(fresh.page.data.mode, 'baseline');
    } finally {
      fresh.restore();
    }
  } finally {
    h.restore();
  }
});

test('r21 network 12: networkPayloadPath remains NONE and nothing but control is sent', () => {
  const h = harness();
  try {
    assert.equal(h.page.data.networkPath, 'NONE');
    h.openSocket();
    h.page.onSimpleStart();
    for (const frame of transferFrames()) h.feed(frame);
    assert.equal(h.page.data.simpleResult, 'PASS');
    h.page.onSimpleCopy();

    const sent = h.socketSent();
    assert.equal(sent.length, 1, 'the minimal path sends ONLY the handshake');
    const hello = JSON.parse(sent[0]);
    assert.equal(hello.type, 'hello', 'and it is the declared message class');
    assert.equal(hello.role, TF012_AUTO_RECEIVER_ROLE, 'from the shared role constant');
    // Nothing about the transfer travels: not the digest, not a chunk, not a frame.
    const wire = sent.join('\n');
    for (const forbidden of ['sha256', '1e21881b', 'chunk', 'payload', 'base64', 'manifest']) {
      assert.ok(!wire.includes(forbidden), `the control channel must not carry ${forbidden}`);
    }
    assert.equal(h.page.simpleResultPayload().networkPayloadPath, 'NONE', 'the result declares the path');
    assert.ok(PAGE_JS.includes("networkPayloadPath: 'NONE'"), 'and the page still states it');
  } finally {
    h.restore();
  }
});

test('r21 network 13: no network payload or oracle path is introduced', () => {
  // The minimal decision module is pure: no platform, no network, no adapter.
  for (const forbidden of ['wx.', 'connectSocket', 'fetch', 'XMLHttpRequest', 'require(', 'Buffer', 'process.']) {
    assert.ok(!SIMPLE_JS.includes(forbidden), `utils/tf012-simple.js must not contain ${forbidden}`);
  }
  // The minimal page region sends nothing and never reads HEAVY receiver diagnostics.
  // Cheap chunk-identity summaries are allowed only in simpleResultPayload(), after the run.
  const region = PAGE_JS.slice(
    PAGE_JS.indexOf('  simpleCounters() {'), PAGE_JS.indexOf('  autoStepReceiverSample() {'));
  for (const forbidden of [
    'publishResult', 'connectSocket', 'wx.request', 'wx.uploadFile', 'wx.downloadFile',
    'crcFailureDiagnostics', 'geometryDiagnostics', 'rotationDiagnostics',
  ]) {
    assert.ok(!region.includes(forbidden), `the simple path must not use ${forbidden}`);
  }
  const hotRegion = PAGE_JS.slice(
    PAGE_JS.indexOf('  simpleCounters() {'), PAGE_JS.indexOf('  simpleResultPayload() {'));
  for (const terminalOnly of ['receivedIndices', 'missingIndices', 'decodedChunkCounts']) {
    assert.ok(!hotRegion.includes(terminalOnly),
      `${terminalOnly} must not run in the per-frame/tick hot path`);
  }
  // The result carries LOCAL digests + compact LOCAL chunk identity summaries only.
  const allowedValueSources = ['sha256Hex', 'expectedSha256'];
  const source = PAGE_JS.slice(
    PAGE_JS.indexOf('  simpleResultPayload() {'), PAGE_JS.indexOf('  onSimpleCopy() {'));
  for (const terminalOnly of ['receivedIndices', 'missingIndices', 'decodedChunkCounts']) {
    assert.ok(source.includes(terminalOnly), `terminal result includes ${terminalOnly}`);
  }
  for (const token of allowedValueSources) {
    assert.ok(source.includes(token), `the result takes its digests from ${token}`);
  }
  assert.ok(!/bytes\s*:|frames\s*:|payload\s*:/u.test(source), 'no frame/payload object is put in the result');
  assert.ok(SIMPLE_JS.includes("networkPayloadPath: 'NONE'"), 'the module declares the payload path');
});
