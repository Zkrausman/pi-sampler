# Shared Wiki schema

Canonical pages are Markdown with YAML frontmatter. A source reference must use an immutable `SRC-YYYY-MM-DD-NNN` identifier and its SHA-256 digest from a committed `evidence/references/*.json` manifest. Do not embed a raw source packet, attachment, unredacted command output, telemetry, credential, OAuth value, or session material.

Metadata, embeddings, discovery output, and raw packets are local/generated or external-only and must not be committed. The authoritative path classification is [`docs/wiki-governance/path-policy-v1.json`](../docs/wiki-governance/path-policy-v1.json).
