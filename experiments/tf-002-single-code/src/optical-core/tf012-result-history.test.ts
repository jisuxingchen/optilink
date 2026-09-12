/**
 * TF-012 r8 — Mini Program result history + first-screen key status.
 *
 * WHAT THIS PINS
 *
 *  1. Every Freeze Test Result APPENDS a complete frozen JSON payload to a bounded
 *     local history (>= the most recent 20 runs), and the history survives a page
 *     reload because it round-trips through local storage.
 *  2. "Copy All Results" exports ALL stored runs as ONE JSON ARRAY of complete
 *     payloads — not line-delimited text, and not a summary.
 *  3. "Copy Latest Result" exports exactly the newest payload.
 *  4. "Clear History" empties the store and leaves nothing behind.
 *  5. The first-screen summary shows historyCount / lastFreezeAt / latest SHA /
 *     latest uniqueReceived-of-totalChunks from REAL receiver counters.
 *  6. Reset Metrics resets live counters only — it must never wipe the history.
 *
 * The page is loaded with a stubbed `wx` so storage and clipboard are exercised
 * for real, and the payload builder used is the SHIPPED r6/r7 baseline builder, so
 * "complete JSON" means benchmark + physical + completion + efficiency + locator,
 * not a fixture invented by this test.
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
const PAGE_JS_PATH = join(MINI, 'pages', 'index', 'index.js');
const PAGE_JS = readFileSync(PAGE_JS_PATH, 'utf8');
const PAGE_WXML = readFileSync(join(MINI, 'pages', 'index', 'index.wxml'), 'utf8');

const opticalCore = createRequire(import.meta.url)(join(MINI, 'utils', 'optical-core.js')) as Record<string, any>;

type Harness = {
  ctx: Record<string, any>;
  store: Map<string, unknown>;
  clips: string[];
  toasts: string[];
};

/**
 * Load the shipped page with an in-memory `wx` stub and a real receiver whose
 * counters describe a 16/16 SHA-MATCH baseline run.
 */
function harness(): Harness {
  const store = new Map<string, unknown>();
  const clips: string[] = [];
  const toasts: string[] = [];

  const wxStub: Record<string, any> = {
    setStorageSync: (key: string, value: unknown) => { store.set(key, value); },
    getStorageSync: (key: string) => (store.has(key) ? store.get(key) : ''),
    removeStorageSync: (key: string) => { store.delete(key); },
    setClipboardData: (options: {data: string; success?: () => void}) => {
      clips.push(options.data);
      if (options.success) options.success();
    },
    showToast: (options: {title?: string}) => { toasts.push(String(options && options.title)); },
    showModal: (options: {success?: (res: {confirm: boolean}) => void}) => {
      if (options && options.success) options.success({confirm: true});
    },
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
  ctx.baselineTimes = [];
  ctx.baselinePostCompleteFrames = 0;

  // Real receiver object (real metrics defaults) + a hand-set 16/16 SHA-MATCH run.
  const receiver = new opticalCore.SingleCodeBaselineReceiver();
  receiver.begin(0);
  receiver.totalChunks = 16;
  receiver.chunkDataBytes = 640;
  receiver.totalFileBytes = 10240;
  receiver.fileName = 'baseline-10k.txt';
  receiver.fileSha256 = 'deadbeef';
  receiver.reconstructionMethod = 'CONCAT_BY_INDEX';
  receiver.activeFileId = 0x51bb1234;
  for (let index = 0; index < 16; index += 1) receiver.received.set(index, new Uint8Array(640));
  const metrics = receiver.metrics;
  metrics.firstChunkMs = 500;
  metrics.allChunksMs = 12345;
  metrics.cameraFrames = 40;
  metrics.decodeAttempts = 40;
  metrics.decodeSuccess = 38;
  metrics.crcFailures = 2;
  metrics.locateFailures = 0;
  metrics.duplicateChunks = 22;
  metrics.codeWidthPx = 400;
  metrics.codeHeightPx = 400;
  metrics.pixPerCellX = 4.09;
  metrics.pixPerCellY = 4.09;
  metrics.locatorStage = 'G7d';
  metrics.locatorStageReason = 'crc-ok';
  metrics.reconstructMs = 3;
  metrics.shaMs = 2;
  ctx.baselineReceiver = receiver;
  ctx.baselineResult = {
    bytes: new Uint8Array(10240),
    sha256Hex: 'aa',
    expectedSha256: 'aa',
    match: true,
    reconstructMs: 3,
    shaMs: 2
  };
  ctx.baselineStartAt = Date.now() - 13000;
  ctx.baselineFramesReceived = 40;

  // onLoad() restores the history; doing the same here keeps one page instance's
  // history strictly independent of every other harness.
  ctx.loadHistory();
  assert.equal(ctx.data.historyCount, 0, 'each harness starts with an empty history');

  return {ctx, store, clips, toasts};
}

/** The exact storage key the page uses, read back out of the shipped source. */
function historyKey(): string {
  const match = /const HISTORY_KEY = '([^']+)'/u.exec(PAGE_JS);
  assert.ok(match, 'HISTORY_KEY is declared in the shipped page');
  return match![1];
}

// ---------------------------------------------------------------------------
// 1. Freeze appends to a persistent, bounded history
// ---------------------------------------------------------------------------

test('every Freeze Test Result appends one complete frozen JSON payload', () => {
  const {ctx, store} = harness();
  assert.equal(ctx.data.historyCount, 0, 'history starts empty');
  assert.equal(ctx.data.lastFreezeAt, '—');

  for (let run = 1; run <= 3; run += 1) {
    ctx.freezeResult();
    assert.equal(ctx.data.historyCount, run, 'historyCount increments on freeze #' + run);
  }

  const entries = JSON.parse(String(store.get(historyKey()))) as Array<Record<string, any>>;
  assert.equal(entries.length, 3, 'three runs were persisted');

  // Each stored payload is the COMPLETE r6/r7 frozen JSON, not a summary.
  for (const entry of entries) {
    const payload = entry.payload as Record<string, any>;
    for (const section of ['benchmark', 'physical', 'completion', 'efficiency', 'locator', 'transfer', 'decoding', 'timing']) {
      assert.ok(payload[section], 'stored payload carries the ' + section + ' section');
    }
    assert.equal(payload.completion.shaResult, 'MATCH');
    assert.equal(payload.completion.reconstructedBytes, 10240);
    assert.equal(entry.shaResult, 'MATCH');
    assert.equal(entry.uniqueReceived, 16);
    assert.equal(entry.totalChunks, 16);
  }
  assert.equal(entries[0].payload.timestamp !== undefined, true, 'the payload keeps its own timestamp');
});

test('the first-screen summary reports count, time, SHA and chunks', () => {
  const {ctx} = harness();
  ctx.freezeResult();
  ctx.freezeResult();

  assert.equal(ctx.data.historyCount, 2);
  assert.equal(ctx.data.historyShaResult, 'MATCH');
  assert.equal(ctx.data.historyShaClass, 'ok', 'SHA MATCH is emphasised as ok');
  assert.equal(ctx.data.historyChunks, '16 / 16');
  assert.notEqual(ctx.data.lastFreezeAt, '—', 'lastFreezeAt is populated');
});

test('history round-trips through local storage across a page reload', () => {
  const first = harness();
  first.ctx.freezeResult();
  first.ctx.freezeResult();
  const persisted = String(first.store.get(historyKey()));

  // Simulate a reload: a brand new page instance over the same local storage.
  const second = harness();
  second.store.set(historyKey(), persisted);
  second.ctx.loadHistory();

  assert.equal(second.ctx.data.historyCount, 2, 'reloaded page sees 2 stored runs');
  assert.equal(second.ctx.data.historyChunks, '16 / 16');
  assert.equal(second.ctx.data.historyShaResult, 'MATCH');
});

test('history keeps the most recent 20 runs and drops the oldest', () => {
  const {ctx, store} = harness();
  // Tag every run so the retained window can be identified exactly.
  for (let run = 1; run <= 25; run += 1) {
    ctx.data.holdMsDeclared = 1000 + run;
    ctx.freezeResult();
  }

  assert.equal(ctx.data.historyCount, 20, 'capped at 20');
  assert.equal(ctx.testHistory.length, 20);

  // The retained window is the LAST 20 freezes: 1006..1025 present, 1001..1005 gone.
  const held = ctx.testHistory.map((entry: Record<string, any>) => entry.holdMs);
  assert.deepEqual(held, Array.from({length: 20}, (_unused, index) => 1006 + index), 'oldest five runs were dropped');

  const persisted = JSON.parse(String(store.get(historyKey()))) as Array<Record<string, any>>;
  assert.equal(persisted.length, 20, 'the stored history matches the in-memory window');
  assert.equal(persisted[0].holdMs, 1006, 'storage also dropped the oldest five');
});

test('the byte budget trims the oldest runs only if a 20-run history would not fit', () => {
  const {ctx} = harness();
  ctx.freezeResult();
  // One complete frozen payload is a few kilobytes; 20 of them stay far below the
  // defensive cap, which must therefore never be the reason a run is dropped.
  const oneEntry = JSON.stringify([ctx.testHistory[0]]).length;
  assert.ok(oneEntry > 1000, 'a stored run is a real payload, not an empty shell');
  assert.ok(oneEntry < 50000, 'a stored run is small enough that 20 of them fit easily');
});

// ---------------------------------------------------------------------------
// 2. Export surfaces
// ---------------------------------------------------------------------------

test('Copy All Results exports one JSON array of complete payloads', () => {
  const {ctx, clips} = harness();
  ctx.freezeResult();
  ctx.freezeResult();
  ctx.freezeResult();
  clips.length = 0;

  ctx.copyAllResults();
  assert.equal(clips.length, 1, 'exactly one clipboard write');
  const text = clips[0];

  // It must parse as a JSON ARRAY (preferred format), not line-delimited text.
  const parsed = JSON.parse(text) as Array<Record<string, any>>;
  assert.ok(Array.isArray(parsed), 'Copy All is a JSON array');
  assert.equal(parsed.length, 3, 'it contains ALL three stored runs');

  // Each element is the complete frozen JSON, and it equals what was stored.
  for (let index = 0; index < 3; index += 1) {
    for (const section of ['benchmark', 'physical', 'completion', 'efficiency', 'locator']) {
      assert.ok(parsed[index][section], 'element ' + index + ' carries ' + section);
    }
    assert.equal(parsed[index].chunks.uniqueReceived, 16);
    assert.equal(parsed[index].completion.shaResult, 'MATCH');
    assert.deepEqual(parsed[index], ctx.testHistory[index].payload, 'export equals the stored payload');
  }
});

test('Copy Latest Result exports exactly the newest payload', () => {
  const {ctx, clips} = harness();
  ctx.freezeResult();
  ctx.freezeResult();
  clips.length = 0;

  ctx.copyLatestResult();
  assert.equal(clips.length, 1);
  const parsed = JSON.parse(clips[0]) as Record<string, any>;
  assert.ok(!Array.isArray(parsed), 'Copy Latest is a single JSON object');
  assert.deepEqual(parsed, ctx.testHistory[1].payload);
});

test('Clear History empties the store; the buttons guard empty history', () => {
  const {ctx, store, clips} = harness();
  ctx.freezeResult();
  assert.equal(store.has(historyKey()), true, 'history was persisted');

  ctx.clearHistory();
  assert.equal(ctx.data.historyCount, 0);
  assert.equal(ctx.testHistory.length, 0);
  assert.equal(store.has(historyKey()), false, 'the storage key is removed');
  assert.equal(ctx.data.historyShaResult, '—');
  assert.equal(ctx.data.lastFreezeAt, '—');

  // Copy All must not write from an empty history. Copy Latest legitimately still
  // copies the result that is currently on screen (Clear keeps that snapshot).
  clips.length = 0;
  ctx.copyAllResults();
  assert.equal(clips.length, 0, 'Copy All writes nothing from an empty history');
  ctx.copyLatestResult();
  assert.equal(clips.length, 1, 'Copy Latest still exports the on-screen snapshot');
  const stillLatest = JSON.parse(clips[0]) as Record<string, any>;
  assert.equal(stillLatest.completion.shaResult, 'MATCH', 'the kept snapshot is the real frozen result');
});

// ---------------------------------------------------------------------------
// 3. Non-regression: history is independent of metrics reset
// ---------------------------------------------------------------------------

test('Reset Metrics resets live counters only and never wipes the history', () => {
  const {ctx, store} = harness();
  ctx.freezeResult();
  ctx.freezeResult();

  ctx.resetMetrics();

  assert.equal(ctx.data.historyCount, 2, 'history survives Reset Metrics');
  assert.equal(ctx.data.frozenResult, '', 'the on-screen snapshot is cleared');
  const entries = JSON.parse(String(store.get(historyKey()))) as unknown[];
  assert.equal(entries.length, 2, 'stored history is untouched by Reset Metrics');

  // Structural guard: resetMetrics must not reference the history key at all.
  const start = PAGE_JS.indexOf('  resetMetrics() {');
  const end = PAGE_JS.indexOf('  toggleHeavy() {');
  assert.ok(start > 0 && end > start, 'resetMetrics body located');
  const body = PAGE_JS.slice(start, end);
  assert.ok(!body.includes('HISTORY_KEY'), 'resetMetrics must not touch HISTORY_KEY');
  assert.ok(!body.includes('testHistory'), 'resetMetrics must not touch testHistory');
});

// ---------------------------------------------------------------------------
// 4. UI wiring + no new network path
// ---------------------------------------------------------------------------

test('the page exposes the r8 history surface and the first-screen key panel', () => {
  for (const method of ['freezeResult', 'copyLatestResult', 'copyAllResults', 'clearHistory', 'loadHistory', 'persistHistory', 'buildHistoryEntry', 'historySummaryPatch', 'buildKeyStatusPatch', 'refreshKeyStatus', 'toggleDiagnostics', 'modeLabelText']) {
    assert.ok(PAGE_JS.includes(method) || PAGE_WXML.includes(method), 'page exposes ' + method);
  }
  for (const field of ['historyCount', 'lastFreezeAt', 'historyShaResult', 'historyChunks', 'historyMax', 'showDiagnostics']) {
    assert.ok(PAGE_WXML.includes(field), 'the history panel shows ' + field);
  }
  // The key fields required on the first screen.
  for (const field of ['keyBuildId', 'keyModeLabel', 'keyHoldMs', 'keyChunks', 'keyMissing', 'keyFirstChunkMs', 'keyAllChunksMs', 'keySha', 'keyReconstruction', 'keyDeepestStage', 'keyStageReason', 'keyLocateFailures', 'keyCrcFailures', 'keyDuplicates', 'keyCodeWidth', 'keyPixPerCell']) {
    assert.ok(PAGE_WXML.includes(field), 'the key panel shows ' + field);
  }
  assert.ok(PAGE_WXML.includes('KEY STATUS'), 'the key panel is labelled');
  assert.ok(PAGE_WXML.includes('showDiagnostics'), 'low-priority diagnostics are collapsible');
  assert.ok(PAGE_WXML.indexOf('KEY STATUS') < PAGE_WXML.indexOf('showDiagnostics'), 'key fields precede the diagnostics block');

  // Clipboard + storage only: no network API may appear in the history feature.
  for (const forbidden of ['wx.request', 'wx.connectSocket', 'wx.uploadFile', 'wx.downloadFile', 'wx.sendSocketMessage', 'XMLHttpRequest', 'sendBeacon', 'https://']) {
    assert.ok(!PAGE_JS.includes(forbidden), 'history feature must not add ' + forbidden);
  }
  assert.ok(PAGE_JS.includes("'optilink.tf012.testHistory.v1'"), 'history uses one dedicated local storage key');
});

// ---------------------------------------------------------------------------
// 5. Compile sanity for the rewritten page
// ---------------------------------------------------------------------------

test('every event handler bound in the WXML exists on the page', () => {
  const {ctx} = harness();
  const bindings = new Set<string>();
  for (const match of PAGE_WXML.matchAll(/bind(?:tap|input|change|initdone|stop|error)="([A-Za-z_$][\w$]*)"/gu)) {
    bindings.add(match[1]);
  }
  assert.ok(bindings.size >= 8, 'the page really binds handlers');
  for (const handler of bindings) {
    assert.equal(typeof ctx[handler], 'function', 'WXML binds ' + handler + '() and the page must define it');
  }
});

test('every data field referenced by the WXML exists in the page data', () => {
  const {ctx} = harness();
  const data = ctx.data as Record<string, unknown>;
  const allowed = new Set(['item', 'index', 'true', 'false', 'null', 'undefined']);
  const missing = new Set<string>();
  for (const match of PAGE_WXML.matchAll(/\{\{([^}]*)\}\}/gu)) {
    // Drop string literals first so 'Single-Code Baseline' contributes no names,
    // then drop property accesses so {{errors.length}} only needs `errors`.
    const expression = match[1].replace(/'[^']*'/gu, ' ').replace(/\.[A-Za-z_$][\w$]*/gu, ' ');
    for (const identifier of expression.match(/[A-Za-z_$][\w$]*/gu) || []) {
      if (allowed.has(identifier)) continue;
      if (!(identifier in data)) missing.add(identifier);
    }
  }
  assert.deepEqual(Array.from(missing), [], 'the WXML references only fields the page provides');
});

