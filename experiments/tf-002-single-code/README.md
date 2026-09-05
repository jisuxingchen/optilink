# TF-002 — Single-code optical baseline

Status: **experimental spike**

This directory implements the first executable feasibility harness after Gate G1.

## What it does

A single static web application contains two roles:

- **Sender** — select or generate bytes, split them into deterministic chunks, render a sequence of standard QR codes on a computer display.
- **Receiver** — use an Android browser camera to decode the QR stream, reject duplicate/corrupted chunks, reassemble the original bytes and verify SHA-256.

The first baseline is:

- receiver: Motorola moto razr 40 ultra;
- sender: ordinary computer display;
- target visual update rate: 24 Hz;
- adjustable QR render size and payload/chunk;
- standard QR only.

This is intentionally **not** the final one-way recovery design. Simple cyclic chunk sequencing is used first to expose visual/decode bottlenecks. Fountain/rateless recovery remains the approved leading candidate for the next transport-recovery step.

## Local / Codespaces run

```bash
cd experiments/tf-002-single-code
npm install
npm test
npm run dev
```

Open the forwarded Vite port on the sender computer. To use the phone camera, open the receiver page through a secure HTTPS origin (for example a GitHub Codespaces forwarded HTTPS URL or a later GitHub Pages preview). Browser camera APIs are normally restricted on insecure non-localhost HTTP origins.

## First test sequence

1. Generate **1 MiB quick test**.
2. Keep the initial controls at approximately:
   - 24 Hz target visual update rate;
   - 600 bytes payload per data QR;
   - 640 px QR render size;
   - ECC M.
3. Start the sender stream.
4. On the moto razr 40 ultra, open the same app and start the camera.
5. Hold/fix the phone roughly perpendicular to the display at ~40–50 cm.
6. Watch unique-chunk yield, duplicates and final SHA-256 result.
7. Increase payload/frame and QR size deliberately; record each configuration rather than tuning invisibly.
8. Only after stable 1 MiB transfers move to the 10 MiB / 5-run benchmark.

## Important measurement rule

The sender displays a **raw payload ceiling** only for diagnostics. It is not a benchmark result.

The authoritative result is calculated on the receiver after reconstruction and successful SHA-256 verification:

```text
net_goodput = verified_original_file_bytes / elapsed_end_to_end_seconds
```

## Expected limitation of this first spike

At 24 Hz, a single standard QR has a finite payload ceiling even before camera/decode losses. TF-002 therefore establishes a truthful baseline. If the target cannot be reached with one code, the evidence feeds TF-003 rather than changing G0 acceptance.
