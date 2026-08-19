# Implementation Plan: AIDEV-143

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** L
*   **Estimated Effort:** 2-3 days
*   **Primary Risk:** Ensuring deterministic recovery of interrupted writes, correctly tracking complex revision ancestries in the ledger (preventing cycles/orphans), and maintaining strict bounds.

## Expected File Changes
*   [NEW] contracts/annotation-v1.mjs: TypeBox schema and semantic validators for Annotation v1 targets, types, metadata (author, timestamp, sensitivity, rationale, evidence class, target identity, revision ancestry).
*   [NEW] contracts/annotation-v1.schema.json: The generated draft 2020-12 JSON schema for Annotation v1.
*   [NEW] contracts/README.md: Thneed GraphRAG Mermaid diagram describing the contracts package.
*   [NEW] scripts/export-annotation-v1-schema.mjs: Script to generate and export the JSON schema.
*   [MODIFY] package.json: Add generate:annotation-schema and alidate:annotation-schema.
*   [NEW] ledgers/annotation-ledger.mjs: Store facade wrapping pisode-evolution-ledger.mjs. Implements append-only revisions, tombstones, bounded listing, export, backup, restore, and versioned migration.
*   [NEW] ledgers/README.md: Thneed GraphRAG Mermaid diagram describing the ledgers package.
*   [NEW] 	ests/annotation-v1.test.mjs: Test suite for contract schema and stateless validation.
*   [NEW] 	ests/annotation-ledger.test.mjs: Test suite for the store facade (ancestry cycle detection, tombstone preservation, bounded queries, interrupted writes).
*   [NEW] docs/techPlans/AIDEV-143-implementation-plan.md: This technical specification and implementation plan.

## Step-by-Step Execution
1.  **Phase 1: Contract & Schema Definition**
    *   Step 1.1: Create contracts/annotation-v1.mjs using TypeBox. Define annotation target categories, sensitivity enums, evidence classes (restricting to human_annotation), and the revision ancestry model (parent ID/digest). Include explicit versioning fields to support future migrations.
    *   Step 1.2: Implement stateless semantic validators in nnotation-v1.mjs to enforce immutability rules, ensuring human_annotation cannot mint observed_evidence.
    *   Step 1.3: Update package.json with scripts and create scripts/export-annotation-v1-schema.mjs to export the TypeBox schema. Generate contracts/annotation-v1.schema.json.
    *   Step 1.4: Create/Update contracts/README.md with a Thneed-compliant Mermaid diagram illustrating the new contract.
    *   Step 1.5: Write comprehensive tests in 	ests/annotation-v1.test.mjs covering stateless validation scenarios.
2.  **Phase 2: Ledger Facade Implementation**
    *   Step 2.1: Create ledgers/annotation-ledger.mjs as a facade around the low-level pisode-evolution-ledger.mjs. Integrate a verification step to ensure the underlying ledger's fsync behaves as required.
    *   Step 2.2: Implement stateful validation: ancestry cycle detection (preventing loops) and orphaned tombstone prevention.
    *   Step 2.3: Implement append-only writes, preserving prior revisions, and represent deletions explicitly as tombstones. Handle concurrency and race conditions (e.g., rejecting conflicting writes to the same parent).
    *   Step 2.4: Implement bounded listing/queries, logical export, backup, restore, and deterministic recovery. Define the migration logic to upgrade unversioned payloads to 1.
    *   Step 2.5: Create/Update ledgers/README.md with a Thneed-compliant Mermaid diagram.
    *   Step 2.6: Write adversarial tests in 	ests/annotation-ledger.test.mjs covering cycles, concurrency, migration, and bounds enforcement.
3.  **Phase 3: Documentation & Handoff**
    *   Step 3.1: Verify all tests pass locally.
    *   Step 3.2: Execute the Thneed Compliance (Zen Loop): Stage changes, run 	hneed beads-scaffold AIDEV-143, generate [bd-3qwe self-doc] RATIONALE and EVIDENCE anchors, and run d update AIDEV-143 --notes ....
    *   Step 3.3: Close the task using d close AIDEV-143.

## Test Matrix
*   **Target Command**: 
ode --test tests/annotation-v1.test.mjs tests/annotation-ledger.test.mjs
*   **Validation Scenarios**:
    *   [ ] Scenario A (Success case: Append new annotation, verify ancestry linkage and metadata preservation)
    *   [ ] Scenario B (Edge case handling: Minting observed_evidence in an annotation is rejected by stateless contract)
    *   [ ] Scenario C (Edge case handling: Tombstone addition correctly masks but does not delete historical records)
    *   [ ] Scenario D (Recovery: Interrupted write leaves the ledger in deterministic state upon restore)
    *   [ ] Scenario E (Bounds: Exceeding listing bounds throws bounded error or returns paginated results)
    *   [ ] Scenario F (Cycle Prevention): Ledger rejects appending an annotation whose parent creates a loop.
    *   [ ] Scenario G (Orphaned Tombstones): Ledger rejects writing a tombstone for a non-existent identity.
    *   [ ] Scenario H (Concurrency/Race Conditions): Ledger rejects conflicting simultaneous writes to the same annotation parent.
    *   [ ] Scenario I (Versioned Migration): Ledger transparently upgrades a legacy/unversioned payload to v1 on read/export.
