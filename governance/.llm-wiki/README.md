---
type: wiki-governance
status: active
---

# Shared Wiki boundary

Only canonical Markdown under `wiki/`, this README, `WIKI_SCHEMA.md`, and Markdown templates are versioned. Canonical pages may contain source IDs and SHA-256 digests, never packet content, credentials, OAuth/session state, embeddings, tool output, telemetry, or broker data.

From the `governance/` directory, run `go run ./cmd/wiki-governance validate -repo-root .` before staging collaboration artifacts. Rebuild local metadata with `go run ./cmd/wiki-governance rebuild -repo-root .`; the generated `meta/` directory remains ignored.

The immutable evidence store is intentionally not selected by this repository. See [`docs/wiki-governance/README.md`](../docs/wiki-governance/README.md) for the approval boundary and recovery procedure.
