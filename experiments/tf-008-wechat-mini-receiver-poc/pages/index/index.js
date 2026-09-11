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
const PROCESS_TIME_CAP = 600;  // max processing-time samples kept for p95
const RECEIVE_MATRIX = 96;     // protocol constant: manifest + dynamic symbol matrix

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
const BUILD_ID = 'tf012-r3-7728b0c';

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
    mode: 'receive', // 'receive' | 'benchmark'
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

  onLoad() {
    this.collectDeviceEvidence();
    this.readCameraPermission();
    this.cameraContext = wx.createCameraContext();
    this.receiveCore = (opticalCore && typeof opticalCore.SharedOpticalReceiveCore === 'function')
      ? new opticalCore.SharedOpticalReceiveCore()
      : null;

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
      fileWriteMs: '—'
    });
    this.appendLog('metrics reset');
  },

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
  },

  onSelectMode(e) {
    this.setMode(e.currentTarget.dataset.mode);
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

  // ---- freeze / copy -----------------------------------------------------
  freezeResult() {
    this.clearFrameTimeout();
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
