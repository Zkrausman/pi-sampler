# Implementation Plan: AIDEV-146 (Collect and reconcile usage across parent and subagent runs)

## Effort & Risk
**Effort:** Medium
**Risk Level:** High
**Risks:**
- **OOM Vulnerability:** Ingesting large receipt trees can crash the reconciler.
- **Cycle-Dependency Loops:** Cyclic subagent relationships can cause infinite traversal DOS.
- **TOCTOU Symlink Traps:** Naive filesystem checks open vectors for symlink replacement attacks.
- **Unprotected State Leakage:** Malformed data could poison the ledger if not failed-closed.

## Expected File Changes
| Path | Operation | Description |
|---|---|---|
| `processors/usage-reconciler.mjs` | Create | Core reconciliation logic: deterministic identity binding, memory-bounded streaming, cycle detection, and gap tracking. |
| `tests/usage-reconciler.test.mjs` | Create | Adversarial and concurrency tests for the usage reconciler. |
| `docs/okf/AIDEV-146-usage-reconciliation.md` | Create | OKF documentation for the usage reconciliation implementation. |
| `evidence/delivery/AIDEV-146.json` | Create | Delivery manifest required by governance validation. |

## Step-by-Step Execution
1. **Scaffold Reconciler & OKF Document:**
   - Create `docs/okf/AIDEV-146-usage-reconciliation.md` detailing the reconciliation strategy.
   - Create the initial skeleton for `processors/usage-reconciler.mjs`.
2. **Implement Deterministic Identity Binding & Fail-Closed Assertions:**
   - Implement domain-separated SHA-256 identifier derivation for requests, segments, runs, sessions, attempts, episodes, and tickets.
   - Add strict fail-closed assertions. Abort reconciliation and wipe staging artifacts securely if invalid hashes or unauthorized domain crossings occur.
3. **Implement Memory-Bounded Parent/Subagent Reconciliation & Cycle Detection:**
   - Build a traversal system that ingests authoritative receipts using **memory-bounded streaming**.
   - Map receipts to their parent/subagent tree structure iteratively.
   - **Strict Cycle Detection:** Use a `Set` of visited node identity hashes. Quarantine the tree and fail-closed immediately if a cycle is detected.
   - Deduplicate provider usage to ensure no double-counting between boundary-spanning runs.
4. **Implement Attribution Gap Tracking:**
   - Explicitly track unmapped provider segments or missing subagent runs.
   - Generate `missingEventIds` and mark coverage as `partial` instead of manufacturing fallback data.
5. **Integrate with Ledger Security Constraints (FD Validation):**
   - Ensure race-condition-free filesystem checks. Use `fs.open`, `fstat` on the file descriptor to verify regular files, and then read from the same FD to prevent TOCTOU symlink attacks.
   - Format reconciled outputs as valid `TicketEpisodeV1` records ready for the `AuthoritativeReceiptLedger`.
6. **Develop Test Suites:**
   - Implement `tests/usage-reconciler.test.mjs`.
   - Add fixtures covering concurrent ticket attribution, partial coverage, adversarial identity binding, cycle detection, and TOCTOU defense.
7. **Complete Governance Delivery:**
   - Generate `evidence/delivery/AIDEV-146.json`.
   - Run `delivery-evidence-validator` and `planning-rubric-validator` to ensure compliance.

## Test Matrix
| Test Case | Type | Expected Outcome |
|---|---|---|
| Parent-Subagent Overlap | Logic | Reconciler accurately sums tokens/costs without double-counting nested subagent runs. |
| Cycle-Dependency Detection | Security | Infinite loops prevented; cyclic trees are quarantined and fail-closed. |
| Memory-Bounded Ingestion | Stress | Reconciler remains stable under a massive volume of simulated receipts. |
| Partial Coverage / Missing Runs | Logic | Reconciler flags record as `partial` and appends missing hashes to `missingEventIds`. |
| Concurrent Attribution | Concurrency | Concurrent ingestion safely attributes usage to distinct tickets without race conditions. |
| Deterministic Identity Generation | Identity | Identical input attributes map consistently to the exact same SHA-256 identifier. |
| TOCTOU FD Verification | Security | Attempted symlink swaps between check and read are rejected via `fstat` validation. |
