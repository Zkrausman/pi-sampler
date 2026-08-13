# Delivery controller

A provider-neutral Pi extension for dispatching **one explicitly supplied work
item**. It is deliberately narrow: it does not discover or select work, merge
branches, change tracker status, or grant approval.

## What it does

The extension registers `delivery_controller_dispatch` in trusted projects.
The caller supplies:

- a work item ID, source identifier, branch, base ref, instructions, and
  verification contract;
- a repository-relative ledger path;
- an approval environment-variable reference (for example,
  `$PROJECT_DELIVERY_APPROVAL`);
- a provider authentication environment-variable reference; and
- idempotency and correlation identifiers.

The controller validates the inputs, records the attempted dispatch in its
ledger, and delegates to the configured provider adapter. In non-interactive
Pi modes, the approval variable must resolve to `approved`.

A project profile should own the work-item pattern, repository source,
verification commands, required checks, and delivery paths. Start from
[`../../profiles/example-project.json`](../../profiles/example-project.json) and
validate against
[`../../profiles/project-profile.schema.json`](../../profiles/project-profile.schema.json).

## Configuration

The extension has no persistent controller configuration file. Configuration is
passed with each `delivery_controller_dispatch` request:

| Field | Required value |
| --- | --- |
| `config.ledgerPath` | A non-empty, repository-relative path that does not escape the checkout. |
| `config.approvalEnvRef` | An environment-variable reference such as `$PROJECT_DELIVERY_APPROVAL`. In non-interactive mode, its value must be `approved`. |
| `providerAuthEnvRef` | An environment-variable reference for the provider credential; never a secret value. |
| `item` | The explicit work item, including `id`, `sources/...` identifier, branch, base ref, verification contract, and instructions. |
| `idempotencyKey` / `correlationId` | Caller-supplied stable identifiers for deduplication and audit correlation. |

A project profile documents the consumer-owned work-item pattern, source,
verification commands, required checks, and paths. The profile helper validates
those values for review workflows; the dispatch tool currently requires the
corresponding item values explicitly and does not auto-load a profile.

## Example: dispatch an approved implementation task

Use this after a human has selected and approved a bounded task—for example,
adding a health endpoint to a service. The agent supplies the task rather than
asking the extension to discover work:

```json
{
  "config": {
    "ledgerPath": ".delivery/jobs.ndjson",
    "approvalEnvRef": "$PROJECT_DELIVERY_APPROVAL"
  },
  "item": {
    "id": "ENG-42",
    "source": "sources/github/acme/example-service",
    "branch": "feature/eng-42-health-endpoint",
    "baseRef": "origin/main",
    "verificationContract": "Run npm test and npm run lint.",
    "instructions": [
      "Add GET /health with a documented JSON response.",
      "Do not change deployment configuration."
    ],
    "title": "Add health endpoint"
  },
  "providerAuthEnvRef": "$DELIVERY_PROVIDER_TOKEN",
  "idempotencyKey": "eng-42-dispatch-v1",
  "correlationId": "delivery-eng-42"
}
```

The controller records the request and dispatches it through the provider
adapter. It does **not** approve the work, choose a different task, merge the
branch, or alter an issue tracker. In CI or other non-interactive modes, set
`PROJECT_DELIVERY_APPROVAL=approved` only in the authorized execution
environment.

## Install

1. With GitHub Packages access configured, install the released package:

   ```powershell
   pi install -l npm:@zkrausman/pi-delivery-controller
   ```

   For local development, clone `pi-sampler` to a trusted path instead.
2. Configure the consumer project's profile and keep provider credentials in
   environment variables, not in the profile or repository.
3. For a local checkout, add this entry point to Pi's `extensions` setting:

   ```json
   {
     "extensions": [
       "E:/Repos/pi-sampler/extensions/delivery-controller/src/index.ts"
     ]
   }
   ```

4. Restart Pi or run `/reload`. To test it for one session:

   ```powershell
   pi -e E:/Repos/pi-sampler/extensions/delivery-controller/src/index.ts
   ```

## Required inputs and restrictions

- Pi must trust the current project.
- `item.source` must be an explicit `sources/...` identifier. The extension has
  no default repository.
- `ledgerPath` is repository-relative and cannot escape the project.
- Approval and provider credentials are environment-variable **references**;
  never pass secret values in tool arguments.
- Interactive use relies on the user approval flow. For non-interactive use,
  set the referenced approval variable to `approved` only in an authorized
  execution environment.

## Ticket lifecycle reference adapter

The controller also provides a **human/host-only** reference adapter for the local `@zkrausman/pi-ticket-lifecycle` ledger. It does not add a model-callable lifecycle tool and `delivery_controller_dispatch` remains dispatch-only.

Before pickup, the host writes the bounded local work-item manifest `.pi/delivery-controller/work-items/<TICKET>.json`:

```json
{"version":1,"ticket":"AIDEV-77","workItem":{"approved":true}}
```

In a trusted interactive Pi session, the host/operator uses `/ticket-lifecycle-pickup <TICKET>` and receives an opaque handle. It then uses `/ticket-lifecycle-start <HANDLE>`, `/ticket-lifecycle-settle <HANDLE>`, and `/ticket-lifecycle-awaiting-merge <HANDLE>`. Before `/ticket-lifecycle-merged <HANDLE>` and `/ticket-lifecycle-closed <HANDLE>`, it must write separate local attestations at `.pi/delivery-controller/attestations/<TICKET>-merged.json` and `...-closed.json`, each with `version`, `ticket`, `kind`, `ref`, and `evidence`. The adapter recomputes an evidence digest; it does not poll or mutate a tracker and does not call dispatch/provider completion proof merge/close.

`pi-ticket-cost` is a peer and must be loaded in the **same Pi process**. The adapter emits only the exact v1 lifecycle signals and waits for a matching result. No result becomes `missing-receiver`; an error becomes `settle-failed`; shutdown/reload marks a pending segment `interrupted`. Reload/restart packages after installing or upgrading them. Final ticket receipts remain partial when a coverage gap exists.

## Verify

From the repository root:

```powershell
node --test tests/delivery-controller-generic.test.mjs tests/delivery-controller-lifecycle.test.mjs
```
