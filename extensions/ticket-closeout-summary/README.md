# Pi ticket closeout summary

`@zkrausman/pi-ticket-closeout-summary` is a dependency-free, local-only, read-only validator and renderer for one explicitly supplied finalized `@zkrausman/pi-ticket-lifecycle` v1 receipt. It never discovers receipts, writes lifecycle storage, invokes a shell, model, network, or tracker.

## Install

Follow [the canonical GitHub Packages scoped-registry and authentication procedure](../../docs/RELEASING.md#consumer-setup), then install the released package:

```powershell
pi install -l npm:@zkrausman/pi-ticket-closeout-summary
```

## API

```js
import { readCloseoutSummary, renderCloseoutMarkdown } from "@zkrausman/pi-ticket-closeout-summary";
const summary = await readCloseoutSummary("E:/project/.pi/ticket-lifecycle/receipts/AIDEV-76.json");
console.log(renderCloseoutMarkdown(summary));
```

`parseFinalizedReceipt(receipt)` and `summarizeFinalizedReceipt(receipt)` strictly validate in-memory receipt data. The returned descriptor exposes only ticket, timestamps/duration, segment counts, aggregate numeric totals, coverage/gap reasons, and merged/closed evidence **counts**. It never exposes evidence references or SHA-256 values. Partial totals are explicitly known lower bounds because incomplete segments are excluded; do not use them in comparable cohort claims. Merge/close counts represent local operator-attestation evidence, not independently remote-verified proof.

## CLI

Supply exactly one absolute receipt path; no receipt search is performed.

```powershell
pi-ticket-closeout-summary --receipt E:/project/.pi/ticket-lifecycle/receipts/AIDEV-76.json
pi-ticket-closeout-summary --receipt E:/project/.pi/ticket-lifecycle/receipts/AIDEV-76.json --format markdown
```

The CLI accepts only `--receipt <path>` and optional `--format json|markdown`. It rejects unknown, repeated, missing, relative, newline-containing, symlink, and nonregular inputs, plus malformed or widened receipt data.
