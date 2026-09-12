/**
 * TF-012 r13 — AUTO PHYSICAL TEST HARNESS / 自动物理测试编排器
 *
 * Platform-neutral definition of the automated physical test plan plus the STRICT
 * control-channel schema. Everything about the plan lives here so the browser sender,
 * the Mini Program and the Node tests all share one definition.
 *
 * NETWORK RULE (enforced, not documented): the control channel may carry CONTROL and
 * TELEMETRY only. No file bytes, no chunk payload, no OptiGrid frame bytes, no
 * reconstructed bytes, no CRC oracle, no expected-decode oracle and no SHA payload
 * ever crosses it. `networkPayloadPath` stays NONE: the optical display → phone
 * camera remains the ONLY payload path.
 *
 * The rule is enforced by `validateTf012AutoControlMessage()` below (an exact-key
 * allowlist plus a recursive forbidden-key scan and a blob-length budget), and that
 * validator is used by the lab relay AND by both endpoints.
 */

export const TF012_AUTO_PLAN_VERSION = 'tf012-auto-v1';

export type Tf012AutoMode = 'static' | 'cyclic';
export type Tf012AutoStepId = 'SETUP' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5';

export interface Tf012AutoStep {
  /** Stable identifier used in the frozen JSON. */
  id: Tf012AutoStepId;
  /** 1-based position inside the A1..A5 sequence; 0 for the setup gate. */
  index: number;
  title: string;
  mode: Tf012AutoMode;
  /** Declared hold time for cyclic steps; null for static steps. */
  holdMs: number | null;
  /** Total wall time for the step. */
  durationMs: number;
  /** A4 only: how long the cycle runs before PAUSE CURRENT FRAME. */
  runMs?: number;
  /** A4 only: how long the frame is held frozen. */
  pauseMs?: number;
  /** Chunk shown for static steps / frozen for the A4 pause. */
  chunkIndex: number | null;
  /** Human note shown on both ends. */
  note: string;
}

/**
 * SETUP GATE. Static chunk 0 for 5 s before the automated sequence. Evidence-based
 * readiness only — deliberately NOT a hard px/cell threshold, because the existing
 * physical evidence proves ~2.99 px/cell can decode successfully.
 */
export const TF012_AUTO_SETUP_STEP: Tf012AutoStep = {
  id: 'SETUP',
  index: 0,
  title: 'SETUP GATE · static chunk0',
  mode: 'static',
  holdMs: null,
  durationMs: 5000,
  chunkIndex: 0,
  note: 'Framing/evidence gate; the sequence aborts here if the setup is unusable.',
};

export const TF012_AUTO_STEPS: readonly Tf012AutoStep[] = [
  {
    id: 'A1',
    index: 1,
    title: 'STATIC chunk0',
    mode: 'static',
    holdMs: null,
    durationMs: 10000,
    chunkIndex: 0,
    note: 'Static diagnostic reference point.',
  },
  {
    id: 'A2',
    index: 2,
    title: 'CYCLIC 5000 ms',
    mode: 'cyclic',
    holdMs: 5000,
    durationMs: 25000,
    chunkIndex: null,
    note: 'Slow cyclic: 5 frames/code of dwell at ~25 FPS.',
  },
  {
    id: 'A3',
    index: 3,
    title: 'CYCLIC 1000 ms',
    mode: 'cyclic',
    holdMs: 1000,
    durationMs: 25000,
    chunkIndex: null,
    note: 'The hold time that physically produced 0/209 decodes.',
  },
  {
    id: 'A4',
    index: 4,
    title: 'CYCLIC 1000 ms then PAUSE CURRENT FRAME',
    mode: 'cyclic',
    holdMs: 1000,
    durationMs: 15000,
    runMs: 5000,
    pauseMs: 10000,
    // Cyclic: the frame that gets frozen is whatever the cursor happens to show, so
    // no chunk is pinned here. PAUSE reports the cursor it actually froze.
    chunkIndex: null,
    note: '5 s cyclic, then freeze the exact current canvas for 10 s. NOT a stop.',
  },
  {
    id: 'A5',
    index: 5,
    title: 'STATIC chunk0 (drift control)',
    mode: 'static',
    holdMs: null,
    durationMs: 10000,
    chunkIndex: 0,
    note: 'Repeat of A1 to detect physical drift across the run.',
  },
];

export const TF012_AUTO_STEP_COUNT = TF012_AUTO_STEPS.length;

// The shipped plan is immutable at RUNTIME as well as in the type system: a step
// definition must never be edited mid-run, because both the sender and the phone
// read their hold time from it.
Object.freeze(TF012_AUTO_SETUP_STEP);
for (const step of TF012_AUTO_STEPS) Object.freeze(step);
Object.freeze(TF012_AUTO_STEPS);

export function tf012AutoStep(id: Tf012AutoStepId): Tf012AutoStep {
  if (id === 'SETUP') return TF012_AUTO_SETUP_STEP;
  const step = TF012_AUTO_STEPS.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`Unknown TF-012 auto step ${id}`);
  return step;
}

/** "Step A2 / 5 · CYCLIC 5000 ms" — the one label both ends display. */
export function tf012AutoStepLabel(step: Tf012AutoStep): string {
  const position = step.index > 0 ? `Step ${step.id} / ${TF012_AUTO_STEP_COUNT}` : 'SETUP GATE';
  return `${position} · ${step.title}`;
}

/** Total planned duration of the A1..A5 sequence, in milliseconds. */
export function tf012AutoPlanDurationMs(): number {
  return TF012_AUTO_STEPS.reduce((total, step) => total + step.durationMs, 0);
}

// ---------------------------------------------------------------------------
// Control-channel schema
// ---------------------------------------------------------------------------
//
// Every message is FLAT (no nested payload bag) and every field is declared. The
// validator rejects: unknown actions, unknown keys, nested objects/arrays, oversized
// strings, and any key that could carry optical payload or act as a decode oracle.

export const TF012_AUTO_SENDER_ROLE = 'tf012-auto-sender';
export const TF012_AUTO_RECEIVER_ROLE = 'tf012-auto-receiver';

export type Tf012AutoCommandAction =
  | 'HELLO'
  | 'SET_MODE'
  | 'SET_HOLD_MS'
  | 'START'
  | 'PAUSE'
  | 'RESUME'
  | 'STOP'
  | 'RESET_METRICS'
  | 'STEP_COMPLETE'
  | 'RUN_COMPLETE'
  | 'RUN_ABORTED'
  | 'TELEMETRY'
  | 'RECEIVER_METRICS';

const COMMAND_ACTIONS = new Set<Tf012AutoCommandAction>([
  'HELLO', 'SET_MODE', 'SET_HOLD_MS', 'START', 'PAUSE', 'RESUME', 'STOP',
  'RESET_METRICS', 'STEP_COMPLETE', 'RUN_COMPLETE', 'RUN_ABORTED',
  'TELEMETRY', 'RECEIVER_METRICS',
]);

/**
 * Fields allowed per action. An EXACT match is required: an unexpected extra field is
 * a policy violation, so a future "just add a bytes field" change cannot slip through.
 */
export const TF012_AUTO_ALLOWED_FIELDS: Readonly<Record<Tf012AutoCommandAction, readonly string[]>> = {
  HELLO: ['type', 'action', 'role', 'runId', 'buildId', 'planVersion'],
  SET_MODE: ['type', 'action', 'runId', 'stepId', 'mode', 'chunkIndex'],
  SET_HOLD_MS: ['type', 'action', 'runId', 'stepId', 'holdMs'],
  START: ['type', 'action', 'runId', 'stepId'],
  PAUSE: ['type', 'action', 'runId', 'stepId', 'chunkIndex'],
  RESUME: ['type', 'action', 'runId', 'stepId'],
  STOP: ['type', 'action', 'runId'],
  RESET_METRICS: ['type', 'action', 'runId', 'stepId'],
  STEP_COMPLETE: ['type', 'action', 'runId', 'stepId', 'paused', 'cursor', 'mode', 'holdMs'],
  RUN_COMPLETE: ['type', 'action', 'runId', 'steps'],
  RUN_ABORTED: ['type', 'action', 'runId', 'reason'],
  TELEMETRY: ['type', 'action', 'runId', 'stepId', 'mode', 'holdMs', 'cursor', 'paused',
    'canvasDevicePx', 'canvasHash', 'pausedAt', 'resumedAt', 'broadcasting'],
  RECEIVER_METRICS: ['type', 'action', 'runId', 'stepId', 'phase', 'payloadPath',
    'observedCodeWidthPx', 'pixelsPerCellX', 'pixelsPerCellY', 'reservedPatternScore',
    'contrast', 'frameRotationIndex', 'callbackFps', 'processingFps', 'activeProcessAvgMs',
    'activeProcessP95Ms', 'cameraFrames', 'decodeAttempts', 'successfulDecodes',
    'crcFailures', 'locateFailures', 'uniqueReceived', 'decodedChunkIndexes'],
};

/**
 * Field-name fragments that would indicate an attempt to move optical payload, file
 * bytes or a decode oracle over the control channel. They are used by
 * `tf012AutoForbiddenFieldHits()` (a test/audit helper) and are NOT applied to the
 * declared allowlist: an allowlisted field is sanctioned by definition, and a
 * substring rule over metric names such as `pixelsPerCellX` would be a false positive.
 * The enforced guard is the exact-key allowlist plus the value checks below.
 */
export const TF012_AUTO_FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  'payload', 'filebytes', 'filecontent', 'filedata', 'chunkbytes', 'framebytes',
  'optigridbytes', 'rawbytes', 'expected', 'oracle', 'reconstructed', 'shabytes',
  'base64', 'imagedata', 'bitmap',
];

/**
 * The one sanctioned exception: `payloadPath` is the explicit declaration that the
 * payload path is NONE. It is a statement ABOUT the payload, not payload itself, so
 * the audit helper ignores it.
 */
const TF012_AUTO_AUDIT_EXEMPT_FIELDS = new Set(['payloadPath']);

/** Return every field name that looks like a payload/oracle channel. */
export function tf012AutoForbiddenFieldHits(message: unknown): string[] {
  if (!isPlainRecord(message)) return [];
  const hits: string[] = [];
  for (const key of Object.keys(message)) {
    if (TF012_AUTO_AUDIT_EXEMPT_FIELDS.has(key)) continue;
    const lower = key.toLowerCase();
    if (TF012_AUTO_FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment))) hits.push(key);
  }
  return hits;
}

/** A single scalar may not exceed this many characters — a blob cannot ride along. */
export const TF012_AUTO_MAX_STRING_LENGTH = 180;
/** A message may not declare more than this many step entries. */
export const TF012_AUTO_MAX_STEPS = 12;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface Tf012AutoValidation {
  ok: boolean;
  reason: string;
}

const OK: Tf012AutoValidation = {ok: true, reason: 'ok'};

/**
 * Strict control-plane validator. Used by the lab relay, the browser sender and the
 * Mini Program, so there is exactly ONE definition of what may cross the channel.
 */
export function validateTf012AutoControlMessage(message: unknown): Tf012AutoValidation {
  if (!isPlainRecord(message)) return {ok: false, reason: 'message must be a JSON object'};
  if (message.type !== undefined && message.type !== 'command') {
    return {ok: false, reason: `unexpected message type ${String(message.type)}`};
  }
  const action = message.action;
  if (typeof action !== 'string' || !COMMAND_ACTIONS.has(action as Tf012AutoCommandAction)) {
    return {ok: false, reason: `unknown action ${String(action)}`};
  }
  const allowed = new Set(TF012_AUTO_ALLOWED_FIELDS[action as Tf012AutoCommandAction]);
  // Exact-key allowlist: an undeclared field is a policy violation, so a future
  // "just add a bytes field" change cannot slip through unnoticed.
  for (const key of Object.keys(message)) {
    if (!allowed.has(key)) return {ok: false, reason: `field ${key} is not allowed on ${action}`};
  }
  for (const [key, value] of Object.entries(message)) {
    if (key === 'steps') {
      if (!Array.isArray(value)) return {ok: false, reason: 'steps must be an array of step IDs'};
      if (value.length > TF012_AUTO_MAX_STEPS) return {ok: false, reason: 'too many steps declared'};
      if (!value.every((entry) => typeof entry === 'string' && entry.length <= 16)) {
        return {ok: false, reason: 'steps must be short strings'};
      }
      continue;
    }
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      // Only a flat list of short scalars is ever acceptable (decodedChunkIndexes).
      if (value.length > 64) return {ok: false, reason: `${key} has too many entries`};
      for (const entry of value) {
        if (typeof entry === 'object' && entry !== null) {
          return {ok: false, reason: `${key} must not contain objects`};
        }
        if (typeof entry === 'string' && entry.length > TF012_AUTO_MAX_STRING_LENGTH) {
          return {ok: false, reason: `${key} contains an oversized entry`};
        }
      }
      continue;
    }
    if (typeof value === 'object') return {ok: false, reason: `${key} must not be a nested object`};
    if (typeof value === 'string') {
      if (value.length > TF012_AUTO_MAX_STRING_LENGTH) {
        return {ok: false, reason: `${key} exceeds the control-channel string budget`};
      }
      // Any long hex/base64 run would be an attempt to ride payload over the channel.
      if (/^[0-9a-f]{80,}$/iu.test(value) || /^[A-Za-z0-9+/=]{120,}$/u.test(value)) {
        return {ok: false, reason: `${key} looks like an encoded blob`};
      }
    }
  }
  return validateTf012AutoSemantics(action as Tf012AutoCommandAction, message);
}

function validateTf012AutoSemantics(
  action: Tf012AutoCommandAction,
  message: Record<string, unknown>,
): Tf012AutoValidation {
  const requireField = (key: string, test: (value: unknown) => boolean, shape: string): Tf012AutoValidation => {
    if (!test(message[key])) return {ok: false, reason: `${action}.${key} must be ${shape}`};
    return OK;
  };
  const isId = (value: unknown): boolean => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/u.test(value);
  const isFiniteNonNegative = (value: unknown): boolean => value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const isBoolean = (value: unknown): boolean => typeof value === 'boolean';

  switch (action) {
    case 'HELLO':
      return requireField('role', (value) => typeof value === 'string' && value.length <= 40, 'a role string');
    case 'SET_MODE':
      if (message.mode !== 'static' && message.mode !== 'cyclic') {
        return {ok: false, reason: 'SET_MODE.mode must be static or cyclic'};
      }
      return requireField('chunkIndex', isFiniteNonNegative, 'null or a non-negative integer');
    case 'SET_HOLD_MS':
      return requireField('holdMs', (value) => typeof value === 'number' && Number.isFinite(value)
        && value >= 1 && value <= 60000, 'a number in 1..60000');
    case 'PAUSE':
      return requireField('chunkIndex', isFiniteNonNegative, 'null or a non-negative integer');
    case 'STEP_COMPLETE':
      return requireField('cursor', isFiniteNonNegative, 'null or a non-negative integer');
    case 'TELEMETRY':
      return requireField('canvasHash', (value) => value === null || value === undefined
        || (typeof value === 'string' && /^[0-9a-f]{1,32}$/u.test(value)), 'null or a short hex digest');
    case 'RUN_ABORTED':
      return requireField('reason', (value) => typeof value === 'string' && value.length > 0
        && value.length <= TF012_AUTO_MAX_STRING_LENGTH, 'a short reason string');
    case 'RECEIVER_METRICS':
      return requireField('payloadPath', (value) => value === 'NONE', 'the literal "NONE"');
    case 'RUN_COMPLETE':
      return requireField('runId', isId, 'an id string');
    default:
      return OK;
  }
}

// ---------------------------------------------------------------------------
// Message builders (the only sanctioned way to construct a control message)
// ---------------------------------------------------------------------------

export interface Tf012AutoEnvelope {
  type: 'command';
  action: Tf012AutoCommandAction;
  [key: string]: unknown;
}

export function tf012AutoCommand(
  action: Tf012AutoCommandAction,
  fields: Record<string, unknown> = {},
): Tf012AutoEnvelope {
  const message = {type: 'command', action, ...fields} as Tf012AutoEnvelope;
  const check = validateTf012AutoControlMessage(message);
  if (!check.ok) throw new Error(`Illegal TF-012 auto control message: ${check.reason}`);
  return message;
}
