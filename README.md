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
| [Wiki delivery](extensions/wiki-delivery/README.md) | Coordinates a fail-closed LLM Wiki delivery lifecycle and validates its manifest. | [Install and use](extensions/wiki-delivery/README.md) |

## Install an extension

Released extensions are private, independently versioned Pi packages hosted in
GitHub Packages. Configure npm with a read-only GitHub Packages token, then
install the desired package in the consumer project. For example:

```powershell
pi install -l npm:@zkrausman/pi-delivery-controller
```

Pi shows a package-update notice for unversioned package sources at session
start. Run `pi update --extensions` after reviewing release notes. Pin an exact
version when a reproducible deployment is required.

For local development, add an extension's `src/index.ts` path to Pi's
`extensions` setting or run it for one session.

> **Output optimization:** `@zkrausman/pi-output-optimizer` has been withdrawn
> from GitHub Packages. Use Pith and install its Pi hook with `pith install --pi` instead.

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
