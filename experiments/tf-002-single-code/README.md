# TF-002 — Single-code optical baseline

Status: **experimental spike**

This directory implements the first executable feasibility harness after Gate G1.

## What it does

The same browser application supports:

- **Auto Benchmark mode** — one phone-side Start automatically generates and transfers a deterministic incompressible 1 MiB payload using the selected TF-002 candidate configuration.
- **Engineering Calibration mode** — retains the 64 KiB automatic parameter sweep for tuning.
- **File / Manual mode** — select a real file or manually generate a payload for functional experiments.
- **Receiver** — Android browser camera decodes, deduplicates, reassembles and verifies SHA-256.
- **Auto Lab coordinator** — relays test control/telemetry only; payload bytes remain on the optical screen→camera path.

The WebSocket control plane is **lab instrumentation only** and must be disabled for official offline acceptance runs.

## Performance-baseline boundary

The owner has now fixed the current sender display at **60 Hz physical refresh rate** for subsequent performance-oriented runs.

This is distinct from the OptiLink **visual-code update rate**. The first 1 MiB stability candidate remains:

- 300 B/frame
- 560 px QR
- 24 Hz OptiLink visual-code update rate
- ECC L

All earlier manual and Auto Lab calibration runs are retained as **functional / engineering evidence only**. They prove the harness, optical path, control plane and tuning logic, but they are not used as the starting performance claim because the physical display refresh condition was not yet frozen and recorded consistently.

From the 60 Hz baseline onward, machine-readable performance results explicitly record both:

- physical display refresh rate;
- OptiLink target visual-code update rate.

## Recommended low-touch workflow

Because the tested Codespace showed a GitHub tunnel/edge forwarding failure, use the temporary HTTPS tunnel wrapper:

```bash
cd experiments/tf-002-single-code
npm install
npm test
npm run lab:tunnel
```

The launcher starts the local coordinator, creates a random Lab Token, starts a temporary HTTPS tunnel and prints complete Sender / Receiver URLs.

Open the printed **Sender** URL on the computer and the printed **Receiver** URL on the moto razr 40 ultra.

### Default 1 MiB benchmark

1. Keep the computer Sender page open.
2. Keep **Auto Lab mode = Benchmark · automatic 1 MiB stability**.
3. The Sender records the current physical display refresh as **60 Hz**.
4. Fix the phone in place and frame the QR region.
5. On the phone press **Start auto test** once and grant camera permission if requested.
6. Do **not** choose/upload a file and do **not** press Generate.
7. The program automatically generates the deterministic 1 MiB incompressible payload, resets the receiver cleanly, starts the optical stream and waits for either verified completion or timeout.
8. On completion, the receiver camera stops automatically. The coordinator stores `results/latest.json` and can post the structured result to Issue #9.

The 1 MiB run uses an 8-minute timeout. A timeout is recorded as evidence rather than silently discarded.

### Engineering calibration

Select **Engineering · 64 KiB calibration sweep** only when new tuning evidence is required. This mode automatically explores payload density / QR size / visual update rate and is not the default performance run.

### File mode

The manual Sender controls remain available for real-file functional tests. A manually selected file overrides generated manual payloads, but manual File mode is not automatically classified as benchmark evidence.

## Sweep synchronization and data-quality rules

Auto Lab prevents one measurement from contaminating the next:

1. Sender stops and blanks the QR canvas.
2. Sender waits for camera stale-frame drain.
3. Sender sends a reset command with a unique reset id.
4. Receiver clears session state, enters a short flush window and sends `receiver-reset-complete` with the same reset id.
5. Sender waits for that acknowledgement before starting the next optical session.
6. Receiver anchors the new session on the manifest rather than on an arbitrary data frame.

Data frames seen before a manifest are reported separately as `ignoredBeforeManifest` instead of foreign/invalid session data.

Receiver metadata is captured on the **receiver page**. Sender metadata records the owner-configured physical display refresh rate and sender browser/screen information.

## 1 MiB stability result fields

The benchmark result records at least:

- evidence class (`performance-baseline`);
- physical display refresh rate;
- target OptiLink visual update rate;
- payload SHA-256 and deterministic seed;
- payload bytes and QR configuration;
- unique / total chunks and completion ratio;
- decoded / duplicate / invalid / pre-manifest counts;
- SHA-256 result;
- receiver-reported goodput;
- sender-observed elapsed time;
- conservative lab end-to-end goodput;
- PASS / HASH_MISMATCH / TIMEOUT / ABORTED status.

The lab end-to-end measurement begins at Sender optical-stream start and ends when completion telemetry reaches the Sender. It therefore includes a small control-plane completion latency and is intentionally conservative. Official offline acceptance remains a separate stage.

## Measurement rule

Sender raw bitrate is diagnostic only. The product benchmark remains:

```text
net_goodput = verified_original_file_bytes / elapsed_end_to_end_seconds
```

A valid headline run requires exact final SHA-256 reconstruction according to `docs/BENCHMARK_SPEC.md`.

The cyclic single-code sequence remains deliberately temporary. Fountain/rateless recovery is still the approved leading candidate for one-way loss recovery, and TF-003 multi-code remains the next carrier-scaling path if the single-code baseline is clearly below target.
