# OptiLink

OptiLink explores **offline optical data exchange** using a screen as the transmitter and a camera as the receiver.

The project starts from a simple question: can a computer turn a file into a real-time visual stream that an Android phone reconstructs reliably at around **100 KB/s net goodput or better**—without using USB, Wi-Fi, Bluetooth, NFC or an Internet data path between endpoints during transmission?

QR is an initial carrier candidate, not the product definition.

## Current phase

**Sprint 0 — Product Discovery & Feasibility**

Gate **G0 is approved** for the first MVP hypothesis:

- Computer → Android phone
- Screen → camera
- One-way, offline file transfer
- Computer sender should prefer zero-install/browser-based use
- ≥100 KB/s net goodput is the initial technical validation target, not yet a product guarantee

Gate **G1 (technical path)** is still open. Candidate technologies are documented but not frozen.

## Project navigation

- [Product vision](docs/PRODUCT_VISION.md)
- [Scenario library](docs/SCENARIO_LIBRARY.md)
- [Product requirements](docs/PRODUCT_REQUIREMENTS.md)
- [Technical options](docs/TECHNICAL_OPTIONS.md)
- [Glossary](docs/GLOSSARY.md)
- [Roadmap](project/ROADMAP.md)
- [Machine-readable project status](project/PROJECT_STATUS.json)
- [Development governance ADR](docs/adr/ADR-0001-development-governance.md)

## Development governance

Normal flow:

**Issue → Branch → Implementation/Docs → GitHub Actions → Draft PR → Owner Review → Merge to `main`**

Critical product and architecture decisions are explicit review gates. Unresolved choices must not be silently invented during implementation.

## Dashboard

The project contains a mobile-friendly dashboard under `dashboard/`. CI builds a preview artifact for branches/PRs. A separate GitHub Pages workflow publishes the dashboard from `main` after merge (repository Pages may require a one-time enablement for GitHub Actions).

## Current GitHub work items

- `PD-002` — scenario discovery and scoring
- `TF-001` — define optical throughput benchmark
- `G1` — technical path approval
- `PM-001` — dashboard publishing and project visibility

## Engineering principle

Measure what the user actually receives: **correctly reconstructed original bytes per second**, not theoretical barcode capacity or display bitrate.
