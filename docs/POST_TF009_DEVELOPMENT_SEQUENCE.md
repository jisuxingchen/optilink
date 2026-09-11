# Post-TF-009 Development Sequence and Acceptance Gates

Status: Proposed execution plan  
Related: Issue #48, TF-009 / PR #46  
Purpose: integrate broadcast/resume product principles into the development process without destabilizing the proven shared receive core.

## 1. Why the sequence changes

TF-009 proved the clean software path:

```text
real sender pixels
→ orientation
→ Manifest
→ dynamic symbols
→ Fountain reconstruction
→ SHA-256 exact match
```

The next risk is no longer whether the protocol can reconstruct a file in software.

The next risks are:
1. Mini Program platform integration;
2. late-join / resume / duplicate / session robustness;
3. phone-side performance and physical optical behavior.

These should be isolated instead of debugged simultaneously.

## 2. Proposed work sequence

### TF-010 — WeChat Mini Program Shared Receive Core Integration

Primary goal:

```text
CameraFrame
→ PixelFrame
→ SAME SharedOpticalReceiveCore
→ Manifest
→ dynamic symbols
→ reconstruction
→ SHA-256
→ local file
```

Scope:
- bundle/export `SharedOpticalReceiveCore`;
- Mini Program camera adapter;
- receiver stage UI;
- local SHA-256 adapter;
- local file write;
- bounded frame-in-flight policy;
- non-physical integration test;
- build/version identification.

Explicit non-goals:
- no broadcast/resume feature expansion unless required for integration;
- no physical G0 claim;
- no performance target relaxation;
- no protocol fork.

Stop condition before TF-010 is complete:
- deterministic 64 KiB non-physical Mini Program integration path passes;
- same shared core lineage as TF-009;
- exact SHA match;
- no network payload path;
- exact-head CI green;
- Technical Review PASS.

### TF-011 — Broadcast / Resume / Session Robustness

Primary goal:

Prove that the receiver behaves correctly when transmission and app lifecycle are imperfect.

Required capabilities:
- receiver late join;
- periodic Manifest replay;
- duplicate-symbol tolerance;
- dropped-frame tolerance;
- receiver restart/resume;
- incomplete-session checkpoint;
- new-session detection;
- no cross-session contamination;
- bounded recovery time.

No physical phone performance optimization is required in this unit.

Recommended deterministic acceptance matrix:

| Case | Scenario | Expected result |
|---|---|---|
| A | receiver starts at frame 0 | reconstruct exact |
| B | receiver joins after ~30% of sender stream | obtains replayed Manifest and reconstructs |
| C | deterministic 10–20% visual-frame drops | reconstructs from later Fountain symbols |
| D | deterministic duplicate frames | duplicates ignored, no corruption |
| E | receive ~50%, checkpoint, destroy receiver, restore | resumes and reconstructs exact |
| F | incomplete session A then valid Manifest B | symbols never mix; session transition handled safely |
| G | repeated Manifest bursts | idempotent/session-safe |
| H | corrupted/invalid Manifest observation | rejected; does not replace valid active session |

For each case capture:
- start point;
- Manifest acquisition delay;
- useful symbol count;
- duplicate count;
- redundant count;
- rejected frames;
- checkpoint restore state;
- reconstruction result;
- SHA-256 result.

TF-011 evidence remains simulation/non-physical unless explicitly run on a real optical path.

### TF-012 — Physical Performance / Worker / Camera Pipeline

Primary goal:

Move from correctness to real phone performance.

Focus:
- Worker insertion;
- one-frame-in-flight / latest-frame policy;
- lock/track cost;
- camera callback stability;
- processing FPS;
- screen/camera geometry;
- physical Manifest/dynamic recovery;
- physical file reconstruction.

Worker insertion target:

```text
CameraFrame callback
→ bounded handoff
→ Worker/shared receive core
→ protocol result event
→ UI/file adapter
```

The main thread must not build an unbounded frame queue.

Physical performance terms remain strict:
- camera raw pixel ingress is not physical optical payload ingress;
- physical raw optical ingress is not Net Goodput;
- Net Goodput requires final reconstructed bytes and exact SHA.

### G0 — Formal acceptance

Only after the previous units are stable:

- deterministic incompressible 10 MiB file;
- real computer display → optical path → phone camera;
- payload networking disabled/offline per acceptance definition;
- 5/5 exact reconstructions;
- final SHA-256 exact;
- median ≥100 KB/s Net Goodput.

100 KB/s remains a validation target, not a product claim before G0 succeeds.

## 3. Protocol behavior to validate during TF-011

### 3.1 Periodic Manifest replay

Candidate stream:

```text
M M M
D D D ... D
M M M
D D D ... D
...
```

Where:
- M = Manifest observation/burst;
- D = dynamic Fountain-symbol frame.

The replay interval is a tunable parameter.

Do not choose it solely by intuition. Measure:
- Manifest overhead;
- worst-case late-join delay;
- recovery after app resume;
- impact on reconstructed throughput.

### 3.2 Sufficient Symbol Recovery

Do not build a request/retransmit mechanism for individual missing chunks.

Receiver completion is based on:
- valid active Manifest;
- Fountain decoder completion;
- byte-length match;
- SHA-256 match.

This keeps the sender one-way and stateless.

### 3.3 Checkpoint cadence

Initial test candidates:
- checkpoint every 1 second;
- checkpoint every 2 seconds;
- checkpoint every 16 or 32 newly useful symbols.

Measure:
- UI/main-thread impact;
- storage write cost;
- restored progress;
- amount of work lost after abrupt termination.

Choose the lightest cadence that provides acceptable resume behavior.

## 4. Mini Program state model

Recommended user-facing states:

```text
IDLE
DETECTING
SESSION_FOUND
RECEIVING
CHECKPOINTING
RECONSTRUCTING
VERIFYING
SAVING
COMPLETE
ERROR
```

Protocol/internal states may remain more detailed.

Do not expose engineering-only terms as primary UX.

Developer panel may show:
- active buildId;
- receiver stage;
- selected transform;
- triplet validity;
- Manifest age;
- decoded/useful/duplicate/redundant symbols;
- solved/total blocks;
- callback FPS;
- acquisition FPS;
- skipped frames;
- lock/track timing.

## 5. Session identity rules

A session must be uniquely distinguishable enough to prevent data mixing.

At minimum review:
- protocol version;
- sessionId;
- file SHA-256;
- byteLength;
- Fountain seed / parameters.

Receiver rules:
1. dynamic symbols are accepted only against the active decoded Manifest/session;
2. a different session cannot silently replace an incomplete session;
3. restoring a checkpoint must validate compatibility with the newly observed Manifest;
4. completed sessions should not resume accidentally.

## 6. Test-first development rule

For post-TF-009 work, prefer this order:

```text
deterministic software test
→ browser/pixel simulation
→ Mini Program non-physical adapter test
→ exact-head CI
→ Technical Review
→ physical phone test
```

Do not debug protocol architecture and physical camera behavior at the same time.

A physical retest is justified only when the same logical path has already passed deterministic software gates.

## 7. Performance optimization rule

Correctness before optimization, but instrumentation from day one.

Always record:
- wall time;
- pre-scan/normalize/lock/track/decode timing;
- frame callback rate;
- processed/skipped rate;
- useful-symbol rate;
- reconstruction throughput.

Optimize only the dominant measured stage.

Do not infer required optimization from desktop timing alone.

## 8. Sender simplification rule

The long-term product sender should not need:
- receiver-ready control messages for payload delivery;
- receiver progress;
- missing-symbol requests;
- network coordination.

A local development harness may still use control calls to deterministically advance visual states, provided receiver payload input remains rendered pixels only.

## 9. Definition of done by work unit

### TF-010 done
- Mini Program consumes shared core;
- no algorithm fork;
- 64 KiB non-physical integration reconstructs exact;
- SHA works locally;
- file write path works;
- CI green;
- Technical Review PASS.

### TF-011 done
- late join PASS;
- Manifest replay PASS;
- frame-drop PASS;
- duplicate PASS;
- checkpoint/restore PASS;
- session-switch isolation PASS;
- all deterministic SHA checks exact;
- CI green;
- Technical Review PASS.

### TF-012 done
- physical pipeline runs the same shared core;
- Worker/bounded pipeline implemented if required by profiling;
- physical Manifest + dynamic decode demonstrated;
- physical file reconstruction demonstrated;
- exact SHA;
- performance measurements correctly classified.

### G0 done
- 10 MiB deterministic incompressible;
- 5/5 exact;
- final SHA exact;
- formal offline payload boundary;
- median ≥100 KB/s Net Goodput.

## 10. Non-adopted shortcuts

Do not use the following to accelerate schedule:
- QR/Base45 as replacement for OptiGrid;
- `wx.scanCode` as the primary high-rate receiver;
- network payload fallbacks;
- receiver access to sender internal payload/state;
- CRC32 as the final file acceptance criterion;
- weakening triplet/projection/exactness rules to raise apparent FPS.

## 11. Governance

Each non-trivial unit continues to follow:

```text
Issue
→ branch
→ implementation/docs
→ CI
→ Draft PR
→ Technical Review
→ PO Gate
→ merge
→ main CI
→ close Issue
```

Technical PASS is not merge authorization.

Stacked PRs must declare their dependency explicitly.

Physical evidence and simulation evidence must remain separately labeled.
