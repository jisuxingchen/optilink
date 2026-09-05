# Technical Options — Pre-G1

This document records candidate technical paths. It deliberately does **not** make G1 decisions.

## Sender candidates

### Option S1 — Browser / TypeScript
Pros: zero-install potential; broad desktop reach; File API + Canvas available; easy static deployment.
Risks: display timing control, browser differences, offline packaging/PWA details.

### Option S2 — Native desktop app
Pros: deterministic rendering and deeper OS integration.
Risks: installation/admin approval burden; multi-platform packaging.

**Current hypothesis:** evaluate S1 first because zero-install may itself be part of product value.

## Android receiver candidates

### Option R1 — Kotlin + CameraX
Pros: native camera controls, performance, frame analysis, device telemetry.
Risks: Android-only implementation cost.

### Option R2 — Mobile browser
Pros: zero-install receiver.
Risks: weaker camera control/performance variance.

**Current hypothesis:** evaluate R1 first for the benchmark.

## Optical carrier candidates

1. Single dynamic QR — simplest baseline and measurement reference.
2. Multi-QR per video frame — parallel payload path to reach higher goodput.
3. Custom monochrome optical code — future density/robustness optimization.
4. Multi-level/color optical code — later research only; sensitive to display/camera/color pipeline.

## Protocol separation hypothesis

Prefer a layered design:

```text
File/Object Layer
      ↓
Transfer Session / Integrity
      ↓
Frame / Chunk Layer
      ↓
Optical Carrier Adapter
      ↓
Screen → Camera
```

This allows the carrier to evolve without redefining file semantics.

## Benchmark priority

The first engineering spike should measure actual reconstructed goodput and error behavior before building a polished application.

Candidate matrix:

- 1 QR × 30 FPS
- 1 QR × 60 FPS
- 4 QR × 30 FPS
- 4 QR × 60 FPS

Variables: QR version, error correction, payload/frame, display size, distance, brightness, camera FPS, frame loss and decode latency.