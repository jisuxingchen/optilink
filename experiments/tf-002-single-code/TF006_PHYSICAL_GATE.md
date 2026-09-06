# TF-006 — Physical OptiGrid v1 High-Density Gate

## Purpose

Move the two TF-005 pixel-domain winners onto the real screen → camera path without asking the owner to manually tune carrier parameters.

This gate is **not** official offline acceptance and does **not** establish product Net Goodput. It is a short network-assisted physical carrier experiment used to select the next real-camera operating point.

## Frozen candidates

| Candidate | Matrix | Payload/frame | Sender raster | Target update | TF-005 rationale |
|---|---:|---:|---:|---:|---|
| Conservative | 160×160 | 2436 B | 960×960 | 60 Hz | 48/48 clean, mild and stress; larger cells; lower decode cost |
| High-capacity | 240×240 | 6036 B | 960×960 | 60 Hz | 48/48 clean, mild and stress; much larger payload/frame; higher decode cost |

200×200 is intentionally excluded because its long stress soak exposed a strong failure mode despite shorter sweeps looking healthy.

## Receiver pipeline

1. Camera acquisition uses the central square image seen by the square preview.
2. Geometry acquisition searches scale and X/Y offset using OptiGrid v1 reserved/finder cells derived only from camera pixels.
3. Tracking reuses that receiver-derived lock and validates pilot score/contrast each scanned camera frame.
4. If tracking falls below threshold, the receiver reacquires geometry; it never receives sender geometry state.
5. Fast decode uses subpixel bilinear 5-point majority sampling for every cell, then OptiGrid v1 header/CRC validation.
6. A deterministic receiver-side oracle checks decoded payload bytes after optical decode. No payload bytes are supplied over WebSocket.

The first physical implementation deliberately keeps the geometry model axis-aligned because the owner is given a square reticle and a six-second perpendicular-alignment preflight. If real evidence shows perspective/rotation is the limiting factor, the next correction should extend the receiver geometry model rather than manually tune per-device parameters.

## One-click workflow

Run `npm run lab:tunnel:tf006` from `experiments/tf-002-single-code`.

The launcher prints fresh Sender and Receiver URLs. The owner opens Sender on the computer and Receiver on the phone, taps **Start TF-006 physical gate** once, aligns the complete carrier inside the green square during the six-second preflight, and then leaves the phone fixed.

The harness automatically:

- starts/stops the camera;
- runs 160×160 and 240×240 for 10 seconds each;
- collects acquisition, tracking, decode, CRC/reject, unique-frame and raw-ingress metrics;
- selects the better physical candidate with a validity penalty;
- saves a machine-readable result;
- publishes the result to Issue #23 when GitHub publication is enabled.

## Evidence boundary

WebSocket / Cloudflare Tunnel is allowed only for lab control and telemetry. Optical frame payload bytes remain screen → camera. The resulting metric is **raw unique optical ingress**, not reconstructed file Net Goodput.

The later official acceptance remains: 10 MiB incompressible payload, 5/5 exact success, final SHA-256, frozen physical setup, and phone Wi‑Fi/Bluetooth/mobile data disabled during the actual transfer.
