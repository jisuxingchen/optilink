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
  validateTf012AutoControlMessage,
  type Tf012AutoEnvelope,
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
    connected: false, url: options.url, runId: null, stepId: null,
    lastRejected: null, telemetrySent: 0, commandsApplied: 0,
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
    if (action === 'HELLO') {
      status.connected = true;
      options.onStatus?.({...status});
      return 'hello';
    }
    if (typeof command.runId === 'string') runId = command.runId;
    if (typeof command.stepId === 'string') stepId = command.stepId;
    switch (action) {
      case 'SET_MODE':
        surface.setMode(command.mode as 'static' | 'cyclic',
          command.chunkIndex === null || command.chunkIndex === undefined ? null : Number(command.chunkIndex));
        break;
      case 'SET_HOLD_MS':
        surface.setHoldMs(Number(command.holdMs));
        break;
      case 'START':
        surface.start();
        break;
      case 'PAUSE':
        surface.pauseCurrentFrame();
        break;
      case 'RESUME':
        surface.resumeCurrentFrame();
        break;
      case 'STOP':
        surface.stop();
        break;
      case 'RESET_METRICS':
        surface.resetMetrics();
        break;
      default:
        // STEP_COMPLETE / RUN_* are receiver→sender notifications; nothing to do but
        // keep the run id in sync so the next telemetry is attributed correctly.
        break;
    }
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
      publish(tf012AutoCommand('HELLO', {
        role: TF012_AUTO_SENDER_ROLE,
        buildId: options.buildId ?? null,
        runId: null,
        planVersion: null,
      }));
      if (telemetryTimer !== null) window.clearInterval(telemetryTimer);
      telemetryTimer = window.setInterval(sendTelemetry, telemetryIntervalMs);
      options.onStatus?.({...status});
    });
    socket.addEventListener('message', (event) => {
      try {
        apply(JSON.parse(String(event.data)));
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
