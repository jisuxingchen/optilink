# TF-012 — Physical Test Plan (64 KiB, Mini Program end-to-end)

**Status:** READY for PO physical action (after exact-head CI green + Technical Review PASS).

## Goal

Computer display → optical image → phone `CameraFrame` → `SharedOpticalReceiveCore`
→ Fountain reconstruction → SHA-256 exact match → local file.

Evidence class on success: `PHYSICAL MINI PROGRAM END-TO-END RECONSTRUCTION`.
This is **NOT G0**. It is **NOT Net Goodput**.

## Sender (PC)

1. One command:
   ```
   cd experiments/tf-002-single-code
   npm run dev:tf012-sender
   ```
2. Open the URL in a browser and go full-screen (F11):
   ```
   http://<PC-LAN-IP>:5318/tiled-physical-v5.html?role=sender&standalone=autonomous&replayEvery=16
   ```
   (or `http://127.0.0.1:5318/...` if the Mini Program preview runs on the same machine)
3. The sender self-cycles forever: orientation 64 → preamble 96 → Manifest ×3 →
   dynamic fountain symbols at 15 Hz. **No manual stepping. No WebSocket payload.**
   The payload is optical-only.

Baseline: `replayEvery = 16` (TEST DEFAULT only, not final product tuning).

## Receiver (WeChat Mini Program)

1. Open `experiments/tf-008-wechat-mini-receiver-poc` in WeChat DevTools.
2. Compile and preview on the phone (or run on the same machine).
3. Tap **Start Camera**, point the rear camera at the full sender display
   (all three tiles + borders in frame).
4. Wait. The phone screen must show, live:
   - buildId (`tf012-r1-<shortsha>`)
   - mode (`receive`)
   - receive stage (IDLE → ORIENTED → PREAMBLE → RECEIVING → complete)
   - file/session
   - processed FPS / skipped / replaced
   - Manifest status
   - solved / total blocks
   - SHA status (MATCH expected)
   - network radio type (should be `none` if airplane mode, for offline evidence)
5. When SHA shows **MATCH**, tap **Freeze Test Result** then **Copy Result** and
   send the JSON back to the PO channel.

## What to send back

- The copied frozen-result JSON (contains buildId, stage, SHA results, metrics,
  device, network type, per-stage timings).
- A screenshot showing the phone screen with buildId + SHA MATCH.
- Confirm whether phone radios were ON or OFF (airplane mode).

## Radios note

If radios are ON, the physical optical reconstruction is valid evidence but is
**NOT** formal offline G0 evidence. Payload still has zero network path.
