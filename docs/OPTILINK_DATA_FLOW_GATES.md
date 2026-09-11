# OptiLink Data Flow Gates — 数据流门

**Status:** ACTIVE for the TF-012 r4 **Single-Code Baseline** (单码基线).
**Scope:** the simplified baseline data flow G1–G13 below. The full TF-012 protocol
path (orientation beacon → Preamble → Manifest → Fountain symbols → 3 tiles) is
**deliberately bypassed** by this baseline and is documented separately in
`docs/TF012_PHYSICAL_TEST.md` and `docs/TF009_ARCHITECTURE_INVENTORY.md`.

Terminology / 术语

- **Gate / 门** — a named, observable stage boundary with one PASS condition.
- **Sender / 发送端** — a browser page. A **stateless cyclic broadcaster**: it
  emits chunk 0 → chunk 1 → … → chunk N-1 → chunk 0 → … forever and only stops
  when the PO presses Stop. No ACK, no retransmission request, no receiver
  feedback, no network payload, no knowledge of receiver state.
- **Receiver / 接收端** — a WeChat Mini Program. It may **join at any time**,
  stores only unique chunks, ignores duplicates, and stops ingest **only when ALL
  UNIQUE CHUNKS ARE PRESENT**.
- **Chunk / 分片** — one self-describing unit of the file; one chunk = one OptiGrid.
- **Not in this baseline / 本基线不包含** — Fountain, Manifest frame, Preamble,
  3-tile composition, ACK, Net Goodput, file save.

| Gate | English name | 中文名称 |
| --- | --- | --- |
| G1 | File Source | 文件源 |
| G2 | File Chunking | 文件切片 |
| G3 | Chunk Packaging | 切片封装 |
| G4 | OptiGrid Encoding | OptiGrid 编码 |
| G5 | Single-Code Display | 单码屏幕显示 |
| G6 | CameraFrame Capture | 相机帧采集 |
| G7 | Single-Code Detection & Decode | 单码定位与解码 |
| G7a | Candidate Detection | 候选区域检测 |
| G7b | Code Bounding Box | 码边界定位 |
| G7c | Geometry Lock | 几何锁定 |
| G7d | CRC Decode | CRC 解码 |
| G8 | Chunk Reception | 分片接收 |
| G9 | Deduplication & Validation | 去重与校验 |
| G10 | All Chunks Received | 分片收齐 |
| G11 | File Reconstruction | 文件重构 |
| G12 | SHA-256 Integrity Verification | SHA-256 完整性校验 |
| G13 | Display Result | 结果显示 |

---

## G1 — File Source / 文件源

- **Input / 输入**: a fixed baseline constant (no external file, no user input).
- **Output / 输出**: one deterministic UTF-8 file `baseline-10k.txt`, exactly
  **10240 bytes** (10 KiB, 160 lines × 64 bytes), plus `fileName`, `fileBytes`,
  `sourceSha256`.
- **Observable metrics / 可观测指标**: byte length, SHA-256, line count, ASCII-only
  byte check, `fileId = FNV-1a(source)`.
- **PASS condition / 通过条件**: byte length == 10240 **and** two independent
  generations produce the same digest (determinism).
- **FAIL interpretation / 失败含义**: the source is not reproducible, so no later
  equality claim can mean anything.
- **Evidence / 证据**: `single-baseline.test.ts` test 1.

## G2 — File Chunking / 文件切片

- **Input / 输入**: the 10240-byte source.
- **Output / 输出**: `totalChunks = 16` chunks of `chunkDataBytes = 640` file-data
  bytes each (exact division, no padding, no Fountain symbols, no overlaps).
- **Observable metrics / 可观测指标**: chunk count, per-chunk data length,
  arithmetic identity `sourceBytes = totalChunks × chunkDataBytes`.
- **PASS condition / 通过条件**: `10240 / 640 == 16` exactly, every chunk is 640
  bytes, and 640 ≤ (OptiGrid v1 capacity − metadata).
- **FAIL interpretation / 失败含义**: the chunk size does not match the real
  single-code payload capacity; the transfer cannot fit one chunk per frame.
- **Evidence / 证据**: `single-baseline.test.ts` tests 2 and 3.

## G3 — Chunk Packaging / 切片封装

- **Input / 输入**: file metadata + one 640-byte chunk of file data.
- **Output / 输出**: one packed payload of **706 bytes**:

  | Offset | Bytes | Field | 字段 |
  | --- | --- | --- | --- |
  | 0 | 2 | magic `"SB"` (0x53 0x42) | 魔数 |
  | 2 | 1 | `version` = 1 | 版本 |
  | 3 | 1 | `reconstructionMethodId` = 0 (`CONCAT_BY_INDEX`) | 重构方式 |
  | 4 | 2 | `totalChunks` (u16) | 总切片数 |
  | 6 | 2 | `chunkDataBytes` (u16) | 每片文件数据 |
  | 8 | 4 | `totalFileBytes` (u32) | 文件总字节 |
  | 12 | 4 | `fileId` (u32, FNV-1a of source) | 文件标识 |
  | 16 | 1 | `chunkIndex` (u8) | 切片序号 |
  | 17 | 1 | `fileNameBytes` (u8) | 文件名长度 |
  | 18 | 16 | `fileName` UTF-8 (`baseline-10k.txt`) | 文件名 |
  | 34 | 32 | `fileSha256` (raw) | 文件 SHA-256 |
  | 66 | 640 | file data | 文件数据 |
  | **706** | | **packed payload total** | **载荷合计** |

- **Capacity check / 容量核对**: OptiGrid v1 matrix 96 inner data cells
  `(96−20)² = 5776 bits = 722 bytes`; minus 10-byte header and 4-byte CRC32 =
  **708-byte payload capacity**. 706 ≤ 708 → **capacity slack = 2 bytes**. The
  encoder itself throws above capacity, so a silent overflow is impossible.
- **Observable metrics / 可观测指标**: packed length, metadata roundtrip equality for
  every field, rejection reasons for corrupted payloads.
- **PASS condition / 通过条件**: 706 bytes packed, all 16 chunks round-trip
  field-for-field, and hostile payloads (bad magic, out-of-range index, truncated)
  are rejected with an explicit reason.
- **FAIL interpretation / 失败含义**: a joiner cannot understand the transfer, or
  the frame silently exceeds the real carrier capacity.
- **Evidence / 证据**: `single-baseline.test.ts` tests 3 and 4.

## G4 — OptiGrid Encoding / OptiGrid 编码

- **Input / 输入**: one 706-byte packed payload per chunk.
- **Output / 输出**: one OptiGrid v1 frame, `matrixSize = 96`, `sequence =
  0x5342_0000 | chunkIndex`, normal OptiGrid v1 CRC32 protection (no special
  symbol type, no Fountain equation, no Manifest frame).
- **Observable metrics / 可观测指标**: decode round-trip equality, CRC pass/fail,
  reserved-cell pattern validity.
- **PASS condition / 通过条件**: every frame decodes back to the exact payload and
  the sequence's low 16 bits equal the chunk index.
- **FAIL interpretation / 失败含义**: the carrier layer is broken independently of
  the camera.
- **Evidence / 证据**: `single-baseline.test.ts` (`frameFor()` asserts all 16
  frames round-trip) and the browser spec, which CRC-decodes frames sampled from
  the real sender canvas.

## G5 — Single-Code Display / 单码屏幕显示

- **Input / 输入**: the current chunk index and the cyclic broadcast state machine.
- **Output / 输出**: **exactly ONE** large OptiGrid on a light background (white
  quiet zone of 3 cells), 1:1 module pixels, no scaling blur; a visible status
  panel; **Start / 开始** and **Stop / 停止** buttons.
- **Observable metrics / 可观测指标**: current chunk, cycle count, hold time,
  canvas module size in pixels, status (`Stopped / 已停止` or `Broadcasting / 广播中`).
- **PASS condition / 通过条件**: Start → chunk 0 → 1 → … → 15 → 0 → … while the
  readout advances; Stop → the broadcast freezes and the displayed chunk stops
  changing; Start again → restarts at chunk 0.
- **FAIL interpretation / 失败含义**: the PO cannot control the broadcast, or more
  than one code is on screen (which would break the single-code assumption).
- **Evidence / 证据**: `single-baseline-sender.spec.ts` (items 13–15) in a real
  headless Chromium against the real canvas.

## G6 — CameraFrame Capture / 相机帧采集

- **Input / 输入**: `CameraContext.onCameraFrame` RGBA frames (4 bytes/pixel) from
  the phone's rear camera.
- **Output / 输出**: `PixelFrame {width, height, data}` handed to the shared core
  through a bounded latest-frame slot (one frame processing, one pending,
  replacements counted — no unbounded queue).
- **Observable metrics / 可观测指标**: camera frame width/height, buffer bytes,
  callback FPS, processed FPS, skipped/replaced counts, observed code width/height
  in camera pixels, estimated pixels-per-cell X/Y.
- **PASS condition / 通过条件**: frames arrive continuously, the callback stays
  live, and geometry metrics are reported (not guessed).
- **FAIL interpretation / 失败含义**: camera permission/plumbing problem — no
  optical claim can be made from this session.
- **Evidence / 证据**: `single-baseline-pixels.test.ts` test 9 (metrics) and the
  on-phone panel; `single-baseline-mini.test.ts` test 16/17 (wiring).

## G7 — Single-Code Detection & Decode / 单码定位与解码

G7 is measured as four independently observable sub-stages. A frame that fails is
reported at the exact sub-stage it reached, with its best failed score — a bare
`locate-failed` is no longer an acceptable outcome.

### G7a — Candidate Detection / 候选区域检测

- **Input / 输入**: one camera frame (`PixelFrame`, RGBA).
- **Output / 输出**: global luma statistics and a ranked list of candidate code
  regions (dark connected components + dark structures re-segmented inside the
  dominant bright page/screen region).
- **Observable metrics / 可观测指标**: luma min/max/mean, channel means R/G/B/A,
  binarisation threshold, contrast, local-variation ratio, dark pixel ratio,
  mask geometry, connected-component count, per-candidate bbox / area / fill
  ratio / aspect / span / frame fraction / detector source, largest-component
  box, bright-region box, rejection reason.
- **PASS condition / 通过条件**: at least one candidate region spans ≥
  `SINGLE_BASELINE_MIN_CANDIDATE_SPAN_PX` (96 px) at a frame contrast ≥
  `SINGLE_BASELINE_MIN_REGION_CONTRAST` (24).
- **FAIL interpretation / 失败含义**: `low-contrast:*` → the frame carries almost
  no optical signal (washed out, camera covered, wrong target);
  `no-dark-pixels:*` → nothing dark was seen;
  `no-candidate-region:*` → dark structure exists but no region is large enough,
  i.e. the code is out of frame or far too small.
- **Evidence / 证据**: `single-baseline-g7.test.ts`; physical counters
  `g7FramesAnalysed`, `g7aPassCount`, `regionLumaMin/Max/Mean`,
  `regionContrast`, `regionDarkPixelRatio`, `regionComponentCount`,
  `regionCandidateCount`, `regionRejection`.

### G7b — Code Bounding Box / 码边界定位

- **Input / 输入**: the G7a candidate list.
- **Output / 输出**: a reported verdict on whether the best candidate looks like a
  code (`spanPx ≥ 2 × matrix`, aspect within [0.5, 2.0]) plus its geometry.
- **Observable metrics / 可观测指标**: candidate centre X/Y, width/height, aspect
  ratio, fraction of the camera frame occupied, estimated code side in pixels,
  fill ratio, detector source, and the reason when the verdict is FAIL.
- **PASS condition / 通过条件**: the best candidate is square-ish and ≥2 px/cell
  (`≥192 px` at matrix 96).
- **FAIL interpretation / 失败含义**: a non-square candidate means the code's dark
  modules **merged** with a larger dark region (bezel, room, dark UI) or
  **fragmented**. G7b is **report-only**: it never aborts the frame, because the
  OptiGrid CRC — not a shape heuristic — is the acceptance oracle. A G7b FAIL with
  a later G7d PASS is a valid decode.
- **Evidence / 证据**: `single-baseline-g7.test.ts` (dark room larger than the
  code, dark UI block, merged/fragmented cases); metrics `g7bPass`, `g7bReason`,
  `g7bPassCount`, `regionLargest*`.

### G7c — Geometry Lock / 几何锁定

- **Input / 输入**: candidate bounding boxes.
- **Output / 输出**: refined geometric locks (centre, side, tilt, 90° frame
  rotation, sub-cell phase, binarisation threshold) with a reserved-pattern score.
- **Observable metrics / 可观测指标**: seed count, best seed score/rotation/side,
  refinement count, **best refined score even when it fails**, best refined rotation,
  pixels-per-cell, phase X/Y, refined contrast.
- **PASS condition / 通过条件**: at least one candidate refined (a lock was
  produced). Final acceptance is G7d.
- **FAIL interpretation / 失败含义**: `bestRefinedPixelsPerCell` far above the
  expected code scale with near-zero reserved contrast → the candidate is the
  **wrong region**; a near-miss score (0.6–0.99) with plausible px/cell and high
  contrast → the **right region with wrong geometry** (perspective, or a quad that
  is not projective); `pixelsPerCell < 3` → a **physical limit** (get closer).
- **Evidence / 证据**: `single-baseline-g7.test.ts`; metrics `g7cPass`,
  `g7cReason`, `refinementBest*`, `seedBest*`.

### G7d — CRC Decode / CRC 解码

- **Input / 输入**: a refined geometric lock.
- **Output / 输出**: an OptiGrid v1 frame validated by its own CRC32.
- **Observable metrics / 可观测指标**: CRC attempts, CRC success, CRC failure,
  decoded sequence, decoded chunk index.
- **PASS condition / 通过条件**: a CRC-valid frame. A wrong geometric lock can never
  produce a chunk.
- **FAIL interpretation / 失败含义**: separate from G7a/G7b/G7c by construction —
  `crcFailures` only counts frames that HAD a lock.
- **Evidence / 证据**: `single-baseline-g7.test.ts`, `single-baseline-pixels.test.ts`;
  metrics `g7dPass`, `crcDecodeAttempts`, `crcSuccess`, `crcFailure`,
  `decodedSequence`, `decodedChunkIndex`, `g7dPassCount`.

## G8 — Chunk Reception / 分片接收

- **Input / 输入**: a decoded OptiGrid frame.
- **Output / 输出**: a stored unique chunk, or an explicit counters-only outcome
  (`duplicate`, `invalid`, `foreign`, `ignored-complete`).
- **Observable metrics / 可观测指标**: `activeFileId`, `totalChunks`,
  `receivedChunks[index]`, `receivedUniqueCount`, `duplicateCount`,
  `lastChunkIndex`, time to first valid chunk.
- **PASS condition / 通过条件**: a receiver started mid-cycle eventually holds all
  16 unique chunks, with no requirement to see chunk 0 first and no sender restart.
- **FAIL interpretation / 失败含义**: the sender cannot be joined late, i.e. the
  chunk is not fully self-describing.
- **Evidence / 证据**: `single-baseline.test.ts` tests 5–7 and
  `single-baseline-pixels.test.ts` tests 5–6 (joins at chunk 11 and at chunk 3 with
  duplicates, both complete).

## G9 — Deduplication & Validation / 去重与校验

- **Input / 输入**: a decoded chunk payload + the active transfer state.
- **Output / 输出**: either `stored`, or `duplicate` / `invalid` / `foreign`, each
  individually counted.
- **Observable metrics / 可观测指标**: duplicates, metadata rejects, foreign-file
  rejects (per rejection reason), per-chunk validation failures.
- **PASS condition / 通过条件**: per chunk — decode OK, CRC valid, metadata valid
  (magic/version/reconstruction method), index in range, `totalChunks`,
  `chunkDataBytes`, `fileId`, `fileSha256` and `reconstructionMethod` all
  consistent with the active transfer. If another `fileId` appears while a file is
  active, the baseline **ignores it and counts it** (no session switch).
- **FAIL interpretation / 失败含义**: corrupted metadata would be accepted, or the
  receiver would silently restart on a foreign transfer.
- **Evidence / 证据**: `single-baseline.test.ts` tests 6, 13, 14.

## G10 — All Chunks Received / 分片收齐

- **Input / 输入**: the set of stored unique chunks.
- **Output / 输出**: the completion decision, and only then the stop of ingest.
- **Observable metrics / 可观测指标**: `receivedUniqueCount` vs `totalChunks`,
  missing index list, time to all chunks, post-complete frames ignored.
- **PASS condition / 通过条件**: `receivedUniqueCount === totalChunks`.
  **The completion condition is NOT `chunkIndex == last index`** — the last missing
  chunk may be any index.
- **FAIL interpretation / 失败含义**: reconstruction is attempted without every
  chunk (silent corruption), or the receiver never declares completion and spins.
- **Evidence / 证据**: `single-baseline.test.ts` tests 8 and 9 (last missing index
  0 / 5 / 11 / 15), test 14 (ingest stops afterwards).

## G11 — File Reconstruction / 文件重构

- **Input / 输入**: all unique chunks.
- **Output / 输出**: 10240 reconstructed bytes via `CONCAT_BY_INDEX` — sort by
  `chunkIndex`, concatenate the 640-byte file payloads, truncate to
  `totalFileBytes`. No Fountain, no repair equations, no checkpoint.
- **Observable metrics / 可观测指标**: reconstructed length, reconstruction time,
  reconstruction method actually used.
- **PASS condition / 通过条件**: exactly 10240 bytes, byte-identical to the source.
- **FAIL interpretation / 失败含义**: ordering/padding/truncation bug in the
  reconstruction path.
- **Evidence / 证据**: `single-baseline.test.ts` tests 7, 10 and
  `single-baseline-pixels.test.ts` test 5.

## G12 — SHA-256 Integrity Verification / SHA-256 完整性校验

- **Input / 输入**: the reconstructed bytes + the `fileSha256` carried in the chunk
  metadata.
- **Output / 输出**: `reconstructedSha256`, comparison result, `MATCH` / `MISMATCH`.
- **Observable metrics / 可观测指标**: both digests, SHA time, PASS/FAIL.
- **PASS condition / 通过条件**: `sourceSha256 == reconstructedSha256` (the metadata
  digest is the sender's own source digest, so the comparison is exact).
- **FAIL interpretation / 失败含义**: MISMATCH means at least one chunk was wrong
  while still passing CRC, or the reconstruction ordering was wrong. It is never
  reported as a pass.
- **Evidence / 证据**: `single-baseline.test.ts` test 11 (including a deliberately
  tampered chunk that must produce MISMATCH).

## G13 — Display Result / 结果显示

- **Input / 输入**: the verified reconstruction.
- **Output / 输出**: the result panel — `TRANSFER COMPLETE / 传输完成`, file name,
  file size, `chunks 16 / 16`, duplicates, reconstruction method
  `CONCAT_BY_INDEX / 按编号拼接`, `SHA-256 MATCH`, and a direct content preview of
  the reconstructed UTF-8 text (first section + last section + total decoded byte
  count when the full 10 KiB is too heavy for one view). **No file save is required
  in this baseline**; the full reconstructed bytes stay in memory for SHA
  verification.
- **Observable metrics / 可观测指标**: preview line count, decoded byte count, SHA
  status, frozen-result JSON.
- **PASS condition / 通过条件**: the displayed preview matches the reconstructed
  bytes and the SHA line reads `MATCH`.
- **FAIL interpretation / 失败含义**: the bytes are correct but the human-visible
  proof is wrong or missing.
- **Evidence / 证据**: `single-baseline.test.ts` test 12,
  `single-baseline-mini.test.ts` test 16 (panel fields), and the frozen-result JSON
  builder `buildBaselineResultPayload()`.

---

## Cross-cutting gates / 横向门

- **Speed / 速度**: not optimised. The initial broadcast hold is a deliberately slow
  1000 ms per chunk (`?holdMs=` overridable); one full cycle takes ~16 s. Reliability
  beats throughput in this baseline.
- **One-way only / 仅单向**: no ACK, no retransmission request, no receiver
  feedback, no network payload. The sender never learns anything about the receiver.
- **Evidence class / 证据等级**: on phone success this is
  `PHYSICAL SINGLE-CODE FILE TRANSFER BASELINE` — **not** Net Goodput, **not** G0.

---

## Current physical status / 当前物理状态

**Kept as-is, not deleted / 保留，不删除**

| Evidence | Status | Note |
| --- | --- | --- |
| CameraFrame capture (Mini Program) | **PASS** | real continuous camera pixels reached JS |
| Orientation acquisition (3 tiles + macro markers) | **PASS** | fiducial-seeded lock succeeded |
| 3/3 exact tile decode | **PASS** | all three tiles decoded exactly |
| Preamble stage (96) | **FAIL** | cold-join robustness work in TF-012 r3 did not make it reliable |

**Single-Code Baseline — r4 real-phone run (Motorola XT2321-2, Android 16, WeChat 8.0.72, 720×1280 RGBA)**

| Gate | r4 physical result | Measured |
| --- | --- | --- |
| G6 CameraFrame Capture / 相机帧采集 | **PHYSICAL PASS** | 5272 frames, 69.97 FPS callback and processing, 14.178 ms avg / 38 ms p95 per frame |
| G7a Candidate Detection / 候选区域检测 | **PHYSICAL FAIL** | 5272 / 5272 frames stopped here (`locateFailures = 5272`) |
| G7b Code Bounding Box / 码边界定位 | **NOT REACHED** | r4 had no G7b sub-stage and no metrics |
| G7c Geometry Lock / 几何锁定 | **NOT REACHED** | `reservedPatternScore = 0`, `observedCodeWidthPx = 0` |
| G7d CRC Decode / CRC 解码 | **NOT REACHED** | `crcFailures = 0` — no lock was ever produced, so this is **not** a CRC failure |
| G8–G13 | **NOT REACHED** | no chunk was ever received; no reconstruction, SHA or display claim |

**Why r4 failed, exactly.** The r4 locator returned a single `locate-failed` for
every frame. Two distinct hard stops produced that, both only visible now that
G7a–G7d are instrumented:

1. `locateDarkRegionBounds` aborted the whole frame when the frame luma span was
   below 60 (`low-contrast`) — a washed-out screen (auto-exposure on a bright
   display) or a camera that is not actually looking at the code reads as a
   uniform field, and every such frame became an unexplainable `locate-failed`.
2. When the largest connected dark region was **not** the code — which is the
   normal case for a phone pointed at a monitor, because the dark room, bezel or
   desk around the bright screen is far larger than the code's black modules — the
   geometric seeds were derived from that wrong region and every seed was rejected
   (`contrast ≤ 0` against the reserved pattern), producing zero refinement
   attempts and therefore zero CRC attempts.

Both are reproduced by monitor-capture fixtures in
`src/optical-core/single-baseline-g7.test.ts` and both are addressed in r5.

**Single-Code Baseline — r5 (software)**

| Gate | Status | Note |
| --- | --- | --- |
| G1–G4 (software) | **PASS** | 706-byte payload, 708-byte capacity, 16 chunks, SHA exact |
| G5 (sender) | **PASS** | browser acceptance: cyclic Start/Stop/cycle + static diagnostic hold; every canvas is a CRC-valid OptiGrid |
| G6 (software) | **PASS** | frame plumbing, bounded pipeline, geometry metrics |
| G7a (software) | **PASS** | candidate detection survives washout, dark room/bezel/UI larger than the code, cast, gradient, blur, moiré, noise |
| G7b (software) | **PASS** | report-only verdict, never aborts the frame |
| G7c (software) | **PASS** | cell-unit refinement from ranked candidates; failed attempts keep their best score |
| G7d (software) | **PASS** | CRC decode of chunk 0 under all fixtures in the "must decode" set |
| G6–G13 (real phone) | **NOT YET TESTED** | next PO run is the **static chunk-0 G7 bring-up**, see `docs/TF012_SINGLE_CODE_BASELINE.md` |

**Known r5 limits, measured (not hidden)**

| Condition | Result | Signature |
| --- | --- | --- |
| ≥50 % brightness ramp across the frame **plus** moiré | not decoded | `bestRefinedPixelsPerCell > 8` and `bestRefinedContrast < 20` → wrong region (global threshold limit) |
| Strong depth perspective (synthetic 0.12 trapezoid) | not decoded | `bestRefinedScore ≈ 0.77`, plausible px/cell, high contrast → right region, insufficient geometry model |
| Code smaller than ~30 % of the frame | not decoded | `bestRefinedPixelsPerCell < 3` → physical limit, get closer |

The proposed replacement for the first case is a gray-frame/checkerboard-border
detector (G7a-2) that derives the code boundary from the alternating border cells
instead of a global threshold. It is **not** implemented yet: the r5 physical
diagnostics must first show whether the real scene is in that class.
