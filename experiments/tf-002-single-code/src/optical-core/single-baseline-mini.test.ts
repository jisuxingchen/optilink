/**
 * TF-012 r4 — Single-Code Baseline integration / boundary tests.
 *
 *  16  Mini Program page boot smoke (registers Page(), buildId, modes)
 *  17  Mini Program baseline mode smoke (mode wiring + shared-core only)
 *  18  network scan: the baseline adds NO network path anywhere
 *  19  oracle scan: the receiver never reads a sender-side payload object
 *
 * These are static/structural checks over the SHIPPED artifacts (the Mini
 * Program page + its committed bundle + the sender page), so they fail loudly
 * if a future change reintroduces a network path or an out-of-band oracle.
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

const read = (path: string): string => readFileSync(path, 'utf8');

const PAGE_JS = read(join(MINI, 'pages', 'index', 'index.js'));
const PAGE_WXML = read(join(MINI, 'pages', 'index', 'index.wxml'));
const BUNDLE = read(join(MINI, 'utils', 'optical-core.js'));
const SENDER_MAIN = read(join(SPIKE, 'src', 'single-baseline-sender-main.ts'));
const SENDER_HTML = read(join(SPIKE, 'single-baseline.html'));
const CORE = read(join(SPIKE, 'src', 'optical-core', 'single-baseline.ts'));

const NETWORK_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['wx.request', /\bwx\.request\b/u],
  ['wx.connectSocket', /\bwx\.connectSocket\b/u],
  ['wx.uploadFile', /\bwx\.uploadFile\b/u],
  ['wx.downloadFile', /\bwx\.downloadFile\b/u],
  ['wx.sendSocketMessage', /\bwx\.sendSocketMessage\b/u],
  ['WebSocket', /\bnew\s+WebSocket\b/u],
  ['fetch()', /[^.\w]fetch\s*\(/u],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/u],
  ['sendBeacon', /\bsendBeacon\b/u],
  ['http(s) URL', /https?:\/\//u],
];

test('16 · Mini Program page boot smoke (Page() registers with baseline surface)', () => {
  const require2 = createRequire(import.meta.url);
  let captured: Record<string, unknown> | null = null;
  (globalThis as unknown as Record<string, unknown>).Page = (cfg: Record<string, unknown>) => { captured = cfg; };
  const entry = join(MINI, 'pages', 'index', 'index.js');
  delete require2.cache[require2.resolve(entry)];
  require2(entry);
  assert.ok(captured, 'Page() was called');
  const page = captured as unknown as Record<string, unknown>;
  const data = page.data as Record<string, unknown>;
  assert.equal(data.mode, 'receive', 'default mode is the shared receive pipeline');
  assert.match(String(data.buildId), /^tf012-r14-/, 'buildId uses the tf012-r14 prefix');
  assert.equal(data.baselineStatus, 'WAITING / 等待', 'baseline status is part of the initial data');
  assert.equal(data.baselineReceivedChunks, '0 / 16', 'baseline chunk counter is part of the initial data');
  assert.ok('baselineSelfCheck' in data, 'baseline self-check field present');

  // The baseline mode is a first-class, selectable mode with its own pipeline.
  for (const method of ['processBaselineFrame', 'runBaselineFrame', 'finalizeBaseline', 'onBaselineTick', 'buildBaselineResultPayload', 'runBaselineSelfCheck']) {
    assert.equal(typeof page[method], 'function', 'page exposes ' + method);
  }
  assert.match(PAGE_WXML, /data-mode="baseline"/u, 'the baseline mode has a UI button');
  assert.match(PAGE_WXML, /单码基线/u, 'the baseline mode is labelled in Chinese too');
  assert.match(PAGE_WXML, /baselineReceivedChunks/u, 'the baseline panel shows received chunks');
  assert.match(PAGE_WXML, /baselineMissingChunks/u, 'the baseline panel shows missing chunks');
  assert.match(PAGE_WXML, /baselineShaStatus/u, 'the baseline panel shows the SHA result');
  assert.match(PAGE_WXML, /baselineContentPreview/u, 'the baseline panel shows the reconstructed content');
  // TF-012 r5: G7 is split into observable sub-stages on the phone.
  for (const g7 of ['G7a Candidate Detection / 候选区域检测', 'G7b Code Bounding Box / 码边界定位', 'G7c Geometry Lock / 几何锁定', 'G7d OptiGrid CRC Decode / CRC 解码']) {
    assert.ok(PAGE_WXML.includes(g7), 'baseline panel shows ' + g7);
  }
  for (const field of ['g7Stage', 'g7StageReason', 'g7aLuma', 'g7aContrast', 'g7aThreshold', 'g7aDarkRatio', 'g7aComponents', 'g7aCandidates', 'g7aCandidateSpans', 'g7aLargestBox', 'g7aRejection', 'g7bPass', 'g7bReason', 'g7cSeeds', 'g7cBestSeed', 'g7cRefined', 'g7cBestRefined', 'g7cGeometry', 'g7cReason', 'g7dPass', 'g7dCrc', 'g7dSequence', 'g7dChunkIndex']) {
    assert.ok(PAGE_WXML.includes(field), 'baseline panel shows ' + field);
    assert.ok(field in data, 'page data exposes ' + field);
  }
  assert.match(PAGE_JS, /locator: \{/u, 'the frozen result carries a locator section');
  for (const section of ['g7aCandidateDetection', 'g7bCodeBoundingBox', 'g7cGeometryLock', 'g7dCrcDecode']) {
    assert.ok(PAGE_JS.includes(section), 'frozen result carries ' + section);
  }

  // TF-012 r6 speed ladder: the phone can declare the hold duration and read the
  // corrected ACTIVE latency plus a gated exploratory Net Goodput.
  for (const method of ['applyHoldMs', 'onHoldMsInput', 'onHoldMsPick', 'baselineActiveStats', 'baselineNetGoodputMetrics']) {
    assert.equal(typeof page[method], 'function', 'page exposes ' + method);
  }
  for (const field of ['holdMsLadder', 'theoChunkRate', 'theoPayloadRate', 'activeProcessAvgMs', 'activeProcessP50Ms', 'activeProcessP95Ms', 'activeProcessMaxMs', 'activeProcessSamples', 'postCompleteFrames', 'clockSource', 'netGoodputText', 'holdMsDeclared']) {
    assert.ok(field in data, 'page data exposes ' + field);
    assert.ok(PAGE_WXML.includes(field), 'speed-ladder panel shows ' + field);
  }
  for (const section of ['benchmark: {', 'physical: {', 'completion: {']) {
    assert.ok(PAGE_JS.includes(section), 'frozen result carries the r6 ' + section);
  }
  for (const field of ['theoreticalChunksPerSecond', 'theoreticalPayloadBytesPerSecond', 'theoreticalPayloadKiBPerSecond', 'timeToFirstValidChunkMs', 'timeToAllChunksMs', 'successfulDecodes', 'observedCodeWidthPx', 'observedCodeHeightPx', 'pixelsPerCellX', 'pixelsPerCellY', 'reconstructedBytes', 'shaResult', 'exploratoryNetGoodputBytesPerSecond', 'exploratoryNetGoodputKiBPerSecond']) {
    assert.ok(PAGE_JS.includes(field), 'frozen result carries ' + field);
  }
  // Net Goodput is gated by the shared core, never computed inline on the phone.
  assert.match(PAGE_JS, /singleBaselineNetGoodput\(/u, 'net goodput uses the shared definition');
  assert.match(PAGE_JS, /clampSingleBaselineHoldMs\(/u, 'hold ms uses the shared ladder clamp');

  // TF-012 r7 Stage B operating-window metrics: diagnostic only, ranking PASSing
  // points — never the PASS condition, never "decode opportunities".
  assert.equal(typeof page.baselineEfficiencyMetrics, 'function', 'page exposes baselineEfficiencyMetrics');
  assert.match(PAGE_JS, /singleBaselineEfficiency\(/u, 'efficiency uses the shared definition');
  assert.match(PAGE_JS, /SINGLE_BASELINE_HOLD_MS_PRESETS/u, 'the phone picker uses the merged preset list');
  assert.match(PAGE_JS, /efficiency: \{/u, 'the frozen result carries an efficiency block');
  for (const field of ['theoreticalCameraFramesPerCode', 'decodeSuccessRatio', 'crcFailureRatio', 'locateFailureRatio', 'newUniqueChunkYield', 'duplicateRatio']) {
    assert.ok(PAGE_JS.includes(field), 'frozen result carries ' + field);
    assert.ok(field in data, 'page data exposes ' + field);
    assert.ok(PAGE_WXML.includes(field), 'speed-ladder panel shows ' + field);
  }
  // The bundle must expose the r7 helpers and the merged preset list.
  assert.match(BUNDLE, /singleBaselineEfficiency/u, 'bundle exports singleBaselineEfficiency');
  assert.match(BUNDLE, /SINGLE_BASELINE_STAGE_B_LADDER/u, 'bundle exports the Stage B ladder');
});

test('17 · Mini Program baseline mode smoke uses the shared core only', () => {
  // The committed bundle exports the shared baseline implementation.
  assert.match(BUNDLE, /SingleCodeBaselineReceiver/u, 'bundle exports SingleCodeBaselineReceiver');
  assert.match(BUNDLE, /singleBaselinePreviewText/u, 'bundle exports the UTF-8 preview helper');
  assert.match(BUNDLE, /captureSingleBaselineCode/u, 'bundle contains the single-code locator');

  // The adapter builds the pixel frame from the CameraFrame buffer and hands it
  // to the shared core — it never decodes payload bits itself.
  const runFrame = PAGE_JS.slice(PAGE_JS.indexOf('  runBaselineFrame(entry) {'), PAGE_JS.indexOf('  onBaselineTick() {'));
  assert.ok(runFrame.length > 100, 'runBaselineFrame present');
  assert.match(runFrame, /data: new Uint8ClampedArray\(entry\.buffer\)/u, 'baseline frame comes from the camera buffer');
  assert.match(runFrame, /receiver\.ingestFrame\(frame, BASELINE_MATRIX, clockMs\(\)\)/u, 'baseline ingest goes through the shared core');
  assert.match(runFrame, /receiver\.complete/u, 'completion is decided by the shared core');
  // r6 timing accounting: a post-completion frame must be classified BEFORE the
  // call and excluded from the active latency aggregate (it used to be averaged
  // in, which is what collapsed avgFrameProcessMs to ~0.007 ms).
  assert.match(runFrame, /active = stageBefore !== 'complete'/u, 'post-completion frames are classified before the call');
  assert.match(runFrame, /if \(active\) \{/u, 'active latency samples are gated on the pre-call stage');
  assert.match(runFrame, /this\.baselinePostCompleteFrames \+= 1/u, 'post-completion frames are counted separately');
  assert.match(PAGE_JS, /receiver\.reconstruct\(\)/u, 'reconstruction is done by the shared core');
  assert.match(PAGE_JS, /receiver\.missingIndices\(\)/u, 'missing-chunk reporting comes from the shared core');

  // No TF-012 state machine, no Preamble, no Manifest, no Fountain in this path.
  for (const forbidden of ['lockPreamble', 'readManifest', 'FountainDecoder', 'SharedOpticalReceiveCore.']) {
    assert.ok(!runFrame.includes(forbidden), 'baseline path must not reference ' + forbidden);
  }

  // The sender renders exactly one code and all metadata lives in the chunk.
  assert.match(SENDER_MAIN, /buildSingleBaselineTransfer\(\)/u, 'sender uses the shared transfer builder');
  assert.match(SENDER_MAIN, /drawChunk/u, 'sender draws one chunk at a time');
  assert.ok(!/TILE_COUNT|tileCount|TILE_CENTERS/u.test(SENDER_MAIN), 'sender has no 3-tile composition');
  assert.ok(!/FountainEncoder|FountainDecoder|new Fountain|Fountain\w+/u.test(SENDER_MAIN), 'sender has no Fountain code path');
  assert.match(SENDER_HTML, /One OptiGrid only/u, 'sender page documents the single-code display');
});

test('18 · network scan: the Single-Code Baseline adds no network path', () => {
  for (const [label, pattern] of NETWORK_PATTERNS) {
    assert.ok(!pattern.test(PAGE_JS), 'Mini Program page must not use ' + label);
    assert.ok(!pattern.test(BUNDLE), 'optical-core bundle must not use ' + label);
    assert.ok(!pattern.test(CORE), 'single-baseline core must not use ' + label);
    assert.ok(!pattern.test(SENDER_MAIN), 'baseline sender must not use ' + label);
  }
  // The sender is a local static page; it declares the payload path explicitly.
  assert.match(PAGE_JS, /Network payload path: NONE/u, 'the page states the payload path');
  assert.match(PAGE_JS, /networkPayloadPath: 'NONE'/u, 'the frozen result states the payload path');
  assert.ok(CORE.includes('STATELESS CYCLIC BROADCASTER'), 'the protocol declares the stateless broadcaster contract');
  assert.ok(/no ACK/iu.test(CORE), 'the protocol declares the no-ACK contract');
  assert.ok(/no network payload/iu.test(CORE), 'the protocol declares the optical-only payload contract');
  assert.ok(/may join at ANY point/iu.test(CORE), 'the protocol declares the arbitrary-join contract');
  assert.ok(/ALL UNIQUE CHUNKS ARE PRESENT/iu.test(CORE), 'the protocol declares the true completion condition');
});

test('19 · oracle scan: the receiver never reads a sender-side payload object', () => {
  // The sender publishes a diagnostic harness surface for the browser only.
  assert.match(SENDER_MAIN, /__SINGLE_BASELINE_SENDER__/u);
  const globalUse = /\b(?:window|document|navigator)[ \t]*\.[ \t]*[A-Za-z_$]/u;
  // The receiver must not know about it (or about any other out-of-band oracle).
  for (const oracle of ['__SINGLE_BASELINE_SENDER__', '__TF012_SENDER__', '__TF009_SENDER__', '__TF011_SENDER__']) {
    assert.ok(!PAGE_JS.includes(oracle), 'Mini Program receiver must not reference ' + oracle);
    assert.ok(!BUNDLE.includes(oracle), 'shared bundle must not reference ' + oracle);
  }
  assert.ok(!globalUse.test(PAGE_JS), 'Mini Program receiver must not touch browser globals');
  assert.ok(!globalUse.test(BUNDLE), 'shared bundle must not touch browser globals');
  // Every byte the baseline receiver consumes comes from a decoded OptiGrid
  // frame: the only ingest entry points take a camera frame or a decoded frame.
  assert.match(CORE, /ingestFrame\(frame: PixelFrame/u, 'ingestFrame accepts only pixels');
  assert.match(CORE, /ingestDecoded\(decoded: OptiGridV1DecodedFrame/u, 'ingestDecoded accepts only a decoded OptiGrid frame');
  assert.ok(!/localStorage|wx\.getStorageSync\('optilink\.singleBaseline/u.test(CORE), 'baseline keeps no side channel state');
});
