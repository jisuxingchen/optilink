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

## Recommended low-touch workflow

Because the tested Codespace showed a GitHub tunnel/edge forwarding failure, the preferred physical-test launcher is now the temporary HTTPS tunnel wrapper:

```bash
cd experiments/tf-002-single-code
npm install
npm test
npm run lab:tunnel
```

The launcher starts the local coordinator, creates a random Lab Token, starts a temporary HTTPS tunnel and prints complete Sender / Receiver URLs.

Open the printed **Sender** URL on the computer and the printed **Receiver** URL on the moto razr 40 ultra. Then:

1. Keep the computer sender page open. No sender-side button is required for the normal auto flow.
2. Fix the phone in place and frame the QR region.
3. On the phone press **Start auto test** once and grant camera permission if requested.
4. The sender automatically sweeps a short calibration matrix for QR payload density and visual update rate.
5. The receiver reports decode/unique/duplicate telemetry through the lab control channel.
6. The coordinator stores the latest structured result in `results/latest.json` and can automatically post it to Issue #9.
7. Press **Stop / finish** on the phone if you want to end early or after calibration.

`npm run lab` remains available for localhost or a working forwarded HTTPS environment.

## Sweep synchronization and data-quality rules

Auto Lab v2 explicitly prevents one sweep from contaminating the next:

1. Sender stops and blanks the QR canvas.
2. Sender waits for the camera to drain stale frames.
3. Sender sends a reset command with a unique reset id.
4. Receiver clears its session state, enters a short flush window and sends `receiver-reset-complete` with the same reset id.
5. Sender waits for that acknowledgement before starting the next optical session.
6. Receiver does not bind a new session id from a data frame; the new session is anchored by its manifest first.

Data frames seen before a manifest are reported separately as `ignoredBeforeManifest` instead of being counted as foreign/invalid session data.

Receiver metadata is captured **on the receiver page** and sent to the sender/coordinator. The result therefore records the receiver page's actual browser user-agent, platform, language and screen information rather than accidentally recording the computer sender's browser.

## Calibration matrix

Auto Lab first uses a 64 KiB deterministic payload and measures unique-symbol yield rather than pretending it is the final file-throughput benchmark.

Stage A explores representative density/size pairs at low update rate. Stage B takes the best density candidate and sweeps visual update rate up to the approved 24 Hz reference point.

The result records, per configuration:

- unique symbols received;
- decoded QR results;
- duplicate results;
- invalid/foreign results;
- pre-manifest ignored results;
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

## Interpretation of the first physical evidence

The first manual screenshots used `README.md` (2,064 bytes), not the 1 MiB generated payload, because a manually selected file overrides the generated payload. Auto Lab always generates its own calibration payload and removes this ambiguity.

The manual screenshots proved that the Browser→QR→moto razr 40 ultra optical path works end-to-end: ECC L completed a 4-chunk transfer with exact SHA-256. The first automated run then proved that one-click receiver-start → automatic parameter sweep → structured telemetry → automatic GitHub Issue publishing works end-to-end.

That first automated run also exposed two data-quality defects which Auto Lab v2 fixes: receiver metadata was assembled on the sender page, and stale frames from the previous sweep could bind or contaminate the next session. Those defects must be considered when interpreting the first automated calibration result; the next run is the first one intended for clean comparison across sweep configurations.
