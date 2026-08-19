# Implementation Plan: AIDEV-135 (Promotion, Canaries, Monitoring, Rollback, Meta-Metrics)

**Estimate:** XL

## Effort & Risk
*   **Effort:** XL. This ticket partitions the core automated evolution machinery into five dense execution slices. Implementing streaming queries, cross-boundary cryptographic validation, strict path sanitization, and crash-safe ledger state machines requires careful staging across multiple child pull requests.
*   **Risk:** High. Automated evolution mechanisms are high-value targets for both accidental failures and malicious escalation. Strict path boundary enforcement, aggressive secret redaction, and independent cryptographic validation are required to prevent directory traversal attacks, immutable data leaks, and cyclic governance bypasses.

## Expected File Changes
*   `contracts/promotion-v1.mjs` (New): Defines versioned artifact bindings and out-of-band locks against automated self-modification.
*   `contracts/canary-v1.mjs` (New): Defines canary execution bounds, target cohorts, and predeclared success/harm thresholds.
*   `contracts/monitoring-v1.mjs` (New): Defines observation standards, threshold comparisons, and missing-evidence handling behavior.
*   `contracts/rollback-v1.mjs` (New): Defines rollback intents, recovery schemas, and pre-append state redaction interfaces.
*   `contracts/meta-evolution-v1.mjs` (New): Defines streaming and cursor-based query structures for metric aggregation schemas.
*   `contracts/ticket-episode-v1.mjs` (Update): Expand validation logic for new terminal events (`rolled_back`).
*   `ledgers/episode-evolution-ledger.mjs` (Update): Add state transitions for crash-safe rollback intents, apply pre-append secret sanitization, and expose streaming/windowed ledger iterators.
*   `governance/pkg/evolutionorchestrator/scoring.go` (Update): Enforce fail-closed rules and independent static/cryptographic validation of human attestations.
*   `utils/path-validator.mjs` (New): Implements strict path canonicalization, symlink trap prevention, and directory traversal checks.
*   `utils/redaction.mjs` (New): Implements rigorous secret and PII sanitization for ledger inputs.
*   `tests/promotion-v1.test.mjs`, `tests/canary-v1.test.mjs`, `tests/rollback-v1.test.mjs`, `tests/meta-evolution-v1.test.mjs`, `tests/path-validator.test.mjs`, `tests/redaction.test.mjs` (New): Unit tests covering all schemas, security constraints, and stream behavior.

## Step-by-Step Execution

*   **Step 1: Slice 1 - Human-Gated Promotion & Governance Locks**
    *   Create `promotion-v1.mjs` defining the versioned diff mappings.
    *   Implement out-of-band locks: the evolution engine is strictly prohibited from automatically promoting changes to `scoring.go`, `promotion-v1.mjs`, or any core governance schema.
    *   Update `scoring.go` to perform static, cryptographic validation of human attestations *independently* of the JS execution environment, eliminating cycle-dependency loops.
    *   Integrate strict path canonicalization and directory traversal checks on all applied diffs, explicitly rejecting symlinks or attempts to escape designated sandbox boundaries.
*   **Step 2: Slice 2 - Bounded Predeclared Canary Planning**
    *   Define the canary schema representing cohort boundaries and execution scope.
    *   Implement a strict initialization constraint: the canary MUST immediately halt and be rejected fail-closed if predeclared success thresholds, absolute harm thresholds, or target cohorts are missing, malformed, or unparseable prior to execution.
*   **Step 3: Slice 3 - Versioned Observation & Monitoring**
    *   Implement the observation schema comparing predicted cost, quality, and human value against actuals.
    *   Enforce explicit fail-closed logic where delayed, missing, or partial evidence immediately counts toward harm thresholds or triggers a halt.
*   **Step 4: Slice 4 - Crash-Safe Rollback & Ledger Evidence**
    *   Introduce `rollback_intent` and `rolled_back` states into the ledger mechanisms.
    *   Implement a rigorous redaction and sanitization pass to strip secrets, credentials, and sensitive environment context from the rollback intents and restoral diffs *before* they are immutably appended to the `EpisodeEvolutionLedger`.
    *   Perform strict path canonicalization on restoral diffs to avoid symlink traps during crash-safe restart reconciliation.
*   **Step 5: Slice 5 - Queryable Meta-Evolution Metrics**
    *   Define schemas for meta-evolution queries grouped by experiment ID, lesson version, and cohort.
    *   Implement streaming, windowed queries, or cursor-based pagination for ledger aggregation. The system must NEVER load the entire immutable ledger history into memory to eliminate OOM vulnerabilities.

## Test Matrix

*   **OOM / Streaming Tolerance Tests:** Assert that meta-metric aggregation scales without unbounded memory growth by processing massively seeded ledgers using cursors and streams.
*   **Symlink & Traversal Trap Tests:** Supply versioned diffs containing `../` sequences and symlink traps; verify they are explicitly rejected during promotion and rollback restoral phases.
*   **Unprotected State Leak Tests:** Inject dummy API keys, credentials, and PII into failure payloads; assert the redaction pass cleanly strips all sensitive material before it appears in the final immutable ledger blob.
*   **Canary Fail-Closed Tests:** Provide a canary initialization request with a missing harm threshold and unparseable cohort boundaries; verify the execution instantly halts without launching the canary.
*   **Independent Validation & Governance Locks Tests:** Assert that `scoring.go` successfully authenticates human cryptographic signatures natively (no JS interop). Validate that mock payloads attempting to programmatically mutate core files (`scoring.go`, `promotion-v1.mjs`) are blocked by the out-of-band locks.
