/**
 * TF-012 r14 — TEST-ONLY fake sender peer.
 *
 * The physical r13 run proved that a phone socket connected to the relay is NOT a
 * sender: every frozen step carried the default sender sample while the carrier kept
 * cycling. These tests therefore need a peer that can be made to misbehave in every way
 * the control plane claims to detect:
 *
 *   - it can refuse to announce itself (no HELLO)
 *   - it can stay silent (no telemetry) or send stale telemetry
 *   - it can ignore SET_MODE / SET_HOLD_MS / START / PAUSE / STOP individually
 *   - it can keep decoding other chunks during a "static" step
 *
 * Nothing here runs on a phone or in a browser: the orchestrator is deterministic and
 * clock-injected, so every one of those scenarios is provable in Node.
 */
import {
  validateTf012AutoControlMessage,
  type Tf012AutoEnvelope,
} from './tf012-auto-plan.ts';
import {
  createTf012AutoOrchestrator,
  emptyReceiverSample,
  type Tf012AutoProgress,
  type Tf012AutoReceiverSample,
  type Tf012AutoRunResult,
  type Tf012AutoSenderSample,
  type Tf012AutoStepResult,
} from './tf012-auto-orchestrator.ts';

export interface FakePeerOptions {
  startAt?: number;
  tickMs?: number;
  maxTicks?: number;
  /** Sender announces itself with HELLO. False = the phone never sees a sender peer. */
  hello?: boolean;
  /** Sender emits TELEMETRY at all. */
  telemetry?: boolean;
  /** Age added to the telemetry timestamp; > TF012_AUTO_TELEMETRY_FRESH_MS is stale. */
  telemetryAgeMs?: number;
  /** Stop refreshing telemetry after N ticks (simulates a sender that went away). */
  staleAfterTick?: number;
  obeyMode?: boolean;
  obeyHoldMs?: boolean;
  obeyStart?: boolean;
  obeyPause?: boolean;
  obeyStop?: boolean;
  /**
   * Ticks the sender needs before it actually applies SET_MODE. Models a slow sender so
   * the "measurement starts only after confirmation" rule is provable.
   */
  confirmationDelayTicks?: number;
  /**
   * What a STATIC step decodes: 'chunk0' is a healthy static carrier, 'many' and
   * 'other' are the optical proof that the sender was not actually static.
   */
  staticDecode?: 'chunk0' | 'many' | 'other';
  /** Setup-gate readiness: false makes the gate abort before A1. */
  ready?: boolean;
  /** Force the r13 UI-window artefact (e.g. 1000) into the receiver sample. */
  windowFps?: number | null;
  /** Extra control messages injected at a given tick index (for hostile-input tests). */
  injectAtTick?: number;
  inject?: (context: FakePeerContext) => void;
}

export interface FakePeerContext {
  tickIndex: number;
  now: number;
  orchestrator: ReturnType<typeof createTf012AutoOrchestrator>;
  commands: Tf012AutoEnvelope[];
}

export interface FakePeer {
  commands: Tf012AutoEnvelope[];
  frozen: Tf012AutoStepResult[];
  progress: Tf012AutoProgress[];
  finalResult: () => Tf012AutoRunResult | null;
  now: () => number;
  tickIndex: () => number;
  /** Advance the clock by one tick and tick the orchestrator. */
  tick: (times?: number) => void;
  runUntilFinal: () => Tf012AutoRunResult | null;
  sender: Tf012AutoSenderSample;
  receiver: Tf012AutoReceiverSample;
  /** Telemetry timestamp the orchestrator sees. */
  telemetryAt: () => number | null;
  setTelemetryAt: (value: number | null) => void;
  setHelloAt: (value: number | null) => void;
  /** Command actions in emission order. */
  actions: () => string[];
}

const FRAMES_PER_TICK = 15;

export function createFakePeer(options: FakePeerOptions = {}): FakePeer {
  const tickMs = options.tickMs ?? 500;
  const maxTicks = options.maxTicks ?? 400;
  const commands: Tf012AutoEnvelope[] = [];
  const frozen: Tf012AutoStepResult[] = [];
  const progress: Tf012AutoProgress[] = [];
  let final: Tf012AutoRunResult | null = null;
  let now = options.startAt ?? 1000;
  let tickIndex = 0;
  let helloAt: number | null = options.hello === false ? null : (options.startAt ?? 1000) - 100;
  let telemetryAt: number | null = options.telemetry === false ? null : now;
  let connected = true;
  let cyclicCursor = 0;
  /** Ticks before a pending SET_MODE is applied (see confirmationDelayTicks). */
  let pendingMode: {mode: 'static' | 'cyclic'; chunkIndex: number | null; applyAtTick: number} | null = null;
  const applyPendingMode = (): void => {
    if (!pendingMode || tickIndex < pendingMode.applyAtTick) return;
    sender.mode = pendingMode.mode;
    if (pendingMode.mode === 'static') sender.cursor = pendingMode.chunkIndex ?? 0;
    pendingMode = null;
  };

  const sender: Tf012AutoSenderSample = {
    mode: 'static', holdMs: null, cursor: 0, paused: false, broadcasting: false,
    canvasDevicePx: 1020, canvasHash: 'aaaa', pausedAt: null, resumedAt: null,
  };
  const receiver = emptyReceiverSample();

  const addIndex = (index: number): void => {
    if (!receiver.decodedChunkIndexes.includes(index)) {
      receiver.decodedChunkIndexes.push(index);
      receiver.uniqueReceived = receiver.decodedChunkIndexes.length;
    }
  };

  /** The r13 artefact: a UI-window FPS that must never reach a frozen result. */
  const windowFps = (): number | null => (options.windowFps === undefined ? null : options.windowFps);

  /** Frames the fake optical link delivered during the CURRENT step. */
  const receiveFrames = (): void => {
    if (!sender.broadcasting) return;
    receiver.cameraFrames += FRAMES_PER_TICK;
    receiver.processedFrames += FRAMES_PER_TICK;
    receiver.decodeAttempts += FRAMES_PER_TICK;
    receiver.callbackFps = windowFps();
    receiver.processingFps = windowFps();
    if (sender.paused) {
      // A frozen carrier still decodes: that is the whole point of A4.
      receiver.successfulDecodes += 10;
      addIndex(sender.cursor ?? 0);
      return;
    }
    if (sender.mode === 'static') {
      const behaviour = options.staticDecode ?? 'chunk0';
      receiver.observedCodeWidthPx = 253;
      receiver.pixelsPerCellX = 2.64;
      receiver.pixelsPerCellY = 2.65;
      receiver.reservedPatternScore = 0.999;
      receiver.contrast = 178;
      receiver.frameRotationIndex = 0;
      if (options.ready === false) {
        // An unusable setup: the locator finds the carrier but nothing decodes.
        receiver.crcFailures += FRAMES_PER_TICK;
        receiver.locateFailures += 2;
        return;
      }
      receiver.successfulDecodes += 14;
      if (behaviour === 'chunk0') addIndex(0);
      else if (behaviour === 'many') { addIndex(0); addIndex(1); addIndex(2); }
      else addIndex(3);
      return;
    }
    receiver.successfulDecodes += 13;
    receiver.observedCodeWidthPx = 253;
    receiver.pixelsPerCellX = 2.64;
    receiver.pixelsPerCellY = 2.65;
    receiver.reservedPatternScore = 0.999;
    receiver.contrast = 178;
    addIndex(cyclicCursor % 16);
    cyclicCursor += 1;
  };

  const orchestrator = createTf012AutoOrchestrator({
    runId: 'run-r14-test',
    buildId: 'tf012-r14-test',
    device: 'node-test-rig',
    ports: {
      send: (message) => {
        const check = validateTf012AutoControlMessage(message);
        if (!check.ok) throw new Error(`illegal control message: ${check.reason}`);
        commands.push(message);
        switch (message.action) {
          case 'SET_MODE': {
            if (options.obeyMode === false) break;
            const mode = message.mode as 'static' | 'cyclic';
            if (options.confirmationDelayTicks) {
              pendingMode = {
                mode,
                chunkIndex: message.chunkIndex === null || message.chunkIndex === undefined
                  ? null : Number(message.chunkIndex),
                applyAtTick: tickIndex + options.confirmationDelayTicks,
              };
              break;
            }
            sender.mode = mode;
            if (mode === 'static') {
              sender.cursor = Number(message.chunkIndex ?? 0);
              sender.holdMs = null;
            } else {
              sender.holdMs = null;
            }
            break;
          }
          case 'SET_HOLD_MS':
            if (options.obeyHoldMs !== false) sender.holdMs = Number(message.holdMs);
            break;
          case 'START':
            if (options.obeyStart !== false) sender.broadcasting = true;
            break;
          case 'PAUSE':
            if (options.obeyPause !== false) {
              sender.paused = true;
              sender.pausedAt = now;
            }
            break;
          case 'RESUME':
            sender.paused = false;
            sender.resumedAt = now;
            break;
          case 'STOP':
            if (options.obeyStop !== false) {
              sender.broadcasting = false;
              sender.paused = false;
            }
            break;
          default:
            break;
        }
      },
      senderSample: () => {
        // Mirror the browser sender: the cyclic cursor advances, a static carrier is
        // pinned to its chunk.
        if (sender.mode === 'cyclic' && sender.broadcasting && !sender.paused) {
          sender.cursor = ((sender.cursor ?? 0) + 1) % 16;
        }
        return {...sender};
      },
      receiverSample: () => ({...receiver, decodedChunkIndexes: [...receiver.decodedChunkIndexes]}),
      resetReceiverMetrics: () => {
        const fresh = emptyReceiverSample();
        Object.assign(receiver, fresh);
      },
      link: {
        controlConnected: () => connected,
        senderHelloAt: () => helloAt,
        telemetryAt: () => telemetryAt,
      },
      onStepResult: (result) => frozen.push(result),
      onRunResult: (result) => {
        final = result;
      },
      onProgress: (entry) => progress.push(entry),
    },
  });

  const tick = (times = 1): void => {
    for (let index = 0; index < times; index += 1) {
      now += tickMs;
      tickIndex += 1;
      if (options.telemetry !== false
        && (options.staleAfterTick === undefined || tickIndex <= options.staleAfterTick)) {
        telemetryAt = options.telemetryAgeMs === undefined ? now : now - options.telemetryAgeMs;
      }
      if (options.injectAtTick === tickIndex && options.inject) {
        options.inject({tickIndex, now, orchestrator, commands});
      }
      applyPendingMode();
      receiveFrames();
      orchestrator.tick(now);
      if (final) return;
    }
  };

  orchestrator.start(now);

  return {
    commands,
    frozen,
    progress,
    finalResult: () => final,
    now: () => now,
    tickIndex: () => tickIndex,
    tick,
    runUntilFinal: () => {
      for (let index = 0; index < maxTicks && !final; index += 1) tick(1);
      return final;
    },
    sender,
    receiver,
    telemetryAt: () => telemetryAt,
    setTelemetryAt: (value) => {
      telemetryAt = value;
    },
    setHelloAt: (value) => {
      helloAt = value;
    },
    actions: () => commands.map((message) => String(message.action)),
  };
}

/** Convenience: build a healthy peer and run the whole plan. */
export function runAutoPlan(options: FakePeerOptions = {}): FakePeer {
  const peer = createFakePeer(options);
  peer.runUntilFinal();
  return peer;
}
