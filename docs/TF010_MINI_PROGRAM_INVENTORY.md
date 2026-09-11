# TF-010 — Mini Program Inventory (Phase 1)

Issue: #47 · Branch: `spike/tf-010-wechat-shared-receiver` · Stacked on PR #46.

Map of the current WeChat Mini Program receiver
(`experiments/tf-008-wechat-mini-receiver-poc`) before TF-010 changes.

Legend: **A** keep as platform adapter · **B** replace with `SharedOpticalReceiveCore` call · **C** remove duplicate logic · **D** missing.

| # | Concern | Current state | Class |
|---|---|---|---|
| 1 | CameraFrame acquisition | `CameraContext.onCameraFrame` → `onFrame(frame)` (`pages/index/index.js`) | A |
| 2 | PixelFrame conversion | `{width, height, data: new Uint8ClampedArray(buffer)}` | A |
| 3 | Orientation-only runtime path | `processOrientationFrame` → `opticalCore.acquireOrientation` (verdict only) | B |
| 4 | Benchmark path | `processBenchmarkFrame` (luma stat + optional normalization) | A |
| 5 | optical-core bundle loading | `require('../../utils/optical-core.js')` | A |
| 6 | Result serialization | `buildResultPayload` / `buildOrientationResultPayload` | B |
| 7 | File write support | none | D |
| 8 | SHA-256 support | none (only Web Crypto in browser adapters) | D |
| 9 | UI mode/state handling | `setMode` / `onSelectMode` + WXML (orientation / benchmark) | B |
| 10 | Duplicated receive logic | none — orientation already calls the shared core | A |

## Conclusion
The adapter (camera callback, PixelFrame wrap, UI, benchmark) stays. The
orientation-only path (#3) is replaced by the full `SharedOpticalReceiveCore`
state machine; file output (#7) and SHA-256 (#8) are added via
`wx.getFileSystemManager` and the shared `sha256Hex` bundle export. No optical
algorithm is duplicated.
