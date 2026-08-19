# Implementation Plan: AIDEV-142

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** M
*   **Estimated Effort:** 3-5 days
*   **Primary Risk:** Cyclic dependencies in subagent relationships leading to infinite loops, and concurrency issues when parsing active sessions.

## Expected File Changes
*   `[NEW]` `src/catalog/session-reconstructor.mjs`: *Implements the core reconstruction logic for Ticket Episodes, handling trusted parent/child session aggregation, provenance tracking, and refresh isolation.*
*   `[NEW]` `tests/episode-reconstruction.test.mjs`: *End-to-end multi-session, subagent hierarchy, and partial-coverage test suite.*
*   `[NEW]` `tests/fixtures/multi-session-reconstruction/`: *Synthetic, non-sensitive fixtures representing parent sessions, subagent sessions, and missing association edge cases.*

## Step-by-Step Execution
1.  **Phase 1: Foundation & Fixtures**
    *   Step 1.1: Create synthetic, non-sensitive test fixtures in `tests/fixtures/multi-session-reconstruction/`.
    *   Step 1.2: Scaffold `src/catalog/session-reconstructor.mjs` and export a `reconstructEpisode(episodeId, sessionLedgers)` function.
2.  **Phase 2: Provenance & Aggregation Logic**
    *   Step 2.1: Implement correlation logic based on `episode.id`, `ticket.id`, `agentRun`, and `attempt`.
    *   Step 2.2: Add cycle-detection to prevent infinite loops when resolving subagent hierarchies.
    *   Step 2.3: Implement deterministic event ordering (e.g., causal linking) to handle clock drift across sessions.
    *   Step 2.4: Handle orphaned subagents by explicit partial coverage classification, not discarding or synthesizing roots.
3.  **Phase 3: Active Refresh & Agentic Safety**
    *   Step 3.1: Implement read-while-write safety by only reading up to the last known committed offset or valid JSON newline boundary.
    *   Step 3.2: Introduce execution limits (timeout and memory bounds) for parsing large session trees.
4.  **Phase 4: Validation & Compliance**
    *   Step 4.1: Write tests including negative scenarios (cycles, malformed data, concurrency).
    *   Step 4.2: Generate the delivery evidence manifest and validate using `cmd/delivery-evidence-validator`.

## Test Matrix
*   **Target Command**: `node --test tests/episode-reconstruction.test.mjs`
*   **Validation Scenarios**:
    *   [ ] Scenario A (Success case): Reconstructs a full episode from trusted multi-session fixtures deterministically.
    *   [ ] Scenario B (Edge case handling): Handles missing associations by returning explicit partial coverage.
    *   [ ] Scenario C (Edge case handling): Unrelated sessions are correctly rejected.
    *   [ ] Scenario D (Success case): Active refresh produces a complete view without mixing generations.
    *   [ ] Scenario E (Governance Guardrail): Assert fail-closed on unredacted session injection.
    *   [ ] Scenario F (Resilience): Handle truncated JSON gracefully.
    *   [ ] Scenario G (Resilience): Catch and handle cyclic dependencies.
    *   [ ] Scenario H (Concurrency): Simulate read-while-write safely.
    *   [ ] Scenario I (Agentic Safety): Enforce memory/time bounds on massive trees.
