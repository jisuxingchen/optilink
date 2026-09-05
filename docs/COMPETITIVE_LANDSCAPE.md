# Competitive Landscape — Optical Screen→Camera Transfer

Status: **Discovery evidence for Gate G1**

Issue: `PD-004` (#6)

## 1. Why this matters

OptiLink started from a valid product hypothesis: transfer data from a screen to a camera without requiring USB, a network connection, Bluetooth, NFC, or a paired radio link.

Discovery now confirms that the **base technical mechanism is established prior art**. Multiple public projects already implement animated QR / optical 2-D-code file transfer, and several report throughput above the G0 target of 100 KB/s under specific setups.

Therefore:

> OptiLink should not assume that "screen→camera file transfer" alone is a durable product moat.

The likely opportunity is the layer above the raw optical carrier: governed enterprise/industrial exchange, OEM integration, policy, auditability, structured payloads, deployment controls, and reproducible engineering evidence.

## 2. Important evidence rule

Performance below is **third-party self-reported** unless explicitly stated otherwise.

It can support the statement "the target appears technically plausible," but it must never be used as an OptiLink benchmark result.

OptiLink must independently reproduce its own result using `docs/BENCHMARK_SPEC.md`.

## 3. Relevant public implementations

### 3.1 Decimen Optical Transfer

Repository/example references:
- https://github.com/Pendia/Decimen-Optical-QR-Transfer
- https://github.com/bashalarmistalt/decimen-optical-transfer

Observed capabilities from public project documentation:

- browser-based sender/receiver path;
- animated multi-code optical transfer;
- fountain/Luby-transform style recovery;
- arbitrary file transfer;
- optional gzip where beneficial;
- SHA-256 integrity verification;
- no network path required for the payload transfer;
- project publishes benchmark/diagnostic workflow and transfer receipts.

Publicly reported performance includes:

- ~418.5 KB/s sustained desktop→phone on a specific Odyssey G9 → iPhone 17 Pro Max setup;
- ~199.2 KB/s sustained phone→phone on a specific device pair;
- earlier demonstrations around ~130 KB/s.

Licensing note:

- current v0.4+ project documentation reports **AGPL-3.0-or-later**;
- releases through v0.3.0 were MIT licensed according to project notices.

Implication for OptiLink:

- proves that browser and multi-code/fountain approaches deserve serious consideration;
- current AGPL code should not be copied into a commercial-friendly architecture without a deliberate license decision;
- earlier MIT portions may be reusable only after exact provenance and notice obligations are reviewed.

---

### 3.2 optical-transfer — tristanheilman

Reference:
- https://github.com/tristanheilman/optical-transfer

Observed capabilities:

- one-way screen→camera transfer;
- LT fountain coding;
- TypeScript core;
- React Native bindings;
- dropped-frame tolerance without a back-channel;
- optional compression;
- packaging as reusable libraries;
- project documents related prior art and attribution.

License reported by repository: **MIT**.

Implication:

- strong evidence that a transport core can be separated from UI/platform code;
- validates fountain-style one-way recovery as a practical candidate;
- reinforces need for a clean-room architecture decision if OptiLink wants its own protocol rather than becoming a thin wrapper.

---

### 3.3 Heliogram

Reference:
- https://github.com/ofitzharding/heliogram

Observed capabilities:

- screen→camera optical file transfer;
- custom animated 2-D optical code rather than relying only on standard QR;
- filename and SHA-256 embedded in the payload workflow;
- browser-pair path plus research/receiver tooling;
- Reed-Solomon related implementation and rolling-shutter research tools.

Project self-reported result:

- **229.7 KB/s**, hand-held, bit-exact, from a 60 Hz laptop panel to a stock phone camera recording 4K60.

License reported by repository: **MIT**.

Implication:

- custom optical codes can materially exceed naive single-QR throughput;
- custom carrier research should be a later optimization, not an assumption required for the first benchmark;
- the project appears to preserve experimental evidence, which is a good model for OptiLink's own benchmark discipline.

---

### 3.4 BeamFerry

Reference:
- https://github.com/shuipashui/beamferry

Observed capabilities from project documentation:

- animated QR optical transfer;
- browser sender/receiver;
- Android receiver;
- desktop receiver;
- protocol/FEC implementation;
- integrity checking;
- offline-first deployment guidance;
- explicit warning that QR streams are visible to anyone with line of sight.

License reported by repository: **MIT**, with third-party notices for derived/reference components.

Implication:

- a web sender + native Android receiver is not novel by itself;
- Android receiver performance, camera control, stall classification and multi-decoder architecture are established engineering areas worth benchmarking rather than rediscovering blindly;
- security messaging must distinguish **integrity** from **confidentiality**.

## 4. Capability comparison — first pass

| Capability | Public prior art | OptiLink implication |
|---|---|---|
| Screen→camera transfer | Common | not a differentiator |
| Zero-install/browser sender | Demonstrated | baseline expectation |
| Browser receiver | Demonstrated | evaluate before assuming native-only |
| Native Android receiver | Demonstrated | possible performance/control path |
| Animated QR | Common | good baseline, not moat |
| Multi-code per frame | Demonstrated | likely necessary for speed scaling |
| Fountain/erasure recovery | Demonstrated | strong candidate for one-way reliability |
| Custom dense optical code | Demonstrated | later optimization path |
| SHA-256 integrity | Common | minimum expectation |
| Compression | Common | useful but must not distort benchmark claims |
| >100 KB/s claims | Multiple projects | target appears plausible; still must reproduce |
| Enterprise authorization policy | Limited/unclear | differentiation opportunity |
| Transfer audit trail | Limited/unclear | differentiation opportunity |
| File/data allowlisting | Limited/unclear | differentiation opportunity |
| Signed manifest / sender identity | Limited/unclear | differentiation opportunity |
| Industrial/OEM SDK governance | Limited/unclear | strong differentiation opportunity |
| Structured industrial payloads | Limited/unclear | differentiation opportunity |
| Validation evidence pack | Mostly research-focused | enterprise differentiation opportunity |
| Admin-managed one-way policy | Limited/unclear | enterprise differentiation opportunity |

"Limited/unclear" means this first-pass review has not found it as a central product proposition; it does **not** assert that no implementation exists.

## 5. Proposed differentiation hypotheses

These are hypotheses for G1/G2, not approved scope.

### D1 — Governed one-way exchange

A system administrator or OEM defines directionality and allowed payload classes. "One-way" becomes a policy object rather than just a lack of ACK packets.

### D2 — Signed transfer manifest

Each transfer can carry or generate:

- payload type;
- original filename or structured object type;
- byte length;
- SHA-256;
- protocol version;
- session ID;
- sender/device identity where available;
- policy decision/result;
- timestamp context;
- optional signature.

### D3 — Enterprise audit integration

Expose machine-readable audit events for SIEM, historian, MES, service-management or validation records.

### D4 — OEM optical service port

SDK/API that allows an HMI/device vendor to expose approved diagnostic/configuration objects visually without designing a new radio/network/service connector.

### D5 — Structured industrial payloads

Move beyond arbitrary files to typed objects such as:

- diagnostic bundle;
- PLC/HMI configuration snapshot;
- robot job package;
- calibration record;
- commissioning report;
- alarm/event export;
- recipe-as-record (read/export first);
- signed update package in later controlled write-capable editions.

### D6 — Deployment controls

Support static/offline/self-hosted sender, managed Android receiver, kiosk mode, policy bundles and reproducible builds.

### D7 — Evidence-first performance

Every published speed claim references a reproducible environment record and raw benchmark result rather than a marketing maximum.

## 6. Security/product lessons from prior art

1. **Visible is not confidential.** Anyone with line of sight and a suitable camera may capture an unencrypted optical stream.
2. **Integrity is not authorization.** SHA-256 proves equality, not whether the recipient was allowed to receive the file.
3. **Air-gapped is not automatically secure.** The channel still crosses a security boundary and must be explicitly governed.
4. **No back-channel favors erasure/fountain coding.** Requiring a specific sequence of frames is fragile.
5. **Raw speed is not enough.** Industrial buyers may value predictable operation, auditability and validation evidence more than peak throughput.
6. **Open-source license provenance matters early.** We should decide whether OptiLink is clean-room implementation, permissive-component reuse, or a derivative architecture before code is copied.

## 7. Recommendation for G1

The recommended working product position to review at G1 is:

> **OptiLink is an enterprise/industrial optical data-exchange platform, with a simple file-transfer MVP used to validate the transport.**

That wording preserves the small G0 implementation while avoiding a future strategy where we compete only on "animated QR file transfer."

## 8. Sources reviewed in this pass

Technical prior art:
- https://github.com/Pendia/Decimen-Optical-QR-Transfer
- https://github.com/bashalarmistalt/decimen-optical-transfer
- https://github.com/tristanheilman/optical-transfer
- https://github.com/ofitzharding/heliogram
- https://github.com/shuipashui/beamferry

Operational/security context:
- NIST SP 800-82 Rev.3 — Guide to Operational Technology (OT) Security: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-82r3.pdf

Regulated-data context:
- FDA Data Integrity and Compliance With Drug CGMP: https://www.fda.gov/regulatory-information/search-fda-guidance-documents/data-integrity-and-compliance-drug-cgmp-questions-and-answers
- FDA CGMP Records and Reports Q&A: https://www.fda.gov/drugs/guidances-drugs/questions-and-answers-current-good-manufacturing-practice-requirements-records-and-reports
