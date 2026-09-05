# TF-002 / TF-003 Optical Transport Experiments

This directory contains isolated browser experiments used to establish OptiLink's physical screen-to-camera baseline. They are intentionally kept separate from production architecture.

## Evidence boundary

- Payload bytes travel only through the optical path: sender display -> camera -> receiver browser.
- The WebSocket/Cloudflare tunnel is lab control and telemetry only.
- Network-assisted Auto Lab runs are engineering/performance experiments, not official offline acceptance.
- Official acceptance still disables Wi-Fi/Bluetooth/mobile data and verifies exact reconstruction by SHA-256.

## Baseline history

1. Single-code cyclic transport established exact optical transfer but suffered severe long-tail duplicate waste.
2. 1 MiB cyclic benchmark on the 60 Hz display timed out at 92.02% after 480 s.
3. TF-002B replaced cyclic retransmission with LT-style Fountain / rateless recovery.
4. First valid Fountain physical run completed 1 MiB with SHA-256 PASS in 436.235 s at about 2.4 KB/s verified goodput.
5. The single-QR gross ceiling at 300 B x 24 Hz is only 7.2 KB/s, so TF-003 now measures spatial parallelism before a custom carrier is justified.

## Launchers

### Single-code baseline

```bash
npm run lab:tunnel
```

### Single-QR Fountain

```bash
npm run lab:tunnel:fountain
```

### TF-003 4QR + Fountain

```bash
npm run lab:tunnel:4qr
```

The launcher stops stale OptiLink lab/tunnel processes, chooses a mode-specific free port, verifies the exact HTML entry before opening the tunnel, and prints fresh Sender/Receiver URLs protected by a random token.

## TF-003 4QR design

The first multi-code experiment deliberately changes only the spatial carrier while keeping the recovery layer and benchmark baseline comparable:

- physical display: 60 Hz
- optical visual update target: 24 Hz
- layout: fixed 2x2 known grid
- regions: 4 standard black/white QR codes
- source symbol payload: 300 B each
- QR render size: 480 px each
- ECC: L
- payload: 1 MiB deterministic incompressible
- outer recovery: LT-style Fountain / rateless XOR with peeling decoder
- final correctness: SHA-256
- timeout: 6 minutes
- theoretical gross payload ceiling: 4 x 300 x 24 = 28,800 B/s

The receiver does not depend on arbitrary whole-frame multi-barcode discovery. It captures the camera stream, takes a centered square region of interest, divides it into four known quadrants, and runs QR decode on each crop. Telemetry records total accepted symbols, scan rounds per second, and per-region decoded/accepted counts so we can see whether browser CPU/camera decode scales with spatial parallelism.

### Physical workflow

1. Run `npm run lab:tunnel:4qr`.
2. Open the freshly printed Sender URL on the 60 Hz computer display.
3. Open the freshly printed Receiver URL on the moto razr 40 ultra.
4. Position the phone so the sender's 2x2 QR square is centered inside the receiver's square reticle.
5. Tap **Start 4QR benchmark** once.
6. Do not upload a file or press Generate. The 1 MiB benchmark is generated automatically.
7. Leave the phone fixed until PASS/TIMEOUT; the camera stops automatically.
8. The machine-readable result is persisted and posted to Issue #10.

The alignment step is the only additional physical requirement versus single QR. If the first run shows a large imbalance between R1-R4, treat that as ROI/alignment evidence before changing transport parameters.

## Decision rule after 4QR

4QR is a scaling experiment, not an assumption that standard QR is the final carrier. Compare verified goodput and accepted-symbol rate against the single-QR Fountain result. If 4QR scaling is materially sub-linear, investigate receiver decode scheduling/ROI once, then move toward 9QR or a custom dense carrier rather than repeatedly micro-tuning one standard QR.
