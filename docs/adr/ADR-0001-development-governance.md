# ADR-0001 — Development Governance

- Status: Accepted
- Date: 2026-09-05
- Decision owner: Repository owner

## Context

OptiLink is an exploratory product with unresolved product and technical questions. The owner requires visible progress, agile project management, explicit implementation steps, GitHub Actions testing, branch-based development and review before critical decisions or merging to `main`.

## Decision

Use the normal flow:

**Issue → Branch → Implementation/Docs → GitHub Actions → Draft PR → Owner Review → Merge to `main`**

Additional rules:

1. Development work happens on branches rather than directly on `main`, except the one-time empty-repository bootstrap.
2. Product/architecture choices that materially constrain future implementation are represented as review Gates.
3. A Gate marked `WAITING_APPROVAL` blocks the dependent work until the owner approves it.
4. GitHub Actions provides automated validation appropriate to the current phase.
5. The project dashboard is treated as a first-class deliverable and should reflect roadmap, sprint status, tasks, blockers and approvals.
6. ADRs record durable technical/architecture decisions; they must not be used to disguise unresolved choices as accepted decisions.
7. Experiment results, especially performance results, should contain reproducible conditions and actual measurements.

## Consequences

- Progress may be slower than unconstrained prototyping, but decisions remain traceable.
- Owner review becomes an explicit part of project flow.
- The repository itself acts as the project record.
- Future automation may derive dashboard state from Issues/PRs, but Sprint 0 may initially use a version-controlled status file.