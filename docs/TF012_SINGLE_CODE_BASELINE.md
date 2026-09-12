# TF-012 r7 — Single-Code Baseline / 单码基线 (Stage B operating window 工作区间)

**Status:** READY for PO physical action (after exact-head CI green + Technical
Review PASS).
**Build:** `tf012-r7-545583a` · build content commit `545583a` · branch
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
**r6 Stage A (real phone, build `tf012-r6-a0e180b`):** the speed ladder was swept
and came back **NON-MONOTONIC** — 1500 PASS, **750 anomalous FAIL**, 333 PASS,
150 PASS, **75 PASS best**, 33 PASS-with-collapse. The results are recorded exactly
below; 750 ms is an **outlier candidate**, not a speed boundary.
**r7 scope:** change Stage B from "find the minimum `holdMs` that still PASSes" to
**"find the best stable operating window"** — maximise real completion efficiency
and reliability, not minimise hold time. The protocol is **untouched**; the only
variable is the chunk hold time.

**r10 scope:** the PO reported that after the r9 UI changes **no** tested speed
decoded. The "r9 shrank the code" hypothesis was **measured and DISPROVEN** (the
carrier geometry is identical r8 vs r9); the real regression was **overlay
occlusion** — the r9 control panel grew ~170 px and covered up to 21.19 % of the
canvas. The layout was fixed so the overlays cover **0 %** of the carrier while
broadcasting, and the invariant is now enforced by test. **No protocol, matrix,
chunk, encoding, locator or CRC change.** Stage B is **paused** until the static
chunk-0 point is reproduced.

**r11 scope:** the PO's screenshot showed the bottom-right explanatory text covering
the OptiGrid. r11 **removes every overlay from the sender page** — the help text and
the control panel are normal flow content in a left sidebar, and the status strip
sits in a band the carrier reserves below itself. Nothing on the page is
`position:fixed` over the canvas any more, so the carrier overlap is **0 at every
viewport in every state**, and a generic regression test (every visible non-carrier
element must not intersect the carrier) enforces it. **No protocol, matrix, chunk,
encoding, locator or CRC change.** Stage B stays paused until the static chunk-0
point is reproduced.

**r12 scope:** the physical report that the static path decodes while the cyclic path
does not (0/209 at 1000 ms, ≈14.25 camera frames per code) was investigated as a
**sender-path equivalence** question. Measurement shows the diagnostic and cyclic
senders render **byte-identical** chunk-0 frames (same SHA-256 over the full RGBA
carrier, same 1020 px geometry, same payload/sequence/CRC, 0 % pixel diff) and that
starting the cycle never resizes or moves the carrier. **No sender discrepancy exists**
— the remaining difference is capture-side, and both r11 runs were already below the
documented `≥ 4 px/cell` limit. See the r12 section. Stage B stays paused.

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

From r6 onward the hold time is swept as a **measurement ladder**; from r7 the
goal is explicitly to **find the best stable operating window** of this
architecture, not to raise the speed. **This baseline deliberately bypasses** the
full TF-012 protocol: no cold-join beacon
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
| Broadcast hold | **Stage A** `?holdMs=` = 1500 / 1000 / 750 / 500 / 333 / 250 / 200 / 150 / 100 / 75 / 50 / 33 ms · **Stage B** = 100 / 90 / 75 / 60 / 50 / 40 ms (default 1000 ms) |

Chunk byte layout (see G3 in the gates document for the full table): magic `"SB"`,
version, reconstructionMethodId, totalChunks, chunkDataBytes, totalFileBytes,
fileId, chunkIndex, fileNameBytes, fileName, fileSha256 (32 raw bytes), then 640
bytes of file data.

## PO test steps / PO 测试步骤

### STAGE A RESULT (r6, REAL PHYSICAL EVIDENCE) — recorded as measured / 实测记录

Build `tf012-r6-a0e180b` · real **Motorola XT2321-2**, Android 16, WeChat 8.0.72,
CameraFrame ≈30 FPS. **Nothing is smoothed or "corrected".**

| holdMs | PASS/FAIL | camera FPS | frames/code (theoretical) | successful decode ratio | CRC failures | locate failures | timeToFirstValidChunk | timeToAllChunks | exploratory Net Goodput | pixels/cell | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1500 | **PASS** | ≈30 | 45.0 | 1674/1970 = 0.850 | 295 | 1 | not reported | **65637 ms** | **≈156 B/s** | ≈3.7–4.0 | slow but healthy |
| 750 | **FAIL — ANOMALOUS / OUTLIER CANDIDATE** | ≈30 | 22.5 | **0/586 = 0.000** | **583** | 3 | n/a | never completed | n/a | **≈3.733** | `frameRotationIndex = 2`, `reservedPatternScore ≈ 0.8017`, `activeProcessAvgMs ≈ 158`, `processing FPS ≈ 6.29` |
| 333 | **PASS** | ≈30 | 10.0 | 607/701 = 0.866 | 94 | 0 | not reported | **23597 ms** | **≈434 B/s** | ≈3.7–4.0 | healthy |
| 150 | **PASS** | ≈30 | 4.5 | 806/1033 = 0.780 | 223 | 4 | not reported | **34463 ms** | **≈297 B/s** | ≈3.7–4.0 | slower than 333 ms despite faster sender |
| 75 | **PASS — best measured point** | ≈30 | 2.25 | 356/398 = 0.895 | 42 | 0 | not reported | **13255 ms** | **≈773 B/s** | ≈3.7–4.0 | best decode ratio, fewest CRC, fastest completion |
| 33 | **PASS but PERFORMANCE COLLAPSE** | ≈30 | 1.0 | 2226/3281 = 0.679 | **1048** | 7 | not reported | **166505 ms** | **≈61.5 B/s** | ≈3.7–4.0 | "functionally viable but operationally inefficient" |

**The data is NON-MONOTONIC**, so Stage B must not use a "first FAIL below the last
PASS" search. **750 ms is an outlier candidate, not a speed-boundary failure** (all
586 attempts failed at the CRC and the geometry readings are off-neighbourhood).
**33 ms is a PASS, not a FAIL** — all 16 chunks arrived and SHA matched, but the
CRC failure count, completion time and Net Goodput collapsed. The camera/display
phase-interaction hypothesis for 33 ms is **explicitly unproven**.

**Observed code size varied across these runs (~358 / 383 / 400 / 402 / 440 px), so
`holdMs` was NOT the only changing variable.** Stage B therefore requires a fixed
physical setup.

### NEXT TEST (r7) — Stage B operating window / 阶梯测试二：工作区间

**Objective:** find the **best stable operating window** for the current
single-code architecture. Pass is not enough — a point must also complete quickly,
with a good Net Goodput and few CRC failures.

**Fixed physical setup (required — this is what makes holdMs the only variable):**

- same phone, same monitor
- same sender window size, same browser zoom, same F11 / full-screen state
- same phone orientation, same distance, same angle
- **same on-screen code size** — check `observedCodeWidthPx` stays in a narrow band
  run to run (Stage A drifted ~358–440 px)
- **phone stand / stable support strongly recommended**; minimise hand-held
  geometry change between runs

This does not require lab metrology — only that geometry stops changing.

**Run these six values, in this order:**

```
100 → 90 → 75 → 60 → 50 → 40 ms
```

(75 ms is re-tested as the Stage A reference point. **125 ms and 80 ms are
deliberately not included** unless Stage B results later justify them. **Do not
re-run 33 ms yet.**)

**Per value:**

1. **Sender** (one terminal, started once and left running):
   ```
   cd experiments/tf-002-single-code
   npm run dev:single-baseline-sender
   ```
2. **Sender URL** — change only `holdMs`, keep the page full-screen (F11):
   ```
   http://<PC-LAN-IP>:5319/single-baseline.html?holdMs=100
   ```
   The panel must show `Hold time / 每码停留 = 100 ms`, the declared rates
   (`theoretical chunk rate`, `theoretical file-payload rate` — **declared
   arithmetic, not measurements, not goodput**) and the `Stage B set / 阶段B取值`
   row `100 / 90 / 75 / 60 / 50 / 40 ms`.
3. Click **Start / 开始** → `Broadcasting / 广播中`. Chunks advance 0→15→0.
4. **Phone**: mode **Single-Code Baseline / 单码基线** → **Start Camera** → aim so
   the whole code plus its white border is in frame, roughly square, filling a good
   part of the frame. Aim **first**, then let it run: the receiver can join at any
   time.
5. **Declare the same hold time on the phone** in the `speed ladder · 速度阶梯`
   panel (`set to sender ?holdMs=`, or the `ladder preset` picker) so it matches the
   URL. It is recorded as `benchmark.holdMs` with `holdMsSource = declared`; if it
   does not match the URL, the theoretical rates and
   `efficiency.theoreticalCameraFramesPerCode` in the JSON are wrong even though the
   transfer is not.
6. Wait for `16 / 16`, `COMPLETE / 完成`, `SHA-256 MATCH`. If a run does not
   complete, stop it after a sensible wait and record the FAIL — do not leave it
   running for many minutes.
7. `Freeze Test Result` → `Copy Result` and record the run.
8. **Then change only `holdMs`** and repeat.

**PASS for a speed point (real phone only, no software PASS):**
`uniqueReceived = 16`, `missing = []`, `reconstructedBytes = 10240`,
`shaResult = MATCH`.

**Record per value:** PASS/FAIL · `physical.timeToAllChunksMs` ·
`exploratoryNetGoodputBytesPerSecond` (or `null`) ·
`efficiency.decodeSuccessRatio` · `efficiency.crcFailureRatio` ·
`efficiency.locateFailureRatio` · `efficiency.newUniqueChunkYield` ·
`efficiency.theoreticalCameraFramesPerCode` · `physical.observedCodeWidthPx` ·
`physical.pixelsPerCellX/Y` · `shaResult`.

**Ranking of PASSing points** (PASS alone is insufficient): 1) lower
`timeToAllChunksMs`, 2) higher exploratory Net Goodput, 3) lower CRC failure ratio,
4) lower locate failure ratio, 5) higher `newUniqueChunkYield`, 6) consistency
across repeats. **Never rank solely by smallest `holdMs`.**

**If a speed point fails, do not guess — read the JSON.** The deepest
`locator.deepestStage` plus the counter that grew names the first degraded gate
(G6 → G7a → G7b → G7c → G7d → G8 → G9 → G10 → G11 → G12 → G13). A dropping
`physical.pixelsPerCellX/Y`, rising `locateFailures` or rising `crcFailures` each
point at a different gate. No locator change is made for speed until a real
speed-specific blocker is proven this way.

**Send back per value:** the full JSON, one screenshot of the phone panel (the
`speed ladder` panel and the `TRANSFER COMPLETE` preview), one screenshot of the
sender page, and radios ON/OFF.

**After the six values — the 750 ms outlier check.** Run `holdMs=750` **once**,
under the **same fixed setup**, purely to determine whether the original 750 ms run
was an outlier. If it PASSes normally, the original run is a setup/lock outlier; if
it FAILs again, the interaction between that hold time and acquisition/tracking is
investigated. **No code is changed before this repeat.**

**Then stability.** Identify the best-performing region from the six Stage B runs,
repeat the candidate best point **3 times** (stable operating candidate = 3/3 with
16/16, SHA MATCH and no catastrophic completion-time outlier), then repeat the
adjacent faster point 3 times. Record completion time and exploratory Net Goodput
as **min / median / max**, plus CRC failure ratio and `newUniqueChunkYield`. A single
run never establishes a "stable limit".

**Not yet:** do not run 33 ms again, and do not optimise anything — no Worker, no
locator rewrite, no matrix or chunk-size change, no 3-code mode, no Fountain.

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
- `efficiency` (r7, **diagnostic only**) — `theoreticalCameraFramesPerCode`
  (`callbackFps × holdMs / 1000`), `decodeSuccessRatio`, `crcFailureRatio`,
  `locateFailureRatio`, `newUniqueChunkYield`, `duplicateRatio`.

`exploratoryNetGoodputBytesPerSecond` / `exploratoryNetGoodputKiBPerSecond` are
`null` unless `shaResult == MATCH` **and** `uniqueReceived == 16`; when they exist
they are `reconstructedBytes / (timeToAllChunksMs / 1000)`. This is a 10 KiB
exploratory physical benchmark. It is **not G0**, and CameraFrame RGBA bandwidth is
never reported as optical throughput.

## r7 efficiency metrics / r7 效率指标

The six `efficiency` values exist because Stage A showed that **per-frame decoder
correctness and whole-file collection efficiency are different things**: at 75 ms
the phone decoded 356 frames successfully to collect 16 unique chunks
(`newUniqueChunkYield ≈ 4.5 %`).

| Metric | Formula | Read it as |
| --- | --- | --- |
| `theoreticalCameraFramesPerCode` | `callbackFps × holdMs / 1000` | Theoretical CameraFrame **opportunities** per code / 每码理论相机采样机会. **Not** decode opportunities — a frame that lands on a display transition still counts here and may still fail CRC. |
| `decodeSuccessRatio` | `successfulDecodes / decodeAttempts` | Per-frame decoder correctness |
| `crcFailureRatio` | `crcFailures / decodeAttempts` | Locked but CRC-rejected |
| `locateFailureRatio` | `locateFailures / decodeAttempts` | No geometric lock at all |
| `newUniqueChunkYield` | `uniqueReceived / successfulDecodes` | **The key r7 metric**: how much decoded work became new data |
| `duplicateRatio` | `duplicates / successfulDecodes` | Re-observation of already-held chunks |

At a ≈30 FPS cadence: 100 ms → 3.0, 90 → 2.7, 75 → 2.25, 60 → 1.8, 50 → 1.5,
40 → 1.2, 33 → ≈1.0 frames/code — at 33 ms the sender switching cadence meets the
camera cadence.

Every field is `null` when its denominator is 0. A run with no decode attempts has
**no** decode success ratio, and 0 unique chunks from 0 successful decodes is
`null` (0/0 is undefined), **not** 0 %. These metrics are diagnostic: they rank
PASSing points and **never decide PASS**.

## r13 AUTO PHYSICAL TEST HARNESS / 自动物理测试编排器

**Goal:** the PO's per-build physical actions reduce to — compile the Mini Program →
open it on the phone → fix the phone position → **tap ONE button**
`Start Auto Test / 开始自动测试`. Everything after that is automatic.

### Architecture

```
phone (orchestrator + receiver)                 PC (sender)
  utils/optical-core.js                          src/single-baseline-sender-main.ts
    tf012-auto-plan.ts        ── plan + schema ──   tf012-auto-plan.ts (same file)
    tf012-auto-orchestrator.ts (deterministic)      src/tf012-auto-sender-client.ts
  utils/tf012-auto.js (wx.connectSocket glue)            │
        │                                                │
        └──────── wss://<lab>/lab  (control + telemetry) ─┘
                     lab-server.mjs  +  tf012-auto-policy.mjs
```

The **plan, the strict schema and the orchestrator are shared code** in the
platform-neutral bundle, so the phone and the sender read the *same* step definition —
they cannot drift apart on `holdMs` or step order. The phone runs the orchestrator; the
sender executes commands and reports telemetry.

### Control channel — CONTROL and TELEMETRY only

* `networkPayloadPath` stays **NONE**; the optical display → phone camera remains the
  ONLY payload path.
* Every message is flat, fully enumerated and validated by ONE function
  (`validateTf012AutoControlMessage`): an **exact-key allowlist per action**, no nested
  objects, flat bounded arrays, a string-length budget, and rejection of hex/base64 blob
  shapes. The **lab relay applies the same validator** (`tf012-auto-policy.mjs` imports
  the same module) plus a **direction rule**: the sender may only emit
  `HELLO`/`TELEMETRY`, the receiver may only emit control + metrics. A `lab-result`
  publish is additionally scanned for payload-shaped keys before it is persisted.
* Actions: `HELLO`, `SET_MODE`, `SET_HOLD_MS`, `START`, `PAUSE`, `RESUME`, `STOP`,
  `RESET_METRICS`, `STEP_COMPLETE`, `RUN_COMPLETE`, `RUN_ABORTED`, `TELEMETRY`,
  `RECEIVER_METRICS`.

### Plan (planVersion `tf012-auto-v1`)

| Step | Mode | holdMs | Duration | Purpose |
| --- | --- | --- | --- | --- |
| SETUP | static chunk0 | — | 5 s | evidence gate; aborts the run if unusable |
| A1 | static chunk0 | — | 10 s | static reference |
| A2 | cyclic | 5000 | 25 s | slow cyclic |
| A3 | cyclic | 1000 | 25 s | the hold time that produced 0/209 decodes |
| A4 | cyclic | 1000 | 15 s | 5 s cyclic → **PAUSE CURRENT FRAME** → 10 s frozen |
| A5 | static chunk0 | — | 10 s | drift control |

### SETUP GATE — evidence-based, no hard px/cell threshold

Not ready unless: ≥ 1 valid decode, the locator locked at least once, the reserved
pattern score ≥ 0.55, and the observed code width ≥ 120 px. **2.99 px/cell with a valid
decode passes** — the existing physical evidence proves it decodes, so a 4 px/cell rule
would wrongly reject a working setup. On failure the run stops before A1, sends `STOP`,
and shows `SETUP NOT READY / 取景条件未就绪` with `observedCodeWidthPx`,
`pixelsPerCell`, `reservedPatternScore`, `contrast`, `successfulDecodes`, `crcFailures`
and `locateFailures`.

### PAUSE CURRENT FRAME (r13) — not Stop

`pauseCurrentFrame()` clears **only** the interval: the canvas is not cleared, not
redrawn, the cursor and chunk index are unchanged, the payload/frame is identical, and
`broadcasting` stays true so the strip still reports. The phone keeps decoding the very
same optical frame. `resumeCurrentFrame()` continues from the frozen cursor (the cycle
does not restart). A4 splits its metrics into **`beforePause`** and **`duringPause`** so
the run answers "does decode success appear only after freezing a cyclic frame?".

### Result shape

Each step freezes ONE immutable result (`Object.freeze`, append-only, never
overwritten) into the phone's bounded history *and* into the run; A4 additionally
carries `beforePause`/`duringPause`. The final JSON is
`{runId, buildId, planVersion, device, startedAtIso, finishedAtIso, status, setupGate,
steps[], stepsCompleted, stepsPlanned, networkPayloadPath: 'NONE'}`, per step:
`sender {mode, holdMs, cursor, canvasDevicePx, canvasHash, pausedAt/resumedAt…}` and
`receiver {observedCodeWidthPx, pixelsPerCellX/Y, reservedPatternScore, contrast,
frameRotationIndex, callbackFps, processingFps, activeProcessAvgMs, activeProcessP95Ms,
cameraFrames, decodeAttempts, successfulDecodes, crcFailures, locateFailures,
uniqueReceived, decodedChunkIndexes}`.

### One-tap PO usage

1. PC: `npm run lab` (optionally behind the tunnel) and open
   `/single-baseline.html?lab=wss://<host>/lab&holdMs=1000`; wait for
   `CONTROL CHANNEL ONLINE` in the sidebar's AUTO TEST block.
2. Phone: open the Mini Program, paste the control URL (and token) once in the AUTO
   TEST panel, fix the phone position, then tap **Start Auto Test / 开始自动测试**.
3. Watch the panel; at the end tap **Copy final auto JSON / 复制最终 JSON**.

## r12 sender-path equivalence — evidence, not assumption / r12 发送端等价性

**Question raised by physical evidence.** Static diagnostic chunk 0 decoded
**970/970** frames on the phone, while the normal **cyclic** sender at
`holdMs = 1000` produced **0 / 209** successful decodes. At 1000 ms there are
≈14.25 camera-frame opportunities per code, so **dwell time is not the primary
explanation** (`holdMs / insufficient dwell time is NOT the primary explanation`).
Before touching the receiver, locator or protocol, the two **sender** paths were
compared directly.

**Verdict: the two paths are byte-identical. No sender discrepancy exists.**

| Measurement (1920×1080, DPR 1, zoom 1, not fullscreen) | diagnostic `?diagnostic=chunk0` | cyclic `?holdMs=1000`, cursor 0 |
| --- | --- | --- |
| canvas device px | 1020×1020 | 1020×1020 |
| canvas CSS px | 1020×1020 | 1020×1020 |
| carrier bounding box | `x 665, y 13, 1020×1020` | `x 665, y 13, 1020×1020` |
| module pitch (`cellPixels`) | 10 px (1020 / 102) | 10 px |
| `transform` / `scale` / `zoom` | `none` / `none` / 1 | `none` / `none` / 1 |
| **SHA-256 of the full RGBA ImageData** | `a12456f2410ff8544db6e875ae40169fe14757afb8194c736a3756f33f2ade89` | **identical** |
| cropped carrier screenshot | `874C72824930ADA5BAFAB0323FE2D399673356C2AAD1135B28B85D74A484228A` (9441 B) | **byte-identical** |
| sampled 96×96 matrix | equals `transfer.frames[0]` | equals `transfer.frames[0]` |
| decoded `sequence` | `1396834304` | `1396834304` |
| decoded payload (706 B) SHA-256 | `c3904e05bf9209d741833288c458fab6b019c9c86d336c03dbf476b70463dc5c` | identical |
| CRC | PASS (decoder rejects bad CRC) | PASS |

* **Pixel diff: 0 px (0.000 %), no diff bounding box** — the two cropped PNGs are the
  same 9441 bytes.
* `drawChunk()` is one function; both modes call `renderCurrent()` → `drawChunk(0)`.
  `diagnosticMode` only changes *which* index is drawn and disables the timer — it
  never changes the encoding, the sequence, the payload or the CRC.
* **Starting the cycle does not change the geometry.** Measured idle vs running at
  1920×1080, 1600×900, 1440×900, 1366×768, 1280×800 and 1024×768: device px, CSS px,
  bounding box, `cellPixels` and stage box are **identical** in every case
  (`identical=true` for all six). The reserved 34 px control band is accounted for in
  `layout()` in both states, so the strip appearing when broadcasting cannot resize or
  move the carrier.
* **The canvas is stable for the whole hold.** Sampling every animation frame for a
  full 1000 ms hold produced exactly **one distinct hash per cursor value**
  (`distinctHashesPerCursor = [[0,1],[1,1]]`, 67 samples); the checkpoint hashes at
  +0, +16, +33, +100 and +500 ms were all `7fdcac2f2387dbdb` and only changed when the
  cursor advanced. The sender never repaints different pixels during a hold.

**Therefore:**

> static and cyclic sender pixels are identical in-browser; the remaining difference
> is physical display/camera behavior.

The physical numbers support that reading: the same 1020 px carrier was observed as
**287.35 px / 2.993 px-per-cell** in the static run but **221.1 px / 2.303 px-per-cell**
in the cyclic run, with contrast **168.65 → 56.65** and `reservedPatternScore`
**0.9515 → 0.6677** (`frameRotationIndex 2`). A low reserved-pattern score together
with a small observed width is a *capture-side* condition — distance/framing,
exposure or blur — not a rendering condition. Scaling the carrier by 221.1 / 287.35
(0.769) accounts for the entire observed difference at the same physical distance.

**Consequence for the PO:** the static chunk-0 procedure must be reproduced with the
same physical setup (same distance, framing, exposure and maximised window) **before**
any cyclic Stage B work resumes, and `observedCodeWidthPx` must be ≥ ~380 px
(`pixelsPerCell` ≥ ~4.0). Both r11 physical runs were **below** that threshold
(2.99 and 2.30 px/cell), i.e. the capture was already past the documented limit.

**Regression tests** (`single-baseline-sender.spec.ts`):

* `r12 equivalence: diagnostic chunk0 and cyclic chunk0 render the identical canvas` —
  exact SHA-256 equality of the full RGBA carrier, equal device/CSS size, `cellPixels`
  and bounding box, equal sampled matrix (and equal to `transfer.frames[0]`), and equal
  decoded `sequence` + payload bytes (equal to `transfer.payloads[0]`);
* `r12 equivalence: starting the cycle never changes the carrier geometry` — the six
  target viewports must report identical geometry and identical chunk-0 pixels before
  and after Start;
* `r12 equivalence: the carrier stays stable for the whole hold period` — no cursor
  value may ever produce more than one canvas hash inside a 1000 ms hold.

## r11 sender layout — nothing is drawn over the carrier / r11 布局

**Report:** the PO's pre-test screenshot proved the bottom-right explanatory text
covered the OptiGrid. r10's "keep the overlay in a margin" approach was still an
overlay, so r11 removes the overlay approach entirely.

**The page is now a two-column flex layout with no `position:fixed`/`absolute`
element over the canvas at all:**

```
#layout  ──  #panel (left sidebar, in flow)  │  #stage (flex column)
                                                 ├─ <canvas id="codeCanvas">
                                                 └─ #statusbar (reserved 30 px band)
```

* the **help / 说明 text moved into the sidebar bottom** as small print (it was the
  fixed bottom-right block);
* the **control panel is a sidebar column**, not a floating card;
* the **status strip is a flow element** in a band `layout()` reserves *below* the
  carrier — the carrier is sized from `min(stageWidth, stageHeight − 30) × 0.98`, so
  it can never grow into that band;
* the sidebar also yields width (`max-width:calc(100% - 210px)`) so the stage can
  never become narrower than the smallest possible carrier.

**Per state:**

| State | On screen |
| --- | --- |
| stopped | sidebar (controls, hold time, readout, rendered size, collapsed file table, **help text**); strip hidden |
| broadcasting | sidebar stays (outside the carrier, so not an obstruction) **without** the help text; strip below the carrier shows the live state + `Stop` |
| optical fullscreen | sidebar and all help gone; only the OptiGrid plus a below-carrier strip with `Stop` and `Exit Fullscreen`; the carrier can only grow |

**Measured (Playwright, `overlap` = total intersection area of the carrier with
every other visible element, in CSS px²):**

| Viewport | carrier device px (windowed) | `cellPixels` | carrier in fullscreen | overlap stopped / broadcasting / fullscreen |
| --- | --- | --- | --- | --- |
| 1920×1080 | 1020 | 10 | 1020 | 0 / 0 / 0 |
| 1600×900 | 816 | 8 | 816 | 0 / 0 / 0 |
| 1440×900 | 816 | 8 | 816 | 0 / 0 / 0 |
| 1366×768 | 714 | 7 | 714 | 0 / 0 / 0 |
| 1280×800 | 714 | 7 | 714 | 0 / 0 / 0 |
| 1024×768 | 612 | 6 | **714** | 0 / 0 / 0 |

At five of the six viewports the carrier is **exactly the same size as r8/r9/r10**
(all of them height-limited). At 1024×768 the sidebar has to occupy the left column,
so the carrier is 612 px (6 px/cell, above the 4 px/cell floor); leaving the sidebar
in optical fullscreen gives 714 px back. The six target viewports all stay above
4 px/cell and no element intersects the carrier in any state.

**Regression tests** (`single-baseline-sender.spec.ts`):

* `r11 layout: the help text and the controls never intersect the carrier` —
  `intersection(carrier, #hint) == 0` and `intersection(carrier, #panel) == 0` while
  stopped, `== 0` for the sidebar/strip while broadcasting, and **every visible
  non-carrier element `== 0`** (a generic DOM walk, not a hard-coded id list) while
  broadcasting and in fullscreen, at all six viewports;
* `r11 layout: the carrier is sized from the stage box and never collapses` — the
  carrier equals `min(stageW, stageH − 30) × 0.98` floored to whole cells, ≥ 408 px,
  ≥ 4 px/cell, fully inside the stage, with a ≥ 24 px free band below it;
* `r11 layout: optical fullscreen releases the sidebar and keeps the carrier clean` —
  the carrier never shrinks, the stage widens, nothing intersects, and leaving
  fullscreen restores the windowed size;
* `r11 layout: the control strip clears the carrier at a small viewport` — 480×480
  and 800×600 are overlap-free too.

## r10 visual-layout regression / r10 视觉布局回归

**Report:** after the r9 UI work, **no** tested speed decoded (`cameraFrames = 647`,
`decodeAttempts = 647`, `successfulDecodes = 0`, `locateFailures = 0`,
`crcFailures = 647`, `observedCodeWidthPx ≈ 289.62`, `pixelsPerCell ≈ 3.017`,
`reservedPatternScore ≈ 0.7985`, G7a/b/c PASS, G7d FAIL 647/647).
**Hypothesis to test:** "r9 shrank the rendered OptiGrid."

**Verdict: DISPROVEN.** Measured in Playwright at the same viewports for build
`8ef0d5b` (r8) and `4f380f8` (r9):

| Viewport | canvas device px (r8 = r9) | `cellPixels` (r8 = r9) | r8 panel H | r9 panel H | r8 overlap | r9 overlap |
| --- | --- | --- | --- | --- | --- | --- |
| 1920×1080 | 1020 | 10 | 430×530 | 430×700 | 0 % | 0 % |
| 1600×900 | 816 | 8 | 430×530 | 430×700 | 3.92 % | 5.25 % |
| 1440×900 | 816 | 8 | 430×530 | 430×700 | 9.95 % | 13.32 % |
| 1366×768 | 714 | 7 | 430×530 | 430×700 | 11.97 % | 15.90 % |
| 1280×800 | 714 | 7 | 430×530 | 430×700 | 15.82 % | 21.19 % |
| 2560×1440 | 1326 | 13 | 430×530 | 430×700 | 0 % | 0 % |

The carrier size is derived from the viewport **only** (`layout()` is byte-identical
r8 vs r9, and hiding the panel never changes `canvas.width`), so r9 **did not**
shrink the code. What r9 *did* do is grow the control panel by ~170 px and push its
overlap of the canvas up by 3–5 percentage points.

The camera-side drop (402.49 → 289.62 px, ratio **0.7196 ≈ 7/10 cells**) matches a
sender rendering at `cellPixels = 7` instead of `10`, i.e. a smaller window /
non-maximised state — plus the documented `px/cell < 3` physical limit. Both facts
are reported as measured, and the occlusion regression was fixed regardless.

### Invariant (now enforced by test) / 不变量

**Benchmark UI must never cover or resize the optical carrier.** 基准测试界面
绝不能遮挡或改变光学载体尺寸。

| State | Overlay policy |
| --- | --- |
| stopped | control panel + hint visible; long file table **collapsed** |
| broadcasting | panel + hint auto-hidden; compact pill only, in a margin the centred canvas never uses → **0 % occlusion** |
| optical fullscreen (`F` / button) | every overlay hidden → **0 % occlusion** |

`#pillShow` (Show / 显示) brings the controls back **without** stopping the
broadcast; changing the hold time still stops the cycle rather than retiming it.

### Rendered code size readout / 码显示尺寸

The sender prints `Rendered code size / 码显示尺寸`: canvas device px, CSS px
(including the quiet zone), the OptiGrid core size, and `device px/cell`. It is
labelled **"display side only, NOT the camera-observed size"** — the only size that
decides a physical PASS is the one the camera sees, and it must be read from the
frozen JSON (`observedCodeWidthPx`, `pixelsPerCell`) on the phone.

### r10 static chunk-0 restore target / r10 静态 chunk 0 恢复目标

Before resuming any speed work, reproduce the known-good static point with a
**maximised / F11 window** on the sender:

| Field | Required |
| --- | --- |
| `observedCodeWidthPx` | **≥ ~380** (healthy runs: 394–402) |
| `pixelsPerCell` | **≥ ~4.0** |
| `decodedChunkIndex` | **0** (`?diagnostic=chunk0`) |
| CRC | PASS **and** SHA MATCH |
| `locateFailures` | 0 |
| sender readout | `device px/cell` ≥ 8; if it reads 7 or less, the window is too small — maximise it and re-measure |

If `px/cell` is below ~3 on the phone, the scan is past the physical limit: move the
phone closer / fill more of the frame. That is a setup correction, **not** a
protocol change.

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

The r6 Stage A **physical PASS** results (1500 / 333 / 150 / 75 / 33 ms) plus the
**750 ms anomalous run** are recorded in full in `docs/OPTILINK_DATA_FLOW_GATES.md`
and in the Stage A table above.

## Software evidence before the PO test / 送测前的软件证据

Run from `experiments/tf-002-single-code`:

| Command | Covers |
| --- | --- |
| `node --test src/optical-core/single-baseline.test.ts` | G1–G4, G8–G13 protocol + receiver logic (16 tests) |
| `node --test src/optical-core/single-baseline-pixels.test.ts` | G6–G13 rendered-pixel end-to-end, all 4 frame rotations, tilt, blur + sensor noise (12 tests) |
| `node --test src/optical-core/single-baseline-g7.test.ts` | G7a–G7d against monitor-capture fixtures: washout, dark room/bezel/UI larger than the code, cast, illumination gradient, blur, moiré, noise, perspective, small code (10 tests) |
| `node --test src/optical-core/single-baseline-speed-ladder.test.ts` | r6 speed ladder: the 12 hold values, URL clamping (no 100 ms floor), declared-rate arithmetic, the net-goodput guard matrix, and the proof that post-completion frames never enter the active latency set (10 tests) |
| `node --test src/optical-core/single-baseline-stage-b.test.ts` | r7 Stage B: the 100/90/75/60/50/40 set, the merged preset list, the frames-per-code table, all six Stage A ratios recomputed from the measured counters (including the 750 ms real zero and the 0/0 → null rule), and the separation of per-frame correctness from whole-file collection efficiency (11 tests) |
| `node --test src/optical-core/single-baseline-mini.test.ts` | Mini Program boot/baseline-mode smoke, G7 UI wiring, r6 speed-ladder + r7 efficiency UI and frozen-JSON fields, network scan, oracle scan (4 tests) |
| `npm run test:single-baseline-sender` | G5 sender Start/Stop/cycle **and** static diagnostic hold in a real browser; every canvas CRC-decoded |
| `npm test` | the full existing regression suite |

## Physical capability metrics to record / 需记录的物理能力指标

camera frame width/height · observed code width/height in camera pixels · matrix
size · estimated pixels-per-cell X/Y · decode attempts · successful decodes · CRC
failures · duplicate chunks · unique chunks · time to first valid chunk · time to
all chunks · total reconstruction time · SHA result · active pre-completion
processing latency (avg / p50 / p95 / max) · post-completion ignored frames ·
theoretical CameraFrames per code · decode success ratio · CRC failure ratio ·
locate failure ratio · new unique chunk yield · duplicate ratio.

**Net Goodput is never declared by default.** It appears only as
`exploratoryNetGoodput*` on a complete, SHA-256-exact real phone run, inside the
`PHYSICAL SINGLE-CODE FILE TRANSFER BASELINE · SPEED LADDER` evidence class — never
as G0 and never as optical throughput.
