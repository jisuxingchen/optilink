/**
 * TF-012 r21 — MINIMAL RECEIVE MODE (pure, platform-free).
 *
 * WHY THIS FILE EXISTS
 *
 * The r13–r20 Mini Program grew into a diagnostic harness: a SETUP gate, an A1–A5
 * sweep, a static probe, per-phase scheduler telemetry, camera timing, failure
 * fingerprints, sampling geometry, rotation histograms and a phase verdict for every
 * phase. Every one of those is worth having while the physics is being diagnosed, and
 * every one of them costs main-thread time in the camera callback path — the physical
 * runs measured a processing duty ratio of ~99.7 %, i.e. the JS thread was busy almost
 * the whole time.
 *
 * The DEFAULT receive path must not pay for any of it:
 *
 *   CameraFrame -> locate -> sample -> CRC -> chunk -> dedupe -> reconstruct -> SHA-256
 *
 * and nothing else. This module is that path's ENTIRE decision surface, kept pure and
 * dependency-free so it can be unit-tested without a phone, a camera or a socket:
 *
 *   simpleRun(kind, nowMs)          begin a run (receive or static decode check)
 *   simpleDecision(run, counters, nowMs)
 *                                   the ONLY place PASS/FAIL is decided
 *   simpleProgressText(...)         cheap UI text formatters (no timers, no clocks)
 *   simpleResultJson(...)           the SMALL result artefact
 *
 * DESIGN RULES (r21 requirements)
 *
 *   1. EVENT-DRIVEN COMPLETION. The run ends the instant the PASS condition is true —
 *      `uniqueReceived === totalChunks` AND the assembled file is the full length AND
 *      SHA-256 MATCH. No fixed dwell time, no step plan. The timeout is a bound, never
 *      a schedule.
 *   2. TIMEOUT FAIL. A run that never completes FAILS at its bound (30 s receive,
 *      5 s static decode check). A camera that never delivers frames also FAILS at that
 *      bound, because the caller evaluates the decision on a tick as well as on a frame.
 *   3. ONE DECISION POINT. `simpleDecision()` never returns a verdict twice: a finished
 *      run is finished.
 *   4. NO DIAGNOSTICS. Nothing here computes fingerprints, stable bits, rotation
 *      histograms, percentiles or phase timing.
 *   5. NETWORK POLICY. The result declares `networkPayloadPath: 'NONE'`; the only SHA
 *      values in it are LOCAL digests, never sender payload.
 *
 * Field-name note: the reference digest is `manifestSha256` and the assembled length is
 * `assembledBytes` on purpose. The lab's payload-shaped-key guards refuse any key
 * containing `expected` or `reconstructed`, and weakening a payload guard so a
 * diagnostic field can be spelled the way we like is the wrong trade (the same call as
 * r20's `plannedTicks`).
 */

/** Run kinds: the physical receive, and the small static alignment check. */
const SIMPLE_KIND_RECEIVE = 'receive';
const SIMPLE_KIND_STATIC = 'static';

/** The 10 KiB baseline transfer: 16 chunks x 640 B. */
const SIMPLE_TOTAL_CHUNKS = 16;
const SIMPLE_CHUNK_DATA_BYTES = 640;
const SIMPLE_FILE_BYTES = 10240;

/** Bounds, not schedules. A completed receive never waits for these. */
const SIMPLE_CAMERA_READY_TIMEOUT_MS = 5000;
const SIMPLE_RECEIVE_TIMEOUT_MS = 30000;
const SIMPLE_STATIC_TIMEOUT_MS = 5000;
/** The static alignment check passes as soon as this many decodes succeeded. */
const SIMPLE_STATIC_MIN_DECODES = 10;

/** UI refresh must stay at or below 4 Hz (2 Hz is what the page's tick provides). */
const SIMPLE_MAX_UI_HZ = 4;

/** Status strings shared by the page and the tests. */
const SIMPLE_STATUS_IDLE = 'WAITING';
const SIMPLE_STATUS_RECEIVING = 'RECEIVING';
const SIMPLE_STATUS_PASS = 'PASS';
const SIMPLE_STATUS_FAIL = 'FAIL';

/**
 * Begin a run. `kind` is 'receive' (the 10 KiB file) or 'static' (the alignment check).
 * Every default is overridable so a test can drive the run deterministically.
 */
function simpleRun(kind, nowMs, options) {
  const settings = options || {};
  const isStatic = kind === SIMPLE_KIND_STATIC;
  return {
    kind: isStatic ? SIMPLE_KIND_STATIC : SIMPLE_KIND_RECEIVE,
    startedAt: nowMs,
    finishedAt: null,
    status: SIMPLE_STATUS_RECEIVING,
    reason: null,
    finished: false,
    timeoutMs: isStatic
      ? numberOr(settings.staticTimeoutMs, SIMPLE_STATIC_TIMEOUT_MS)
      : numberOr(settings.receiveTimeoutMs, SIMPLE_RECEIVE_TIMEOUT_MS),
    minDecodes: numberOr(settings.staticMinDecodes, SIMPLE_STATIC_MIN_DECODES),
    totalChunks: numberOr(settings.totalChunks, SIMPLE_TOTAL_CHUNKS),
    fileBytes: numberOr(settings.fileBytes, SIMPLE_FILE_BYTES),
  };
}

/**
 * THE decision. Returns `null` while the run is still open, or a terminal verdict
 * exactly once. Called on every processed frame AND on every UI tick, so a camera that
 * dies mid-run still FAILS at the bound instead of hanging forever.
 *
 * `counters` is a flat snapshot of LOCAL receiver state:
 *   {uniqueReceived, totalChunks, assembledBytes, fileLength, shaResult, successfulDecodes}
 */
function simpleDecision(run, counters, nowMs) {
  if (!run || run.finished) return null;
  const now = typeof nowMs === 'number' ? nowMs : 0;
  const elapsedMs = Math.max(0, now - run.startedAt);
  const counts = counters || {};

  if (run.kind === SIMPLE_KIND_STATIC) {
    const decodes = numberOr(counts.successfulDecodes, 0);
    if (decodes >= run.minDecodes) {
      return {status: SIMPLE_STATUS_PASS, reason: 'static-decodes', elapsedMs};
    }
    if (elapsedMs >= run.timeoutMs) {
      return {status: SIMPLE_STATUS_FAIL, reason: 'static-timeout', elapsedMs};
    }
    return null;
  }

  // The MINIMAL receive gate is the FROZEN 10 KiB baseline, not merely any
  // self-consistent transfer described by optical metadata. Receiver metadata is useful
  // evidence, but it must never redefine the acceptance target.
  const total = numberOr(counts.totalChunks, run.totalChunks);
  const length = numberOr(counts.fileLength, 0);
  const unique = numberOr(counts.uniqueReceived, 0);
  if (total !== run.totalChunks) {
    return {status: SIMPLE_STATUS_FAIL, reason: 'baseline-total-chunks', elapsedMs};
  }
  if (length > 0 && length !== run.fileBytes) {
    return {status: SIMPLE_STATUS_FAIL, reason: 'baseline-file-bytes', elapsedMs};
  }
  if (unique === run.totalChunks) {
    // All 16 frozen-baseline chunks are held. PASS requires exactly 10,240 assembled
    // bytes AND the local digest match. Metadata cannot shrink or expand this gate.
    const bytes = numberOr(counts.assembledBytes, 0);
    if (bytes !== run.fileBytes) {
      return {status: SIMPLE_STATUS_FAIL, reason: 'file-length', elapsedMs};
    }
    if (counts.shaResult === 'MATCH') {
      return {status: SIMPLE_STATUS_PASS, reason: 'sha-match', elapsedMs};
    }
    return {status: SIMPLE_STATUS_FAIL, reason: 'sha-mismatch', elapsedMs};
  }
  if (elapsedMs >= run.timeoutMs) {
    return {status: SIMPLE_STATUS_FAIL, reason: 'receive-timeout', elapsedMs};
  }
  return null;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

/** `7 / 16` — the progress line. */
function simpleProgressText(uniqueReceived, totalChunks) {
  const unique = Math.max(0, numberOr(uniqueReceived, 0));
  const total = numberOr(totalChunks, SIMPLE_TOTAL_CHUNKS);
  return unique + ' / ' + total;
}

/** `123 OK · 14 CRC · 28.4 FPS` — one line, three local counters. */
function simpleDecodeText(counters, fps) {
  const counts = counters || {};
  const ok = Math.max(0, numberOr(counts.successfulDecodes, 0));
  const crc = Math.max(0, numberOr(counts.crcFailures, 0));
  const rate = typeof fps === 'number' && isFinite(fps) ? fps.toFixed(1) : '—';
  return ok + ' OK · ' + crc + ' CRC · ' + rate + ' FPS';
}

/** `310px · 3.23px/cell · contrast 176 · rot 0` — the locator's own numbers. */
function simpleGeometryText(counters) {
  const counts = counters || {};
  const width = typeof counts.codeWidthPx === 'number' && isFinite(counts.codeWidthPx)
    ? Math.round(counts.codeWidthPx) + 'px'
    : '—';
  const perCell = typeof counts.pixelsPerCell === 'number' && isFinite(counts.pixelsPerCell)
    ? counts.pixelsPerCell.toFixed(2) + 'px/cell'
    : '—';
  const contrast = typeof counts.contrast === 'number' && isFinite(counts.contrast)
    ? 'contrast ' + Math.round(counts.contrast)
    : 'contrast —';
  const rotation = typeof counts.rotation === 'number' && isFinite(counts.rotation)
    ? 'rot ' + counts.rotation
    : 'rot —';
  return width + ' · ' + perCell + ' · ' + contrast + ' · ' + rotation;
}

/** `12.3 s`, `0.4 s` — elapsed time as the PO reads it. */
function simpleElapsedText(ms) {
  return (numberOr(ms, 0) / 1000).toFixed(1) + ' s';
}

/** The sender label. The relay confirms a peer; a reachable socket is not a sender. */
function simpleSenderText(peerPresent, controlConnected) {
  if (peerPresent) return 'CONNECTED / 已连接';
  return controlConnected ? 'SOCKET ONLY / 仅通道' : 'NOT CONNECTED / 未连接';
}

/** The camera label: frames must be ARRIVING, not merely requested. */
function simpleCameraText(running, callbackActive) {
  return running && callbackActive ? 'READY / 就绪' : 'NOT READY / 未就绪';
}

/** The one-line result detail shown under the verdict. */
function simpleDetailText(status, reason, counters) {
  const counts = counters || {};
  if (status === SIMPLE_STATUS_PASS) {
    return reason === 'static-decodes'
      ? 'static alignment OK (' + numberOr(counts.successfulDecodes, 0) + ' decodes)'
      : 'SHA-256 MATCH · ' + numberOr(counts.assembledBytes, 0) + ' B';
  }
  if (status === SIMPLE_STATUS_FAIL) {
    if (reason === 'static-timeout') return 'only ' + numberOr(counts.successfulDecodes, 0)
      + ' decodes in ' + (SIMPLE_STATIC_TIMEOUT_MS / 1000) + ' s — align the phone';
    if (reason === 'receive-timeout') return 'timeout after ' + (SIMPLE_RECEIVE_TIMEOUT_MS / 1000)
      + ' s at ' + numberOr(counts.uniqueReceived, 0) + ' / ' + numberOr(counts.totalChunks, SIMPLE_TOTAL_CHUNKS) + ' chunks';
    if (reason === 'sha-mismatch') return 'all chunks received but SHA-256 MISMATCH';
    if (reason === 'baseline-total-chunks') return 'baseline mismatch: '
      + numberOr(counts.totalChunks, 0) + ' chunks, expected ' + SIMPLE_TOTAL_CHUNKS;
    if (reason === 'baseline-file-bytes') return 'baseline mismatch: '
      + numberOr(counts.fileLength, 0) + ' B, expected ' + SIMPLE_FILE_BYTES + ' B';
    if (reason === 'file-length') return 'all chunks received but length is '
      + numberOr(counts.assembledBytes, 0) + ' B, expected ' + SIMPLE_FILE_BYTES + ' B';
    return String(reason || 'failed');
  }
  if (status === SIMPLE_STATUS_RECEIVING) return 'receiving';
  return 'tap START RECEIVE / 点击开始接收';
}

/**
 * The SMALL result artefact: the PO's field list, and nothing else. Every value is a
 * LOCAL measurement or a local digest; `networkPayloadPath` declares the payload path.
 */
function simpleResultJson(input) {
  const state = input || {};
  const counts = state.counters || {};
  return {
    buildId: state.buildId || null,
    mode: state.mode || 'simple-receive',
    status: state.status || SIMPLE_STATUS_IDLE,
    reason: state.reason || null,
    startedAtIso: state.startedAtIso || null,
    finishedAtIso: state.finishedAtIso || null,
    elapsedMs: numberOr(state.elapsedMs, 0),

    cameraFrames: numberOr(counts.cameraFrames, 0),
    decodeAttempts: numberOr(counts.decodeAttempts, 0),
    successfulDecodes: numberOr(counts.successfulDecodes, 0),
    crcFailures: numberOr(counts.crcFailures, 0),
    locateFailures: numberOr(counts.locateFailures, 0),

    uniqueReceived: numberOr(counts.uniqueReceived, 0),
    totalChunks: numberOr(counts.totalChunks, SIMPLE_TOTAL_CHUNKS),
    assembledBytes: numberOr(counts.assembledBytes, 0),
    fileLength: numberOr(counts.fileLength, SIMPLE_FILE_BYTES),

    receivedChunkIndexes: state.receivedChunkIndexes || '',
    missingChunkIndexes: state.missingChunkIndexes || '',
    decodedChunkCounts: state.decodedChunkCounts || '',
    metadataRejects: numberOr(state.metadataRejects, 0),
    foreignChunkRejects: numberOr(state.foreignChunkRejects, 0),
    duplicateChunks: numberOr(state.duplicateChunks, 0),

    sha256: state.sha256 || null,
    manifestSha256: state.manifestSha256 || null,
    shaResult: counts.shaResult || 'INCOMPLETE',

    observedCodeWidthPx: numberOr(counts.codeWidthPx, null),
    pixelsPerCell: numberOr(counts.pixelsPerCell, null),
    contrast: numberOr(counts.contrast, null),
    rotation: numberOr(counts.rotation, null),

    networkPayloadPath: 'NONE',
  };
}

module.exports = {
  SIMPLE_KIND_RECEIVE,
  SIMPLE_KIND_STATIC,
  SIMPLE_TOTAL_CHUNKS,
  SIMPLE_CHUNK_DATA_BYTES,
  SIMPLE_FILE_BYTES,
  SIMPLE_CAMERA_READY_TIMEOUT_MS,
  SIMPLE_RECEIVE_TIMEOUT_MS,
  SIMPLE_STATIC_TIMEOUT_MS,
  SIMPLE_STATIC_MIN_DECODES,
  SIMPLE_MAX_UI_HZ,
  SIMPLE_STATUS_IDLE,
  SIMPLE_STATUS_RECEIVING,
  SIMPLE_STATUS_PASS,
  SIMPLE_STATUS_FAIL,
  simpleRun,
  simpleDecision,
  simpleProgressText,
  simpleDecodeText,
  simpleGeometryText,
  simpleElapsedText,
  simpleSenderText,
  simpleCameraText,
  simpleDetailText,
  simpleResultJson,
};
