# Implementation Plan: AIDEV-133 (Versioned Lesson Registry)

## Effort & Risk
- **Effort**: L (Large). Requires robust schema definitions, state machine transitions, graph lineage traversal, durable ledger integration, and stringent security handling.
- **Risk**: High. The Lesson Registry is the foundation for autonomous system evolution. Bugs here could lead to silent behavioral regression, conflicting rules, or premature promotion of unverified agent behaviors. The single-ticket guardrail, emergency prohibition policies, and OOM/symlink vectors must be strictly managed.

## Expected File Changes
| Type | File Path | Description |
| :--- | :--- | :--- |
| **New** | `contracts/lesson-v1.mjs` | TypeBox schema (`LessonV1Schema`), lifecycle states, and independent semantic validators. |
| **New** | `ledgers/lesson-registry.mjs` | Durable facade backing onto `EpisodeEvolutionLedger` with stream-based queries, conflict detection, fail-closed guards, and atomic rollbacks. |
| **New** | `docs/specs/LESSON-REGISTRY-V1.md` | Architecture spec for lesson schema, lifecycle, conflict detection, unidirectional flow, and threat model. |
| **New** | `scripts/export-lesson-v1-schema.mjs` | JSON Schema export script writing exclusively to `stdout` (no filesystem I/O). |
| **New** | `tests/lesson-v1.test.mjs` | Contract tests for TypeBox schemas, semantic validation, and fail-closed state leakage handling. |
| **New** | `tests/lesson-registry.test.mjs` | Persistence, unidirectional flow, multi-ticket/zero-evidence guardrails, overlap detection error handling, and streamed rebuilding tests. |
| **New** | `tests/helpers/lesson-conformance.mjs` | Fixtures and mocks for lesson states, bad actors, and provenance chains. |
| **Modify**| `package.json` | Add `generate:lesson-schema` (via stdout redirection) and `validate:lesson-schema` scripts. |

*(Note: `contracts/lesson-v1.schema.json` will not be committed to version control. It will only be generated via stdout or validated in CI, per governance rules).*

## Step-by-Step Execution

### Phase 1: Contract & Specification Foundation
1. **Author the Specification**: Create `docs/specs/LESSON-REGISTRY-V1.md` detailing the schema, states (`proposed`, `evaluated`, `promoted`, `monitored`, `reverted`, `retired`, `superseded`, `rejected`), threat models, conflict resolution policy, fail-closed assertions, and unidirectional data flow constraints.
2. **Define the Schema**: Implement `contracts/lesson-v1.mjs` using TypeBox. Define `LessonV1Schema` capturing applicability bounds, behaviors, evidence citations, and immutable provenance constraints. Keep this module pure and completely decoupled from ledger components to prevent cyclic dependencies.
3. **Generate CLI Script**: Implement `scripts/export-lesson-v1-schema.mjs`. Ensure the script performs **no filesystem output**, writing strictly to `stdout` to avoid symlink trap vulnerabilities. Wire up `package.json` scripts using shell redirection.

### Phase 2: Registry Ledger Implementation
1. **Implement `LessonRegistry` Base (Unidirectional Flow)**: Create `ledgers/lesson-registry.mjs`. Instantiate it over the existing `EpisodeEvolutionLedger`. Ensure data flows strictly from `LessonRegistry` -> `EpisodeEvolutionLedger`, with all validation logic maintained independently above the ledger layer to avoid cycle-dependency loops.
2. **Streamed Ledger Querying & Rebuilding**: Implement rebuilding and query mechanisms using streaming, chunking, or cursor-based pagination over `EpisodeEvolutionLedger` to mitigate OOM vulnerabilities from unbounded memory loading.
3. **Lifecycle State Machine & Atomic Rollbacks**: Implement state transitions (`evaluate`, `promote`, etc.). Ensure that failed transitions or validation rejections strictly rollback any in-memory active cache mutations and throw securely without leaking internal raw ledger packets.
4. **Single-Ticket, Zero-Evidence & Emergency Guardrails**:
   - Implement the validation within `promote()`.
   - **Fail-Closed on Evidence**: Reject any payload with zero evidence.
   - **Fail-Closed on Multi-Ticket**: Reject payloads supported by only a single ticket, *unless* they possess a catastrophic-safety exception block.
   - **Fail-Closed on Bypass**: If the catastrophic exception metadata block is malformed or unparsable, immediately deny promotion.
5. **Conflict & Overlap Analysis**: Implement `detectConflicts(lesson)` and `detectOverlaps(lesson)` using stream-based ledger querying. Do not allow silent tie-breaking. **Fail-Closed on Detection Errors**: If the detection functions throw an unexpected error or timeout, the promotion must fail immediately.

### Phase 3: Test Harness & Verification
1. **Develop Conformance Fixtures**: Build `tests/helpers/lesson-conformance.mjs` to generate valid, invalid, zero-evidence, and malformed-bypass payloads.
2. **Contract Tests**: Implement `tests/lesson-v1.test.mjs` to rigorously test structural validation, ensuring invalid lifecycle jumps trigger secure, leak-free errors.
3. **Registry Tests**: Implement `tests/lesson-registry.test.mjs`. Verify bounded/streamed registry rebuilds, unidirectional dependency flows, the zero-evidence / multi-ticket promotion block, emergency fail-closed parsing logic, and that `detectConflicts` failures halt execution securely.

## Test Matrix

| Feature / Module | Test Scenario | Expected Outcome |
| :--- | :--- | :--- |
| **Contracts** | Valid v1 payload serialization | Passes `validateLessonV1` and strictly matches generated schema. |
| **Contracts** | Missing or zero evidence | Rejected by validation (fail-closed). |
| **State Machine** | Invalid transition / failed validation | Throws securely; active memory cache state remains fully rolled back/unmutated. |
| **Guardrails** | Promote single-ticket feature lesson | Promotion denied due to insufficient evidence breadth. |
| **Emergency** | Malformed bypass metadata block | Promotion denied (fail-closed metadata parsing). |
| **Emergency** | Promote single-ticket catastrophic `avoid` | Promotion succeeds under fail-closed emergency exception rules. |
| **OOM Safety** | Rebuild from ledger with 10M events | Memory profile remains flat; pages successfully streamed and discarded. |
| **Conflicts** | Propose overlapping contradictory lesson | Detection flags conflict; explicitly requires supersession/rejection. |
| **Conflicts** | Overlap detection throws runtime error | Promotion fails closed; error bubbled securely. |
| **Architecture** | Cyclic dependency check | Linters/Tests assert `EpisodeEvolutionLedger` does not import validation logic. |
| **CLI Tools** | Execute `export-lesson-v1-schema.mjs` | Output pushed solely to `stdout`; no filesystem files created. |
