/**
 * TF-012 r9 — Mini Program holdMs declaration control.
 *
 * WHY THIS FILE EXISTS
 *
 * The Stage B sweep needs the PO to declare, on the phone, the SAME hold time the
 * PC sender is using. The r8 control existed but was below the fold and the PO
 * reported "手机没看到切换 ms 的选项" — so r9 moves it onto the FIRST SCREEN above
 * the viewfinder, adds one-tap Stage B chips, and states the consistency rule in
 * the UI.
 *
 * WHAT IT MUST NOT DO
 *
 * The declared hold time is ANNOTATION + THEORETICAL METRICS ONLY. It must never
 * reach the decode path, the frame pipeline, the protocol, the reconstruction or
 * the SHA check, and it must never be synchronised over the network (the payload
 * path stays NONE, with no hidden oracle or control dependency). The tests below
 * pin both halves: the control works, and changing it changes NOTHING in the
 * receive pipeline.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
// src/optical-core -> experiments/tf-002-single-code -> experiments
const EXPERIMENTS = join(HERE, '..', '..', '..');
const MINI = join(EXPERIMENTS, 'tf-008-wechat-mini-receiver-poc');
const SPIKE = join(EXPERIMENTS, 'tf-002-single-code');
const PAGE_JS_PATH = join(MINI, 'pages', 'index', 'index.js');
const PAGE_JS = readFileSync(PAGE_JS_PATH, 'utf8');
const PAGE_WXML = readFileSync(join(MINI, 'pages', 'index', 'index.wxml'), 'utf8');
const SENDER_MAIN = readFileSync(join(SPIKE, 'src', 'single-baseline-sender-main.ts'), 'utf8');
const SENDER_HTML = readFileSync(join(SPIKE, 'single-baseline.html'), 'utf8');

const opticalCore = createRequire(import.meta.url)(join(MINI, 'utils', 'optical-core.js')) as Record<string, any>;
const core = createRequire(import.meta.url)(join(SPIKE, 'src', 'optical-core', 'single-baseline.ts')) as Record<string, any>;

/** Stage B operating window plus the single 750 ms outlier check. */
const STAGE_B_AND_OUTLIER = [100, 90, 75, 60, 50, 40, 750];

function harness(): Record<string, any> {
  const wxStub: Record<string, any> = {
    setStorageSync: () => {},
    getStorageSync: () => '',
    removeStorageSync: () => {},
    setClipboardData: () => {},
    showToast: () => {},
    showModal: () => {},
    env: {USER_DATA_PATH: '/tmp'}
  };
  (globalThis as unknown as Record<string, unknown>).wx = wxStub;

  let captured: Record<string, any> | null = null;
  (globalThis as unknown as Record<string, unknown>).Page = (config: Record<string, any>) => { captured = config; };
  const require2 = createRequire(import.meta.url);
  delete require2.cache[require2.resolve(PAGE_JS_PATH)];
  require2(PAGE_JS_PATH);
  assert.ok(captured, 'Page() was called');

  const config = captured as unknown as Record<string, any>;
  const ctx: Record<string, any> = Object.assign(Object.create(null), config);
  ctx.data = JSON.parse(JSON.stringify(config.data));
  ctx.data.mode = 'baseline';
  ctx.setData = (patch: Record<string, unknown>) => { Object.assign(ctx.data, patch); };
  ctx.appendLog = () => {};
  ctx.recordError = () => {};
  ctx.clearFrameTimeout = () => {};
  ctx.stopCamera = () => {};
  ctx.processedFrames = 0;
  ctx.windowProcessed = 0;
  ctx.baselineTimes = [];
  ctx.baselinePostCompleteFrames = 0;
  ctx.baselineFramesReceived = 0;
  ctx.baselineFramesProcessed = 0;
  ctx.baselineStartAt = Date.now();
  ctx.baselineReceiver = new opticalCore.SingleCodeBaselineReceiver();
  // begin() with a real wall-clock origin, exactly like the shipped onLoad would,
  // so the measured completion window is a sane duration.
  ctx.baselineReceiver.begin(Date.now());
  // onLoad() does these three things; reproduce them so the page behaves as shipped.
  ctx.loadHistory();
  ctx.applyHoldMs(1000);
  ctx.refreshKeyStatus();
  return ctx;
}

const chip = (holdMs: number): Record<string, unknown> => ({currentTarget: {dataset: {hms: String(holdMs)}}});

// ---------------------------------------------------------------------------
// 1. The control is on the first screen, above the viewfinder
// ---------------------------------------------------------------------------

test('all Stage B values and the 750 ms outlier have one-tap chips', () => {
  for (const holdMs of STAGE_B_AND_OUTLIER) {
    assert.ok(
      PAGE_WXML.includes(`data-hms="${holdMs}"`),
      'the phone must offer a ' + holdMs + ' ms chip',
    );
  }
  assert.ok(PAGE_WXML.includes('bindtap="onHoldMsChip"'), 'the chips are tappable');
  assert.ok(PAGE_JS.includes('onHoldMsChip'), 'the tap handler exists on the page');
});

test('the holdMs control sits above the camera and outside the collapsed diagnostics', () => {
  const holdBar = PAGE_WXML.indexOf('Sender holdMs declaration');
  const camera = PAGE_WXML.indexOf('<camera');
  const diagnostics = PAGE_WXML.indexOf('wx:if="{{showDiagnostics}}"');
  assert.ok(holdBar > 0, 'the declaration bar is rendered');
  assert.ok(camera > 0, 'the viewfinder exists');
  assert.ok(diagnostics > 0, 'the diagnostics block exists');
  // First screen: the control must come BEFORE the viewfinder and must not be
  // inside the block that is hidden by default.
  assert.ok(holdBar < camera, 'the holdMs bar is above the viewfinder');
  assert.ok(holdBar < diagnostics, 'the holdMs bar is not inside the collapsed diagnostics');
});

test('the phone states the PC/phone consistency rule without any network sync', () => {
  assert.ok(PAGE_WXML.includes('Must match sender'), 'the rule is shown in English');
  assert.ok(PAGE_WXML.includes('必须与电脑发送端一致'), 'the rule is shown in Chinese');
  // No hidden oracle: the phone never reads the sender over the network.
  for (const pattern of ['wx.request', 'wx.connectSocket', 'new WebSocket', 'XMLHttpRequest', 'fetch(']) {
    assert.ok(!PAGE_JS.includes(pattern), 'no network path may be added: ' + pattern);
  }
  assert.ok(PAGE_JS.includes("networkPayloadPath: 'NONE'"), 'the payload path is still declared NONE');
});

// ---------------------------------------------------------------------------
// 2. The declaration works and propagates
// ---------------------------------------------------------------------------

test('a Stage B chip sets the declared holdMs in the panel, the key status and the rates', () => {
  const ctx = harness();
  assert.equal(ctx.data.holdMsDeclared, 1000, 'default declaration');

  for (const [index, holdMs] of STAGE_B_AND_OUTLIER.entries()) {
    ctx.onHoldMsChip(chip(holdMs));
    assert.equal(ctx.data.holdMsDeclared, holdMs, 'chip ' + holdMs + ' ms is declared');
    assert.equal(ctx.data.keyHoldMs, holdMs + ' ms (declared)', 'KEY STATUS shows the same value');
    assert.equal(ctx.data.holdMsInput, String(holdMs), 'the custom box mirrors it');

    const benchmark = opticalCore.singleBaselineBenchmark(holdMs);
    assert.equal(ctx.data.theoChunkRate, benchmark.theoreticalChunksPerSecond + ' chunk/s');
    assert.equal(
      ctx.data.theoPayloadRate,
      benchmark.theoreticalPayloadBytesPerSecond + ' B/s · ' + benchmark.theoreticalPayloadKiBPerSecond + ' KiB/s',
    );
    assert.ok(index >= 0, 'iterated in order');
  }
});

test('the declared holdMs reaches the frozen JSON as benchmark.holdMs with its source', () => {
  const ctx = harness();
  ctx.onHoldMsChip(chip(75));

  const payload = ctx.buildResultPayload();
  assert.equal(payload.benchmark.holdMs, 75);
  assert.match(String(payload.benchmark.holdMsSource), /declared/u, 'the source is declared, never measured');
  assert.equal(payload.benchmark.theoreticalChunksPerSecond, 13.333);
  assert.equal(payload.benchmark.theoreticalPayloadBytesPerSecond, 8533.3);

  // The declaration is annotation: it must not invent a PASS or a goodput number.
  assert.equal(payload.pass, false, 'an untouched receiver cannot PASS');
  assert.equal(payload.exploratoryNetGoodputBytesPerSecond, null);
});

test('a declared value outside the ladder is clamped, not accepted blindly', () => {
  const ctx = harness();
  ctx.applyHoldMs('5');
  assert.equal(ctx.data.holdMsDeclared, 33, 'clamped up to the fastest supported hold');
  ctx.applyHoldMs('999999');
  assert.equal(ctx.data.holdMsDeclared, 60000, 'clamped down to the slowest supported hold');
  ctx.applyHoldMs('nonsense');
  assert.equal(ctx.data.holdMsDeclared, 1000, 'garbage falls back to the default');
});

// ---------------------------------------------------------------------------
// 3. Changing the declaration must NOT touch the receive pipeline
// ---------------------------------------------------------------------------

test('the declaration is never referenced by the decode / frame / reconstruction path', () => {
  const readers = ['holdMsDeclared', 'holdMsInput', 'applyHoldMs', 'onHoldMsChip', 'theoChunkRate'];
  const regions: Array<[string, string, string]> = [
    ['processBaselineFrame', '  processBaselineFrame(buffer, width, height) {', '  runBaselineFrame(entry) {'],
    ['runBaselineFrame', '  runBaselineFrame(entry) {', '  // Completion is ALL UNIQUE'],
    ['finalizeBaseline', '  finalizeBaseline() {', '  // Reconstruction complete'],
  ];
  for (const [name, start, end] of regions) {
    const from = PAGE_JS.indexOf(start);
    const to = PAGE_JS.indexOf(end);
    assert.ok(from > 0 && to > from, name + ' body located');
    const body = PAGE_JS.slice(from, to);
    for (const token of readers) {
      assert.ok(!body.includes(token), name + ' must not read the declared holdMs (' + token + ')');
    }
  }
  // And the shared core cannot see it at all.
  for (const token of ['holdMsDeclared', 'theoChunkRate']) {
    assert.ok(!JSON.stringify(Object.keys(opticalCore)).includes(token), 'the core is unaware of ' + token);
  }
});

test('changing the declaration mid-run leaves decode, reconstruction and SHA untouched', () => {
  const ctx = harness();
  const transfer = core.buildSingleBaselineTransfer();
  const matrixSize = core.SINGLE_BASELINE_MATRIX;
  const total = transfer.totalChunks;
  assert.equal(total, 16);

  // The receiver joins at chunk 5 and the PO changes the declaration between
  // EVERY frame — the only thing that must change is the annotation.
  for (let step = 0; step < total; step += 1) {
    const chunkIndex = (5 + step) % total;
    ctx.onHoldMsChip(chip(STAGE_B_AND_OUTLIER[step % STAGE_B_AND_OUTLIER.length]));
    const frame = core.renderSingleBaselineFrame(transfer.frames[chunkIndex], matrixSize, {
      width: 720,
      height: 720,
      fill: 0.72,
    }) as {width: number; height: number; data: Uint8ClampedArray};
    ctx.runBaselineFrame({buffer: frame.data.buffer, width: frame.width, height: frame.height});
  }

  const receiver = ctx.baselineReceiver;
  assert.equal(receiver.complete, true, 'all 16 unique chunks arrived despite the changes');
  assert.equal(receiver.receivedUniqueCount, 16);
  assert.deepEqual(receiver.missingIndices(), []);
  assert.equal(receiver.metrics.locateFailures, 0);
  assert.equal(receiver.metrics.crcFailures, 0);
  assert.equal(receiver.metrics.decodeSuccess, 16);

  // The reconstruction and SHA verdict are produced by the shared core and are
  // identical to a run with a constant declaration.
  const result = ctx.baselineResult;
  assert.ok(result, 'finalizeBaseline ran');
  assert.equal(result.bytes.length, 10240);
  assert.equal(result.match, true, 'SHA-256 MATCH is unaffected by the declaration');
  assert.equal(result.sha256Hex, transfer.fileSha256Hex);

  // The frozen JSON records the LAST declared value and still reports the real
  // measured completion, i.e. annotation and measurement stay separate.
  const payload = ctx.buildResultPayload();
  assert.equal(payload.benchmark.holdMs, STAGE_B_AND_OUTLIER[(total - 1) % STAGE_B_AND_OUTLIER.length]);
  assert.equal(payload.completion.shaResult, 'MATCH');
  assert.equal(payload.completion.reconstructedBytes, 10240);
  assert.equal(payload.physical.uniqueReceived, 16);
  assert.ok(payload.exploratoryNetGoodputBytesPerSecond > 0, 'a complete SHA-exact run still yields goodput');
});

// ---------------------------------------------------------------------------
// 4. The PC sender keeps the same declaration surface
// ---------------------------------------------------------------------------

test('the PC sender exposes a visible holdMs dropdown wired to the same values', () => {
  assert.ok(SENDER_HTML.includes('id="holdMsSelect"'), 'the sender page has a dropdown');
  assert.ok(SENDER_HTML.includes('Hold time / 每码停留'), 'the dropdown is labelled');
  assert.ok(SENDER_HTML.includes('Current holdMs / 当前每码停留'), 'the sender shows the current hold time');
  assert.ok(SENDER_HTML.includes('Theoretical chunks/s / 理论切片速率'), 'the sender shows the chunk rate');
  assert.ok(SENDER_HTML.includes('Theoretical payload rate / 理论载荷速率'), 'the sender shows the payload rate');
  // The groups come from the shared ladders, never from a hard-coded copy.
  assert.ok(SENDER_MAIN.includes('SINGLE_BASELINE_STAGE_B_LADDER'), 'Stage B comes from the shared ladder');
  assert.ok(SENDER_MAIN.includes("url.searchParams.set('holdMs'"), 'the URL query stays in sync');
  assert.ok(SENDER_MAIN.includes('stopBroadcast()'), 'a running broadcast is stopped before applying');
});
