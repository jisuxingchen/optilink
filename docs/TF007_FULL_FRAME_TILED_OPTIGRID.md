# TF-007 — Full-frame tiled OptiGrid carrier gate

## Objective

Increase optical carrier capacity without immediately pushing a single OptiGrid square past the physical spatial-resolution cliff seen in TF-006B.

The next desktop bench uses the full simulated 1920×1080 camera frame and multiple independently decodable OptiGrid tiles. Receiver input remains pixel-only.

## Evidence from TF-006B

Two physical v4 runs showed that the simple global-center sampler can already be exact at low density, while the local mesh is not reliably beneficial:

- run 1: 56×56, 72×72 and 80×80 had zero global-center errors;
- run 2: 48×48 and 64×64 had zero global-center errors;
- v4 mesh qualification incorrectly skipped dynamic testing because it only qualified on mesh error counts;
- around 96–120 cells the single-square carrier becomes much less reliable, so simply increasing one square's density is not the preferred primary path.

The physical-harness correctness fix is tracked separately in Issue #28.

## Capacity baseline

OptiGrid v1 at 80×80 carries 436 payload bytes/frame.

- one tile × 60 Hz = 26,160 B/s gross;
- two full-size tiles × 60 Hz = 52,320 B/s gross;
- reaching 100,000 B/s therefore requires either additional spatial channels, more bits/cell, or both.

The tiled bench is intended to quantify how much of the full 1920×1080 frame can be used at the low-density operating points that are already physically plausible.

## Phase A — monochrome tiled pixel simulation

Candidate layouts:

1. one centered 80×80 reference tile;
2. two horizontal 80×80 tiles using the full landscape width;
3. one/two 96×96 tiles as the next density step;
4. 2×2 layouts only as diagnostics because their cell pitch approaches the failed single-grid high-density regime.

Each tile has its own finder/pilot region, homography, header, sequence and CRC. A frame is accepted tile-by-tile; one failed tile must not invalidate another valid tile.

The simulation must test at least 24/30/45/60 Hz under clean, mild and stress transforms, with multi-seed long-soak runs. Primary metrics are exact tile decode ratio, unique payload ingress, decode p95, per-tile balance and gross utilization.

## Pixel isolation boundary

The Receiver may only consume the post-render/post-channel ImageData. It may not access Sender payload bytes, source cells, frame objects, sequence state or Sender-derived geometry.

Benchmark oracle comparison happens only after the Receiver independently decodes bytes from pixels.

## Phase B — 2-bit carrier only after monochrome stability

If two full-size monochrome tiles are stable but capacity remains materially below the ≥100 KB/s target, test a custom 2-bit/cell modulation over the same geometry.

Candidate modulation families:

- calibrated four-level luminance;
- four well-separated color symbols with receiver-side calibration.

This is OptiLink custom carrier work, not standard QR. Selection must be based on measured pixel-domain error rate and goodput, not theoretical bits/cell.

## Gate to physical test

Do not ask for another phone run until:

- desktop pixel-only long soak is stable;
- the chosen layout has material gross margin above the desired physical result;
- receiver decode p95 has enough headroom for target visual rate;
- the carrier has a clear fallback when one tile is temporarily lost.

Physical evidence remains raw optical ingress until Fountain/reassembly and SHA-256 are integrated. Official acceptance remains 10 MiB incompressible, 5/5 exact, final SHA-256 and radios disabled during actual payload transfer.
