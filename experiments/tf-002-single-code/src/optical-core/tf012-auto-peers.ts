/**
 * TF-012 r15 — peer presence registry (pure, order-independent).
 *
 * The physical r14 run showed both endpoints connected with neither aware of the other.
 * Part of the cause was the handshake message class; the other part is that the relay only
 * ever told the ALREADY-CONNECTED side about a new client. Whoever connected second was
 * never told about the first, so presence depended on connection order.
 *
 * This registry makes presence deterministic: registering a role returns BOTH
 *   - the peers that were already present (the newcomer must be told about them), and
 *   - whether the newcomer is news for the others (they must be told about it).
 *
 * It is pure and synchronous, so both connection orders are unit-testable without a socket.
 */
import {
  TF012_AUTO_RECEIVER_ROLE,
  TF012_AUTO_SENDER_ROLE,
  tf012AutoPeerNotice,
  type Tf012AutoHelloRole,
} from './tf012-auto-plan.ts';

export {TF012_AUTO_RECEIVER_ROLE, TF012_AUTO_SENDER_ROLE};

export interface Tf012AutoPeerNotice {
  to: Tf012AutoHelloRole;
  message: ReturnType<typeof tf012AutoPeerNotice>;
}

export interface Tf012AutoPeerRegistry {
  /** Register a role. Idempotent: a repeated hello from the same role is not news. */
  register: (role: Tf012AutoHelloRole) => {isNew: boolean; alreadyPresent: Tf012AutoHelloRole[]};
  unregister: (role: Tf012AutoHelloRole) => Tf012AutoHelloRole[];
  present: () => Tf012AutoHelloRole[];
  has: (role: Tf012AutoHelloRole) => boolean;
  /**
   * Everything the relay must SEND when `role` registers:
   *   toOthers   — a 'hello' notice about the newcomer, for each peer already present
   *   toNewcomer — a 'hello' notice about each peer already present
   * Both lists come from the same registry, so neither direction can be forgotten.
   */
  registrationNotices: (role: Tf012AutoHelloRole) => {
    toOthers: Tf012AutoPeerNotice[];
    toNewcomer: Tf012AutoPeerNotice[];
  };
  /** Notices to send when a role disappears. */
  goodbyeNotices: (role: Tf012AutoHelloRole) => Tf012AutoPeerNotice[];
}

export function createTf012PeerRegistry(): Tf012AutoPeerRegistry {
  /** Roles currently registered, in registration order. */
  const order: Tf012AutoHelloRole[] = [];

  const present = (): Tf012AutoHelloRole[] => order.slice();
  const has = (role: Tf012AutoHelloRole): boolean => order.includes(role);

  const register = (role: Tf012AutoHelloRole) => {
    const isNew = !order.includes(role);
    if (isNew) order.push(role);
    // "alreadyPresent" is every OTHER role that was here first — the newcomer has to be
    // told about them, which is exactly what the r14 relay failed to do.
    const alreadyPresent = order.filter((candidate) => candidate !== role);
    return {isNew, alreadyPresent};
  };

  const unregister = (role: Tf012AutoHelloRole): Tf012AutoHelloRole[] => {
    const index = order.indexOf(role);
    if (index >= 0) order.splice(index, 1);
    return present();
  };

  const registrationNotices = (role: Tf012AutoHelloRole) => {
    const {isNew, alreadyPresent} = register(role);
    if (!isNew) return {toOthers: [], toNewcomer: []};
    return {
      toOthers: alreadyPresent.map((peer) => ({to: peer, message: tf012AutoPeerNotice('hello', role)})),
      toNewcomer: alreadyPresent.map((peer) => ({to: role, message: tf012AutoPeerNotice('hello', peer)})),
    };
  };

  const goodbyeNotices = (role: Tf012AutoHelloRole): Tf012AutoPeerNotice[] =>
    unregister(role).map((peer) => ({to: peer, message: tf012AutoPeerNotice('bye', role)}));

  return {register, unregister, present, has, registrationNotices, goodbyeNotices};
}
