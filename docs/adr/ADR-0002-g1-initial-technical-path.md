# ADR-0002 — G1 Initial Product and Technical Path

- Status: **Accepted**
- Date: 2026-09-05
- Decision owner: Repository owner
- Gate: G1

## Context

Sprint 0 discovery established two important facts:

1. screen→camera optical file transfer is technically credible and has substantial public prior art;
2. raw optical file transfer alone is therefore not a sufficient long-term product moat.

The project still needs a simple transport MVP to independently validate performance, robustness and browser/camera constraints before investing in enterprise or industrial product layers.

## Decision

### D1 — Product position

OptiLink is developed toward an **enterprise / industrial optical data-exchange platform**. The first file-transfer MVP is a transport-validation vehicle, not the complete product definition.

### D2 — Sender baseline

Use a **Browser / TypeScript** sender first. Zero-install / low-deployment-friction is treated as a potential product advantage.

### D3 — Receiver baseline

Use an **Android browser** receiver first. Escalate to native **Kotlin + CameraX** only when measured browser limitations justify the additional implementation and deployment cost.

### D4 — Visual carrier sequence

Use the following evidence-driven sequence:

1. single standard QR/code baseline;
2. multiple standard codes per display frame if throughput requires it;
3. custom optical carrier only after a measured bottleneck demonstrates that standard codes are insufficient.

### D5 — One-way loss recovery

Fountain / rateless erasure coding is the leading recovery candidate for a one-way channel. The single-code baseline may start with simpler deterministic sequencing to measure the optical/decode path, but production-oriented one-way recovery must not rely on an ACK channel that violates the one-way assumption.

### D6 — Open-source policy

Permissively licensed commodity libraries may be reused where appropriate. OptiLink keeps its protocol/application semantics under project control. Third-party optical-transfer transport implementations are not copied into the project without provenance and license review.

### D7 — Benchmark

The benchmark defined in `docs/BENCHMARK_SPEC.md` is the performance evidence standard:

- primary payload: 10 MiB incompressible data;
- exact SHA-256 reconstruction;
- 5/5 successful runs for a stable configuration;
- median ≥100 KB/s net goodput for the G0 engineering target;
- all relevant physical and software conditions recorded;
- no hidden network payload path.

## First physical baseline

- Receiver: **Motorola moto razr 40 ultra**
- Sender display: ordinary computer display; exact model not frozen for the first test
- Initial target visual update rate: **24 Hz**
- Adjustable experiment variables include:
  - displayed code/window size;
  - QR/code pixel/module size or equivalent density parameter;
  - payload bytes per code;
  - QR version / ECC where applicable;
  - later visual update-rate variants.

24 Hz is a starting benchmark condition, not a permanent product limit.

## Consequences

- TF-002 may implement a browser/browser single-code spike.
- TF-003 remains evidence-dependent on TF-002 results.
- The experiment must expose timing and sizing controls rather than burying them as constants.
- A failure to reach 100 KB/s in the single-code baseline is valid evidence, not a reason to change the acceptance metric.
- Native Android and custom optical carriers remain escalation paths, not assumptions.
