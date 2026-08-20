# Implementation Plan: AIDEV-158

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** XL
*   **Estimated Effort:** 1-2 weeks delivered as three serial pull requests
*   **Primary Risk:** A self-authored acceptance claim, benchmark threshold, waiver, or repository-local authority file could incorrectly unlock completion or merge.

This ticket uses three milestones under one ticket because the user selected five children: A removes unsafe merge capability; B introduces acceptance/evidence and baseline measurement without pass claims; C applies separately approved thresholds and enforcement. The user—not repository code—is the merge authority. Repository scripts never call GitHub merge, force-push, PR-body mutation, or tracker transition APIs.

Each child plan includes stable test IDs before implementation. Machine enforcement uses a strict sibling acceptance manifest bound to the plan blob, repository, immutable base, and head; Markdown table position is never an identity.

## Expected File Changes
*   `[DELETE]` `scripts/merge-train.mjs`: Remove marker minting, commit amendment, force-push, admin merge, and tracker-transition automation.
*   `[MODIFY]` `package.json`: Remove `merge-train`; add acceptance, benchmark, and evidence validators.
*   `[MODIFY]` `.agents/skills/create-implementation-plan/SKILL.md`: Require stable acceptance IDs and sibling manifest generation.
*   `[MODIFY]` `.agents/skills/project-delivery/SKILL.md`: Require complete acceptance coverage and sticky explicit merge authority.
*   `[MODIFY]` `profiles/project-profile.schema.json`: Add acceptance classes, benchmark policy, and waiver policy.
*   `[MODIFY]` `profiles/pi-sampler.json`: Declare ordinary verification, local 10M benchmark, and smaller CI regression classes.
*   `[NEW]` `governance/docs/delivery-evidence/acceptance-manifest-v1.schema.json`: Strict approved-plan row schema.
*   `[NEW]` `governance/docs/delivery-evidence/acceptance-matrix-v1.schema.json`: Strict observed/waived/blocked result schema.
*   `[NEW]` `governance/docs/delivery-evidence/benchmark-evidence-v1.schema.json`: Bounded benchmark evidence schema.
*   `[NEW]` `governance/docs/delivery-evidence/waiver-v1.schema.json`: Signed, scoped, expiring, replay-resistant waiver schema.
*   `[NEW]` `scripts/validate-delivery-waiver.mjs`: Verify waiver signatures against a trusted-base public key/configuration; no signing capability exists in repository or agent code.
*   `[MODIFY]` `governance/pkg/deliveryevidence/validator.go`: Validate immutable plan/manifest/matrix/evidence binding and class-specific verifiers.
*   `[MODIFY]` `governance/pkg/deliveryevidence/validator_test.go`: Add tamper, coverage, waiver, replay, benchmark, and blocked-row tests.
*   `[MODIFY]` `governance/cmd/delivery-evidence-validator/main.go`: Add strict validation modes.
*   `[MODIFY]` `governance/docs/delivery-evidence/README.md`: Document trust and non-authority boundaries.
*   `[NEW]` `scripts/benchmark-lesson-registry-rebuild.mjs`: Shared bounded local/CI benchmark runner.
*   `[NEW]` `tests/lesson-registry-benchmark.test.mjs`: Smaller deterministic CI regression using the same metrics.
*   `[NEW]` `tests/delivery-acceptance.test.mjs`: Manifest/matrix and delivery-skill integration tests.
*   `[MODIFY]` `.github/workflows/validate.yml`: Run schema validation and the smaller regression, never the 10M run.
*   `[NEW]` `.llm-wiki/wiki/requirements/AIDEV-133-flat-memory-rebuild.md`: Durable requirement remains unresolved until approved evidence exists; supplied by AIDEV-160 format.

Local-only, ignored artifacts include full benchmark output, environment inventory, samples, and raw traces. A bounded redacted baseline summary may be committed only in a threshold-approval follow-up, never in the same commit that first defines the runner.

## Step-by-Step Execution
1.  **Phase 1: Milestone A — immediate safety prelude**
    *   Step 1.1: Delete `merge-train` and remove its package command.
    *   Step 1.2: Audit repository scripts, workflows, reusable actions, dependencies, permissions, API clients, hooks, and tracker integrations for force-push, PR mutation, admin merge, merge, or tracker-transition capability.
    *   Step 1.3: Update skills so `do not merge` remains sticky; `Ready to merge`, refresh, push, or auto-merge language never overrides it. Only the user action `Merge PR #N` authorizes that one merge outside repository automation.
2.  **Phase 2: Milestone B — acceptance and baseline contracts**
    *   Step 2.1: Define strict acceptance manifests with normalized ASCII IDs, no duplicate/additional fields, trusted plan digest, and immutable repository/base binding.
    *   Step 2.2: Validate each row exactly once as `observed`, `waived`, or `blocked`. Observed evidence names a class-specific verifier, command definition, tool version, environment class, exit status, timestamps, and artifact digests.
    *   Step 2.3: Define waivers as signatures from a consumer-owned operator key held outside the repository, agent sessions, and subagent environment. Trusted-base configuration contains only the verifier/public key. Bind issuer/key ID, repository, PR, row, plan digest, base/head, rationale, issue, nonce, issuance/expiry, revocation reference, and single-use replay state. Candidate-authored JSON or a missing/unconfigured verifier remains blocked; there is no unsigned fallback.
    *   Step 2.4: Implement the benchmark runner with workload digest, 10,000,000 events, warmup, repetitions, timeout, event completeness, RSS sampling, robust slope estimator, runtime/hardware classification, variance, and bounded outputs.
    *   Step 2.5: Run the first controlled local baseline. Record metrics only; do not claim acceptance and do not set thresholds in the same change.
3.  **Phase 3: Human threshold decision**
    *   Step 3.1: Present baseline repetitions, peak RSS, slope, variance, runtime, and environment limits to the user.
    *   Step 3.2: Record explicit approved thresholds in a separate reviewed commit and update the AIDEV-133 requirement.
4.  **Phase 4: Milestone C — enforce**
    *   Step 4.1: Evaluate a later 10M candidate run against the approved thresholds.
    *   Step 4.2: Add the smaller CI regression using identical metric definitions but independent event-count acceptance.
    *   Step 4.3: Block completion for missing/duplicate/forged/expired/revoked rows, candidate-signed or replayed waivers, partial benchmark output, failed completeness, or unresolved requirements without a positively verified external waiver.
    *   Step 4.4: Never provide report-only completion fallback; migration gaps keep readiness blocked.

## Test Matrix
*   **Target Command**: `npm test && cd governance && go test -race ./pkg/deliveryevidence ./cmd/delivery-evidence-validator`
*   **Validation Scenarios**:
    *   [ ] `A158-T01` No repository script/workflow can mint a clean marker, force-push, admin-merge, merge, or transition Linear.
    *   [ ] `A158-T02` `Ready to merge`, `Refresh PR #N`, `Push PR #N`, and `Enable auto-merge PR #N` do not override `do not merge`.
    *   [ ] `A158-T03` Missing, duplicate, confusable, unknown, deleted, or plan-digest-mismatched acceptance IDs reject.
    *   [ ] `A158-T04` Candidate-forged attribution/signatures, missing verifier, stale, replayed, expired, revoked, wrong-repository, wrong-base/head, or wrong-row evidence/waivers reject against the trusted-base public key.
    *   [ ] `A158-T05` A linked wiki requirement remains blocked unless an explicit valid waiver exists.
    *   [ ] `A158-T06` Unit tests and the smaller CI regression cannot satisfy the 10M class.
    *   [ ] `A158-T07` First 10M run records baseline only; no threshold means no pass claim.
    *   [ ] `A158-T08` Later 10M repetitions validate event completeness, timeout, peak RSS, slope, variance, workload digest, and approved environment envelope.
    *   [ ] `A158-T09` CI regression uses the same measurement implementation but a smaller fixed event count.
    *   [ ] `A158-T10` Huge counts, malformed samples, output bombs, child-process timeout, partial files, and deep/duplicate-key JSON fail within fixed resource limits.
    *   [ ] `A158-T11` Concurrent evidence or waiver consumption cannot replace a newer result or revive revoked authority.
