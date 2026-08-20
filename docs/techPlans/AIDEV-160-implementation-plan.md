# Implementation Plan: AIDEV-160

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** XL
*   **Estimated Effort:** 5-8 days in two serial pull requests
*   **Primary Risk:** Candidate-controlled policy or free-form wiki content could bless its own publication, delete useful legacy knowledge, leak sensitive session material, or mutate a checkout not owned by the current run.

Milestone A is read-only governance: trusted-base policy, requirements schema, candidate schema, and validation. Milestone B enables transactional curation only after A is on the protected base. Implementers and reviewers have equal candidate-generation rights but neither automatically publishes. Reviewer candidates travel through a bounded local broker/output artifact rather than direct writes to the public repository.

Current PR #150/AIDEV-133 pages receive a separate operational inventory and human per-page decision. No implementation command bulk-deletes or rewrites them.

## Expected File Changes
*   `[NEW]` `docs/wiki-governance/path-policy-v1.json`: Public-root policy consumed from trusted base.
*   `[NEW]` `docs/wiki-governance/candidate-manifest-v1.schema.json`: Strict bounded candidate/disposition schema.
*   `[NEW]` `docs/wiki-governance/requirement-v1.schema.json`: Strict requirement/frontmatter schema.
*   `[MODIFY]` `governance/pkg/wikigovernance/policy.go`: Explicit policy path, overlap rejection, trusted-base policy input, requirement/candidate semantics.
*   `[MODIFY]` `governance/pkg/wikigovernance/repository.go`: Read-only diff validation, transactional curation primitives, exact checkout/lease binding.
*   `[MODIFY]` `governance/cmd/wiki-governance/main.go`: Separate validate and authorized curate modes.
*   `[MODIFY]` `governance/pkg/wikigovernance/policy_test.go`: Policy, overlap, trusted-base, requirement, legacy, and schema tests.
*   `[MODIFY]` `governance/pkg/wikigovernance/repository_test.go`: Transaction, concurrent edit, cross-checkout, and hostile filesystem tests.
*   `[MODIFY]` `.github/workflows/wiki-governance.yml`: Validate candidate wiki diff with immutable base policy/code.
*   `[MODIFY]` `.gitignore`: Ignore local candidate inbox, raw benchmark/evidence, receipts, and curation staging.
*   `[MODIFY]` `.llm-wiki/WIKI_SCHEMA.md`: Define candidate classification and requirement semantics.
*   `[MODIFY]` `.llm-wiki/config.json`: Register requirements collection/template.
*   `[NEW]` `.llm-wiki/templates/requirement.md`: Canonical requirement template.
*   `[NEW]` `.llm-wiki/wiki/requirements/index.md`: Canonical requirements index.
*   `[MODIFY]` `.llm-wiki/wiki/index.md`: Link requirements.
*   `[MODIFY]` `.llm-wiki/wiki/decisions/index.md`: Distinguish decisions from requirements.
*   `[MODIFY]` `.llm-wiki/wiki/changes/index.md`: Distinguish final outcomes from candidates.
*   `[NEW]` `scripts/wiki-candidate.mjs`: Write bounded candidates only to a consumer-local inbox and produce deterministic manifests.
*   `[NEW]` `scripts/curate-wiki-candidates.mjs`: Materialize explicitly selected canonical pages through a durable journal/recovery protocol in the assigned leased worktree.
*   `[MODIFY]` `CONTRIBUTING.md`: Document four dispositions and human per-page publication review.
*   `[MODIFY]` `.agents/skills/project-delivery/SKILL.md`: Implementer candidate generation and final classification handoff.
*   `[MODIFY]` `.agents/skills/project-code-review/SKILL.md`: Reviewer candidate generation through local output only.
*   `[MODIFY]` `.agents/skills/wiki-governance-scrub/SKILL.md`: Trusted policy, requirements, and transactional curation.
*   `[MODIFY]` `tests/wiki-tracking-policy.test.mjs`: Root policy, ignore, requirements, and candidate coverage.
*   `[NEW]` `docs/runbooks/aidev-133-wiki-candidate-curation.md`: Safe inventory and human curation procedure without machine paths or raw content.

## Step-by-Step Execution
1.  **Phase 1: Milestone A — trusted read-only policy**
    *   Step 1.1: Add a public-root policy and make CI load validator code and policy from immutable base when evaluating a PR wiki diff.
    *   Step 1.2: Reject all path-class overlaps at policy load. Sensitive/raw/generated classes are never made canonical through precedence.
    *   Step 1.3: Preserve every existing tracked legacy page by default. Reject added or modified public `sources/obs-*` pages unless a separately approved migration changes policy; candidates cannot edit an exception inventory to bless themselves.
    *   Step 1.4: Add strict requirement schema: version, normalized issue/slug, bounded statement/rationale/references, status/priority enums, created/updated/last-reviewed dates, no extra or duplicate fields, and index consistency.
    *   Step 1.5: Add strict four-way candidate disposition schema: `current-pr`, `focused-wiki-pr`, `local-only-memory`, `unsafe-rejected`.
2.  **Phase 2: Candidate production**
    *   Step 2.1: Implementer and reviewer can create bounded local candidates with role, issue, proposed target/type, statement, rationale, provenance references, sensitivity scan result, and content digest.
    *   Step 2.2: Candidate free text is bounded and redacted; prompts, transcripts, raw tool output, credentials, personal identifiers, absolute paths, lease tokens, sessions, and unredacted evidence cannot be promoted.
    *   Step 2.3: Reviewer candidates are returned through the local broker/output channel and do not write the candidate branch or primary checkout.
3.  **Phase 3: Milestone B — transactional curation**
    *   Step 3.1: Require explicit human per-file disposition plus exact canonical target, assigned worktree real path, common Git identity, lease nonce, expected head, and expected destination absence/digest.
    *   Step 3.2: Acquire a curation lock, stage selected pages/index changes in a temporary sibling, validate the complete projected repository, and durably write/fsync a journal containing before/after digests, ordered publication steps, expected checkout identity, and recovery direction before touching destinations.
    *   Step 3.3: Publish each file through same-directory temporary files and atomic rename where supported, fsync files/directories, and advance the journal with compare-and-swap. On startup or error, recovery uses exact digests to roll the entire set forward or back; unrelated concurrent edits cause refusal rather than overwrite. Reject symlink/junction/case-alias/root-swap/nested-repo attacks.
    *   Step 3.4: Inject crashes after every journal, file, rename, index, and directory-sync boundary and prove recovery yields the complete old or complete new projected wiki—never a silently accepted partial state. Preserve journal/staging for manual recovery when the platform cannot prove safe atomic behavior.
    *   Step 3.5: Directly related durable pages may enter the current PR; unrelated durable pages require a focused wiki PR; local and unsafe dispositions never enter Git.
4.  **Phase 4: Historical curation runbook**
    *   Step 4.1: Inventory current PR #150/AIDEV-133 candidates without deleting or staging anything.
    *   Step 4.2: Obtain human per-page decisions, synthesize useful material into decisions/changes/requirements, and verify no knowledge is lost before any transient local page is removed.
    *   Step 4.3: Keep raw inventory and rejected content local; commit only the approved redacted canonical diff in a focused PR when unrelated to current code.
5.  **Phase 5: Rollback**
    *   Step 5.1: Disable mutation-capable curation while retaining trusted read-only policy, raw ignores, requirements schema, and local candidate evidence. Never restore automatic `obs-*` publication.

## Test Matrix
*   **Target Command**: `node --test tests/wiki-tracking-policy.test.mjs && cd governance && go test -race ./pkg/wikigovernance ./cmd/wiki-governance`
*   **Validation Scenarios**:
    *   [ ] `A160-T01` PR validation uses immutable base policy/code and cannot approve a candidate's self-modified policy.
    *   [ ] `A160-T02` Canonical/sensitive, canonical/raw, canonical/generated, or other class overlap rejects policy loading.
    *   [ ] `A160-T03` Existing legacy observation deletion, rename, modification, or same-PR exception tampering rejects.
    *   [ ] `A160-T04` Implementer and reviewer candidates use the same bounded schema and dispositions.
    *   [ ] `A160-T05` Unknown role/disposition/type, missing rationale/traceability, raw output, secrets, paths, tokens, sessions, or oversized/deep/duplicate-key data rejects.
    *   [ ] `A160-T06` Valid requirement page and index pass; invalid name, issue, status, priority, dates, fields, or missing index entry reject.
    *   [ ] `A160-T07` A new or modified public `sources/obs-*` page rejects by default while unchanged legacy pages remain preserved.
    *   [ ] `A160-T08` A lease for another checkout, changed head, root swap, symlink/junction, case alias, or concurrent destination edit blocks curation.
    *   [ ] `A160-T09` Ordinary failure and process-kill injection after every publication boundary recover to the complete old or complete new pages/indexes, never an accepted partial state; concurrent edits are preserved and staging/journal remain auditable.
    *   [ ] `A160-T10` Current-PR, focused-wiki-PR, local-only, and unsafe dispositions produce exactly their documented Git effects.
    *   [ ] `A160-T11` Metadata/index rebuild uses a pinned tool version and detects backlink/index loss or drift before publication.
