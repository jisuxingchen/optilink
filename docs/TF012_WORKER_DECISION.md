# TF-012 — Worker Decision Record

**Status:** DEFERRED — do not implement a WeChat Worker for the first physical smoke test.
**Rule applied:** "Do not implement complexity only for architectural appearance" / "Measure before choosing."

## Decision

TF-012 ships the **bounded single-thread pipeline** on the Mini Program main thread:

```
CameraFrame callback
  → bounded latest-frame slot (one processing + one pending)
  → SharedOpticalReceiveCore.processFrame (shared receive-core bundle)
  → UI tick (batched, 500 ms) + checkpoint (bounded) + local file write
```

A WeChat `Worker` is **not** implemented in this stage.

## Why

1. **We cannot measure the blocker yet.** Phase 4 says "Measure before choosing." The
   deciding measurement — whether main-thread receive work materially blocks
   `CameraFrame` callbacks on the real phone — requires a real device. That is a
   PO action, not a software action.
2. **The shared core is already DOM/canvas/camera-free**, so it *could* run in a
   Worker, but the adapter owns everything platform-specific. A Worker would not
   require an algorithm fork — it would `require` the same `utils/optical-core.js`
   CJS bundle lineage (see `bundle lineage check` in validation).
3. **Copy cost is real and unquantified.** A 720×1280 RGBA frame is ~3.7 MB.
   WeChat Mini Program `Worker.postMessage` does **not** support a transfer list;
   it structured-clones. Moving the full buffer per frame adds a copy of the
   dominant input. Whether that copy costs more than the main-thread work it
   offloads is exactly the thing that must be measured on-device.
4. **The bounded pipeline already bounds the backlog.** The main-thread consumer
   naturally throttles the producer; heavy stages (orientation) are gated behind
   the cheap beacon probe and only run on beacon frames. Phase 8 allows heavy
   acquisition to exceed one frame period as long as the backlog stays bounded
   and the receiver recovers automatically.

## When to revisit

After the first physical 64 KiB test, with real numbers for:

- `callbackFps` vs `processingFps`
- per-stage `avg/p50/p95/max` (Phase 1 inventory, captured on-device)
- `skippedBusyFrames` / `replacedFrames`
- main-thread blocking observed in the Mini Program profiler

If `processingFps` materially trails `callbackFps` and the receive work dominates,
implement the Worker **then**, using the same `optical-core.js` lineage:

```
main thread: CameraFrame → bounded handoff (latest-frame) → worker.postMessage({width,height,data})
worker:       PixelFrame → SharedOpticalReceiveCore.processFrame → postMessage({stage, events})
main thread:  setData (batched) + persist checkpoint + write file
```

No algorithm fork. If transfer-copy overhead is unacceptable, evaluate a
downsampled handoff (e.g., hand off a 1280×720 luma/gray pre-normalized buffer)
or a Worker-side `onCameraFrame` if WeChat ever exposes camera frames inside a
Worker (it does not today).
