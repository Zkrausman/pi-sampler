# Implementation Plan: AIDEV-155

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** XL
*   **Estimated Effort:** 2-4 weeks across five child tickets and serial reviewed milestones
*   **Primary Risk:** Treating repository-local policy or a maintainer-authored marker as stronger authority than it is, while shared Git state, merge capability, review evidence, and public wiki writes cross trust boundaries.

This umbrella coordinates five children: AIDEV-156 through AIDEV-160. AIDEV-161 is related but remains outside this implementation boundary. The workflow has two user-managed sessions: a Luna writer and a Terra reviewer. Terra may launch one fresh final-review child; that child reports only blocker/high findings and may be resumed for at most two correction passes.

Trust boundaries:

*   The writer owns only its leased implementation checkout and may not merge.
*   Review clones have separate Git config/object storage with no hard links or alternates to writer repositories.
*   The Terra parent owns iterative review and may not edit the candidate or merge.
*   The final child receives only frozen packet, acceptance, and validation evidence and has no mutation tools.
*   Repository scripts provide deterministic validation, not proof of user authority or model execution.
*   Acceptance waivers require a consumer-owned signing key outside repository/agent access and a trusted-base public verifier; unsigned or candidate-signed waivers remain blocked.
*   The user remains the only merge authority; `do not merge` stays active until the exact instruction `Merge PR #N`.
*   Raw packets, findings, prompts, sessions, receipts, token/cost data, and benchmark output remain local. Public markers contain bounded commit-binding metadata only.
*   Wiki candidates from either role are local until an explicit classify-and-curate handoff publishes a redacted canonical page.

Required landing order and ownership:

1. AIDEV-158 safety prelude removes `merge-train` and automatic merge/force-push/marker-minting capability.
2. AIDEV-157 adds isolated managed review workspaces and safe quarantine cleanup.
3. AIDEV-156 adds packet v3 and retains v2 compatibility validation.
4. AIDEV-160 milestone A adds trusted-base read-only wiki policy and requirements; milestone B later adds transactional curation.
5. AIDEV-158 milestones B/C add acceptance manifests, benchmark baseline/approval, and enforcement.
6. AIDEV-159 milestone A lands trusted validator/schema changes; milestone B activates the final-child gate on a later base.

A child that edits a shared contract owns that file for its milestone. Every successor rebases onto the exact merged predecessor, regenerates evidence, reruns the full suite, and updates its plan only through a separately reviewed planning change. No child is implemented from the umbrella branch.

## Expected File Changes
*   `[NEW]` `docs/techPlans/AIDEV-156-implementation-plan.md`: Packet readability child plan.
*   `[NEW]` `docs/techPlans/AIDEV-157-implementation-plan.md`: Review workspace child plan.
*   `[NEW]` `docs/techPlans/AIDEV-158-implementation-plan.md`: Acceptance and merge-authority child plan.
*   `[NEW]` `docs/techPlans/AIDEV-159-implementation-plan.md`: Final Terra-child and attestation child plan.
*   `[NEW]` `docs/techPlans/AIDEV-160-implementation-plan.md`: Wiki candidate and requirements child plan.
*   `[NEW]` `docs/techPlans/AIDEV-161-implementation-plan.md`: Separate threat-boundary follow-up plan.

Implementation files are enumerated in each child plan. This umbrella changes no runtime behavior.

## Step-by-Step Execution
1.  **Phase 1: Freeze contracts and remove immediate capability risk**
    *   Step 1.1: Merge this planning PR so every child plan exists on the immutable base before implementation provisioning.
    *   Step 1.2: Deliver only AIDEV-158 milestone A: remove `scripts/merge-train.mjs`, its package command, and any repository-owned force-push/admin-merge/attestation-minting path.
    *   Step 1.3: Confirm GitHub workflow write permissions and branch protection still require user-owned merge action.
2.  **Phase 2: Establish safe evidence workspaces and transport**
    *   Step 2.1: Deliver AIDEV-157 using disposable isolated review clones, not linked worktrees that share common Git configuration.
    *   Step 2.2: Deliver AIDEV-156 packet v3 with bounded physical lines and deterministic reconstruction.
3.  **Phase 3: Establish wiki and acceptance contracts**
    *   Step 3.1: Deliver AIDEV-160 milestone A read-only policy and `wiki/requirements/` support from trusted-base validation.
    *   Step 3.2: Deliver AIDEV-158 milestone B acceptance manifests and benchmark runner; run the 10M baseline without claiming pass/fail.
    *   Step 3.3: Obtain explicit threshold approval, then deliver AIDEV-158 milestone C enforcement and smaller CI regression.
    *   Step 3.4: Deliver AIDEV-160 milestone B transactional curation after read-only policy is trusted.
4.  **Phase 4: Activate the final review gate**
    *   Step 4.1: Deliver AIDEV-159 milestone A schema/validator/bootstrap support.
    *   Step 4.2: On a later base, deliver milestone B orchestration and required check activation.
    *   Step 4.3: Run one complete two-session acceptance scenario without auto-merge.
5.  **Phase 5: Operational remediation and closeout**
    *   Step 5.1: Use AIDEV-157's separately approved dry-run runbook to quarantine and remove only positively verified PR #150 review workspaces and exact polluted local Git keys.
    *   Step 5.2: Use AIDEV-160 curation to inventory current AIDEV-133/PR #150 candidates; preserve useful knowledge and publish only approved canonical pages.
    *   Step 5.3: Keep AIDEV-161 separate and blocked on its explicit threat-model decision.

## Test Matrix
*   **Target Command**: `npm ci && npm test`
*   **Target Command**: `cd governance && go test -race ./... && go vet ./...`
*   **Validation Scenarios**:
    *   [ ] `A155-T01` Every child implementation is provisioned only after its plan is merged on the selected immutable base.
    *   [ ] `A155-T02` Repository search and workflow audit find no repository-owned force-push, admin-merge, clean-marker minting, or tracker-transition path.
    *   [ ] `A155-T03` A linked reviewer cannot mutate the writer repository's common Git configuration because reviews use isolated managed clones.
    *   [ ] `A155-T04` A 55 KiB multiline patch is fully reviewable without changing candidate source.
    *   [ ] `A155-T05` Every acceptance row is observed, explicitly waived, or blocking; unit tests cannot satisfy benchmark classes.
    *   [ ] `A155-T06` The 10M baseline is measured before thresholds are approved; a later run is evaluated against the approved threshold and CI runs a smaller regression.
    *   [ ] `A155-T07` Terra launches one fresh final child, resumes only that child at most twice, and remains blocked after child loss, timeout, or a third correction request.
    *   [ ] `A155-T08` `Ready to merge`, refresh, push, and auto-merge language do not override a prior `do not merge`.
    *   [ ] `A155-T09` Implementer and reviewer candidates receive the same four-way classification, while new raw public `obs-*` pages are rejected by default.
    *   [ ] `A155-T10` Trusted-base bootstrap is demonstrated: validator changes land before they become required checks.
    *   [ ] `A155-T11` Operational cleanup quarantines only exact clean known resources and preserves dirty, ignored, nested, changed, locked, or uncertain content.
    *   [ ] `A155-T12` Wiki curation crash injection recovers the complete old or complete new page/index set, and concurrent Git-config remediation refuses rather than overwriting unrelated edits.
