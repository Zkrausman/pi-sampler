# LLM Wiki Schema

## Ownership Rules

| Path | Owner | Rule |
|------|-------|------|
| raw/** | extension | immutable after capture |
| wiki/** | model + user | editable knowledge pages |
| meta/events.jsonl | extension tools | append-only authoritative state |
| meta/* except events.jsonl | extension | generated projections |
| . | human + explicit request | operating rules |

Back up `meta/events.jsonl` to preserve activity history. Generated logs cannot reconstruct it.

## Source Packet Format

```
raw/sources/SRC-YYYY-MM-DD-NNN/
  manifest.json
  original/
  extracted.md
  attachments/
```

## Page Types

- **source** — what this specific source says
- **entity** — people, orgs, tools, products
- **concept** — ideas, patterns, frameworks
- **synthesis** — cross-source theses and tensions
- **analysis** — durable filed answers from queries
- **requirement** — atomic requirements with status, priority, and traceability

## Company Mode

- `wiki/decisions/` records durable project choices and their rationale.
- `wiki/changes/` records material project outcomes and migrations.
- Company knowledge pages use `confidence: high | medium | low` when they make claims that may need later revision.
- Personal notes, machine-specific paths, session material, and temporary working state belong in the local personal vault rather than this public project vault.

## Version-Control Boundary

Canonical project knowledge is versioned: `config.json`, `WIKI_SCHEMA.md`, templates, and redacted Markdown under `wiki/`. Runtime metadata, raw packets, outputs, discoveries, logs, credentials, session artifacts, and unredacted tool output stay local.

Before handoff, inspect `git status --short -- .llm-wiki`:

1. Include durable pages directly related to the current change in that change's pull request.
2. Put durable but unrelated pages in a focused `docs(wiki): ...` pull request.
3. Move personal knowledge to the personal vault and delete transient project observations rather than publishing them.
4. Scrub credentials, lease tokens, personal identifiers, absolute machine paths, raw prompts, transcripts, and tool output before staging.
5. Run the wiki-governance validator and inspect the staged diff before pushing.

## Linking Style

- New internal links: [label](/folder/page.md)
- Legacy readable links: [[folder/page]]
- Source citation: [source](/sources/SRC-YYYY-MM-DD-NNN.md)
