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

## Replacement map

| Retired capability | Retirement reason | Future owner |
| --- | --- | --- |
| Conversation Catalog | Its catalog and hindsight implementation is legacy code, not a safe authority boundary. | **M2** returns the useful concepts as lossless episode memory and portable human annotations. |
| Ticket Cost | Exact accounting must be tied to the new evidence and episode contracts, not a legacy process-local receipt mechanism. | **M2** returns exact model, token, and cost accounting. |
| Ticket Lifecycle | Legacy lifecycle state cannot define the new authority model. | **M1** defines Ticket Episode v1, evidence classes, and the threat model; later M1–M5 contracts implement lifecycle authority. |
| Ticket Closeout Summary | A closeout renderer cannot be trusted independently of its replacement lifecycle evidence. | **M5** returns closeout authority after the new evidence and lifecycle contracts exist. |
| Delivery Controller | Dispatch and reconciliation had unsafe model-facing authority and filesystem assumptions. | **M3** returns Delivery authority only through the M1–M5 contracts and threat model. |
| Wiki Delivery | Wiki lifecycle attestations lacked the new authoritative evidence model. | **M4** returns Wiki authority only through the M1–M5 contracts and threat model. |

Lifecycle, closeout, Delivery, and Wiki authority return only through the new M1–M5 architecture; no legacy implementation is a bridge to it. Pi Excalidraw remains an independent human/AI productivity tool and is not part of this retirement.
