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
}

export function emptyReceiverSample(): Tf012AutoReceiverSample {
  return {
    observedCodeWidthPx: null, pixelsPerCellX: null, pixelsPerCellY: null,
    reservedPatternScore: null, contrast: null, frameRotationIndex: null,
    callbackFps: null, processingFps: null, activeProcessAvgMs: null,
    activeProcessP95Ms: null, cameraFrames: 0, processedFrames: 0, decodeAttempts: 0,
    successfulDecodes: 0, crcFailures: 0, locateFailures: 0,
    uniqueReceived: 0, decodedChunkIndexes: [],
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
  /** Deltas / interval seconds — step-scoped, cannot inherit a UI-window artefact. */
  callbackFps: number | null;
  processingFps: number | null;
}

function delta(from: number, to: number): number {
  return Math.max(0, to - from);
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

/**
 * Every way a run can end. Only COMPLETE asserts a controlled experiment; anything the
 * harness could not verify lands on a named failure instead of a silent success.
 */
export type Tf012AutoRunStatus =
  | 'COMPLETE'
  | 'ABORTED'
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
  /** When SETUP actually began (first fresh sender telemetry). */
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

export interface Tf012AutoSetupGateResult {
  ready: boolean;
  label: 'SETUP READY / 取景条件就绪' | 'SETUP NOT READY / 取景条件未就绪';
  reasons: string[];
  evidence: Tf012AutoReceiverSample;
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
  /** Human-readable progress hook for the UI. */
  onProgress?: (progress: Tf012AutoProgress) => void;
}

export interface Tf012AutoProgress {
  phase: 'WAITING_FOR_SENDER' | 'SETUP' | 'CONFIRMING' | 'STEP' | 'STOPPING' | 'DONE' | 'ABORTED';
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

  private phase: 'IDLE' | 'WAITING_FOR_SENDER' | 'SETUP' | 'CONFIRMING' | 'RUNNING' | 'STOPPING' | 'DONE' | 'ABORTED' = 'IDLE';
  private requestedAt = 0;
  private startedAt = 0;
  private finishedAt = 0;
  private runtime: StepRuntime | null = null;
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
  }

  /** Step results frozen so far — appended, never rewritten. */
  stepResults(): readonly Tf012AutoStepResult[] {
    return this.results;
  }

  finalResult(): Tf012AutoRunResult | null {
    return this.runResult;
  }

  /** Begin: wait for a REAL sender peer before any step may be measured. */
  start(nowMs: number): void {
    if (this.phase !== 'IDLE') return;
    this.requestedAt = nowMs;
    this.phase = 'WAITING_FOR_SENDER';
    this.gate = null;
    this.emitProgress(nowMs);
  }

  abort(reason: string): void {
    if (this.phase === 'DONE' || this.phase === 'ABORTED') return;
    this.abortedReason = 'ABORTED';
    this.abortDetail = reason;
    this.phase = 'ABORTED';
    this.ports.send(tf012AutoCommand('STOP', {runId: this.runId}));
    // An operator abort still produces a final, honest artefact: the steps that were
    // actually measured are preserved, and the status says ABORTED rather than COMPLETE.
    this.finish(this.finishedAt || this.monotonicNow(), 'ABORTED');
  }

  /** The host clock, used only for the abort path's final timestamp. */
  private monotonicNow(): number {
    return this.finishedAt || this.requestedAt;
  }

  /** Fresh sender telemetry age, or null when none was ever received. */
  private telemetryAgeMs(nowMs: number): number | null {
    const at = this.ports.link.telemetryAt();
    return at == null ? null : Math.max(0, nowMs - at);
  }

  private telemetryIsFresh(nowMs: number): boolean {
    const age = this.telemetryAgeMs(nowMs);
    return age != null && age <= TF012_AUTO_TELEMETRY_FRESH_MS;
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
    if (this.phase === 'IDLE' || this.phase === 'DONE' || this.phase === 'ABORTED') return;

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

    if (this.phase === 'SETUP') {
      if (!this.runtime) { this.emitProgress(nowMs); return; }
      const violation = this.staticInvariantViolation();
      if (violation) { this.failRun('STATIC_INVARIANT_VIOLATION', violation, nowMs); return; }
      if (nowMs - this.runtime.issuedAt >= this.setupStep.durationMs) {
        this.gate = evaluateTf012AutoSetupGate(this.ports.receiverSample());
        this.staticInvariants.push({
          id: 'static_setup_invariant', ok: true,
          detail: 'SETUP observed chunk 0 only',
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

  /** WAITING_FOR_SENDER → SETUP needs all three: socket, HELLO, fresh telemetry. */
  private tickWaitingForSender(nowMs: number): void {
    const helloAt = this.ports.link.senderHelloAt();
    if (helloAt != null && this.senderHelloAt == null) this.senderHelloAt = helloAt;
    // A sender that goes away invalidates the handshake: the run must not begin on a
    // stale "connected" flag.
    if (helloAt == null) this.senderHelloAt = null;
    const connected = this.ports.link.controlConnected();
    const fresh = this.telemetryIsFresh(nowMs);
    if (connected && helloAt != null && fresh) {
      this.startedAt = nowMs;
      this.phase = 'SETUP';
      this.runtime = {
        step: this.setupStep,
        issuedAt: nowMs,
        measuredAt: nowMs,
        pauseIssuedAt: null,
        pauseConfirmedAt: null,
        paused: false,
        intervalStart: null,
        stepStartSample: null,
        confirmDeadlineAt: nowMs + TF012_AUTO_COMMAND_CONFIRM_TIMEOUT_MS,
      };
      this.ports.resetReceiverMetrics();
      const setupStart = this.ports.receiverSample();
      this.runtime.intervalStart = setupStart;
      this.runtime.stepStartSample = setupStart;
      this.ports.send(tf012AutoCommand('SET_MODE', {
        runId: this.runId, stepId: this.setupStep.id, mode: 'static', chunkIndex: this.setupStep.chunkIndex,
      }));
      this.ports.send(tf012AutoCommand('START', {runId: this.runId, stepId: this.setupStep.id}));
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
      runtime.intervalStart = this.ports.receiverSample();
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
        runtime.intervalStart = this.ports.receiverSample();
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
      const receiver = this.ports.receiverSample();
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
      return `${step.id} is STATIC chunk0 but chunk ${offender} was decoded`;
    }
    const uniqueDelta = now.uniqueReceived - start.uniqueReceived;
    if (uniqueDelta > 1) {
      return `${step.id} is STATIC chunk0 but ${uniqueDelta} unique chunks arrived`;
    }
    return null;
  }

  /** Abort with a named status, always STOPping the sender first. */
  private failRun(status: Tf012AutoRunStatus, detail: string, nowMs: number): void {
    this.abortedReason = status;
    this.abortDetail = detail;
    this.phase = 'ABORTED';
    this.ports.send(tf012AutoCommand('STOP', {runId: this.runId}));
    this.finish(nowMs, status);
  }

  private beginStep(index: number, nowMs: number): void {
    const step = this.steps[index];
    this.phase = 'CONFIRMING';
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
    this.runtime.stepStartSample = this.ports.receiverSample();
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

  private freezeStep(sender: Tf012AutoSenderSample, receiver: Tf012AutoReceiverSample, nowMs: number): void {
    if (!this.runtime) return;
    const {step, issuedAt, measuredAt, paused} = this.runtime;
    const startedAt = measuredAt ?? issuedAt;
    const actualDurationMs = Math.max(0, nowMs - startedAt);
    const intervalStart = this.runtime.intervalStart ?? receiver;
    const interval = tf012AutoIntervalMetrics(intervalStart, receiver, actualDurationMs);
    // The whole step, including the window before the sender state was confirmed.
    const stepInterval = tf012AutoIntervalMetrics(
      this.runtime.stepStartSample ?? receiver, receiver, Math.max(0, nowMs - issuedAt));
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
      this.staticInvariants.push({
        id: `static_${step.id}_invariant`,
        ok: true,
        detail: `${step.id} observed chunk 0 only`,
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
    for (const step of this.steps) {
      if (step.id === 'A4') continue;
      const check = this.confirmations.find((entry) => entry.id === `confirm_${step.id}`);
      checks.push(check ?? {id: `confirm_${step.id}`, ok: false, detail: 'step never confirmed'});
    }
    const pauseCheck = this.confirmations.find((entry) => entry.id === 'confirm_A4_pause');
    checks.push(pauseCheck ?? {id: 'confirm_A4_pause', ok: false, detail: 'A4 pause never confirmed'});
    for (const id of ['static_setup_invariant', 'static_A1_invariant', 'static_A5_invariant']) {
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
    this.finishedAt = nowMs;
    const validity = this.evaluateValidity();
    // The r14 rule: COMPLETE is only permitted when every validity check passed. A run
    // that cannot prove it was controlled is HARNESS_INVALID, never a silent success.
    const finalStatus: Tf012AutoRunStatus = status === 'COMPLETE' && !validity.valid
      ? 'HARNESS_INVALID'
      : status;
    const result: Tf012AutoRunResult = {
      runId: this.runId,
      buildId: this.buildId,
      planVersion: this.planVersion,
      device: this.device,
      startedAtIso: new Date(this.startedAt || this.requestedAt).toISOString(),
      finishedAtIso: new Date(nowMs).toISOString(),
      status: finalStatus,
      validity,
      timeline: {
        requestedAtIso: new Date(this.requestedAt).toISOString(),
        senderHelloAtIso: this.senderHelloAt == null ? null : new Date(this.senderHelloAt).toISOString(),
        setupStartedAtIso: this.startedAt ? new Date(this.startedAt).toISOString() : null,
        stopSentAtIso: this.stopSentAt == null ? null : new Date(this.stopSentAt).toISOString(),
        stopConfirmedAtIso: this.stopConfirmedAt == null ? null : new Date(this.stopConfirmedAt).toISOString(),
      },
      setupGate: this.gate ?? evaluateTf012AutoSetupGate(this.ports.receiverSample()),
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
    this.emitProgress(nowMs);
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
    const remainingMs = step
      ? (step.id === 'A4'
        ? Math.max(0, (step.runMs ?? 0) + (step.pauseMs ?? 0) - elapsed)
        : Math.max(0, step.durationMs - elapsed))
      : 0;
    this.ports.onProgress({
      phase: this.phase === 'IDLE' ? 'WAITING_FOR_SENDER'
        : this.phase === 'RUNNING' ? 'STEP' : this.phase,
      // The run outcome, never a connection state: a later socket update cannot
      // overwrite COMPLETE / ABORTED / SETUP_NOT_READY on either UI.
      status: this.runResult?.status
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
