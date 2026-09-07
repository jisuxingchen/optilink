# TF-007 — Full-frame tiled OptiGrid carrier simulation

## Goal

Use the TF-006B physical evidence to stop over-optimizing one dense square and instead test spatial parallelism over the full 1920×1080 landscape frame before another phone run.

## Evidence boundary

This remains a desktop pixel-simulation experiment. The Receiver accepts only a newly rendered/degraded `ImageData` frame. It does not receive Sender payload bytes, cell arrays, frame objects, exact tile geometry, or Sender-derived lock state.

A benchmark oracle compares bytes only **after** independent per-tile CRC-valid optical decode.

## Implemented Phase A

A new `tiled-carrier.html` / `src/tiled-carrier.ts` bench now:

1. renders a true 1920×1080 Sender frame;
2. places one, two, three, or four independent OptiGrid v1 tiles;
3. applies a new full-frame optical raster with scale, rotation, shear, blur, and deterministic pixel noise;
4. gives the Receiver only the degraded ImageData;
5. searches only coarse protocol lanes/quadrants, never exact Sender positions;
6. independently acquires each tile from dark/finder pixels;
7. refines each tile quadrilateral from reserved OptiGrid cells;
8. tracks the receiver-derived quadrilateral on later frames;
9. decodes each tile with the simple global-center sampler favored by TF-006B evidence;
10. validates each tile with OptiGrid CRC and then a separate deterministic benchmark oracle.

## Automated suites

### Quick

Includes the single-tile reference plus multi-tile 2×80, 3×96 and 4×80 candidates under clean/mild/stress channels.

### Full

Sweeps:
- matrix: 80 / 96;
- tiles: 1 / 2 / 3 / 4;
- optical rate: 24 / 30 / 45 / 60 Hz;
- channel: clean / mild / stress.

### Soak

Runs 20 independently seeded optical frames for each scenario on:
- 3×96 @60 Hz;
- 4×80 @60 Hz;
- 4×96 @60 Hz.

These include monochrome layouts whose gross capacity exceeds 100 KB/s, but the suite does **not** assume they will pass. It records measured pixel-sim validity and receiver capacity instead.

## Capacity reference

OptiGrid v1 payload capacities:
- 80×80: 436 B/tile;
- 96×96: 708 B/tile.

At 60 Hz:
- 2×80: 52.32 KB/s gross;
- 2×96: 84.96 KB/s gross;
- 3×96: 127.44 KB/s gross;
- 4×80: 104.64 KB/s gross;
- 4×96: 169.92 KB/s gross.

Only the last three can clear 100 KB/s gross in monochrome. They still need substantial measured robustness and decoder margin before any phone test.

## Gate

Do not create a new physical tiled test until:
- the pixel-only isolation assertions pass;
- at least one multi-tile layout is stable across clean/mild/stress;
- a multi-seed soak is complete;
- the selected layout has useful margin above 100 KB/s rather than merely theoretical capacity.

If monochrome spatial parallelism is stable but cannot provide adequate margin, Phase B will evaluate a custom 2-bit/cell carrier (color or calibrated multi-level luminance) on the same independently tracked tile geometry.
