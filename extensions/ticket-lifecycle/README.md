# Pi ticket lifecycle

`@zkrausman/pi-ticket-lifecycle` is a dependency-light, local-only core for
attributing one logical ticket's Pi cost across multiple sessions. It does not
contact a tracker, make model/network calls, parse chat text, or register Pi
tools/events. A trusted ticket-loop adapter supplies only authoritative,
versioned transition data.

## Lifecycle contract

The adapter appends v1 transitions in this order:

```text
pickup → segment-start / segment-settle ... → awaiting-merge → merged → closed
```

Every transition has `version: 1`, a unique bounded `eventId`, ticket key, and
UTC `at`. `pickup`, `merged`, and `closed` carry redacted evidence references
(`{ ref, sha256 }`); merge and close evidence are mandatory. A segment start
contains its stable segment/session/start-request identifiers. Settlement
supplies the same identifiers, a stable settle-request identifier, and the
already-created cost receipt data (`total`, `parentDelta`, `subagentTotal`, and
`subagentRuns`). The package never imports `pi-ticket-cost`.

A settlement can instead mark a segment `interrupted`, `missing-receiver`,
`settle-failed`, or `abandoned`. Those segments become explicit attribution
gaps. Final receipts can be `partial`, but they never hide missing coverage.
Finalization requires a closed lifecycle, all segments settled, and both merge
and close evidence.

## Use

```js
import { TicketLifecycleLedger } from "@zkrausman/pi-ticket-lifecycle/src/index.mjs";

const ledger = new TicketLifecycleLedger(process.cwd());
await ledger.append({ version: 1, eventId: "pickup-123", ticket: "ENG-123", at: "2026-01-01T00:00:00.000Z", action: "pickup" });
// The trusted adapter later adds segment-start/segment-settle and evidence-bearing terminal transitions.
const { receipt } = await ledger.finalize("ENG-123");
```

The append-only ledger and immutable final receipts are under
`.pi/ticket-lifecycle/`. Use one `TicketLifecycleLedger` per trusted project.
Adapters must persist/own their ticket transitions before calling this API, and
must not treat dispatch, model output, or tracker polling as authoritative
merge or close evidence.

## Verify

```powershell
node --test tests/ticket-lifecycle.test.mjs
```
