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
const ORIENT_EVERY = 4;        // run orientation acquisition on every Nth frame

// Shared optical acquisition core (bundled from the TF-007H modules).
const opticalCore = require('../../utils/optical-core.js');

// Unmistakable build identifier — must be visible on the phone to prove the
// device is running the latest orientation-capable package (not a stale cache).
const BUILD_ID = 'tf008-r9';

Page({
  data: {
    // lifecycle
    running: false,
    callbackActive: false,
    frozen: false,
    heavy: false,
    mode: 'orientation', // 'orientation' | 'benchmark'
    buildId: BUILD_ID,
    permissionStatus: 'unknown',
    maxZoom: '—',
    networkPath: 'NONE',

    // orientation mode state
    orientAttempts: 0,
    orientReceived: 0,
    orientProcessed: 0,
    orientSkipped: 0,
    orientCandidate: '—',
    orientLocked: 'WAITING',
    orientExactTiles: '—',
    orientTotalErrors: '—',
    orientProjection: '—',
    orientSupport: '—',
    orientReject: '—',
    orientMarkers: '—',
    orientAvgMs: '—',
    orientP95Ms: '—',
    orientSelfCheck: '—',
    orientLastResultAge: '—',
    orientPipelineError: '',
    tileStatus: [],

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

  // orientation mode internal state
  orientTimes: [],     // ms per acquisition run
  orientFramesReceived: 0,
  orientFramesProcessed: 0,
  orientLatest: null,  // last OrientationAcquisition result
  orientLastAt: 0,     // timestamp of last successful acquisition

  onLoad() {
    this.collectDeviceEvidence();
    this.readCameraPermission();
    this.cameraContext = wx.createCameraContext();

    this.windowStartAt = Date.now();
    this.timer = setInterval(() => this.onTick(), UI_REFRESH_MS);

    this.appendLog('OptiLink camera-frame PoC ready. Payload is OPTICAL-ONLY.');
    this.appendLog('Network payload path: NONE (no network APIs used).');
    this.runOrientationSelfCheck();
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
    this.orientTimes = [];
    this.orientFramesReceived = 0;
    this.orientFramesProcessed = 0;
    this.orientLatest = null;
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
      orientAttempts: 0,
      orientReceived: 0,
      orientProcessed: 0,
      orientSkipped: 0,
      orientCandidate: '—',
      orientLocked: 'WAITING',
      orientExactTiles: '—',
      orientTotalErrors: '—',
      orientProjection: '—',
      orientSupport: '—',
      orientReject: '—',
      orientMarkers: '—',
      orientAvgMs: '—',
      orientP95Ms: '—',
      orientSelfCheck: '—',
      orientLastResultAge: '—',
      orientPipelineError: '',
      tileStatus: []
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
  // from orientation.
  setMode(mode) {
    if (this.data.mode === mode) return;
    this.resetMetrics();
    this.setData({ mode, orientPipelineError: '' });
    this.appendLog('active mode: ' + mode);
    if (mode === 'orientation') this.runOrientationSelfCheck();
  },

  onSelectMode(e) {
    this.setMode(e.currentTarget.dataset.mode);
  },

  runOrientationSelfCheck() {
    const problems = [];
    if (!opticalCore) problems.push('optical-core bundle missing');
    else if (typeof opticalCore.acquireOrientation !== 'function') problems.push('acquireOrientation not a function');
    if (this.data.mode !== 'orientation') problems.push('mode is not orientation');
    if (problems.length) {
      this.setData({ orientSelfCheck: 'SELF-CHECK FAIL: ' + problems.join('; ') });
      this.recordError('orientation_selfcheck_failed: ' + problems.join('; '));
    } else {
      this.setData({ orientSelfCheck: 'SELF-CHECK OK' });
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

    if (this.data.mode === 'orientation') {
      this.processOrientationFrame(buffer, width, height);
    } else {
      this.processBenchmarkFrame(buffer, width, height);
    }

    this.setData({
      frameWidth: width,
      frameHeight: height,
      frameBufferBytes: buffer.byteLength,
      frameFormat: 'RGBA (4 bytes/px)'
    });
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

  // Orientation mode: run the shared TF-007H 64x64 acquisition on a cadence.
  // Payload stays local — only the acquisition verdict is computed, in memory.
  processOrientationFrame(buffer, width, height) {
    this.orientFramesReceived++;
    if (this.orientFramesReceived % ORIENT_EVERY !== 0) return; // every-N gate

    if (!opticalCore || typeof opticalCore.acquireOrientation !== 'function') {
      this.recordError('optical_core_unavailable');
      return;
    }

    const t0 = Date.now();
    let frame;
    try {
      frame = { width, height, data: new Uint8ClampedArray(buffer) };
    } catch (err) {
      this.recordError('frame_wrap_failed:' + (err && err.message));
      return;
    }

    let result;
    try {
      result = opticalCore.acquireOrientation(frame);
    } catch (err) {
      this.recordError('acquireOrientation_failed:' + (err && err.message));
      return;
    }

    const elapsed = Date.now() - t0;
    this.orientTimes.push(elapsed);
    if (this.orientTimes.length > PROCESS_TIME_CAP) this.orientTimes.shift();
    this.orientFramesProcessed++;
    this.orientLatest = result;
    this.orientLastAt = Date.now();
    this.processedFrames++;
    this.windowProcessed++;
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

    if (this.data.mode === 'orientation') {
      this.onOrientationTick();
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

    const bufferBytes = this.data.frameBufferBytes || 0;
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

  onOrientationTick() {
    const elapsed = Math.max(1, Date.now() - this.windowStartAt);
    const seconds = elapsed / 1000;

    const callbackFps = (this.windowReceived / seconds).toFixed(1);
    const acquisitionFps = (this.windowProcessed / seconds).toFixed(1);
    const skipped = Math.max(0, this.orientFramesReceived - this.orientFramesProcessed);
    const skipRatio = this.orientFramesReceived
      ? ((skipped / this.orientFramesReceived) * 100).toFixed(1) + '%'
      : '0.0%';
    const avgMs = this.orientTimes.length
      ? (this.orientTimes.reduce((a, b) => a + b, 0) / this.orientTimes.length).toFixed(2) + ' ms'
      : '—';
    const p95 = this.percentile(this.orientTimes, 0.95);
    const bufferBytes = this.data.frameBufferBytes || 0;
    const ingressMBps = ((bufferBytes * Number(callbackFps)) / 1e6).toFixed(3);

    const patch = {
      callbackFps,
      processingFps: acquisitionFps,
      totalReceived: this.receivedFrames,
      processed: this.processedFrames,
      skipped,
      skipRatio,
      avgProcessMs: avgMs,
      p95ProcessMs: p95 != null ? p95.toFixed(2) + ' ms' : '—',
      ingressMBps,
      orientAttempts: this.orientFramesProcessed,
      orientReceived: this.orientFramesReceived,
      orientProcessed: this.orientFramesProcessed,
      orientSkipped: skipped,
      orientAvgMs: avgMs,
      orientP95Ms: p95 != null ? p95.toFixed(2) + ' ms' : '—'
    };

    const r = this.orientLatest;
    if (r && r.best) {
      const best = r.best;
      const tileCount = opticalCore && opticalCore.TILE_COUNT ? opticalCore.TILE_COUNT : 3;
      patch.orientCandidate = best.orientationMode;
      patch.orientLocked = r.locked ? 'LOCKED' : 'NOT LOCKED';
      patch.orientExactTiles = best.exactTiles + ' / ' + tileCount;
      patch.orientTotalErrors = Number.isFinite(best.totalBitErrors) ? String(best.totalBitErrors) : 'n/a';
      patch.orientProjection = best.projectionSafe === true ? 'true' : best.projectionSafe === false ? 'false' : 'null';
      patch.orientSupport = best.locatorSupport;
      patch.orientReject = best.tripletRejectReason || '—';
      patch.orientMarkers = (best.detectedMarkerComponentCount != null ? best.detectedMarkerComponentCount : 0) + ' components / ' + (best.validTripletMarkerCount != null ? best.validTripletMarkerCount : 0) + ' triplet markers';
      patch.tileStatus = best.tiles.map(t =>
        'tile ' + t.tile + ': ' + (t.acquired ? (t.exact ? 'exact' : 'err ' + t.bitErrors) : 'miss')
      );
    }

    patch.orientLastResultAge = this.orientLastAt ? (Date.now() - this.orientLastAt) + ' ms ago' : 'no result';
    patch.orientPipelineError = (this.data.running && this.orientFramesReceived > ORIENT_EVERY && this.orientFramesProcessed === 0)
      ? 'ERROR: ORIENTATION PIPELINE NOT RUNNING'
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
    if (this.data.mode === 'orientation') return this.buildOrientationResultPayload();
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

  buildOrientationResultPayload() {
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const callbackFps = elapsedMs > 0 ? (this.receivedFrames / (elapsedMs / 1000)).toFixed(2) : '0.00';
    const acquisitionFps = elapsedMs > 0 ? (this.orientFramesProcessed / (elapsedMs / 1000)).toFixed(2) : '0.00';
    const skipped = Math.max(0, this.orientFramesReceived - this.orientFramesProcessed);
    const avgAcqMs = this.orientTimes.length
      ? Number((this.orientTimes.reduce((a, b) => a + b, 0) / this.orientTimes.length).toFixed(3))
      : null;
    const p95AcqMs = this.percentile(this.orientTimes, 0.95);

    const r = this.orientLatest;
    const best = r ? r.best : null;
    const locked = !!(r && r.locked);
    const tileCount = opticalCore && opticalCore.TILE_COUNT ? opticalCore.TILE_COUNT : 3;

    const orientation = best
      ? {
          mode: best.orientationMode,
          matrixSize: best.matrixSize,
          exactTiles: best.exactTiles,
          tileCount,
          errors: Number.isFinite(best.totalBitErrors) ? best.totalBitErrors : null,
          projection: best.projectionSafe,
          locked,
          support: best.locatorSupport,
          detectedMarkerComponentCount: best.detectedMarkerComponentCount != null ? best.detectedMarkerComponentCount : 0,
          validTripletMarkerCount: best.validTripletMarkerCount != null ? best.validTripletMarkerCount : 0,
          tripletValid: !!best.tripletValid,
          lockMode: best.lockMode || 'fallback-exhaustive',
          tripletRejectReason: best.tripletRejectReason || null,
          markerCandidates: best.markerCandidates || [],
          tiles: best.tiles.map(t => ({
            tile: t.tile,
            acquired: t.acquired,
            exact: t.exact,
            bitErrors: Number.isFinite(t.bitErrors) ? t.bitErrors : null,
            reason: t.reason || (t.acquired ? 'acquired' : 'not-acquired')
          }))
        }
      : { locked: false, reason: 'no-acquisition-result', support: [], tiles: [] };

    return {
      evidenceClass: 'PHYSICAL MINI PROGRAM TF-007H ORIENTATION ACQUISITION',
      buildId: this.data.buildId,
      appMode: this.data.mode,
      note: 'Feasibility spike only. NOT Manifest PASS / throughput PASS / Net Goodput.',
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
        frameFormat: this.data.frameFormat
      },
      orientation,
      transformCandidates: r && r.transformCandidates ? r.transformCandidates : [],
      selectedTransform: r && r.selectedTransform ? r.selectedTransform : null,
      profile: r && r.profile ? r.profile : null,
      performance: {
        callbackFps: Number(callbackFps),
        acquisitionFps: Number(acquisitionFps),
        avgAcquisitionMs: avgAcqMs,
        p95AcquisitionMs: p95AcqMs != null ? Number(p95AcqMs.toFixed(3)) : null,
        receivedFrames: this.orientFramesReceived,
        processedFrames: this.orientFramesProcessed,
        skippedFrames: skipped
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
