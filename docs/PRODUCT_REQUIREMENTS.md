# Product Requirements

## Requirement status legend

- **APPROVED** — owner-reviewed requirement
- **HYPOTHESIS** — working assumption to validate
- **OPEN** — decision required

## G0 — MVP definition

Status: **APPROVED** on 2026-09-05.

| ID | Requirement | Status |
|---|---|---|
| RQ-001 | Sender is a computer and receiver is an Android phone | APPROVED |
| RQ-002 | Data travels from screen to camera | APPROVED |
| RQ-003 | MVP transfer direction is one-way: computer → phone | APPROVED |
| RQ-004 | MVP transfers files first | APPROVED |
| RQ-005 | Actual transfer session must not require Internet/network communication between sender and receiver | APPROVED |
| RQ-006 | Computer sender should prefer a zero-install browser-based experience | APPROVED |
| RQ-007 | Initial engineering target is ≥100 KB/s **net goodput** | APPROVED target, not guarantee |
| RQ-008 | Correctness must be verified before a file is reported as successfully received | APPROVED |
| RQ-009 | Product must not be positioned as a method to bypass organizational controls | APPROVED |

## Definitions

**Net goodput** = correctly reconstructed original-file bytes / elapsed transfer time. Encoding overhead, repeated frames, FEC overhead and unusable frames do not count as useful bytes.

**Offline transfer session** = no data path such as Wi-Fi, Bluetooth, USB, NFC or Internet is required between the sender and receiver during file transmission.

## G1 — technical path questions

Status: **OPEN — owner review required before architecture freeze.**

Questions to resolve through research/spikes:

1. Is browser/TypeScript the sender baseline?
2. Is native Kotlin + CameraX the Android receiver baseline?
3. What is the first optical carrier: single QR, multi-QR, or another code?
4. What packet/frame metadata is minimally required?
5. What error-control strategy is needed: retransmission, FEC, fountain code, Reed-Solomon, or staged combination?
6. Is 30 FPS enough for the first benchmark, or should 60 FPS be mandatory?
7. What test devices and viewing conditions define the initial benchmark?

No irreversible architecture choice should be treated as approved until G1 is reviewed.