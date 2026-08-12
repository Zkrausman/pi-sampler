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
| [Conversation catalog](extensions/conversation-catalog/README.md) | Browses and reads saved Pi conversations locally, then creates redaction-reviewed, evidence-cited hindsight reports. | [Install and use](extensions/conversation-catalog/README.md) |
| [Wiki delivery](extensions/wiki-delivery/README.md) | Coordinates a fail-closed LLM Wiki delivery lifecycle and validates its manifest. | [Install and use](extensions/wiki-delivery/README.md) |
| Pi Excalidraw (project-local) | Creates and reads local `.excalidraw` architecture diagrams with deterministic parsing; it makes no cloud/API calls. | [Load locally](#pi-excalidraw-project-local-extension) |

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

### Pi Excalidraw project-local extension

To enable the local Excalidraw tools through Pi's auto-discovered project
extension location, create `.pi/extensions/pi-excalidraw/index.ts` containing:

```ts
export { default } from "../../../src/extensions/pi-excalidraw/index.ts";
```

Then start Pi in this trusted project (or use `/reload`). The extension registers
`generate_diagram` and `read_diagram`. Both accept only project-relative
`.excalidraw` paths, parse/write only the local filesystem, and never use a
network service or subprocess. `generate_diagram` accepts constrained statements
such as `nodes: Client, API; Client -> API`; `read_diagram` returns JSON-formatted
nodes and arrow connections. Inputs are bounded (description, scene, nesting,
elements, labels, and summary output) and reads reject non-regular files before
opening them. The reader opens and verifies one file descriptor to reduce
path/symlink TOCTOU exposure; portable Node APIs cannot atomically guarantee a
resolved pathname remains inside the project if an attacker can replace it
between path validation and open, so run only in a trusted local project.

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
