# pi-sampler

A local human/AI productivity repository. Pi is a third-party platform; this
repository is not affiliated with or endorsed by Pi's maintainers.

## Current product boundary

M0 retired the legacy self-evolution extension packages. There are no supported
or installable Pi extension packages in this repository. The retirement decision,
the hostile-audit conclusion, and the M1–M5 replacement map are recorded in
[the retirement record](docs/LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md).
Ticket Episode v1 now supplies the versioned identity, evidence-class, and
threat-model contract for successor work; see
[the canonical specification](docs/specs/TICKET-EPISODE-V1.md).

## Future plugin boundary

`pi-sampler` remains the umbrella repository for multiple independent Pi
extensions. Its current M0 inventory contains zero supported or installable
**packaged** extensions. `pi-evolution` will be the single coherent
self-evolution plugin, built only through the approved M1–M5 milestone
contracts and release policy.

Pi Excalidraw remains a separate, human-in-the-loop productivity plugin. It
creates and reads local `.excalidraw` architecture diagrams with deterministic
parsing and no cloud/API calls. It does **not** own lifecycle authority,
evolution evidence, lessons, or promotion decisions. Future packages may be
introduced only through their approved milestone contracts and release policy.

### Pi Excalidraw project-local extension

To enable the local Excalidraw tools through Pi's auto-discovered project
extension location, create `.pi/extensions/pi-excalidraw/index.ts` containing:

```ts
export { default } from "../../../src/extensions/pi-excalidraw/index.ts";
```

Start Pi in this trusted project (or use `/reload`). The extension registers
`generate_diagram` and `read_diagram`. Both accept only project-relative
`.excalidraw` paths, use only the local filesystem, and never use a network
service or subprocess.

`generate_diagram` accepts constrained architecture statements, for example:

```text
nodes: Client, API, Database; Client -> API -> Database
```

`read_diagram` returns JSON-formatted visual nodes and arrow connections. Both
tools bound descriptions, scene-file size, JSON nesting, elements, labels, and
summary output. They reject traversal, malformed scene data, symlink escapes,
and non-regular files rather than reading arbitrary paths.

The reader opens and verifies one file descriptor to reduce path/symlink
replacement exposure. Portable Node filesystem APIs cannot atomically guarantee
that a resolved pathname remains inside the project when a hostile concurrent
actor replaces filesystem objects after validation. Use Pi Excalidraw only in a
trusted local project; it is not a defense against a hostile filesystem.

The separate [project-local SQLite workspace boundary](docs/PI-EXCALIDRAW-WORKSPACE.md)
stores bounded native scenes at `.pi/excalidraw/workspace.sqlite`, with
conditional revisions, import/export, and an optional IPv4-loopback-only HTTP
service. It requires Node 24 or later and its experimental built-in
`node:sqlite` API; see that document for the full persistence boundary. It
intentionally does not register Pi operations or provide browser UX.

## Public-project policies

- [Legacy self-evolution retirement](docs/LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md)
- [Privacy and local-data boundaries](docs/PRIVACY.md)
- [Security reporting](SECURITY.md)
- [Platform, trademark, and non-affiliation notice](docs/PLATFORM-AND-TRADEMARKS.md)
- [Contribution provenance and DCO](CONTRIBUTING.md#contribution-provenance-and-dco)

## Project profiles

[`profiles/project-profile.schema.json`](profiles/project-profile.schema.json)
defines the consumer-owned project-profile shape: work-item identifiers, source
repository, verification commands, required checks, and evidence/specification
paths. [`profiles/example-project.json`](profiles/example-project.json) and
[`profiles/gelt-trading.example.json`](profiles/gelt-trading.example.json) are
examples, not repository defaults or active runtime configuration. Validate a
consumer profile against that schema with the consumer's JSON Schema validator;
repository changes to the schema or examples are covered by `npm test`.

## Optional governance module

[`governance/`](governance/) is a nested Go module containing independent
validators, reconciliation helpers, schemas, and templates. It does not restore
or execute a retired extension. Run its current checks from the repository root:

```powershell
npm run validate:governance
cd governance
go test -race ./...
go run ./cmd/wiki-governance validate -repo-root .
```

The wiki-governance command also runs in
[`.github/workflows/wiki-governance.yml`](.github/workflows/wiki-governance.yml)
on pull requests and pushes to `main`.

## Development

```powershell
npm test
npm run build
npm run validate:governance
npm run validate:compliance
npm run validate:pi-extensions
npm run validate:packages
```

See [`docs/SCOPED-REVIEW.md`](docs/SCOPED-REVIEW.md) for local, commit-only
scoped review packets.
