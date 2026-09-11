# TF-011 — Session / Manifest Inventory (Phase 1)

Issue: #51 · Branch: `spike/tf-011-broadcast-resume-session` · Stacked on PR #50.

Map of the current session/manifest/reconstruction state before TF-011 changes.
Guidance source: PR #49 (`OPTILINK_BROADCAST_RESUME_PRODUCT_PRINCIPLES.md`).

| # | Question | Before TF-011 | Minimum change |
|---|---|---|---|
| 1 | Session identity | Manifest carries `sessionId`, `file.sha256`, `byteLength`, `fountainSeed`, `blockSize`, `matrixSize` — but no canonical key was computed | Add `sessionKey(manifest)` over these fields |
| 2 | Manifest lifetime | Assumed to appear once; first recovery initialized the decoder (`if recovered && !manifest`) | Idempotent replay: same key never resets; new key switches |
| 3 | Dynamic symbol ↔ Manifest association | Implicit (symbols decoded only against the active decoder) | Route symbols only into the active session; reject before Manifest |
| 4 | Duplicate handling | `FountainDecoder.addSymbol` returns `duplicate` (counted) | Already correct (normal broadcast behavior) |
| 5 | Redundant symbol handling | `addSymbol` returns `redundant` (counted) | Already correct |
| 6 | Serializable receive state | No export | `exportCheckpoint()`: manifest + solved-block snapshot + geometric locks |
| 7 | FountainDecoder restore | Not serializable internally (equations/adjacency) | Rebuild via `solvedBlocksSnapshot()` re-added as degree-1 symbols |
| 8 | Session switching | Not present | Explicit transition: preserve prior checkpoint, switch, restore-if-known |
| 9 | Dynamic frames before Manifest | `acceptDynamicFrame` returned 0 (ignored) | Count as `rejectedFrames` (explicit) |

## Design decisions
- **Session key** = `protocol|version|sessionId|sha256|byteLength|matrixSize|blockSize|seed` (reuses existing Manifest fields; no duplicated metadata).
- **Checkpoint** stores `manifest`, solved source blocks (base64), `normalizedMode`, and the 3 geometric `PixelLock`s — NOT FountainDecoder internals. Restore rebuilds the decoder deterministically by re-adding solved blocks as degree-1 symbols.
- **Transition policy (documented)**: same session key → idempotent replay (no reset); different valid session → switch (preserve prior checkpoint, restore new session from its own checkpoint if present); malformed/integrity-failed Manifest → rejected (no change).
- **Sender**: stateless broadcast (`standalone=broadcast`), manifest burst + N dynamic symbols per cycle, multi-session via `setSession(i)`; no receiver feedback.
- **Late-join note**: COLD late join (fresh receiver — no orientation, no locks, no Manifest, no decoder) is supported via a periodic acquisition beacon: the sender re-emits orientation(64) + preamble(96) at the start of every broadcast cycle, and the core's `processFrame()` greedily re-acquires orientation → preamble → Manifest → symbols from future broadcast content only. No sender restart, no ACK, no receiver feedback.
