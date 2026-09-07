const SENDER_ROLE = 'tf007v3-tiled-sender';
const RECEIVER_ROLE = 'tf007v3-tiled-receiver';
const ORIENTATION_MATRIX = 64;
const DENSITY_MATRICES = new Set([80, 96, 112, 120]);
const CANDIDATE_HZ = new Map([[80, 30], [96, 60], [112, 45], [120, 45]]);
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
  return Object.keys(value).every(key => allowed.has(key));
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

function isMatrix(value, includeOrientation = false) {
  return Number.isInteger(value) && (DENSITY_MATRICES.has(value) || (includeOrientation && value === ORIENTATION_MATRIX));
}

function validCandidateConfig(config) {
  if (!exactKeys(config, new Set(['id', 'matrixSize', 'targetHz', 'durationMs', 'payloadBytes', 'tileCount', 'reference']))) return false;
  if (!isId(config.id) || !DENSITY_MATRICES.has(config.matrixSize)) return false;
  if (CANDIDATE_HZ.get(config.matrixSize) !== config.targetHz) return false;
  if (!Number.isFinite(config.durationMs) || config.durationMs <= 0 || config.durationMs > 60000) return false;
  if (!Number.isInteger(config.payloadBytes) || config.payloadBytes <= 0 || config.payloadBytes > 10000) return false;
  if (config.tileCount !== 3 || typeof config.reference !== 'boolean') return false;
  return config.reference === (config.matrixSize === 80);
}

function validSenderCommand(message) {
  if (!isRecord(message) || message.type !== 'command' || typeof message.action !== 'string') return false;
  switch (message.action) {
    case 'tf007v3-preamble-visible':
    case 'tf007v3-calibrate': {
      if (!exactKeys(message, new Set(['type', 'action', 'id', 'matrixSize', 'kind']))) return false;
      if (!isId(message.id) || !isMatrix(message.matrixSize, true)) return false;
      if (message.kind !== 'orientation' && message.kind !== 'density') return false;
      return message.kind === 'orientation' ? message.matrixSize === ORIENTATION_MATRIX : DENSITY_MATRICES.has(message.matrixSize);
    }
    case 'tf007v3-candidate-config':
      return exactKeys(message, new Set(['type', 'action', 'id', 'config'])) && isId(message.id) && validCandidateConfig(message.config) && message.id === message.config.id;
    case 'tf007v3-candidate-finish':
      return exactKeys(message, new Set(['type', 'action', 'id'])) && isId(message.id);
    case 'tf007v3-finished':
      return exactKeys(message, new Set(['type', 'action', 'status'])) && typeof message.status === 'string' && message.status.length <= 80;
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
    return exactKeys(message, new Set(['type', 'event', 'id', 'value'])) && isId(message.id);
  }
  return false;
}

export function allowTiledRelay(role, message) {
  if (role === SENDER_ROLE) return validSenderCommand(message);
  if (role === RECEIVER_ROLE) return validReceiverRelay(message);
  return false;
}

export function allowTiledLabResult(role, message) {
  if (role !== SENDER_ROLE || !isRecord(message) || message.type !== 'lab-result' || !isRecord(message.run)) return false;
  return message.run.kind === 'tf007-tiled-physical-calibration' && Number(message.run.issueNumber) === 27;
}

// Import-time invariants run in every existing lab-server CI smoke test. They guard
// the evidence boundary against accidental sender→receiver payload/cell/frame relay.
const selfTests = [
  allowTiledRelay(SENDER_ROLE, {type: 'command', action: 'tf007v3-calibrate', id: 'x', matrixSize: 64, kind: 'orientation'}) === true,
  allowTiledRelay(SENDER_ROLE, {type: 'command', action: 'tf007v3-candidate-config', id: 'c', config: {id: 'c', matrixSize: 96, targetHz: 60, durationMs: 10000, payloadBytes: 708, tileCount: 3, reference: false}}) === true,
  allowTiledRelay(SENDER_ROLE, {type: 'command', action: 'tf007v3-candidate-config', id: 'c', config: {id: 'c', matrixSize: 96, targetHz: 60, durationMs: 10000, payloadBytes: 708, tileCount: 3, reference: false}, payload: [1, 2, 3]}) === false,
  allowTiledRelay(SENDER_ROLE, {type: 'state', event: 'tf007v3-candidate-result', id: 'c', value: {payload: [1, 2, 3]}}) === false,
  allowTiledRelay(SENDER_ROLE, {type: 'command', action: 'unknown', payload: [1, 2, 3]}) === false,
  allowTiledRelay(RECEIVER_ROLE, {type: 'state', event: 'tf007v3-candidate-ready', id: 'c', value: {ok: true}}) === true,
  allowTiledLabResult(SENDER_ROLE, {type: 'lab-result', run: {kind: 'tf007-tiled-physical-calibration', issueNumber: 27}}) === true,
  allowTiledLabResult(SENDER_ROLE, {type: 'lab-result', run: {kind: 'tf007-tiled-physical-calibration', issueNumber: 9}}) === false,
];
if (selfTests.some(value => !value)) throw new Error('TF-007 tiled control-plane policy self-test failed');
