# Technical Options — Pre-G1

Status: **Evidence-informed hypotheses; no architecture decision is approved yet.**

This document records candidate technical paths and how discovery changed their relative priority. It deliberately does **not** make G1 decisions.

## 1. Key finding since the first draft

Public prior art materially reduces uncertainty around the basic mechanism:

- animated standard QR + fountain coding has been demonstrated for one-way file transfer;
- browser-based sender/receiver paths exist;
- native mobile receivers also exist;
- multi-code frames and custom dense optical codes can scale throughput;
- several projects report ≥100 KB/s under particular device/setup conditions.

Relevant examples are recorded in `COMPETITIVE_LANDSCAPE.md`.

This means the first OptiLink spike should optimize for **fast independent reproduction and measurement**, not for inventing a novel visual code immediately.

## 2. Sender candidates

### S1 — Browser / TypeScript

**Pros**
- zero-install potential;
- broad desktop reach;
- File API, Canvas/WebGL and Web Workers available;
- can be served statically or packaged as PWA/self-hosted assets;
- public prior art shows browser senders are viable.

**Risks**
- display timing variance;
- browser throttling/background behavior;
- refresh-rate differences;
- offline packaging and enterprise browser-policy details.

**Current evidence-weighted hypothesis:** **S1 first.**

The sender side is not where we currently expect the hardest bottleneck, and zero-install is a likely product requirement for managed endpoints.

---

### S2 — Native desktop app

**Pros**
- more deterministic render timing;
- easier access to low-level display/GPU behavior;
- packaged offline operation.

**Risks**
- installation/admin approval burden;
- Windows/macOS packaging work;
- weaker fit for the "no software install on source workstation" scenario.

**Current hypothesis:** fallback/optimization path if browser rendering becomes the measured bottleneck.

## 3. Android receiver candidates

### R1 — Mobile browser receiver

**Pros**
- fastest route to an end-to-end spike;
- zero-install on both ends is possible;
- WebAssembly QR/vision decoders are available;
- public projects demonstrate real browser camera receivers.

**Risks**
- inconsistent camera constraints across Android browsers/devices;
- limited control over autofocus, exposure, resolution and frame delivery;
- browser/OS thermal and scheduling behavior can be opaque.

**Updated hypothesis:** **benchmark R1 first**, because discovery shows it may be sufficient and minimizes implementation before the transport is validated.

---

### R2 — Kotlin + CameraX native receiver

**Pros**
- stronger camera lifecycle/control;
- direct frame analysis pipeline;
- better instrumentation for FPS, dropped frames and device telemetry;
- likely more predictable optimization path for industrial deployment.

**Risks**
- Android-specific implementation cost;
- APK deployment/management;
- could be premature if browser already clears the target comfortably.

**Updated hypothesis:** use R2 as the **performance/control escalation path** if R1 cannot meet stability/measurement needs, or if enterprise deployment requires native control.

This is a change from the initial "native first" assumption and is intentionally left for G1 review.

## 4. Optical carrier candidates

### C1 — Single standard QR

Use as the minimum-complexity reference point.

Purpose:
- validate camera/decode pipeline;
- establish a reproducible low-density baseline;
- measure how far simple sequential/erasure-coded transfer can go.

Not expected to be the final performance ceiling.

---

### C2 — Multiple standard QR/codes per displayed frame

Use parallel visual regions to increase payload density while retaining mature decoding libraries.

Public prior art makes this a strong candidate for the first serious attempt at the ≥100 KB/s target.

Risks:
- more decode CPU;
- unequal focus/perspective across tiles;
- display/camera resolution limits.

**Current hypothesis:** likely first performance carrier after C1 baseline.

---

### C3 — Custom monochrome dense optical code

Potential advantages:
- less finder/header overhead;
- fixed fiducials and known grid geometry;
- tunable symbol size and ECC;
- better control of frame identity and synchronization.

Risks:
- substantial codec/computer-vision work;
- easy to overfit to one display/camera pair;
- must independently prove robustness.

**Current hypothesis:** do not start here. Use only if standard-code results justify further density work.

---

### C4 — Color / multilevel custom code

Projects such as `libcimbar` demonstrate the potential of dense color/icon matrices, but color pipelines introduce calibration, white-balance, glare and device-variation risk.

Reference: https://github.com/sz3/libcimbar

**Current hypothesis:** later research only.

## 5. One-way loss-recovery candidates

### F1 — Indexed chunks + repeat loop

**Pros:** trivial implementation and debugging.

**Cons:** missed specific chunks create stalls; efficiency degrades badly as the receiver waits for rare missing frames.

Use only as a reference implementation if needed.

---

### F2 — Reed-Solomon block groups

**Pros:** mature fixed-rate erasure/error recovery; deterministic overhead.

**Cons:** block-group boundaries can still stall if losses exceed group parity; less flexible for an endless one-way stream.

Useful for visual-frame ECC or grouped transport recovery.

---

### F3 — Fountain / rateless erasure coding

Public prior art strongly supports this pattern for no-back-channel optical transfer. Examples include TXQR, Decimen, optical-transfer and libcimbar-related stacks.

References:
- https://github.com/divan/txqr
- https://github.com/tristanheilman/optical-transfer
- https://github.com/sz3/libcimbar

**Pros**
- receiver can reconstruct after collecting enough useful symbols in any order;
- dropped/blurred frames cost time rather than requiring explicit retransmission;
- natural fit for one-way transport.

**Risks**
- implementation/protocol complexity;
- overhead and decoder memory must be measured;
- licensing/provenance must be considered if third-party code is reused.

**Current hypothesis:** F3 is the leading transport-recovery candidate for G1, potentially combined with the visual code's own ECC.

## 6. Protocol separation hypothesis

Prefer a layered design:

```text
File / Typed Object Layer
          ↓
Manifest + Integrity + Policy Metadata
          ↓
Transfer Session / Erasure Recovery
          ↓
Optical Frame Envelope
          ↓
Carrier Adapter (QR / multi-code / custom)
          ↓
Screen → Camera
```

This keeps enterprise semantics and transfer identity independent of the visual carrier.

A future carrier change should not require redefining what a file, diagnostic bundle, configuration snapshot or signed package means.

## 7. Clean-room / open-source reuse options

G1 should explicitly choose one of these policies before implementation:

### OSS-1 — Clean-room OptiLink transport

Use public projects as research references only; implement protocol/code independently from specifications/literature.

**Pros:** clearest IP/provenance story; full control.

**Cons:** more development and risk of repeating solved work.

### OSS-2 — Reuse permissively licensed components

Use mature MIT/Apache/MPL components where they provide commodity functions (e.g. QR decoding), with notices and provenance tracked.

**Pros:** faster and lower technical risk.

**Cons:** license review and third-party dependency management required.

### OSS-3 — Derive from an existing optical-transfer stack

Fastest path but can constrain licensing/product architecture. Current AGPL components in particular may be unsuitable for the intended commercial model without a deliberate license strategy.

**Current hypothesis:** prefer **OSS-2 for commodity libraries** plus an OptiLink-owned protocol/application layer. Do not copy competitor transport code until G1 approves provenance strategy.

## 8. Recommended staged spike for G1 review

This is a proposal, not approval:

### Stage A — Fastest end-to-end proof

- desktop browser/TypeScript sender;
- Android phone browser receiver;
- standard QR baseline;
- SHA-256 integrity;
- minimal transport envelope;
- benchmark instrumentation from `BENCHMARK_SPEC.md`.

### Stage B — Performance scaling

- multi-code visual frames;
- fountain-style one-way recovery;
- Web Workers/WASM decoder pipeline;
- attempt stable ≥100 KB/s median goodput.

### Stage C — Native escalation only if evidence requires it

- Kotlin + CameraX receiver;
- explicit resolution/FPS/exposure instrumentation;
- compare against browser receiver using the same protocol and payload.

### Stage D — Custom carrier research only after measured bottleneck

- fixed fiducials / dense grid / custom code;
- monochrome first;
- color/multilevel only if it produces a clear quantified benefit.

## 9. What G1 still needs from the owner

1. Approve or reject the working product position: **enterprise/industrial optical data-exchange platform, with file-transfer MVP as transport validation**.
2. Approve browser-first sender.
3. Approve browser-first Android receiver with native escalation path, or require native Android from day one.
4. Approve standard QR → multi-code staged carrier path.
5. Approve fountain-style erasure recovery as the leading one-way strategy.
6. Approve open-source provenance policy.
7. Identify the actual Android test device and primary sender/display available for the physical benchmark.

Until those are resolved, architecture-specific implementation remains blocked.
