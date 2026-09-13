/**
 * TF-012 r15 — PEER DISCOVERY / HANDSHAKE CORRECTNESS.
 *
 * WHY THIS FILE EXISTS
 *
 * Physical r14 evidence: the PC showed `AUTO TEST CONTROL ONLINE` with
 * `Control peer: WAITING FOR PHONE`, the phone showed `WAITING FOR PC SENDER`, and the PC
 * had already sent 102 telemetry messages. Both endpoints were connected; neither was
 * registered; nothing was relayed.
 *
 * Root cause: the endpoints announced themselves as `{type:'command', action:'HELLO'}`
 * while the coordinator only registers roles on `{type:'hello'}`. The handshake therefore
 * fell through to the CONTROL relay branch, where an unregistered client is rejected as
 * `unknown role` — so no role registry entry ever existed, no peer notice was ever sent,
 * no telemetry ever reached the phone, and no command ever reached the PC.
 *
 * The four message classes are now separate and each has its own validator:
 *   1. `{type:'hello', role}`                    — registration
 *   2. `{type:'peer', event, role}`              — presence notice (relay → endpoint)
 *   3. `{type:'command', action, …}`             — validated control/telemetry
 *   4. `{type:'lab-result', run}`                — validated result
 *
 * Cases pinned here: the nine the task listed, in order.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {
  TF012_AUTO_HELLO_FIELDS,
  TF012_AUTO_PEER_FIELDS,
  TF012_AUTO_RECEIVER_ROLE,
  TF012_AUTO_SENDER_ROLE,
  isTf012AutoHelloMessage,
  tf012AutoHelloMessage,
  tf012AutoPeerNotice,
  tf012AutoPeerRole,
  validateTf012AutoControlMessage,
  validateTf012AutoHelloMessage,
  validateTf012AutoPeerNotice,
} from './tf012-auto-plan.ts';
import {createTf012PeerRegistry} from './tf012-auto-peers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS = join(HERE, '..', '..', '..');
const MINI = join(EXPERIMENTS, 'tf-008-wechat-mini-receiver-poc');
const PAGE_JS_PATH = join(MINI, 'pages', 'index', 'index.js');
const miniRequire = createRequire(import.meta.url);
const autoAdapter = miniRequire(join(MINI, 'utils', 'tf012-auto.js')) as Record<string, any>;

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

/** Minimal WebSocket + window stubs so the browser sender client can be driven in Node. */
function senderClientHarness() {
  const sent: string[] = [];
  const handlers: Record<string, (event: any) => void> = {};
  const socket = {
    readyState: 1,
    send: (data: string) => sent.push(data),
    addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; },
    close: () => {},
  };
  const globals = globalThis as unknown as Record<string, any>;
  const previousWindow = globals.window;
  const previousWebSocket = globals.WebSocket;
  globals.window = {setInterval: () => 0, clearInterval: () => {}};
  globals.WebSocket = function StubWebSocket() { return socket; } as unknown as typeof WebSocket;
  (globals.WebSocket as any).OPEN = 1;

  const surface = {
    setMode: () => {}, setHoldMs: () => 0, start: () => {}, pauseCurrentFrame: () => false,
    resumeCurrentFrame: () => false, stop: () => {}, resetMetrics: () => {},
    sample: () => ({
      mode: 'static' as const, holdMs: null, cursor: 0, paused: false, broadcasting: false,
      canvasDevicePx: 1020, canvasHash: 'aaaa', pausedAt: null, resumedAt: null,
    }),
  };
  return {
    sent, handlers, socket, surface,
    restore: () => {
      globals.window = previousWindow;
      globals.WebSocket = previousWebSocket;
    },
  };
}

/** wx stub that captures the socket handlers the Mini Program adapter registers. */
function miniAdapterHarness() {
  const sent: string[] = [];
  const handlers: Record<string, (event: any) => void> = {};
  const socket = {
    send: (options: {data: string}) => sent.push(options.data),
    onOpen: (handler: () => void) => { handlers.open = handler; },
    onMessage: (handler: (event: any) => void) => { handlers.message = handler; },
    onClose: (handler: () => void) => { handlers.close = handler; },
    onError: (handler: () => void) => { handlers.error = handler; },
    close: () => {},
  };
  (globalThis as unknown as Record<string, unknown>).wx = {connectSocket: () => socket};
  return {sent, handlers, socket};
}

// ---------------------------------------------------------------------------
// 1 — the sender accepts a peer hello without routing it through the control validator
// ---------------------------------------------------------------------------

test('r15 sender: a peer hello is accepted without being validated as control', async () => {
  const {createTf012AutoSenderClient} = await import('../tf012-auto-sender-client.ts');
  const harness = senderClientHarness();
  try {
    const client = createTf012AutoSenderClient({
      surface: harness.surface as any, url: 'wss://lab/lab', buildId: 'tf012-r15-test',
    });
    harness.handlers.open?.({});
    assert.equal(client.status().peerConnected, false, 'no peer before any notice');

    // The relay's presence notice is a `peer` message, NOT a control envelope.
    assert.equal(validateTf012AutoControlMessage(
      tf012AutoPeerNotice('hello', TF012_AUTO_RECEIVER_ROLE)).ok, false,
    'a peer notice must never be a valid control message');
    harness.handlers.message?.({data: JSON.stringify(
      tf012AutoPeerNotice('hello', TF012_AUTO_RECEIVER_ROLE))});

    const status = client.status();
    assert.equal(status.peerConnected, true, 'the sender must recognise the phone peer');
    assert.ok(status.peerSeenAt != null);
    assert.equal(status.lastRejected, null, 'the notice must not be recorded as a rejection');
    // And the handshake it SENT is the canonical hello class.
    const hello = JSON.parse(harness.sent[0]);
    assert.equal(hello.type, 'hello');
    assert.equal(hello.role, TF012_AUTO_SENDER_ROLE);
    assert.equal(validateTf012AutoControlMessage(hello).ok, false,
      'the outbound hello must not be a control envelope either');

    // A bye removes presence again.
    harness.handlers.message?.({data: JSON.stringify(tf012AutoPeerNotice('bye', TF012_AUTO_RECEIVER_ROLE))});
    assert.equal(client.status().peerConnected, false);
    client.close();
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// 2 — the phone accepts a peer hello without requiring type === 'command'
// ---------------------------------------------------------------------------

test('r15 phone: a peer hello is accepted before the type==="command" filter', () => {
  const harness = miniAdapterHarness();
  const runner = autoAdapter.createAutoTestRunner({
    url: 'wss://lab/lab', token: '', buildId: 'tf012-r15-test', device: 'test',
    receiverSample: () => ({}), resetReceiverMetrics: () => {}, onLog: () => {},
  });
  runner.connect();
  harness.handlers.open?.({});
  assert.equal(runner.senderHelloAt(), null, 'no peer yet');

  // r14's code did `if (message.type !== 'command') return;` BEFORE its peer branch, so
  // this message could never be seen. It must be consumed here.
  harness.handlers.message?.({
    data: JSON.stringify(tf012AutoPeerNotice('hello', TF012_AUTO_SENDER_ROLE)),
  });
  assert.ok(runner.senderHelloAt() != null, 'the phone must register the sender peer');
  assert.equal(runner.peerPresent(), true);

  harness.handlers.message?.({
    data: JSON.stringify(tf012AutoPeerNotice('bye', TF012_AUTO_SENDER_ROLE)),
  });
  assert.equal(runner.peerPresent(), false, 'a bye clears presence');
  runner.dispose();
});

// ---------------------------------------------------------------------------
// 3 — the peer path does not weaken command validation
// ---------------------------------------------------------------------------

test('r15 validation: peer discovery does not loosen the control validator', async () => {
  // The control validator still refuses every non-control class.
  assert.equal(validateTf012AutoControlMessage(
    tf012AutoPeerNotice('hello', TF012_AUTO_SENDER_ROLE)).ok, false);
  assert.equal(validateTf012AutoControlMessage(
    tf012AutoHelloMessage(TF012_AUTO_SENDER_ROLE)).ok, false);
  assert.equal(validateTf012AutoControlMessage({type: 'lab-result', run: {}}).ok, false);

  // And a payload-shaped COMMAND is still rejected on the sender's control path.
  const {createTf012AutoSenderClient} = await import('../tf012-auto-sender-client.ts');
  const harness = senderClientHarness();
  try {
    const client = createTf012AutoSenderClient({
      surface: harness.surface as any, url: 'wss://lab/lab', buildId: 'tf012-r15-test',
    });
    harness.handlers.open?.({});
    const outcome = client.apply({type: 'command', action: 'START', chunkPayload: 'AAEC'});
    assert.match(outcome, /^rejected:/);
    assert.match(String(client.status().lastRejected), /chunkPayload/);
    client.close();
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// 4 + 5 — both connection orders must end with BOTH ends aware
// ---------------------------------------------------------------------------

test('r15 presence: PC first, then the phone — both ends discover each other', () => {
  const registry = createTf012PeerRegistry();

  // PC connects first: nobody to tell.
  const pc = registry.registrationNotices(TF012_AUTO_SENDER_ROLE);
  assert.deepEqual(pc.toOthers, []);
  assert.deepEqual(pc.toNewcomer, []);
  assert.deepEqual(registry.present(), [TF012_AUTO_SENDER_ROLE]);

  // Phone connects second: the incumbent must be told, AND the newcomer must be told.
  const phone = registry.registrationNotices(TF012_AUTO_RECEIVER_ROLE);
  assert.deepEqual(phone.toOthers, [{
    to: TF012_AUTO_SENDER_ROLE,
    message: tf012AutoPeerNotice('hello', TF012_AUTO_RECEIVER_ROLE),
  }], 'the PC must learn that the phone arrived');
  assert.deepEqual(phone.toNewcomer, [{
    to: TF012_AUTO_RECEIVER_ROLE,
    message: tf012AutoPeerNotice('hello', TF012_AUTO_SENDER_ROLE),
  }], 'the phone must learn that the PC was already there');
  // A duplicate hello is not news.
  assert.equal(registry.registrationNotices(TF012_AUTO_RECEIVER_ROLE).toOthers.length, 0);
  assert.deepEqual(registry.present(), [TF012_AUTO_SENDER_ROLE, TF012_AUTO_RECEIVER_ROLE]);
});

test('r15 presence: phone first, then the PC — both ends discover each other', () => {
  const registry = createTf012PeerRegistry();

  const phone = registry.registrationNotices(TF012_AUTO_RECEIVER_ROLE);
  assert.deepEqual(phone.toOthers, []);
  const pc = registry.registrationNotices(TF012_AUTO_SENDER_ROLE);

  assert.deepEqual(pc.toOthers, [{
    to: TF012_AUTO_RECEIVER_ROLE,
    message: tf012AutoPeerNotice('hello', TF012_AUTO_SENDER_ROLE),
  }], 'the phone must learn that the PC arrived');
  assert.deepEqual(pc.toNewcomer, [{
    to: TF012_AUTO_SENDER_ROLE,
    message: tf012AutoPeerNotice('hello', TF012_AUTO_RECEIVER_ROLE),
  }], 'the PC must learn that the phone was already there');

  // Whoever leaves notifies the survivor.
  assert.deepEqual(registry.goodbyeNotices(TF012_AUTO_RECEIVER_ROLE), [{
    to: TF012_AUTO_SENDER_ROLE,
    message: tf012AutoPeerNotice('bye', TF012_AUTO_RECEIVER_ROLE),
  }]);
  assert.deepEqual(registry.present(), [TF012_AUTO_SENDER_ROLE]);
});

// ---------------------------------------------------------------------------
// 6 + 7 — peer presence is still not enough without fresh telemetry
// ---------------------------------------------------------------------------

/** The phone page's handshake line for one progress snapshot. */
function phoneHandshake(progress: Record<string, unknown>): string {
  const store = new Map<string, unknown>();
  (globalThis as unknown as Record<string, unknown>).wx = {
    setStorageSync: (key: string, value: unknown) => store.set(key, value),
    getStorageSync: (key: string) => (store.has(key) ? store.get(key) : ''),
    removeStorageSync: (key: string) => store.delete(key),
    setClipboardData: () => {}, showToast: () => {}, showModal: () => {},
    env: {USER_DATA_PATH: '/tmp'},
  };
  let captured: Record<string, any> | null = null;
  (globalThis as unknown as Record<string, unknown>).Page = (config: Record<string, any>) => { captured = config; };
  delete miniRequire.cache[miniRequire.resolve(PAGE_JS_PATH)];
  miniRequire(PAGE_JS_PATH);
  const config = captured as unknown as Record<string, any>;
  const ctx: Record<string, any> = Object.assign(Object.create(null), config);
  ctx.setData = (patch: Record<string, unknown>) => { Object.assign(ctx.data, patch); };
  const patch = ctx.autoProgressPatch(progress);
  return String(patch.autoHandshake);
}

const BASE_PROGRESS = {
  phase: 'WAITING_FOR_SENDER', status: 'WAITING_FOR_SENDER', stepId: null,
  label: 'WAITING FOR PC SENDER', stepIndex: 0, stepCount: 5, remainingMs: 0, paused: false,
  requested: '—', senderConfirmed: false, senderMismatch: null, pauseRequested: false,
  pauseConfirmed: false, frozenCursor: null, holdMs: null,
};

test('r15 handshake: a peer with no fresh telemetry still reads as waiting', () => {
  // Control socket up, but no peer registered yet.
  assert.match(phoneHandshake({
    ...BASE_PROGRESS, senderConnected: true, senderHello: false, telemetryAgeMs: null, telemetryFresh: false,
  }), /NO PEER/);
  // Peer found, but its telemetry is missing or stale — still not "connected".
  assert.match(phoneHandshake({
    ...BASE_PROGRESS, senderConnected: true, senderHello: true, telemetryAgeMs: null, telemetryFresh: false,
  }), /TELEMETRY STALE/);
  assert.match(phoneHandshake({
    ...BASE_PROGRESS, senderConnected: true, senderHello: true, telemetryAgeMs: 99999, telemetryFresh: false,
  }), /TELEMETRY STALE/);
});

test('r15 handshake: peer + fresh telemetry is the only "SENDER CONNECTED"', () => {
  const connected = phoneHandshake({
    ...BASE_PROGRESS, senderConnected: true, senderHello: true, telemetryAgeMs: 40, telemetryFresh: true,
  });
  assert.match(connected, /SENDER CONNECTED/);
  // The full progression the task specified.
  assert.match(phoneHandshake({...BASE_PROGRESS, senderConnected: false, senderHello: false,
    telemetryAgeMs: null, telemetryFresh: false}), /WAITING FOR PC SENDER/);
  assert.match(phoneHandshake({...BASE_PROGRESS, senderConnected: true, senderHello: false,
    telemetryAgeMs: null, telemetryFresh: false}), /CONTROL ONLINE, NO PEER/);
  assert.match(phoneHandshake({...BASE_PROGRESS, senderConnected: true, senderHello: true,
    telemetryAgeMs: 40, telemetryFresh: true}), /SENDER CONNECTED/);
});

// ---------------------------------------------------------------------------
// 8 — a malformed peer message is ignored safely on both ends
// ---------------------------------------------------------------------------

test('r15 robustness: malformed peer messages are ignored, never fatal', async () => {
  const hostile: unknown[] = [
    null, 'text', 42, [], {},
    {type: 'peer'},
    {type: 'peer', event: 'hello'},
    {type: 'peer', event: 'hello', role: 'someone-else'},
    {type: 'peer', event: 'nonsense', role: TF012_AUTO_SENDER_ROLE},
    {type: 'peer', event: 'hello', role: TF012_AUTO_SENDER_ROLE, extra: 1},
    {type: 'peer', event: 'hello', role: TF012_AUTO_SENDER_ROLE, payloadBytes: 'AAEC'},
  ];
  for (const message of hostile) {
    assert.equal(validateTf012AutoPeerNotice(message).ok, false, `must be rejected: ${JSON.stringify(message)}`);
    assert.equal(validateTf012AutoControlMessage(message).ok, false);
  }

  const {createTf012AutoSenderClient} = await import('../tf012-auto-sender-client.ts');
  const harness = senderClientHarness();
  try {
    const client = createTf012AutoSenderClient({
      surface: harness.surface as any, url: 'wss://lab/lab', buildId: 'tf012-r15-test',
    });
    harness.handlers.open?.({});
    harness.handlers.message?.({data: JSON.stringify(tf012AutoPeerNotice('hello', TF012_AUTO_RECEIVER_ROLE))});
    for (const message of hostile) {
      harness.handlers.message?.({data: JSON.stringify(message)});
    }
    // Presence survives; nothing was applied; no crash.
    assert.equal(client.status().peerConnected, true);
    assert.equal(client.status().commandsApplied, 0);
    assert.equal(client.status().lastRejected, null);
    // Garbage that is not even JSON is also safe.
    harness.handlers.message?.({data: 'not json at all'});
    assert.equal(client.status().lastRejected, 'malformed JSON');
    client.close();
  } finally {
    harness.restore();
  }

  const mini = miniAdapterHarness();
  const runner = autoAdapter.createAutoTestRunner({
    url: 'wss://lab/lab', token: '', buildId: 'tf012-r15-test', device: 'test',
    receiverSample: () => ({}), resetReceiverMetrics: () => {}, onLog: () => {},
  });
  runner.connect();
  mini.handlers.open?.({});
  for (const message of hostile) {
    mini.handlers.message?.({data: JSON.stringify(message)});
  }
  mini.handlers.message?.({data: '{"broken"'});
  assert.equal(runner.peerPresent(), false, 'garbage must never fake a peer');
  runner.dispose();
});

// ---------------------------------------------------------------------------
// 9 — nothing payload-shaped can travel on the discovery path
// ---------------------------------------------------------------------------

test('r15 control channel: the discovery path carries no payload or oracle', () => {
  // The two discovery classes have fixed, tiny field sets.
  assert.deepEqual([...TF012_AUTO_HELLO_FIELDS], ['type', 'role', 'buildId', 'runId', 'planVersion']);
  assert.deepEqual([...TF012_AUTO_PEER_FIELDS], ['type', 'event', 'role']);

  const hello = tf012AutoHelloMessage(TF012_AUTO_SENDER_ROLE, {buildId: 'x', runId: null, planVersion: null});
  assert.deepEqual(Object.keys(hello).sort(), ['buildId', 'planVersion', 'role', 'runId', 'type']);

  // Payload-shaped fields, nested objects and oversized strings are refused outright.
  for (const bad of [
    {type: 'hello', role: TF012_AUTO_SENDER_ROLE, chunkPayload: 'AA'},
    {type: 'hello', role: TF012_AUTO_SENDER_ROLE, fileBytes: 'AA'},
    {type: 'hello', role: TF012_AUTO_SENDER_ROLE, frameBytes: 'AA'},
    {type: 'hello', role: TF012_AUTO_SENDER_ROLE, expectedCrc: 1},
    {type: 'hello', role: TF012_AUTO_SENDER_ROLE, extra: {a: 1}},
    {type: 'hello', role: TF012_AUTO_SENDER_ROLE, buildId: 'a'.repeat(400)},
    {type: 'hello', role: 'tf012-auto-evil'},
  ]) {
    assert.equal(validateTf012AutoHelloMessage(bad).ok, false, `hello must reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => tf012AutoHelloMessage(TF012_AUTO_SENDER_ROLE, {chunkPayload: 'AA'}),
    /Illegal TF-012 auto hello/);

  // A peer notice can only ever name a role and an event.
  assert.deepEqual(tf012AutoPeerNotice('hello', TF012_AUTO_RECEIVER_ROLE),
    {type: 'peer', event: 'hello', role: TF012_AUTO_RECEIVER_ROLE});
  assert.equal(tf012AutoPeerRole(TF012_AUTO_SENDER_ROLE), TF012_AUTO_RECEIVER_ROLE);
  assert.equal(tf012AutoPeerRole('nobody'), null);
});

// ---------------------------------------------------------------------------
// The class split itself, pinned as a source invariant
// ---------------------------------------------------------------------------

test('r15 classes: the endpoints announce themselves with type "hello"', () => {
  const SENDER = readFileSync(join(EXPERIMENTS, 'tf-002-single-code', 'src',
    'tf012-auto-sender-client.ts'), 'utf8');
  const PHONE = readFileSync(join(MINI, 'utils', 'tf012-auto.js'), 'utf8');

  for (const [label, source] of [['sender', SENDER], ['phone', PHONE]] as const) {
    assert.match(source, /tf012AutoHelloMessage\(TF012_AUTO_(SENDER|RECEIVER)_ROLE/,
      `${label} must register with the canonical hello class`);
    assert.equal(/tf012AutoCommand\('HELLO'/.test(source), false,
      `${label} must not send the handshake as a control envelope`);
  }
  // The handshake spelling the relay accepts, from the relay side.
  const RELAY = readFileSync(join(EXPERIMENTS, 'tf-002-single-code', 'lab-server.mjs'), 'utf8');
  assert.match(RELAY, /isTf012AutoHelloMessage\(message\)/);
  assert.match(RELAY, /registrationNotices/);
  assert.match(RELAY, /toNewcomer/);
  // A hello is recognised in either spelling, so a client's build cannot break the link.
  assert.equal(isTf012AutoHelloMessage({type: 'hello', role: TF012_AUTO_SENDER_ROLE}), true);
  assert.equal(isTf012AutoHelloMessage({
    type: 'command', action: 'HELLO', role: TF012_AUTO_SENDER_ROLE}), true);
  assert.equal(isTf012AutoHelloMessage({type: 'command', action: 'TELEMETRY'}), false);
  assert.equal(validateTf012AutoHelloMessage({
    type: 'command', action: 'HELLO', role: TF012_AUTO_RECEIVER_ROLE}).ok, true);
});
