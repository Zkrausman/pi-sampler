# Implementation Plan: AIDEV-159

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** XL
*   **Estimated Effort:** 5-8 days across bootstrap and activation pull requests
*   **Primary Risk:** A public marker can prove deterministic packet consistency but cannot by itself prove which model ran or that review was independent; activating a validator in the same PR that introduces it also creates a bootstrap gap.

The workflow remains two user-managed sessions. Terra owns iterative review and launches exactly one fresh final child after provisional clean. The child receives complete frozen inputs, reports only blocker/high findings, and may be resumed for at most two corrections. Each correction gets a complete newly generated packet/matrix/evidence set for the new head; delta-only review is forbidden. Child loss, timeout, provider failure, malformed receipt, or a third correction leaves the gate blocked and requires the user to decide whether to authorize a replacement.

Public model/profile fields are privacy-safe maintainer claims, not cryptographic model proof. Full lifecycle artifacts, prompts, findings, session/run IDs, usage, cost, and receipts remain local. No PR efficiency comment is generated.

## Expected File Changes
*   `[NEW]` `scripts/final-review-receipt.mjs`: Validate local Pi-subagent lifecycle artifacts, correction count, exact frozen inputs, revocation, and canonical receipt digest.
*   `[NEW]` `docs/final-review-receipt-v1.schema.json`: Strict local receipt schema and bounds.
*   `[MODIFY]` `scripts/validate-adversarial-review-attestation.mjs`: Add minimal marker v3 while freezing v2 compatibility.
*   `[MODIFY]` `scripts/generate-review-packet.mjs`: Expose versioned v3 canonical digest helpers from AIDEV-156.
*   `[MODIFY]` `.pi/agents/scoped-reviewer.md`: Define complete-input re-review, blocker/high-only output, and no mutation.
*   `[MODIFY]` `.agents/skills/project-code-review/SKILL.md`: Define Terra-parent continuity, one fresh child, same-child resume, correction cap, and failure escalation.
*   `[MODIFY]` `.agents/skills/project-delivery/SKILL.md`: Freeze/rebind inputs, invalidate stale receipts, and preserve merge-authority separation.
*   `[MODIFY]` `.github/workflows/adversarial-review.yml`: Validate v3 only through immutable trusted-base code and bounded environment inputs.
*   `[MODIFY]` `.github/pull_request_template.md`: Add minimal marker v3 and local-material prohibition.
*   `[MODIFY]` `CONTRIBUTING.md`: Document the two-session/final-child workflow and the marker's caller-claim limit.
*   `[MODIFY]` `scripts/hooks/pre-push.mjs`: Validate marker consistency without granting push or merge authority.
*   `[NEW]` `tests/final-review-receipt.test.mjs`: Lifecycle, rebinding, resume, revocation, loss, and bounds tests.
*   `[MODIFY]` `tests/adversarial-review-attestation.test.mjs`: V3 schema, privacy, exact binding, downgrade, and bootstrap tests.

Minimal public marker v3 contains only format/version, base/head, clean outcome, packet-v3 digest, acceptance-matrix digest, verification-evidence digest, reviewer model ID, review-profile version, and opaque local-receipt digest. It excludes identity, sessions, runs, transcript, findings, prompts, paths, token/usage counts, latency, and cost.

## Step-by-Step Execution
1.  **Phase 1: Bootstrap trusted validation**
    *   Step 1.1: Land marker-v3 schema parsing, privacy bounds, and trusted-base workflow support without making v3 the required gate for its own PR.
    *   Step 1.2: Keep v2 accepted only as legacy packet-consistency evidence and prevent it from satisfying the new final-gate status.
    *   Step 1.3: Activate the required v3 status only in a later PR whose base already contains the validator.
2.  **Phase 2: Final-child lifecycle**
    *   Step 2.1: Terra freezes exact repository/PR/base/head, packet v3, acceptance matrix, and verification evidence after iterative review is provisionally clean.
    *   Step 2.2: Launch exactly one fresh Terra-model child with read-only tools and the versioned review profile.
    *   Step 2.3: Record local lifecycle evidence and canonical receipt under consumer-local ignored storage, never in a checkout.
3.  **Phase 3: Corrections and invalidation**
    *   Step 3.1: Any blocker/high result or later authenticated Terra-parent blocker revokes the current clean receipt immediately, including when head is unchanged.
    *   Step 3.2: Luna fixes and pushes; Terra freezes complete inputs for the new exact head and resumes the same child.
    *   Step 3.3: Allow no more than two resumes after the initial pass. The resumed child reviews the complete candidate, not only the delta.
    *   Step 3.4: Child loss/failure or a third correction request blocks. A replacement child requires explicit user authorization and creates a new receipt lineage.
4.  **Phase 4: Render and validate the marker**
    *   Step 4.1: Render v3 only for a current clean local receipt whose every digest matches the frozen inputs.
    *   Step 4.2: CI regenerates packet v3 with trusted-base code and validates public digests/fields. It labels model/profile as maintainer-attested provenance, not external proof.
    *   Step 4.3: Passing review evidence marks the PR review-ready only; the user must separately issue `Merge PR #N`.
5.  **Phase 5: Rollback**
    *   Step 5.1: Disable v3 issuance/status if necessary while preserving local receipt history and v2 compatibility. Never silently downgrade a v3-required PR to v2.

## Test Matrix
*   **Target Command**: `node --test tests/final-review-receipt.test.mjs tests/adversarial-review-attestation.test.mjs tests/scoped-review-packet.test.mjs`
*   **Validation Scenarios**:
    *   [ ] `A159-T01` Final child starts fresh with only complete frozen packet/matrix/evidence inputs.
    *   [ ] `A159-T02` Blocker/high output creates no clean receipt and revokes any prior clean state.
    *   [ ] `A159-T03` Each correction changes bindings and the same child re-reviews the full candidate.
    *   [ ] `A159-T04` Two resumes are allowed; a third, child loss, timeout, provider failure, or corrupted artifact keeps the gate blocked.
    *   [ ] `A159-T05` A later valid blocker revokes a clean receipt even when `HEAD` is unchanged.
    *   [ ] `A159-T06` Wrong child lineage, model, profile, repository, PR, base/head, packet, matrix, evidence, nonce, or revoked receipt rejects.
    *   [ ] `A159-T07` Marker containing personal identity, session/run ID, transcript, finding text, path, usage/tokens, latency, or cost rejects.
    *   [ ] `A159-T08` Model/profile fields are bounded and explicitly classified as maintainer-attested caller claims.
    *   [ ] `A159-T09` Existing v2 fixtures validate as legacy consistency only and cannot satisfy v3 final review.
    *   [ ] `A159-T10` Trusted workflow uses pinned actions, read-only permissions, trusted-base code, bounded environment data, redacted logs, and no candidate dependencies.
    *   [ ] `A159-T11` Bootstrap PR does not enforce its own new validator; activation succeeds only after the validator is on base.
