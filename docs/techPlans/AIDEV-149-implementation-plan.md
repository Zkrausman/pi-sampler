# Implementation Plan: AIDEV-149 - Compute versioned comparable task-efficiency cohorts

## 1. Effort & Risk
* **Effort Level**: Medium
* **Linear Estimate**: M
* **Complexity / Risk**: Medium. The complexity has increased slightly to handle strict memory management (OOM prevention), strict mathematical safety (fail-closed exclusion), and security (PII redaction and symlink traversal prevention). The core logic remains focused on multi-dimensional efficiency metrics and metric versioning.

## 2. Expected File Changes
* `contracts/task-efficiency-cohort-v1.mjs`: New schema defining the structure for versioned cohorts, comparison dimensions (cost, time, quality), and evidence traceability. Must enforce data sanitization boundaries (only UUIDs/hashes allowed for trace IDs; no raw payloads or context snippets).
* `contracts/task-efficiency-cohort-v1.schema.json`: Auto-generated JSON schema export.
* `scripts/export-task-efficiency-cohort-v1-schema.mjs`: Script to generate the schema export. Must include `fs.realpath` and explicit path boundary containment assertions to protect against symlink traversal attacks.
* `src/metrics/task-efficiency-cohorts.mjs`: Implementation logic to compute bounded aggregate metrics. Must use a streaming, paginated, or chunked processing model (no loading the entire ledger into memory). Must enforce strict fail-closed exclusion logic.
* `tests/task-efficiency-cohorts.test.mjs`: Unit and integration tests covering chunked processing, exclusion of incomplete work, sanitization, and cost/quality optimization trade-offs.
* `docs/specs/TASK-EFFICIENCY-COHORTS-V1.md`: Architectural specification defining the dimensions of efficiency, metric versioning, mathematical safety, PII redaction, and a strict acyclic dependency graph.
* `package.json`: Updated to include the new schema export script and ensure the test harness captures the new tests.

## 3. Step-by-Step Execution
1. **Architectural Specification**: Write `docs/specs/TASK-EFFICIENCY-COHORTS-V1.md` outlining the efficiency dimensions, metric versioning logic, and mathematical safety. Document a strict acyclic dependency graph: `src/metrics/` can read from contracts/ledgers, but core ledger/routing modules cannot import from `src/metrics/`.
2. **Schema Definition**: Create `contracts/task-efficiency-cohort-v1.mjs`. Enforce strict data sanitization boundaries—traceability links back to `AuthoritativeReceipt` items must only use UUIDs or hashes, explicitly blocking raw inputs, outputs, or full receipt payloads to prevent PII/secret leakage.
3. **Schema Export Setup**: Create `scripts/export-task-efficiency-cohort-v1-schema.mjs` incorporating `fs.realpath` and boundary checks to prevent symlink traps. Run the script to generate `contracts/task-efficiency-cohort-v1.schema.json`.
4. **Aggregation Implementation**: Develop `src/metrics/task-efficiency-cohorts.mjs`. Implement a streaming or paginated consumption model for the ledger to prevent OOM errors. Implement strict fail-closed behavior for incomplete tickets: any ticket missing required dimension data (cost, time, quality) MUST be aggressively discarded from aggregates with a warning thrown, preventing zero-cost skewing or division-by-zero.
5. **Testing Framework**: Develop `tests/task-efficiency-cohorts.test.mjs`. Add tests to verify chunked ledger processing, strict exclusion (no `NaN`/`Infinity`), PII redaction (only UUIDs present), and symlink safety in the export script. Validate that higher cost but lower rework correctly yields a better efficiency score.
6. **Integration & Validation**: Validate the unidirectional dependency graph and ensure the streaming integration with `EpisodeEvolutionLedger` correctly correlates evidence without circular dependencies.

## 4. Test Matrix
* **Unit - Schema Validation & Sanitization**: Verify that `task-efficiency-cohort-v1.mjs` strictly enforces structure and only allows sanitized trace IDs (no raw data leakage).
* **Unit - Streaming & OOM Prevention**: Ensure `src/metrics/task-efficiency-cohorts.mjs` handles large mocked ledgers using chunked/paginated processing without exceeding memory limits.
* **Unit - Strict Fail-Closed Exclusion**: Test that tickets missing cost, time, or quality data are aggressively excluded and trigger warnings, preventing skewed metrics.
* **Unit - Export Boundary Containment**: Test that `export-task-efficiency-cohort-v1-schema.mjs` throws errors on malicious symlink paths.
* **Unit - Value vs Cost Efficiency**: Test scenarios where a more expensive model with fewer retries yields a better efficiency score than a cheap model with high rework.
* **Unit - Metric Versioning**: Ensure altering the metric definition string generates an independent cohort identity.
* **Integration - Acyclic Traceability**: Verify that the efficiency module can read from ledgers but introduces no cyclic dependencies.