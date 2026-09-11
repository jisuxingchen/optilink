# OptiLink Broadcast / Resume Product Principles

Status: Proposed design guidance for post-TF-009 work  
Related: Issue #48, TF-009 / PR #46  
Evidence boundary: architecture/product guidance only; no physical PASS or Net Goodput claim.

## 1. Purpose

This document records the product/protocol ideas accepted from a reviewed offline visual-file-transfer route and adapts them to OptiLink without changing the core OptiGrid + OLTP + Fountain direction already proven in TF-009.

The goal is to reduce sender/receiver coordination complexity while improving late-join, resume, duplicate tolerance, and user experience.

## 2. Core decisions

### 2.1 Sender should behave as a stateless broadcaster

The production sender should not require receiver acknowledgements for the payload path.

Target behavior:

```text
select file
→ build session Manifest
→ continuously broadcast optical session
→ periodically replay Manifest
→ continuously emit Fountain symbols
```

The sender may expose local UI controls such as start / pause / stop, but optical payload delivery must not depend on a return channel.

Why:
- preserves the offline one-way product model;
- removes coordinator/WebSocket dependency from the payload protocol;
- lets the receiver join at any time;
- reduces cross-platform coordination failure modes.

### 2.2 Receiver may join late

A receiver opening after transmission has already started should be able to recover the active session without restarting the sender.

Required mechanism:
- periodic Manifest replay;
- session identity in protocol state;
- Fountain symbol stream that does not require a particular starting symbol;
- duplicate/redundant-symbol tolerance.

### 2.3 Optimize for final consistency, not per-frame reliability

The receiver does not need every visual frame to decode successfully.

Success condition:

```text
sufficient valid independent symbols
→ Fountain reconstruction
→ exact byte length
→ final SHA-256 match
```

This is preferable to a fixed missing-chunk recovery protocol.

Product principle:

> OptiLink targets **Sufficient Symbol Recovery**, not **Missing Chunk Recovery**.

### 2.4 Keep frames/session self-identifying enough to recover state

Do not duplicate the full Manifest in every dynamic frame.

Instead:
- Manifest carries file/session/protocol metadata;
- dynamic symbols carry the minimum frame/symbol/session identity needed for de-duplication and safe routing;
- Manifest is replayed periodically.

Candidate Manifest fields:
- protocol/version;
- sessionId;
- filename;
- byteLength;
- SHA-256;
- matrix size;
- tile count;
- Fountain source block bytes;
- Fountain seed;
- optional feature flags.

Candidate dynamic identity:
- session discriminator;
- sequence / symbol id;
- integrity field already provided by OptiGrid/OLTP.

Exact wire format remains an implementation decision and must preserve existing protocol compatibility where practical.

## 3. Manifest replay

The sender should use a repeating structure such as:

```text
Manifest burst
Dynamic × N
Manifest burst
Dynamic × N
...
```

N must be determined by simulation/physical testing rather than guessed.

Acceptance criteria for the eventual design:
- receiver starting mid-stream obtains a valid Manifest within a bounded time;
- receiver does not require sender restart;
- Manifest overhead remains small relative to useful payload;
- stale Manifest/session data cannot contaminate a new session.

## 4. Resume / checkpoint model

The Mini Program receiver should persist incomplete receive sessions.

Recommended checkpoint:

```text
ReceiveCheckpoint {
  protocolVersion
  sessionId
  manifest
  seenSymbolIds
  solvedBlockCount
  totalBlockCount
  decoderResumeState?   // only if safe/stable to serialize
  updatedAt
}
```

Important implementation rule:

Do **not** synchronously persist on every camera frame or symbol.

Preferred policy:
- receive/decode in memory;
- checkpoint every 1–2 seconds, or every N newly useful symbols;
- checkpoint immediately on app lifecycle transition when safe;
- restore the incomplete session on next launch.

If Fountain decoder state is not safely serializable, persist enough accepted symbols or solved source blocks to reconstruct decoder state deterministically.

## 5. Session switching

When a different valid Manifest is observed while another session is incomplete, the receiver must not mix symbols.

Required behavior:
- detect new sessionId / file identity;
- keep current incomplete session checkpoint;
- prompt or apply a clearly defined session-selection rule;
- route subsequent symbols only to the active session.

No symbol should be accepted into a decoder whose Manifest/session identity does not match.

## 6. Duplicate and loss handling

Duplicates are normal broadcast behavior, not an error.

Receiver metrics should distinguish:
- captured visual frames;
- decoded frames;
- useful new symbols;
- duplicate symbols;
- redundant Fountain symbols;
- rejected/invalid frames;
- dropped camera frames.

Dropped frames should not trigger sender retransmission. The receiver waits for later useful symbols.

## 7. Product UI model

Engineering diagnostics remain available, but the normal user flow should be file-centric.

Suggested product states:

```text
Waiting for transfer
→ File detected: <name> / <size>
→ Receiving: <progress>
→ Reconstructing
→ Verifying SHA-256
→ Saving
→ Complete
```

Developer diagnostics may separately expose:
- camera FPS;
- acquisition FPS;
- selected transform;
- triplet status;
- decoded symbol count;
- duplicate/redundant counts;
- skipped frames;
- lock timing.

## 8. Local file result

On successful reconstruction:
1. exact reconstructed byte length must match Manifest;
2. SHA-256 must match Manifest-carried SHA;
3. bytes may then be written to Mini Program local storage;
4. completion UI must distinguish reconstructed / verified / saved states.

No upload or network-assisted payload path is allowed.

## 9. What is intentionally NOT adopted

### 9.1 QR as primary carrier

Do not replace OptiGrid with sequential QR codes.

Reason:
- the reviewed QR route targets low single-digit KB/s;
- OptiLink G0 target is ≥100 KB/s physical Net Goodput;
- TF-009 has already proven the OptiGrid/OLTP/Fountain software chain end-to-end.

QR may remain a future fallback/bootstrap/compatibility option only if justified separately.

### 9.2 Base45 for primary payload

Do not add Base45 to the primary OptiGrid payload path.

Reason:
- Base45 exists to fit QR alphanumeric encoding;
- OptiGrid can carry binary protocol data directly;
- text encoding would add expansion and CPU work without benefit.

### 9.3 wx.scanCode / takePhoto loop as the main high-rate receiver

Keep `CameraFrame → PixelFrame` as the main receive adapter.

Reason:
- physical PoC already demonstrated ~25–30 camera callbacks/s;
- scanCode/takePhoto loops add unnecessary latency and image I/O;
- the shared optical core is already designed around PixelFrame.

### 9.4 CRC32 as final file acceptance

Keep:
- frame/protocol integrity checks where appropriate;
- **final SHA-256** as the file-level acceptance condition.

Do not downgrade final integrity to CRC32.

## 10. Architectural target

```text
PC Sender
  File bytes
    → FountainEncoder
    → OLTP / OptiGrid visual symbols
    → periodic Manifest + continuous symbol broadcast
    → display

Phone Receiver
  CameraFrame
    → PixelFrame
    → SharedOpticalReceiveCore
    → Manifest/session
    → useful Fountain symbols
    → de-duplication
    → checkpoint
    → reconstruction
    → SHA-256
    → local file
```

## 11. Evidence terminology

Keep these distinct:
- theoretical gross capacity;
- simulated/pixel raw ingress;
- simulated reconstructed throughput;
- physical raw optical ingress;
- Net Goodput.

Only a real display → optical path → phone camera → reconstruction → final SHA-256 exact match may qualify as physical Net Goodput evidence.

## 12. Immediate integration point

This document should guide TF-010 and the work that follows it.

TF-010 should first integrate the proven `SharedOpticalReceiveCore` into the Mini Program.

Broadcast/resume/session-hardening work should then be validated as a dedicated follow-on unit before formal physical performance/G0 work.
