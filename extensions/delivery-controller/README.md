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

## Install

1. Clone `pi-sampler` to a trusted local path.
2. Configure the consumer project's profile and keep provider credentials in
   environment variables, not in the profile or repository.
3. Add this entry point to Pi's `extensions` setting:

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

## Verify

From the repository root:

```powershell
node --test tests/delivery-controller-generic.test.mjs
```
