# OptiLink Product Vision

## Problem hypothesis

Many data-transfer tasks are already well served by USB, Ethernet, Wi-Fi, Bluetooth, NFC or cloud services. OptiLink should **not** exist merely because optical transfer is technically interesting.

OptiLink explores cases where conventional channels are unavailable, disallowed, uneconomical, inconvenient, or create unnecessary integration/security burden.

## Product idea

Use a **screen as an optical transmitter** and a **camera as an optical receiver** to exchange data without requiring a direct electrical or network connection between the two endpoints.

QR codes are only a candidate first carrier. The long-term product is an optical data-transfer protocol and implementation platform, not a QR-code utility.

## Approved Gate G0 — first MVP hypothesis

Approved 2026-09-05:

- Computer → Android phone
- Screen → camera
- One-way transfer
- Offline during the actual data-transfer session
- File transfer first
- Computer sender should prefer zero-install/browser-based operation
- Initial engineering validation target: **≥100 KB/s net goodput**
- 100 KB/s is a validation target, **not yet a product promise**

## Guiding principles

1. **Scenario first, technology second.**
2. Do not invent requirements when a product decision is still open.
3. Critical choices become explicit review gates.
4. Security positioning is controlled/authorized exchange, never bypassing customer policy.
5. Measure effective correctly reconstructed bytes, not theoretical encoded bitrate.
6. Keep the protocol independent from the visual carrier where practical.

## Long-term possibilities

- Personal offline file exchange
- Air-gapped / isolated environments
- Industrial maintenance and diagnostics
- Pharmaceutical / controlled environments
- OEM integration into HMI, instruments, robots and embedded products
- Structured data, task packages, logs and configuration objects
- SDK / protocol licensing

These remain hypotheses until validated.