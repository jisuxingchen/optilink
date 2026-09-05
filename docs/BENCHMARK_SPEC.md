# Optical Throughput Benchmark Specification

Status: **Approved at Gate G1 — baseline frozen for TF-002**

Issue: `TF-001` (#2, completed)

This document defines how OptiLink measures optical transfer performance. Its purpose is to prevent cherry-picking and post-hoc changes to the success criteria.

## 1. Primary question

Can OptiLink independently achieve the G0 engineering target of:

> **≥100 KB/s net goodput** for a real screen→camera file transfer, while reconstructing the original file exactly?

Public third-party results may inform feasibility, but they do not count as OptiLink evidence.

## 2. Primary metric

**Net goodput**

```text
net_goodput = verified_original_file_bytes / elapsed_transfer_seconds
```

Only bytes from the final, correctly reconstructed original file count.

The following do **not** count as useful payload:

- QR/barcode framing overhead
- frame headers
- duplicated frames
- parity/FEC/fountain overhead
- compression gain in the primary headline test
- frames that decode but do not contribute new information
- unrecovered or corrupted payload

Units must be reported explicitly as KB/s (decimal) and KiB/s (binary) when publishing results.

## 3. Correctness gate

A run is valid only if:

1. the receiver reports completion;
2. reconstructed file length equals the source file length;
3. SHA-256 of the received file exactly equals SHA-256 of the source file.

If any condition fails, the run is recorded as **FAILED**, not as a slow successful transfer.

## 4. Primary benchmark payload

The headline benchmark uses deterministic pseudorandom/incompressible binary data so compression cannot manufacture a better speed number.

Required payload sizes:

- **1 MiB** — iteration / quick test
- **10 MiB** — primary G0 benchmark
- **100 MiB** — endurance / thermal / memory test after the 10 MiB case is stable

The payload generator seed must be recorded so the test can be reproduced.

Compression is **disabled** for the primary headline result.

## 5. Timing definition

Elapsed time starts when the sender displays the first transfer frame belonging to the measured session.

Elapsed time ends when the receiver:

1. has enough information to reconstruct the full file;
2. finishes reconstruction;
3. verifies final SHA-256 successfully.

This intentionally includes receiver-side completion work. A separate optical-acquisition metric may be reported, but it must not replace end-to-end net goodput.

For the network-assisted Auto Lab only, a sender-observed timing may be recorded from optical-stream start until verified receiver-completion telemetry reaches the sender. This measurement is conservative because it includes the control-plane completion latency and **does not replace** the later official offline benchmark.

## 6. Minimum repeated-run method

For each benchmark configuration:

- run at least **5 valid attempts**;
- report every failed attempt;
- report median goodput as the primary result;
- also report minimum, maximum, p10/p90 when sample count permits;
- do not use the single fastest run as the headline claim.

If fewer than 5/5 runs complete correctly under the baseline condition, the configuration cannot be called stable.

## 7. Test environment record

Every run group records:

### Sender
- device make/model when known
- OS/version
- browser/app/version
- physical display resolution
- display scaling
- physical display refresh rate
- target visual-code update rate
- brightness setting
- fullscreen/windowed state
- render window dimensions
- code pixel dimensions
- QR version / module count when fixed
- approximate module pixels where applicable

### Receiver
- device make/model
- OS/version
- browser/app/version
- camera API/path
- requested and actual camera resolution
- requested and actual FPS if available
- autofocus state
- exposure state / lock if used
- digital zoom if any

### Geometry
- screen-to-camera distance
- viewing angle
- approximate framing percentage in camera view

### Environment
- indoor/controlled/bright condition
- measured lux if available
- obvious reflections/glare
- screen PWM/flicker observations if relevant

### Software/configuration
- OptiLink commit SHA
- carrier/code type
- code count per displayed frame
- payload bytes per code/frame
- visual ECC level
- transport/FEC configuration
- target visual update rate
- actual unique useful frames/s if measurable

## 8. Frozen TF-002 baseline

Approved at G1:

- **receiver:** Motorola moto razr 40 ultra
- **sender:** ordinary computer display; exact make/model is not required for the first iteration
- **initial target visual-code update rate:** **24 Hz**
- screen brightness: start at 100% unless glare makes decoding materially worse; any change must be recorded
- camera approximately perpendicular to screen
- initial distance: 40–50 cm
- normal indoor lighting with no direct glare
- sender uses a dedicated large display window / fullscreen when practical
- fixed/steady receiver baseline before handheld robustness testing

Current physical sender condition for performance-oriented TF-002 runs, owner-confirmed on 2026-09-05:

- **physical display refresh rate: 60 Hz**
- **OptiLink visual-code update target: 24 Hz**
- these are separate quantities and must both be recorded in every result
- earlier manual and Auto Lab rounds before this physical-refresh condition was frozen are classified as **functional / engineering evidence**, not the starting performance dataset

The following are deliberate experiment variables and must be exposed by the harness rather than hidden constants:

- visual-code update rate (24 Hz baseline; later values allowed)
- code render size in pixels
- QR/code density / module size
- payload bytes per code
- QR version and ECC where applicable
- display/window dimensions

The actual physical display resolution and refresh rate are recorded at test time. The 24 Hz value is the **OptiLink visual update target**, not an assumption about the monitor's hardware refresh rate.

## 9. Carrier experiment matrix

| ID | Configuration | Purpose |
|---|---|---|
| B0 | Single standard QR, 24 Hz target | simplest frozen TF-002 reference point |
| B1 | Single standard QR, higher stable visual update rate | determine single-code timing ceiling |
| B2 | Multiple standard codes, 24 Hz target | TF-003 density scaling |
| B3 | Multiple codes, higher stable rate | attempt G0 target with standard codes |
| B4 | Custom dense optical code, only if justified | later optimization only |

The benchmark records **actual decoded/useful frame rate** rather than assuming display refresh equals camera decode rate.

## 10. Required intermediate metrics

At minimum capture:

- displayed frame count
- camera frames processed when available
- successfully decoded code count
- unique transport symbols accepted
- duplicate symbols
- decode failures
- symbols required for reconstruction
- total optical bytes emitted
- total useful original bytes
- reconstruction time
- hash verification time
- CPU load / thermal warning if available

Derived metrics:

- visual decode success rate
- unique-symbol yield
- transport overhead ratio
- FEC/fountain recovery overhead
- end-to-end net goodput

## 11. Robustness matrix

After the baseline reaches stable correctness, test degradation separately.

### Distance
- 30 cm
- 50 cm
- 80 cm

### Angle
- 0°
- 15°
- 30°

### Lighting
- normal indoor
- bright indoor / glare-prone
- lower-light indoor

### Motion
- fixed receiver
- normal handheld receiver

These tests do not redefine the primary baseline result.

## 12. Offline/no-network verification

At least one acceptance run demonstrates:

- no USB data connection between sender and receiver;
- receiver Wi-Fi and Bluetooth disabled;
- receiver mobile data disabled or airplane mode used while camera remains available;
- no application network request is required for payload transfer;
- if a web application was previously loaded from a network, the actual payload transfer does not use that network path.

## 13. G0 success criteria

### Required
- 10 MiB incompressible payload
- 5/5 correct runs under frozen baseline conditions
- exact SHA-256 match for every successful run
- median **≥100 KB/s net goodput**
- no hidden network data path during optical transfer

### Stretch goals
- p10 ≥100 KB/s
- stable handheld operation
- 100 MiB endurance success
- meaningful tolerance to dropped/blurred frames without restart

## 14. Failure classification

Failures are labeled rather than discarded:

- `CAPTURE_FAILURE`
- `DECODE_FAILURE`
- `DUPLICATE_STALL`
- `INSUFFICIENT_SYMBOLS`
- `REASSEMBLY_FAILURE`
- `HASH_MISMATCH`
- `RECEIVER_CRASH`
- `SENDER_STALL`
- `THERMAL_THROTTLE`
- `USER_ALIGNMENT_FAILURE`
- `OTHER`

## 15. Evidence package

```text
experiments/benchmark/<date>-<device-pair>/
├── README.md
├── environment.json
├── results.csv
├── source-hash.txt
├── receiver-logs/
└── screenshots-or-recordings/
```

Only non-sensitive test artifacts are committed to the public repository.

CI can validate file format and synthetic/protocol tests, but **GitHub Actions cannot replace the physical screen→camera benchmark**.

## 16. G1 decisions now in force

G1 approved:

1. Browser / TypeScript sender first.
2. Android browser receiver first; Kotlin + CameraX is an evidence-driven escalation path.
3. Single standard QR/code is the first carrier baseline.
4. SHA-256 is mandatory final integrity evidence.
5. Fountain / rateless erasure coding is the leading one-way recovery candidate.
6. Permissive commodity libraries may be reused after provenance/license review; third-party optical transport implementations are not copied wholesale.
7. The first physical receiver is moto razr 40 ultra.
8. TF-002 starts at a 24 Hz visual-code update target with adjustable code size/density and later rate variants.

Durable rationale is recorded in `docs/adr/ADR-0002-g1-initial-technical-path.md`.
