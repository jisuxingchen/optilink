# TF-008 — WeChat Mini Program Receiver camera-frame PoC

A directly-runnable WeChat Mini Program that proves JavaScript receives **real,
continuous camera pixel data** via `CameraContext.onCameraFrame`, and measures
the metrics OptiLink needs before committing to a Mini Program Receiver.

This is a **feasibility spike only**. It does **not** implement TF-007H
acquisition, Manifest recovery, OptiGrid decode, or payload reconstruction.

## Product boundary (hard rule)

Payload is **optical-only**. This Mini Program makes **ZERO network calls**. No
OptiGrid image / cell / frame / payload / oracle data leaves the device through
Wi-Fi, mobile data, Bluetooth, USB, NFC, WebSocket, or HTTP/HTTPS.

The page permanently shows **"OPTICAL CAMERA FRAME — LOCAL ONLY"** and
**"Network payload path: NONE"**.

---

## 1. Open WeChat Developer Tools

1. Install / open **WeChat Developer Tools** (微信开发者工具).
2. On the first screen click **Import** (导入) / "Import project".

## 2. Import project

- **Directory to select:**
  `experiments/tf-008-wechat-mini-receiver-poc`
  (the folder that contains `project.config.json`).

## 3. AppID mode for local testing

- Use the **test AppID** (`touristappid`, "测试号") or your own test AppID.
- The `project.config.json` already sets `"appid": "touristappid"`.
- You do **not** need a registered production AppID for this spike.

## 4. Required base library version

- `project.config.json` sets `"libVersion": "2.33.0"`.
- Minimum APIs used:
  - `CameraContext.onCameraFrame` — base **2.7.0**
  - `CameraContext.setZoom` / `maxZoom` — base **2.10.0**
  - split system-info APIs (`wx.getDeviceInfo` / `wx.getAppBaseInfo`) — base **2.20.1**
- Use a base library **≥ 2.33.0** if prompted. A newer stable is fine.

## 5. Preview / real-device debug

- Click **Preview** (预览) → scan the QR code with WeChat on your
  **moto razr 40 ultra**.
- Or use **Real-device debug** (真机调试) for live console.

> **Developer Tools simulator evidence is NOT physical evidence.** The simulator
> uses a synthetic camera; its FPS/resolution/pixel data do not represent your
> phone. Only the physical-device run counts.

## 6. Camera permission flow

- First tap of **Start Camera** triggers WeChat's `scope.camera` authorization
  prompt. Tap **Allow**.
- If previously denied, re-enable camera in WeChat settings. The status panel
  shows `granted` / `denied` / `not-requested`.

## TF-012 r21 — MINIMAL RECEIVE (the default flow)

Since r21 the Mini Program opens on the **minimal physical receiver**, not on the diagnostic
harness:

```
open → camera auto-starts → sender connected → tap ONE button → receive → PASS/FAIL → COPY RESULT
```

CameraFrame → locate → sample → CRC → chunk → dedupe → reconstruct → SHA-256, and nothing else.

**How to run it**

1. Open the Mini Program. The first screen must read `buildId tf012-r21-e2b5a40`. The camera
   starts by itself (allow `scope.camera` if asked).
2. On the PC, start the single-code baseline sender (the 16-chunk transfer).
3. Wait until the phone shows **Camera: READY** and **Sender: CONNECTED**
   (`SOCKET ONLY` = the relay is reachable but the PC sender is not announcing itself).
4. Tap **START RECEIVE / 开始接收** once. The run ends the moment
   `16/16 chunks + 10240 B + SHA-256 MATCH` is true — in seconds, not after a 90 s plan.
5. Tap **COPY RESULT / 复制结果** and send the JSON. It is small by design: buildId, mode, status,
   timings, the camera/decode counters, chunks, `assembledBytes`, the two local digests,
   `shaResult`, the geometry numbers and `networkPayloadPath: NONE`. After P4 it also carries
   compact scalar chunk-identity summaries — `receivedChunkIndexes`, `missingChunkIndexes`,
   `decodedChunkCounts`, `metadataRejects`, `foreignChunkRejects`, and `duplicateChunks`.
   They are read only when the terminal result is copied; no r19/r20 per-frame diagnostics are
   re-enabled.

**STATIC CHECK / 静态检查** is the quick alignment aid: PASS at 10 valid decodes within 5 s, with no
sender progress needed.

**Bounds (not schedules):** receive 30 s, static check 5 s. Nothing waits for a fixed dwell time
after a PASS, and once the verdict is in, camera frames are dropped before the decoder.

**Where the diagnostics went.** The r13–r20 harness — AUTO PHYSICAL TEST (SETUP gate + A1–A5),
STATIC PROBE, phase timing, camera timing, failure fingerprints, sampling geometry, rotation
histograms, KEY STATUS, the holdMs declaration and the mode buttons — is all still present, behind
**ADVANCED DIAGNOSTICS / 高级诊断**, which is **OFF by default**. The default runtime does not
compute any of it; a test proves zero diagnostic receiver calls per frame.

`utils/tf012-simple.js` holds the entire decision surface of the minimal path (pure, no platform,
no network, unit-tested).

The steps in §7 below describe the ORIGINAL r5 camera-frame spike UI, which now lives behind
**ADVANCED DIAGNOSTICS** (mode buttons + KEY STATUS).

## 7. How to run the test

1. Point the rear camera at any well-lit, high-contrast scene.
2. Tap **Start Camera**.
3. Watch callback FPS, processing FPS, resolution, luma range, ingress MB/s.
4. Optionally toggle **Normalization 1280×720** to measure normalization cost.
5. When done, tap **Freeze Test Result**, then **Copy Result**.

## 8. Recommended test duration

- **20–30 seconds** of continuous capture before freezing. This yields enough
  samples for stable callback-FPS / processing-FPS / p95 estimates.

## 9. What to copy back

After **Freeze Test Result** → **Copy Result**, paste the JSON back into
ChatGPT. It is self-labelled:

```
Evidence class: PHYSICAL MINI PROGRAM CAMERA-FRAME POC
```

It contains device info, runtime info, resolution, callback/processing FPS,
frame counts, avg/p95 processing ms, normalization metrics, luminance/contrast,
start time, duration, and errors. It explicitly states it is **NOT** a TF-007H /
Manifest / throughput / Net Goodput PASS.

---

## What the metrics mean (honest definition)

- **callback FPS** = frames delivered by `onCameraFrame` per second.
- **processing FPS** = frames on which the cheap luma stat ran (normally equals
  callback rate; the cheap stat runs on every frame).
- **skipped/dropped** = `received − processed` (normally 0).
- **normalization** runs on every 3rd frame (when enabled) and is timed separately.
- **data ingress MB/s** = `frameBufferBytes × callbackFPS / 1e6`.

## TF-008 — orientation acquisition mode

The page has two modes (toggle with **Mode**):

- **orientation** (default): runs the shared TF-007H 64×64 orientation acquisition
  on live camera frames. Point the rear camera at the PC Sender's 64×64
  orientation pattern and watch `candidate` / `state` / `exact tiles` /
  `projection safe` / `locator support`. Success target: `LOCKED` with
  `exact tiles 3/3`, `errors 0`, `projection true`, correct orientation.
- **benchmark**: the original camera-frame throughput benchmark (callback FPS,
  processing FPS, luminance/contrast, optional 1280×720 normalization).

The orientation acquisition is the **exact same code** the browser Receiver uses,
bundled into `utils/optical-core.js` (see below). No TF-007H source was modified.

## Rebuilding utils/optical-core.js

The shared core lives in `experiments/tf-002-single-code/src/optical-core/`.
To rebuild the Mini Program bundle after editing it:

```powershell
cd experiments/tf-002-single-code
npx vite build --config vite.optical-core.config.mjs
Copy-Item dist-optical-core/optical-core.js ..\tf-008-wechat-mini-receiver-poc\utils\optical-core.js -Force
```

## Local-only guarantee (verified)

No network APIs are used anywhere in the source:
`wx.request`, `wx.uploadFile`, `wx.downloadFile`, `wx.connectSocket`,
`wx.createUDPSocket`, `wx.createTCPSocket`, `WebSocket`, `wx.cloud` — **none present**.

## Key official APIs used

| Capability | API | Base lib |
|---|---|---|
| Camera component | `<camera>` (rear, flash, resolution, frame-size) | 1.6.0 |
| Frame listener | `CameraContext.onCameraFrame` → `CameraFrameListener.start/stop` | 2.7.0 |
| Zoom | `CameraContext.setZoom` + `bindinitdone` `maxZoom` | 2.10.0 |
| Frame data | callback `{ width, height, data: ArrayBuffer }` (RGBA) | 2.7.0 |
| System info | `wx.getSystemInfoSync` / `wx.getDeviceInfo` / `wx.getAppBaseInfo` | 2.20.1 |
| Clipboard | `wx.setClipboardData` | 1.1.0 |
