# Implementation Plan: ZAR-126

## Effort & Risk Analysis
*   **Complexity:** Medium
*   **Estimated Effort:** 2-4 hours
*   **Primary Risk:** The onboarding documentation fails to guide users on commit graph corruption (e.g., from rebases), or is placed in a non-governed path, causing the Wiki Governance Gate to fail and blocking new engineers from merging their first delivery.

## Expected File Changes
*   `[NEW]` `.llm-wiki/wiki/onboarding/ai_delivery_onboarding.md`: *Primary onboarding document for new engineers on the AI delivery and Pi system. (Note: Placed here instead of `docs/runbooks/` to strictly comply with the `path-policy-v1.json` `canonical_versioned` allowlist).*
*   `[MODIFY]` `README.md`: *Add a reference link pointing new engineers to `.llm-wiki/wiki/onboarding/ai_delivery_onboarding.md`.*

## Step-by-Step Execution
1.  **Phase 1: Project Setup & Document Governance**
    *   Step 1.1: Create `.llm-wiki/wiki/onboarding/ai_delivery_onboarding.md` with the required YAML frontmatter (ownership tags, creation date) to comply with OKF specifications.
    *   Step 1.2: Detail local environment setup covering Pi package installations (`.pi/settings.json local:./tools/*` pattern) and project trust.
    *   Step 1.3: Document the Wiki tools (`wiki_recall/capture/ingest/lint`) and explain the path policy allowlist for `.llm-wiki/wiki/**/*.md`.
2.  **Phase 2: Delivery Commit Pattern & Recovery**
    *   Step 2.1: Explain the 2-commit evidence pattern (Delivery commit followed by Evidence commit) and why `review_ready` remains parent-bound to avoid circular hash dependencies.
    *   Step 2.2: Add a critical recovery section detailing how to handle git rebases, squashes, or `--amend` which corrupt the parent-bound commit graph, including how to re-generate evidence.
3.  **Phase 3: CI Gates & PR Bypass Conventions**
    *   Step 3.1: Document the PR Delivery Evidence Gate (ancestor validation) and the Wiki Governance Gate.
    *   Step 3.2: Explicitly define the bypass constraints: PR titles must be prefixed with `[housekeeping]` or `[evolution]` to skip manifest checks for wiki-only or chore PRs.
4.  **Phase 4: Operator Tooling & Emergency Separation**
    *   Step 4.1: Document the standard operator use cases: ledger (`tools/pi-delivery-controller/ledger.mjs`), evaluation ledger, orchestrator, and quotas.
    *   Step 4.2: Explicitly separate emergency procedures (`$GELT_DELIVERY_KILL_SWITCH`) by linking to a dedicated, access-controlled operational runbook (`docs/runbooks/autonomous-delivery-runbook.md`) rather than detailing them in the new engineer onboarding doc.

## Test Matrix
*   **Target Command**: `go run ./cmd/wiki-governance validate -repo-root . && go run ./cmd/wiki-governance lint -repo-root .`
*   **Validation Scenarios**:
    *   [ ] **Scenario A (Happy Path / Wiki Validation):** The new document passes all governance tests without sensitive leaks.
    *   [ ] **Scenario B (Negative Test - CI Gate Rejection):** Push a 1-commit PR and an inverted-commit PR (evidence commit before delivery commit) to verify the pipeline fails with the correct, readable error pointing to the onboarding doc.
    *   [ ] **Scenario C (Bypass Test):** Open a PR with the `[housekeeping]` title prefix containing only wiki changes and ensure the delivery manifest CI gate is bypassed.
    *   [ ] **Scenario D (CI Environment Parity):** Open a Draft PR to ensure the GitHub Actions/CI runners execute the validation logic correctly and parity is maintained with local `go run ./cmd/wiki-governance...`.
    *   [ ] **Scenario E (Dry Run):** A reviewer performs a human dry-run following the onboarding document on a fresh clone to install packages, understand the 2-commit rule, and execute offline validation.
