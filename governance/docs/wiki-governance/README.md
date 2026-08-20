---
type: governance-runbook
title: Shared Wiki, OKF, and evidence collaboration model
timestamp: 2026-08-06T00:00:00Z
---

# Shared Wiki, OKF, and evidence collaboration model

## 🎯 What

This repository shares only reviewable canonical Wiki/OKF Markdown, schemas, templates, delivery manifests, immutable evidence references, and the non-secret `.pi/policy.json`. The executable source of truth is [`path-policy-v1.json`](path-policy-v1.json). From the `governance/` directory, run `go run ./cmd/wiki-governance validate -repo-root .` before staging these artifacts.

| Classification | Location | Git rule | Contents |
| --- | --- | --- | --- |
| Canonical/versioned | `.llm-wiki/config.json`, `.llm-wiki/wiki/**/*.md`, `.llm-wiki/templates/**/*.md`, `.llm-wiki/WIKI_SCHEMA.md`, `.pi/policy.json`, `docs/specs/`, `docs/okf/`, `docs/wiki-governance/`, `evidence/delivery/`, `evidence/references/` | Allowlisted | Declarative vault mode/topic, redacted knowledge, schemas, templates, IDs, SHA-256 digests, delivery state, and optional harness cost metadata (numeric counters + anonymized `developer_id` only) |
| Generated/local | `.llm-wiki/meta/`, `outputs/`, `.discoveries/` | Ignored | Rebuildable metadata, plugin output, and embeddings. |
| External immutable evidence | `.llm-wiki/raw/`, `evidence/raw/` | Ignored and rejected by validator | Raw packets/assets stay outside Git; committed references contain only a source ID, digest, classification, and redaction state. |
| Sensitive/local | `.pi/sessions/`, `.pi/oauth/`, `.pi/credentials/`, `.pi/npm/`, `.pi/cache/`, `.pi/tmp/`, `artifacts/tool-output/` | Ignored and rejected by validator | Credentials, OAuth/browser state, session files, package installation, caches, and unredacted output. |

The policy fails closed for unclassified paths under `.llm-wiki`, `.pi`, `evidence/raw`, and `artifacts/tool-output`. The validator scans canonical candidates for private keys, Bearer credentials, and common credential-value assignments. It is a guardrail, not a substitute for human redaction review.

## 💡 Why

Canonical Git history needs to be reproducible and auditable without disclosing broker data, source packets, or agent/session material. An `evidence/references/*.json` file conforms to [`evidence-reference-schema-v1.json`](evidence-reference-schema-v1.json) and records only an immutable `SRC-YYYY-MM-DD-NNN` ID and SHA-256 digest. The raw object is deliberately not fetched, printed, copied, or retained by this repository.

## Workflow

1. **Onboard.** Clone the repository, review this runbook and `.pi/policy.json`, and install an approved, integrity-verified Pi package locally under `.pi/npm`. Authenticate only through the approved local/runtime mechanism; never place provider keys, OAuth state, or session files in the clone.
2. **Own one branch/worktree.** Create one ticket branch from current `origin/main` and one dedicated clean worktree. Do not share a worktree or edit another engineer's generated metadata. Resolve canonical Markdown conflicts on the owning ticket branch.
3. **Capture safely.** Store raw source material only in the yet-to-be-approved immutable evidence service. Create a committed reference manifest only after its source ID and SHA-256 digest are available. Summarize/redact into a canonical page; do not paste raw material or tool output.
4. **Validate and rebuild.** From `governance/`, run `go run ./cmd/wiki-governance validate -repo-root .`, then `go run ./cmd/wiki-governance rebuild -repo-root .`. The rebuild deterministically writes the ignored `.llm-wiki/meta/registry.json` from canonical Markdown paths and content digests. Run the delivery-evidence validator for delivery manifests as required by WORK-104.
5. **Review.** Inspect `git status --ignored`, `git diff --check`, and the staged diff. A credential-like value, raw path, or unallowlisted collaboration file is a stop condition.
6. **Harness cost (WORK-123, optional).** `evidence/delivery/*.json` may carry an optional `harness` object alongside `verifications`: `{provider, model, thinkingLevel, thinkingLevelMap, usage{input,output,reasoning,cacheRead,cacheWrite,totalTokens}, cost{input,output,cacheRead,cacheWrite,total}, elapsedMs, harnessType: pi|jules, developer_id: sha256:<16hex>}`. All fields are optional; missing harness or `developer_id` remains valid and is reported as `unknown` in stratified aggregates (class × thinkingLevel × harness × developer_id). `developer_id` is `sha256(lowercase(trim(email)))[:16]` — run `node tools/telemetry/collect.mjs --manifest evidence/delivery/WORK-XXX.json --provider <id> --model <id> --harnessType pi --email $(git log -1 --pretty=format:%ae)` before committing evidence (single run, no persistent state; sessions stay gitignored per WORK-121; no Thneed). Do not commit raw prompts, transcripts, or PII.

## Clean clone, merge conflicts, and recovery

A clean clone contains canonical pages/templates/policy but no raw vault, metadata, embeddings, credentials, OAuth state, sessions, or tool output. Recreate metadata with the rebuild command above; obtain raw evidence only through an approved authorization path and validate its ID/digest out of band.

For a Markdown conflict, preserve both redacted semantic changes, keep frontmatter valid, sort list-like IDs lexically, regenerate local metadata, and rerun validation. Never resolve a conflict by copying an ignored raw file into a canonical page. For a generated-file conflict, delete the local generated file and rebuild; generated artifacts are not merged.

If a canonical artifact may contain sensitive material: stop sharing, do not amend it into another file, notify the security/incident owner through the established incident channel, revoke/rotate the affected credential through its owner, and remove the exposed Git history only under an approved incident procedure. This repository does not define that procedure or a credential system.

## Offboarding

Remove the engineer or agent's access from the approved external evidence service and provider systems, rotate credentials under the owning system's procedure, delete local worktrees/vaults/sessions according to the approved retention decision, and verify no branch or PR contains forbidden paths with `wiki-governance validate`. Do not use Git as an archive for raw evidence or credentials.

## External decision boundary — action required

The repository intentionally defines **no** external evidence provider, credential/access-control implementation, retention duration, deletion workflow, or incident ownership. Before raw evidence is shared or recovery is exercised, the parent/owner must approve: (1) the immutable evidence store, (2) least-privilege reader/writer/admin roles and audit method, (3) retention/deletion requirements, (4) access revocation/offboarding ownership, and (5) incident/escalation contact. Until then, raw evidence must remain local or otherwise outside Git and only safe IDs/digests may be committed.

## ✅ Verification

`cmd/wiki-governance` and `pkg/wikigovernance` have deterministic tests for valid and invalid policy input, classification, path and secret rejection, Git ignore safety, canonical metadata rebuild, aggregate-only inventory, and a clean Git clone. The command is executed in CI by [`.github/workflows/wiki-governance.yml`](../../../.github/workflows/wiki-governance.yml) on pull requests and pushes to `main`.

## ✨ Result

Teams can collaborate through Git on redacted knowledge and delivery references while Git configuration and the validator block local/generated, raw, and sensitive material from the governed collaboration surface.
