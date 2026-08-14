# @zkrausman/pi-ticket-lifecycle

## 0.2.0

### Minor Changes

- 45687bb: Add a tracker-neutral local ticket lifecycle ledger with crash recovery, ownership-token locking, and immutable aggregate cost receipts.

### Patch Changes

- c5d3e5a: Reject merge-path transitions with unsettled segments and restore the ticket-cost lifecycle listener after retained-instance session restarts.

## 0.1.1

### Patch Changes

- Reject awaiting-merge and merged transitions while any ticket segment remains pending.

## 0.1.0

### Minor Changes

- Add a local tracker-neutral lifecycle ledger and immutable multi-session ticket cost receipts with explicit attribution gaps.
