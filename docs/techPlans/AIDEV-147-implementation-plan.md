# Implementation Plan: AIDEV-147 (Usage & Cost Queries)

## Effort & Risk
* **Effort**: High. Requires strict enforcement of arithmetic, exact pagination state boundaries, version tracking, stream-processing, and strict module boundaries.
* **Risk**: High. Incorrect usage queries could lead to silent data loss, incorrect cost aggregation, or cross-tenant leakage. The "fail-closed" requirement is crucial; any dropped coverage during pagination, broken stream pipes, or malformed EOFs must throw an error rather than silently omitting data. Processing must be streamed to avoid OOM vulnerabilities, and exact component arithmetic is required to prevent floating-point precision loss.

## Expected File Changes
1. `contracts/usage-query-v1.mjs` (New)
   * Defines schema validations for usage queries, filters (ticket, model, attempt, session, segment, request, subagent run), cost snapshot versions, and completeness metadata.
   * Includes strict tenant/context isolation boundaries.
2. `contracts/usage-query-v1.schema.json` (New)
   * Auto-generated canonical JSON schema.
3. `ledgers/usage-query-engine.mjs` (New)
   * Implements the core query engine via stream-processing to prevent buffering/OOM.
   * Includes read-only state isolation proxies, cryptographic/checksum verification for stream integrity, exact arithmetic for component sums, and completeness gating.
4. `scripts/export-usage-query-v1-schema.mjs` (New)
   * Script to export the JSON schema.
5. `tests/usage-query.test.mjs` (New)
   * Exhaustive test suite for exact arithmetic, dimension querying, completeness bounds, stream truncation failures, tenant isolation, and read-only immutability.
6. `package.json` / `.dependency-cruiser.js`
   * Register the new schema export script and configure dependency-cruiser to enforce strict acyclic boundaries between `contracts` and `ledgers`.

## Step-by-Step Execution
1. **Contracts Definition**:
   * Create `contracts/usage-query-v1.mjs`. Define structures for QueryRequest (dimensions, limits, tenant contexts), QueryResult (aggregates, gaps, metadata), and PricingSnapshot.
   * Implement validation schemas focusing on strict types (e.g., using exact decimal representations) and strict tenant boundary partitioning to prevent cross-session usage leakage.
2. **Schema Generation**:
   * Create `scripts/export-usage-query-v1-schema.mjs` and run it to generate `contracts/usage-query-v1.schema.json`.
3. **Engine Implementation**:
   * Create `ledgers/usage-query-engine.mjs`. The engine must wrap the `EpisodeEvolutionLedger` instance in a strict read-only proxy/interface to prevent accidental mutation.
   * Implement querying mechanisms using explicit stream-processing of events. Do not buffer ledger arrays into memory prior to pagination bounds to avoid OOM vulnerabilities.
   * Apply cryptographic or checksum verification on the ledger stream to ensure a broken pipe or malformed EOF fails closed, rather than generating a false complete receipt.
   * Implement multi-dimensional filtering, working memory limits, byte/record bounds, and exact component arithmetic.
   * Enforce completeness gating and mark coverage gaps explicitly.
4. **Dependency & Cycle Management**:
   * Update linting/cruiser rules to explicitly enforce acyclic boundaries, preventing `contracts` from importing `ledgers`.
5. **Testing**:
   * Implement `tests/usage-query.test.mjs` covering mathematical precision, bounds limits, stream faults, tenant isolation, and read-only proxy protections.

## Test Matrix
| Scenario | Action | Expected Outcome |
|----------|--------|------------------|
| Exact Arithmetic | Sum costs across thousands of component events. | Aggregate matches exact mathematical sum without float precision loss. |
| Streaming / OOM Protection | Query massive dataset exceeding memory capacity. | Processes successfully via stream-processing; memory stays strictly bounded. |
| Malformed EOF / Stream Truncation | Truncate ledger stream or simulate broken pipe mid-read. | Fails closed (throws error or rejects completeness) due to checksum/cryptographic validation failure. |
| Read-Only State Isolation | Attempt to mutate the ledger state from within the query engine. | Throws error; read-only proxy strictly prevents mutation. |
| Tenant Boundary Leakage | Query data with mixed tenant sessions. | Results strictly isolate by tenant context; cross-session leakage is fully prevented. |
| Completeness Gating | Attempt to generate a complete receipt with missing/skipped observations. | Throws error or explicitly rejects receipt creation; no complete receipt produced. |
| Bounded Pagination | Query exceeding byte/record limit mid-page. | Returns partial results with clear attribution-gap metadata indicating incomplete coverage. |
| Incomparable Versions | Aggregate events with mismatched metric/price-snapshot versions. | Rejects silent aggregation; strictly groups or isolates aggregates by version. |
