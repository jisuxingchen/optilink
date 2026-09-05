# TF-002 — Single-code optical baseline

Status: **experimental spike**

This directory implements the first executable feasibility harness after Gate G1.

## What it does

The same browser application supports:

- **Sender** — generate/select bytes, chunk them, render sequential standard QR codes on the computer display.
- **Receiver** — use the Android browser camera to decode, deduplicate, reassemble and verify SHA-256.
- **Auto Lab coordinator** — relay only test control/telemetry between sender and receiver so parameter sweeps can run with almost no manual interaction.

The optical file payload remains screen→camera. The WebSocket control plane is **lab instrumentation only** and must be disabled for official offline acceptance runs.

## First physical baseline

- receiver: Motorola moto razr 40 ultra;
- sender: ordinary computer display;
- first reference visual update rate: 24 Hz;
- QR size, payload/frame and update rate are adjustable;
- standard QR only.

The cyclic single-code sequence is deliberately temporary. Fountain/rateless recovery remains the approved leading candidate for later one-way loss recovery.

## Recommended Codespaces workflow — low-touch Auto Lab

Run:

```bash
cd experiments/tf-002-single-code
npm install
npm test
npm run lab
```

Use the forwarded HTTPS port 5173.

Open on the computer:

```text
<forwarded-url>/?role=sender
```

Open on the moto razr 40 ultra:

```text
<forwarded-url>/?role=receiver
```

Then:

1. Keep the computer sender page open. No sender-side button is required for the normal auto flow.
2. Fix the phone in place and frame the QR region.
3. On the phone press **Start auto test** once and grant camera permission if requested.
4. The sender automatically sweeps a short calibration matrix for QR payload density and visual update rate.
5. The receiver reports decode/unique/duplicate telemetry through the lab control channel.
6. The coordinator stores the latest structured result in `results/latest.json` and exposes it at `/api/lab/latest`.
7. Press **Stop / finish** on the phone if you want to end early or after calibration.

If the Codespace has authenticated GitHub CLI access, optional automatic posting to Issue #9 can be enabled when starting the coordinator:

```bash
OPTILINK_PUBLISH_GITHUB=1 npm run lab
```

If GitHub publishing is unavailable, the local `results/latest.json` remains the fallback evidence.

## Calibration matrix

Auto Lab first uses a 64 KiB deterministic payload and measures unique-symbol yield rather than pretending it is the final file-throughput benchmark.

Stage A explores representative density/size pairs at low update rate. Stage B takes the best density candidate and sweeps visual update rate up to the approved 24 Hz reference point.

The result records, per configuration:

- unique symbols received;
- decoded QR results;
- duplicate results;
- invalid results;
- unique symbols/second;
- decoded results/second;
- duplicate ratio.

The best calibration candidate is selected by unique-symbol rate. That candidate is then used for the next 1 MiB stability test.

## Important measurement rule

Sender raw bitrate is diagnostic only. The authoritative product benchmark remains:

```text
net_goodput = verified_original_file_bytes / elapsed_end_to_end_seconds
```

A valid headline run requires exact final SHA-256 reconstruction according to `docs/BENCHMARK_SPEC.md`.

## Interpretation of the first manual screenshots

The first user-run screenshots used `README.md` (2,064 bytes), not the 1 MiB generated payload, because a manually selected file overrides the generated payload. Auto Lab now always generates its own calibration payload and removes this ambiguity.

The screenshots nevertheless proved that the Browser→QR→moto razr 40 ultra optical path works end-to-end: ECC L completed a 4-chunk transfer with exact SHA-256, while M/Q/H examples stalled at 50–75% in the observed runs. The large duplicate counts also show that blind 24 Hz cyclic rendering is poorly matched to the receiver's useful decode rate. Auto Lab is specifically designed to measure and tune that mismatch automatically.
