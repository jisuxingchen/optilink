# TF-012 r6 — Single-Code Baseline / 单码基线 (speed ladder 速度阶梯)

**Status:** READY for PO physical action (after exact-head CI green + Technical
Review PASS).
**Build:** `tf012-r6-<shortsha>` (pinned by the buildId commit) · branch
`spike/tf-012-physical-performance` · Issue #53 · PR #54.
(The follow-up commit that pins this buildId string changes nothing else in the
baseline; `utils/optical-core.js` is rebuilt from the same source.)
**r4 physical evidence (kept):** G6 CameraFrame = **PHYSICAL PASS**;
G7 = **PHYSICAL FAIL** with `locateFailures = 5272 / 5272` and `crcFailures = 0`;
G7b–G13 = NOT REACHED. See `docs/OPTILINK_DATA_FLOW_GATES.md` → Current physical
status for the exact failure mechanism and the r5 fixes.
**r5/r6 software:** G7a–G7d PASS on monitor-capture fixtures; a real-phone run
later proved `642 / 642` decodes with `0` locate failures, `0` CRC failures and
`~4.09` camera pixels/cell, i.e. the 16/16 + SHA-256 MATCH baseline works.
**r6 scope:** characterise the stable speed limit of the CURRENT architecture.
The protocol is **untouched**; the only variable is the chunk hold time.

## What this is / 这是什么

The **primary physical bring-up path** for OptiLink. A deliberately simple, slow,
one-code-at-a-time optical file transfer:

```
PC screen → ONE OptiGrid at a time → real WeChat Mini Program CameraFrame
→ collect chunks from ANY start time → receive ALL unique chunks
→ reconstruct → SHA-256 exact → display reconstructed content
```

Sender is a **stateless cyclic broadcaster** (无状态循环广播): chunk 0 → … → chunk
15 → chunk 0 → … forever, until the PO presses Stop. Receiver may join at **any**
point in the cycle. No ACK, no retransmission request, no receiver feedback, no
network payload.

From r6 onward the hold time is swept as a **measurement ladder** — the goal is to
characterise the stable speed limit of this architecture, not to raise it. **This
baseline deliberately bypasses** the full TF-012 protocol: no cold-join beacon
state, no Preamble, no Manifest, no Fountain, no 3-tile composition. See
`docs/OPTILINK_DATA_FLOW_GATES.md` for the gate model.

## Frozen baseline layout / 冻结的基线布局

| Item | Value |
| --- | --- |
| Source file | `baseline-10k.txt` |
| File size | **10240 bytes** (10 KiB, 160 lines × 64 bytes, deterministic ASCII) |
| Matrix | **96 × 96** OptiGrid v1 |
| OptiGrid v1 payload capacity | **708 bytes** (722 − 10 header − 4 CRC) |
| File data per chunk | **640 bytes** |
| Metadata per chunk | **66 bytes** (16-byte file name) |
| **Packed payload per chunk** | **706 bytes** → capacity slack **2 bytes** |
| Total chunks | **16** |
| Reconstruction | `CONCAT_BY_INDEX` / 按编号拼接 |
| Per-frame protection | OptiGrid v1 CRC32 |
| Broadcast hold | **speed ladder** `?holdMs=` = 1500 / 1000 / 750 / 500 / 333 / 250 / 200 / 150 / 100 / 75 / 50 / 33 ms (default 1000 ms) |

Chunk byte layout (see G3 in the gates document for the full table): magic `"SB"`,
version, reconstructionMethodId, totalChunks, chunkDataBytes, totalFileBytes,
fileId, chunkIndex, fileNameBytes, fileName, fileSha256 (32 raw bytes), then 640
bytes of file data.

## PO test steps / PO 测试步骤

### NEXT TEST (r6) — Stage A coarse speed ladder / 阶梯测试一：粗测

**Precondition (already met in software):** the 16/16 + SHA-256 MATCH baseline was
proven on a real phone with `0` locate failures and `0` CRC failures. Do **not**
re-run the static chunk-0 G7 bring-up, and do **not** optimise anything yet.

**Purpose:** find the transition region — the last stable PASS hold time and the
first FAIL hold time. **Characterise first, optimise later.**

**Test only these six Stage A values, in this order:**

```
1500 → 750 → 333 → 150 → 75 → 33 ms
```

Do **not** run all 12 ladder values up front. Stage B (125 / 100 / 90 / 80 …) only
comes after the transition region is known.

**For each of the six values:**

1. **Sender** (one terminal, started once and left running):
   ```
   cd experiments/tf-002-single-code
   npm run dev:single-baseline-sender
   ```
2. **Sender URL** — change only `holdMs`, keep the page full-screen (F11):
   ```
   http://<PC-LAN-IP>:5319/single-baseline.html?holdMs=1500
   ```
   The panel must show `Hold time / 每码停留 = 1500 ms` plus the declared rates
   (`theoretical chunk rate`, `theoretical file-payload rate`). Those two are
   **declared arithmetic**, not measurements and not goodput.
3. Click **Start / 开始** → `Broadcasting / 广播中`. Chunks advance 0→15→0.
4. **Phone**: mode **Single-Code Baseline / 单码基线** → **Start Camera** → aim so
   the whole code plus its white border is in frame, roughly square, filling a good
   part of the frame. Aim **first**, then let it run: the receiver can join at any
   time.
5. **Before the run, declare the hold time on the phone**: in the new
   `speed ladder · 速度阶梯` panel, set `set to sender ?holdMs=` (type the value, or
   use the `ladder preset` picker) so it matches the URL. The frozen JSON records
   it as `benchmark.holdMs` (`holdMsSource = declared`). If it does not match the
   URL, the theoretical rates in the JSON are wrong even though the transfer is not.
6. Wait for `16 / 16`, `COMPLETE / 完成`, `SHA-256 MATCH`.
7. `Freeze Test Result` → `Copy Result` and record the run.
8. **Then change only `holdMs`** and repeat.

**PASS for a speed point (real phone only, no software PASS):**
`uniqueReceived = 16`, `missing = []`, `reconstructedBytes = 10240`,
`shaResult = MATCH`.

**Per value, record:** PASS / FAIL · `physical.timeToAllChunksMs` · `shaResult` ·
`physical.crcFailures` · `physical.locateFailures` ·
`exploratoryNetGoodputBytesPerSecond` (or `null`) · the deepest G7 sub-stage
reached (`locator.deepestStage`) and, if it failed, which counter grew first.

**If a speed point fails, do not guess — read the JSON.** The deepest
`locator.deepestStage` plus the counter that grew names the first degraded gate
(G6 → G7a → G7b → G7c → G7d → G8 → G9 → G10 → G11 → G12 → G13). A dropping
`physical.pixelsPerCellX/Y`, rising `locateFailures` or rising `crcFailures` each
point at a different gate. No locator change is made for speed until a real
speed-specific blocker is proven this way.

**Send back per value:** the full JSON, one screenshot of the phone panel (the
`speed ladder` panel and the `TRANSFER COMPLETE` preview), one screenshot of the
sender page, and radios ON/OFF.

After the six Stage A values are in, Stage B refines around the transition, and
the candidate fastest PASS is repeated **3 times** (3/3 exact SHA MATCH required
before calling it stable).

### REFERENCE — 16-chunk cyclic transfer / 16 片循环传输 (already PASSED)

This is the baseline procedure the r6 ladder varies. It is kept for reference and
for re-verification at 1500 ms.

### 1. One sender command

```
cd experiments/tf-002-single-code
npm run dev:single-baseline-sender
```

### 2. Exact sender URL

Open in a browser, full-screen it (F11), and let the whole white area be visible:

```
http://<PC-LAN-IP>:5319/single-baseline.html?holdMs=1500
```

Use `http://127.0.0.1:5319/single-baseline.html?holdMs=1500` if the Mini Program
preview runs on the same machine. `holdMs` only changes the hold time; it does not
change the protocol.

### 3. Start button

Click **Start / 开始**. The panel must switch to `Broadcasting / 广播中` and the
`Current chunk / 当前切片` field must advance `0 → 1 → … → 15 → 0 …`, with
`Cycle count / 循环次数` incrementing once per full cycle. The sender shows **one**
large OptiGrid only — never three codes.

You may press **Stop / 停止** at any time to freeze the broadcast. Pressing
**Start / 开始** again restarts from chunk 0.

### 4. Mini Program baseline mode

In WeChat DevTools open `experiments/tf-008-wechat-mini-receiver-poc`, compile,
and preview on the phone. Then:

1. Tap **Single-Code Baseline 单码基线** (the mode button).
2. Tap **Start Camera**.
3. Point the rear camera at the single code so that the **whole code plus its white
   border** is inside the frame. Hold the phone roughly square to the screen.
4. Wait — one full cycle is ~16 chunks; at 1500 ms per chunk a cycle takes ~24 s.

### 5. Expected on the phone

```
Received chunks / 已接收分片   X / 16   →   16 / 16
Missing chunks / 缺失分片      [...]     →   none
Status / 状态                  RECEIVING / 接收中  →  COMPLETE / 完成
Reconstruction / 重构方式      CONCAT_BY_INDEX
SHA-256                        MATCH
```

Then the result panel shows `TRANSFER COMPLETE / 传输完成` with the reconstructed
content preview (first section + last section + total decoded byte count). No file
save is required in this baseline.

The receiver may be started at any moment — including after the sender has already
been broadcasting for a while. It does **not** need sender restart, and it does
**not** need chunk 0 first.

### 6. What to send back

1. The frozen JSON: tap **Freeze Test Result** then **Copy Result**, and paste the
   JSON into the PO channel. It contains buildId, transfer identity, per-stage
   counters, camera/decode metrics, the SHA result and the preview.
2. A screenshot showing the phone screen with the buildId, `16 / 16` and
   `SHA-256 MATCH`.
3. Whether the phone radios were ON or OFF (airplane mode). With radios ON the
   optical result is still valid evidence, but it is not formal offline evidence.
4. Anything the phone reported in `errors`.

## r6 timing metric correction / r6 时间指标修正

The r4/r5 frozen JSON reported `avgFrameProcessMs = 0.007` and
`p95FrameProcessMs = 0.000`, which cannot be the cost of decoding a 96×96 OptiGrid.
Root cause: every processed frame was timed, including frames that arrive **after**
completion. Such a frame returns from `ingestFrame` before touching a pixel, and the
adapter's frame wrapper is a **zero-copy** `new Uint8ClampedArray(arrayBuffer)` view,
so it costs ~0 ms. Because the sample ring keeps only the newest 600 entries, the
long post-completion tail evicted every real decode sample from the average.

r6 fix: a frame is classified **before** the ingest call from the receiver stage.
Pre-completion frames enter the active aggregate
(`timing.activeProcessAvgMs / P50 / P95 / Max`, `timing.activeProcessSamples`);
post-completion frames are excluded and counted in `timing.postCompleteFrames`. The
frame that completes the transfer is still counted as active. Timings use a
monotonic sub-millisecond clock when available (`timing.clockSource`), so a fast
decode is not quantised to 0 ms. A second defect was fixed at the same time: the
baseline `callbackFps` divided the **global** frame counter by a baseline-only
window; it now uses the baseline counter.

## Speed ladder metrics in the frozen JSON / 速度阶梯指标

The frozen result now contains three separated blocks:

- `benchmark` — **declared** arithmetic: `holdMs` (must equal the sender URL),
  `theoreticalChunksPerSecond`, `theoreticalPayloadBytesPerSecond`,
  `theoreticalPayloadKiBPerSecond`. Never a measurement, never goodput.
- `physical` — **measured**: `timeToFirstValidChunkMs`, `timeToAllChunksMs`,
  `cameraFrames`, `decodeAttempts`, `successfulDecodes`, `locateFailures`,
  `crcFailures`, `metadataRejects`, `foreignChunkRejects`, `duplicates`,
  `uniqueReceived`, `callbackFps`, `processingFps`, `observedCodeWidthPx`,
  `observedCodeHeightPx`, `pixelsPerCellX`, `pixelsPerCellY` (plus the G7a–G7d
  `locator` block and the corrected `timing` block).
- `completion` — `reconstructedBytes`, `shaResult`, `missing`, `pass`.

`exploratoryNetGoodputBytesPerSecond` / `exploratoryNetGoodputKiBPerSecond` are
`null` unless `shaResult == MATCH` **and** `uniqueReceived == 16`; when they exist
they are `reconstructedBytes / (timeToAllChunksMs / 1000)`. This is a 10 KiB
exploratory physical benchmark. It is **not G0**, and CameraFrame RGBA bandwidth is
never reported as optical throughput.

## Acceptance / 验收

PASS only if a **real phone** proves:

10 KiB source → one-code cyclic optical broadcast → receiver joins at an arbitrary
time → receives all 16 unique chunks → reconstructs 10240 bytes → SHA-256 exact →
reconstructed text displayed.

Not part of this baseline: file save, 3-code requirement, Fountain requirement,
Preamble requirement, Manifest requirement, calibration to a target speed.

**An exploratory Net Goodput number is produced** when (and only when) a real run
completes with 16/16 unique chunks and SHA-256 MATCH. It is recorded as evidence of
the CURRENT architecture, never as a design goal or a guarantee.

## Software evidence before the PO test / 送测前的软件证据

Run from `experiments/tf-002-single-code`:

| Command | Covers |
| --- | --- |
| `node --test src/optical-core/single-baseline.test.ts` | G1–G4, G8–G13 protocol + receiver logic (16 tests) |
| `node --test src/optical-core/single-baseline-pixels.test.ts` | G6–G13 rendered-pixel end-to-end, all 4 frame rotations, tilt, blur + sensor noise (12 tests) |
| `node --test src/optical-core/single-baseline-g7.test.ts` | G7a–G7d against monitor-capture fixtures: washout, dark room/bezel/UI larger than the code, cast, illumination gradient, blur, moiré, noise, perspective, small code (10 tests) |
| `node --test src/optical-core/single-baseline-speed-ladder.test.ts` | r6 speed ladder: the 12 hold values, URL clamping (no 100 ms floor), declared-rate arithmetic, the net-goodput guard matrix, and the proof that post-completion frames never enter the active latency set (10 tests) |
| `node --test src/optical-core/single-baseline-mini.test.ts` | Mini Program boot/baseline-mode smoke, G7 UI wiring, r6 speed-ladder UI + frozen-JSON fields, network scan, oracle scan (4 tests) |
| `npm run test:single-baseline-sender` | G5 sender Start/Stop/cycle **and** static diagnostic hold in a real browser; every canvas CRC-decoded |
| `npm test` | the full existing regression suite |

## Physical capability metrics to record / 需记录的物理能力指标

camera frame width/height · observed code width/height in camera pixels · matrix
size · estimated pixels-per-cell X/Y · decode attempts · successful decodes · CRC
failures · duplicate chunks · unique chunks · time to first valid chunk · time to
all chunks · total reconstruction time · SHA result · active pre-completion
processing latency (avg / p50 / p95 / max) · post-completion ignored frames.

**Net Goodput is never declared by default.** It appears only as
`exploratoryNetGoodput*` on a complete, SHA-256-exact real phone run, inside the
`PHYSICAL SINGLE-CODE FILE TRANSFER BASELINE · SPEED LADDER` evidence class — never
as G0 and never as optical throughput.
