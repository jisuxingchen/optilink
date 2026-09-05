# Scenario Library

Status: **Discovery — scored hypotheses, not product commitments**

This file exists to answer one question before we invest in implementation:

> **Where is optical screen→camera exchange materially better than the alternatives already available?**

The rejection rule remains strict: if USB, Ethernet, Wi-Fi, Bluetooth, NFC, cloud sync, a normal browser download, or an existing managed transfer product is already easier, approved, inexpensive, and sufficiently secure, OptiLink should not force itself into the scenario.

## 1. Scoring model

Each scenario is scored 1–5 on six dimensions. The weighted total is normalized to 100.

| Dimension | Weight | Meaning |
|---|---:|---|
| Existing-channel gap | 25% | How badly existing USB/network/wireless approaches fail or are disallowed |
| User pain / urgency | 20% | Frequency, cost, delay, safety or operational frustration |
| Optical fit | 20% | Whether screen→camera solves the specific transfer constraint naturally |
| Replicability / buyer value | 15% | Whether the problem repeats across customers and has a plausible buyer |
| Implementation feasibility | 10% | Whether required display/camera/software integration is realistic |
| Governance feasibility | 10% | Whether security/compliance policy could plausibly approve the pattern |

Confidence is separate from score:

- **High** — supported by public standards/guidance or repeated market evidence
- **Medium** — plausible and partially supported, but buyer/workflow evidence is incomplete
- **Low** — speculative; requires direct interviews or prototype evidence

## 2. First-pass scenario ranking

| Rank | ID | Scenario | Score /100 | Confidence | Current disposition |
|---:|---|---|---:|---|---|
| 1 | SCN-005 | OEM embedded optical service/export port | 88 | Medium | **Top candidate** |
| 2 | SCN-004 | Industrial HMI/SCADA diagnostic export | 84 | Medium-High | **Top candidate** |
| 3 | SCN-010 | Temporary field-service exchange without network credentials | 82 | Medium | **Top candidate** |
| 4 | SCN-002 | Managed / isolated workstation export | 80 | High for the restriction pattern; Medium for optical adoption | **Top candidate** |
| 5 | SCN-003 | Regulated/GMP read-only electronic-data export | 76 | Medium | **Strategic candidate** |
| 6 | SCN-007 | Low-frequency maintenance transfer | 74 | Medium | Explore |
| 7 | SCN-012 | Browser-only / VDI / kiosk transfer | 72 | Medium | Explore |
| 8 | SCN-008 | Legacy equipment with software-upgradable HMI | 70 | Medium | Conditional |
| 9 | SCN-009 | High-security one-way boundary / cross-domain style transfer | 68 | Medium | Later-stage only |
| 10 | SCN-006 | Robot/AGV task or parameter package | 61 | Low-Medium | Deprioritize unless network is constrained |
| 11 | SCN-001 | Generic PC → phone ad-hoc file copy | 48 | High | **Deprioritize** |
| 12 | SCN-011 | General consumer phone↔phone transfer | 40 | High | **Reject for MVP** |

The numbers are **decision aids, not market-size claims**. They will change as evidence improves.

## 3. Scenario details

### SCN-001 — Generic PC → phone ad-hoc file copy

**Typical alternatives:** AirDrop / Nearby Share / messaging apps / cloud drives / USB cable / local web transfer.

**Why OptiLink may help:** no pairing, no account, no cable, visible physical path.

**Why it is weak:** existing consumer options are already excellent when allowed. Public open-source projects also demonstrate this exact use case, so technical novelty is low.

**Disposition:** deprioritize as the commercial wedge. Keep it only as a simple demo/MVP test case.

---

### SCN-002 — Managed or isolated workstation export

**Example environment:** workstation with network isolation and restricted removable-media policy; user needs to export a small approved file, report, log, or data package.

**Typical alternatives:** controlled USB process, removable-media scanning station, temporary network exception, manual re-entry, print/paper workflow, managed cross-domain product.

**Why OptiLink may help:** a one-way, connectionless, software-defined transfer path can avoid creating a network session or inserting removable media.

**Constraints:** optical does **not** automatically make the transfer authorized. The organization must explicitly approve the channel and control what can be exported.

**Evidence:** NIST SP 800-82 Rev.3 states that removable media in OT environments should be protected and use restricted according to policy, illustrating why some environments tightly govern USB-like media.

Source: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-82r3.pdf

**Disposition:** top candidate for non-classified enterprise/OT environments; avoid positioning as a policy bypass.

---

### SCN-003 — Regulated/GMP read-only electronic-data export

**Example environment:** pharmaceutical laboratory/production equipment where electronic raw data, metadata, audit trails or diagnostic packages need controlled transfer.

**Typical alternatives:** validated network integration, controlled removable media, vendor service laptop, manual export workflow.

**Why OptiLink may help:** a read-only optical export can potentially reduce ad-hoc networking or removable-media handling while preserving an explicitly controlled transfer process.

**Critical constraint:** the optical link itself is **not** GMP compliance. A production solution would need authorization, complete record context, integrity verification, traceability, auditability, validation, retention and procedural controls as applicable.

**Evidence:** FDA data-integrity guidance emphasizes reliable/accurate data, metadata, audit trails and risk-based controls; FDA also states electronic records and associated context must be maintained securely and traceably.

Sources:
- https://www.fda.gov/regulatory-information/search-fda-guidance-documents/data-integrity-and-compliance-drug-cgmp-questions-and-answers
- https://www.fda.gov/drugs/guidances-drugs/questions-and-answers-current-good-manufacturing-practice-requirements-records-and-reports

**Disposition:** strategic vertical; start with **read-only export**, not recipe/write-back, until governance requirements are deeply understood.

---

### SCN-004 — Industrial HMI/SCADA diagnostic export

**Example environment:** machine/HMI/SCADA station needs to export alarms, logs, recipes-as-records, screenshots, diagnostic bundles or historian extracts without establishing a new engineering network connection.

**Typical alternatives:** USB, engineering laptop connection, Ethernet service port, vendor remote support, manual screenshots.

**Why OptiLink may help:** many industrial devices already have a display; a camera-equipped service phone/tablet is common. For low/medium-size diagnostic bundles, optical export could behave like a software-defined "service port".

**Best fit conditions:**
- transfer is occasional rather than continuous telemetry;
- data volume is moderate;
- sender software/HMI is modifiable;
- creating or approving a network path is disproportionately expensive;
- one-way export is acceptable.

**Disposition:** top candidate; high alignment with OptiLink's likely industrial/OEM direction.

---

### SCN-005 — OEM embedded optical service/export port

**Example environment:** equipment vendor controls the HMI/display application and wants a standard offline support channel without adding another connector/radio/network stack.

**Typical alternatives:** USB service port, SD card, Ethernet service port, Bluetooth/Wi-Fi module, proprietary handheld service tool.

**Why OptiLink may help:** software-defined physical interface using hardware the device may already have (display) and hardware the technician may already carry (camera phone/tablet).

**Potential payloads:** diagnostic bundle, configuration snapshot, commissioning report, calibration record, machine fingerprint, firmware metadata, small signed update package in a later bidirectional/write-capable edition.

**Commercial model hypothesis:** SDK / protocol licensing / OEM integration support / enterprise management layer.

**Disposition:** highest-priority differentiation hypothesis because it moves OptiLink beyond a generic file-transfer utility.

---

### SCN-006 — Robot/AGV task or parameter package

**Why it sounds attractive:** robots commonly have cameras or operator displays, so optical exchange feels natural.

**Why it is not automatically valuable:** most connected robots already have Wi-Fi/Ethernet/fleet-management infrastructure; optical transfer may add friction rather than remove it.

**Disposition:** only pursue where network association is intentionally absent, temporary, or operationally painful.

---

### SCN-007 — Low-frequency maintenance transfer

**Example environment:** a machine needs a few MB of logs/configuration a few times per year; permanent networking is not economically justified.

**Why OptiLink may help:** very low infrastructure burden if sender display is programmable.

**Disposition:** promising supporting scenario; may share the same product as SCN-004/005 rather than require a separate product.

---

### SCN-008 — Legacy equipment with software-upgradable HMI

**Why OptiLink may help:** avoids physical port retrofit if the display stack can be changed.

**Hard boundary:** if the legacy machine cannot be modified to display the optical frames, OptiLink cannot magically add the capability.

**Disposition:** conditional; requires software/firmware access or OEM cooperation.

---

### SCN-009 — High-security one-way boundary / cross-domain style transfer

**Why OptiLink may fit conceptually:** directionality is visible and a screen→camera channel can be physically one-way.

**Why it is not an MVP target:** high-assurance cross-domain environments can require formal security architecture, certified components, strict content filtering and operational accreditation. A DIY optical link must not be described as equivalent to a certified data diode or cross-domain solution.

**Disposition:** long-term research only.

---

### SCN-010 — Temporary field-service exchange without network credentials

**Example environment:** external technician is allowed to receive an approved diagnostic package but should not receive plant Wi-Fi credentials or direct network access.

**Typical alternatives:** guest network, service VLAN, USB handoff, email/cloud upload, customer-operated export.

**Why OptiLink may help:** customer can expose only an approved payload visually; technician receives it without joining the plant network.

**Disposition:** top candidate, especially as part of an OEM/industrial service product.

---

### SCN-011 — General consumer phone↔phone transfer

**Disposition:** reject for MVP. Existing ecosystems already solve this well; optical is unlikely to win on convenience except as a novelty or emergency fallback.

---

### SCN-012 — Browser-only / VDI / kiosk transfer

**Example environment:** managed endpoint where installing a sender application is prohibited but browser file access and fullscreen display are allowed.

**Why OptiLink may help:** a zero-install sender can run as a static web/PWA application; transfer can remain local after loading the tool.

**Constraints:** browser security policy, file-access policy and whether the endpoint permits the page itself must be validated.

**Disposition:** useful product requirement and deployment pattern rather than a standalone vertical.

## 4. Cross-scenario requirements emerging from discovery

The top scenarios repeatedly imply the following capabilities:

1. **One-way mode as a first-class product policy**, not merely an implementation detail.
2. **Explicit authorization** for what can be sent.
3. **Integrity verification** before accepting a transfer.
4. **Transfer manifest**: payload type, size, hash, sender/product identity, timestamp/session context.
5. **Audit/event output** for enterprise integration.
6. **Allowlist / policy hooks** for file type, size, direction and destination role.
7. **Structured payload support**, not only arbitrary files.
8. **SDK / embeddable sender** for OEM HMI/device integration.
9. **No hidden network dependency** during the actual optical session.
10. **Visible confidentiality warning**: an unencrypted optical stream can be captured by another camera with line of sight.

These are hypotheses for later product requirements; they are not all part of the G0 MVP.

## 5. Immediate discovery priorities

Before G1, deepen evidence for these five:

1. **SCN-005 OEM embedded optical service/export port**
2. **SCN-004 Industrial HMI/SCADA diagnostic export**
3. **SCN-002 Managed / isolated workstation export**
4. **SCN-010 Temporary field-service exchange**
5. **SCN-003 Regulated/GMP read-only export**

The next decision is not "can animated codes transfer files?" Public prior art already strongly suggests yes. The next decision is:

> **Which customer workflow is painful enough that an optical channel deserves to exist as a governed product?**
