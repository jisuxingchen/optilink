# OptiGrid v0 — Dense Monochrome Optical Carrier

Status: **experimental / TF-004**

OptiGrid v0 is a project-owned screen→camera carrier designed for controlled OptiLink experiments. It is deliberately not a general-purpose barcode and does not replace the OLTP/Fountain recovery layer.

## Why it exists

Measured standard-QR results established a carrier-scaling problem:

- single QR + Fountain: 1 MiB SHA-256 PASS at 2403.70 B/s;
- native 4QR + Fountain: 1 MiB SHA-256 PASS at 3618.15 B/s;
- 4× displayed QR capacity produced only ~1.51× verified goodput.

OptiGrid therefore removes generic QR discovery/encoding overhead and tests direct optical cell sampling.

## v0 frame

A frame is one square black/white matrix.

Reserved structure:

- two outer black/white border rings;
- four distinct 4×4 corner pilot patterns;
- remaining interior cells carry frame bytes directly, one bit per cell.

Binary frame bytes:

| Field | Size | Purpose |
| --- | ---: | --- |
| Magic | 2 B | ASCII `OG` |
| Version | 1 B | v0 = 0 |
| Matrix size | 1 B | cells per side |
| Sequence | 4 B | monotonically changing optical frame id |
| Payload length | 2 B | number of payload bytes in this frame |
| Payload | variable | direct binary optical payload |
| CRC32 | 4 B | integrity over header + payload |

No Base64 is used in OptiGrid frames.

## Receiver v0

The receiver uses the known central square camera ROI rather than barcode discovery:

1. crop a fixed central square;
2. rescale to a fixed sampling density per cell;
3. sample known reserved black/white cells to estimate luminance threshold;
4. sample all cells;
5. reject frames with insufficient contrast or poor reserved/pilot match;
6. parse the binary header and verify CRC32;
7. during calibration, independently regenerate the expected deterministic payload from the decoded sequence and compare it byte-for-byte.

Bad frames are discarded. The future Fountain layer handles frame erasures.

## First carrier calibration

Fixed comparison conditions:

- physical display: 60 Hz;
- optical update target: 24 Hz;
- receiver: moto razr 40 ultra;
- sender render square: 960×960 px;
- matrix candidates: 64, 80, 96, 120, 160 cells;
- approximately 7 seconds per candidate.

The Auto Lab records per candidate:

- valid and unique frames/s;
- raw unique optical payload bytes/s;
- duplicates;
- alignment/pilot rejects;
- CRC/header rejects;
- deterministic-payload mismatches;
- average and p95 decode CPU time;
- contrast and reserved/pilot score;
- sender actual render rate.

The winner is selected by **measured unique optical payload bytes/s**, not by theoretical capacity.

`uniquePayloadBytesPerSecond` is a carrier-calibration diagnostic, not verified Net Goodput. A transport performance claim requires Fountain integration, complete reconstruction, and final SHA-256.

## Lab boundary

Quick Tunnel / WebSocket may carry commands, configuration and telemetry only. Optical frame payload bytes remain screen→camera. Official offline acceptance is a later test with the control network disabled.

## Next step after calibration

Select one physically stable matrix density, place Fountain symbols inside OptiGrid payloads, run a deterministic incompressible 1 MiB transfer, and require SHA-256 PASS before comparing verified goodput with the 4QR baseline.
