# TF-012 r4 — Single-Code Baseline / 单码基线 (physical bring-up path)

**Status:** READY for PO physical action (after exact-head CI green + Technical
Review PASS).
**Build:** `tf012-r5-<shortsha>` · branch `spike/tf-012-physical-performance` ·
Issue #53 · PR #54.
**r4 physical evidence (kept):** G6 CameraFrame = **PHYSICAL PASS**;
G7 = **PHYSICAL FAIL** with `locateFailures = 5272 / 5272` and `crcFailures = 0`;
G7b–G13 = NOT REACHED. See `docs/OPTILINK_DATA_FLOW_GATES.md` → Current physical
status for the exact failure mechanism and the r5 fixes.

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

Speed does not matter here. **This baseline deliberately bypasses** the full
TF-012 protocol: no cold-join beacon state, no Preamble, no Manifest, no Fountain,
no 3-tile composition. See `docs/OPTILINK_DATA_FLOW_GATES.md` for the gate model.

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
| Broadcast hold | 1000 ms per chunk by default (`?holdMs=` overridable) |

Chunk byte layout (see G3 in the gates document for the full table): magic `"SB"`,
version, reconstructionMethodId, totalChunks, chunkDataBytes, totalFileBytes,
fileId, chunkIndex, fileNameBytes, fileName, fileSha256 (32 raw bytes), then 640
bytes of file data.

## PO test steps / PO 测试步骤

### NEXT TEST (r5) — static chunk-0 G7 bring-up / 单码静态定位测试

The r4 physical run proved **G6 = PHYSICAL PASS** and then failed inside the
locator on **5272 / 5272 frames** with no explanation (`locateFailures = 5272`,
`crcFailures = 0`). G7 is now split into G7a→G7d with per-frame metrics, and the
sender has a static diagnostic mode. **Do not run the 16-chunk transfer yet.**

1. **Sender command**
   ```
   cd experiments/tf-002-single-code
   npm run dev:single-baseline-sender
   ```
2. **Sender URL** — this holds ONE chunk forever, no cycling:
   ```
   http://<PC-LAN-IP>:5319/single-baseline.html?diagnostic=chunk0
   ```
3. **Expected sender screen**: one large OptiGrid, panel shows
   `TF-012 Single-Code Baseline · Diagnostic 诊断模式`,
   `Diagnostic Mode / 诊断模式 = Static hold / 静态固定`,
   `Held Chunk / 固定切片 = 0`, `Hold time = static (diagnostic)`,
   `Current chunk = 0 / 15`, status `Stopped / 已停止`
4. **Click Start / 开始** → status becomes `Holding / 固定中` and the code stays on
   chunk 0 (it must never advance)
5. **Mini Program**: mode **Single-Code Baseline / 单码基线** → **Start Camera**
6. **Aim** so the whole code plus its white border is inside the frame, roughly
   square to the screen, close enough that the code fills a good part of the frame
7. **Read the `G7 locator diagnostics` panel** and screenshot it. What matters:
   - `deepest stage / 最深阶段` → `G7a`, `G7b`, `G7c` or `G7d`
   - `G7a Candidate Detection` PASS/FAIL + `frame luma min/max/mean`,
     `contrast`, `dark pixel ratio`, `dark components`, `candidates`,
     `candidate spans`, `largest region`, `G7a rejection`
   - `G7b Code Bounding Box` PASS/FAIL + reason
   - `G7c Geometry Lock` PASS/FAIL + `seeds`, `best seed score`,
     `best refined score (incl. failed)`, `geometry` (px/cell, phase)
   - `G7d OptiGrid CRC Decode` PASS/FAIL + `CRC attempts/ok/fail`,
     `decoded sequence`, `decoded chunkIndex`
8. **PASS target for this run**: at least one frame shows
   `G7a PASS`, `G7b PASS`, `G7c PASS`, `G7d PASS`, `decoded chunkIndex = 0`.
   Partial progress is also useful evidence — e.g. "G7a PASS (candidates 2,
   contrast 130) but G7c FAIL bestRefined 0.5 px/cell 12" tells us exactly what to
   fix next.
9. **Then**: `Freeze Test Result` → `Copy Result`
10. **Send back**: the full JSON, a screenshot of the G7 diagnostics panel, a
    screenshot of the sender screen, and radios ON/OFF

Only after a static chunk-0 CRC decode succeeds do we resume the 16-chunk cyclic
transfer test below.

### AFTER G7 WORKS — 16-chunk cyclic transfer / 16 片循环传输

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

## Acceptance / 验收

PASS only if a **real phone** proves:

10 KiB source → one-code cyclic optical broadcast → receiver joins at an arbitrary
time → receives all 16 unique chunks → reconstructs 10240 bytes → SHA-256 exact →
reconstructed text displayed.

Not part of this baseline: speed / Net Goodput claim, file save, 3-code
requirement, Fountain requirement, Preamble requirement, Manifest requirement.

## Software evidence before the PO test / 送测前的软件证据

Run from `experiments/tf-002-single-code`:

| Command | Covers |
| --- | --- |
| `node --test src/optical-core/single-baseline.test.ts` | G1–G4, G8–G13 protocol + receiver logic (16 tests) |
| `node --test src/optical-core/single-baseline-pixels.test.ts` | G6–G13 rendered-pixel end-to-end, all 4 frame rotations, tilt, blur + sensor noise (12 tests) |
| `node --test src/optical-core/single-baseline-g7.test.ts` | G7a–G7d against monitor-capture fixtures: washout, dark room/bezel/UI larger than the code, cast, illumination gradient, blur, moiré, noise, perspective, small code (10 tests) |
| `node --test src/optical-core/single-baseline-mini.test.ts` | Mini Program boot/baseline-mode smoke, G7 UI wiring, network scan, oracle scan (4 tests) |
| `npm run test:single-baseline-sender` | G5 sender Start/Stop/cycle **and** static diagnostic hold in a real browser; every canvas CRC-decoded |
| `npm test` | the full existing regression suite |

## Physical capability metrics to record / 需记录的物理能力指标

camera frame width/height · observed code width/height in camera pixels · matrix
size · estimated pixels-per-cell X/Y · decode attempts · successful decodes · CRC
failures · duplicate chunks · unique chunks · time to first valid chunk · time to
all chunks · total reconstruction time · SHA result.

**Net Goodput is deliberately NOT reported** — this is only the
`PHYSICAL SINGLE-CODE FILE TRANSFER BASELINE`.
