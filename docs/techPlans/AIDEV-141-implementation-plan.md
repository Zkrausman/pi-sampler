# Implementation Plan: AIDEV-141

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** M
*   **Estimated Effort:** 1-2 days
*   **Primary Risk:** Unbounded streams failing to backpressure on gigabyte-long lines without newlines, leading to OOM crashes.

## Expected File Changes
*   `[NEW]` `docs/specs/CONVERSATION-CATALOG-INGESTION-V1.md`: Architectural specification detailing bounds, snapshot mechanics, quarantine, and tail preservation.
*   `[NEW]` `contracts/conversation-catalog-v1.mjs`: Canonical TypeBox contract defining source manifests, event formats, and diagnostics.
*   `[NEW]` `contracts/conversation-catalog-v1.schema.json`: Checked JSON Schema export for conversation catalog contracts.
*   `[NEW]` `contracts/generate-schema.mjs`: Script to generate the canonical JSON schema export, kept within the permitted path.
*   `[NEW]` `ledgers/conversation-catalog.mjs`: Bounded, failure-isolated ingestion engine and catalog query interface.
*   `[NEW]` `tests/conversation-catalog-ingestion.test.mjs`: Exhaustive test suite covering symlinks, changing files, malformed JSONL, oversized files, and memory bounds.
*   `[NEW]` `tests/fixtures/conversation-sources/`: Adversarial and valid fixture corpus for test coverage.
*   `[MODIFY]` `package.json`: Update test scripts to point to new tests and schema generation scripts.

## Trust Boundaries
*   **Source Data Authenticity**: Files in the root directory are untrusted; their contents could be corrupted, oversized, or symlinked maliciously.
*   **File Mutation Limitations**: The `snapshotSource` function relies on file stats before and after reading to detect changes. Extremely fast atomic swaps or specific OS filesystem caching behaviors may bypass this detection heuristic.
*   **Schema Safety**: Incoming file content is strictly evaluated against TypeBox schemas; unknown or deeply nested JSON structures failing the schema are discarded.

## Acceptance Criteria
*   A long, malformed, changing, symlinked, or oversized source cannot disable healthy search.
*   A marker beyond the former truncation boundary remains inspectable and citable.
*   Skipped sources and coverage are explicit and bounded.
*   Adversarial filesystem and memory-bound fixtures pass.
*   Delivery adheres to the 2-commit standard (Implementation followed by Evidence).

## Step-by-Step Execution
1.  **Commit 1: Contracts, Specs, and Failing Tests (The Framework)**
    *   Step 1.1: Define TypeBox schemas in `contracts/conversation-catalog-v1.mjs` for `ConversationSourceManifest`, `ConversationEvent`, `SourceCoverageDiagnostic`, and `IngestionQuarantineRecord`. Add `contracts/generate-schema.mjs` for exporting the JSON schema.
    *   Step 1.2: Write the `docs/specs/CONVERSATION-CATALOG-INGESTION-V1.md` architectural specification detailing `maxLineLength` streaming limits, `maxDepth` directory bounds, and the snapshot read mechanism.
    *   Step 1.3: Create adversarial mock fixtures in `tests/fixtures/conversation-sources/` for symlinks, oversized files, mutated files, empty files, whitespace-only files, non-JSONL arrays/objects, deeply nested directories, and files with gigabyte-long single lines.
    *   Step 1.4: Write test cases in `tests/conversation-catalog-ingestion.test.mjs` executing `discoverSources` and `queryEvents` against fixtures to ensure isolated failures and bounded memory.
2.  **Commit 2: Ingestion Engine Development & Passing Tests (The Implementation)**
    *   Step 2.1: Implement `discoverSources(rootDir, options)` in `ledgers/conversation-catalog.mjs` with bounded directory traversal (halting at `maxDepth`), rejecting symlinks and paths outside the root.
    *   Step 2.2: Implement `snapshotSource(sourcePath, options)` capturing file stats before/after reading to detect changes and enforcing byte limits.
    *   Step 2.3: Implement `parseConversationEvents(snapshot, options)` as a stream parser for JSONL, enforcing `maxLineLength` to catch and quarantine lines exceeding safe memory bounds without OOM, preserving valid lines, and retaining tail content.
    *   Step 2.4: Implement `quarantineSource` and catalog aggregate diagnostics so failures are isolated.
    *   Step 2.5: Implement `queryEvents(query, pagination)` providing bounded access to parsed events.

## Test Matrix
*   **Target Command**: `node --test tests/conversation-catalog-ingestion.test.mjs`
*   **Validation Scenarios**:
    *   [ ] Scenario 1 (Healthy ingestion with valid JSONL events and correct pagination)
    *   [ ] Scenario 2 (Oversized source file rejected cleanly without OOM)
    *   [ ] Scenario 3 (Directory traversal with symlinks skipped properly)
    *   [ ] Scenario 4 (File mutated during read yields `changing_source_detected` diagnostic)
    *   [ ] Scenario 5 (Malformed JSONL line yields partial coverage but preserves rest of file)
    *   [ ] Scenario 6 (Tail content retained and queryable beyond 4KB boundary)
    *   [ ] Scenario 7 (Line Length Overflow: File containing a single continuously long string without newlines is truncated/quarantined cleanly without OOM via `maxLineLength` boundary)
    *   [ ] Scenario 8 (Directory Traversal Depth Limit: Folder bomb nested beyond `maxDepth` halts traversal)
    *   [ ] Scenario 9 (Edge-Case File Content: Empty files, whitespace-only files, or valid non-JSONL arrays/objects gracefully skipped)
