/**
 * TF-012 r13 — browser-side AUTO TEST control client.
 *
 * Connects the sender page to the lab relay as `tf012-auto-receiver`'s counterpart
 * (`tf012-auto-sender`), accepts ONLY messages that pass the shared strict validator,
 * and executes them against the sender's control surface.
 *
 * The client never sends payload: everything it publishes is scalar control/telemetry
 * and every outbound message is validated before it leaves the page.
 */
import {
  TF012_AUTO_SENDER_ROLE,
  tf012AutoCommand,
  tf012AutoHelloMessage,
  tf012AutoSenderStateLabel,
  tf012AutoSenderStateMismatch,
  validateTf012AutoControlMessage,
  validateTf012AutoPeerNotice,
  type Tf012AutoEnvelope,
  type Tf012AutoSenderState,
} from './optical-core/tf012-auto-plan.ts';

export interface Tf012AutoSenderSurface {
  setMode: (mode: 'static' | 'cyclic', chunkIndex: number | null) => void;
  setHoldMs: (holdMs: number) => number;
  start: () => void;
  pauseCurrentFrame: () => boolean;
  resumeCurrentFrame: () => boolean;
  stop: () => void;
  resetMetrics: () => void;
  sample: () => {
    mode: 'static' | 'cyclic';
    holdMs: number | null;
    cursor: number | null;
    paused: boolean;
    broadcasting: boolean;
    canvasDevicePx: number | null;
    canvasHash: string | null;
    pausedAt: number | null;
    resumedAt: number | null;
  };
}

export interface Tf012AutoSenderClientOptions {
  surface: Tf012AutoSenderSurface;
  /** Full ws(s):// URL of the lab relay, including ?token= when the lab is protected. */
  url: string;
  buildId?: string | null;
  telemetryIntervalMs?: number;
  onStatus?: (status: Tf012AutoClientStatus) => void;
}

export interface Tf012AutoClientStatus {
  connected: boolean;
  url: string;
  runId: string | null;
  stepId: string | null;
  /**
   * The auto-test run phase as seen from THIS end. Derived purely from the control
   * messages the receiver sent, so the panel never has to guess whether a run is live:
   *   IDLE    — connected (or not), no run started yet
   *   RUNNING — after SET_MODE / START / STEP_COMPLETE
   *   PAUSED  — after PAUSE (A4's freeze), back to RUNNING on RESUME
   *   DONE    — after RUN_COMPLETE / RUN_ABORTED
   */
  phase: 'IDLE' | 'RUNNING' | 'PAUSED' | 'DONE';
  /** The phone announced itself (relay-confirmed peer HELLO) and is still talking. */
  peerConnected: boolean;
  /** Host-clock timestamp of the last inbound message from the phone, or null. */
  peerSeenAt: number | null;
  /** Messages received FROM the phone (control), for the panel's RX readout. */
  peerMessages: number;
  /** The state the phone last REQUESTED, as a phrase such as "CYCLIC 1000 ms". */
  requestedLabel: string;
  /** The sender's live state, same vocabulary. */
  actualLabel: string;
  /** True when live state matches the request — the sender never asserts it for the phone. */
  requestedConfirmed: boolean;
  /** Why the live state does not match, when it does not. */
  requestedMismatch: string | null;
  lastRejected: string | null;
  telemetrySent: number;
  commandsApplied: number;
}

const TELEMETRY_INTERVAL_MS = 500;

export function createTf012AutoSenderClient(options: Tf012AutoSenderClientOptions) {
  const {surface} = options;
  const telemetryIntervalMs = options.telemetryIntervalMs ?? TELEMETRY_INTERVAL_MS;
  let socket: WebSocket | null = null;
  let telemetryTimer: number | null = null;
  let runId: string | null = null;
  let stepId: string | null = null;
  const status: Tf012AutoClientStatus = {
    connected: false, url: options.url, runId: null, stepId: null, phase: 'IDLE',
    peerConnected: false, peerSeenAt: null, peerMessages: 0,
    requestedLabel: '—', actualLabel: '—', requestedConfirmed: false, requestedMismatch: null,
    lastRejected: null, telemetrySent: 0, commandsApplied: 0,
  };

  /** What the phone asked for. A request is not an achievement — the panel shows both. */
  const requested: {
    mode: 'static' | 'cyclic' | null;
    holdMs: number | null;
    cursor: number | null;
    paused: boolean | null;
    broadcasting: boolean | null;
  } = {mode: null, holdMs: null, cursor: null, paused: null, broadcasting: null};

  /** Recompute requested-vs-actual from the live surface sample. */
  const refreshConfirmation = (): void => {
    const sample = surface.sample();
    const actual: Tf012AutoSenderState = {
      mode: sample.mode, holdMs: sample.holdMs, cursor: sample.cursor,
      paused: sample.paused, broadcasting: sample.broadcasting,
    };
    const expected: Tf012AutoSenderState = {
      mode: requested.mode ?? actual.mode,
      holdMs: (requested.mode ?? actual.mode) === 'cyclic' ? requested.holdMs : null,
      cursor: (requested.mode ?? actual.mode) === 'static' ? requested.cursor : null,
      paused: requested.paused ?? actual.paused,
      broadcasting: requested.broadcasting ?? actual.broadcasting,
    };
    status.actualLabel = tf012AutoSenderStateLabel(actual) + (actual.paused ? ' · PAUSED' : '')
      + (actual.broadcasting ? '' : ' · STOPPED');
    status.requestedLabel = requested.mode == null
      ? '—'
      : tf012AutoSenderStateLabel(expected) + (requested.paused === true ? ' · PAUSED' : '')
        + (requested.broadcasting === false ? ' · STOPPED' : '');
    status.requestedMismatch = requested.mode == null ? null : tf012AutoSenderStateMismatch(actual, expected);
    status.requestedConfirmed = requested.mode != null && status.requestedMismatch === null;
  };

  const publish = (message: Tf012AutoEnvelope): void => {
    const check = validateTf012AutoControlMessage(message);
    if (!check.ok) {
      status.lastRejected = check.reason;
      options.onStatus?.({...status});
      return;
    }
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const sendTelemetry = (): void => {
    const sample = surface.sample();
    refreshConfirmation();
    publish(tf012AutoCommand('TELEMETRY', {
      runId, stepId, mode: sample.mode, holdMs: sample.holdMs, cursor: sample.cursor,
      paused: sample.paused, broadcasting: sample.broadcasting,
      canvasDevicePx: sample.canvasDevicePx, canvasHash: sample.canvasHash,
      pausedAt: sample.pausedAt, resumedAt: sample.resumedAt,
    }));
    status.telemetrySent += 1;
    options.onStatus?.({...status});
  };

  /** Apply one inbound control message. Returns a short outcome for the log. */
  function apply(message: unknown): string {
    const check = validateTf012AutoControlMessage(message);
    if (!check.ok) {
      status.lastRejected = check.reason;
      options.onStatus?.({...status});
      return 'rejected:' + check.reason;
    }
    const command = message as Tf012AutoEnvelope;
    const action = String(command.action);
    // Any inbound control message proves the phone is on the other end.
    status.peerSeenAt = Date.now();
    status.peerConnected = true;
    status.peerMessages += 1;
    if (action === 'HELLO') {
      status.connected = true;
      options.onStatus?.({...status});
      return 'hello';
    }
    if (typeof command.runId === 'string') runId = command.runId;
    if (typeof command.stepId === 'string') stepId = command.stepId;
    switch (action) {
      case 'SET_MODE': {
        const mode = command.mode as 'static' | 'cyclic';
        requested.mode = mode;
        requested.holdMs = mode === 'cyclic' ? requested.holdMs : null;
        requested.cursor = mode === 'static'
          ? (command.chunkIndex === null || command.chunkIndex === undefined ? 0 : Number(command.chunkIndex))
          : null;
        requested.broadcasting = true;
        requested.paused = false;
        surface.setMode(mode, command.chunkIndex === null || command.chunkIndex === undefined
          ? null : Number(command.chunkIndex));
        status.phase = 'RUNNING';
        break;
      }
      case 'SET_HOLD_MS':
        requested.holdMs = Number(command.holdMs);
        surface.setHoldMs(Number(command.holdMs));
        break;
      case 'START':
        requested.broadcasting = true;
        surface.start();
        status.phase = 'RUNNING';
        break;
      case 'PAUSE':
        requested.paused = true;
        surface.pauseCurrentFrame();
        status.phase = 'PAUSED';
        break;
      case 'RESUME':
        requested.paused = false;
        surface.resumeCurrentFrame();
        status.phase = 'RUNNING';
        break;
      case 'STOP':
        requested.broadcasting = false;
        requested.paused = false;
        surface.stop();
        status.phase = 'IDLE';
        break;
      case 'RESET_METRICS':
        surface.resetMetrics();
        break;
      case 'RUN_COMPLETE':
      case 'RUN_ABORTED':
        // Defensive: a completed run must never leave the carrier broadcasting, even if
        // the STOP message itself were lost. The PO must never have to press Stop.
        requested.broadcasting = false;
        requested.paused = false;
        if (surface.sample().broadcasting) surface.stop();
        status.phase = 'DONE';
        break;
      default:
        if (action === 'STEP_COMPLETE') status.phase = 'RUNNING';
        break;
    }
    refreshConfirmation();
    status.commandsApplied += 1;
    status.runId = runId;
    status.stepId = stepId;
    options.onStatus?.({...status});
    sendTelemetry();
    return action.toLowerCase();
  }

  function connect(): void {
    try {
      socket = new WebSocket(options.url);
    } catch {
      status.connected = false;
      options.onStatus?.({...status});
      return;
    }
    socket.addEventListener('open', () => {
      status.connected = true;
      // r15: the handshake is its OWN message class ({type:'hello'}), never a control
      // envelope. The relay registers the role from this message; sending it as
      // `{type:'command', action:'HELLO'}` is what left both ends unregistered in r14.
      socket?.send(JSON.stringify(tf012AutoHelloMessage(TF012_AUTO_SENDER_ROLE, {
        buildId: options.buildId ?? null,
        runId: null,
        planVersion: null,
      })));
      if (telemetryTimer !== null) window.clearInterval(telemetryTimer);
      telemetryTimer = window.setInterval(sendTelemetry, telemetryIntervalMs);
      options.onStatus?.({...status});
    });
    socket.addEventListener('message', (event) => {
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        // MESSAGE CLASS 2: peer presence. Handled by its own validator and NEVER fed to
        // the control validator — a `{type:'peer'}` notice is not a control envelope.
        const notice = validateTf012AutoPeerNotice(parsed);
        if (notice.ok) {
          const peer = parsed as {event: string};
          if (peer.event === 'hello') {
            status.peerConnected = true;
            status.peerSeenAt = Date.now();
          } else {
            status.peerConnected = false;
          }
          options.onStatus?.({...status});
          return;
        }
        // Anything else that is not a control envelope is ignored, never "validated as
        // control" and never able to mutate state.
        const envelope = parsed as {type?: unknown};
        if (envelope?.type !== 'command') return;
        apply(parsed);
      } catch {
        status.lastRejected = 'malformed JSON';
        options.onStatus?.({...status});
      }
    });
    socket.addEventListener('close', () => {
      status.connected = false;
      if (telemetryTimer !== null) {
        window.clearInterval(telemetryTimer);
        telemetryTimer = null;
      }
      options.onStatus?.({...status});
    });
    socket.addEventListener('error', () => {
      status.connected = false;
      options.onStatus?.({...status});
    });
  }

  connect();
  return {
    status: () => ({...status}),
    apply,
    sendTelemetry,
    close: () => {
      if (telemetryTimer !== null) window.clearInterval(telemetryTimer);
      telemetryTimer = null;
      socket?.close();
      socket = null;
    },
  };
}
