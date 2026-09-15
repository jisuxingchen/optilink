/**
 * TF-012 r15b — peer presence registry, keyed by SOCKET.
 *
 * WHY THIS FILE CHANGED
 *
 * The first shipped version tracked presence as a single role boolean. That is unsafe
 * whenever a socket is replaced before its close event fires — browser reload, duplicated
 * tab, Mini Program recompile/reopen, flaky mobile network. The sequence
 *
 *   1. sender socket A registers
 *   2. sender socket B registers (stale A is still open)
 *   3. the registry sees the role already present, so B is not "news"
 *   4. A finally closes
 *   5. close unconditionally removed the ROLE
 *   6. B is still alive and registered, but the registry now says sender is absent
 *   7. phone and PC both show a live control channel with NO PEER
 *
 * …is indistinguishable from a handshake bug. Presence is therefore derived from LIVE
 * SOCKETS:
 *
 *     rolePresent(role) = count(live registered sockets for role) > 0
 *
 * Invariants enforced here:
 *   - HELLO registers THIS socket only; a hello for a role that already has a live socket
 *     still answers the newcomer with the opposite role's current presence.
 *   - A peer `hello` notice is broadcast to the opposite role only on a 0 -> 1 transition.
 *   - CLOSE unregisters THIS socket only; a peer `bye` is emitted only on a 1 -> 0
 *     transition, so closing one of several sockets never withdraws presence.
 *   - Every operation returns the resulting counts so the coordinator can log them.
 *
 * Pure and synchronous: all of the above is unit-testable without a socket, and
 * `lab-tf012-peer-smoke.mjs` additionally proves it through the real relay.
 */
import {
  TF012_AUTO_RECEIVER_ROLE,
  TF012_AUTO_SENDER_ROLE,
  tf012AutoPeerNotice,
  type Tf012AutoHelloRole,
} from './tf012-auto-plan.ts';

export {TF012_AUTO_RECEIVER_ROLE, TF012_AUTO_SENDER_ROLE};

export interface Tf012AutoPeerNotice {
  message: ReturnType<typeof tf012AutoPeerNotice>;
}

export interface Tf012AutoPeerCounts {
  senderSockets: number;
  receiverSockets: number;
}

export interface Tf012AutoPeerRegistrationPlan {
  /** Broadcast to every live socket of the opposite role — only on a 0 -> 1 transition. */
  toOppositeRole: Tf012AutoPeerNotice[];
  /** The newcomer's own snapshot — sent when the opposite role is currently present. */
  toThisSocket: Tf012AutoPeerNotice[];
  /** True when this registration made the role present (0 -> 1). */
  roleBecamePresent: boolean;
  counts: Tf012AutoPeerCounts;
}

export interface Tf012AutoPeerGoodbyePlan {
  /** Broadcast to the opposite role — EMPTY unless the role just became absent (1 -> 0). */
  toOppositeRole: Tf012AutoPeerNotice[];
  /** The role this socket had, or null when it was never registered. */
  role: Tf012AutoHelloRole | null;
  /** True when the last live socket for the role went away. */
  roleBecameAbsent: boolean;
  counts: Tf012AutoPeerCounts;
}

export interface Tf012AutoPeerRegistry {
  registerSocket: (socketId: string, role: Tf012AutoHelloRole) => Tf012AutoPeerRegistrationPlan;
  unregisterSocket: (socketId: string) => Tf012AutoPeerGoodbyePlan;
  socketsFor: (role: Tf012AutoHelloRole) => string[];
  counts: () => Tf012AutoPeerCounts;
  present: () => Tf012AutoHelloRole[];
  has: (role: Tf012AutoHelloRole) => boolean;
  /** "senderSockets=1 receiverSockets=1" — the one-line diagnostic the relay logs. */
  describe: () => string;
}

function opposite(role: Tf012AutoHelloRole): Tf012AutoHelloRole {
  return role === TF012_AUTO_SENDER_ROLE ? TF012_AUTO_RECEIVER_ROLE : TF012_AUTO_SENDER_ROLE;
}

export function createTf012PeerRegistry(): Tf012AutoPeerRegistry {
  /** socketId -> role. One entry per LIVE registered socket; that is the whole model. */
  const bySocket = new Map<string, Tf012AutoHelloRole>();

  const socketsFor = (role: Tf012AutoHelloRole): string[] =>
    [...bySocket.entries()].filter(([, candidate]) => candidate === role).map(([id]) => id);

  const counts = (): Tf012AutoPeerCounts => ({
    senderSockets: socketsFor(TF012_AUTO_SENDER_ROLE).length,
    receiverSockets: socketsFor(TF012_AUTO_RECEIVER_ROLE).length,
  });

  const has = (role: Tf012AutoHelloRole): boolean => socketsFor(role).length > 0;
  const present = (): Tf012AutoHelloRole[] => {
    const all: Tf012AutoHelloRole[] = [TF012_AUTO_SENDER_ROLE, TF012_AUTO_RECEIVER_ROLE];
    return all.filter((role) => has(role));
  };
  const describe = (): string => {
    const {senderSockets, receiverSockets} = counts();
    return `senderSockets=${senderSockets} receiverSockets=${receiverSockets}`;
  };

  const registerSocket = (socketId: string, role: Tf012AutoHelloRole): Tf012AutoPeerRegistrationPlan => {
    const previousRole = bySocket.get(socketId) ?? null;
    if (previousRole === role) {
      // Idempotent re-hello from the SAME socket: presence is unchanged, but the snapshot
      // is still returned so a re-registering client is told what is present.
      return {
        toOppositeRole: [],
        toThisSocket: has(opposite(role))
          ? [{message: tf012AutoPeerNotice('hello', opposite(role))}]
          : [],
        roleBecamePresent: false,
        counts: counts(),
      };
    }
    // A socket that changes role must stop being counted for the old one first, so a stale
    // role cannot be kept alive by a socket that now belongs to the other side.
    if (previousRole) bySocket.delete(socketId);
    const wasPresent = has(role);
    bySocket.set(socketId, role);
    const roleBecamePresent = !wasPresent;
    return {
      // Only a role that just arrived is news for the other side.
      toOppositeRole: roleBecamePresent ? [{message: tf012AutoPeerNotice('hello', role)}] : [],
      // The newcomer ALWAYS learns the opposite role's current presence, even when its own
      // role already had another socket.
      toThisSocket: has(opposite(role))
        ? [{message: tf012AutoPeerNotice('hello', opposite(role))}]
        : [],
      roleBecamePresent,
      counts: counts(),
    };
  };

  const unregisterSocket = (socketId: string): Tf012AutoPeerGoodbyePlan => {
    const role = bySocket.get(socketId) ?? null;
    if (!role) {
      return {toOppositeRole: [], role: null, roleBecameAbsent: false, counts: counts()};
    }
    bySocket.delete(socketId);
    const roleBecameAbsent = !has(role);
    return {
      // A surviving socket with the same role keeps the presence alive: NO bye.
      toOppositeRole: roleBecameAbsent ? [{message: tf012AutoPeerNotice('bye', role)}] : [],
      role,
      roleBecameAbsent,
      counts: counts(),
    };
  };

  return {registerSocket, unregisterSocket, socketsFor, counts, present, has, describe};
}
