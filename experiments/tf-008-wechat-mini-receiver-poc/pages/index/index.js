/**
 * OptiLink WeChat Mini Program Receiver — camera-frame PoC (TF-008 spike).
 *
 * PURPOSE
 * Prove JavaScript receives real, continuous camera pixel data via
 * CameraContext.onCameraFrame, and measure the metrics OptiLink needs before
 * committing to a Mini Program Receiver. This is a feasibility spike ONLY —
 * it does NOT implement TF-007H acquisition, Manifest recovery, OptiGrid
 * decode, or payload reconstruction.
 *
 * PRODUCT BOUNDARY (hard rule)
 * Payload is OPTICAL-ONLY. This Mini Program makes ZERO network calls. No
 * OptiGrid image / cell / frame / payload / oracle data leaves the device
 * through Wi-Fi, mobile data, Bluetooth, USB, NFC, WebSocket, or HTTP/HTTPS.
 */

const NORMALIZE_W = 1280;
const NORMALIZE_H = 720;
const STAT_SAMPLE_STEP = 16;   // sample every Nth pixel for the cheap luma stat
const NORMALIZE_EVERY = 3;     // run the normalization bench every Nth frame when enabled
const FRAME_TIMEOUT_MS = 5000; // "no camera frame received within 5s"
const UI_REFRESH_MS = 500;     // periodic UI refresh / FPS window
const PROCESS_TIME_CAP = 600;  // max ACTIVE processing-time samples kept for p50/p95
const RECEIVE_MATRIX = 96;     // protocol constant: manifest + dynamic symbol matrix
const BASELINE_MATRIX = 96;    // TF-012 r4 single-code baseline matrix
const BASELINE_TOTAL_CHUNKS = 16; // TF-012 r4 baseline: 10240 B / 640 B per chunk
const BASELINE_FILE_BYTES = 10240; // TF-012 r4/r6 deterministic source file size
const BASELINE_DEFAULT_HOLD_MS = 1000; // must match the sender URL ?holdMs=

// Shared optical acquisition core (bundled from the TF-007H modules).
// GUARDED LOAD: the page must never fail silently. If the bundle throws at
// require time (e.g. a missing runtime global), Page() still registers and the
// UI visibly shows BOOT ERROR with the reason. The receive pipeline degrades
// to "core unavailable" and still renders.
let opticalCore = null;
let opticalCoreLoadError = '';
try {
  opticalCore = require('../../utils/optical-core.js');
} catch (err) {
  opticalCoreLoadError = String(err && err.message ? err.message : err);
}

// Unmistakable build identifier — must be visible on the phone to prove the
// device is running the latest shared-receive package (not a stale cache).
const BUILD_ID = 'tf012-r6-a0e180b';

/**
 * Monotonic millisecond clock for the speed-ladder benchmark.
 *
 * WHY THIS EXISTS: the r4/r5 timing block averaged `Date.now() - t0` over ALL
 * processed baseline frames. Post-completion frames return immediately from
 * `ingestFrame` before touching a single pixel, and the adapter's frame wrapper
 * is a ZERO-COPY `new Uint8ClampedArray(arrayBuffer)` view, so those frames cost
 * ~0 ms. Because the sample ring keeps only the last PROCESS_TIME_CAP entries,
 * a long post-completion tail evicted every real decode sample and the reported
 * average collapsed to ~0.007 ms — a measurement of the ignore path, not of
 * decoding. Two independent corrections are applied here:
 *
 *   1. post-completion frames are excluded from the active latency aggregate and
 *      counted separately as `postCompleteFrames`;
 *   2. timings use a sub-millisecond clock when the platform provides one, so a
 *      fast decode is not quantised to 0 ms by Date.now()'s 1 ms resolution.
 *
 * `Date.now()` remains the fallback and the clock actually used is reported in
 * the frozen JSON as `timing.clockResolutionMs` / `timing.clockSource`.
 */
const performanceClock = (function () {
  try {
    if (typeof wx === 'undefined' || typeof wx.getPerformance !== 'function') return null;
    const perf = wx.getPerformance();
    return perf && typeof perf.now === 'function' ? perf : null;
  } catch (err) {
    return null;
  }
}());

const CLOCK_SOURCE = performanceClock ? 'wx.getPerformance().now()' : 'Date.now()';

function clockMs() {
  return performanceClock ? performanceClock.now() : Date.now();
}

// Checkpoint persistence (bounded cadence — never per camera frame). The
// platform-neutral core owns checkpoint export/import; this adapter only does
// storage I/O behind a small swappable interface.
const CHECKPOINT_KEY = 'optilink.tf011.receiveCheckpoint.v1';
const CHECKPOINT_EVERY_TICKS = 4; // ~2s at UI_REFRESH_MS=500

const storageAdapter = {
  save(key, value) {
    try { wx.setStorageSync(key, value); return true; } catch (err) { return false; }
  },
  load(key) {
    try { return wx.getStorageSync(key) || null; } catch (err) { return null; }
  },
  remove(key) {
    try { wx.removeStorageSync(key); } catch (err) { /* ignore */ }
  }
};

Page({
  data: {
    // lifecycle
    running: false,
    callbackActive: false,
    frozen: false,
    heavy: false,
    mode: 'receive', // 'receive' | 'benchmark' | 'baseline'
    buildId: BUILD_ID,
    bootStatus: 'BOOT OK',
    bootError: '',
    permissionStatus: 'unknown',
    maxZoom: '—',
    networkPath: 'NONE',

    // receive mode state (SharedOpticalReceiveCore)
    productStage: 'Waiting for transfer',
    fileName: '—',
    receiveStage: 'IDLE',
    receiveSelectedTransform: '—',
    receiveTripletValid: '—',
    receiveSupport: '—',
    receiveExactTiles: '—',
    manifestStatus: '—',
    manifestFileSize: '—',
    decodedSymbols: 0,
    solvedBlocks: '—',
    totalBlocks: '—',
    reconstructionStatus: '—',
    shaStatus: '—',
    localFilePath: '—',
    receiveSelfCheck: '—',
    receivePipelineError: '',
    tileStatus: [],

    // TF-012 physical metric counters (Phase 12)
    beaconDetections: 0,
    orientationAttempts: 0,
    orientationSuccess: 0,
    manifestAcquisitions: 0,
    preambleAttempts: 0,
    preambleSuccess: 0,
    preambleRejected: 0,
    lastStageTransition: '—',
    lastStageTransitionAt: '—',
    duplicates: 0,
    redundant: 0,
    rejected: 0,
    replaced: 0,
    reconstructionMs: '—',
    shaMs: '—',
    fileWriteMs: '—',
    networkType: '—',

    // TF-012 r4 single-code baseline (单码基线) mode state
    baselineStatus: 'WAITING / 等待',
    baselineFileId: '—',
    baselineFileName: '—',
    baselineFileSize: '—',
    baselineReceivedChunks: '0 / 16',
    baselineMissingChunks: '—',
    baselineDuplicates: 0,
    baselineLastChunk: '—',
    baselineDecodeAttempts: 0,
    baselineDecodeSuccess: 0,
    baselineCrcFailures: 0,
    baselineLocateFailures: 0,
    baselineForeignRejects: 0,
    baselineMetadataRejects: 0,
    baselineCodeWidth: '—',
    baselinePixPerCell: '—',
    baselineReservedScore: '—',
    baselineRotation: '—',
    baselineContrast: '—',
    baselineFirstChunkMs: '—',
    baselineAllChunksMs: '—',
    baselineElapsed: '—',
    baselineFrameInfo: '—',
    baselineReconstructionStatus: '—',
    baselineReconstructMethod: '—',
    baselineReconstructMs: '—',
    baselineShaMs: '—',
    baselineShaStatus: '—',
    baselineContentPreview: '',
    baselinePreviewLines: 0,
    baselineSelfCheck: '—',

    // TF-012 r6 speed ladder (declared hold time + corrected active latency +
    // exploratory net goodput). Theoretical rates are DECLARED arithmetic.
    // r6 speed ladder: the DECLARED hold duration of ONE chunk, matching the
    // sender URL (?holdMs=). The receiver cannot observe the sender's timer, so
    // the PO declares it and every theoretical rate is derived from it and
    // labelled as declared — never as a measured goodput.
    holdMsInput: String(BASELINE_DEFAULT_HOLD_MS),
    holdMsDeclared: BASELINE_DEFAULT_HOLD_MS,
    holdMsLadder: [],
    theoChunkRate: '—',
    theoPayloadRate: '—',
    // r7 diagnostic efficiency metrics (rank PASSing points, never decide PASS)
    theoreticalCameraFramesPerCode: '—',
    decodeSuccessRatio: '—',
    crcFailureRatio: '—',
    locateFailureRatio: '—',
    newUniqueChunkYield: '—',
    duplicateRatio: '—',
    activeProcessAvgMs: '—',
    activeProcessP50Ms: '—',
    activeProcessP95Ms: '—',
    activeProcessMaxMs: '—',
    activeProcessSamples: 0,
    postCompleteFrames: 0,
    clockSource: '—',
    netGoodputText: 'null (needs 16/16 + SHA MATCH)',

    // G7 locator diagnostics (G7a candidate → G7b bounding box → G7c geometry → G7d CRC)
    g7aPass: '—',
    g7aCount: '0 / 0',
    g7aLuma: '—',
    g7aContrast: '—',
    g7aThreshold: '—',
    g7aDarkRatio: '—',
    g7aLocalVariation: '—',
    g7aChannels: '—',
    g7aComponents: '—',
    g7aCandidates: '—',
    g7aCandidateSpans: '—',
    g7aLargestBox: '—',
    g7aBrightRegion: '—',
    g7aRejection: '—',
    g7bPass: '—',
    g7bReason: '—',
    g7cPass: '—',
    g7cSeeds: '—',
    g7cBestSeed: '—',
    g7cRefined: '—',
    g7cBestRefined: '—',
    g7cGeometry: '—',
    g7cReason: '—',
    g7dPass: '—',
    g7dCrc: '—',
    g7dSequence: '—',
    g7dChunkIndex: '—',
    g7Stage: '—',
    g7StageReason: '—',

    // live metrics
    frameWidth: 0,
    frameHeight: 0,
    frameBufferBytes: 0,
    frameFormat: '—',
    callbackFps: '0.0',
    processingFps: '0.0',
    totalReceived: 0,
    processed: 0,
    skipped: 0,
    skipRatio: '0.0%',
    avgProcessMs: '—',
    p95ProcessMs: '—',
    ingressMBps: '0.000',

    // luminance / contrast
    meanLuma: '—',
    minLuma: '—',
    maxLuma: '—',
    contrastRange: '—',

    // normalization benchmark
    normalizeAvgMs: '—',
    normalizeP95Ms: '—',
    normalizeFps: '0.0',
    normalizeSamples: 0,

    // device evidence
    deviceTimestamp: '—',
    wechatVersion: '—',
    baseLibVersion: '—',
    platform: '—',
    system: '—',
    model: '—',
    brand: '—',
    pixelRatio: '—',
    screenSize: '—',
    sdkVersion: '—',

    // errors / warnings
    errors: [],

    // frozen test result
    frozenResult: '',
    frozenAt: '',

    log: ''
  },

  // ---- non-reactive internal state --------------------------------------
  cameraContext: null,
  frameListener: null,
  timer: null,
  frameTimeoutTimer: null,

  startedAt: 0,
  lastFrameAt: 0,
  receivedFrames: 0,
  processedFrames: 0,
  skippedFrames: 0,
  normalizeSamples: 0,

  windowStartAt: 0,
  windowReceived: 0,
  windowProcessed: 0,

  processTimes: [],    // ms per processed frame
  normalizeTimes: [],  // ms per normalization run

  latestLuma: null,

  // receive mode internal state
  receiveCore: null,           // SharedOpticalReceiveCore instance
  receiveBusy: false,          // one frame actively processing (no unbounded queue)
  receivePending: null,        // bounded slot: at most one latest pending frame
  receiveFramesReceived: 0,
  receiveFramesProcessed: 0,
  receiveFramesSkipped: 0,
  receiveFramesReplaced: 0,    // pending-slot overwrites (older frame dropped)
  receiveTimes: [],            // ms per processed frame
  receiveStageTimes: {},       // per-stage ms samples
  receiveFinalized: false,     // reconstruction + SHA already finalized
  checkpointTick: 0,           // bounded checkpoint cadence counter
  frameW: 0, frameH: 0, frameBytes: 0,  // batched frame geometry (no per-frame setData)
  reconstructMs: 0, shaMs: 0, fileWriteMs: 0,

  // TF-012 r4 single-code baseline internal state (bypasses the full TF-012
  // state machine: no cold-join beacon, no Preamble, no Manifest, no Fountain,
  // no 3-tile logic — one big OptiGrid, one chunk per frame).
  baselineReceiver: null,
  baselineBusy: false,
  baselinePending: null,
  baselineFramesReceived: 0,
  baselineFramesProcessed: 0,
  baselineFramesReplaced: 0,
  // r6: ACTIVE (pre-completion) processing latency samples ONLY. Post-completion
  // ignored frames are counted in baselinePostCompleteFrames and never enter
  // this ring — see the clockMs() comment for the r4/r5 accounting bug.
  baselineTimes: [],
  baselinePostCompleteFrames: 0,
  baselineFinalized: false,
  baselineResult: null,
  baselineStartAt: 0,

  onLoad() {
    this.collectDeviceEvidence();
    this.readCameraPermission();
    this.cameraContext = wx.createCameraContext();
    this.receiveCore = (opticalCore && typeof opticalCore.SharedOpticalReceiveCore === 'function')
      ? new opticalCore.SharedOpticalReceiveCore()
      : null;
    this.baselineReceiver = (opticalCore && typeof opticalCore.SingleCodeBaselineReceiver === 'function')
      ? new opticalCore.SingleCodeBaselineReceiver()
      : null;
    if (this.baselineReceiver) this.baselineReceiver.begin(clockMs());

    // TF-012 r6/r7 speed ladder: expose Stage A + Stage B presets to the picker
    // and derive the declared theoretical rates for the default hold time.
    const ladder = (opticalCore && Array.isArray(opticalCore.SINGLE_BASELINE_HOLD_MS_PRESETS))
      ? opticalCore.SINGLE_BASELINE_HOLD_MS_PRESETS.slice()
      : [];
    const ladderLabels = ladder.map((value) => value + ' ms');
    this.setData({ holdMsLadder: ladderLabels, clockSource: CLOCK_SOURCE });
    this.applyHoldMs(BASELINE_DEFAULT_HOLD_MS);

    // Boot status is VISIBLE and never silent: if the bundle failed to load the
    // page still renders and shows BOOT ERROR with the reason.
    if (opticalCoreLoadError) {
      this.setData({ bootStatus: 'BOOT ERROR', bootError: opticalCoreLoadError });
      this.recordError('optical_core_load_failed:' + opticalCoreLoadError);
      this.appendLog('BOOT ERROR: ' + opticalCoreLoadError);
    } else if (!this.receiveCore) {
      this.setData({ bootStatus: 'BOOT ERROR', bootError: 'SharedOpticalReceiveCore missing from bundle' });
      this.recordError('receive_core_missing_from_bundle');
    } else {
      this.setData({ bootStatus: 'BOOT OK' });
    }

    this.windowStartAt = Date.now();
    this.timer = setInterval(() => this.onTick(), UI_REFRESH_MS);

    this.appendLog('OptiLink shared receive pipeline ready. Payload is OPTICAL-ONLY.');
    this.appendLog('Network payload path: NONE (no network APIs used).');
    this.runReceiveSelfCheck();
    this.restorePersistedCheckpoint();
  },

  onHide() {
    // App going to background: checkpoint if an incomplete session is active.
    this.persistCheckpoint();
  },

  onUnload() {
    this.stopAll();
  },

  // ---- camera component events ------------------------------------------
  onInitDone(e) {
    const maxZoom = e.detail && e.detail.maxZoom;
    if (maxZoom != null) this.setData({ maxZoom: String(maxZoom) });
    this.appendLog('camera init done, maxZoom=' + maxZoom);
  },

  onCameraStop() {
    this.setData({ running: false, callbackActive: false });
    this.appendLog('camera stopped by system (e.g. backgrounded)');
    this.recordError('camera_stopped_by_system');
  },

  onCameraError(e) {
    const detail = JSON.stringify(e && e.detail ? e.detail : e);
    this.setData({ running: false, callbackActive: false });
    this.appendLog('camera error: ' + detail);
    this.recordError('camera_error:' + detail);
  },

  // ---- controls ----------------------------------------------------------
  startCamera() {
    if (this.data.running) return;
    this.clearErrors();
    this.resetMetrics();

    if (!this.cameraContext) {
      try {
        this.cameraContext = wx.createCameraContext();
      } catch (err) {
        this.recordError('createCameraContext_failed:' + (err && err.message));
        this.setData({ running: false });
        return;
      }
    }

    try {
      this.frameListener = this.cameraContext.onCameraFrame((frame) => this.onFrame(frame));
    } catch (err) {
      this.recordError('onCameraFrame_unavailable:' + (err && err.message));
      this.setData({ running: false });
      return;
    }

    this.frameListener.start({
      success: () => {
        this.startedAt = Date.now();
        this.setData({ running: true, callbackActive: false });
        this.appendLog('frame listener started');
        this.armFrameTimeout();
      },
      fail: (err) => {
        const msg = err && err.errMsg ? err.errMsg : JSON.stringify(err);
        this.recordError('frame_listener_start_failed:' + msg);
        this.setData({ running: false, callbackActive: false });
      }
    });
  },

  stopCamera() {
    this.clearFrameTimeout();
    if (this.frameListener) {
      try { this.frameListener.stop(); } catch (err) { /* ignore */ }
      this.frameListener = null;
    }
    this.setData({ running: false, callbackActive: false });
    this.appendLog('frame listener stopped');
  },

  resetMetrics() {
    this.receivedFrames = 0;
    this.processedFrames = 0;
    this.skippedFrames = 0;
    this.normalizeSamples = 0;
    this.processTimes = [];
    this.normalizeTimes = [];
    this.latestLuma = null;
    this.receiveCore = (opticalCore && typeof opticalCore.SharedOpticalReceiveCore === 'function')
      ? new opticalCore.SharedOpticalReceiveCore()
      : null;
    this.receiveBusy = false;
    this.receivePending = null;
    this.baselineReceiver = (opticalCore && typeof opticalCore.SingleCodeBaselineReceiver === 'function')
      ? new opticalCore.SingleCodeBaselineReceiver()
      : null;
    if (this.baselineReceiver) this.baselineReceiver.begin(clockMs());
    this.baselineBusy = false;
    this.baselinePending = null;
    this.baselineFramesReceived = 0;
    this.baselineFramesProcessed = 0;
    this.baselineFramesReplaced = 0;
    this.baselineTimes = [];
    this.baselinePostCompleteFrames = 0;
    this.baselineFinalized = false;
    this.baselineResult = null;
    this.receiveFramesReceived = 0;
    this.receiveFramesProcessed = 0;
    this.receiveFramesSkipped = 0;
    this.receiveFramesReplaced = 0;
    this.receiveTimes = [];
    this.receiveStageTimes = {};
    this.receiveFinalized = false;
    this.checkpointTick = 0;
    this.frameW = 0;
    this.frameH = 0;
    this.frameBytes = 0;
    this.reconstructMs = 0;
    this.shaMs = 0;
    this.fileWriteMs = 0;
    this.windowStartAt = Date.now();
    this.windowReceived = 0;
    this.windowProcessed = 0;
    this.startedAt = Date.now();
    this.lastFrameAt = 0;
    this.baselineStartAt = Date.now();

    this.setData({
      frozen: false,
      frozenResult: '',
      frozenAt: '',
      frameWidth: 0,
      frameHeight: 0,
      frameBufferBytes: 0,
      frameFormat: '—',
      callbackFps: '0.0',
      processingFps: '0.0',
      totalReceived: 0,
      processed: 0,
      skipped: 0,
      skipRatio: '0.0%',
      avgProcessMs: '—',
      p95ProcessMs: '—',
      ingressMBps: '0.000',
      meanLuma: '—',
      minLuma: '—',
      maxLuma: '—',
      contrastRange: '—',
      normalizeAvgMs: '—',
      normalizeP95Ms: '—',
      normalizeFps: '0.0',
      normalizeSamples: 0,
      productStage: 'Waiting for transfer',
      fileName: '—',
      receiveStage: 'IDLE',
      receiveSelectedTransform: '—',
      receiveTripletValid: '—',
      receiveSupport: '—',
      receiveExactTiles: '—',
      manifestStatus: '—',
      manifestFileSize: '—',
      decodedSymbols: 0,
      solvedBlocks: '—',
      totalBlocks: '—',
      reconstructionStatus: '—',
      shaStatus: '—',
      localFilePath: '—',
      receiveSelfCheck: '—',
      receivePipelineError: '',
      tileStatus: [],
      beaconDetections: 0,
      orientationAttempts: 0,
      orientationSuccess: 0,
      manifestAcquisitions: 0,
      duplicates: 0,
      redundant: 0,
      rejected: 0,
      replaced: 0,
      reconstructionMs: '—',
      shaMs: '—',
      fileWriteMs: '—',
      baselineStatus: 'WAITING / 等待',
      baselineFileId: '—',
      baselineFileName: '—',
      baselineFileSize: '—',
      baselineReceivedChunks: '0 / 16',
      baselineMissingChunks: '—',
      baselineDuplicates: 0,
      baselineLastChunk: '—',
      baselineDecodeAttempts: 0,
      baselineDecodeSuccess: 0,
      baselineCrcFailures: 0,
      baselineLocateFailures: 0,
      baselineForeignRejects: 0,
      baselineMetadataRejects: 0,
      baselineCodeWidth: '—',
      baselinePixPerCell: '—',
      baselineReservedScore: '—',
      baselineRotation: '—',
      baselineContrast: '—',
      baselineFirstChunkMs: '—',
      baselineAllChunksMs: '—',
      baselineElapsed: '—',
      baselineFrameInfo: '—',
      baselineReconstructionStatus: '—',
      baselineReconstructMethod: '—',
      baselineReconstructMs: '—',
      baselineShaMs: '—',
      baselineShaStatus: '—',
      baselineContentPreview: '',
      baselinePreviewLines: 0
    });
    this.appendLog('metrics reset');  },

  toggleHeavy() {
    this.setData({ heavy: !this.data.heavy });
    this.appendLog(this.data.heavy
      ? 'normalization benchmark enabled (1280x720, every ' + NORMALIZE_EVERY + 'th frame)'
      : 'normalization benchmark disabled');
  },

  // Idempotent mode selection — selecting the active mode is a no-op. Used by
  // the two explicit mode buttons so the PO cannot accidentally toggle away
  // from the shared receive pipeline.
  setMode(mode) {
    if (this.data.mode === mode) return;
    this.resetMetrics();
    this.setData({ mode, receivePipelineError: '' });
    this.appendLog('active mode: ' + mode);
    if (mode === 'receive') this.runReceiveSelfCheck();
    if (mode === 'baseline') this.runBaselineSelfCheck();
  },

  onSelectMode(e) {
    this.setMode(e.currentTarget.dataset.mode);
  },

  // ---- TF-012 r6 speed ladder: declared hold time -------------------------
  // The receiver CANNOT observe the sender's hold timer, so the PO declares it
  // here, exactly matching the sender URL (?holdMs=). Declaring it is not a
  // measurement: only the theoretical rates derive from it, and they are always
  // labelled as declared arithmetic, never as goodput or optical throughput.
  applyHoldMs(raw) {
    if (!opticalCore || typeof opticalCore.clampSingleBaselineHoldMs !== 'function') return;
    const declared = opticalCore.clampSingleBaselineHoldMs(raw, BASELINE_DEFAULT_HOLD_MS);
    const benchmark = typeof opticalCore.singleBaselineBenchmark === 'function'
      ? opticalCore.singleBaselineBenchmark(declared)
      : null;
    this.setData({
      holdMsInput: String(declared),
      holdMsDeclared: declared,
      theoChunkRate: benchmark ? (benchmark.theoreticalChunksPerSecond + ' chunk/s') : '—',
      theoPayloadRate: benchmark
        ? (benchmark.theoreticalPayloadBytesPerSecond + ' B/s · '
          + benchmark.theoreticalPayloadKiBPerSecond + ' KiB/s')
        : '—'
    });
  },

  onHoldMsInput(e) {
    const raw = e && e.detail ? e.detail.value : '';
    if (raw === '' || raw === '-') {
      this.setData({ holdMsInput: raw });
      return;
    }
    this.applyHoldMs(raw);
  },

  onHoldMsPick(e) {
    const ladder = this.data.holdMsLadder || [];
    const index = Number(e && e.detail ? e.detail.value : 0);
    if (!Number.isFinite(index) || index < 0 || index >= ladder.length) return;
    this.applyHoldMs(ladder[index]);
  },

  runBaselineSelfCheck() {
    const problems = [];
    if (!opticalCore) problems.push('optical-core bundle missing');
    else {
      if (typeof opticalCore.SingleCodeBaselineReceiver !== 'function') problems.push('SingleCodeBaselineReceiver not exported');
      if (typeof opticalCore.sha256Hex !== 'function') problems.push('sha256Hex not exported');
      if (typeof opticalCore.acquireOrientation !== 'function') problems.push('acquireOrientation not exported');
    }
    if (!this.baselineReceiver) problems.push('baseline receiver instance unavailable');
    if (problems.length) {
      this.setData({ baselineSelfCheck: 'SELF-CHECK FAIL: ' + problems.join('; ') });
      this.recordError('baseline_selfcheck_failed: ' + problems.join('; '));
    } else {
      this.setData({ baselineSelfCheck: 'SELF-CHECK OK' });
    }
  },

  runReceiveSelfCheck() {
    const problems = [];
    if (!opticalCore) problems.push('optical-core bundle missing');
    else {
      if (typeof opticalCore.SharedOpticalReceiveCore !== 'function') problems.push('SharedOpticalReceiveCore not exported');
      if (typeof opticalCore.sha256Hex !== 'function') problems.push('sha256Hex not exported');
      if (typeof opticalCore.acquireOrientation !== 'function') problems.push('acquireOrientation not exported');
    }
    if (this.data.mode !== 'receive') problems.push('mode is not receive');
    if (problems.length) {
      this.setData({ receiveSelfCheck: 'SELF-CHECK FAIL: ' + problems.join('; ') });
      this.recordError('receive_selfcheck_failed: ' + problems.join('; '));
    } else {
      this.setData({ receiveSelfCheck: 'SELF-CHECK OK' });
    }
  },

  // ---- frame callback ----------------------------------------------------
  onFrame(frame) {
    const now = Date.now();
    this.receivedFrames++;
    this.windowReceived++;
    this.lastFrameAt = now;

    // First frame proves the callback is actually live.
    if (!this.data.callbackActive) {
      this.clearFrameTimeout();
      this.setData({ callbackActive: true });
      this.appendLog('first frame received: ' + frame.width + 'x' + frame.height);
    }

    const width = frame.width;
    const height = frame.height;
    const buffer = frame.data; // ArrayBuffer (RGBA, 4 bytes/px)

    // Batch frame geometry on the instance — the UI tick refreshes these. No
    // per-frame setData (setData is the dominant main-thread UI cost and must
    // stay out of the camera callback hot path).
    this.frameW = width;
    this.frameH = height;
    this.frameBytes = buffer.byteLength;

    if (this.data.mode === 'receive') {
      this.processReceiveFrame(buffer, width, height);
    } else if (this.data.mode === 'baseline') {
      this.processBaselineFrame(buffer, width, height);
    } else {
      this.processBenchmarkFrame(buffer, width, height);
    }
  },

  // Benchmark mode: cheap luma stat every frame + optional normalization.
  processBenchmarkFrame(buffer, width, height) {
    const t0 = Date.now();
    const luma = this.cheapLumaStat(buffer, width, height);
    this.latestLuma = luma;

    if (this.data.heavy && (this.receivedFrames % NORMALIZE_EVERY) === 0) {
      const n0 = Date.now();
      this.downsampleLuma(buffer, width, height, NORMALIZE_W, NORMALIZE_H);
      const nms = Date.now() - n0;
      this.normalizeTimes.push(nms);
      if (this.normalizeTimes.length > PROCESS_TIME_CAP) this.normalizeTimes.shift();
      this.normalizeSamples++;
    }

    const elapsed = Date.now() - t0;
    this.processTimes.push(elapsed);
    if (this.processTimes.length > PROCESS_TIME_CAP) this.processTimes.shift();
    this.processedFrames++;
    this.windowProcessed++;
  },

  // Receive mode: bounded latest-frame pipeline (Phase 2).
  //   CameraFrame callback → bounded slot → SharedOpticalReceiveCore.processFrame.
  // At most ONE frame is actively processing and ONE latest frame is pending.
  // A newer frame overwrites the pending slot while busy (framesReplaced).
  // No unbounded queue is ever built. Payload stays local.
  processReceiveFrame(buffer, width, height) {
    this.receiveFramesReceived++;
    if (!this.receiveCore) {
      this.recordError('receive_core_unavailable');
      return;
    }
    if (this.receiveBusy) {
      // Bounded latest-frame slot: keep only the newest pending frame.
      this.receivePending = { buffer, width, height };
      this.receiveFramesReplaced++;
      return;
    }
    this.receiveBusy = true;
    this.runReceiveFrame({ buffer, width, height });
  },

  runReceiveFrame(entry) {
    const core = this.receiveCore;
    const t0 = Date.now();
    try {
      const frame = { width: entry.width, height: entry.height, data: new Uint8ClampedArray(entry.buffer) };
      const stageBefore = core.stage;
      // Single greedy entry point: cold late join uses the cheap beacon gate,
      // advanced stages run preamble/manifest/dynamic. Manifest/preamble/
      // acquisition frames are routed (or skipped) inside the shared core —
      // the adapter never decodes payload bits itself.
      core.processFrame(frame, RECEIVE_MATRIX);
      const elapsed = Date.now() - t0;
      if (!this.receiveStageTimes[stageBefore]) this.receiveStageTimes[stageBefore] = [];
      this.receiveStageTimes[stageBefore].push(elapsed);
      if (this.receiveStageTimes[stageBefore].length > PROCESS_TIME_CAP) this.receiveStageTimes[stageBefore].shift();
      this.receiveTimes.push(elapsed);
      if (this.receiveTimes.length > PROCESS_TIME_CAP) this.receiveTimes.shift();
      this.receiveFramesProcessed++;
      this.processedFrames++;
      this.windowProcessed++;
      if (core.complete && !this.receiveFinalized) this.finalizeReconstruction();
    } catch (err) {
      this.recordError('receive_failed:' + (err && err.message));
    } finally {
      const next = this.receivePending;
      if (next) {
        this.receivePending = null;
        this.runReceiveFrame(next);
      } else {
        this.receiveBusy = false;
      }
    }
  },

  // ---- TF-012 r4 single-code baseline mode (单码基线) ----------------------
  // ONE large OptiGrid per camera frame. This mode deliberately bypasses the
  // full TF-012 state machine: no cold-join beacon state, no Preamble, no
  // Manifest, no Fountain, no 3-tile logic. Pipeline:
  //   CameraFrame → locate ONE OptiGrid → decode → parse chunk metadata →
  //   validate transfer/file identity → store unique chunk → ignore duplicate.
  // Bounded latest-frame pipeline, identical in shape to receive mode.
  processBaselineFrame(buffer, width, height) {
    this.baselineFramesReceived++;
    if (!this.baselineReceiver) {
      this.recordError('baseline_receiver_unavailable');
      return;
    }
    if (this.baselineBusy) {
      this.baselinePending = { buffer, width, height };
      this.baselineFramesReplaced++;
      return;
    }
    this.baselineBusy = true;
    this.runBaselineFrame({ buffer, width, height });
  },

  // r6 TIMING ACCOUNTING (corrected): the sample ring measures ACTIVE processing
  // only. A frame that arrives after the transfer is complete returns from
  // `ingestFrame` before any pixel work, so its latency is the ignore path, not
  // a decode. Mixing the two collapsed avgProcessMs to ~0.007 ms in r4/r5 and
  // made the metric useless for speed benchmarking. The distinction is decided
  // BEFORE the call (the receiver stage at entry), so the frame that COMPLETES
  // the transfer is still counted as active, and post-completion frames are
  // counted separately.
  runBaselineFrame(entry) {
    const receiver = this.baselineReceiver;
    const t0 = clockMs();
    let active = true;
    try {
      const frame = { width: entry.width, height: entry.height, data: new Uint8ClampedArray(entry.buffer) };
      const stageBefore = receiver.stage;
      active = stageBefore !== 'complete' && stageBefore !== 'reconstructing' && stageBefore !== 'verifying';
      receiver.ingestFrame(frame, BASELINE_MATRIX, clockMs());
      const elapsed = clockMs() - t0;
      if (active) {
        this.baselineTimes.push(elapsed);
        if (this.baselineTimes.length > PROCESS_TIME_CAP) this.baselineTimes.shift();
      } else {
        // Excluded from active latency on purpose — see comment above.
        this.baselinePostCompleteFrames += 1;
      }
      this.baselineFramesProcessed++;
      this.processedFrames++;
      this.windowProcessed++;
      if (receiver.complete && !this.baselineFinalized) this.finalizeBaseline();
    } catch (err) {
      this.recordError('baseline_failed:' + (err && err.message));
    } finally {
      const next = this.baselinePending;
      if (next) {
        this.baselinePending = null;
        this.runBaselineFrame(next);
      } else {
        this.baselineBusy = false;
      }
    }
  },

  // Completion is ALL UNIQUE CHUNKS RECEIVED — never "the last chunk index
  // arrived" (the last missing chunk may be any index). Reconstruction is
  // CONCAT_BY_INDEX truncated to totalFileBytes, then SHA-256 against the
  // digest carried in the chunk metadata. No file is saved in this baseline.
  finalizeBaseline() {
    const receiver = this.baselineReceiver;
    if (!receiver || this.baselineFinalized) return;
    this.baselineFinalized = true;
    let result = null;
    try {
      result = receiver.reconstruct();
    } catch (err) {
      this.recordError('baseline_reconstruct_failed:' + (err && err.message));
      return;
    }
    if (!result) {
      this.recordError('baseline_reconstruct_incomplete:' + receiver.receivedUniqueCount + '/' + receiver.totalChunks);
      return;
    }
    this.baselineResult = result;
    const preview = opticalCore.singleBaselinePreviewText(result.bytes, 6);
    this.setData({
      baselineStatus: result.match ? 'COMPLETE / 完成' : 'ERROR / 错误',
      baselineReconstructionStatus: 'RECONSTRUCTED ' + result.bytes.length + ' B',
      baselineReconstructMs: result.reconstructMs + ' ms',
      baselineShaMs: result.shaMs + ' ms',
      baselineShaStatus: result.match ? 'MATCH' : 'MISMATCH',
      baselineContentPreview: preview.head + '\n· · ·\n' + preview.tail,
      baselinePreviewLines: preview.lines
    });
    this.appendLog('baseline reconstruction ' + (result.match ? 'SHA MATCH' : 'SHA MISMATCH') + ' · ' + result.bytes.length + ' bytes');
  },

  // Reconstruction complete: compute the local SHA-256 and write the file.
  finalizeReconstruction() {
    const core = this.receiveCore;
    if (!core || this.receiveFinalized) return;
    this.receiveFinalized = true;
    let bytes;
    try {
      const r0 = Date.now();
      bytes = core.reconstruct();
      this.reconstructMs = Date.now() - r0;
    } catch (err) {
      this.recordError('reconstruct_failed:' + (err && err.message));
      return;
    }
    if (!bytes) {
      this.recordError('reconstruct_incomplete:' + core.solvedCount + '/' + core.sourceCount);
      return;
    }
    const s0 = Date.now();
    const reconstructedSha = opticalCore.sha256Hex(bytes);
    this.shaMs = Date.now() - s0;
    const manifestSha = core.manifest && core.manifest.file ? core.manifest.file.sha256 : null;
    const match = manifestSha !== null && reconstructedSha === manifestSha;
    this.setData({
      reconstructionStatus: 'RECONSTRUCTED ' + bytes.length + ' B',
      reconstructionMs: this.reconstructMs + ' ms',
      shaMs: this.shaMs + ' ms',
      shaStatus: match ? 'MATCH' : (manifestSha === null ? 'NO MANIFEST SHA' : 'MISMATCH'),
      manifestFileSize: core.manifest ? (core.manifest.file.byteLength + ' B') : '—'
    });
    this.writeReconstructedFile(bytes, reconstructedSha, match);
  },

  writeReconstructedFile(bytes, sha, match) {
    try {
      const fs = wx.getFileSystemManager();
      const path = wx.env.USER_DATA_PATH + '/tf012-reconstructed-' + (match ? 'match' : 'mismatch') + '.bin';
      const data = bytes.slice().buffer;
      const w0 = Date.now();
      fs.writeFile({
        filePath: path,
        data,
        success: () => {
          this.fileWriteMs = Date.now() - w0;
          this.setData({ localFilePath: path, fileWriteMs: this.fileWriteMs + ' ms' });
          this.appendLog('reconstructed file written: ' + path + ' sha=' + sha);
        },
        fail: (err) => this.recordError('write_file_failed:' + (err && err.errMsg ? err.errMsg : JSON.stringify(err)))
      });
    } catch (err) {
      this.recordError('file_write_unavailable:' + (err && err.message));
    }
  },

  // Persist the active incomplete session as a checkpoint (bounded, not per frame).
  persistCheckpoint() {
    const core = this.receiveCore;
    if (!core || core.complete || !core.manifest) return;
    const cp = core.exportCheckpoint();
    if (!cp) return;
    const ok = storageAdapter.save(CHECKPOINT_KEY, JSON.stringify(cp));
    if (ok) this.appendLog('checkpoint saved: ' + cp.solvedCount + '/' + cp.totalBlocks);
  },

  // Restore an incomplete session from storage on cold start.
  restorePersistedCheckpoint() {
    const raw = storageAdapter.load(CHECKPOINT_KEY);
    if (!raw) return;
    let cp;
    try { cp = JSON.parse(raw); } catch (err) { storageAdapter.remove(CHECKPOINT_KEY); return; }
    if (!cp || cp.version !== 1) { storageAdapter.remove(CHECKPOINT_KEY); return; }
    if (this.receiveCore && this.receiveCore.restoreCheckpoint(cp)) {
      this.appendLog('checkpoint restored: ' + cp.solvedCount + '/' + cp.totalBlocks);
    } else {
      storageAdapter.remove(CHECKPOINT_KEY);
    }
  },

  // ---- periodic tick -----------------------------------------------------
  onTick() {
    if (this.data.frozen) return;

    // Watchdog: camera started but no frame arrived.
    if (this.data.running && !this.data.callbackActive && this.startedAt) {
      if (Date.now() - this.startedAt >= FRAME_TIMEOUT_MS) {
        this.recordError('no_camera_frame_within_' + (FRAME_TIMEOUT_MS / 1000) + 's');
        this.appendLog('WARNING: no camera frame received within ' + (FRAME_TIMEOUT_MS / 1000) + 's');
      }
    }

    if (this.data.mode === 'receive') {
      this.onReceiveTick();
    } else if (this.data.mode === 'baseline') {
      this.onBaselineTick();
    } else {
      this.onBenchmarkTick();
    }

    // Rotate the FPS window.
    this.windowStartAt = Date.now();
    this.windowReceived = 0;
    this.windowProcessed = 0;
  },

  onBenchmarkTick() {
    const elapsed = Math.max(1, Date.now() - this.windowStartAt);
    const seconds = elapsed / 1000;

    const callbackFps = (this.windowReceived / seconds).toFixed(1);
    const processingFps = (this.windowProcessed / seconds).toFixed(1);
    const skipped = Math.max(0, this.receivedFrames - this.processedFrames);
    const skipRatio = this.receivedFrames
      ? ((skipped / this.receivedFrames) * 100).toFixed(1) + '%'
      : '0.0%';

    const avgProcessMs = this.percentileFormat(this.processTimes, 'avg');
    const p95ProcessMs = this.percentile(this.processTimes, 0.95);

    const bufferBytes = this.frameBytes || 0;
    const ingressMBps = ((bufferBytes * Number(callbackFps)) / 1e6).toFixed(3);

    const patch = {
      callbackFps,
      processingFps,
      totalReceived: this.receivedFrames,
      processed: this.processedFrames,
      skipped,
      skipRatio,
      avgProcessMs,
      p95ProcessMs: p95ProcessMs != null ? p95ProcessMs.toFixed(2) + ' ms' : '—',
      ingressMBps
    };

    if (this.latestLuma) {
      patch.meanLuma = this.latestLuma.mean.toFixed(1);
      patch.minLuma = this.latestLuma.min.toFixed(1);
      patch.maxLuma = this.latestLuma.max.toFixed(1);
      patch.contrastRange = this.latestLuma.range.toFixed(1);
    }

    if (this.data.heavy && this.normalizeTimes.length) {
      const avg = this.normalizeTimes.reduce((a, b) => a + b, 0) / this.normalizeTimes.length;
      const p95 = this.percentile(this.normalizeTimes, 0.95);
      patch.normalizeAvgMs = avg.toFixed(2) + ' ms';
      patch.normalizeP95Ms = p95 != null ? p95.toFixed(2) + ' ms' : '—';
      patch.normalizeFps = avg > 0 ? (1000 / avg).toFixed(1) : '0.0';
      patch.normalizeSamples = this.normalizeSamples;
    }

    this.setData(patch);
  },

  onReceiveTick() {
    const elapsed = Math.max(1, Date.now() - this.windowStartAt);
    const seconds = elapsed / 1000;

    const callbackFps = (this.windowReceived / seconds).toFixed(1);
    const processingFps = (this.windowProcessed / seconds).toFixed(1);
    const skipped = Math.max(0, this.receiveFramesReceived - this.receiveFramesProcessed);
    const skipRatio = this.receiveFramesReceived
      ? ((skipped / this.receiveFramesReceived) * 100).toFixed(1) + '%'
      : '0.0%';
    const avgMs = this.receiveTimes.length
      ? (this.receiveTimes.reduce((a, b) => a + b, 0) / this.receiveTimes.length).toFixed(2) + ' ms'
      : '—';
    const p95 = this.percentile(this.receiveTimes, 0.95);
    const bufferBytes = this.frameBytes || 0;
    const ingressMBps = ((bufferBytes * Number(callbackFps)) / 1e6).toFixed(3);
    const core = this.receiveCore;
    const productStage = core
      ? (core.complete ? 'Verifying SHA-256' : core.stage === 'receiving' ? 'Receiving' : core.stage === 'idle' ? 'Waiting for transfer' : 'Detecting')
      : 'Waiting for transfer';

    const patch = {
      callbackFps,
      processingFps,
      totalReceived: this.receivedFrames,
      processed: this.processedFrames,
      skipped,
      skipRatio,
      replaced: this.receiveFramesReplaced,
      avgProcessMs: avgMs,
      p95ProcessMs: p95 != null ? p95.toFixed(2) + ' ms' : '—',
      ingressMBps,
      productStage,
      receiveStage: core ? core.stage.toUpperCase() : 'UNAVAILABLE',
      frameWidth: this.frameW,
      frameHeight: this.frameH,
      frameBufferBytes: this.frameBytes,
      frameFormat: this.frameBytes ? 'RGBA (4 bytes/px)' : '—',
      decodedSymbols: core ? core.stats.decodedSymbols : 0,
      duplicates: core ? core.stats.duplicateSymbols : 0,
      redundant: core ? core.stats.redundantSymbols : 0,
      rejected: core ? core.stats.rejectedFrames : 0,
      beaconDetections: core ? core.eventCounts.beaconProbes : 0,
      orientationAttempts: core ? core.eventCounts.orientationAttempts : 0,
      orientationSuccess: core ? core.eventCounts.orientationSuccess : 0,
      manifestAcquisitions: core ? core.eventCounts.manifestAcquisitions : 0,
      preambleAttempts: core ? core.eventCounts.preambleAttempts : 0,
      preambleSuccess: core ? core.eventCounts.preambleSuccess : 0,
      preambleRejected: core ? core.eventCounts.preambleRejectedOrSkipped : 0,
      lastStageTransition: core ? core.lastStageTransition : '—',
      lastStageTransitionAt: core && core.lastStageTransitionAt ? new Date(core.lastStageTransitionAt).toLocaleTimeString() : '—',
      solvedBlocks: core ? (core.solvedCount + ' / ' + core.sourceCount) : '—',
      totalBlocks: core ? core.sourceCount : '—'
    };

    if (core && core.orientation && core.orientation.best) {
      const best = core.orientation.best;
      patch.receiveSelectedTransform = core.normalizedMode || '—';
      patch.receiveTripletValid = best.tripletValid ? 'true' : 'false';
      patch.receiveSupport = best.locatorSupport;
      patch.receiveExactTiles = best.exactTiles + ' / 3';
      patch.tileStatus = best.tiles.map(t =>
        'tile ' + t.tile + ': ' + (t.acquired ? (t.exact ? 'exact' : 'err ' + t.bitErrors) : 'miss')
      );
    }

    if (core && core.manifest) {
      patch.manifestStatus = 'RECOVERED';
      patch.manifestFileSize = core.manifest.file.byteLength + ' B';
      patch.fileName = core.manifest.file.name;
    }

    // Bounded checkpoint cadence (every CHECKPOINT_EVERY_TICKS ticks, not per frame).
    this.checkpointTick += 1;
    if (this.checkpointTick >= CHECKPOINT_EVERY_TICKS) {
      this.checkpointTick = 0;
      this.persistCheckpoint();
    }

    patch.receivePipelineError = (this.data.running && this.receiveFramesReceived > 4 && this.receiveFramesProcessed === 0)
      ? 'ERROR: RECEIVE PIPELINE NOT RUNNING'
      : '';

    this.setData(patch);
  },

  // Live single-code baseline panel. Every value here is measured by the
  // platform-neutral baseline receiver — the adapter never decodes payload
  // bits, never talks to the sender and never reads a sender-side oracle.
  onBaselineTick() {
    const elapsed = Math.max(1, Date.now() - this.windowStartAt);
    const seconds = elapsed / 1000;
    const callbackFps = (this.windowReceived / seconds).toFixed(1);
    const processingFps = (this.windowProcessed / seconds).toFixed(1);
    const skipped = Math.max(0, this.baselineFramesReceived - this.baselineFramesProcessed);
    const activeStats = this.baselineActiveStats();
    const avgMs = activeStats.avg != null ? activeStats.avg.toFixed(2) + ' ms' : '—';
    const receiver = this.baselineReceiver;
    const metrics = receiver ? receiver.metrics : null;
    const total = receiver && receiver.totalChunks ? receiver.totalChunks : BASELINE_TOTAL_CHUNKS;
    const missing = receiver ? receiver.missingIndices() : [];
    const netGoodput = this.baselineNetGoodputMetrics(receiver, this.baselineResult);
    const efficiency = this.baselineEfficiencyMetrics(receiver);

    this.setData({
      callbackFps,
      processingFps,
      totalReceived: this.receivedFrames,
      processed: this.processedFrames,
      skipped,
      skipRatio: this.baselineFramesReceived ? ((skipped / this.baselineFramesReceived) * 100).toFixed(1) + '%' : '0.0%',
      replaced: this.baselineFramesReplaced,
      avgProcessMs: avgMs,
      activeProcessAvgMs: activeStats.avg != null ? activeStats.avg.toFixed(3) + ' ms' : '—',
      activeProcessP50Ms: activeStats.p50 != null ? activeStats.p50.toFixed(3) + ' ms' : '—',
      activeProcessP95Ms: activeStats.p95 != null ? activeStats.p95.toFixed(3) + ' ms' : '—',
      activeProcessMaxMs: activeStats.max != null ? activeStats.max.toFixed(3) + ' ms' : '—',
      activeProcessSamples: activeStats.count,
      postCompleteFrames: this.baselinePostCompleteFrames,
      clockSource: CLOCK_SOURCE,
      netGoodputText: netGoodput
        ? (netGoodput.bytesPerSecond + ' B/s · ' + netGoodput.kibPerSecond + ' KiB/s')
        : 'null (needs 16/16 + SHA MATCH)',
      theoreticalCameraFramesPerCode: efficiency.theoreticalCameraFramesPerCode != null
        ? String(efficiency.theoreticalCameraFramesPerCode)
        : '—',
      decodeSuccessRatio: this.ratioText(efficiency.decodeSuccessRatio),
      crcFailureRatio: this.ratioText(efficiency.crcFailureRatio),
      locateFailureRatio: this.ratioText(efficiency.locateFailureRatio),
      newUniqueChunkYield: this.ratioText(efficiency.newUniqueChunkYield),
      duplicateRatio: this.ratioText(efficiency.duplicateRatio),
      frameWidth: this.frameW,
      frameHeight: this.frameH,
      frameBufferBytes: this.frameBytes,
      frameFormat: this.frameBytes ? 'RGBA (4 bytes/px)' : '—',
      baselineFrameInfo: this.frameW ? (this.frameW + ' × ' + this.frameH) : '—',
      baselineElapsed: this.baselineStartAt ? ((Date.now() - this.baselineStartAt) / 1000).toFixed(1) + ' s' : '—',
      baselineStatus: this.baselineStatusText(receiver),
      baselineReceivedChunks: receiver ? (receiver.receivedUniqueCount + ' / ' + total) : '0 / ' + BASELINE_TOTAL_CHUNKS,
      baselineMissingChunks: missing.length ? '[' + missing.join(', ') + ']' : 'none',
      baselineDuplicates: metrics ? metrics.duplicateChunks : 0,
      baselineLastChunk: metrics && metrics.lastChunkIndex >= 0 ? String(metrics.lastChunkIndex) : '—',
      baselineDecodeAttempts: metrics ? metrics.decodeAttempts : 0,
      baselineDecodeSuccess: metrics ? metrics.decodeSuccess : 0,
      baselineCrcFailures: metrics ? metrics.crcFailures : 0,
      baselineLocateFailures: metrics ? metrics.locateFailures : 0,
      baselineForeignRejects: metrics ? metrics.foreignChunkRejects : 0,
      baselineMetadataRejects: metrics ? metrics.metadataRejects : 0,
      baselineCodeWidth: metrics && metrics.codeWidthPx ? metrics.codeWidthPx.toFixed(0) + ' px' : '—',
      baselinePixPerCell: metrics && metrics.pixPerCellX
        ? metrics.pixPerCellX.toFixed(2) + ' / ' + metrics.pixPerCellY.toFixed(2)
        : '—',
      baselineReservedScore: metrics && metrics.reservedScore ? (metrics.reservedScore * 100).toFixed(1) + '%' : '—',
      baselineRotation: metrics ? String(metrics.rotation) : '—',
      baselineContrast: metrics && metrics.contrast ? metrics.contrast.toFixed(1) : '—',
      baselineFirstChunkMs: metrics && metrics.firstChunkMs >= 0 ? metrics.firstChunkMs + ' ms' : '—',
      baselineAllChunksMs: metrics && metrics.allChunksMs >= 0 ? metrics.allChunksMs + ' ms' : '—',
      baselineFileId: receiver && receiver.activeFileId !== null
        ? '0x' + (receiver.activeFileId >>> 0).toString(16).padStart(8, '0')
        : '—',
      baselineFileName: receiver && receiver.fileName ? receiver.fileName : '—',
      baselineFileSize: receiver && receiver.totalFileBytes ? receiver.totalFileBytes + ' B' : '—',
      baselineReconstructMethod: receiver && receiver.reconstructionMethod ? receiver.reconstructionMethod : '—',
      g7aPass: metrics ? (metrics.g7aPassCount > 0 ? 'PASS' : (metrics.regionRejection ? 'FAIL' : '—')) : '—',
      g7aCount: metrics ? (metrics.g7aPassCount + ' / ' + metrics.g7FramesAnalysed) : '0 / 0',
      g7aLuma: metrics
        ? ('min ' + metrics.regionLumaMin.toFixed(0) + ' · max ' + metrics.regionLumaMax.toFixed(0)
          + ' · mean ' + metrics.regionLumaMean.toFixed(0))
        : '—',
      g7aContrast: metrics ? metrics.regionContrast.toFixed(1) : '—',
      g7aThreshold: metrics ? metrics.regionThreshold.toFixed(1) : '—',
      g7aDarkRatio: metrics ? (metrics.regionDarkPixelRatio * 100).toFixed(2) + '%' : '—',
      g7aLocalVariation: metrics ? (metrics.regionLocalVariationRatio * 100).toFixed(2) + '%' : '—',
      g7aChannels: metrics
        ? ('R' + metrics.regionChannelMeanR.toFixed(0) + ' G' + metrics.regionChannelMeanG.toFixed(0)
          + ' B' + metrics.regionChannelMeanB.toFixed(0) + ' A' + metrics.regionChannelMeanA.toFixed(0))
        : '—',
      g7aComponents: metrics ? String(metrics.regionComponentCount) : '—',
      g7aCandidates: metrics ? String(metrics.regionCandidateCount) : '—',
      g7aCandidateSpans: metrics && metrics.regionCandidateSpansPx ? metrics.regionCandidateSpansPx : '—',
      g7aLargestBox: metrics
        ? ('x' + metrics.regionLargestX.toFixed(0) + ' y' + metrics.regionLargestY.toFixed(0)
          + ' ' + metrics.regionLargestWidth.toFixed(0) + '×' + metrics.regionLargestHeight.toFixed(0)
          + ' area' + metrics.regionLargestArea + ' fill' + metrics.regionLargestFillRatio.toFixed(2)
          + ' aspect' + metrics.regionLargestAspect.toFixed(2))
        : '—',
      g7aBrightRegion: metrics
        ? ((metrics.regionCandidateSpansPx || '').indexOf('bright-subregion') >= 0 ? 'used' : 'not used')
        : '—',
      g7aRejection: metrics && metrics.regionRejection ? metrics.regionRejection : 'none',
      g7bPass: metrics ? (metrics.g7bPass ? 'PASS' : 'FAIL') : '—',
      g7bReason: metrics && metrics.g7bReason ? metrics.g7bReason : (metrics && metrics.g7bPass ? 'ok' : '—'),
      g7cPass: metrics ? (metrics.g7cPass ? 'PASS' : 'FAIL') : '—',
      g7cSeeds: metrics ? String(metrics.seedCount) : '—',
      g7cBestSeed: metrics ? metrics.seedBestScore.toFixed(3) + ' (rot ' + metrics.seedBestRotation + ')' : '—',
      g7cRefined: metrics ? String(metrics.refinementCount) : '—',
      g7cBestRefined: metrics
        ? (metrics.refinementBestScore.toFixed(3) + ' (rot ' + metrics.refinementBestRotation + ')')
        : '—',
      g7cGeometry: metrics
        ? (metrics.refinementBestPixPerCell.toFixed(2) + ' px/cell · phase '
          + metrics.refinementBestPhaseX.toFixed(2) + '/' + metrics.refinementBestPhaseY.toFixed(2))
        : '—',
      g7cReason: metrics && metrics.g7cReason ? metrics.g7cReason : (metrics && metrics.g7cPass ? 'ok' : '—'),
      g7dPass: metrics ? (metrics.g7dPass ? 'PASS' : 'FAIL') : '—',
      g7dCrc: metrics
        ? ('attempts ' + metrics.crcDecodeAttempts + ' · ok ' + metrics.crcSuccess + ' · fail ' + metrics.crcFailure)
        : '—',
      g7dSequence: metrics && metrics.decodedSequence >= 0 ? '0x' + (metrics.decodedSequence >>> 0).toString(16) : '—',
      g7dChunkIndex: metrics && metrics.decodedChunkIndex >= 0 ? String(metrics.decodedChunkIndex) : '—',
      g7Stage: metrics ? metrics.locatorStage : '—',
      g7StageReason: metrics && metrics.locatorStageReason ? metrics.locatorStageReason : '—',
      baselinePipelineError: (this.data.running && this.baselineFramesReceived > 4 && this.baselineFramesProcessed === 0)
        ? 'ERROR: BASELINE PIPELINE NOT RUNNING'
        : ''
    });
  },

  baselineStatusText(receiver) {
    if (!receiver || receiver.activeFileId === null) return 'WAITING / 等待';
    if (receiver.stage === 'error') return 'ERROR / 错误';
    if (receiver.stage === 'complete') return 'COMPLETE / 完成';
    if (receiver.stage === 'verifying') return 'VERIFYING / 校验中';
    if (receiver.stage === 'reconstructing') return 'RECONSTRUCTING / 重构中';
    return 'RECEIVING / 接收中';
  },

  // ---- freeze / copy -----------------------------------------------------
  freezeResult() {    this.clearFrameTimeout();
    this.stopCamera();

    const result = this.buildResultPayload();
    const text = JSON.stringify(result, null, 2);

    this.setData({
      frozen: true,
      frozenAt: new Date().toLocaleString(),
      frozenResult: text
    });
    this.appendLog('test result frozen');
  },

  copyResult() {
    if (!this.data.frozenResult) {
      wx.showToast({ title: 'No frozen result', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.frozenResult,
      success: () => wx.showToast({ title: 'Copied', icon: 'success' }),
      fail: () => wx.showToast({ title: 'Copy failed', icon: 'none' })
    });
  },

  buildResultPayload() {
    if (this.data.mode === 'receive') return this.buildReceiveResultPayload();
    if (this.data.mode === 'baseline') return this.buildBaselineResultPayload();
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const callbackFps = elapsedMs > 0 ? (this.receivedFrames / (elapsedMs / 1000)).toFixed(2) : '0.00';
    const processingFps = elapsedMs > 0 ? (this.processedFrames / (elapsedMs / 1000)).toFixed(2) : '0.00';
    const skipped = Math.max(0, this.receivedFrames - this.processedFrames);
    const skipRatio = this.receivedFrames ? ((skipped / this.receivedFrames) * 100).toFixed(2) + '%' : '0.00%';
    const avgProcessMs = this.percentileFormat(this.processTimes, 'avg');
    const p95ProcessMs = this.percentile(this.processTimes, 0.95);
    const bufferBytes = this.data.frameBufferBytes || 0;
    const ingressMBps = ((bufferBytes * Number(callbackFps)) / 1e6).toFixed(4);

    const normalize = this.data.heavy && this.normalizeTimes.length
      ? {
          enabled: true,
          target: NORMALIZE_W + 'x' + NORMALIZE_H,
          samples: this.normalizeSamples,
          averageMs: (this.normalizeTimes.reduce((a, b) => a + b, 0) / this.normalizeTimes.length).toFixed(3),
          p95Ms: this.percentile(this.normalizeTimes, 0.95) != null
            ? this.percentile(this.normalizeTimes, 0.95).toFixed(3)
            : null,
          effectiveFps: (1000 / (this.normalizeTimes.reduce((a, b) => a + b, 0) / this.normalizeTimes.length)).toFixed(1)
        }
      : { enabled: false };

    return {
      evidenceClass: 'PHYSICAL MINI PROGRAM CAMERA-FRAME POC',
      buildId: this.data.buildId,
      appMode: this.data.mode,
      note: 'Feasibility spike only. NOT TF-007H PASS / Manifest PASS / throughput PASS / Net Goodput.',
      networkPayloadPath: 'NONE',
      timestamp: new Date().toISOString(),
      testDurationMs: elapsedMs,
      device: {
        model: this.data.model,
        brand: this.data.brand,
        system: this.data.system,
        platform: this.data.platform,
        pixelRatio: this.data.pixelRatio,
        screenSize: this.data.screenSize,
        wechatVersion: this.data.wechatVersion,
        baseLibVersion: this.data.baseLibVersion,
        sdkVersion: this.data.sdkVersion
      },
      camera: {
        frameWidth: this.data.frameWidth,
        frameHeight: this.data.frameHeight,
        frameBufferBytes: this.data.frameBufferBytes,
        frameFormat: this.data.frameFormat,
        maxZoom: this.data.maxZoom,
        permissionStatus: this.data.permissionStatus
      },
      metrics: {
        callbackFps: Number(callbackFps),
        processingFps: Number(processingFps),
        totalReceivedFrames: this.receivedFrames,
        processedFrames: this.processedFrames,
        skippedFrames: skipped,
        skipRatio,
        avgProcessMs,
        p95ProcessMs: p95ProcessMs != null ? p95ProcessMs.toFixed(3) : null,
        ingressMBps: Number(ingressMBps)
      },
      luminance: this.latestLuma
        ? {
            mean: Number(this.latestLuma.mean.toFixed(2)),
            min: Number(this.latestLuma.min.toFixed(2)),
            max: Number(this.latestLuma.max.toFixed(2)),
            contrastRange: Number(this.latestLuma.range.toFixed(2))
          }
        : null,
      normalization: normalize,
      errors: this.data.errors
    };
  },

  /**
   * TF-012 r6 single-code baseline frozen result.
   *
   * This is the JSON the PO copies back after a REAL PHONE run and it is the
   * ONLY place a speed-ladder result may be declared PASS. Evidence class is
   * explicitly NOT Net Goodput-by-default and NOT G0.
   *
   * r6 structure (the three quantities that must never be conflated):
   *   benchmark  — DECLARED sender-side arithmetic (holdMs → theoretical rates).
   *                A rate here is NOT a measurement and NOT a PASS.
   *   physical   — what the phone actually did (frames, decodes, failures, px/cell).
   *   completion — reconstruction + SHA-256 verdict, and the ONLY gate for
   *                exploratoryNetGoodput* (null unless 16/16 unique + MATCH).
   */
  buildBaselineResultPayload() {
    const receiver = this.baselineReceiver;
    const metrics = receiver ? receiver.metrics : null;
    const elapsedMs = this.baselineStartAt ? Date.now() - this.baselineStartAt : 0;
    // r6 fix: FPS must use the BASELINE frame counters. `this.receivedFrames` is
    // a global counter shared by every mode, so dividing it by a baseline-only
    // elapsed window reported an inflated callback FPS.
    const callbackFps = elapsedMs > 0 ? (this.baselineFramesReceived / (elapsedMs / 1000)).toFixed(2) : '0.00';
    const processingFps = elapsedMs > 0 ? (this.baselineFramesProcessed / (elapsedMs / 1000)).toFixed(2) : '0.00';
    const activeStats = this.baselineActiveStats();
    const missing = receiver ? receiver.missingIndices() : [];
    const reconstruction = this.baselineResult;
    const uniqueReceived = receiver ? receiver.receivedUniqueCount : 0;
    const totalChunks = receiver && receiver.totalChunks ? receiver.totalChunks : BASELINE_TOTAL_CHUNKS;
    const shaResult = reconstruction ? (reconstruction.match ? 'MATCH' : 'MISMATCH') : this.data.baselineShaStatus;
    const pass = shaResult === 'MATCH'
      && uniqueReceived === totalChunks
      && totalChunks === BASELINE_TOTAL_CHUNKS
      && reconstruction
      && reconstruction.bytes.length === BASELINE_FILE_BYTES
      && missing.length === 0;
    const netGoodput = this.baselineNetGoodputMetrics(receiver, reconstruction);
    const efficiency = this.baselineEfficiencyMetrics(receiver);
    const declaredHoldMs = this.data.holdMsDeclared;
    const benchmark = (opticalCore && typeof opticalCore.singleBaselineBenchmark === 'function')
      ? opticalCore.singleBaselineBenchmark(declaredHoldMs)
      : null;
    const timeToAllChunksMs = metrics && metrics.allChunksMs >= 0 ? metrics.allChunksMs : null;
    const timeToFirstValidChunkMs = metrics && metrics.firstChunkMs >= 0 ? metrics.firstChunkMs : null;

    return {
      evidenceClass: 'PHYSICAL SINGLE-CODE FILE TRANSFER BASELINE · SPEED LADDER',
      note: 'Single-Code Baseline 单码基线 speed ladder (TF-012 r6). A 10 KiB exploratory physical benchmark only — NOT Net Goodput by default, NOT G0, NOT optical throughput.',
      buildId: this.data.buildId,
      appMode: this.data.mode,
      modeLabel: 'Single-Code Baseline / 单码基线',
      networkPayloadPath: 'NONE',
      timestamp: new Date().toISOString(),
      testDurationMs: elapsedMs,
      reconstructionMethod: receiver ? receiver.reconstructionMethod : null,
      passDefinition: 'uniqueReceived == totalChunks == 16 AND missing == [] AND reconstructedBytes == 10240 AND shaResult == MATCH',
      // ---- 1. DECLARED sender-side arithmetic — NOT a measurement ----
      benchmark: {
        holdMs: benchmark ? benchmark.holdMs : declaredHoldMs,
        holdMsSource: 'declared (must equal the sender URL ?holdMs=)',
        theoreticalChunksPerSecond: benchmark ? benchmark.theoreticalChunksPerSecond : null,
        theoreticalPayloadBytesPerSecond: benchmark ? benchmark.theoreticalPayloadBytesPerSecond : null,
        theoreticalPayloadKiBPerSecond: benchmark ? benchmark.theoreticalPayloadKiBPerSecond : null,
        chunkDataBytes: receiver && receiver.chunkDataBytes ? receiver.chunkDataBytes : null,
        totalChunks,
        matrixSize: BASELINE_MATRIX,
        warning: 'Theoretical gross file-payload rate = chunkDataBytes / holdMs. Declared arithmetic only. NOT a measurement, NOT Net Goodput, NOT optical throughput.'
      },
      // ---- 2. MEASURED physical decode metrics ----
      physical: {
        timeToFirstValidChunkMs,
        timeToAllChunksMs,
        // Informational: the steady-state window that excludes the PO's aiming
        // time. NOT used for exploratoryNetGoodput (which uses timeToAllChunksMs).
        timeFromFirstChunkToAllChunksMs: (timeToAllChunksMs !== null && timeToFirstValidChunkMs !== null)
          ? timeToAllChunksMs - timeToFirstValidChunkMs
          : null,
        cameraFrames: metrics ? metrics.cameraFrames : 0,
        decodeAttempts: metrics ? metrics.decodeAttempts : 0,
        successfulDecodes: metrics ? metrics.decodeSuccess : 0,
        locateFailures: metrics ? metrics.locateFailures : 0,
        crcFailures: metrics ? metrics.crcFailures : 0,
        metadataRejects: metrics ? metrics.metadataRejects : 0,
        foreignChunkRejects: metrics ? metrics.foreignChunkRejects : 0,
        duplicates: metrics ? metrics.duplicateChunks : 0,
        uniqueReceived,
        callbackFps: Number(callbackFps),
        processingFps: Number(processingFps),
        observedCodeWidthPx: metrics ? Number(metrics.codeWidthPx.toFixed(2)) : null,
        observedCodeHeightPx: metrics ? Number(metrics.codeHeightPx.toFixed(2)) : null,
        pixelsPerCellX: metrics ? Number(metrics.pixPerCellX.toFixed(3)) : null,
        pixelsPerCellY: metrics ? Number(metrics.pixPerCellY.toFixed(3)) : null,
        reservedPatternScore: metrics ? Number(metrics.reservedScore.toFixed(4)) : null,
        binarisationThreshold: metrics ? Number(metrics.threshold.toFixed(2)) : null,
        contrast: metrics ? Number(metrics.contrast.toFixed(2)) : null,
        frameRotationIndex: metrics ? metrics.rotation : null,
        postCompleteFrames: metrics ? metrics.postCompleteFrames : this.baselinePostCompleteFrames,
        postCompleteFramesIgnoredByAdapter: this.baselinePostCompleteFrames
      },
      // ---- 3. COMPLETION + the only gateway to a goodput number ----
      completion: {
        reconstructedBytes: reconstruction ? reconstruction.bytes.length : null,
        shaResult,
        sha256: reconstruction ? reconstruction.sha256Hex : null,
        expectedSha256: reconstruction ? reconstruction.expectedSha256 : null,
        missing,
        reconstructionStatus: this.data.baselineReconstructionStatus,
        reconstructMs: reconstruction ? reconstruction.reconstructMs : null,
        shaMs: reconstruction ? reconstruction.shaMs : null,
        previewLines: this.data.baselinePreviewLines,
        preview: this.data.baselineContentPreview
      },
      // null unless completion proves 16/16 unique + exact SHA-256 MATCH.
      exploratoryNetGoodputBytesPerSecond: netGoodput ? netGoodput.bytesPerSecond : null,
      exploratoryNetGoodputKiBPerSecond: netGoodput ? netGoodput.kibPerSecond : null,
      exploratoryNetGoodputFormula: 'reconstructedBytes / (timeToAllChunksMs / 1000) — null unless 16/16 unique + SHA-256 MATCH',
      // ---- 4. DIAGNOSTIC efficiency metrics (rank PASSing points only) ----
      // These never decide PASS. newUniqueChunkYield is the key one: per-frame
      // decoder correctness and whole-file collection efficiency are different
      // things, and Stage A showed many duplicate decodes before 16/16.
      efficiency: {
        theoreticalCameraFramesPerCode: efficiency.theoreticalCameraFramesPerCode,
        theoreticalCameraFramesPerCodeFormula: 'callbackFps × holdMs / 1000',
        theoreticalCameraFramesPerCodeLabel: 'Theoretical CameraFrame opportunities per code / 每码理论相机采样机会',
        decodeSuccessRatio: efficiency.decodeSuccessRatio,
        crcFailureRatio: efficiency.crcFailureRatio,
        locateFailureRatio: efficiency.locateFailureRatio,
        newUniqueChunkYield: efficiency.newUniqueChunkYield,
        duplicateRatio: efficiency.duplicateRatio,
        disclaimer: 'Diagnostic metrics for ranking PASSing speed points. They are NOT the PASS condition and MUST NOT be read as decode opportunities.'
      },
      pass,
      transfer: {
        fileId: receiver && receiver.activeFileId !== null
          ? '0x' + (receiver.activeFileId >>> 0).toString(16).padStart(8, '0')
          : null,
        fileName: receiver ? receiver.fileName : null,
        fileBytes: receiver ? receiver.totalFileBytes : null,
        totalChunks: receiver ? receiver.totalChunks : null,
        chunkDataBytes: receiver ? receiver.chunkDataBytes : null,
        fileSha256: receiver ? receiver.fileSha256 : null
      },
      chunks: {
        uniqueReceived,
        missing: missing,
        duplicates: metrics ? metrics.duplicateChunks : 0,
        lastChunkIndex: metrics ? metrics.lastChunkIndex : -1,
        foreignChunkRejects: metrics ? metrics.foreignChunkRejects : 0,
        metadataRejects: metrics ? metrics.metadataRejects : 0,
        postCompleteFrames: metrics ? metrics.postCompleteFrames : 0
      },
      camera: {
        frameWidth: this.data.frameWidth,
        frameHeight: this.data.frameHeight,
        frameBufferBytes: this.data.frameBufferBytes,
        frameFormat: this.data.frameFormat,
        observedCodeWidthPx: metrics ? Number(metrics.codeWidthPx.toFixed(2)) : null,
        observedCodeHeightPx: metrics ? Number(metrics.codeHeightPx.toFixed(2)) : null,
        matrixSize: BASELINE_MATRIX,
        estimatedPixelsPerCellX: metrics ? Number(metrics.pixPerCellX.toFixed(3)) : null,
        estimatedPixelsPerCellY: metrics ? Number(metrics.pixPerCellY.toFixed(3)) : null,
        reservedPatternScore: metrics ? Number(metrics.reservedScore.toFixed(4)) : null,
        binarisationThreshold: metrics ? Number(metrics.threshold.toFixed(2)) : null,
        contrast: metrics ? Number(metrics.contrast.toFixed(2)) : null,
        frameRotationIndex: metrics ? metrics.rotation : null
      },
      decoding: {
        cameraFrames: metrics ? metrics.cameraFrames : 0,
        decodeAttempts: metrics ? metrics.decodeAttempts : 0,
        successfulDecodes: metrics ? metrics.decodeSuccess : 0,
        crcFailures: metrics ? metrics.crcFailures : 0,
        locateFailures: metrics ? metrics.locateFailures : 0
      },
      timing: {
        timeToFirstValidChunkMs,
        timeToAllChunksMs,
        reconstructionMs: metrics && metrics.reconstructMs >= 0 ? metrics.reconstructMs : null,
        sha256Ms: metrics && metrics.shaMs >= 0 ? metrics.shaMs : null,
        callbackFps: Number(callbackFps),
        processingFps: Number(processingFps),
        // r6 CORRECTED: active = pre-completion frames ONLY. Post-completion
        // ignored frames are excluded (and counted separately) — in r4/r5 they
        // entered this aggregate and collapsed the average to ~0.007 ms.
        activeProcessAvgMs: activeStats.avg != null ? Number(activeStats.avg.toFixed(3)) : null,
        activeProcessP50Ms: activeStats.p50 != null ? Number(activeStats.p50.toFixed(3)) : null,
        activeProcessP95Ms: activeStats.p95 != null ? Number(activeStats.p95.toFixed(3)) : null,
        activeProcessMaxMs: activeStats.max != null ? Number(activeStats.max.toFixed(3)) : null,
        activeProcessSamples: activeStats.count,
        postCompleteFrames: this.baselinePostCompleteFrames,
        clockSource: CLOCK_SOURCE,
        clockResolutionMs: performanceClock ? 'sub-millisecond' : 1,
        // Deprecated r4/r5 names, now computed over ACTIVE samples only.
        avgFrameProcessMs: activeStats.avg != null ? Number(activeStats.avg.toFixed(3)) : null,
        p95FrameProcessMs: activeStats.p95 != null ? Number(activeStats.p95.toFixed(3)) : null
      },
      reconstruction: {
        status: this.data.baselineReconstructionStatus,
        bytes: reconstruction ? reconstruction.bytes.length : null,
        reconstructMs: reconstruction ? reconstruction.reconstructMs : null,
        sha256: reconstruction ? reconstruction.sha256Hex : null,
        expectedSha256: reconstruction ? reconstruction.expectedSha256 : null,
        shaResult,
        previewLines: this.data.baselinePreviewLines,
        preview: this.data.baselineContentPreview
      },
      // TF-012 r5: G7 is split so a physical failure is attributable to one sub-stage.
      locator: {
        g7aCandidateDetection: {
          pass: this.data.g7aPass,
          framesAnalysed: metrics ? metrics.g7FramesAnalysed : 0,
          passCount: metrics ? metrics.g7aPassCount : 0,
          lumaMin: metrics ? Number(metrics.regionLumaMin.toFixed(2)) : null,
          lumaMax: metrics ? Number(metrics.regionLumaMax.toFixed(2)) : null,
          lumaMean: metrics ? Number(metrics.regionLumaMean.toFixed(2)) : null,
          contrast: metrics ? Number(metrics.regionContrast.toFixed(2)) : null,
          binarisationThreshold: metrics ? Number(metrics.regionThreshold.toFixed(2)) : null,
          darkPixelRatio: metrics ? Number(metrics.regionDarkPixelRatio.toFixed(4)) : null,
          localVariationRatio: metrics ? Number(metrics.regionLocalVariationRatio.toFixed(4)) : null,
          channelMeans: metrics ? {
            r: Number(metrics.regionChannelMeanR.toFixed(1)),
            g: Number(metrics.regionChannelMeanG.toFixed(1)),
            b: Number(metrics.regionChannelMeanB.toFixed(1)),
            a: Number(metrics.regionChannelMeanA.toFixed(1))
          } : null,
          componentCount: metrics ? metrics.regionComponentCount : null,
          candidateCount: metrics ? metrics.regionCandidateCount : null,
          candidateSpans: metrics ? metrics.regionCandidateSpansPx : null,
          largestComponent: metrics ? {
            x: metrics.regionLargestX,
            y: metrics.regionLargestY,
            width: metrics.regionLargestWidth,
            height: metrics.regionLargestHeight,
            area: metrics.regionLargestArea,
            fillRatio: Number(metrics.regionLargestFillRatio.toFixed(3)),
            aspect: Number(metrics.regionLargestAspect.toFixed(3))
          } : null,
          rejection: metrics && metrics.regionRejection ? metrics.regionRejection : null
        },
        g7bCodeBoundingBox: {
          pass: metrics ? metrics.g7bPass : null,
          passCount: metrics ? metrics.g7bPassCount : 0,
          reason: metrics && metrics.g7bReason ? metrics.g7bReason : null
        },
        g7cGeometryLock: {
          pass: metrics ? metrics.g7cPass : null,
          passCount: metrics ? metrics.g7cPassCount : 0,
          seedCount: metrics ? metrics.seedCount : null,
          bestSeedScore: metrics ? Number(metrics.seedBestScore.toFixed(4)) : null,
          bestSeedRotation: metrics ? metrics.seedBestRotation : null,
          refinementCount: metrics ? metrics.refinementCount : null,
          bestRefinedScore: metrics ? Number(metrics.refinementBestScore.toFixed(4)) : null,
          bestRefinedRotation: metrics ? metrics.refinementBestRotation : null,
          bestRefinedPixelsPerCell: metrics ? Number(metrics.refinementBestPixPerCell.toFixed(3)) : null,
          bestRefinedPhaseX: metrics ? Number(metrics.refinementBestPhaseX.toFixed(3)) : null,
          bestRefinedPhaseY: metrics ? Number(metrics.refinementBestPhaseY.toFixed(3)) : null,
          reason: metrics && metrics.g7cReason ? metrics.g7cReason : null
        },
        g7dCrcDecode: {
          pass: metrics ? metrics.g7dPass : null,
          passCount: metrics ? metrics.g7dPassCount : 0,
          crcAttempts: metrics ? metrics.crcDecodeAttempts : null,
          crcSuccess: metrics ? metrics.crcSuccess : null,
          crcFailure: metrics ? metrics.crcFailure : null,
          decodedSequence: metrics && metrics.decodedSequence >= 0 ? metrics.decodedSequence : null,
          decodedChunkIndex: metrics && metrics.decodedChunkIndex >= 0 ? metrics.decodedChunkIndex : null
        },
        deepestStage: metrics ? metrics.locatorStage : null,
        stageReason: metrics ? metrics.locatorStageReason : null,
        locatorFailures: metrics ? metrics.locateFailures : null,
        crcFailures: metrics ? metrics.crcFailures : null
      },
      device: {
        model: this.data.model,
        brand: this.data.brand,
        system: this.data.system,
        platform: this.data.platform,
        wechatVersion: this.data.wechatVersion,
        baseLibVersion: this.data.baseLibVersion,
        sdkVersion: this.data.sdkVersion,
        pixelRatio: this.data.pixelRatio,
        screenSize: this.data.screenSize
      },
      networkType: this.data.networkType,
      errors: this.data.errors
    };
  },

  buildReceiveResultPayload() {
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const callbackFps = elapsedMs > 0 ? (this.receivedFrames / (elapsedMs / 1000)).toFixed(2) : '0.00';
    const processingFps = elapsedMs > 0 ? (this.receiveFramesProcessed / (elapsedMs / 1000)).toFixed(2) : '0.00';
    const skipped = Math.max(0, this.receiveFramesReceived - this.receiveFramesProcessed);
    const core = this.receiveCore;
    const stage = core ? core.stage : 'unavailable';
    const bytes = core && core.complete ? core.reconstruct() : null;
    const reconstructedSha = bytes ? opticalCore.sha256Hex(bytes) : null;
    const manifestSha = core && core.manifest ? core.manifest.file.sha256 : null;
    const shaMatch = reconstructedSha !== null && manifestSha !== null && reconstructedSha === manifestSha;

    const orientation = core && core.orientation && core.orientation.best
      ? {
          mode: core.orientation.best.orientationMode,
          matrixSize: core.orientation.best.matrixSize,
          exactTiles: core.orientation.best.exactTiles,
          tileCount: opticalCore && opticalCore.TILE_COUNT ? opticalCore.TILE_COUNT : 3,
          errors: Number.isFinite(core.orientation.best.totalBitErrors) ? core.orientation.best.totalBitErrors : null,
          projection: core.orientation.best.projectionSafe,
          locked: core.orientation.locked,
          support: core.orientation.best.locatorSupport,
          tripletValid: !!core.orientation.best.tripletValid,
          lockMode: core.orientation.best.lockMode || 'fallback-exhaustive',
          tripletRejectReason: core.orientation.best.tripletRejectReason || null,
          selectedTransform: core.orientation.selectedTransform,
          tiles: core.orientation.best.tiles.map(t => ({
            tile: t.tile, acquired: t.acquired, exact: t.exact,
            bitErrors: Number.isFinite(t.bitErrors) ? t.bitErrors : null
          }))
        }
      : { locked: false, reason: 'no-orientation-result' };

    const manifest = core && core.manifest
      ? {
          protocol: core.manifest.protocol,
          version: core.manifest.version,
          file: { name: core.manifest.file.name, byteLength: core.manifest.file.byteLength },
          matrixSize: core.manifest.transport.matrixSize,
          fountainSourceBlockBytes: core.manifest.transport.fountainSourceBlockBytes,
          fountainSeed: core.manifest.transport.fountainSeed
        }
      : null;

    const dynamic = core
      ? {
          capturedFrames: core.stats.capturedFrames,
          decodedSymbols: core.stats.decodedSymbols,
          duplicateSymbols: core.stats.duplicateSymbols,
          redundantSymbols: core.stats.redundantSymbols,
          decodeFailures: core.stats.decodeFailures,
          trackFallbacks: core.stats.trackFallbacks,
          solvedBlocks: core.solvedCount,
          totalBlocks: core.sourceCount
        }
      : null;

    const reconstruction = core
      ? {
          status: core.complete ? 'complete' : 'incomplete',
          reconstructedSize: bytes ? bytes.length : null,
          reconstructedSha256: reconstructedSha,
          manifestSha256: manifestSha,
          shaMatch
        }
      : null;

    // Per-stage budget inventory (Phase 1): avg / p95 / max over processed frames.
    const stageSummary = {};
    Object.keys(this.receiveStageTimes).forEach((key) => {
      const v = this.receiveStageTimes[key];
      if (!v || !v.length) return;
      const sorted = v.slice().sort((a, b) => a - b);
      stageSummary[key] = {
        n: v.length,
        avgMs: Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)),
        p95Ms: Number(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))].toFixed(2)),
        maxMs: Number(sorted[sorted.length - 1].toFixed(2))
      };
    });

    const sourceByteLength = core && core.manifest ? core.manifest.file.byteLength : null;
    // Physical reconstructed throughput (only valid on exact reconstruction).
    // This is NOT Net Goodput (see docs/TF011_SESSION_MANIFEST_INVENTORY.md and
    // the Net Goodput definition — no formal definition satisfied here).
    const physicalReconstructedBytesPerSecond = (shaMatch && sourceByteLength && elapsedMs > 0)
      ? Number((sourceByteLength / (elapsedMs / 1000)).toFixed(2))
      : null;

    return {
      evidenceClass: 'PHYSICAL MINI PROGRAM END-TO-END RECONSTRUCTION',
      buildId: this.data.buildId,
      appMode: this.data.mode,
      stage,
      note: 'Physical optical reconstruction evidence. NOT G0. NOT Net Goodput. Payload has zero network path.',
      networkPayloadPath: 'NONE',
      radiosState: this.data.networkType,
      localFilePath: this.data.localFilePath || null,
      timestamp: new Date().toISOString(),
      testDurationMs: elapsedMs,
      device: {
        model: this.data.model,
        brand: this.data.brand,
        system: this.data.system,
        platform: this.data.platform,
        pixelRatio: this.data.pixelRatio,
        screenSize: this.data.screenSize,
        wechatVersion: this.data.wechatVersion,
        baseLibVersion: this.data.baseLibVersion,
        sdkVersion: this.data.sdkVersion
      },
      camera: {
        frameWidth: this.frameW,
        frameHeight: this.frameH,
        frameBufferBytes: this.frameBytes,
        frameFormat: this.frameBytes ? 'RGBA (4 bytes/px)' : '—'
      },
      orientation,
      manifest,
      dynamic,
      reconstruction,
      sha256: { reconstructedSha256: reconstructedSha, manifestSha256: manifestSha, shaMatch },
      protocolEvents: {
        beaconDetections: core ? core.eventCounts.beaconProbes : 0,
        orientationAttempts: core ? core.eventCounts.orientationAttempts : 0,
        orientationSuccess: core ? core.eventCounts.orientationSuccess : 0,
        manifestAcquisitions: core ? core.eventCounts.manifestAcquisitions : 0,
        preambleAttempts: core ? core.eventCounts.preambleAttempts : 0,
        preambleSuccess: core ? core.eventCounts.preambleSuccess : 0,
        preambleRejectedOrSkipped: core ? core.eventCounts.preambleRejectedOrSkipped : 0,
        lastStageTransition: core ? core.lastStageTransition : 'IDLE',
        lastStageTransitionAt: core && core.lastStageTransitionAt ? new Date(core.lastStageTransitionAt).toISOString() : null
      },
      performance: {
        callbackFps: Number(callbackFps),
        processingFps: Number(processingFps),
        receivedFrames: this.receiveFramesReceived,
        processedFrames: this.receiveFramesProcessed,
        skippedBusyFrames: skipped,
        replacedFrames: this.receiveFramesReplaced,
        boundedModel: 'one frame processing + one latest pending frame',
        reconstructMs: this.reconstructMs,
        shaMs: this.shaMs,
        fileWriteMs: this.fileWriteMs,
        perStageMs: stageSummary,
        sourceByteLength,
        physicalReconstructedBytesPerSecond
      },
      errors: this.data.errors
    };
  },

  // ---- pixel helpers -----------------------------------------------------
  // frame.data is a flat RGBA ArrayBuffer. Return {mean, min, max, range, std}
  // over a subsampled grid (cheap, O(n/step^2)).
  cheapLumaStat(buffer, width, height) {
    const data = new Uint8Array(buffer);
    const step = STAT_SAMPLE_STEP;
    let sum = 0;
    let count = 0;
    let min = 255;
    let max = 0;

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const luma = (299 * r + 587 * g + 114 * b) / 1000;
        sum += luma;
        count++;
        if (luma < min) min = luma;
        if (luma > max) max = luma;
      }
    }

    if (!count) return { mean: 0, min: 0, max: 0, range: 0, std: 0 };
    const mean = sum / count;
    let sqSum = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const luma = (299 * r + 587 * g + 114 * b) / 1000;
        const d = luma - mean;
        sqSum += d * d;
      }
    }
    return { mean, min, max, range: max - min, std: Math.sqrt(sqSum / count) };
  },

  // Box-downsample RGBA -> luma Float32Array at target resolution. Reference
  // implementation to measure normalization latency; production would use
  // WASM/Worker. Does NOT build a display preview.
  downsampleLuma(buffer, sw, sh, tw, th) {
    const data = new Uint8Array(buffer);
    const out = new Float32Array(tw * th);
    const sx = sw / tw;
    const sy = sh / th;
    for (let ty = 0; ty < th; ty++) {
      const y0 = Math.floor(ty * sy);
      for (let tx = 0; tx < tw; tx++) {
        const x0 = Math.floor(tx * sx);
        const i = (y0 * sw + x0) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        out[ty * tw + tx] = (299 * r + 587 * g + 114 * b) / 1000;
      }
    }
    return out;
  },

  percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction));
    return sorted[idx];
  },

  // TF-012 r6: latency statistics over ACTIVE (pre-completion) frames only.
  // `baselineTimes` never receives a post-completion ignored frame, so this is a
  // decode-cost distribution, not a mixture of decode cost and an early return.
  baselineActiveStats() {
    const values = this.baselineTimes;
    if (!values.length) return {avg: null, p50: null, p95: null, max: null, count: 0};
    let sum = 0;
    let max = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[i];
      if (values[i] > max) max = values[i];
    }
    return {
      avg: sum / values.length,
      p50: this.percentile(values, 0.5),
      p95: this.percentile(values, 0.95),
      max,
      count: values.length
    };
  },

  /**
   * TF-012 r6 exploratory Net Goodput. Delegates the guard to the shared core so
   * the browser sender, Node tests and this adapter agree on exactly one
   * definition: 16/16 unique chunks AND SHA-256 MATCH, else null.
   */
  baselineNetGoodputMetrics(receiver, reconstruction) {
    if (!opticalCore || typeof opticalCore.singleBaselineNetGoodput !== 'function') return null;
    if (!receiver || !reconstruction) return null;
    const metrics = receiver.metrics;
    return opticalCore.singleBaselineNetGoodput(
      reconstruction.bytes.length,
      metrics.allChunksMs,
      receiver.receivedUniqueCount,
      receiver.totalChunks,
      reconstruction.match === true,
    );
  },

  /**
   * TF-012 r7 Stage B efficiency metrics. Delegates the arithmetic AND the guards
   * to the shared core so a zero-denominator case reports null instead of a 0/0.
   * These are diagnostic: PASS is still 16/16 unique + 10240 bytes + SHA MATCH.
   */
  baselineEfficiencyMetrics(receiver) {
    const empty = {
      theoreticalCameraFramesPerCode: null,
      decodeSuccessRatio: null,
      crcFailureRatio: null,
      locateFailureRatio: null,
      newUniqueChunkYield: null,
      duplicateRatio: null
    };
    if (!opticalCore || typeof opticalCore.singleBaselineEfficiency !== 'function') return empty;
    if (!receiver) return empty;
    const metrics = receiver.metrics;
    const elapsedMs = this.baselineStartAt ? Date.now() - this.baselineStartAt : 0;
    const callbackFps = elapsedMs > 0 ? (this.baselineFramesReceived / (elapsedMs / 1000)) : 0;
    return opticalCore.singleBaselineEfficiency({
      callbackFps,
      holdMs: this.data.holdMsDeclared,
      decodeAttempts: metrics.decodeAttempts,
      successfulDecodes: metrics.decodeSuccess,
      crcFailures: metrics.crcFailures,
      locateFailures: metrics.locateFailures,
      duplicates: metrics.duplicateChunks,
      uniqueReceived: receiver.receivedUniqueCount
    });
  },

  /** Render a ratio for the phone panel. null stays visibly absent, never 0. */
  ratioText(value, digits) {
    if (value === null || value === undefined) return 'n/a';
    return (value * 100).toFixed(digits === undefined ? 2 : digits) + '%';
  },

  percentileFormat(values, kind) {
    if (!values.length) return '—';
    if (kind === 'avg') {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      return avg.toFixed(2) + ' ms';
    }
    return '—';
  },

  // ---- device evidence (official APIs only) ------------------------------
  collectDeviceEvidence() {
    const evidence = { deviceTimestamp: new Date().toISOString() };
    try {
      const sys = wx.getSystemInfoSync();
      if (sys) {
        evidence.wechatVersion = sys.version || '—';
        evidence.baseLibVersion = sys.SDKVersion || '—';
        evidence.platform = sys.platform || '—';
        evidence.system = sys.system || '—';
        evidence.model = sys.model || '—';
        evidence.brand = sys.brand || '—';
        evidence.pixelRatio = sys.pixelRatio != null ? String(sys.pixelRatio) : '—';
        evidence.screenSize = (sys.screenWidth || 0) + ' × ' + (sys.screenHeight || 0);
        evidence.sdkVersion = sys.SDKVersion || '—';
      }
    } catch (err) {
      this.recordError('getSystemInfoSync_failed:' + (err && err.message));
    }
    try {
      const app = wx.getAppBaseInfo && wx.getAppBaseInfo();
      if (app) {
        if (app.SDKVersion) evidence.baseLibVersion = app.SDKVersion;
        if (app.version) evidence.wechatVersion = app.version;
      }
    } catch (err) { /* optional */ }
    try {
      const dev = wx.getDeviceInfo && wx.getDeviceInfo();
      if (dev) {
        if (dev.model) evidence.model = dev.model;
        if (dev.brand) evidence.brand = dev.brand;
        if (dev.system) evidence.system = dev.system;
        if (dev.platform) evidence.platform = dev.platform;
      }
    } catch (err) { /* optional */ }
    // Radio state proxy: network type (wifi/5g/4g/3g/2g/none/unknown). "none"
    // implies airplane mode (offline-radio) which is the formal offline G0
    // condition. This does NOT transmit anything.
    try {
      wx.getNetworkType({
        success: (res) => { this.setData({ networkType: (res && res.networkType) || 'unknown' }); },
        fail: () => { this.setData({ networkType: 'unknown' }); }
      });
    } catch (err) { this.setData({ networkType: 'unknown' }); }
    this.setData(evidence);
    this.appendLog('device model (runtime): ' + evidence.model);
  },

  // ---- permission --------------------------------------------------------
  readCameraPermission() {
    try {
      wx.getSetting({
        success: (res) => {
          const auth = res.authSetting || {};
          const granted = auth['scope.camera'];
          const status = granted === true ? 'granted' : granted === false ? 'denied' : 'not-requested';
          this.setData({ permissionStatus: status });
          this.appendLog('camera permission: ' + status);
        },
        fail: (err) => {
          this.setData({ permissionStatus: 'unknown' });
          this.recordError('getSetting_failed:' + (err && err.errMsg));
        }
      });
    } catch (err) {
      this.setData({ permissionStatus: 'unknown' });
    }
  },

  // ---- errors / timeout --------------------------------------------------
  recordError(msg) {
    this.setData({ errors: this.data.errors.concat(msg) });
  },

  clearErrors() {
    this.setData({ errors: [] });
  },

  armFrameTimeout() {
    this.clearFrameTimeout();
    this.frameTimeoutTimer = setTimeout(() => {
      if (this.data.running && !this.data.callbackActive) {
        this.recordError('no_camera_frame_within_' + (FRAME_TIMEOUT_MS / 1000) + 's');
        this.appendLog('WARNING: no camera frame received within ' + (FRAME_TIMEOUT_MS / 1000) + 's');
      }
    }, FRAME_TIMEOUT_MS);
  },

  clearFrameTimeout() {
    if (this.frameTimeoutTimer) {
      clearTimeout(this.frameTimeoutTimer);
      this.frameTimeoutTimer = null;
    }
  },

  stopAll() {
    this.clearFrameTimeout();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopCamera();
  },

  appendLog(line) {
    const stamp = new Date().toLocaleTimeString();
    const log = '[' + stamp + '] ' + line + '\n' + (this.data.log || '');
    this.setData({ log: log.slice(0, 4000) });
  }
});
