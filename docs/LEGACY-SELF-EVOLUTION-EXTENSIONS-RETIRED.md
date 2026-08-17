# Legacy self-evolution extensions retired

## M0 retirement decision

M0 permanently retires these legacy extension packages from the active repository:

- `extensions/conversation-catalog`
- `extensions/delivery-controller`
- `extensions/ticket-closeout-summary`
- `extensions/ticket-cost`
- `extensions/ticket-lifecycle`
- `extensions/wiki-delivery`

A hostile audit found that the legacy authority and filesystem boundaries were not safe enough to repair incrementally. In particular, model-facing Delivery reconciliation could write through an attacker-controlled ledger path. The packages are therefore removed rather than patched, disabled, republished, or compatibility-wrapped.

There are zero known external consumers. No replacement release, migration package, compatibility layer, or active `legacy/` code directory will be created. Git history is the archive for salvageable implementation ideas and prior release evidence; it is not installed, registered, packaged, tested as active functionality, or reachable at runtime.

## Replacement map and migration boundary

There is no in-place package migration: there are zero known external consumers,
and no retired package is installed or compatibility-supported. The migration path
for each capability is therefore **Git-history reference only**, followed by a
new successor that accepts only data and evidence defined by its listed contract.
The following ticket chain is the authoritative replacement ownership map.

| Retired package | Retirement reason | Foundational contract | Authoritative evidence/schema owner | Later adapter or user experience |
| --- | --- | --- | --- | --- |
| Conversation Catalog | Its catalog and hindsight implementation is legacy code, not a safe authority boundary. | **M2:** [AIDEV-126](https://linear.app/geltagentictrading/issue/AIDEV-126) and [AIDEV-127](https://linear.app/geltagentictrading/issue/AIDEV-127) return lossless episode memory and portable human annotations. | The M2 contracts define what successor memory and annotations may treat as evidence. | Any later presentation is separate from the retired implementation. |
| Ticket Cost | Exact accounting must be tied to the new evidence and episode contracts, not a legacy process-local receipt mechanism. | **M2:** [AIDEV-128](https://linear.app/geltagentictrading/issue/AIDEV-128) and [AIDEV-129](https://linear.app/geltagentictrading/issue/AIDEV-129) define exact model, token, and cost accounting. | The M2 accounting contracts own the evidence and attribution boundary. | Any later display consumes those M2 records; it is not a package revival. |
| Ticket Lifecycle | Legacy lifecycle state cannot define the new authority model. | **M1:** [AIDEV-123](https://linear.app/geltagentictrading/issue/AIDEV-123) and [AIDEV-124](https://linear.app/geltagentictrading/issue/AIDEV-124) establish Ticket Episode v1, evidence classes, and threat-model foundations. | **M3:** [AIDEV-130](https://linear.app/geltagentictrading/issue/AIDEV-130) owns lifecycle schema authority. | No legacy lifecycle adapter is a bridge to the successor. |
| Ticket Closeout Summary | A closeout renderer cannot be trusted independently of replacement lifecycle evidence. | It depends on the M1 foundations above rather than defining them itself. | **M3:** [AIDEV-130](https://linear.app/geltagentictrading/issue/AIDEV-130) owns the lifecycle schema evidence a closeout may consume. | A user-facing closeout experience may later appear in **M5** through [AIDEV-136](https://linear.app/geltagentictrading/issue/AIDEV-136); this is not M3 authority expansion. |
| Delivery Controller | Dispatch and reconciliation had unsafe model-facing authority and filesystem assumptions. | **M1:** [AIDEV-125](https://linear.app/geltagentictrading/issue/AIDEV-125) owns the Delivery contract. | **M3:** [AIDEV-131](https://linear.app/geltagentictrading/issue/AIDEV-131) owns authoritative Delivery receipts. | **M5:** [AIDEV-137](https://linear.app/geltagentictrading/issue/AIDEV-137) may rebuild the adapter only after those contracts and receipts exist. |
| Wiki Delivery | Wiki lifecycle attestations lacked an authoritative evidence model. | It relies on the M1 evidence and threat-model foundations; it does not create a parallel authority. | **M3:** [AIDEV-131](https://linear.app/geltagentictrading/issue/AIDEV-131) owns the authoritative receipts required before Wiki claims can be trusted. | **M5:** [AIDEV-137](https://linear.app/geltagentictrading/issue/AIDEV-137) may rebuild the adapter only after authoritative receipts exist. |

Foundational contracts establish identities, trust boundaries, and allowed claims;
authoritative evidence/schema work establishes what can be accepted as a receipt;
and later adapter or UX work may consume those established contracts but cannot
substitute for them. **M4 owns no Delivery or Wiki replacement work.** No legacy
implementation is a bridge to the new architecture. Pi Excalidraw remains an
independent human/AI productivity tool and is not part of this retirement.
