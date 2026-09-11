# TF-009 — Architecture Inventory: Optical Receive Pipeline

Issue: #45 · Branch: `spike/tf-009-full-receive-simulation` · Stacked on PR #44.

This document maps the current TF-007/TF-008 optical receive stages and classifies
each as platform-neutral/shared or coupled to a specific platform. It is the
Phase 1 prerequisite before any refactor (TF-009 governance: "Do not refactor
until this map is clear").

## Classification legend

- **A** — already platform-neutral / shared (pure TypeScript, no DOM / canvas / camera / WebSocket / wx.*).
- **B** — embedded in the browser lab receiver (`tiled-physical-v5-main.ts`), not yet extracted.
- **C** — coupled to physical camera (`getUserMedia`, `HTMLVideoElement`).
- **D** — coupled to coordinator / WebSocket.
- **E** — missing entirely.

## Stage map

| # | Stage | Primary module(s) | Class | Notes |
|---|---|---|---|---|
| 1 | Orientation / training lock | `optical-core/orientation-acquisition.ts`, `tiled-training-solver.ts` (+`-legacy`, `-core`), `tf007h-orientation-quality.ts`, `tf007h-known-training-refine.ts`, `tiled-orientation-fiducial.ts`, `optigrid-geometry.ts` | **A** | Verdict-only API (`acquireOrientation`); the underlying `acquireKnownTrainingLock`/`countKnownErrors`/`refineKnownTrainingResidual` are shared. **Gap:** PixelLock objects are NOT exposed by the shared API — only the browser's internal `calibrationFromImage` keeps them for later stages. |
| 2 | Manifest acquisition | `oltp-manifest.ts`, `oltp-optical-session.ts`, `tf007g-manifest-recovery.ts` | **A/B** | Encode/decode/`decodeManifestObservation` are pure (A). The acquisition *loop* (`readManifestOptically`) lives in the browser receiver (B) and is camera-coupled (C). |
| 3 | Candidate / dynamic frame acquisition | `tiled-physical-v5-main.ts` (`processCandidateFrame`), `stable-fingerprint-gate.ts`, `packed-cell-sampler.ts` | **B** | Sampling primitives are pure (A), but the capture loop is embedded in the browser receiver and camera-coupled (C). |
| 4 | Frame identity / ordering | `optigrid-v1.ts` (`sequence`), `observation-spool.ts` (`captureId`) | **A** | Sequence numbers + spool ordering are pure. A shared ordering policy does not yet exist above them. |
| 5 | Payload extraction | `optigrid-v1.ts` (`decodeFrameCellsV1`), `tiled-training-solver.ts` (`decodeWithPixelLock`), `deferred-optigrid-decoder.ts` | **A** | Fully shared. |
| 6 | Integrity / error handling | `optigrid-v1.ts` (CRC32), `tiled-training-solver.ts` (`countKnownErrors`), `deferred-optigrid-decoder.ts` (threshold retries) | **A** | Fully shared. |
| 7 | Reconstruction | `fountain.ts` (`FountainEncoder`/`FountainDecoder`) | **E** | Fountain code exists and is platform-neutral, but is **not wired into the optical dynamic stage**. The sender's `renderDynamic` emits synthetic deterministic `payloadFor(symbol)` bytes, not real file-derived fountain symbols. No file → symbols → file assembler exists. |
| 8 | SHA-256 verification | none | **E** | `oltp-manifest.ts` carries a `sha256` field but it is a placeholder in the lab sender; no digest is computed over reconstructed bytes. Web Crypto can provide SHA-256 in the browser adapter; a pure-TS digest would be needed for the Mini Program adapter. |

## Cross-cutting coupling

- **Frame normalization (rotate/resize):** shared `normalizeFrame` (A). The browser
  receiver has a canvas-based equivalent (`captureNormalized`) used only for live
  video; the Mini Program uses the shared pure version.
- **Sender rendering:** `renderCells` / `renderPreamble` / `renderDynamic` in
  `tiled-physical-v5-main.ts` are canvas-coupled (B/C) — they are the *sender*,
  not the receiver, so they may remain a browser adapter.
- **Coordinator protocol:** `connect` / `send` / `waitState` / `resolvePending` are
  WebSocket-coupled (D) and are test-control only, not part of the optical path.

## Conclusion

1. All optical algorithm primitives (orientation lock, fiducial locator, OptiGrid
   v1 encode/decode, manifest encode/decode, fountain code, packed-cell buffers,
   deferred decoder, spool) are **already platform-neutral** (class A).
2. What is missing is a **shared orchestration state machine** (orientation →
   manifest → dynamic → reconstruct) that currently only exists inside
   `tiled-physical-v5-main.ts` (class B).
3. A **real file-transfer data path is missing** (class E): the dynamic sender
   must be driven from `FountainEncoder` over real file bytes, and the receiver
   must feed decoded symbols into `FountainDecoder` and verify SHA-256 over the
   reconstructed bytes.
4. No algorithm duplication is required; TF-009 is a **wiring + orchestration**
   effort plus one small shared-core extension (expose PixelLocks from the shared
   orientation path).

## Non-goals / hard boundaries

- Receiver input remains rendered pixels only (no oracle, no network payload).
- Do not modify PR #37.
- SIMULATION evidence only — never "physical raw optical ingress" or "Net Goodput".
