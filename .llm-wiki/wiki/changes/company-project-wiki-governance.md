---
type: change
title: Company project wiki governance
status: merged
timestamp: 2026-08-20T14:20:00Z
created: 2026-08-20
updated: 2026-08-20
confidence: high
---

# Company project wiki governance

PR #145 moved the public project vault to company mode and made declarative wiki configuration part of the versioned collaboration surface. It also introduced dedicated decision and change directories and documented the handoff classification for wiki work:

- Durable knowledge related to the current change belongs in that pull request.
- Durable but unrelated knowledge belongs in a focused `docs(wiki): ...` pull request.
- Personal working memory belongs in the personal vault.
- Transient observations should be removed instead of published.

Root ignore rules and regression tests keep raw packets, generated metadata, outputs, discoveries, sessions, credential-like files, logs, and unredacted tool output outside Git while leaving `.llm-wiki/config.json`, schemas, templates, and redacted canonical pages versionable.

See the canonical [wiki schema](../../WIKI_SCHEMA.md), [changes index](/changes/index.md), and [decision index](/decisions/index.md).
