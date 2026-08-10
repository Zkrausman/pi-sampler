# pi-sampler

Reusable [Pi](https://github.com/earendil-works/pi-mono) extensions and optional
AI-development tooling. The repository owns reusable mechanisms; a consuming
repository owns its work-item format, repository source, credentials, commands,
and governance policy.

> **Security:** Pi extensions execute with your user permissions. Install only
> reviewed revisions, use project-local configuration only in trusted projects,
> and never commit credentials, sessions, or generated delivery evidence.

## Extensions

| Extension | Purpose | Documentation |
| --- | --- | --- |
| [Delivery controller](extensions/delivery-controller/README.md) | Dispatch one explicitly supplied work item to a configured provider. It does not select work, merge code, or update a tracker. | [Install and use](extensions/delivery-controller/README.md) |
| [Output optimizer](extensions/output-optimizer/README.md) | Safely reduces large successful shell output while preserving failures, diffs, and small output verbatim. | [Install and use](extensions/output-optimizer/README.md) |
| [Wiki delivery](extensions/wiki-delivery/README.md) | Coordinates a fail-closed LLM Wiki delivery lifecycle and validates its manifest. | [Install and use](extensions/wiki-delivery/README.md) |

## Install an extension

Clone this repository, then add the extension's `src/index.ts` path to Pi's
`extensions` setting. The exact settings file is the one used by your Pi
installation (for example, its user-level `settings.json`):

```json
{
  "extensions": [
    "E:/Repos/pi-sampler/extensions/output-optimizer/src/index.ts"
  ]
}
```

Restart Pi or run `/reload`. For a one-session smoke test, run:

```powershell
pi -e E:/Repos/pi-sampler/extensions/output-optimizer/src/index.ts
```

Each extension README lists its prerequisites and configuration. Pi also
supports project-local extensions under `.pi/extensions/`; use that option only
for a project you trust.

## Project profiles

Use [`profiles/project-profile.schema.json`](profiles/project-profile.schema.json)
to document consumer-owned values such as work-item identifiers, verification
commands, source repository, required checks, and evidence/specification paths.
[`profiles/example-project.json`](profiles/example-project.json) is a generic
example. The Gelt profile is an example consumer configuration, not a default.

## Optional governance module

[`governance/`](governance/) is a nested Go module containing validators,
reconciliation helpers, schemas, and templates. Validate it independently:

```powershell
cd governance
go test -race ./...
```

## Development

```powershell
node --test tests/*.test.mjs
cd governance; go test -race ./...
```

See [`docs/specs/AI-TOOLING-SEPARATION.md`](docs/specs/AI-TOOLING-SEPARATION.md)
for the extraction boundary and migration rationale.
