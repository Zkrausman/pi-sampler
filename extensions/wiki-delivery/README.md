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

## Example: record a completed feature as governed knowledge

Use this after implementing a feature whose design notes, verification results,
and code-review outcome should become durable project knowledge. Start a run
with the delivery metadata and redacted source files. This abbreviated example
shows the shape of `wiki_delivery_begin`; a real run supplies at least five
sources and one or more canonical pages:

```json
{
  "ticket_id": "ENG-42",
  "recall_query": "health endpoint design and verification",
  "okf_path": "docs/specifications/ENG-42-health-endpoint.md",
  "delivery_state": "review_ready",
  "pr_number": 42,
  "pr_url": "https://github.com/acme/example-service/pull/42",
  "pr_draft": false,
  "review_verdict": "approved",
  "merge_status": "not_merged",
  "sources": [
    { "kind": "specification", "title": "Feature specification", "file_path": "docs/specifications/ENG-42-health-endpoint.md" }
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
installed validator accepts it.

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
3. Add this entry point to Pi's `extensions` setting:

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

The repository's legacy Wiki-controller tests have not yet been restored. Run
the governance suite after installing its validator/template:

```powershell
cd governance
go test -race ./...
```
