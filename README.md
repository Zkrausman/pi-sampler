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

Released extensions are private, independently versioned Pi packages hosted in
GitHub Packages. Configure npm with a read-only GitHub Packages token, then
install the package in the consumer project:

```powershell
pi install -l npm:@zkrausman/pi-output-optimizer
```

Pi shows a package-update notice for unversioned package sources at session
start. Run `pi update --extensions` after reviewing release notes. Pin an exact
version when a reproducible deployment is required:

```powershell
pi install -l npm:@zkrausman/pi-output-optimizer@0.1.0
```

For local development, add an extension's `src/index.ts` path to Pi's
`extensions` setting or run it for one session:

```powershell
pi -e E:/Repos/pi-sampler/extensions/output-optimizer/src/index.ts
```

Each extension README lists its prerequisites, configuration, and concrete
usage examples. See [`docs/RELEASING.md`](docs/RELEASING.md) for private-registry
setup, semantic versioning, and release operations.

## Project profiles

Use [`profiles/project-profile.schema.json`](profiles/project-profile.schema.json)
to document consumer-owned values such as work-item identifiers, verification
commands, source repository, required checks, and evidence/specification paths.
[`profiles/example-project.json`](profiles/example-project.json) is a generic
example. Treat every profile as consumer-owned configuration, never as a
repository default.

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
