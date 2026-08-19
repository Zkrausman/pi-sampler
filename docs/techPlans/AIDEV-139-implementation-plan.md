# Implementation Plan: AIDEV-139 (Self-Evolution Acceptance Scenario)

## Effort & Risk
* **Effort Level:** High. This is a program acceptance gate requiring end-to-end orchestration of the entire self-evolution loop, from ingestion to meta-evolution, rollback, and audit compilation.
* **Risk Level:** High. The execution requires strict adherence to a frozen plan to prevent implicit tuning. It tests the integrity of all prerequisite systems and enforces robust fail-closed, memory-safe, and secure file-system operations.

## Expected File Changes

* **New Artifacts & Test Harness Files:**
  * `tests/acceptance/aidev139-cohort-definition.json` (The predeclared frozen cohort: task classes, models, success/failure mix, holdouts, seeded regressions, and thresholds).
  * `tests/acceptance/run-self-evolution-scenario.mjs` (or equivalent shell/Go orchestrator to execute the frozen plan).
  * `docs/reports/AIDEV-139-acceptance-audit.md` (The generated, human-readable artifact explaining the complete evolution history, rollbacks, and citations).

* **Modified Files:**
  * Adjustments to ledger and ingestion mechanisms strictly to configure cryptographic freezing of validation rules, strict pagination parameters, and fail-closed timeout boundaries.

## Step-by-Step Execution

1. **Predeclaration & Freezing (The Frozen Plan)**
   * Define the complete representative cohort in `tests/acceptance/aidev139-cohort-definition.json` with sample sizes, holdouts, a seeded bad lesson, and a canary-regression seed.
   * **Cycle-Dependency Safeguard:** Cryptographically freeze or strictly isolate orchestration, validation, and holdout evaluation code. Evolutions are strictly restricted from modifying the pipeline's own governance rules to prevent auto-approving meta-evolution loops.

2. **Cohort Execution & Secure Evidence Capture**
   * Run the test harness orchestrator `run-self-evolution-scenario.mjs` to execute the task cohort.
   * **State Leakage Safeguard:** Perform mandatory sanitization and boundary-checking to strip unrelated task state and sensitive conversational context *before* anything is written to the ledger.
   * **Symlink Trap Safeguard:** Explicitly reject symlink escapes and rigorously verify file descriptors before ingestion to prevent path traversal traps from capturing arbitrary files.
   * Publish the sanitized authoritative evidence to the `episode-evolution-ledger`.

3. **Retrospective & Curation Phase**
   * Trigger the system to produce isolated retrospectives from the cohort data.
   * **Governance Integrity:** Curation must be performed by an actual independent reviewer using a separate clean worktree and identity. If independent review is not possible, the system must fail-closed. No simulated curation is permitted.
   * Verify that generated retrospectives contain valid citations to the ledger.

4. **Holdout Evaluation & Adversarial Defense**
   * Replay the curated lessons against the protected holdout sets defined in step 1.
   * Assert that the system blocks the intentionally "bad" lesson from promotion.
   * **Fail-Closed Assertion:** If holdout evaluation times out, crashes, or is otherwise unreachable, it must fail-closed and reject the lesson.

5. **Canary Regression & Automated Rollback**
   * Promote an approved change that contains the seeded canary regression onto bounded work.
   * Monitor the execution logs/ledgers to trigger the regression.
   * Assert that the orchestrator detects the failure and executes an automated rollback within the predeclared threshold.
   * **Fail-Closed Assertion:** If the monitor or automated rollback mechanism crashes or goes offline, the pipeline must fail-closed, halting all execution immediately rather than leaving the regression active.

6. **Audit & OOM-Safe Reconciliation Publication**
   * **OOM Vulnerability Safeguard:** Run a reconciliation script to verify the Episode and Evolution Ledgers align perfectly, strictly using bounded pagination, streaming, or chunked processing to ensure OOM safety regardless of ledger size.
   * Generate `AIDEV-139-acceptance-audit.md` summarizing what changed, why, evidence citations, decision makers, results, and recovery history. Ensure the audit is fully understandable by a human without reading implementation code.

## Test Matrix

* **Ledger Reconciliation (OOM-Safe) Check**: Verify episode and evolution ledgers reconcile exactly, utilizing chunked processing; simulate a massive dataset to guarantee memory stability.
* **Sanitization & Traversal Check**: Assert that evidence capture properly handles a malicious symlink trap by rejecting the ingestion, and verify unrelated state is stripped before ledger insertion.
* **Governance Freeze Check**: Validate that a lesson attempting to modify the orchestration or holdout evaluation logic is immediately rejected by the cryptographic freeze boundary.
* **Fail-Closed Threshold Checks**:
  * Verify a timed-out holdout evaluation results in a rejected lesson.
  * Verify a crashed monitor during the canary phase results in an immediate execution halt.
* **Adversarial Holdout Check**: Validate that the intentionally bad lesson is definitively rejected during the holdout evaluation phase.
* **Canary Detection & Rollback Check**: Validate that the seeded regression is detected during the canary phase and automatically rolled back before the error threshold is breached.
