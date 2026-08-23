# Implementation Plan: AIDEV-182

## 1. Effort & Risk Analysis
*   **Complexity (T-Shirt):** L
*   **Estimated Effort:** 2 weeks
*   **Primary Risk:** Allowing automated commits or merges without manual operator review, or drift between the exact planning base and execution base causing out-of-sync implementations.

### Trusted Planning Handoff
The initial lead planner is Gemini running manually in Antigravity. Gemini receives the exact-base planning requirements and research, then produces the uncommitted implementation plan and sibling acceptance manifest. Gemini must not be represented or invoked as a Pi provider/model. Implementation, review, publication, and merge authority remain separate.

## 2. Expected File Changes
*   `[MODIFY]` `.agents/skills/create-implementation-plan/SKILL.md`: Update to become the single canonical planning skill. Strip automatic commit/push/PR and Linear SDLC sync capabilities. Add instructions for epic planning metadata, exact-base worktree provisioning, and manual Antigravity handoff.
*   `[DELETE]` `.agents/skills/create-implementation-plan-team/SKILL.md`: Delete redundant team wrapper.
*   `[MODIFY]` `tests/implementation-plan-skills.test.mjs`: Migrate and strengthen existing tests to enforce uncommitted-only authority, manual handoff, and exact-base constraints, using AIDEV-132 through AIDEV-140 as a read-only audit corpus.
*   `[NEW]` `contracts/implementation-plan-manifest-v2.mjs`: Define executable TypeBox schemas for `implementation-plan-manifest/v2`, supporting epic metadata, dependencies, and maintaining v1 backward compatibility.
*   `[NEW]` `scripts/export-implementation-plan-manifest-v2-schema.mjs`: Schema export script for the v2 manifest.
*   `[NEW]` `contracts/implementation-plan-manifest-v2.schema.json`: Generated JSON Schema artifact for the v2 manifest.
*   `[NEW]` `scripts/validate-implementation-plan.mjs`: Executable deterministic local validation utility.
*   `[NEW]` `tests/implementation-plan-manifest-v2.test.mjs`: Parity tests proving runtime and generated-schema agreement, alongside independently authored negative fixtures.
*   `[NEW]` `docs/IMPLEMENTATION-PLANNING.md`: Authoritative repository documentation target specifying canonical workflow and migration procedures.

## 3. Step-by-Step Execution

1.  **Phase 1: Canonical Skill Consolidation & Documentation**
    *   **Step 1.1**: Modify `.agents/skills/create-implementation-plan/SKILL.md` to be the sole canonical workflow. Explicitly instruct the skill to provision an exact-base leased planning worktree using `scripts/delivery-worktree.mjs` (`prepare --purpose plan`), then halt and instruct the operator to open it manually in Antigravity. Remove automatic lifecycle mutations; output must strictly be uncommitted planning artifacts. Delete `.agents/skills/create-implementation-plan-team/SKILL.md`.
    *   **Step 1.2**: Create `docs/IMPLEMENTATION-PLANNING.md`. Specify the canonical skill name and invocation, migration from `create-implementation-plan-team`, removal/deprecation behavior, manual Antigravity workflow, artifact formats, authority boundaries, validation, and review procedure. Detail a rollback procedure that restores the prior skill version without restoring automatic publication authority. Explain how existing v1 plans remain valid. Add tests ensuring documentation and canonical-skill behavior remain synchronized.

2.  **Phase 2: Implementation Plan Manifest v2 Contract**
    *   **Step 2.1**: Implement `contracts/implementation-plan-manifest-v2.mjs`. The manifest must be `implementation-plan-manifest/v2` and contain fields for: plan digest and planning base, ticket and repository revisions, acceptance rows, hard dependencies, expected predecessor outputs, owned files/symbols/contracts, compatibility assumptions, staleness triggers, just-in-time revalidation inputs, and bounded AIDEV-184/AIDEV-185 portfolio metadata. Ensure read and validation backward-compatibility for existing `acceptance-manifest/v1` plans. Do not silently rewrite historic manifests.
    *   **Step 2.2**: Create `scripts/export-implementation-plan-manifest-v2-schema.mjs` and export the generated JSON Schema to `contracts/implementation-plan-manifest-v2.schema.json`.

3.  **Phase 3: Implementation-Ready Deterministic Validator**
    *   **Step 3.1**: Implement `scripts/validate-implementation-plan.mjs`. Specify bounded CLI/library inputs. Require an exact 40- or 64-character immutable commit-object identity. Reject refs, branches, tags, short SHAs, and non-commit objects. Read Git objects from the declared planning base. Use POSIX repository-relative path normalization; reject absolute paths, drive paths, backslashes, traversal, NULs, aliases, and oversized paths. Modified/deleted/existing paths must exist at the planning base; new paths must not collide with an existing base path unless explicitly classified as replacement.
    *   **Step 3.2**: Cited source files must be bounded regular UTF-8 blobs; cited symbols must use a concrete bounded representation and deterministic lookup. Enforce plan and manifest byte limits, and JSON depth, collection, string, dependency, acceptance-row, and metadata bounds. Calculate SHA-256 plan digest over exact UTF-8 bytes. Enforce exact acceptance-ID parity, and ticket/repository revision validation. Return deterministic bounded JSON result envelope and diagnostic codes. Nonzero exit for every invalid or indeterminate result.
    *   **Step 3.3**: Ensure the validator performs no execution of cited files, hooks, prompts, or candidate-provided commands. Perform no filesystem, Git configuration, branch, PR, or tracker mutation. Treat historical-object absence as a bounded indeterminate/fail-closed result, avoiding mislabeling as a shallow clone.

4.  **Phase 4: Test Implementation and Negative Fixtures**
    *   **Step 4.1**: Implement tests demonstrating validation and planning-skill capabilities using the existing plans for `AIDEV-132` through `AIDEV-140` as a bounded read-only audit corpus. Do not rewrite those plans. Specify independently maintained expected diagnostic classes for tests to verify detection of: invented/stale paths/APIs, weak repository grounding, vague security mechanisms, missing acceptance coverage, oversized scope, weak verification commands, and unsupported platform guarantees.
    *   **Step 4.2**: Implement exact runtime/generated-schema parity verification.
    *   **Step 4.3**: Add independently authored negative tests explicitly testing: malformed JSON; oversized plan/manifest; excessive JSON depth/collection counts; traversal and encoded traversal; absolute Windows/Unix paths; backslashes and drive/device paths; short SHA, ref, tag, branch, and non-commit object inputs; modified/deleted paths missing from the base; unexpected new-path collision; missing/ambiguous symbol citations; binary and invalid UTF-8 cited files; plan digest mismatch; acceptance-ID mismatch and duplication; stale ticket/repository revisions; unavailable historical Git objects; and runtime/generated-schema drift.

5.  **Phase 5: Bootstrap, Migration, and Review Discipline**
    *   **Step 5.1 (Bootstrap/Migration Statement)**: AIDEV-182’s own plan remains `acceptance-manifest/v1`. AIDEV-182 implementation introduces v2. New plans use v2 only after the v2 contract and canonical skill merge into the trusted base. Historical v1 manifests remain readable and are not silently rewritten.
    *   **Step 5.2 (Review Discipline)**: Every finding must be classified as defect, hardening, or preference. Only reproducible defects tied to explicit acceptance, trusted invariants, documented contracts, or concrete material harm block the plan. Hardening and preferences remain non-blocking. Adversarial review occurs only for trusted high/critical risk or explicit threat triggers. Do not ratchet requirements. Limit ordinary architect revision passes to at most two; unresolved contradictions or scope above XL escalate to a human. Independent review cannot edit the plan it reviews.

## 4. Review Evidence Flow
The exact trusted base selects post-activation v3 evidence. Complete packet, acceptance matrix, and verification inputs are frozen before the review starts. The current receipt is revalidated before publication, and any revocation invalidates a same-head marker. Legacy v2 is preserved strictly for bootstrap compatibility on old bases; v3 is the default after activation.

## 5. Test Matrix
*   **Target Command**: `npm test`
*   **Validation Scenarios**:
    *   [ ] A182-T01: Canonical-skill migration ensures `create-implementation-plan` is strictly manual handoff, deleting team wrapper, synchronizing behavior with docs/IMPLEMENTATION-PLANNING.md.
    *   [ ] A182-T02: Manual Antigravity handoff uses Gemini as the initial lead planner; Gemini receives the exact-base planning requirements and research and produces the uncommitted implementation plan and sibling manifest. Gemini must not be represented or invoked as a Pi provider/model; implementation, review, publication, and merge authority remain separate, with no automatic lifecycle authority.
    *   [ ] A182-T03: Exact-base worktree provisioning is verified by tests, bounded by `scripts/delivery-worktree.mjs` contract.
    *   [ ] A182-T04: Deterministic validator ensures strict bounds (40/64 char SHA, Posix paths, no execution mutations) and rejects drift, missing objects, or traversal.
    *   [ ] A182-T05: Implement implementation-plan-manifest/v2 with TypeBox schema and export script at `contracts/implementation-plan-manifest-v2.schema.json`.
    *   [ ] A182-T06: Exact runtime and generated-schema parity verification.
    *   [ ] A182-T07: Existing acceptance-manifest/v1 plans retain read and validation compatibility; no silent rewrites.
    *   [ ] A182-T08: V2 manifest carries hard dependencies, predecessor outputs, and portfolio metadata for independently reviewable per-ticket plans.
    *   [ ] A182-T09: Explicit staleness triggers; refrains from declaring full campaign staleness when relevant inputs are unchanged.
    *   [ ] A182-T10: Digest and acceptance IDs match exactly between plan and manifest; calculated over exact UTF-8 bytes.
    *   [ ] A182-T11: Audit corpus AIDEV-132–AIDEV-140 tests detect stale paths, vague mechanisms, missing coverage, without rewriting those plans.
    *   [ ] A182-T12: Independent negative tests verify malformed JSON, oversized bounds, traversal escapes, missing objects, and schema drift.
    *   [ ] A182-T13: Review finding discipline correctly applies defect vs preference, bounding adversarial paths and revision loops.
    *   [ ] A182-T14: V1-to-V2 Bootstrap boundary validation ensures AIDEV-182 emits a valid v1 artifact until v2 merges.
    *   [ ] A182-T15: Re-evaluation of rollback constraints correctly restores previous skill versions without auto-publication.
