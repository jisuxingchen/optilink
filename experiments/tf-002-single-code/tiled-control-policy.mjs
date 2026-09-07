export const TILED_SENDER_ROLE = 'tf007v3-tiled-sender';
export const TILED_RECEIVER_ROLE = 'tf007v3-tiled-receiver';
const ORIENTATION_MATRIX = 64;
const DENSITY_MATRICES = new Set([80, 96, 112, 120]);
const CANDIDATE_HZ = new Map([[80, 30], [96, 60], [112, 45], [120, 45]]);
const CANDIDATE_PAYLOAD_BYTES = new Map([[80, 436], [96, 708], [112, 1044], [120, 1236]]);
const FINISH_STATUSES = new Set([
  'ABORTED',
  'TRAINING_LOCK_FAILED',
  'FUNCTIONAL_REFERENCE_PREAMBLE_FAILED',
  'FUNCTIONAL_REFERENCE_FAILED',
  'DENSITY_PREAMBLE_PARTIAL_FAILURE',
  'BELOW_100KBPS',
  'PASS_RAW_100KBPS',
  'ERROR',
]);
const STATE_EVENTS = new Set([
  'tf007v3-receiver-ready',
  'tf007v3-calibration-result',
  'tf007v3-candidate-ready',
  'tf007v3-candidate-result',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === allowed.size && Object.keys(value).every(key => allowed.has(key));
}

function calibrationId(value, kind, matrix) {
  if (typeof value !== 'string') return false;
  const expectedKind = kind === 'orientation' ? 'orientation' : 'density';
  return new RegExp(`^tf007v3-${expectedKind}-${matrix}-[a-z0-9]+$`).test(value);
}

function candidateId(value, matrix, hz) {
  return typeof value === 'string' && new RegExp(`^tf007v3-${matrix}-${hz}-[a-z0-9]+$`).test(value);
}

function isMatrix(value, includeOrientation = false) {
  return Number.isInteger(value) && (DENSITY_MATRICES.has(value) || (includeOrientation && value === ORIENTATION_MATRIX));
}

function validCandidateConfig(config) {
  if (!exactKeys(config, new Set(['id', 'matrixSize', 'targetHz', 'durationMs', 'payloadBytes', 'tileCount', 'reference']))) return false;
  if (!DENSITY_MATRICES.has(config.matrixSize)) return false;
  if (CANDIDATE_HZ.get(config.matrixSize) !== config.targetHz) return false;
  if (!candidateId(config.id, config.matrixSize, config.targetHz)) return false;
  if (config.durationMs !== 10000) return false;
  if (CANDIDATE_PAYLOAD_BYTES.get(config.matrixSize) !== config.payloadBytes) return false;
  if (config.tileCount !== 3 || typeof config.reference !== 'boolean') return false;
  return config.reference === (config.matrixSize === 80);
}

function validSenderCommand(message) {
  if (!isRecord(message) || message.type !== 'command' || typeof message.action !== 'string') return false;
  switch (message.action) {
    case 'tf007v3-preamble-visible':
    case 'tf007v3-calibrate': {
      if (!exactKeys(message, new Set(['type', 'action', 'id', 'matrixSize', 'kind']))) return false;
      if (!isMatrix(message.matrixSize, true)) return false;
      if (message.kind !== 'orientation' && message.kind !== 'density') return false;
      const matrixAllowed = message.kind === 'orientation' ? message.matrixSize === ORIENTATION_MATRIX : DENSITY_MATRICES.has(message.matrixSize);
      return matrixAllowed && calibrationId(message.id, message.kind, message.matrixSize);
    }
    case 'tf007v3-candidate-config':
      return exactKeys(message, new Set(['type', 'action', 'id', 'config'])) && validCandidateConfig(message.config) && message.id === message.config.id;
    case 'tf007v3-candidate-finish': {
      if (!exactKeys(message, new Set(['type', 'action', 'id']))) return false;
      const match = /^tf007v3-(80|96|112|120)-(30|45|60)-[a-z0-9]+$/.exec(String(message.id || ''));
      return Boolean(match) && CANDIDATE_HZ.get(Number(match[1])) === Number(match[2]);
    }
    case 'tf007v3-finished':
      return exactKeys(message, new Set(['type', 'action', 'status'])) && FINISH_STATUSES.has(message.status);
    case 'tiled-physical-stop':
      return exactKeys(message, new Set(['type', 'action']));
    default:
      return false;
  }
}

function validReceiverRelay(message) {
  if (!isRecord(message)) return false;
  if (message.type === 'command') {
    return message.action === 'tiled-physical-stop' && exactKeys(message, new Set(['type', 'action']));
  }
  if (message.type === 'telemetry') {
    return exactKeys(message, new Set(['type', 'telemetry'])) && isRecord(message.telemetry) && message.telemetry.transport === 'tf007-tiled-physical-v3';
  }
  if (message.type === 'state') {
    if (!STATE_EVENTS.has(message.event)) return false;
    if (message.event === 'tf007v3-receiver-ready') return exactKeys(message, new Set(['type', 'event', 'receiver']));
    if (!exactKeys(message, new Set(['type', 'event', 'id', 'value']))) return false;
    if (message.event === 'tf007v3-calibration-result') {
      const match = /^tf007v3-(orientation|density)-(64|80|96|112|120)-[a-z0-9]+$/.exec(String(message.id || ''));
      if (!match) return false;
      const matrix = Number(match[2]);
      return match[1] === 'orientation' ? matrix === ORIENTATION_MATRIX : DENSITY_MATRICES.has(matrix);
    }
    const match = /^tf007v3-(80|96|112|120)-(30|45|60)-[a-z0-9]+$/.exec(String(message.id || ''));
    return Boolean(match) && CANDIDATE_HZ.get(Number(match[1])) === Number(match[2]);
  }
  return false;
}

export function allowTiledHello(message) {
  return exactKeys(message, new Set(['type', 'role'])) && message.type === 'hello' && (message.role === TILED_SENDER_ROLE || message.role === TILED_RECEIVER_ROLE);
}

export function allowTiledRelay(role, message) {
  if (role === TILED_SENDER_ROLE) return validSenderCommand(message);
  if (role === TILED_RECEIVER_ROLE) return validReceiverRelay(message);
  return false;
}

export function allowTiledLabResult(role, message) {
  if (role !== TILED_SENDER_ROLE || !isRecord(message) || message.type !== 'lab-result' || !isRecord(message.run)) return false;
  return message.run.kind === 'tf007-tiled-physical-calibration' && Number(message.run.issueNumber) === 27;
}

// Import-time invariants run in every existing lab-server CI smoke test. They guard
// the evidence boundary against accidental sender→receiver payload/cell/frame relay.
const calibrationIdExample = 'tf007v3-orientation-64-mv123';
const candidateIdExample = 'tf007v3-96-60-mv456';
const selfTests = [
  allowTiledHello({type: 'hello', role: TILED_SENDER_ROLE}) === true,
  allowTiledHello({type: 'hello', role: 'payload-bytes-here'}) === false,
  allowTiledHello({type: 'hello', role: TILED_SENDER_ROLE, payload: [1, 2, 3]}) === false,
  allowTiledRelay(TILED_SENDER_ROLE, {type: 'command', action: 'tf007v3-calibrate', id: calibrationIdExample, matrixSize: 64, kind: 'orientation'}) === true,
  allowTiledRelay(TILED_SENDER_ROLE, {type: 'command', action: 'tf007v3-candidate-config', id: candidateIdExample, config: {id: candidateIdExample, matrixSize: 96, targetHz: 60, durationMs: 10000, payloadBytes: 708, tileCount: 3, reference: false}}) === true,
  allowTiledRelay(TILED_SENDER_ROLE, {type: 'command', action: 'tf007v3-candidate-config', id: candidateIdExample, config: {id: candidateIdExample, matrixSize: 96, targetHz: 60, durationMs: 10000, payloadBytes: 708, tileCount: 3, reference: false}, payload: [1, 2, 3]}) === false,
  allowTiledRelay(TILED_SENDER_ROLE, {type: 'command', action: 'tf007v3-candidate-config', id: 'tf007v3-96-60-payloadbytes', config: {id: 'tf007v3-96-60-payloadbytes', matrixSize: 96, targetHz: 60, durationMs: 10000, payloadBytes: 709, tileCount: 3, reference: false}}) === false,
  allowTiledRelay(TILED_SENDER_ROLE, {type: 'state', event: 'tf007v3-candidate-result', id: candidateIdExample, value: {payload: [1, 2, 3]}}) === false,
  allowTiledRelay(TILED_SENDER_ROLE, {type: 'command', action: 'unknown', payload: [1, 2, 3]}) === false,
  allowTiledRelay(TILED_RECEIVER_ROLE, {type: 'state', event: 'tf007v3-candidate-ready', id: candidateIdExample, value: {ok: true}}) === true,
  allowTiledLabResult(TILED_SENDER_ROLE, {type: 'lab-result', run: {kind: 'tf007-tiled-physical-calibration', issueNumber: 27}}) === true,
  allowTiledLabResult(TILED_SENDER_ROLE, {type: 'lab-result', run: {kind: 'tf007-tiled-physical-calibration', issueNumber: 9}}) === false,
];
if (selfTests.some(value => !value)) throw new Error('TF-007 tiled control-plane policy self-test failed');
