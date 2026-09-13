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

  // PC connects first: the role transitions 0 -> 1, so a notice is planned for the
  // opposite role — there is simply no live sender/receiver socket to receive it yet.
  const pc = registry.registerSocket('s1', TF012_AUTO_SENDER_ROLE);
  assert.deepEqual(pc.toOppositeRole, [
    {message: tf012AutoPeerNotice('hello', TF012_AUTO_SENDER_ROLE)},
  ], 'the receiver role has nobody yet, so delivery is a no-op');
  assert.deepEqual(pc.toThisSocket, [], 'and there is no opposite presence to report');
  assert.equal(pc.roleBecamePresent, true);
  assert.deepEqual(registry.present(), [TF012_AUTO_SENDER_ROLE]);

  // Phone connects second: the incumbent must be told, AND the newcomer must be told.
  const phone = registry.registerSocket('s2', TF012_AUTO_RECEIVER_ROLE);
  assert.deepEqual(phone.toOppositeRole, [
    {message: tf012AutoPeerNotice('hello', TF012_AUTO_RECEIVER_ROLE)},
  ], 'the PC must learn that the phone arrived');
  assert.deepEqual(phone.toThisSocket, [
    {message: tf012AutoPeerNotice('hello', TF012_AUTO_SENDER_ROLE)},
  ], 'the phone must learn that the PC was already there');
  assert.deepEqual(phone.counts, {senderSockets: 1, receiverSockets: 1});
  // A duplicate hello from the SAME socket is not news, but still reports the snapshot.
  const again = registry.registerSocket('s2', TF012_AUTO_RECEIVER_ROLE);
  assert.deepEqual(again.toOppositeRole, []);
  assert.deepEqual(again.toThisSocket, [{message: tf012AutoPeerNotice('hello', TF012_AUTO_SENDER_ROLE)}]);
  assert.equal(again.roleBecamePresent, false);
  assert.deepEqual(registry.present(), [TF012_AUTO_SENDER_ROLE, TF012_AUTO_RECEIVER_ROLE]);
});

test('r15 presence: phone first, then the PC — both ends discover each other', () => {
  const registry = createTf012PeerRegistry();

  const phone = registry.registerSocket('s1', TF012_AUTO_RECEIVER_ROLE);
  assert.deepEqual(phone.toOppositeRole, [
    {message: tf012AutoPeerNotice('hello', TF012_AUTO_RECEIVER_ROLE)},
  ], 'planned for the sender role; nothing is listening yet');
  const pc = registry.registerSocket('s2', TF012_AUTO_SENDER_ROLE);

  assert.deepEqual(pc.toOppositeRole, [
    {message: tf012AutoPeerNotice('hello', TF012_AUTO_SENDER_ROLE)},
  ], 'the phone must learn that the PC arrived');
  assert.deepEqual(pc.toThisSocket, [
    {message: tf012AutoPeerNotice('hello', TF012_AUTO_RECEIVER_ROLE)},
  ], 'the PC must learn that the phone was already there');

  // Whoever leaves notifies the survivor...
  const goodbye = registry.unregisterSocket('s1');
  assert.equal(goodbye.role, TF012_AUTO_RECEIVER_ROLE);
  assert.equal(goodbye.roleBecameAbsent, true);
  assert.deepEqual(goodbye.toOppositeRole, [
    {message: tf012AutoPeerNotice('bye', TF012_AUTO_RECEIVER_ROLE)},
  ]);
  assert.deepEqual(registry.present(), [TF012_AUTO_SENDER_ROLE]);
});

// ---------------------------------------------------------------------------
// r15b — OVERLAPPING SOCKETS (reload / recompile / flaky reconnect)
//
// The r15 registry tracked a role as a single boolean, so the close of a STALE socket
// removed a role that a NEWER live socket still held. These cases pin the socket-keyed
// model that replaces it.
// ---------------------------------------------------------------------------

test('r15b presence: sender B replaces A, A closes — the phone still sees a sender', () => {
  const registry = createTf012PeerRegistry();
  registry.registerSocket('senderA', TF012_AUTO_SENDER_ROLE);   // PC first
  registry.registerSocket('phone', TF012_AUTO_RECEIVER_ROLE);    // phone joins
  assert.deepEqual(registry.counts(), {senderSockets: 1, receiverSockets: 1});

  // Browser reload: the new tab registers while the old socket is still open.
  const replacement = registry.registerSocket('senderB', TF012_AUTO_SENDER_ROLE);
  assert.equal(replacement.roleBecamePresent, false, 'B is not news: A still holds the role');
  assert.deepEqual(replacement.toOppositeRole, [], 'no duplicate hello for the phone');
  assert.deepEqual(replacement.toThisSocket, [
    {message: tf012AutoPeerNotice('hello', TF012_AUTO_RECEIVER_ROLE)},
  ], 'case 8: B must still learn that the phone is present');
  assert.deepEqual(registry.counts(), {senderSockets: 2, receiverSockets: 1});

  // The stale socket finally closes: the role survives.
  const stale = registry.unregisterSocket('senderA');
  assert.equal(stale.roleBecameAbsent, false);
  assert.deepEqual(stale.toOppositeRole, [], 'closing A must NOT tell the phone the sender left');
  assert.equal(registry.has(TF012_AUTO_SENDER_ROLE), true, 'case 1: sender is still present');
  assert.deepEqual(registry.counts(), {senderSockets: 1, receiverSockets: 1});

  // Only when the LAST sender socket goes does the phone get a bye.
  const last = registry.unregisterSocket('senderB');
  assert.equal(last.roleBecameAbsent, true);
  assert.deepEqual(last.toOppositeRole, [
    {message: tf012AutoPeerNotice('bye', TF012_AUTO_SENDER_ROLE)},
  ], 'case 6: exactly one bye when the last socket leaves');
  assert.equal(registry.has(TF012_AUTO_SENDER_ROLE), false);
});

test('r15b presence: receiver B replaces A, A closes — the PC still sees the phone', () => {
  const registry = createTf012PeerRegistry();
  registry.registerSocket('phoneA', TF012_AUTO_RECEIVER_ROLE);
  registry.registerSocket('pc', TF012_AUTO_SENDER_ROLE);

  // Mini Program recompile/reopen: the old receiver socket is still alive for a moment.
  const replacement = registry.registerSocket('phoneB', TF012_AUTO_RECEIVER_ROLE);
  assert.equal(replacement.roleBecamePresent, false);
  assert.deepEqual(replacement.toThisSocket, [
    {message: tf012AutoPeerNotice('hello', TF012_AUTO_SENDER_ROLE)},
  ], 'case 8: the new receiver must learn that the PC is present');

  const stale = registry.unregisterSocket('phoneA');
  assert.deepEqual(stale.toOppositeRole, [], 'no bye while phoneB is alive');
  assert.equal(registry.has(TF012_AUTO_RECEIVER_ROLE), true, 'case 2: the phone is still present');

  const last = registry.unregisterSocket('phoneB');
  assert.deepEqual(last.toOppositeRole, [
    {message: tf012AutoPeerNotice('bye', TF012_AUTO_RECEIVER_ROLE)},
  ], 'case 7: one bye for the receiver when the last socket leaves');
});

test('r15b presence: two sockets, one closes — no bye; unknown socket — no notice at all', () => {
  const registry = createTf012PeerRegistry();
  registry.registerSocket('a', TF012_AUTO_SENDER_ROLE);
  registry.registerSocket('b', TF012_AUTO_SENDER_ROLE);
  registry.registerSocket('r', TF012_AUTO_RECEIVER_ROLE);

  // Case 5: one of two sender sockets closes -> the receiver must NOT be told.
  assert.deepEqual(registry.unregisterSocket('a').toOppositeRole, []);
  assert.deepEqual(registry.unregisterSocket('b').toOppositeRole, [
    {message: tf012AutoPeerNotice('bye', TF012_AUTO_SENDER_ROLE)},
  ]);

  // Closing a socket that never registered (or closed twice) is inert.
  const unknown = registry.unregisterSocket('never-registered');
  assert.equal(unknown.role, null);
  assert.deepEqual(unknown.toOppositeRole, []);
  assert.deepEqual(registry.counts(), {senderSockets: 0, receiverSockets: 1});
});

test('r15b presence: a socket that changes role stops counting for the old one', () => {
  const registry = createTf012PeerRegistry();
  registry.registerSocket('s1', TF012_AUTO_SENDER_ROLE);
  const switched = registry.registerSocket('s1', TF012_AUTO_RECEIVER_ROLE);
  assert.equal(switched.roleBecamePresent, true);
  assert.deepEqual(registry.counts(), {senderSockets: 0, receiverSockets: 1},
    'the old role must not be kept alive by a socket that now belongs to the other side');
  assert.deepEqual(registry.present(), [TF012_AUTO_RECEIVER_ROLE]);
});

test('r15b presence: presence is exactly "at least one live socket", in both orders', () => {
  // Case 9 invariant, stated directly: routing and presence both read live sockets.
  for (const order of [['sender', 'receiver'], ['receiver', 'sender']] as const) {
    const registry = createTf012PeerRegistry();
    const ids: string[] = [];
    for (const [index, role] of order.entries()) {
      const id = `socket-${index}`;
      ids.push(id);
      registry.registerSocket(id, role === 'sender' ? TF012_AUTO_SENDER_ROLE : TF012_AUTO_RECEIVER_ROLE);
    }
    assert.equal(registry.has(TF012_AUTO_SENDER_ROLE), true, `${order.join('->')} must see the sender`);
    assert.equal(registry.has(TF012_AUTO_RECEIVER_ROLE), true, `${order.join('->')} must see the receiver`);
    assert.deepEqual(registry.socketsFor(TF012_AUTO_SENDER_ROLE).length, 1);
    assert.match(registry.describe(), /senderSockets=1 receiverSockets=1/);
    for (const id of ids) registry.unregisterSocket(id);
    assert.equal(registry.has(TF012_AUTO_SENDER_ROLE), false);
    assert.equal(registry.has(TF012_AUTO_RECEIVER_ROLE), false);
    assert.match(registry.describe(), /senderSockets=0 receiverSockets=0/);
  }
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
// r15b — the coordinator must be able to explain itself
// ---------------------------------------------------------------------------

test('r15b diagnostics: the relay identifies itself and reports live socket counts', async () => {
  const RELAY = readFileSync(join(EXPERIMENTS, 'tf-002-single-code', 'lab-server.mjs'), 'utf8');
  // A stale coordinator (an older process still holding the port) is the failure mode that
  // looks exactly like a handshake bug, so the relay must name itself.
  assert.match(RELAY, /const RELAY_BUILD = '/, 'the relay declares its build');
  assert.match(RELAY, /event: 'connected', relay: RELAY_BUILD/, 'identity is sent on connect');
  assert.match(RELAY, /event: 'peer-registry'/, 'live counts are broadcast');
  assert.match(RELAY, /clientBuild=/,
    'registration logs the client build id, so a stale phone/page build is visible in the relay log');
  assert.match(RELAY, /TF012 peer registry: register/);
  assert.match(RELAY, /TF012 peer registry: close/);
  assert.match(RELAY, /relay: RELAY_BUILD, peerRegistry:/, 'health also exposes identity + counts');

  // The PC panel must read the diagnostics from the EXISTING lab socket: the baseline
  // pages may not add a network path (pinned by single-baseline-mini.test.ts in test 18).
  const SENDER_MAIN = readFileSync(join(EXPERIMENTS, 'tf-002-single-code', 'src',
    'single-baseline-sender-main.ts'), 'utf8');
  assert.equal(/[^.\w]fetch\s*\(/u.test(SENDER_MAIN), false,
    'the sender page must not add a fetch() network path');
  assert.match(SENDER_MAIN, /relayBuild/, 'the panel shows the coordinator identity');
  assert.match(SENDER_MAIN, /peerCounts/, 'the panel shows the live socket counts');
  const CLIENT = readFileSync(join(EXPERIMENTS, 'tf-002-single-code', 'src',
    'tf012-auto-sender-client.ts'), 'utf8');
  assert.match(CLIENT, /peer-registry|envelope\.relay|relayBuild/, 'the client carries the diagnostics');
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
  // r15b: presence is keyed by socket, and a bye is conditional on the role going 1 -> 0.
  assert.match(RELAY, /registerSocket\(/);
  assert.match(RELAY, /unregisterSocket\(/);
  assert.match(RELAY, /roleBecameAbsent/);
  assert.match(RELAY, /TF012 peer registry/);
  // A hello is recognised in either spelling, so a client's build cannot break the link.
  assert.equal(isTf012AutoHelloMessage({type: 'hello', role: TF012_AUTO_SENDER_ROLE}), true);
  assert.equal(isTf012AutoHelloMessage({
    type: 'command', action: 'HELLO', role: TF012_AUTO_SENDER_ROLE}), true);
  assert.equal(isTf012AutoHelloMessage({type: 'command', action: 'TELEMETRY'}), false);
  assert.equal(validateTf012AutoHelloMessage({
    type: 'command', action: 'HELLO', role: TF012_AUTO_RECEIVER_ROLE}).ok, true);
});
