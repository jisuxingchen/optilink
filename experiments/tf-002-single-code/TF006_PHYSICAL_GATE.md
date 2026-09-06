# TF-006 — Physical OptiGrid v1 Projective Sweep

## Purpose

Move the TF-005 pixel-domain OptiGrid v1 evidence onto the real screen → camera path without asking the owner to manually tune carrier parameters.

This gate is **not** official offline acceptance and does **not** establish product Net Goodput. It is a short network-assisted physical carrier experiment used to select a stable real-camera operating point.

## Evidence that triggered v2

Two consecutive physical runs of the first TF-006 implementation at 60 Hz produced zero CRC-valid payload frames for both 160×160 and 240×240.

The failures were still diagnostic:

- camera video was 1080×1920 at reported 60 fps;
- observed contrast was high (roughly 60–72 on frames that reached a lock);
- the old axis-aligned receiver occasionally reached a reserved/finder score around 72–73%;
- several frames reached payload decode and then failed CRC;
- no silent payload corruption was accepted.

The v1 physical receiver only searched an axis-aligned central square (scale/X/Y). That was too weak for real screen-camera rotation/perspective. The first sender also changed the carrier on every display RAF, so there was no true lower-rate temporal control.

## v2 automatic sweep

The owner still performs no manual parameter tuning. One run now tests:

| Matrix | Payload/frame | Target update | Gross payload ceiling |
|---|---:|---:|---:|
| 120×120 | 1236 B | 20 Hz | 24.72 KB/s |
| 120×120 | 1236 B | 30 Hz | 37.08 KB/s |
| 160×160 | 2436 B | 20 Hz | 48.72 KB/s |
| 160×160 | 2436 B | 30 Hz | 73.08 KB/s |
| 240×240 | 6036 B | 20 Hz | 120.72 KB/s |
| 240×240 | 6036 B | 30 Hz | 181.08 KB/s |

This deliberately stops using 60 optical updates/s for the next diagnostic gate. A 240×240 carrier at 20 Hz still has >100 KB/s gross capacity while each optical symbol is held for roughly three 60 Hz display refreshes.

## Receiver pipeline

1. Camera input is cropped to the same central square represented by the phone preview.
2. A coarse scale/X/Y search creates an initial square seed using OptiGrid v1 reserved/finder cells derived only from camera pixels.
3. The four corners are independently refined by coordinate descent.
4. A homography maps normalized OptiGrid cell coordinates into the real camera quadrilateral.
5. Tracking reuses the receiver-derived quadrilateral and validates pilot score/contrast each scanned camera frame.
6. If tracking fails, the receiver reacquires and refines geometry; it never receives sender geometry state.
7. Fast decode uses projective subpixel bilinear 5-point majority sampling for every cell, followed by OptiGrid v1 header/CRC validation.
8. A deterministic receiver-side oracle checks decoded payload bytes only after optical decode. No payload bytes are supplied over WebSocket.

The geometry lock is retained across candidate changes. Before each measured candidate, the sender displays a static carrier for a short warm-up so the receiver can lock before counters are reset.

## Sender timing

The sender now rate-limits **actual carrier changes** to the candidate target rate instead of merely recording a target-Hz field while changing every display RAF.

This is important for rolling-shutter and asynchronous display/camera phase behavior. At 20 Hz the same optical symbol remains visible for about three 60 Hz display refreshes; at 30 Hz it remains visible for about two.

## One-click workflow

Run `npm run lab:tunnel:tf006` from `experiments/tf-002-single-code`.

The launcher prints fresh Sender and Receiver URLs. The owner opens Sender on the computer and Receiver on the phone, taps **Start TF-006 physical sweep** once, aligns the complete carrier inside the green square during the six-second preflight, and then leaves the phone fixed.

The harness automatically:

- starts/stops the camera;
- runs the six density/rate candidates listed above;
- performs static warm-up before each measured candidate;
- collects acquisition, projective tracking, decode, CRC/reject, unique-frame and raw-ingress metrics;
- selects the best physical candidate with a validity penalty;
- saves a machine-readable result;
- publishes the result to Issue #23 when GitHub publication is enabled.

## Decision rule

The next step is based on real evidence, not gross bitrate alone:

- If one candidate achieves stable CRC-valid decoding and useful raw ingress, use that operating point for the 1 MiB Fountain + SHA-256 physical transfer gate.
- If lower-rate candidates work but high-density candidates fail, optimize density/sampling before file transfer.
- If even 120×120 @20 Hz cannot produce stable CRC-valid frames, stop throughput tuning and redesign physical fiducials / synchronization before asking the owner for more repeated tests.

## Evidence boundary

WebSocket / Cloudflare Tunnel is allowed only for lab control and telemetry. Optical frame payload bytes remain screen → camera. The resulting metric is **raw unique optical ingress**, not reconstructed file Net Goodput.

The later official acceptance remains: 10 MiB incompressible payload, 5/5 exact success, final SHA-256, frozen physical setup, and phone Wi‑Fi/Bluetooth/mobile data disabled during the actual transfer.
