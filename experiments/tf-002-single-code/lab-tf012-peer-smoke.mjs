/**
 * TF-012 r15 — REAL relay peer-discovery smoke test.
 *
 * The r14 failure was reproduced physically: both endpoints connected to the coordinator and
 * neither recognised the other. The unit tests pin the registry logic; this script proves
 * the actual `lab-server.mjs` wiring:
 *
 *   - a client that announces itself with the canonical `{type:'hello'}` is REGISTERED,
 *     and can then relay commands/telemetry (the r14 blocker);
 *   - the newcomer is told about the incumbent, AND the incumbent is told about the
 *     newcomer — in BOTH connection orders;
 *   - the legacy `{type:'command', action:'HELLO'}` spelling also registers;
 *   - an unregistered client still cannot relay anything;
 *   - a payload-shaped hello is rejected;
 *   - a disconnect produces a `bye` notice for the survivor.
 */
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';

const port = 5198;
const token = 'ci-tf012-secret';
const SENDER = 'tf012-auto-sender';
const RECEIVER = 'tf012-auto-receiver';

const child = spawn(process.execPath, ['lab-server.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    OPTILINK_LAB_TOKEN: token,
    OPTILINK_LAB_PAGE: 'tf012auto',
    OPTILINK_PUBLISH_GITHUB: '0',
  },
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealth() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/lab/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.status === 'OK' && health.mode === 'tf012auto') return;
      }
    } catch {}
    await sleep(150);
  }
  throw new Error(`TF-012 lab health timeout\n${stderr}`);
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/lab?token=${token}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolve with the first message matching `predicate`. */
function waitMessage(ws, predicate, label, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${label}`));
    }, timeout);
    const onMessage = (raw) => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { return; }
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); };
    ws.on('message', onMessage);
  });
}

const isPeer = (role) => (value) => value?.type === 'peer' && value?.event === 'hello' && value?.role === role;

try {
  await waitHealth();

  // -------------------------------------------------------------------------
  // PHASE A — PC (sender) connects first, phone (receiver) second. Canonical hello.
  // -------------------------------------------------------------------------
  const sender = await openSocket();
  const senderRegistered = waitMessage(sender, (m) => m?.type === 'server' && m?.event === 'registered',
    'sender registration');
  sender.send(JSON.stringify({type: 'hello', role: SENDER, buildId: 'smoke', runId: null, planVersion: null}));
  const senderMeta = await senderRegistered;
  if (senderMeta.role !== SENDER) throw new Error('sender registration role mismatch');

  const receiver = await openSocket();
  const senderSeesPhone = waitMessage(sender, isPeer(RECEIVER), 'sender <- peer hello receiver');
  const phoneSeesSender = waitMessage(receiver, isPeer(SENDER), 'receiver <- peer hello sender');
  const receiverRegistered = waitMessage(receiver, (m) => m?.type === 'server' && m?.event === 'registered',
    'receiver registration');
  receiver.send(JSON.stringify({type: 'hello', role: RECEIVER, buildId: 'smoke', runId: null, planVersion: null}));

  // BOTH directions must arrive. This is the exact r14 defect: the later client was never
  // told about the one already present.
  await phoneSeesSender;
  await senderSeesPhone;
  const receiverMeta = await receiverRegistered;
  if (!receiverMeta.peers?.includes(SENDER)) {
    throw new Error(`receiver registration must report the present peer, got ${JSON.stringify(receiverMeta.peers)}`);
  }

  // Registration is what unlocks the relay — a hello is NOT validated as control.
  const commandRelayed = waitMessage(sender, (m) => m?.type === 'command' && m?.action === 'SET_MODE',
    'phone -> sender SET_MODE');
  receiver.send(JSON.stringify({type: 'command', action: 'SET_MODE', runId: 'smoke', stepId: 'A1', mode: 'static', chunkIndex: 0}));
  await commandRelayed;

  const telemetryRelayed = waitMessage(receiver, (m) => m?.type === 'command' && m?.action === 'TELEMETRY',
    'sender -> phone TELEMETRY');
  sender.send(JSON.stringify({
    type: 'command', action: 'TELEMETRY', runId: 'smoke', stepId: 'A1', mode: 'static',
    holdMs: null, cursor: 0, paused: false, broadcasting: true,
    canvasDevicePx: 1020, canvasHash: 'abcd1234', pausedAt: null, resumedAt: null,
  }));
  await telemetryRelayed;

  // An unregistered client must still be refused by the strict control plane.
  const stranger = await openSocket();
  const strangerRejected = waitMessage(stranger, (m) => m?.type === 'server' && m?.event === 'policy-rejected',
    'stranger rejection');
  stranger.send(JSON.stringify({type: 'command', action: 'START', runId: 'smoke', stepId: 'A1'}));
  const rejection = await strangerRejected;
  if (!String(rejection.reason).includes('unknown role')) {
    throw new Error(`expected an unknown-role rejection, got ${rejection.reason}`);
  }

  // A hello may not smuggle payload either.
  const payloadHelloRejected = waitMessage(stranger, (m) => m?.type === 'server' && m?.event === 'policy-rejected',
    'payload hello rejection');
  stranger.send(JSON.stringify({type: 'hello', role: SENDER, chunkPayload: 'AAEC'}));
  await payloadHelloRejected;
  stranger.close();

  // A departure must reach the survivor.
  const goodbye = waitMessage(receiver, (m) => m?.type === 'peer' && m?.event === 'bye' && m?.role === SENDER,
    'receiver <- peer bye sender');
  sender.close();
  await goodbye;
  receiver.close();
  await sleep(200);

  // -------------------------------------------------------------------------
  // PHASE B — phone first, PC second, and the LEGACY hello spelling on the PC.
  // -------------------------------------------------------------------------
  const receiver2 = await openSocket();
  const receiver2Registered = waitMessage(receiver2, (m) => m?.type === 'server' && m?.event === 'registered',
    'receiver2 registration');
  receiver2.send(JSON.stringify({type: 'hello', role: RECEIVER, buildId: 'smoke', runId: null, planVersion: null}));
  await receiver2Registered;

  const sender2 = await openSocket();
  const phone2SeesSender = waitMessage(receiver2, isPeer(SENDER), 'receiver2 <- peer hello sender');
  const sender2SeesPhone = waitMessage(sender2, isPeer(RECEIVER), 'sender2 <- peer hello receiver');
  // Legacy spelling: the coordinator must register it too, so a client build cannot break
  // the link on its own.
  sender2.send(JSON.stringify({type: 'command', action: 'HELLO', role: SENDER, runId: null, buildId: null, planVersion: null}));
  await sender2SeesPhone;
  await phone2SeesSender;

  const telemetry2 = waitMessage(receiver2, (m) => m?.type === 'command' && m?.action === 'TELEMETRY',
    'sender2 -> receiver2 TELEMETRY');
  sender2.send(JSON.stringify({
    type: 'command', action: 'TELEMETRY', runId: 'smoke', stepId: 'A2', mode: 'cyclic',
    holdMs: 1000, cursor: 3, paused: false, broadcasting: true,
    canvasDevicePx: 1020, canvasHash: 'ef015678', pausedAt: null, resumedAt: null,
  }));
  await telemetry2;

  sender2.close();
  receiver2.close();

  console.log('TF-012 r15 peer smoke PASS: canonical hello registers, legacy hello registers, '
    + 'peer presence reaches BOTH ends in both connection orders, control relays only after '
    + 'registration, unregistered clients are still refused, payload-shaped hellos are rejected, '
    + 'and a departure notifies the survivor');
} finally {
  child.kill('SIGTERM');
}
