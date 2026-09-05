# OptiLink Roadmap

## Delivery model

The roadmap is intentionally hypothesis-driven. Later dates are not commitments until earlier uncertainty is reduced.

## Phase 0 — Product Discovery & Feasibility

### Sprint 0 — Product Discovery
- [x] Bootstrap repository
- [x] Approve Gate G0 — first MVP hypothesis
- [x] Establish development governance
- [x] Create initial scenario library
- [x] Record candidate technical options
- [x] Create project dashboard baseline
- [x] Add CI baseline
- [ ] Expand/scored scenario matrix
- [ ] Define benchmark acceptance conditions
- [ ] Prepare Gate G1 technical-path proposal

### Gate G1 — Technical Path Approval
Owner reviews sender, receiver, carrier baseline, protocol separation and benchmark conditions.

## Phase 1 — Feasibility Spikes

### SPIKE-001 — Optical throughput baseline
- Single-QR baseline
- Measure decode success, effective payload and net goodput
- Record test environment

### SPIKE-002 — Parallel/multi-code throughput
- Test multiple codes per frame
- Compare CPU/camera bottlenecks
- Determine whether ≥100 KB/s is practical

### Gate G2 — Feasibility Decision
Continue, change technical path, lower/modify target, or stop.

## Phase 2 — Prototype

- Minimal browser sender
- Minimal Android receiver
- File chunking/reassembly
- Integrity validation
- Transfer progress and diagnostics
- Controlled test matrix

### Gate G3 — MVP Scope/Quality Approval
Owner reviews observed behavior and decides whether to productize.

## Phase 3 — MVP

- User-facing workflow
- Robust session handling
- Error recovery
- Packaging/offline sender story
- Android build/release workflow
- Product documentation

## Phase 4 — Productization exploration

Potential tracks, only after evidence:
- Personal utility
- Enterprise controlled transfer
- Industrial/OEM SDK
- Pharmaceutical/regulated environment solution
- Structured data/object transfer

### Gate G4 — Commercial direction
Select target customer, value proposition and go-to-market hypothesis.