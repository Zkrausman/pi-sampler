# @zkrausman/pi-ticket-cost

## 0.2.3

### Patch Changes

- c5d3e5a: Reject merge-path transitions with unsettled segments and restore the ticket-cost lifecycle listener after retained-instance session restarts.

## 0.2.2

### Patch Changes

- Restore the single trusted lifecycle-event listener after a retained extension instance starts a new session.

## 0.2.1

### Patch Changes

- 127dceb: Include bounded model and run aggregates in receipts and fail closed rather than double-counting duplicate subagent run identifiers.

## 0.2.0

### Minor Changes

- 231b80f: Automate trusted ticket-loop windows through a versioned local Pi event-bus API and correctly aggregate pi-subagents numeric metadata costs, tokens, and turns in closeout receipts.

## 0.1.1

### Patch Changes

- Add deterministic, trusted-project ticket cost receipts with explicit begin and close commands. Aggregate bounded local parent and subagent usage, publish complete receipt pairs under `.pi/ticket-costs`, and render a paste-ready Linear closeout block.
