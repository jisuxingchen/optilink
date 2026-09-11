# WeChat Mini Program Receiver — Feasibility Report

Date: 2026-09-10
Repo: `jisuxingchen/optilink`
Status: **Research / prototype spike** (TF-008 precursor). No merge performed.

---

## 1. Executive conclusion

**CONDITIONAL GO**

A WeChat Mini Program can, in principle, replace the mobile-browser Receiver for
OptiLink optical transfer. Official documentation confirms every *hard*
prerequisite exists:

- continuous camera frame access (`CameraContext.onCameraFrame`, RGBA `ArrayBuffer`),
- `WXWebAssembly`, `Worker`, `OffscreenCanvas`, `Canvas 2D`, `WebGL`, typed arrays,
- local binary file write + `FileSystemManager.getFileInfo({ digestAlgorithm: 'sha256' })`,
- offline execution of an already-cached package,
- LAN-only coordinator via `ws://` (optional — not required for payload).

The "conditional" is because the two quantities that decide real feasibility —
**frame callback FPS** and **decode throughput on device** — are **not documented
and must be measured on physical hardware** (the moto razr 40 ultra). Nothing in
the official API guarantees 30/60 FPS frame delivery or that the dense
fiducial/OptiGrid pipeline runs fast enough in Mini Program JS/WASM.

Decision rule: **GO** only after the TF-008 camera-frame PoC proves, on the
physical device, that (a) `onCameraFrame` delivers a usable frame rate at a
usable resolution, and (b) the decode pipeline's per-frame cost fits inside that
budget. Until then it is CONDITIONAL.

No weakening of the optical-only payload rule is proposed. The Mini Program must
complete the full receive session with Wi-Fi / Bluetooth / mobile data OFF.

---

## 2. Capability matrix

Legend for Evidence/Source: **Official** = official WeChat/Tencent docs cited;
**UNKNOWN** = not documented, requires physical test; **Sim** = DevTools simulator.

| Requirement | Mini Program capability | Evidence / source | Risk |
|---|---|---|---|
| Rear camera | `device-position="back"` on `<camera>` | Official (camera component, base 1.6.0) | Low |
| Continuous frames | `CameraContext.onCameraFrame` → `CameraFrameListener.start/stop` | Official (base 2.7.0) | Low (API exists) |
| Frame callback FPS | Not documented; device/system determined | UNKNOWN — physical test required | **High** |
| Resolution control | `resolution` (low/med/high) + `frame-size` (small/med/large); actual pixel size device-determined | Official (camera component) | Medium |
| Raw pixel access | callback `{ width, height, data: ArrayBuffer }`, RGBA 4 bytes/px | Official (`onCameraFrame`) | Low |
| Pixel format | RGBA only (no YUV option exposed) | Official | Low (RGBA is fine) |
| WASM | `WXWebAssembly.instantiate(path)`, Memory/Table/Global (iOS: no Global), SIMD since WeChat 8.0.25 | Official (WXWebAssembly guide) | Low–Medium |
| Worker | `wx.createWorker` (max 1), `useExperimentalWorker` for iOS; frames can be delivered into worker via `CameraFrameListener.start({worker})` + `Worker.getCameraFrameData` (2.25.1) | Official | Medium (single worker) |
| Canvas 2D | `<canvas type="2d">` (2.9.0); max 1365×1365 | Official (canvas component) | Medium (size cap) |
| WebGL | `<canvas type="webgl">` (2.7.0) | Official | Low |
| OffscreenCanvas | `wx.createOffscreenCanvas` (2.16.1), `getImageData` supported | Official | Low |
| Typed arrays | Standard `Uint8Array`/`ArrayBuffer` throughout | Official (frame data is ArrayBuffer) | Low |
| Local binary storage | `FileSystemManager.writeFile/appendFile/readFile` accept `ArrayBuffer`; `wx.env.USER_DATA_PATH` | Official | Low |
| 10 MiB reconstruction | User files quota 200 MB combined; single file ≤ 100 MB | Official (file-system guide + writeFile err 1300202) | Low |
| SHA-256 | `FileSystemManager.getFileInfo({ digestAlgorithm: 'sha256' })` → `{ size, digest }` | Official | Low (or compute in JS/WASM) |
| Offline execution | Cached package launches with stale local version when network absent | Official (update-mechanism) | Medium (first launch needs network) |
| Network-independent optical op | No network API required for receive; coordinator optional | Official (LAN `ws://` allowed) | Low |
| Coordinator (optional) | `wx.connectSocket`; `ws://` LAN IP allowed since 2.4.0; production remote requires `wss://` + whitelisted ICP domain | Official (network guide + mDNS guide) | Low (optional anyway) |

---

## 3. Architecture recommendation

```
PC Sender  →  visible OptiGrid frames  →  Mini Program camera
                                              │  (RGBA ArrayBuffer frames, LOCAL only)
                                              ▼
                                        acquisition adapter
                                              │  PixelFrame {width,height,data}
                                              ▼
                                 normalization / orientation / fiducial
                                              ▼
                                 OptiGrid sampling → cell observations
                                              ▼
                                 Manifest recovery (OLTP manifest)
                                              ▼
                                 OLTP decode (deferred / Fountain)
                                              ▼
                                 local file write (USER_DATA_PATH)
                                              ▼
                                 SHA-256 (getFileInfo or JS/WASM)
                                              ▼
                                 equality check vs Manifest.sha256
```

The payload path is **entirely local**: camera → memory → disk. The only optional
network component is a coordinator (`wx.connectSocket` to a LAN `ws://` address)
for session/control/telemetry, which is **not** on the payload path and is
explicitly disabled during formal G0 transfer (radios OFF).

Proposed target repo structure (not implemented in this spike):

```
packages/
  optical-core/            # pure-TS, platform-agnostic optical algorithms
    acquisition/           # PixelFrame type, sampler interface (adapter boundary)
    optigrid/              # optigrid-v1, geometry, training solver, packed cells
    manifest/              # oltp-manifest, optical session, manifest recovery
    decoder/               # deferred decoder, observation spool, fountain
    integrity/             # portable SHA-256
apps/
  web-receiver/            # existing tf-002 browser Receiver (unchanged behavior)
  wechat-mini-receiver/    # new Mini Program Receiver
```

The critical abstraction is a single interface replacing the DOM `ImageData`
dependency in the core algorithms.

---

## 4. Reuse analysis

### A. Reusable unchanged (pure TypeScript, no DOM)

| Module | Notes |
|---|---|
| `optigrid-v1.ts` | frame encode/decode, payload capacity, reserved cells |
| `optigrid-geometry.ts` | homography, quad mapping |
| `tiled-training-solver-core.ts` / `-legacy.ts` / `-solver.ts` | fiducial/known-training lock acquisition |
| `tiled-orientation-fiducial.ts` | fiducial locator |
| `tf007h-orientation-quality.ts`, `tf007h-known-training-refine.ts` | orientation ranking / refine |
| `packed-cell-sampler.ts`, `packed-cell-buffer.ts` | packed cell sampling |
| `observation-spool.ts`, `buffered-observation-queue.ts` | spool / queue |
| `deferred-optigrid-decoder.ts` | deferred decode |
| `stable-fingerprint-gate.ts` | fingerprint gate |
| `tf007g-manifest-recovery.ts` | Manifest recovery |
| `protocol.ts` (crc32), `fountain.ts`, `buffered-throughput-model.ts`, `tf-007f-*.ts` | CRC / Fountain / planning |
| `oltp-manifest.ts`, `oltp-optical-session.ts` | Manifest type + optical frames |

### B. Reusable with adapter

| Module | Required adapter |
|---|---|
| All core modules typing input as `ImageData` | Replace with a `PixelFrame { width, height, data: Uint8Array }` interface; Mini Program wraps `onCameraFrame` `{width,height,data}` into it (RGBA already) |
| `protocol.ts` `sha256Hex` | Uses `crypto.subtle` (browser-only). Replace with portable pure-JS/WASM SHA-256 or `getFileInfo({digestAlgorithm:'sha256'})` |
| `oltp-manifest.ts` `TextEncoder`/`TextDecoder` | Verify availability in Mini Program runtime; provide a polyfill if absent |
| `fountain.ts` (if it hashes) | Same SHA-256 adapter |

### C. Browser-only (do not reuse)

| Module | Why |
|---|---|
| `tiled-physical-v5-main.ts` and all `*-main.ts` / `*-selftest.ts` | DOM, `getUserMedia`, `drawImage`/`getImageData`, `WebSocket` coordinator, `requestVideoFrameCallback` |
| `tiled-physical-fiducial-hooks.ts` | Monkey-patches `CanvasRenderingContext2D.prototype.drawImage` — browser-only |
| `optigrid-preflight.ts`, `carrier-bench.ts`, `carrier-frontier.ts`, `main.ts` | Browser benches/harness |

### D. Mini Program-specific (new)

| Component | Notes |
|---|---|
| Camera acquisition adapter | `<camera>` + `onCameraFrame` → `PixelFrame` |
| Frame normalization | JS/OffscreenCanvas/WASM downscale of RGBA frames (no `drawImage(video)`) |
| File sink | `appendFile`/`writeFile` to `USER_DATA_PATH` |
| SHA-256 | `getFileInfo` digest (or WASM) |
| Optional coordinator | `wx.connectSocket` (`ws://` LAN) — not on payload path |

---

## 5. Risks

1. **Camera-frame FPS (HIGH).** `onCameraFrame` callback rate is not documented
   and is device/system determined. OptiLink's carrier targets a 60 Hz display
   with 15 Hz optical symbols; if the Mini Program delivers e.g. only 15–24 FPS,
   held-symbol acquisition still works but temporal headroom shrinks. Must measure
   on the moto razr 40 ultra.
2. **Resolution (MEDIUM-HIGH).** `frame-size` gives coarse buckets; the actual
   `onCameraFrame` pixel dimensions are device-decided. Need enough resolution for
   3× 96–192-cell OptiGrid tiles in one frame. Must measure.
3. **YUV conversion (LOW).** Frames are RGBA only — no YUV decode needed, which
   actually removes a browser pain point.
4. **Memory (MEDIUM).** Streaming architecture is mandatory: extract compact cell
   observations and discard the image immediately. Do not retain full frames.
   Single-Worker and WASM memory limits apply.
5. **Runtime limitations (MEDIUM).** Max **1** Worker; Canvas 2D max 1365×1365;
   iOS lacks `WXWebAssembly.Global`. `SharedArrayBuffer` is not confirmed
   available — treat as UNKNOWN and avoid depending on it.
6. **iOS differences (MEDIUM).** `useExperimentalWorker` needed for iOS worker
   speed; iOS cannot use mDNS (7.0.18+); `WXWebAssembly.Global` unsupported on iOS.
7. **Offline launch (MEDIUM).** An already-cached package launches offline (stale
   local version). **First-ever** launch of a never-used Mini Program requires
   network. Formal G0 must ensure the package is pre-loaded before the offline
   test. "优先使用本地版本" admin setting helps avoid sync-update stalls.
8. **File export (MEDIUM).** Reconstructed file is stored locally and hash-verified;
   exporting it (save to album / share) is a separate, post-test step and may be
   restricted by WeChat policies.

---

## 6. Recommended next milestone

**TF-008 — Mini Receiver Spike** (do **not** auto-create; propose only)

Acceptance criteria (very small):

1. Camera-frame PoC (this repo, `experiments/tf-008-wechat-mini-receiver-poc`) runs
   on the moto razr 40 ultra and reports real `frameWidth × frameHeight`, RGBA
   buffer size, callback FPS, and a non-zero luma range.
2. Record, on-device, `onCameraFrame` FPS and resolution with `frame-size="large"`
   (and `medium`/`small`).
3. Measure per-frame cost of the existing fiducial + sparse-fingerprint step
   (adapted to `PixelFrame`) — decide JS vs WASM vs Worker.
4. Decide GO / NO-GO on Mini Program Receiver based on (1)–(3).

If GO, the next task integrates TF-007H orientation acquisition + Manifest
recovery + OLTP decode behind the `PixelFrame` adapter, with the full pipeline
still optical-only.

---

## Governance / final report

1. **Verdict:** CONDITIONAL GO.
2. **Key official API findings:**
   - `CameraContext.onCameraFrame` returns RGBA `ArrayBuffer` frames via a
     `CameraFrameListener` (`start`/`stop`), base 2.7.0; requires `frame-size`.
   - Frames can be routed into a Worker (`start({worker})`, base 2.25.1).
   - `WXWebAssembly` supports Memory/Table (+ SIMD since WeChat 8.0.25); WASM in
     Worker since 2.15.0; wasm must live outside the worker dir; `.wasm.br` ok.
   - `FileSystemManager.writeFile/appendFile/readFile` accept `ArrayBuffer`;
     `getFileInfo({ digestAlgorithm:'sha256' })` returns `{ size, digest }`.
   - User-file storage 200 MB combined; single file ≤ 100 MB.
   - Offline: cached package launches with stale local version when offline;
     first-ever launch requires network.
   - `ws://` LAN coordinator allowed since 2.4.0 (same subnet, non-local IP);
     remote production requires `wss://` + whitelisted ICP domain.
   - Camera stops when backgrounded (`bind:stop`).
3. **Prototype files created:**
   - `experiments/tf-008-wechat-mini-receiver-poc/` (app + page + README).
4. **Tests actually run:** None physically — Mini Program requires WeChat DevTools
   + a physical phone. No simulator run performed in this environment. No
   fabricated camera evidence.
5. **Requires physical phone test:** frame FPS, resolution, pixel format
   confirmation, decode throughput, offline cold-start behavior, iOS behavior.
6. **Recommended next step:** approve TF-008 spike; run the camera-frame PoC on the
   moto razr 40 ultra and record FPS/resolution before integrating the optical
   pipeline.

No PR merged. No TF-007H thresholds changed. No Manifest PASS / Net Goodput
claimed. No network path for payload introduced.
