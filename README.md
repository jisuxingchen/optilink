# OptiLink

OptiLink explores offline optical data exchange using a screen as the transmitter and a camera as the receiver.

## Current phase

**Sprint 0 — Product Discovery & Feasibility**

Approved Gate G0 hypothesis for the first MVP:

- Computer → Android phone
- Screen-to-camera
- One-way, offline file transfer
- Computer sender should prefer zero-install/browser-based use
- 100 KB/s net goodput is the initial technical validation target, not yet a product guarantee

## Development governance

Normal flow: **Issue → Branch → Implementation/Docs → GitHub Actions → Draft PR → Owner Review → Merge to `main`**.

Critical product and architecture decisions are recorded as explicit review gates and must not be silently invented during implementation.
