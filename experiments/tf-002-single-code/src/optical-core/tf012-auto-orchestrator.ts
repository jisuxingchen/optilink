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
  tf012AutoStepLabel,
  type Tf012AutoEnvelope,
  type Tf012AutoMode,
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
    activeProcessP95Ms: null, cameraFrames: 0, decodeAttempts: 0,
    successfulDecodes: 0, crcFailures: 0, locateFailures: 0,
    uniqueReceived: 0, decodedChunkIndexes: [],
  };
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
  startedAtIso: string;
  finishedAtIso: string;
  sender: Tf012AutoSenderSample;
  /** Present for A4 only: the metrics collected before and during the freeze. */
  beforePause?: {sender: Tf012AutoSenderSample; receiver: Tf012AutoReceiverSample};
  duringPause?: {sender: Tf012AutoSenderSample; receiver: Tf012AutoReceiverSample};
  receiver: Tf012AutoReceiverSample;
}

export interface Tf012AutoRunResult {
  runId: string;
  buildId: string | null;
  planVersion: string;
  device: string | null;
  startedAtIso: string;
  finishedAtIso: string;
  status: 'COMPLETE' | 'SETUP_NOT_READY' | 'ABORTED';
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
  /** Human-readable progress hook for the UI. */
  onProgress?: (progress: Tf012AutoProgress) => void;
}

export interface Tf012AutoProgress {
  phase: 'SETUP' | 'STEP' | 'DONE' | 'ABORTED';
  stepId: string | null;
  label: string;
  stepIndex: number;
  stepCount: number;
  remainingMs: number;
  paused: boolean;
  senderConnected: boolean;
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
  /** True when the sender is reachable; the run refuses to start otherwise. */
  senderConnected?: () => boolean;
}

interface StepRuntime {
  step: Tf012AutoStep;
  startedAt: number;
  /** A4: when PAUSE is issued. */
  pauseAt: number | null;
  paused: boolean;
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
  private readonly senderConnected: () => boolean;

  private phase: 'IDLE' | 'SETUP' | 'RUNNING' | 'DONE' | 'ABORTED' = 'IDLE';
  private startedAt = 0;
  private finishedAt = 0;
  private runtime: StepRuntime | null = null;
  private readonly results: Tf012AutoStepResult[] = [];
  private gate: Tf012AutoSetupGateResult | null = null;
  private abortedReason: string | null = null;
  private beforePauseSnapshot: {sender: Tf012AutoSenderSample; receiver: Tf012AutoReceiverSample} | null = null;
  private runResult: Tf012AutoRunResult | null = null;

  constructor(options: Tf012AutoOrchestratorOptions) {
    this.runId = options.runId;
    this.steps = options.steps ?? TF012_AUTO_STEPS;
    this.setupStep = options.setupStep ?? TF012_AUTO_SETUP_STEP;
    this.ports = options.ports;
    this.buildId = options.buildId ?? null;
    this.device = options.device ?? null;
    this.senderConnected = options.senderConnected ?? (() => true);
  }

  /** Step results frozen so far — appended, never rewritten. */
  stepResults(): readonly Tf012AutoStepResult[] {
    return this.results;
  }

  finalResult(): Tf012AutoRunResult | null {
    return this.runResult;
  }

  /** Begin: static chunk 0 for the setup-gate duration. */
  start(nowMs: number): void {
    if (this.phase !== 'IDLE') return;
    this.startedAt = nowMs;
    this.phase = 'SETUP';
    this.gate = null;
    this.runtime = {step: this.setupStep, startedAt: nowMs, pauseAt: null, paused: false};
    this.ports.resetReceiverMetrics();
    this.ports.send(tf012AutoCommand('SET_MODE', {
      runId: this.runId, stepId: this.setupStep.id, mode: 'static', chunkIndex: this.setupStep.chunkIndex,
    }));
    this.ports.send(tf012AutoCommand('START', {runId: this.runId, stepId: this.setupStep.id}));
    this.emitProgress(nowMs);
  }

  abort(reason: string): void {
    if (this.phase === 'DONE' || this.phase === 'ABORTED') return;
    this.abortedReason = reason;
    this.phase = 'ABORTED';
    this.ports.send(tf012AutoCommand('STOP', {runId: this.runId}));
    this.emitProgress(this.finishedAt || this.startedAt);
  }

  /** Advance the machine. `nowMs` is the host clock in milliseconds. */
  tick(nowMs: number): void {
    if (this.phase === 'IDLE' || this.phase === 'SETUP') {
      if (this.phase === 'IDLE') return;
      if (this.runtime && nowMs - this.runtime.startedAt >= this.setupStep.durationMs) {
        this.gate = evaluateTf012AutoSetupGate(this.ports.receiverSample());
        if (!this.gate.ready) {
          this.phase = 'ABORTED';
          this.abortedReason = 'SETUP_NOT_READY';
          this.ports.send(tf012AutoCommand('STOP', {runId: this.runId}));
          this.finish(nowMs, 'SETUP_NOT_READY');
          return;
        }
        this.beginStep(0, nowMs);
      }
      this.emitProgress(nowMs);
      return;
    }
    if (this.phase !== 'RUNNING' || !this.runtime) {
      this.emitProgress(nowMs);
      return;
    }
    const {step} = this.runtime;
    const elapsed = nowMs - this.runtime.startedAt;

    // A4: issue PAUSE CURRENT FRAME once, at runMs, and snapshot the "before" metrics.
    if (step.id === 'A4' && !this.runtime.paused && this.runtime.pauseAt != null && nowMs >= this.runtime.pauseAt) {
      this.beforePauseSnapshot = {sender: this.ports.senderSample(), receiver: this.ports.receiverSample()};
      this.ports.send(tf012AutoCommand('PAUSE', {
        // Report the frame that is ACTUALLY about to be frozen, so the frozen JSON
        // answers "which chunk did the pause hold?" instead of guessing.
        runId: this.runId, stepId: step.id, chunkIndex: this.beforePauseSnapshot.sender.cursor,
      }));
      this.runtime.paused = true;
    }

    if (elapsed < step.durationMs) {
      this.emitProgress(nowMs);
      return;
    }

    // Step finished: freeze it immutably, then move on.
    this.freezeStep(this.ports.senderSample(), this.ports.receiverSample(), nowMs);
    const nextIndex = this.steps.indexOf(step) + 1;
    if (nextIndex >= this.steps.length) {
      this.phase = 'DONE';
      this.finish(nowMs, 'COMPLETE');
      return;
    }
    this.beginStep(nextIndex, nowMs);
    this.emitProgress(nowMs);
  }

  private beginStep(index: number, nowMs: number): void {
    const step = this.steps[index];
    this.phase = 'RUNNING';
    this.runtime = {
      step,
      startedAt: nowMs,
      pauseAt: step.runMs != null ? nowMs + step.runMs : null,
      paused: false,
    };
    this.beforePauseSnapshot = null;
    this.ports.resetReceiverMetrics();
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
    const {step, startedAt, paused} = this.runtime;
    const result: Tf012AutoStepResult = {
      stepId: step.id,
      index: step.index,
      title: step.title,
      mode: step.mode,
      holdMs: step.holdMs,
      plannedDurationMs: step.durationMs,
      startedAtIso: new Date(startedAt).toISOString(),
      finishedAtIso: new Date(nowMs).toISOString(),
      sender,
      receiver,
    };
    if (step.id === 'A4') {
      result.beforePause = this.beforePauseSnapshot ?? {sender, receiver};
      result.duringPause = {sender, receiver};
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

  private finish(nowMs: number, status: Tf012AutoRunResult['status']): void {
    this.finishedAt = nowMs;
    const result: Tf012AutoRunResult = {
      runId: this.runId,
      buildId: this.buildId,
      planVersion: this.planVersion,
      device: this.device,
      startedAtIso: new Date(this.startedAt).toISOString(),
      finishedAtIso: new Date(nowMs).toISOString(),
      status,
      setupGate: this.gate ?? evaluateTf012AutoSetupGate(this.ports.receiverSample()),
      steps: [...this.results],
      stepsCompleted: this.results.length,
      stepsPlanned: this.steps.length,
      networkPayloadPath: 'NONE',
    };
    this.runResult = result;
    this.phase = status === 'COMPLETE' ? 'DONE' : 'ABORTED';
    this.ports.send(tf012AutoCommand(status === 'COMPLETE' ? 'RUN_COMPLETE' : 'RUN_ABORTED', {
      runId: this.runId,
      ...(status === 'COMPLETE'
        ? {steps: this.results.map((step) => step.stepId)}
        : {reason: this.abortedReason ?? status}),
    }));
    this.ports.onRunResult(result);
    this.emitProgress(nowMs);
  }

  private emitProgress(nowMs: number): void {
    if (!this.ports.onProgress) return;
    const step = this.runtime?.step ?? null;
    const elapsed = this.runtime ? nowMs - this.runtime.startedAt : 0;
    this.ports.onProgress({
      phase: this.phase === 'SETUP' ? 'SETUP'
        : this.phase === 'RUNNING' ? 'STEP'
          : this.phase === 'DONE' ? 'DONE' : 'ABORTED',
      stepId: step ? step.id : null,
      label: step ? tf012AutoStepLabel(step) : 'AUTO TEST idle',
      stepIndex: step && step.index > 0 ? step.index : 0,
      stepCount: this.steps.length,
      remainingMs: step ? Math.max(0, step.durationMs - elapsed) : 0,
      paused: Boolean(this.runtime?.paused),
      senderConnected: this.senderConnected(),
      holdMs: step ? step.holdMs : null,
    });
  }
}

export function createTf012AutoOrchestrator(options: Tf012AutoOrchestratorOptions): Tf012AutoOrchestrator {
  return new Tf012AutoOrchestrator(options);
}

export {TF012_AUTO_STEP_COUNT};
