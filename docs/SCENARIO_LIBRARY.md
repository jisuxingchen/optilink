# Scenario Library

Status: **Discovery — hypotheses only**

The purpose of this file is to collect possible use cases before deciding which ones deserve product investment.

| ID | Scenario | Why existing transfer may be insufficient | Optical value hypothesis | Current status |
|---|---|---|---|---|
| SCN-001 | PC → phone ad-hoc file copy | Network pairing, cable or account login may be inconvenient | Fast no-pairing transfer by pointing camera at screen | Explore |
| SCN-002 | Air-gapped workstation export | Network and removable media may be prohibited or tightly governed | Physical-directional, connectionless transfer | Explore |
| SCN-003 | Controlled pharmaceutical/GMP area | Mobile media/network access may be governed; auditability matters | Controlled optical export with policy/audit features | Explore |
| SCN-004 | Industrial HMI/SCADA diagnostic export | Connecting engineering laptop/network may add operational burden | Export logs without establishing a network session | Explore |
| SCN-005 | OEM equipment feature | Vendor already controls display software/firmware | Embed protocol/SDK as a standard device capability | Explore |
| SCN-006 | Robot/AGV task package | Temporary task exchange without network association | Camera/screen-based task or parameter exchange | Explore |
| SCN-007 | Low-frequency maintenance transfer | Building a permanent network path is uneconomic | Low infrastructure cost for occasional exchange | Explore |
| SCN-008 | Old equipment with software-upgradable HMI | Hardware ports may be difficult to retrofit | Software-only addition if screen output is programmable | Conditional |

## Scenario screening criteria

Each scenario will later be scored on:

1. Existing alternatives and why they are insufficient
2. User pain / frequency / urgency
3. Required sender modification
4. Required receiver hardware/software
5. Security/compliance constraints
6. Expected file/data size
7. Required transfer speed
8. Required distance / angle / lighting robustness
9. Commercial buyer and willingness to pay
10. Market size / replicability

## Rejection rule

A scenario should be deprioritized if USB, Ethernet, Wi-Fi, Bluetooth, NFC or another existing method is already easier, approved, inexpensive and sufficiently secure.