# Optical Throughput Benchmark Specification

Status: **Draft for Gate G1 review**

Issue: `TF-001` (#2)

This document defines how OptiLink will measure optical transfer performance before implementation begins. Its purpose is to prevent cherry-picking and post-hoc changes to the success criteria.

## 1. Primary question

Can OptiLink independently achieve the G0 engineering target of:

> **≥100 KB/s net goodput** for a real screen→camera file transfer, while reconstructing the original file exactly?

Public third-party results may inform feasibility, but they do not count as OptiLink evidence.

## 2. Primary metric

**Net goodput**

```
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

The headline benchmark must use a deterministic pseudorandom/incompressible binary payload so compression cannot manufacture a better speed number.

Required payload sizes:

- **1 MiB** — iteration / quick test
- **10 MiB** — primary G0 benchmark
- **100 MiB** — endurance / thermal / memory test after the 10 MiB case is stable

The payload generator seed must be recorded so the test can be reproduced.

Compression must be **disabled** for the primary headline result.

Secondary tests may include compressible logs/text and representative industrial data, but results must be labeled separately.

## 5. Timing definition

Elapsed time starts when the sender displays the first transfer frame that belongs to the measured session.

Elapsed time ends when the receiver:

1. has enough information to reconstruct the full file;
2. finishes reconstruction;
3. verifies the final SHA-256 successfully.

This intentionally includes receiver-side completion work. A separate metric may report optical acquisition time, but it must not replace end-to-end net goodput.

## 6. Minimum repeated-run method

For each benchmark configuration:

- run at least **5 valid attempts**;
- report every failed attempt;
- report median goodput as the primary result;
- also report minimum, maximum, p10/p90 when sample count permits;
- do not use the single fastest run as the headline claim.

If fewer than 5/5 runs complete correctly under the baseline condition, the configuration cannot be called stable.

## 7. Test environment record

Every run group must record:

### Sender
- device make/model
- OS/version
- browser/app/version
- physical display resolution
- display scaling
- refresh rate
- brightness setting
- fullscreen/windowed state
- code/grid physical size or pixel dimensions

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
- viewing angle (horizontal/vertical or defined test fixture)
- approximate framing percentage in camera view

### Environment
- indoor/controlled/bright condition
- measured lux if a meter is available
- obvious reflections/glare
- screen PWM/flicker observations if relevant

### Software/configuration
- OptiLink commit SHA
- carrier/code type
- code count per displayed frame
- payload bytes per code/frame
- visual ECC level
- transport/FEC configuration
- target sender FPS
- actual unique useful frames/s if measurable

## 8. Baseline geometry proposed for G1

The following is a **candidate**, not yet frozen:

- laptop/desktop display → Android phone
- screen brightness: 100%
- camera perpendicular to screen
- distance: 40–50 cm
- normal indoor lighting with no direct glare
- sender fullscreen
- handheld is allowed only after a fixed/steady baseline is established

G1 must approve the actual baseline device pair and conditions.

## 9. Carrier experiment matrix

Carrier choice remains open until G1, but the measurement sequence should support at least:

| ID | Configuration | Purpose |
|---|---|---|
| B0 | Single standard QR, baseline FPS | simplest reference point |
| B1 | Single standard QR, highest stable FPS | determine frame-rate ceiling |
| B2 | Multiple QR/codes per display frame, baseline FPS | test density scaling |
| B3 | Multiple QR/codes, highest stable FPS | attempt G0 target |
| B4 | Custom dense optical code, if justified | later optimization only |

The benchmark must record **actual decoded/useful frame rate** rather than assuming display refresh equals camera decode rate.

## 10. Required intermediate metrics

At minimum capture:

- displayed frame count
- camera frames processed (when available)
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

After the baseline reaches stable correctness, test degradation separately:

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

These tests are not allowed to redefine the primary baseline result.

## 12. Offline/no-network verification

Because G0 requires an offline transfer session, at least one acceptance run must demonstrate:

- no USB data connection between sender and receiver;
- receiver Wi-Fi and Bluetooth disabled;
- receiver mobile data disabled or device in airplane mode with camera still available;
- no application network request is required for payload transfer;
- if the web sender was previously loaded from a network, it must still complete the actual transfer without using that network path.

Longer term, a packaged/self-hosted/PWA deployment may be tested separately.

## 13. G0 success criteria

### Required
- 10 MiB incompressible payload
- 5/5 correct runs under frozen baseline conditions
- exact SHA-256 match for every successful run
- median **≥100 KB/s net goodput**
- no hidden network data path during the optical transfer

### Stretch goals
- p10 ≥100 KB/s
- stable handheld operation
- 100 MiB endurance success
- meaningful tolerance to dropped/blurred frames without restart

## 14. Failure classification

Failures must be labeled rather than discarded:

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

Each benchmark release should preserve:

```
experiments/benchmark/<date>-<device-pair>/
├── README.md
├── environment.json
├── results.csv
├── source-hash.txt
├── receiver-logs/
└── screenshots-or-recordings/
```

Only non-sensitive test artifacts should be committed to the public repository.

CI can validate file format and synthetic/protocol tests, but **GitHub Actions cannot replace the physical screen→camera benchmark**.

## 16. Decisions required at G1

Before implementing the physical benchmark harness, owner review must freeze:

1. first sender platform;
2. first receiver platform;
3. baseline device pair available for testing;
4. first carrier family;
5. minimum integrity method;
6. first loss-recovery strategy;
7. whether third-party open-source components are used, referenced, or avoided;
8. baseline camera/display conditions.
