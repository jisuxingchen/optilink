/**
 * TF-012 r15 — peer presence registry, Node entry point for the lab coordinator.
 *
 * The implementation lives in `src/optical-core/tf012-auto-peers.ts` so it is typed and
 * shared with the tests; Node 22 strips the types on import. This file exists only so the
 * relay has a plain `.mjs` module path, exactly like `tf012-auto-policy.mjs`.
 */
export {
  TF012_AUTO_RECEIVER_ROLE,
  TF012_AUTO_SENDER_ROLE,
  createTf012PeerRegistry,
} from './src/optical-core/tf012-auto-peers.ts';

