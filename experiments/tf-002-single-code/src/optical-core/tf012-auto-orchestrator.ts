/**
 * TF-012 r13 — AUTO PHYSICAL TEST ORCHESTRATOR (platform-neutral state machine).
 *
 * The phone runs this; the browser sender and the Node tests use the same code. It is
 * a deterministic machine: it NEVER reads a clock or a timer itself — the host calls
 * `tick(nowMs)` and every decision is a pure function of the injected time, the
 * injected control port and the injected receiver sampler. That is what makes the
 * sequence order, the step/holdMs synchronisation, the pause split and the frozen
 * results unit-testable without a phone or a browser.
 *
 * The orchestrator sends CONTROL only. The receiver metrics it freezes come from the
 * local optical receiver — never from the network.
 */
import {
  TF012_AUTO_PLAN_VERSION,
  TF012_AUTO_SETUP_STEP,
  TF012_AUTO_STEPS,
  TF012_AUTO_STEP_COUNT,
  tf012AutoCommand,
  tf012AutoExpectedSenderState,
  tf012AutoSenderStateLabel,
  tf012AutoSenderStateMismatch,
  tf012AutoStepLabel,
  type Tf012AutoEnvelope,
  type Tf012AutoMode,
  type Tf012AutoSenderState,
  type Tf012AutoStep,
} from './tf012-auto-plan.ts';

/** r19: local analysis of the frames the decoder rejected. */
export interface Tf012AutoCrcDiagnostics {
  failedFrames: number;
  analysedFrames: number;
  distinctFingerprints: number;
  topFingerprint: string | null;
  topFingerprintCount: number;
  fingerprintHistogram: Record<string, number>;
  stableBitCount: number | null;
  analysedBitCount: number | null;
  meanBitFlipVsPrevious: number | null;
  headerInvalidFrames: number;
  crcMismatchFrames: number;
}

export function emptyCrcDiagnostics(): Tf012AutoCrcDiagnostics {
  return {
    failedFrames: 0, analysedFrames: 0, distinctFingerprints: 0,
    topFingerprint: null, topFingerprintCount: 0, fingerprintHistogram: {},
    stableBitCount: null, analysedBitCount: null, meanBitFlipVsPrevious: null,
    headerInvalidFrames: 0, crcMismatchFrames: 0,
  };
}

/** r19: the sampling geometry one frame was decoded with. */
export interface Tf012AutoGeometrySample {
  boundingBox: {x: number; y: number; width: number; height: number};
  pixelsPerCell: number;
  phaseX: number;
  phaseY: number;
  rotation: number;
  refinementScore: number;
  reservedPatternScore: number;
  contrast: number;
  threshold: number;
  candidates: number;
  seeds: number;
  refined: number;
  bestSeedScore: number;
  secondSeedScore: number;
  selectedCandidate: number;
  stage: string;
  stageReason: string;
}

export interface Tf012AutoGeometryDiagnostics {
  failure: Tf012AutoGeometrySample | null;
  success: Tf012AutoGeometrySample | null;
}

/**
 * r19: camera callback + processing timing, measured by the HOST.
 *
 * Cumulative since the host's last metric reset (which the orchestrator triggers at every
 * step boundary), so the frozen snapshot is exact for that step and the deltas are real
 * interval quantities. This is the runtime evidence for "is frame processing starving the
 * orchestrator?" — exposure is NEVER inferred from it.
 */
export interface Tf012AutoCameraTiming {
  callbackCount: number;
  callbackIntervalAvgMs: number | null;
  callbackIntervalP50Ms: number | null;
  callbackIntervalP95Ms: number | null;
  callbackIntervalMaxMs: number | null;
  processCount: number;
  processSumMs: number;
  processDurationAvgMs: number | null;
  processDurationP50Ms: number | null;
  processDurationP95Ms: number | null;
  processDurationMaxMs: number | null;
}

export function emptyCameraTiming(): Tf012AutoCameraTiming {
  return {
    callbackCount: 0,
    callbackIntervalAvgMs: null, callbackIntervalP50Ms: null, callbackIntervalP95Ms: null,
    callbackIntervalMaxMs: null,
    processCount: 0, processSumMs: 0,
    processDurationAvgMs: null, processDurationP50Ms: null, processDurationP95Ms: null,
    processDurationMaxMs: null,
  };
}

/** The camera-timing evidence for one interval: exact deltas + end-of-window percentiles. */
export interface Tf012AutoCameraTimingDelta {
  durationMs: number;
  callbackCount: number;
  callbackIntervalAvgMs: number | null;
  callbackIntervalP50Ms: number | null;
  callbackIntervalP95Ms: number | null;
  callbackIntervalMaxMs: number | null;
  processCount: number;
  processSumMs: number;
  processDurationAvgMs: number | null;
  processDurationP50Ms: number | null;
  processDurationP95Ms: number | null;
  processDurationMaxMs: number | null;
  /** Fraction of the interval the JS thread spent inside frame processing (0..1). */
  processingDutyRatio: number | null;
}

export function tf012AutoCameraTimingDelta(
  start: Tf012AutoCameraTiming,
  end: Tf012AutoCameraTiming,
  durationMs: number,
): Tf012AutoCameraTimingDelta {
  const callbackCount = Math.max(0, end.callbackCount - start.callbackCount);
  const processCount = Math.max(0, end.processCount - start.processCount);
  const processSumMs = Math.max(0, end.processSumMs - start.processSumMs);
  return {
    durationMs,
    callbackCount,
    callbackIntervalAvgMs: callbackCount > 0 ? durationMs / callbackCount : null,
    // Percentiles are end-of-window values from the host's bounded sample ring: exact for
    // the trailing window, labelled as such rather than pretending to be interval quantiles.
    callbackIntervalP50Ms: end.callbackIntervalP50Ms,
    callbackIntervalP95Ms: end.callbackIntervalP95Ms,
    callbackIntervalMaxMs: end.callbackIntervalMaxMs,
    processCount,
    processSumMs,
    processDurationAvgMs: processCount > 0 ? processSumMs / processCount : null,
    processDurationP50Ms: end.processDurationP50Ms,
    processDurationP95Ms: end.processDurationP95Ms,
    processDurationMaxMs: end.processDurationMaxMs,
    processingDutyRatio: durationMs > 0 ? processSumMs / durationMs : null,
  };
}

/** Live optical-receiver evidence for one instant. Every field is locally measured. */
export interface Tf012AutoReceiverSample {
  observedCodeWidthPx: number | null;
  pixelsPerCellX: number | null;
  pixelsPerCellY: number | null;
  reservedPatternScore: number | null;
  contrast: number | null;
  frameRotationIndex: number | null;
  callbackFps: number | null;
  processingFps: number | null;
  activeProcessAvgMs: number | null;
  activeProcessP95Ms: number | null;
  cameraFrames: number;
  /** Frames that reached the decoder — needed for a step-scoped processing FPS. */
  processedFrames: number;
  decodeAttempts: number;
  successfulDecodes: number;
  crcFailures: number;
  locateFailures: number;
  uniqueReceived: number;
  decodedChunkIndexes: number[];
  /**
   * r18: optical decodes per chunk index, measured by the LOCAL receiver (duplicates
   * included). Never derived from sender telemetry — the network says what the sender
   * intended to show, this says what the camera actually resolved.
   */
  acceptedDecodeCountByChunkIndex: Record<string, number>;
  /** r19: local analysis of the rejected frames (fingerprints, stable bits, CRC stage). */
  crcDiagnostics: Tf012AutoCrcDiagnostics;
  /** r19: the sampling geometry the CRC stage actually used. */
  geometry: Tf012AutoGeometryDiagnostics;
  /** r19: camera callback/processing timing since the host's last metric reset. */
  cameraTiming: Tf012AutoCameraTiming;
}

export function emptyReceiverSample(): Tf012AutoReceiverSample {
  return {
    observedCodeWidthPx: null, pixelsPerCellX: null, pixelsPerCellY: null,
    reservedPatternScore: null, contrast: null, frameRotationIndex: null,
    callbackFps: null, processingFps: null, activeProcessAvgMs: null,
    activeProcessP95Ms: null, cameraFrames: 0, processedFrames: 0, decodeAttempts: 0,
    successfulDecodes: 0, crcFailures: 0, locateFailures: 0,
    uniqueReceived: 0, decodedChunkIndexes: [], acceptedDecodeCountByChunkIndex: {},
    crcDiagnostics: emptyCrcDiagnostics(), geometry: {failure: null, success: null},
    cameraTiming: emptyCameraTiming(),
  };
}

// ---------------------------------------------------------------------------
// r14 — interval metrics, sender link, freshness and validity
// ---------------------------------------------------------------------------

/**
 * Metrics for ONE measurement interval, as deltas over that interval.
 *
 * r13 froze cumulative counters, so the A4 "duringPause" block was really the whole
 * step and the analyst had to subtract by hand. Every frozen interval now carries its
 * own duration and deltas, and its own FPS computed from those deltas — the 500 ms UI
 * window is never used as evidence.
 */
export interface Tf012AutoIntervalMetrics {
  durationMs: number;
  cameraFramesDelta: number;
  processedFramesDelta: number;
  decodeAttemptsDelta: number;
  successfulDecodesDelta: number;
  crcFailuresDelta: number;
  locateFailuresDelta: number;
  uniqueReceivedDelta: number;
  /** Chunk indexes FIRST observed inside this interval (not the cumulative set). */
  decodedChunkIndexes: number[];
  /** r18: decodes GAINED in this interval, per chunk index (deltas only, > 0). */
  acceptedDecodeCountByChunkIndex: Record<string, number>;
  /** Deltas / interval seconds — step-scoped, cannot inherit a UI-window artefact. */
  callbackFps: number | null;
  processingFps: number | null;
}

function delta(from: number, to: number): number {
  return Math.max(0, to - from);
}

/**
 * Per-index decode counts gained between two snapshots (r18).
 *
 * Keys are chunk indexes; only indexes with a POSITIVE gain appear, so an empty object
 * means "this interval decoded nothing", not "the histogram failed to load".
 */
export function tf012AutoChunkDecodeDelta(
  start: Record<string, number>,
  end: Record<string, number>,
): Record<string, number> {
  const gained: Record<string, number> = {};
  for (const key of Object.keys(end)) {
    const difference = delta(start[key] ?? 0, end[key]);
    if (difference > 0) gained[key] = difference;
  }
  return gained;
}

export function tf012AutoIntervalMetrics(
  start: Tf012AutoReceiverSample,
  end: Tf012AutoReceiverSample,
  durationMs: number,
): Tf012AutoIntervalMetrics {
  const seconds = durationMs / 1000;
  const cameraFramesDelta = delta(start.cameraFrames, end.cameraFrames);
  const processedFramesDelta = delta(start.processedFrames, end.processedFrames);
  return {
    durationMs,
    cameraFramesDelta,
    processedFramesDelta,
    decodeAttemptsDelta: delta(start.decodeAttempts, end.decodeAttempts),
    successfulDecodesDelta: delta(start.successfulDecodes, end.successfulDecodes),
    crcFailuresDelta: delta(start.crcFailures, end.crcFailures),
    locateFailuresDelta: delta(start.locateFailures, end.locateFailures),
    uniqueReceivedDelta: delta(start.uniqueReceived, end.uniqueReceived),
    decodedChunkIndexes: end.decodedChunkIndexes.filter(
      (index) => !start.decodedChunkIndexes.includes(index),
    ),
    acceptedDecodeCountByChunkIndex: tf012AutoChunkDecodeDelta(
      start.acceptedDecodeCountByChunkIndex, end.acceptedDecodeCountByChunkIndex,
    ),
    callbackFps: seconds > 0 ? cameraFramesDelta / seconds : null,
    processingFps: seconds > 0 ? processedFramesDelta / seconds : null,
  };
}

/**
 * What the orchestrator must know about the SENDER PEER before it may measure anything.
 *
 * A phone socket being connected to the relay is NOT a sender: r13 proved that by
 * producing a COMPLETE run in which no sender telemetry ever arrived. All three signals
 * below are required, and the telemetry timestamp is compared against the local clock so
 * a stale sample can never be mistaken for a live one.
 */
export interface Tf012AutoSenderLink {
  /** The phone's own control socket is open. Necessary, never sufficient. */
  controlConnected: () => boolean;
  /** Host-clock timestamp of the relay-confirmed sender HELLO, or null. */
  senderHelloAt: () => number | null;
  /** Host-clock timestamp of the last sender TELEMETRY message, or null. */
  telemetryAt: () => number | null;
}

/**
 * Live CAMERA acquisition state, measured by the HOST (the phone).
 *
 * r17 exists because of a physical run that reported SETUP_NOT_READY — an OPTICAL
 * verdict — while the phone was decoding STATIC chunk 0 at 97.95% with a 0.998 reserved
 * score. The gate had been evaluated against a receiver that had never processed a
 * single frame for this run: the harness had spent its 5 s setup window before the
 * camera pipeline was feeding it, and then blamed the framing.
 *
 * A relay connection is not a sender (r14); by the same rule, a camera VIEW is not
 * camera ACQUISITION. The run may not begin measuring until frames are actually
 * arriving AND reaching the single-code baseline pipeline.
 */
export interface Tf012AutoCameraStatus {
  /** The frame listener exists and has been started. */
  listening: boolean;
  /** At least one CameraFrame callback has fired since the listener started. */
  callbackActive: boolean;
  /** Monotonic count of camera frames delivered to the page (never reset mid-run). */
  framesReceived: number;
  /**
   * Monotonic count of frames actually INGESTED by the single-code baseline receiver.
   * This is what separates "the viewfinder is showing pixels" from "the pipeline the
   * setup gate reads is being fed" — the exact distinction r15b's run lacked.
   */
  baselineFrames: number;
  /** Host-clock timestamp of the newest camera frame, or null. */
  lastFrameAt: number | null;
}

/** A camera frame older than this is not evidence of live acquisition. */
export const TF012_AUTO_CAMERA_FRAME_FRESH_MS = 1000;
/** Frames that must arrive AFTER the run started looking, before SETUP may be issued. */
export const TF012_AUTO_CAMERA_MIN_FRAMES = 5;
/** Frames that must reach the BASELINE pipeline (proves the receiver is being fed). */
export const TF012_AUTO_CAMERA_MIN_BASELINE_FRAMES = 5;
/**
 * How long the harness waits for acquisition after the sender peer is ready. A camera
 * that never starts must END the run as CAMERA_NOT_READY — never as an optical verdict.
 */
export const TF012_AUTO_CAMERA_WAIT_TIMEOUT_MS = 15000;

/** The camera-readiness verdict, with the reasons a UI can show verbatim. */
export interface Tf012AutoCameraReadiness {
  ready: boolean;
  reasons: string[];
  /** Camera frames counted SINCE the run began waiting for the camera. */
  frames: number;
  /** Of those, how many reached the single-code baseline pipeline. */
  baselineFrames: number;
  lastFrameAgeMs: number | null;
}

/**
 * Decide whether camera acquisition is live, from counters measured by the host.
 *
 * Frames are counted as DELTAS against the baseline captured when the run started
 * waiting: "the camera delivered frames at some point earlier" is not readiness, it is
 * history. The baseline-pipeline count is required separately because a page that is not
 * running the single-code pipeline can deliver thousands of camera frames while the
 * receiver the gate reads stays at zero — precisely the r15b physical signature.
 */
export function tf012AutoCameraReadiness(
  status: Tf012AutoCameraStatus,
  nowMs: number,
  baseline: {framesReceived: number; baselineFrames: number},
): Tf012AutoCameraReadiness {
  const reasons: string[] = [];
  const frames = Math.max(0, status.framesReceived - baseline.framesReceived);
  const baselineFrames = Math.max(0, status.baselineFrames - baseline.baselineFrames);
  const lastFrameAgeMs = status.lastFrameAt == null ? null : Math.max(0, nowMs - status.lastFrameAt);
  if (!status.listening) reasons.push('camera frame listener is not running');
  if (!status.callbackActive) reasons.push('no CameraFrame callback has fired yet');
  if (lastFrameAgeMs == null) reasons.push('no camera frame has ever arrived');
  else if (lastFrameAgeMs > TF012_AUTO_CAMERA_FRAME_FRESH_MS) {
    reasons.push(`newest camera frame is ${lastFrameAgeMs} ms old`);
  }
  if (frames < TF012_AUTO_CAMERA_MIN_FRAMES) {
    reasons.push(`only ${frames} camera frames since the run started (need ${TF012_AUTO_CAMERA_MIN_FRAMES})`);
  }
  if (baselineFrames < TF012_AUTO_CAMERA_MIN_BASELINE_FRAMES) {
    reasons.push(`only ${baselineFrames} frames reached the single-code baseline pipeline (need ${TF012_AUTO_CAMERA_MIN_BASELINE_FRAMES})`);
  }
  return {ready: reasons.length === 0, reasons, frames, baselineFrames, lastFrameAgeMs};
}

/** Sender telemetry older than this is not evidence of anything. */
export const TF012_AUTO_TELEMETRY_FRESH_MS = 1500;
/** How long a step waits for telemetry to confirm the requested sender state. */
export const TF012_AUTO_COMMAND_CONFIRM_TIMEOUT_MS = 5000;
/** How long A4 waits for the PAUSE to be confirmed by telemetry. */
export const TF012_AUTO_PAUSE_CONFIRM_TIMEOUT_MS = 5000;
/** How long the run waits for broadcasting=false after A5's STOP. */
export const TF012_AUTO_STOP_CONFIRM_TIMEOUT_MS = 4000;
/**
 * A sender that stops reporting for this long ends the run. r13's failure mode was a
 * sender that never reported at all, so "wait forever" is not an option.
 */
export const TF012_AUTO_TELEMETRY_LOSS_MS = 5000;

// ---------------------------------------------------------------------------
// r18 — SCHEDULER TIMING / EVIDENCE INTEGRITY
// ---------------------------------------------------------------------------
//
// A physical r17 run measured A1 +2.6 s, A2 +1.1 s and A3 +30.5 s over plan, with a
// 19.3 s command→confirmation wait against a configured 5 s deadline. Every deadline in
// this machine is evaluated ON A TICK, so a stalled tick loop silently stretches every
// "bounded" wait and quietly turns a 25 s step into 55 s of different evidence. The
// instrumentation below makes that visible instead of averaging it away.

/**
 * A tick gap larger than this invalidates a step's timing.
 *
 * The phone schedules `tick()` every 250 ms. Normal jitter is bounded by one frame of
 * camera processing (~20-100 ms measured physically), so two cadences (~500 ms) is still
 * unremarkable. 1500 ms is SIX cadences: no plausible jitter or single-frame delay
 * explains it, which is exactly the signature of the 19 s / 30 s stalls observed in r17.
 */
export const TF012_AUTO_TIMING_STALL_THRESHOLD_MS = 1500;
/** How long a PO abort keeps observing telemetry for the STOP confirmation. */
export const TF012_AUTO_ABORT_STOP_TIMEOUT_MS = 3000;

export interface Tf012AutoTickStats {
  tickCount: number;
  tickIntervalAvgMs: number | null;
  tickIntervalP50Ms: number | null;
  tickIntervalP95Ms: number | null;
  tickIntervalMaxMs: number | null;
  largestTickGapMs: number | null;
  largestTickGapStartedAtIso: string | null;
  largestTickGapEndedAtIso: string | null;
}

/**
 * Whether a step's WALL-CLOCK evidence is trustworthy.
 *
 * `valid: false` never means "the physics failed" — it means the scheduler stalled, so
 * the planned duration is not the measured duration and the step must not be ranked on a
 * physical speed ladder as if it were.
 */
export interface Tf012AutoTimingIntegrity {
  valid: boolean;
  reason: 'OK' | 'ORCHESTRATOR_STALL';
  thresholdMs: number;
  largestTickGapMs: number | null;
  largestTickGapStartedAtIso: string | null;
  largestTickGapEndedAtIso: string | null;
}

export function emptyTickStats(): Tf012AutoTickStats {
  return {
    tickCount: 0,
    tickIntervalAvgMs: null, tickIntervalP50Ms: null, tickIntervalP95Ms: null,
    tickIntervalMaxMs: null,
    largestTickGapMs: null, largestTickGapStartedAtIso: null, largestTickGapEndedAtIso: null,
  };
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/** Accumulates tick intervals for one scope (the run, or one step). */
export class Tf012AutoTickTracker {
  private intervals: number[] = [];
  private lastTickAt: number | null = null;
  private largestGap: {ms: number; startedAt: number; endedAt: number} | null = null;
  private readonly cap: number;

  constructor(cap = 4096) {
    this.cap = cap;
  }

  reset(): void {
    this.intervals = [];
    this.lastTickAt = null;
    this.largestGap = null;
  }

  /** Record one tick. The first tick of a scope has no interval to measure. */
  note(nowMs: number): void {
    if (this.lastTickAt != null) {
      const gap = nowMs - this.lastTickAt;
      if (gap > 0) {
        if (this.intervals.length < this.cap) this.intervals.push(gap);
        if (!this.largestGap || gap > this.largestGap.ms) {
          this.largestGap = {ms: gap, startedAt: this.lastTickAt, endedAt: nowMs};
        }
      }
    }
    this.lastTickAt = nowMs;
  }

  stats(): Tf012AutoTickStats {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const sum = this.intervals.reduce((total, entry) => total + entry, 0);
    return {
      tickCount: this.intervals.length,
      tickIntervalAvgMs: this.intervals.length > 0 ? sum / this.intervals.length : null,
      tickIntervalP50Ms: percentile(sorted, 0.5),
      tickIntervalP95Ms: percentile(sorted, 0.95),
      tickIntervalMaxMs: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
      largestTickGapMs: this.largestGap ? this.largestGap.ms : null,
      largestTickGapStartedAtIso: this.largestGap ? new Date(this.largestGap.startedAt).toISOString() : null,
      largestTickGapEndedAtIso: this.largestGap ? new Date(this.largestGap.endedAt).toISOString() : null,
    };
  }

  integrity(): Tf012AutoTimingIntegrity {
    const stats = this.stats();
    const stalled = stats.largestTickGapMs != null && stats.largestTickGapMs > TF012_AUTO_TIMING_STALL_THRESHOLD_MS;
    return {
      valid: !stalled,
      reason: stalled ? 'ORCHESTRATOR_STALL' : 'OK',
      thresholdMs: TF012_AUTO_TIMING_STALL_THRESHOLD_MS,
      largestTickGapMs: stats.largestTickGapMs,
      largestTickGapStartedAtIso: stats.largestTickGapStartedAtIso,
      largestTickGapEndedAtIso: stats.largestTickGapEndedAtIso,
    };
  }
}

/** Who ended the run. Analysts must not have to infer this from timestamps. */
export type Tf012AutoAbortSource = 'PO_STOP' | 'HARNESS' | 'CAMERA' | 'SENDER' | 'CONTROL';

/** The r18 abort record: when, by whom, why, and whether the carrier stopped. */
export interface Tf012AutoAbortInfo {
  source: Tf012AutoAbortSource;
  reason: string;
  detail: string;
  abortedAtIso: string;
  stopSentAtIso: string | null;
  /** Telemetry reported `broadcasting === false` during the post-abort window. */
  stopTelemetryConfirmed: boolean;
  stopTelemetryObservedAtIso: string | null;
}

/** Status → abort source: the machine names its own failures. */
function abortSourceForStatus(status: Tf012AutoRunStatus): Tf012AutoAbortSource {
  if (status === 'CAMERA_NOT_READY') return 'CAMERA';
  if (status === 'SENDER_STATE_NOT_CONFIRMED') return 'SENDER';
  return 'HARNESS';
}

/**
 * r19 — per-PHASE timing, so a SETUP stall cannot be confused with a STOPPING stall.
 *
 * The r18 run reported one run-wide `largestTickGapMs` dominated by the STOP/abort tail,
 * while SETUP had overshot its 5 s plan by 4.55 s on its own. Every phase now carries its
 * own tick statistics and its own plan-versus-actual comparison.
 */
export interface Tf012AutoPhaseTiming {
  phase: string;
  tickCount: number;
  tickIntervalAvgMs: number | null;
  tickIntervalP50Ms: number | null;
  tickIntervalP95Ms: number | null;
  tickIntervalMaxMs: number | null;
  largestTickGapMs: number | null;
  largestTickGapStartedAtIso: string | null;
  largestTickGapEndedAtIso: string | null;
  /** Plan for this phase when the plan defines one (SETUP, A1..A5), else null. */
  plannedDurationMs: number | null;
  actualDurationMs: number;
  overshootMs: number | null;
  timingValid: boolean;
}

/**
 * Every way a run can end. Only COMPLETE asserts a controlled experiment; anything the
 * harness could not verify lands on a named failure instead of a silent success.
 */
export type Tf012AutoRunStatus =
  | 'COMPLETE'
  | 'ABORTED'
  | 'CAMERA_NOT_READY'
  | 'SETUP_NOT_READY'
  | 'SENDER_STATE_NOT_CONFIRMED'
  | 'STATIC_INVARIANT_VIOLATION'
  | 'STOP_NOT_CONFIRMED'
  | 'HARNESS_INVALID';

export interface Tf012AutoValidityCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** The r14 gate: a run may claim COMPLETE only if every one of these checks passed. */
export interface Tf012AutoValidity {
  valid: boolean;
  checks: Tf012AutoValidityCheck[];
}


export interface Tf012AutoSenderSample {
  mode: Tf012AutoMode;
  holdMs: number | null;
  cursor: number | null;
  paused: boolean;
  broadcasting: boolean;
  canvasDevicePx: number | null;
  canvasHash: string | null;
  pausedAt: number | null;
  resumedAt: number | null;
}

export interface Tf012AutoStepResult {
  stepId: string;
  index: number;
  title: string;
  mode: Tf012AutoMode;
  holdMs: number | null;
  plannedDurationMs: number;
  /** When the commands for this step were issued. */
  requestedAtIso: string;
  /** When live telemetry confirmed the requested sender state. */
  confirmedAtIso: string;
  /** Measurement window bounds: confirmation → freeze. */
  startedAtIso: string;
  finishedAtIso: string;
  actualDurationMs: number;
  // ---- r18 timing evidence ---------------------------------------------------
  /** Commands-issued → confirmation observed, with the overshoot past the deadline. */
  confirmationRequestedAtIso: string;
  confirmationObservedAtIso: string | null;
  confirmationDeadlineMs: number;
  /** 0 when the state was proven inside the deadline, otherwise the excess. */
  confirmationOvershootMs: number;
  /** Whole-step bounds (commands → freeze) and how far they exceeded the plan. */
  stepStartedAtIso: string;
  stepPlannedDurationMs: number;
  stepMeasuredDurationMs: number;
  stepOvershootMs: number;
  /** A4 only: PAUSE request → PAUSE confirmation, with its own overshoot. */
  pauseRequestedAtIso: string | null;
  pauseConfirmedAtIso: string | null;
  pauseOvershootMs: number | null;
  /** Tick-loop statistics for THIS step, and whether its timing is trustworthy. */
  tickStats: Tf012AutoTickStats;
  timingIntegrity: Tf012AutoTimingIntegrity;
  /** r19: camera callback/processing timing for the measurement window. */
  cameraTiming: Tf012AutoCameraTimingDelta;
  /** r19: optical decode-failure analysis over the measurement window (local only). */
  crcDiagnostics: Tf012AutoCrcDiagnostics;
  /** r19: the sampling geometry the CRC stage used (best rejected / last accepted). */
  geometry: Tf012AutoGeometryDiagnostics;
  /** False means the sender never proved the requested state — the step is unusable. */
  senderConfirmed: boolean;
  senderStateRequested: string;
  /** Live sender telemetry, exactly as reported. */
  sender: Tf012AutoSenderSample;
  /** Step-scoped deltas + FPS for the MEASUREMENT window (confirmation → freeze). */
  interval: Tf012AutoIntervalMetrics;
  /**
   * Deltas for the WHOLE step (commands issued → freeze). This includes any frames the
   * carrier produced while the sender state was still unconfirmed, which is exactly the
   * window the static optical invariant must police.
   */
  stepInterval: Tf012AutoIntervalMetrics;
  /** Absolute end snapshot (raw counters, kept for audit). */
  receiver: Tf012AutoReceiverSample;
  /** Present for A4 only: the cyclic interval before the freeze. */
  beforePause?: {sender: Tf012AutoSenderSample; receiver: Tf012AutoReceiverSample; interval: Tf012AutoIntervalMetrics};
  /** Present for A4 only: the frozen interval, measured independently. */
  duringPause?: {sender: Tf012AutoSenderSample; receiver: Tf012AutoReceiverSample; interval: Tf012AutoIntervalMetrics};
}

export interface Tf012AutoRunTimeline {
  /** When the PO tapped the button. */
  requestedAtIso: string;
  /** When the relay-confirmed sender HELLO arrived. */
  senderHelloAtIso: string | null;
  /** r17: when camera acquisition was proven live (frames arriving into the baseline). */
  cameraReadyAtIso: string | null;
  /** r17: when the SETUP commands (static chunk 0) were issued. Starts no timer. */
  setupRequestedAtIso: string | null;
  /** r17: when live telemetry PROVED static chunk 0 running. Opens the setup window. */
  setupConfirmedAtIso: string | null;
  /**
   * When SETUP measuring actually began. Equal to `setupConfirmedAtIso` by construction:
   * the window opens on confirmation, never on command issue.
   */
  setupStartedAtIso: string | null;
  stopSentAtIso: string | null;
  stopConfirmedAtIso: string | null;
}

export interface Tf012AutoRunResult {
  runId: string;
  buildId: string | null;
  planVersion: string;
  device: string | null;
  startedAtIso: string;
  finishedAtIso: string;
  status: Tf012AutoRunStatus;
  /** The r14 gate: why this run may or may not claim COMPLETE. */
  validity: Tf012AutoValidity;
  /** r18: why the run ended, when, by whom, and whether the carrier stopped. */
  abort: Tf012AutoAbortInfo | null;
  /** r18: tick-loop statistics for the whole run. */
  scheduler: Tf012AutoTickStats;
  /** r18: whether the run's wall-clock evidence is trustworthy. */
  timingIntegrity: Tf012AutoTimingIntegrity;
  /** r19: tick statistics and plan-vs-actual per PHASE (SETUP vs STOPPING separated). */
  phaseTiming: Tf012AutoPhaseTiming[];
  /** r19: true when this artefact came from the short STATIC diagnostic probe. */
  probe: boolean;
  timeline: Tf012AutoRunTimeline;
  setupGate: Tf012AutoSetupGateResult;
  steps: Tf012AutoStepResult[];
  stepsCompleted: number;
  stepsPlanned: number;
  networkPayloadPath: 'NONE';
}

// ---------------------------------------------------------------------------
// SETUP GATE — evidence-based readiness, no hard px/cell threshold
// ---------------------------------------------------------------------------

/**
 * The evidence WINDOW the setup gate was evaluated over.
 *
 * Counters are DELTAS across the window (post-confirmation → gate evaluation), so the
 * phone can never display a live decode count from a different window next to a gate
 * verdict from this one without the two being labelled as different windows. The optical
 * readings (code width, px/cell, reserved score, contrast) are the end-of-window
 * snapshot: they are instantaneous measurements, not counters.
 */
export interface Tf012AutoSetupEvidenceWindow {
  startedAtIso: string;
  finishedAtIso: string;
  durationMs: number;
  cameraFrames: number;
  processedFrames: number;
  decodeAttempts: number;
  successfulDecodes: number;
  crcFailures: number;
  locateFailures: number;
  uniqueReceived: number;
  observedCodeWidthPx: number | null;
  pixelsPerCell: number | null;
  reservedPatternScore: number | null;
  contrast: number | null;
  frameRotationIndex: number | null;
}

export function tf012AutoSetupEvidenceWindow(
  start: Tf012AutoReceiverSample,
  end: Tf012AutoReceiverSample,
  startedAt: number,
  finishedAt: number,
): Tf012AutoSetupEvidenceWindow {
  return {
    startedAtIso: new Date(startedAt).toISOString(),
    finishedAtIso: new Date(finishedAt).toISOString(),
    durationMs: Math.max(0, finishedAt - startedAt),
    cameraFrames: delta(start.cameraFrames, end.cameraFrames),
    processedFrames: delta(start.processedFrames, end.processedFrames),
    decodeAttempts: delta(start.decodeAttempts, end.decodeAttempts),
    successfulDecodes: delta(start.successfulDecodes, end.successfulDecodes),
    crcFailures: delta(start.crcFailures, end.crcFailures),
    locateFailures: delta(start.locateFailures, end.locateFailures),
    uniqueReceived: delta(start.uniqueReceived, end.uniqueReceived),
    observedCodeWidthPx: end.observedCodeWidthPx,
    pixelsPerCell: end.pixelsPerCellX,
    reservedPatternScore: end.reservedPatternScore,
    contrast: end.contrast,
    frameRotationIndex: end.frameRotationIndex,
  };
}

export interface Tf012AutoSetupGateResult {
  ready: boolean;
  label: 'SETUP READY / 取景条件就绪' | 'SETUP NOT READY / 取景条件未就绪';
  reasons: string[];
  evidence: Tf012AutoReceiverSample;
  /** r17: the gate verdict's own interval. Null when SETUP never opened. */
  evidenceWindow: Tf012AutoSetupEvidenceWindow | null;
}

/** A reserved-pattern score below this means the locator is guessing, not locking. */
export const TF012_AUTO_GATE_MIN_RESERVED_SCORE = 0.55;
/** The observed code must be at least this wide in camera pixels to be worth trying. */
export const TF012_AUTO_GATE_MIN_CODE_WIDTH_PX = 120;

/**
 * Decide whether the physical setup is usable from the STATIC chunk-0 evidence.
 * Deliberately evidence-based: one valid decode plus a working locator is enough,
 * because 2.99 px/cell is already proven to decode. This gate exists to stop the
 * automated sequence from producing five useless steps, not to enforce a threshold
 * the hardware cannot meet.
 */
export function evaluateTf012AutoSetupGate(sample: Tf012AutoReceiverSample): Tf012AutoSetupGateResult {
  const reasons: string[] = [];
  if (sample.successfulDecodes < 1) reasons.push('no valid decode yet');
  if (sample.decodeAttempts > 0 && sample.locateFailures >= sample.decodeAttempts) {
    reasons.push('locator never locked');
  }
  if (sample.reservedPatternScore != null && sample.reservedPatternScore < TF012_AUTO_GATE_MIN_RESERVED_SCORE) {
    reasons.push(`reserved pattern score ${sample.reservedPatternScore.toFixed(3)} below ${TF012_AUTO_GATE_MIN_RESERVED_SCORE}`);
  }
  if (sample.observedCodeWidthPx != null && sample.observedCodeWidthPx < TF012_AUTO_GATE_MIN_CODE_WIDTH_PX) {
    reasons.push(`observed code width ${sample.observedCodeWidthPx.toFixed(1)} px below ${TF012_AUTO_GATE_MIN_CODE_WIDTH_PX} px`);
  }
  const ready = reasons.length === 0;
  return {
    ready,
    label: ready ? 'SETUP READY / 取景条件就绪' : 'SETUP NOT READY / 取景条件未就绪',
    reasons,
    evidence: sample,
    evidenceWindow: null,
  };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface Tf012AutoPorts {
  /** Send one validated control message to the sender. */
  send: (message: Tf012AutoEnvelope) => void;
  /** Read the sender's latest telemetry (last message received), if any. */
  senderSample: () => Tf012AutoSenderSample;
  /** Read the local optical receiver's live evidence. */
  receiverSample: () => Tf012AutoReceiverSample;
  /** Reset the local receiver metrics at a step boundary. */
  resetReceiverMetrics: () => void;
  /** Freeze one immutable step result. Must never overwrite an earlier one. */
  onStepResult: (result: Tf012AutoStepResult) => void;
  onRunResult: (result: Tf012AutoRunResult) => void;
  /** Handshake + freshness signals for the sender peer. */
  link: Tf012AutoSenderLink;
  /**
   * r17: live camera-acquisition state. Required, not optional — a harness that can run
   * without proving acquisition is the defect this revision removes.
   */
  cameraStatus: () => Tf012AutoCameraStatus;
  /** Human-readable progress hook for the UI. */
  onProgress?: (progress: Tf012AutoProgress) => void;
}

export interface Tf012AutoProgress {
  phase:
    | 'WAITING_FOR_SENDER'
    | 'WAITING_FOR_CAMERA'
    | 'CONFIRMING_SETUP'
    | 'SETUP'
    | 'CONFIRMING'
    | 'STEP'
    | 'STOPPING'
    | 'DONE'
    | 'ABORTED';
  /** The run outcome so far; never overwritten by a later connection update. */
  status: Tf012AutoRunStatus | 'RUNNING' | 'WAITING_FOR_SENDER';
  stepId: string | null;
  label: string;
  stepIndex: number;
  stepCount: number;
  remainingMs: number;
  paused: boolean;
  /** Phone control socket open. */
  senderConnected: boolean;
  /** Relay-confirmed sender HELLO received. */
  senderHello: boolean;
  /** Age of the newest sender telemetry, ms (null = never). */
  telemetryAgeMs: number | null;
  telemetryFresh: boolean;
  /** r17: camera acquisition is live (frames arriving into the baseline pipeline). */
  cameraReady: boolean;
  /** r17: why the camera is not ready yet, or the frame counts once it is. */
  cameraDetail: string;
  /** r17: telemetry has proved the sender is in the requested SETUP state. */
  setupConfirmed: boolean;  /** r17: the setup measurement interval is open (nothing before this is setup evidence). */
  setupWindowOpen: boolean;
  /** r18: ticks measured so far, the largest gap, and whether timing is still valid. */
  tickCount: number;
  largestTickGapMs: number | null;
  timingIntegrityValid: boolean;
  /** r18: the abort source once the run has ended (null while it is still running). */
  abortSource: Tf012AutoAbortSource | null;
  /** The requested sender state for the active step, e.g. "CYCLIC 1000 ms". */
  requested: string;
  /** True once telemetry proved the sender is in the requested state. */
  senderConfirmed: boolean;
  /** Why the sender does not yet match, when it does not. */
  senderMismatch: string | null;
  pauseRequested: boolean;
  pauseConfirmed: boolean;
  frozenCursor: number | null;
  /** The ACTIVE step's declared hold time; null for static steps. The phone sets its
   *  own declaration from this value, so both ends follow one definition. */
  holdMs: number | null;
}

export interface Tf012AutoOrchestratorOptions {
  runId: string;
  buildId?: string | null;
  device?: string | null;
  ports: Tf012AutoPorts;
  /** Override the plan (tests). Defaults to the shipped A1..A5 plan. */
  steps?: readonly Tf012AutoStep[];
  setupStep?: Tf012AutoStep;
  /** r19: this artefact is the short STATIC diagnostic probe, not the A1..A5 sweep. */
  probe?: boolean;
}

interface StepRuntime {
  step: Tf012AutoStep;
  /** Commands for this step were issued at this instant. */
  issuedAt: number;
  /** Telemetry confirmed the requested state at this instant (starts measurement). */
  measuredAt: number | null;
  /** A4: PAUSE was issued at this instant. */
  pauseIssuedAt: number | null;
  /** A4: telemetry confirmed the freeze at this instant. */
  pauseConfirmedAt: number | null;
  paused: boolean;
  /** Interval start snapshot used for every delta of the measurement window. */
  intervalStart: Tf012AutoReceiverSample | null;
  /** Whole-step baseline (taken right after the step's metric reset). */
  stepStartSample: Tf012AutoReceiverSample | null;
  /** Hard deadline for state confirmation. */
  confirmDeadlineAt: number;
}

/**
 * Deterministic orchestrator. Host contract:
 *   start(nowMs)  → validates the gate prerequisites and issues the first commands
 *   tick(nowMs)   → advances the machine; safe to call at any frequency
 *   abort(reason) → stops the run without producing a COMPLETE result
 */
export class Tf012AutoOrchestrator {
  readonly runId: string;
  readonly planVersion = TF012_AUTO_PLAN_VERSION;
  private readonly steps: readonly Tf012AutoStep[];
  private readonly setupStep: Tf012AutoStep;
  private readonly ports: Tf012AutoPorts;
  private readonly buildId: string | null;
  private readonly device: string | null;
  private readonly probe: boolean;

  private phase: 'IDLE' | 'WAITING_FOR_SENDER' | 'WAITING_FOR_CAMERA' | 'CONFIRMING_SETUP' | 'SETUP' | 'CONFIRMING' | 'RUNNING' | 'STOPPING' | 'ABORTED_OBSERVING' | 'DONE' | 'ABORTED' = 'IDLE';
  private requestedAt = 0;
  private startedAt = 0;
  private finishedAt = 0;
  private runtime: StepRuntime | null = null;
  // ---- r18 scheduler instrumentation ------------------------------------------
  /** Tick-loop statistics for the WHOLE run. */
  private readonly runTicks = new Tf012AutoTickTracker();
  /** Tick-loop statistics for the ACTIVE step (reset at every step boundary). */
  private readonly stepTicks = new Tf012AutoTickTracker();
  /** r19: one tracker per PHASE, opened/closed as the machine moves through them. */
  private readonly phaseTrackers = new Map<string, {
    tracker: Tf012AutoTickTracker;
    startedAt: number;
    endedAt: number | null;
    plannedDurationMs: number | null;
  }>();
  private currentPhaseKey: string | null = null;
  /** The last tick instant the machine saw, used when an abort has no explicit clock. */
  private lastTickAt: number | null = null;
  // ---- r18 abort lifecycle ----------------------------------------------------
  private pendingAbort: Tf012AutoAbortInfo | null = null;
  private pendingAbortStatus: Tf012AutoRunStatus | null = null;
  private abortObserveUntil = 0;
  // ---- r17 camera pre-flight -------------------------------------------------
  /** When the run began waiting for camera acquisition. */
  private cameraWaitStartedAt: number | null = null;
  /** Frame counters captured when the wait began: readiness counts DELTAS from here. */
  private cameraBaselineFrames = 0;
  private cameraBaselinePipelineFrames = 0;
  /** When acquisition was proven live; null means SETUP may not be issued. */
  private cameraReadyAt: number | null = null;
  private cameraReadiness: Tf012AutoCameraReadiness | null = null;
  // ---- r17 setup sequencing --------------------------------------------------
  /** When the SETUP commands were issued (no timer runs from here). */
  private setupRequestedAt: number | null = null;
  /** When telemetry proved static chunk 0: the instant the setup window opens. */
  private setupConfirmedAt: number | null = null;
  /** Receiver snapshot taken right after the post-confirmation reset. */
  private setupWindowStart: Tf012AutoReceiverSample | null = null;
  private setupWindowStartedAt: number | null = null;
  private readonly results: Tf012AutoStepResult[] = [];
  private gate: Tf012AutoSetupGateResult | null = null;
  private abortedReason: Tf012AutoRunStatus | null = null;
  private abortDetail = '';
  private beforePauseSnapshot: {
    sender: Tf012AutoSenderSample;
    receiver: Tf012AutoReceiverSample;
    interval: Tf012AutoIntervalMetrics;
  } | null = null;
  private runResult: Tf012AutoRunResult | null = null;
  private senderHelloAt: number | null = null;
  private stopSentAt: number | null = null;
  private stopConfirmedAt: number | null = null;
  /** Every step's confirmation outcome, for the final validity gate. */
  private readonly confirmations: Tf012AutoValidityCheck[] = [];
  private readonly staticInvariants: Tf012AutoValidityCheck[] = [];
  private pauseConfirmed = false;
  private frozenCursor: number | null = null;
  /**
   * A4 deliberately leaves the carrier frozen, so the NEXT step must resume it —
   * otherwise it can never confirm "running" and the run would abort at A5. r14 found
   * this by test: the sender stays paused after PAUSE CURRENT FRAME.
   */
  private resumeNeeded = false;

  constructor(options: Tf012AutoOrchestratorOptions) {
    this.runId = options.runId;
    this.steps = options.steps ?? TF012_AUTO_STEPS;
    this.setupStep = options.setupStep ?? TF012_AUTO_SETUP_STEP;
    this.ports = options.ports;
    this.buildId = options.buildId ?? null;
    this.device = options.device ?? null;
    this.probe = options.probe === true;
  }

  /** Step results frozen so far — appended, never rewritten. */
  stepResults(): readonly Tf012AutoStepResult[] {
    return this.results;
  }

  finalResult(): Tf012AutoRunResult | null {
    return this.runResult;
  }

  /** Begin: wait for a REAL sender peer, then for a LIVE camera, before any step. */
  start(nowMs: number): void {
    if (this.phase !== 'IDLE') return;
    this.requestedAt = nowMs;
    this.phase = 'WAITING_FOR_SENDER';
    this.gate = null;
    this.runTicks.reset();
    this.runTicks.note(nowMs);
    this.emitProgress(nowMs);
  }

  /**
   * Host-driven abort (the PO pressed Stop, or the runner is tearing the session down).
   *
   * r17 defect this fixes: the final JSON reported `finishedAtIso` EARLIER than
   * `startedAtIso`, because the abort path fell back to `requestedAt` when no clock was
   * available. An abort now carries its real instant, its source and its reason, and the
   * machine keeps observing telemetry briefly so the artefact can state whether the
   * carrier actually stopped.
   */
  abort(reason: string, options: {source?: Tf012AutoAbortSource; detail?: string; nowMs?: number} = {}): void {
    if (this.phase === 'DONE' || this.phase === 'ABORTED' || this.phase === 'ABORTED_OBSERVING') return;
    const at = options.nowMs ?? this.lastTickAt ?? this.requestedAt;
    this.beginAbort('ABORTED', options.source ?? 'PO_STOP', reason, options.detail ?? reason, at);
  }

  /** Fresh sender telemetry age, or null when none was ever received. */
  private telemetryAgeMs(nowMs: number): number | null {
    const at = this.ports.link.telemetryAt();
    return at == null ? null : Math.max(0, nowMs - at);
  }

  /**
   * The phase key the clock is currently in. Steps report as their own id (A1..A5), the
   * setup gate as SETUP, the abort tail as ABORT_OBSERVATION — so a STOP-induced stall can
   * never be attributed to the measurement it followed.
   */
  private phaseKey(): string {
    switch (this.phase) {
      case 'CONFIRMING':
      case 'RUNNING':
        return this.runtime?.step.id ?? 'STEP';
      case 'ABORTED_OBSERVING':
        return 'ABORT_OBSERVATION';
      default:
        return this.phase;
    }
  }

  private plannedDurationForPhase(key: string): number | null {
    if (key === 'SETUP') return this.setupStep.durationMs;
    const step = this.steps.find((candidate) => candidate.id === key);
    return step ? step.durationMs : null;
  }

  /** Open/close phase scopes and record every tick against the ACTIVE phase. */
  private notePhase(nowMs: number): void {
    const key = this.phaseKey();
    if (key !== this.currentPhaseKey) {
      if (this.currentPhaseKey) {
        const closed = this.phaseTrackers.get(this.currentPhaseKey);
        if (closed) closed.endedAt = nowMs;
      }
      const existing = this.phaseTrackers.get(key);
      if (existing) {
        existing.endedAt = null;
      } else {
        this.phaseTrackers.set(key, {
          tracker: new Tf012AutoTickTracker(), startedAt: nowMs, endedAt: null,
          plannedDurationMs: this.plannedDurationForPhase(key),
        });
      }
      this.currentPhaseKey = key;
    }
    this.phaseTrackers.get(key)?.tracker.note(nowMs);
  }

  /** r19: every phase with its own tick statistics and its own overshoot. */
  private phaseTiming(): Tf012AutoPhaseTiming[] {
    const entries: Tf012AutoPhaseTiming[] = [];
    for (const [key, entry] of this.phaseTrackers) {
      const stats = entry.tracker.stats();
      const endedAt = entry.endedAt ?? entry.startedAt;
      const actualDurationMs = Math.max(0, endedAt - entry.startedAt);
      entries.push({
        phase: key,
        tickCount: stats.tickCount,
        tickIntervalAvgMs: stats.tickIntervalAvgMs,
        tickIntervalP50Ms: stats.tickIntervalP50Ms,
        tickIntervalP95Ms: stats.tickIntervalP95Ms,
        tickIntervalMaxMs: stats.tickIntervalMaxMs,
        largestTickGapMs: stats.largestTickGapMs,
        largestTickGapStartedAtIso: stats.largestTickGapStartedAtIso,
        largestTickGapEndedAtIso: stats.largestTickGapEndedAtIso,
        plannedDurationMs: entry.plannedDurationMs,
        actualDurationMs,
        overshootMs: entry.plannedDurationMs == null
          ? null
          : Math.max(0, actualDurationMs - entry.plannedDurationMs),
        timingValid: entry.tracker.integrity().valid,
      });
    }
    return entries;
  }

  /**
   * Deep-copy a receiver sample before storing it as interval evidence.
   *
   * The port contract is "return a FRESH snapshot", but a host that returns one mutable
   * object would silently corrupt every delta (the r13 note about shallow freezing). r18
   * made that risk concrete: the per-chunk histogram is an OBJECT, so a shallow copy
   * aliases it and the interval delta collapses to {} because start and end point at the
   * same map. The harness therefore copies what it keeps.
   */
  private capture(sample: Tf012AutoReceiverSample): Tf012AutoReceiverSample {
    return {
      ...sample,
      decodedChunkIndexes: [...sample.decodedChunkIndexes],
      acceptedDecodeCountByChunkIndex: {...sample.acceptedDecodeCountByChunkIndex},
      // r19: the new evidence blocks are objects too — copy them for the same reason.
      crcDiagnostics: {
        ...sample.crcDiagnostics,
        fingerprintHistogram: {...sample.crcDiagnostics.fingerprintHistogram},
      },
      cameraTiming: {...sample.cameraTiming},
      geometry: {
        failure: sample.geometry.failure
          ? {...sample.geometry.failure, boundingBox: {...sample.geometry.failure.boundingBox}}
          : null,
        success: sample.geometry.success
          ? {...sample.geometry.success, boundingBox: {...sample.geometry.success.boundingBox}}
          : null,
      },
    };
  }

  private telemetryIsFresh(nowMs: number): boolean {
    const age = this.telemetryAgeMs(nowMs);
    return age != null && age <= TF012_AUTO_TELEMETRY_FRESH_MS;
  }

  /** One line the UI can show verbatim: frame counts when ready, reasons when not. */
  private cameraDetailText(): string {
    if (this.cameraReadyAt != null) {
      const readiness = this.cameraReadiness;
      return readiness
        ? `live: ${readiness.frames} frames, ${readiness.baselineFrames} into the baseline pipeline`
        : 'live';
    }
    const readiness = this.cameraReadiness;
    if (!readiness) return 'not probed yet';
    const counts = `${readiness.frames} frames, ${readiness.baselineFrames} into the baseline pipeline`;
    const age = readiness.lastFrameAgeMs == null
      ? 'no frame yet'
      : `last frame ${readiness.lastFrameAgeMs} ms ago`;
    return `${counts}, ${age} — ${readiness.reasons.join('; ')}`;
  }

  /**
   * Has the sender proved the requested state? Requires FRESH telemetry that was also
   * produced AFTER the commands were issued, so a stale sample can never confirm a
   * command that was just sent.
   */
  private senderConfirmation(
    nowMs: number,
    expected: Tf012AutoSenderState,
    issuedAt: number,
  ): {confirmed: boolean; mismatch: string | null} {
    const at = this.ports.link.telemetryAt();
    if (!this.telemetryIsFresh(nowMs)) {
      return {confirmed: false, mismatch: 'sender telemetry is missing or stale'};
    }
    if (at != null && at < issuedAt) {
      return {confirmed: false, mismatch: 'sender telemetry predates the request'};
    }
    return {confirmed: tf012AutoSenderStateMismatch(this.ports.senderSample(), expected) === null,
      mismatch: tf012AutoSenderStateMismatch(this.ports.senderSample(), expected)};
  }

  /** Advance the machine. `nowMs` is the host clock in milliseconds. */
  tick(nowMs: number): void {
    if (this.phase === 'DONE' || this.phase === 'ABORTED') return;
    this.lastTickAt = nowMs;
    // r18: every tick is measured, so a stalled loop cannot hide in the averages.
    this.runTicks.note(nowMs);
    this.stepTicks.note(nowMs);
    // r19: and it is measured against the PHASE it belongs to.
    this.notePhase(nowMs);
    if (this.phase === 'IDLE') return;
    if (this.phase === 'ABORTED_OBSERVING') {
      this.tickAbortObservation(nowMs);
      return;
    }

    if (this.phase === 'WAITING_FOR_SENDER') {
      this.tickWaitingForSender(nowMs);
      return;
    }

    // Once a run is under way the sender must KEEP reporting: a peer that goes silent
    // mid-run invalidates every measurement after that point.
    const telemetryAge = this.telemetryAgeMs(nowMs);
    if (telemetryAge == null || telemetryAge > TF012_AUTO_TELEMETRY_LOSS_MS) {
      this.failRun('SENDER_STATE_NOT_CONFIRMED',
        telemetryAge == null ? 'sender telemetry never arrived' : `sender telemetry lost (${telemetryAge} ms)`, nowMs);
      return;
    }

    if (this.phase === 'WAITING_FOR_CAMERA') {
      this.tickWaitingForCamera(nowMs);
      return;
    }

    if (this.phase === 'CONFIRMING_SETUP') {
      this.tickConfirmingSetup(nowMs);
      return;
    }

    if (this.phase === 'SETUP') {
      if (!this.runtime || this.runtime.measuredAt == null) { this.emitProgress(nowMs); return; }
      const violation = this.staticInvariantViolation();
      if (violation) { this.failRun('STATIC_INVARIANT_VIOLATION', violation, nowMs); return; }
      if (nowMs - this.runtime.measuredAt >= this.setupStep.durationMs) {
        const endSample = this.ports.receiverSample();
        const window = tf012AutoSetupEvidenceWindow(
          this.setupWindowStart ?? endSample,
          endSample,
          this.setupWindowStartedAt ?? this.runtime.measuredAt,
          nowMs,
        );
        const setupFrames = window.cameraFrames;
        // r18: the gate is evaluated on a WINDOW-CONSISTENT sample. In r17 it still
        // carried the phone's 500 ms UI-window FPS (55.56) next to a 180/5.14 s window
        // (35.0) — a live-window number inside frozen evidence. Decode counts and optics
        // are end-of-window snapshots; the rates are now derived from the window itself.
        const windowSeconds = window.durationMs / 1000;
        const evidence: Tf012AutoReceiverSample = {
          ...endSample,
          callbackFps: windowSeconds > 0 ? window.cameraFrames / windowSeconds : null,
          processingFps: windowSeconds > 0 ? window.processedFrames / windowSeconds : null,
        };
        const gate = evaluateTf012AutoSetupGate(evidence);
        if (setupFrames === 0) {
          gate.reasons.unshift(`no camera frames arrived during SETUP (${window.durationMs} ms open)`);
        }
        // The gate is recorded BEFORE any guard can abort, so the frozen JSON always
        // carries the window and the sample the harness actually saw.
        this.gate = Object.freeze({...gate, evidenceWindow: window});
        // A setup hold with NO camera frames at all is a harness fault, not an optical
        // one. r15b reported SETUP_NOT_READY (an optics verdict) for exactly this state;
        // it must now be named as the acquisition problem it is.
        if (setupFrames === 0) {
          this.failRun('CAMERA_NOT_READY',
            `no camera frames arrived during SETUP (${window.durationMs} ms open)`, nowMs);
          return;
        }
        // r18: the SETUP static invariant is now COMPUTED, not asserted: every index the
        // camera accepted during the window must be chunk 0.
        const acceptedIndexes = this.staticScopeIndexes(endSample);
        const setupOffender = acceptedIndexes.find((index) => index !== 0);
        if (setupOffender !== undefined) {
          this.staticInvariants.push({
            id: 'static_setup_invariant', ok: false,
            detail: `SETUP accepted chunk ${setupOffender} (accepted: ${acceptedIndexes.join(', ')})`,
          });
          this.failRun('STATIC_INVARIANT_VIOLATION',
            `SETUP is STATIC chunk0 but chunk ${setupOffender} was accepted`, nowMs);
          return;
        }
        this.staticInvariants.push({
          id: 'static_setup_invariant', ok: true,
          detail: acceptedIndexes.length > 0
            ? `SETUP accepted chunk0 only (accepted: ${acceptedIndexes.join(', ')})`
            : 'SETUP accepted no chunk (the setup hold decoded nothing)',
        });
        if (!this.gate.ready) {
          this.failRun('SETUP_NOT_READY', this.gate.reasons.join('; ') || 'setup gate not ready', nowMs);
          return;
        }
        this.beginStep(0, nowMs);
      }
      this.emitProgress(nowMs);
      return;
    }

    if (this.phase === 'STOPPING') {
      this.tickStopping(nowMs);
      return;
    }

    if (!this.runtime) { this.emitProgress(nowMs); return; }
    if (this.phase === 'CONFIRMING') {
      this.tickConfirming(nowMs);
      return;
    }
    if (this.phase === 'RUNNING') {
      this.tickRunning(nowMs);
      return;
    }
    this.emitProgress(nowMs);
  }

  /**
   * WAITING_FOR_SENDER → WAITING_FOR_CAMERA needs all three: socket, HELLO, fresh
   * telemetry. r17: the sender being ready no longer starts SETUP — the setup gate
   * reads the PHONE's camera pipeline, so acquisition must be proven live first.
   */
  private tickWaitingForSender(nowMs: number): void {
    const helloAt = this.ports.link.senderHelloAt();
    if (helloAt != null && this.senderHelloAt == null) this.senderHelloAt = helloAt;
    // A sender that goes away invalidates the handshake: the run must not begin on a
    // stale "connected" flag.
    if (helloAt == null) this.senderHelloAt = null;
    const connected = this.ports.link.controlConnected();
    const fresh = this.telemetryIsFresh(nowMs);
    if (connected && helloAt != null && fresh) {
      this.phase = 'WAITING_FOR_CAMERA';
      this.startedAt = nowMs;
      this.cameraWaitStartedAt = nowMs;
      // Count frames from NOW. "The camera delivered frames before the PO tapped the
      // button" is history, not acquisition, and history is what made the r15b run look
      // like an optical failure.
      const status = this.ports.cameraStatus();
      this.cameraBaselineFrames = status.framesReceived;
      this.cameraBaselinePipelineFrames = status.baselineFrames;
    }
    this.emitProgress(nowMs);
  }

  /** WAITING_FOR_CAMERA → CONFIRMING_SETUP requires proven live acquisition. */
  private tickWaitingForCamera(nowMs: number): void {
    const readiness = tf012AutoCameraReadiness(this.ports.cameraStatus(), nowMs, {
      framesReceived: this.cameraBaselineFrames,
      baselineFrames: this.cameraBaselinePipelineFrames,
    });
    this.cameraReadiness = readiness;
    if (readiness.ready) {
      this.cameraReadyAt = nowMs;
      this.requestSetup(nowMs);
      this.emitProgress(nowMs);
      return;
    }
    if (this.cameraWaitStartedAt != null
      && nowMs - this.cameraWaitStartedAt >= TF012_AUTO_CAMERA_WAIT_TIMEOUT_MS) {
      this.failRun('CAMERA_NOT_READY',
        `camera acquisition was not live within ${TF012_AUTO_CAMERA_WAIT_TIMEOUT_MS} ms: ${readiness.reasons.join('; ')}`,
        nowMs);
      return;
    }
    this.emitProgress(nowMs);
  }

  /**
   * Issue the SETUP request. The commands go out here, but NOTHING is measured yet: the
   * setup window does not open until live telemetry proves the sender is static chunk 0
   * (see `tickConfirmingSetup`). r15b's physical run timed the window from this instant
   * and evaluated the gate against a receiver that had not yet produced a frame.
   */
  private requestSetup(nowMs: number): void {
    this.phase = 'CONFIRMING_SETUP';
    this.setupRequestedAt = nowMs;
    this.stepTicks.reset();
    this.stepTicks.note(nowMs);
    this.runtime = {
      step: this.setupStep,
      issuedAt: nowMs,
      measuredAt: null,
      pauseIssuedAt: null,
      pauseConfirmedAt: null,
      paused: false,
      intervalStart: null,
      stepStartSample: null,
      confirmDeadlineAt: nowMs + TF012_AUTO_COMMAND_CONFIRM_TIMEOUT_MS,
    };
    if (this.ports.senderSample().paused) {
      // A carrier left FROZEN by an aborted A4 can never confirm "static chunk 0
      // running", so it is released first — the same rule `beginStep` applies.
      this.ports.send(tf012AutoCommand('RESUME', {runId: this.runId, stepId: this.setupStep.id}));
    }
    this.ports.send(tf012AutoCommand('SET_MODE', {
      runId: this.runId, stepId: this.setupStep.id, mode: 'static', chunkIndex: this.setupStep.chunkIndex,
    }));
    this.ports.send(tf012AutoCommand('START', {runId: this.runId, stepId: this.setupStep.id}));
  }

  /**
   * CONFIRMING_SETUP → SETUP. The sender must PROVE static chunk 0 before the window
   * opens: mode=static, cursor=0, broadcasting=true, paused=false. The metric reset and
   * the window baseline happen at THIS instant, never at command issue time, so the gate
   * can only ever be evaluated over post-confirmation frames.
   */
  private tickConfirmingSetup(nowMs: number): void {
    const runtime = this.runtime;
    if (!runtime) { this.emitProgress(nowMs); return; }
    const expected = tf012AutoExpectedSenderState(this.setupStep);
    const {confirmed, mismatch} = this.senderConfirmation(nowMs, expected, runtime.issuedAt);
    if (confirmed) {
      runtime.measuredAt = nowMs;
      this.setupConfirmedAt = nowMs;
      this.confirmations.push({
        id: 'confirm_SETUP', ok: true,
        detail: `SETUP ${tf012AutoSenderStateLabel(expected)} confirmed by telemetry`,
      });
      this.ports.resetReceiverMetrics();
      const start = this.ports.receiverSample();
      runtime.intervalStart = start;
      runtime.stepStartSample = start;
      this.setupWindowStart = start;
      this.setupWindowStartedAt = nowMs;
      this.phase = 'SETUP';
      this.emitProgress(nowMs);
      return;
    }
    if (nowMs >= runtime.confirmDeadlineAt) {
      this.confirmations.push({id: 'confirm_SETUP', ok: false, detail: mismatch ?? 'not confirmed'});
      this.failRun('SENDER_STATE_NOT_CONFIRMED',
        `SETUP: ${mismatch ?? 'requested sender state not confirmed'}`, nowMs);
      return;
    }
    this.emitProgress(nowMs);
  }

  /** A step's commands are out; the measurement timer may not start until they land. */
  private tickConfirming(nowMs: number): void {
    const runtime = this.runtime!;
    const expected = tf012AutoExpectedSenderState(runtime.step);
    const {confirmed, mismatch} = this.senderConfirmation(nowMs, expected, runtime.issuedAt);
    if (confirmed) {
      runtime.measuredAt = nowMs;
      runtime.intervalStart = this.capture(this.ports.receiverSample());
      this.confirmations.push({
        id: `confirm_${runtime.step.id}`,
        ok: true,
        detail: tf012AutoSenderStateLabel(expected),
      });
      this.phase = 'RUNNING';
      this.emitProgress(nowMs);
      return;
    }
    if (nowMs >= runtime.confirmDeadlineAt) {
      this.confirmations.push({
        id: `confirm_${runtime.step.id}`,
        ok: false,
        detail: mismatch ?? 'not confirmed',
      });
      this.failRun('SENDER_STATE_NOT_CONFIRMED',
        `${runtime.step.id}: ${mismatch ?? 'requested sender state not confirmed'}`, nowMs);
      return;
    }
    this.emitProgress(nowMs);
  }

  private tickRunning(nowMs: number): void {
    const runtime = this.runtime!;
    const {step} = runtime;
    const measuredAt = runtime.measuredAt ?? nowMs;
    const elapsed = nowMs - measuredAt;

    // A4: request the freeze, then wait for telemetry to CONFIRM it before treating the
    // carrier as frozen.
    if (step.id === 'A4' && runtime.pauseIssuedAt != null && runtime.pauseConfirmedAt == null) {
      const sample = this.ports.senderSample();
      const at = this.ports.link.telemetryAt();
      const fresh = this.telemetryIsFresh(nowMs);
      const confirmed = fresh && at != null && at >= runtime.pauseIssuedAt
        && sample.paused === true && sample.cursor != null && sample.broadcasting === true;
      if (confirmed) {
        runtime.pauseConfirmedAt = nowMs;
        runtime.paused = true;
        this.pauseConfirmed = true;
        this.frozenCursor = sample.cursor;
        this.confirmations.push({
          id: 'confirm_A4_pause', ok: true,
          detail: `PAUSE confirmed by telemetry; frozen cursor ${String(sample.cursor)}`,
        });
        // The next step inherits a paused carrier, so it must be resumed first.
        this.resumeNeeded = true;
        // The frozen interval starts at CONFIRMATION, so "duringPause" is measured from
        // the moment the freeze was proven, not from the moment it was requested.
        runtime.intervalStart = this.capture(this.ports.receiverSample());
      } else if (nowMs - runtime.pauseIssuedAt >= TF012_AUTO_PAUSE_CONFIRM_TIMEOUT_MS) {
        this.confirmations.push({
          id: 'confirm_A4_pause', ok: false,
          detail: fresh ? 'telemetry never reported paused=true' : 'telemetry went stale before the pause was confirmed',
        });
        this.failRun('SENDER_STATE_NOT_CONFIRMED', 'A4: PAUSE CURRENT FRAME was not confirmed by telemetry', nowMs);
        return;
      }
      this.emitProgress(nowMs);
      return;
    }

    const violation = this.staticInvariantViolation();
    if (violation) { this.failRun('STATIC_INVARIANT_VIOLATION', violation, nowMs); return; }

    if (step.id === 'A4' && runtime.pauseIssuedAt == null && elapsed >= (step.runMs ?? 0)) {
      const receiver = this.capture(this.ports.receiverSample());
      const sender = this.ports.senderSample();
      // The "beforePause" interval is closed HERE: measured from confirmation to the
      // PAUSE request, with its own deltas, so nobody has to subtract counters later.
      this.beforePauseSnapshot = {
        sender,
        receiver,
        interval: tf012AutoIntervalMetrics(runtime.intervalStart ?? receiver, receiver, elapsed),
      };
      runtime.pauseIssuedAt = nowMs;
      this.ports.send(tf012AutoCommand('PAUSE', {
        // Report the frame that is ACTUALLY about to be frozen, so the frozen JSON
        // answers "which chunk did the pause hold?" instead of guessing.
        runId: this.runId, stepId: step.id, chunkIndex: sender.cursor,
      }));
      this.emitProgress(nowMs);
      return;
    }

    const stepEndsAt = step.id === 'A4'
      ? (runtime.pauseConfirmedAt ?? nowMs) + (step.pauseMs ?? 0)
      : measuredAt + step.durationMs;
    if (nowMs < stepEndsAt) {
      this.emitProgress(nowMs);
      return;
    }

    this.freezeStep(this.ports.senderSample(), this.ports.receiverSample(), nowMs);
    const nextIndex = this.steps.indexOf(step) + 1;
    if (nextIndex >= this.steps.length) {
      // A5 is frozen: completion requires the sender to actually stop.
      this.stopSentAt = nowMs;
      this.phase = 'STOPPING';
      this.ports.send(tf012AutoCommand('STOP', {runId: this.runId}));
      this.emitProgress(nowMs);
      return;
    }
    this.beginStep(nextIndex, nowMs);
    this.emitProgress(nowMs);
  }

  /** After A5: wait for broadcasting=false before the run may claim COMPLETE. */
  private tickStopping(nowMs: number): void {
    const sample = this.ports.senderSample();
    const at = this.ports.link.telemetryAt();
    const fresh = this.telemetryIsFresh(nowMs);
    const confirmed = fresh && at != null && this.stopSentAt != null && at >= this.stopSentAt
      && sample.broadcasting === false;
    if (confirmed) {
      this.stopConfirmedAt = nowMs;
      this.finish(nowMs, 'COMPLETE');
      return;
    }
    if (this.stopSentAt != null && nowMs - this.stopSentAt >= TF012_AUTO_STOP_CONFIRM_TIMEOUT_MS) {
      this.finish(nowMs, 'STOP_NOT_CONFIRMED');
      return;
    }
    this.emitProgress(nowMs);
  }

  /**
   * Optical cross-check: a static step that decodes anything other than chunk 0 proves
   * the sender is NOT in the requested state, whatever the network telemetry claims.
   *
   * r18: this check used to be blind, because the receiver exposed no chunk indexes and
   * every sample carried `decodedChunkIndexes: []`. It now reads TWO local signals:
   *   1. the accepted chunk indexes gained since the step began (`receivedIndices()`),
   *   2. the per-index decode histogram gained since the step began — which counts EVERY
   *      decode, including repeats of an already-held chunk, so a carrier that keeps
   *      showing chunk 3 is caught even though nothing new was stored.
   */
  private staticInvariantViolation(): string | null {
    const step = this.runtime?.step ?? null;
    if (!step) return null;
    if (step.mode !== 'static') return null;
    const start = this.runtime?.stepStartSample ?? null;
    if (!start) return null;
    const now = this.ports.receiverSample();
    const observed = now.decodedChunkIndexes.filter((index) => !start.decodedChunkIndexes.includes(index));
    const offender = observed.find((index) => index !== 0);
    if (offender !== undefined) {
      return `${step.id} is STATIC chunk0 but chunk ${offender} was accepted`;
    }
    const histogram = tf012AutoChunkDecodeDelta(
      start.acceptedDecodeCountByChunkIndex, now.acceptedDecodeCountByChunkIndex,
    );
    const decodedOffender = Object.keys(histogram).find((key) => key !== '0');
    if (decodedOffender !== undefined) {
      return `${step.id} is STATIC chunk0 but chunk ${decodedOffender} was decoded `
        + `(${histogram[decodedOffender]} frames)`;
    }
    const uniqueDelta = now.uniqueReceived - start.uniqueReceived;
    if (uniqueDelta > 1) {
      return `${step.id} is STATIC chunk0 but ${uniqueDelta} unique chunks arrived`;
    }
    return null;
  }

  /** r18: every OPTICALLY accepted index in a static scope must be chunk 0. */
  private staticScopeIndexes(sample: Tf012AutoReceiverSample): number[] {
    return [...sample.decodedChunkIndexes].sort((a, b) => a - b);
  }

  /**
   * Abort with a named status. The source follows the status, so an analyst never has to
   * infer "who ended this run" from timestamps.
   */
  private failRun(status: Tf012AutoRunStatus, detail: string, nowMs: number): void {
    this.beginAbort(status, abortSourceForStatus(status), status, detail, nowMs);
  }

  /**
   * Start an abort: record WHO/WHY/WHEN, send STOP, then keep observing telemetry for a
   * short window so the artefact can state whether the carrier actually stopped.
   */
  private beginAbort(
    status: Tf012AutoRunStatus,
    source: Tf012AutoAbortSource,
    reason: string,
    detail: string,
    at: number,
  ): void {
    this.abortedReason = status;
    this.abortDetail = detail;
    this.pendingAbortStatus = status;
    this.pendingAbort = {
      source,
      reason,
      detail,
      abortedAtIso: new Date(at).toISOString(),
      stopSentAtIso: new Date(at).toISOString(),
      stopTelemetryConfirmed: false,
      stopTelemetryObservedAtIso: null,
    };
    this.stopSentAt = at;
    this.phase = 'ABORTED_OBSERVING';
    this.abortObserveUntil = at + TF012_AUTO_ABORT_STOP_TIMEOUT_MS;
    this.ports.send(tf012AutoCommand('STOP', {runId: this.runId}));
    this.finishedAt = at;
    this.emitProgress(at);
  }

  /**
   * Post-abort window: the carrier has been told to STOP; record whether telemetry
   * confirms it. Bounded by TF012_AUTO_ABORT_STOP_TIMEOUT_MS so a dead peer cannot hang
   * the artefact, and never longer than needed when the answer arrives immediately.
   */
  private tickAbortObservation(nowMs: number): void {
    const abort = this.pendingAbort;
    if (!abort) { this.finalize(this.finishedAt, this.pendingAbortStatus ?? 'ABORTED'); return; }
    const sentAt = this.stopSentAt ?? nowMs;
    if (!abort.stopTelemetryConfirmed
      && this.telemetryIsFresh(nowMs)
      && this.ports.senderSample().broadcasting === false) {
      abort.stopTelemetryConfirmed = true;
      abort.stopTelemetryObservedAtIso = new Date(nowMs).toISOString();
    }
    this.emitProgress(nowMs);
    if (abort.stopTelemetryConfirmed || nowMs >= this.abortObserveUntil) {
      this.finalize(Math.max(this.finishedAt, sentAt), this.pendingAbortStatus ?? 'ABORTED');
    }
  }

  private beginStep(index: number, nowMs: number): void {
    const step = this.steps[index];
    this.phase = 'CONFIRMING';
    this.stepTicks.reset();
    this.stepTicks.note(nowMs);
    this.runtime = {
      step,
      issuedAt: nowMs,
      measuredAt: null,
      pauseIssuedAt: null,
      pauseConfirmedAt: null,
      paused: false,
      intervalStart: null,
      stepStartSample: null,
      confirmDeadlineAt: nowMs + TF012_AUTO_COMMAND_CONFIRM_TIMEOUT_MS,
    };
    this.beforePauseSnapshot = null;
    this.ports.resetReceiverMetrics();
    this.runtime.stepStartSample = this.capture(this.ports.receiverSample());
    if (this.resumeNeeded) {
      // Leaving A4's freeze: the carrier must be running again for this step to exist.
      this.resumeNeeded = false;
      this.ports.send(tf012AutoCommand('RESUME', {runId: this.runId, stepId: step.id}));
    }
    this.ports.send(tf012AutoCommand('SET_MODE', {
      runId: this.runId, stepId: step.id, mode: step.mode, chunkIndex: step.chunkIndex,
    }));
    if (step.holdMs != null) {
      // The sender's hold time is driven from the SAME step definition the phone
      // declares, so the two sides cannot drift apart.
      this.ports.send(tf012AutoCommand('SET_HOLD_MS', {
        runId: this.runId, stepId: step.id, holdMs: step.holdMs,
      }));
    }
    this.ports.send(tf012AutoCommand('START', {runId: this.runId, stepId: step.id}));
  }

  private freezeStep(sender: Tf012AutoSenderSample, receiverInput: Tf012AutoReceiverSample, nowMs: number): void {
    if (!this.runtime) return;
    // r18: the harness owns its evidence — copy the sample it is about to freeze.
    const receiver = this.capture(receiverInput);
    const {step, issuedAt, measuredAt, paused} = this.runtime;
    const startedAt = measuredAt ?? issuedAt;
    const actualDurationMs = Math.max(0, nowMs - startedAt);
    const intervalStart = this.runtime.intervalStart ?? receiver;
    const interval = tf012AutoIntervalMetrics(intervalStart, receiver, actualDurationMs);
    // The whole step, including the window before the sender state was confirmed.
    const stepInterval = tf012AutoIntervalMetrics(
      this.runtime.stepStartSample ?? receiver, receiver, Math.max(0, nowMs - issuedAt));
    const confirmationObservedAt = measuredAt;
    const confirmationOvershootMs = confirmationObservedAt == null
      ? 0
      : Math.max(0, (confirmationObservedAt - issuedAt) - TF012_AUTO_COMMAND_CONFIRM_TIMEOUT_MS);
    const stepMeasuredDurationMs = Math.max(0, nowMs - issuedAt);
    const tickStats = this.stepTicks.stats();
    const result: Tf012AutoStepResult = {
      stepId: step.id,
      index: step.index,
      title: step.title,
      mode: step.mode,
      holdMs: step.holdMs,
      plannedDurationMs: step.durationMs,
      requestedAtIso: new Date(issuedAt).toISOString(),
      confirmedAtIso: new Date(startedAt).toISOString(),
      startedAtIso: new Date(startedAt).toISOString(),
      finishedAtIso: new Date(nowMs).toISOString(),
      actualDurationMs,
      confirmationRequestedAtIso: new Date(issuedAt).toISOString(),
      confirmationObservedAtIso: confirmationObservedAt == null ? null : new Date(confirmationObservedAt).toISOString(),
      confirmationDeadlineMs: TF012_AUTO_COMMAND_CONFIRM_TIMEOUT_MS,
      confirmationOvershootMs,
      stepStartedAtIso: new Date(issuedAt).toISOString(),
      stepPlannedDurationMs: step.durationMs,
      stepMeasuredDurationMs,
      stepOvershootMs: Math.max(0, stepMeasuredDurationMs - step.durationMs),
      pauseRequestedAtIso: this.runtime.pauseIssuedAt == null
        ? null : new Date(this.runtime.pauseIssuedAt).toISOString(),
      pauseConfirmedAtIso: this.runtime.pauseConfirmedAt == null
        ? null : new Date(this.runtime.pauseConfirmedAt).toISOString(),
      pauseOvershootMs: this.runtime.pauseIssuedAt == null || this.runtime.pauseConfirmedAt == null
        ? null
        : Math.max(0, (this.runtime.pauseConfirmedAt - this.runtime.pauseIssuedAt) - TF012_AUTO_PAUSE_CONFIRM_TIMEOUT_MS),
      tickStats,
      timingIntegrity: this.stepTicks.integrity(),
      cameraTiming: tf012AutoCameraTimingDelta(
        intervalStart.cameraTiming, receiver.cameraTiming, actualDurationMs),
      crcDiagnostics: {...receiver.crcDiagnostics, fingerprintHistogram: {...receiver.crcDiagnostics.fingerprintHistogram}},
      geometry: {
        failure: receiver.geometry.failure ? {...receiver.geometry.failure, boundingBox: {...receiver.geometry.failure.boundingBox}} : null,
        success: receiver.geometry.success ? {...receiver.geometry.success, boundingBox: {...receiver.geometry.success.boundingBox}} : null,
      },
      senderConfirmed: measuredAt != null,
      senderStateRequested: tf012AutoSenderStateLabel(tf012AutoExpectedSenderState(step)),
      sender,
      // Frozen evidence carries STEP-SCOPED FPS only: the 500 ms UI window can never
      // leak into a result (that produced the 1000 FPS artefact in r13).
      receiver: {...receiver, callbackFps: interval.callbackFps, processingFps: interval.processingFps},
      interval,
      stepInterval,
    };
    if (step.id === 'A4') {
      const before = this.beforePauseSnapshot ?? {sender, receiver, interval};
      const duringStart = this.runtime.pauseConfirmedAt ?? startedAt;
      result.beforePause = before;
      result.duringPause = {
        sender,
        receiver,
        // Independent interval: measured from pause confirmation to the freeze, with its
        // own deltas. No cumulative counters for the analyst to subtract.
        interval: tf012AutoIntervalMetrics(before.receiver, receiver, Math.max(0, nowMs - duringStart)),
      };
    }
    if (step.mode === 'static') {
      // r18: computed from the LOCAL optical indexes the camera accepted during the
      // step, not asserted. (The r17 run could not have detected a wrong chunk here: the
      // receiver exposed no indexes, so the check had nothing to read.)
      const acceptedIndexes = this.staticScopeIndexes(receiver);
      const offender = acceptedIndexes.find((index) => index !== 0);
      this.staticInvariants.push({
        id: `static_${step.id}_invariant`,
        ok: offender === undefined,
        detail: offender !== undefined
          ? `${step.id} accepted chunk ${offender} (accepted: ${acceptedIndexes.join(', ')})`
          : (acceptedIndexes.length > 0
            ? `${step.id} accepted chunk0 only (accepted: ${acceptedIndexes.join(', ')})`
            : `${step.id} accepted no chunk`),
      });
    }
    // Append-only: a step result is frozen the moment it is produced and is never
    // rewritten, so a later step cannot corrupt an earlier measurement.
    this.results.push(Object.freeze(result) as Tf012AutoStepResult);
    this.ports.onStepResult(result);
    this.ports.send(tf012AutoCommand('STEP_COMPLETE', {
      runId: this.runId, stepId: step.id, paused,
      cursor: sender.cursor, mode: sender.mode, holdMs: sender.holdMs,
    }));
  }

  /**
   * The r14 validity gate. `COMPLETE` asserts a CONTROLLED experiment, so every check
   * below must hold: a sender peer existed, every step proved its requested state, the
   * static optical invariant held, A4's pause was confirmed, all five steps froze once,
   * and the sender reported itself stopped.
   */
  private evaluateValidity(): Tf012AutoValidity {
    const checks: Tf012AutoValidityCheck[] = [];
    const hello = this.senderHelloAt != null;
    checks.push({
      id: 'sender_hello', ok: hello,
      detail: hello ? 'relay-confirmed sender HELLO received' : 'no sender HELLO was ever received',
    });
    const telemetrySeen = this.ports.link.telemetryAt() != null;
    checks.push({
      id: 'sender_telemetry', ok: telemetrySeen,
      detail: telemetrySeen ? 'sender telemetry received' : 'no sender telemetry was ever received',
    });
    // The checks follow the PLAN, not a hardcoded A1..A5 list, so the r19 static probe is
    // judged by the same rules as the sweep (one step, one confirmation, one invariant)
    // instead of being failed for steps it never planned to run.
    for (const step of this.steps) {
      if (step.id === 'A4') continue;
      const check = this.confirmations.find((entry) => entry.id === `confirm_${step.id}`);
      checks.push(check ?? {id: `confirm_${step.id}`, ok: false, detail: 'step never confirmed'});
    }
    if (this.steps.some((step) => step.id === 'A4')) {
      const pauseCheck = this.confirmations.find((entry) => entry.id === 'confirm_A4_pause');
      checks.push(pauseCheck ?? {id: 'confirm_A4_pause', ok: false, detail: 'A4 pause never confirmed'});
    }
    const staticChecks = [
      'static_setup_invariant',
      ...this.steps.filter((step) => step.mode === 'static').map((step) => `static_${step.id}_invariant`),
    ];
    for (const id of staticChecks) {
      const check = this.staticInvariants.find((entry) => entry.id === id);
      checks.push(check ?? {id, ok: false, detail: 'static step never completed'});
    }
    const unique = new Set(this.results.map((entry) => entry.stepId));
    const resultsOk = this.results.length === this.steps.length && unique.size === this.steps.length;
    checks.push({
      id: 'frozen_results', ok: resultsOk,
      detail: `${this.results.length}/${this.steps.length} frozen exactly once`,
    });
    const stopped = this.stopConfirmedAt != null;
    checks.push({
      id: 'stop_confirmed', ok: stopped,
      detail: stopped ? 'sender reported broadcasting=false after A5' : 'STOP was not confirmed',
    });
    return {valid: checks.every((check) => check.ok), checks};
  }

  private finish(nowMs: number, status: Tf012AutoRunStatus): void {
    this.finalize(nowMs, status);
  }

  /**
   * Build and publish the final artefact.
   *
   * r18 rules encoded here:
   *   - `finishedAtIso` is the LATEST instant the run saw (`max(abort, last tick)`), so it
   *     can never precede `startedAtIso` — the r17 abort wrote a finish time in the past;
   *   - every non-COMPLETE result carries an explicit `abort` record (source, reason,
   *     detail, real instant, STOP sent, STOP confirmed by telemetry);
   *   - run-level tick statistics and a timing-integrity verdict are always present.
   */
  private finalize(nowMs: number, status: Tf012AutoRunStatus): void {
    const finishedAt = Math.max(nowMs, this.lastTickAt ?? 0, this.finishedAt, this.startedAt, this.requestedAt);
    this.finishedAt = finishedAt;
    // r19: close the open phase scope so its duration is the time actually spent in it.
    if (this.currentPhaseKey) {
      const open = this.phaseTrackers.get(this.currentPhaseKey);
      if (open && open.endedAt == null) open.endedAt = finishedAt;
    }
    const validity = this.evaluateValidity();
    // The r14 rule: COMPLETE is only permitted when every validity check passed. A run
    // that cannot prove it was controlled is HARNESS_INVALID, never a silent success.
    const finalStatus: Tf012AutoRunStatus = status === 'COMPLETE' && !validity.valid
      ? 'HARNESS_INVALID'
      : status;
    const abortInfo: Tf012AutoAbortInfo | null = finalStatus === 'COMPLETE'
      ? null
      : (this.pendingAbort ?? {
        source: abortSourceForStatus(finalStatus),
        reason: finalStatus,
        detail: this.abortDetail || 'run did not complete',
        abortedAtIso: new Date(finishedAt).toISOString(),
        stopSentAtIso: this.stopSentAt == null ? null : new Date(this.stopSentAt).toISOString(),
        stopTelemetryConfirmed: this.stopConfirmedAt != null,
        stopTelemetryObservedAtIso: this.stopConfirmedAt == null ? null : new Date(this.stopConfirmedAt).toISOString(),
      });
    const result: Tf012AutoRunResult = {
      runId: this.runId,
      buildId: this.buildId,
      planVersion: this.planVersion,
      device: this.device,
      startedAtIso: new Date(this.startedAt || this.requestedAt).toISOString(),
      finishedAtIso: new Date(finishedAt).toISOString(),
      status: finalStatus,
      validity,
      abort: abortInfo,
      scheduler: this.runTicks.stats(),
      timingIntegrity: this.runTicks.integrity(),
      phaseTiming: this.phaseTiming(),
      probe: this.probe,
      timeline: {
        requestedAtIso: new Date(this.requestedAt).toISOString(),
        senderHelloAtIso: this.senderHelloAt == null ? null : new Date(this.senderHelloAt).toISOString(),
        cameraReadyAtIso: this.cameraReadyAt == null ? null : new Date(this.cameraReadyAt).toISOString(),
        setupRequestedAtIso: this.setupRequestedAt == null ? null : new Date(this.setupRequestedAt).toISOString(),
        setupConfirmedAtIso: this.setupConfirmedAt == null ? null : new Date(this.setupConfirmedAt).toISOString(),
        setupStartedAtIso: this.setupWindowStartedAt == null ? null : new Date(this.setupWindowStartedAt).toISOString(),
        stopSentAtIso: this.stopSentAt == null ? null : new Date(this.stopSentAt).toISOString(),
        stopConfirmedAtIso: this.stopConfirmedAt == null ? null : new Date(this.stopConfirmedAt).toISOString(),
      },
      setupGate: this.gate ?? {...evaluateTf012AutoSetupGate(this.ports.receiverSample()), evidenceWindow: null},
      steps: [...this.results],
      stepsCompleted: this.results.length,
      stepsPlanned: this.steps.length,
      networkPayloadPath: 'NONE',
    };
    this.runResult = result;
    this.phase = finalStatus === 'COMPLETE' ? 'DONE' : 'ABORTED';
    this.ports.send(tf012AutoCommand(finalStatus === 'COMPLETE' ? 'RUN_COMPLETE' : 'RUN_ABORTED', {
      runId: this.runId,
      ...(finalStatus === 'COMPLETE'
        ? {steps: this.results.map((step) => step.stepId)}
        : {reason: `${finalStatus}: ${this.abortDetail || 'run did not complete'}`.slice(0, 180)}),
    }));
    this.ports.onRunResult(result);
    this.emitProgress(finishedAt);
  }

  private emitProgress(nowMs: number): void {
    if (!this.ports.onProgress) return;
    const step = this.runtime?.step ?? null;
    const expected = step ? tf012AutoExpectedSenderState(step) : null;
    const telemetryAgeMs = this.telemetryAgeMs(nowMs);
    const measuredAt = this.runtime?.measuredAt ?? null;
    const elapsed = measuredAt != null ? nowMs - measuredAt : 0;
    const senderConfirmed = measuredAt != null;
    const sample = this.ports.senderSample();
    // Keep the camera detail live while the run is still waiting for acquisition, so the
    // phone can show WHY it has not started instead of an unexplained pause.
    if (this.cameraReadyAt == null && this.phase === 'WAITING_FOR_CAMERA') {
      this.cameraReadiness = tf012AutoCameraReadiness(this.ports.cameraStatus(), nowMs, {
        framesReceived: this.cameraBaselineFrames,
        baselineFrames: this.cameraBaselinePipelineFrames,
      });
    }
    const remainingMs = step
      ? (step.id === 'A4'
        ? Math.max(0, (step.runMs ?? 0) + (step.pauseMs ?? 0) - elapsed)
        : Math.max(0, step.durationMs - elapsed))
      : 0;
    const stepTickStats = this.stepTicks.stats();
    this.ports.onProgress({
      phase: this.phase === 'IDLE' ? 'WAITING_FOR_SENDER'
        : this.phase === 'RUNNING' ? 'STEP'
          : this.phase === 'ABORTED_OBSERVING' ? 'ABORTED' : this.phase,
      // The run outcome, never a connection state: a later socket update cannot
      // overwrite COMPLETE / ABORTED / SETUP_NOT_READY on either UI. During the abort
      // observation the pending status is already shown, so the UI never flips back to
      // "RUNNING" while the machine finishes the STOP handshake.
      status: this.runResult?.status
        ?? this.pendingAbortStatus
        ?? (this.phase === 'WAITING_FOR_SENDER' ? 'WAITING_FOR_SENDER' : 'RUNNING'),
      stepId: step ? step.id : null,
      label: step ? tf012AutoStepLabel(step)
        : (this.phase === 'WAITING_FOR_SENDER' ? 'WAITING FOR PC SENDER' : 'AUTO TEST idle'),
      stepIndex: step && step.index > 0 ? step.index : 0,
      stepCount: this.steps.length,
      remainingMs,
      paused: Boolean(this.runtime?.paused),
      senderConnected: this.ports.link.controlConnected(),
      senderHello: this.ports.link.senderHelloAt() != null,
      telemetryAgeMs,
      telemetryFresh: telemetryAgeMs != null && telemetryAgeMs <= TF012_AUTO_TELEMETRY_FRESH_MS,
      cameraReady: this.cameraReadyAt != null,
      cameraDetail: this.cameraDetailText(),
      setupConfirmed: this.setupConfirmedAt != null,
      setupWindowOpen: this.phase === 'SETUP',
      tickCount: stepTickStats.tickCount,
      largestTickGapMs: stepTickStats.largestTickGapMs,
      timingIntegrityValid: this.stepTicks.integrity().valid,
      abortSource: this.pendingAbort ? this.pendingAbort.source : (this.runResult?.abort?.source ?? null),
      requested: expected ? tf012AutoSenderStateLabel(expected) : '—',
      senderConfirmed,
      senderMismatch: expected && !senderConfirmed
        ? tf012AutoSenderStateMismatch(sample, expected)
        : null,
      pauseRequested: this.runtime?.pauseIssuedAt != null,
      pauseConfirmed: this.pauseConfirmed,
      frozenCursor: this.frozenCursor,
      holdMs: step ? step.holdMs : null,
    });
  }
}

export function createTf012AutoOrchestrator(options: Tf012AutoOrchestratorOptions): Tf012AutoOrchestrator {
  return new Tf012AutoOrchestrator(options);
}

export {TF012_AUTO_STEP_COUNT};
