# Wiki delivery

A fail-closed Pi controller for an LLM Wiki delivery lifecycle. It coordinates
source capture, ingestion, canonical-page creation, observations, linting, and
manifest validation. It never treats a queued background operation as completed
and does not claim delivery success when validation fails.

## What it does

The extension registers three tools:

- `wiki_delivery_begin` starts a clean-worktree lifecycle and provides the
  authorized sequence to the agent.
- `wiki_delivery_attest` records completion of observed ingestion or lint work.
- `wiki_delivery_finalize` writes and validates the resulting delivery manifest
  only after every required lifecycle stage and delivery commit is observed.

It gates the installed LLM Wiki tools so an active lifecycle follows the
approved sequence. It stores only redacted lifecycle receipts in the Pi session.

## Configuration

This extension has no project configuration file or path adapter yet. Its
validator convention is fixed and requires `cmd/delivery-evidence-validator`
and `evidence/delivery/` at the consumer project root.

The `wiki_delivery_begin` call supplies the run-specific configuration:

| Input | Purpose |
| --- | --- |
| Delivery metadata | Work-item ID, specification path, delivery state, pull request, review verdict, and merge status. |
| `sources` | At least five redacted local files to capture as immutable sources. |
| `canonical_pages` | One or more required canonical Wiki pages. |
| `verifications` | Command outcome metadata and output digests, never raw command output. |

`wiki_delivery_attest` accepts only the generated run ID and `ingestion` or
`lint` as its stage. `wiki_delivery_finalize` accepts the run ID and the clean
commit SHA containing the canonical Wiki changes. The required Wiki-tool
sequence, clean-worktree requirement, and validator command are safeguards, not
configuration options.

## Example: record a completed feature as governed knowledge

Use this after implementing a feature whose design notes, verification results,
and code-review outcome should become durable project knowledge. Start a run
with the delivery metadata and redacted source files. This example shows the
complete accepted `wiki_delivery_begin` source set; each source must use one of
the controller's accepted local Markdown paths:

```json
{
  "ticket_id": "ENG-42",
  "recall_query": "health endpoint design and verification",
  "okf_path": "docs/specs/ENG-42-health-endpoint.md",
  "delivery_state": "review_ready",
  "pr_number": 42,
  "pr_url": "https://github.com/acme/example-service/pull/42",
  "pr_draft": false,
  "review_verdict": "approved",
  "merge_status": "not_merged",
  "sources": [
    { "kind": "ticket", "title": "Feature ticket", "file_path": "docs/okf/ENG-42-ticket.md" },
    { "kind": "spec", "title": "Feature specification", "file_path": "docs/specs/ENG-42-health-endpoint.md" },
    { "kind": "pull_request", "title": "Pull request", "file_path": "docs/okf/ENG-42-pull-request.md" },
    { "kind": "review", "title": "Code review", "file_path": "docs/okf/ENG-42-review.md" },
    { "kind": "verification", "title": "Verification results", "file_path": "docs/okf/ENG-42-verification.md" }
  ],
  "canonical_pages": [
    { "type": "requirement", "title": "Health endpoint" }
  ],
  "verifications": [
    { "command": "npm test", "exit_code": 0, "outcome": "passed", "output_sha256": "<sha256>" }
  ]
}
```

The controller directs the agent through capture, ingestion, canonical-page
creation, observation, linting, and attestations. After those steps and the
canonical Wiki changes are committed, call `wiki_delivery_finalize` with the
run ID and that clean commit SHA. The extension writes a manifest only when the
installed validator accepts it, at `evidence/delivery/<TICKET>.json`.

After creating a pull request, synchronize its number and URL from the consumer
project root with `node <extension>/src/sync-pr-evidence.mjs <TICKET>`. Without
a manifest-path argument, synchronization reads and updates
`evidence/delivery/<TICKET>.json`.

## Prerequisites

This extension is for projects that use the compatible LLM Wiki toolset and
have the following validator layout available in the project checkout:

```text
cmd/delivery-evidence-validator
evidence/delivery/
```

It invokes `go run ./cmd/delivery-evidence-validator` during finalization.
Install the compatible governance module/template from this repository before
enabling finalization. This extension currently follows that conventional
manifest layout; do not install it in a project that uses a different layout
until its adapter/configuration is supplied.

## Install

1. Install and configure the LLM Wiki extension/tools in the consumer project.
2. Add the compatible governance validator and ensure `go run
   ./cmd/delivery-evidence-validator` succeeds from the project root.
3. Follow [the canonical GitHub Packages scoped-registry and authentication procedure](../../docs/RELEASING.md#consumer-setup), then install the released package:

   ```powershell
   pi install -l npm:@zkrausman/pi-wiki-delivery
   ```

   For local development, clone `pi-sampler` to a trusted path instead.
4. For a local checkout, add this entry point to Pi's `extensions` setting:

   ```json
   {
     "extensions": [
       "E:/Repos/pi-sampler/extensions/wiki-delivery/src/index.ts"
     ]
   }
   ```

4. Restart Pi or run `/reload`. For a one-session smoke test:

   ```powershell
   pi -e E:/Repos/pi-sampler/extensions/wiki-delivery/src/index.ts
   ```

## Operational safeguards

- The worktree must be clean when a lifecycle begins.
- Only redacted local source files are accepted; raw Wiki metadata and source
  packets are not read or written by this controller.
- Canonical Wiki changes must be committed before finalization.
- A failed validator removes the newly written manifest rather than leaving
  unvalidated evidence behind.

## Verify

Run the repository test suite, which includes the Wiki-delivery controller and
extension-registration lifecycle coverage:

```powershell
npm test
```

After installing the compatible validator/template in a consumer project, also
run its governance suite:

```powershell
cd governance
go test -race ./...
```
