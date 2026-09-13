/**
 * TF-012 r13 — AUTO TEST control-plane policy for the lab relay.
 *
 * This module is the RELAY's enforcement point. It imports the SAME schema module the
 * sender page and the Mini Program use, so there is exactly one definition of what may
 * cross the control channel — no duplicated allowlist that can drift.
 *
 * Network rule enforced here: CONTROL and TELEMETRY only. Anything shaped like file
 * bytes, chunk payload, OptiGrid frame bytes, reconstructed bytes or a decode oracle is
 * rejected at the relay, so it can never reach either endpoint even if an endpoint were
 * compromised or a future change tried to add it.
 */
import {
  TF012_AUTO_RECEIVER_ROLE,
  TF012_AUTO_SENDER_ROLE,
  validateTf012AutoControlMessage,
  validateTf012AutoHelloMessage,
} from './src/optical-core/tf012-auto-plan.ts';

export {TF012_AUTO_RECEIVER_ROLE, TF012_AUTO_SENDER_ROLE};

/** Actions the SENDER side may emit. The sender is a command target, never a source. */
const SENDER_OUTBOUND = new Set(['HELLO', 'TELEMETRY']);

/** Actions the RECEIVER (phone) side may emit — it is the orchestrator. */
const RECEIVER_OUTBOUND = new Set([
  'HELLO', 'SET_MODE', 'SET_HOLD_MS', 'START', 'PAUSE', 'RESUME', 'STOP',
  'RESET_METRICS', 'STEP_COMPLETE', 'RUN_COMPLETE', 'RUN_ABORTED', 'RECEIVER_METRICS',
]);

export const TF012_AUTO_LAB_KIND = 'tf012-auto-physical';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * HELLO must declare one of the two sanctioned roles. Delegates to the SHARED hello
 * validator so the relay, the browser sender and the Mini Program agree on one definition
 * — and so the handshake is never validated as a control envelope.
 */
export function allowTf012AutoHello(message) {
  return validateTf012AutoHelloMessage(message);
}

/**
 * Relay a control/telemetry message from `role`. Direction is enforced as well as the
 * schema: the sender may only report, the receiver may only orchestrate.
 */
export function allowTf012AutoRelay(role, message) {
  const check = validateTf012AutoControlMessage(message);
  if (!check.ok) return {ok: false, reason: check.reason};
  const action = String(message.action);
  if (role === TF012_AUTO_SENDER_ROLE && !SENDER_OUTBOUND.has(action)) {
    return {ok: false, reason: `the sender role may not emit ${action}`};
  }
  if (role === TF012_AUTO_RECEIVER_ROLE && !RECEIVER_OUTBOUND.has(action)) {
    return {ok: false, reason: `the receiver role may not emit ${action}`};
  }
  if (role !== TF012_AUTO_SENDER_ROLE && role !== TF012_AUTO_RECEIVER_ROLE) {
    return {ok: false, reason: 'unknown role'};
  }
  return {ok: true, reason: 'ok'};
}

/**
 * The sanctioned "payload path is NONE" declarations. They NAME the payload in order to
 * deny it, so they are not payload-shaped keys. Without this exemption the run result
 * itself would be rejected for containing its own `networkPayloadPath: 'NONE'`.
 */
const PAYLOAD_PATH_DECLARATIONS = new Set(['payloadpath', 'networkpayloadpath']);

/**
 * The phone may persist its final frozen JSON to the lab. It must be a TF-012 auto-test
 * run, must declare no network payload path, and — because the relay persists it — must
 * not contain any payload-bearing key. This is the second line of defence for the
 * "no payload traverses the network" requirement.
 */
export function allowTf012AutoLabResult(role, message) {
  if (role !== TF012_AUTO_RECEIVER_ROLE) return {ok: false, reason: 'only the receiver may publish a run result'};
  if (!isRecord(message) || !isRecord(message.run)) return {ok: false, reason: 'lab-result must carry a run object'};
  const run = message.run;
  if (run.kind !== TF012_AUTO_LAB_KIND) return {ok: false, reason: `run.kind must be ${TF012_AUTO_LAB_KIND}`};
  if (run.networkPayloadPath !== 'NONE') return {ok: false, reason: 'networkPayloadPath must be NONE'};
  if (typeof run.runId !== 'string' || run.runId.length === 0 || run.runId.length > 64) {
    return {ok: false, reason: 'run.runId must be a short string'};
  }
  if (run.planVersion !== 'tf012-auto-v1') return {ok: false, reason: 'run.planVersion must be tf012-auto-v1'};
  if (!Array.isArray(run.steps) || run.steps.length > 12) return {ok: false, reason: 'run.steps must be an array'};
  const offenders = [];
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      const lowered = key.toLowerCase();
      if (!PAYLOAD_PATH_DECLARATIONS.has(lowered)
        && ['payload', 'filebytes', 'filecontent', 'filedata', 'chunkbytes', 'framebytes',
          'imagedata', 'bitmap', 'reconstructed', 'oracle', 'expected'].some((f) => lowered.includes(f))) {
        offenders.push(`${path}.${key}`);
      }
      walk(entry, `${path}.${key}`);
    }
  };
  walk(run, 'run');
  if (offenders.length > 0) return {ok: false, reason: `payload-shaped keys in the result: ${offenders.join(', ')}`};
  return {ok: true, reason: 'ok'};
}
