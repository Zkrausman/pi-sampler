# Implementation Plan: AIDEV-128
**Title:** Attribute exact model, token, and cost usage to Ticket Episodes

## Executive Summary
This document outlines the technical implementation plan for AIDEV-128. The goal is to accurately measure parent and subagent costs by specific model and episode/run identity to establish defensible task-to-value analysis. 

The implementation treats AIDEV-128 as an outcome parent, consisting of three primary child tasks:
1. **AIDEV-145**: Usage Observation v1 and immutable price snapshots.
2. **AIDEV-146**: Authoritative parent/subagent collection and reconciliation.
3. **AIDEV-147**: Bounded attribution queries and completeness gates.

## Phase 1: Usage Observation v1 & Immutable Price Snapshots (AIDEV-145)
**Objective**: Define the core schema and data structures for recording exact token usage and computing costs reliably.

### Schema Changes
1. **Define `UsageObservationV1` Schema**:
   - Update `contracts/authoritative-receipt-v1.schema.json` to include an `observation.usage` object.
   - Fields: `provider`, `model`, `version`, `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheTokens`.
   - Add a nested `priceSnapshot` object to capture the per-token cost at the time of observation (e.g., `inputCostPerMillion`, `outputCostPerMillion`).
   - Add a calculated `totalCost` field for immutability.
2. **Attribution Gaps**:
   - Introduce an `attributionGaps` array in the schema to explicitly capture missing or malformed observations.

### Implementation Details
- Update the corresponding validation logic in `contracts/authoritative-receipt-v1.mjs`.
- Create a utility for fetching or injecting the current price snapshot during run execution.

## Phase 2: Parent/Subagent Collection & Reconciliation (AIDEV-146)
**Objective**: Ensure all usage is bound chronologically and hierarchically across complex multi-agent runs.

### Hierarchy Binding
1. **Identity Linking**:
   - Bind each usage observation to its contextual identities: `episode`, `attempt`, `session`, `segment`, and `requestIdentity`.
   - Ensure the `producer` field specifies whether the usage originated from the parent agent or a specific subagent.
2. **Reconciliation Logic**:
   - Modify `ledgers/episode-evolution-ledger.mjs` and `ledgers/authoritative-receipt-ledger.mjs`.
   - Implement hierarchical aggregation: sum usage from all subagent runs up to the parent run.
   - Validate component sums against total sums.
   - Validate run counts, chronology, and producer version matches.
3. **Refactoring Legacy Code**:
   - Remove reliance on modification-time correlation for usage attribution.
   - Eliminate unsafe staging cleanup mechanisms that could orphaned or drop usage telemetry.

## Phase 3: Bounded Attribution Queries & Completeness Gates (AIDEV-147)
**Objective**: Build reliable queries and prevent incomplete receipts from being committed.

### Completeness Gates
1. **Strict Receipt Validation**:
   - Add strict completeness gates in the ledger logic.
   - Fail receipt generation if `usage` is missing and no explicitly approved `attributionGaps` are provided.
2. **Probe Fixes**:
   - Fix the "original junction deletion" and "inconsistent-total probes" by ensuring they fail safely and return descriptive errors instead of silent failures or partial state corruption.

### Query API
1. **Query Methods**:
   - Implement read methods in `episode-evolution-ledger.mjs` to allow querying exact usage and cost.
   - Required index/query dimensions: `ticket`, `model`, `attempt`, `session`, `subagent`.
2. **Boundary-Spanning Runs**:
   - Handle concurrent tickets and boundary-spanning runs safely by using explicit run IDs rather than temporal overlaps.

## Verification & Acceptance
- [ ] Ensure concurrent tickets and boundary-spanning runs attribute cost correctly without cross-contamination.
- [ ] Attempt to produce a complete receipt with skipped/missing usage and verify the system blocks it.
- [ ] Run the original junction deletion and inconsistent-total probes and verify they fail safely.
- [ ] Test the query API across all dimensions (ticket, model, attempt, session, subagent).
- [ ] Run the boundary-spanning fixture and assert exact cost totals across the three children.

## Dependencies & Blockers
- **Blocked By**: 
  - AIDEV-124 (Bounded Episode and Evolution ledgers)
  - AIDEV-125 (Define authoritative adapter and artifact receipt contracts)
- **Blocks**: AIDEV-150, AIDEV-149, AIDEV-136, AIDEV-131, AIDEV-130.
