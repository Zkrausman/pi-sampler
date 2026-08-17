# pi-sampler

A local human/AI productivity repository. Pi is a third-party platform; this
repository is not affiliated with or endorsed by Pi's maintainers.

## Current product boundary

M0 retired the legacy self-evolution extension packages. There are no supported
or installable Pi extension packages in this repository. The retirement decision,
the hostile-audit conclusion, and the M1–M5 replacement map are recorded in
[the retirement record](docs/LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md).

Pi Excalidraw remains an independent project-local human/AI productivity tool.
It creates and reads local `.excalidraw` architecture diagrams with deterministic
parsing and no cloud/API calls.

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

The separate [project-local SQLite workspace boundary](docs/PI-EXCALIDRAW-WORKSPACE.md)
stores bounded native scenes at `.pi/excalidraw/workspace.sqlite`, with
conditional revisions, import/export, and an optional IPv4-loopback-only HTTP
service. It intentionally does not register Pi operations or provide browser UX.

## Public-project policies

- [Legacy self-evolution retirement](docs/LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md)
- [Privacy and local-data boundaries](docs/PRIVACY.md)
- [Security reporting](SECURITY.md)
- [Platform, trademark, and non-affiliation notice](docs/PLATFORM-AND-TRADEMARKS.md)
- [Contribution provenance and DCO](CONTRIBUTING.md#contribution-provenance-and-dco)

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
