# Implementation Plan

## Effort & Risk
* **Effort**: Medium. Involves extending the existing TypeBox contract to implement a rigorous state machine for ticket episodes, ensuring timeline validation, separating raw authoritative evidence from untrusted claims, and strictly securing the state machine against algorithmic complexity attacks, infinite loops, and data leaks.
* **Risk**: Moderate. Requires meticulous validation, bounded limits, and a strict fail-closed architecture to prevent attacks via infinite state toggling (OOM), cyclic dependencies, SSRF, or symlink vulnerabilities. The data leakage rules add a dimension of security and observability complexity.

## Expected File Changes
* `contracts/ticket-episode-v1.mjs`: Define lifecycle states (`pickup`, `active`, `blocked`, `completion`, `failure`, `cancellation`, `supersession`, `conflict`). Add strict bounds (`additionalProperties: false`, `maxLength`, `maxItems`), limits on ledger size/transition history, transition validation logic (enforcing chronological progression like pickup-before-close, blocking cyclic dependencies), and authoritative completion gates that fail-closed on malformed payloads.
* `contracts/ticket-episode-v1.schema.json`: Regenerated via script to match TypeBox definition updates.
* `docs/specs/TICKET-EPISODE-V1.md`: Update normative specifications detailing the canonical lifecycle state machine, transitions, finalization invariants, cycle-dependency bounds, security considerations (SSRF, symlinks), and scrubbing requirements for failure/conflict states.
* `tests/ticket-episode-v1.test.mjs`: Introduce adversarial test cases covering reversed chronology, close-before-pickup, unverified completion claims, cross-segment correlation ID duplication, and conflicting concurrent transitions. Also add tests for OOM/ledger unbounded growth, infinite state loop prevention, fail-closed handling of malformed payloads, SSRF/symlink validation, and state leakage prevention.

## Step-by-Step Execution
1. **State Machine Definition & Strict Bounds**: Update `contracts/ticket-episode-v1.mjs` to define TypeBox schemas for the canonical lifecycle states. Apply `additionalProperties: false` globally and define strict `maxLength` and `maxItems` constraints for all string and array fields (especially in `observed_evidence`) to prevent algorithmic complexity attacks.
2. **Authoritative Gate & Fail-Closed Architecture**: Update the schema and validation routines to distinguish `observed_evidence` from untrusted claims. Ensure the validation operates on a fail-closed architecture; any malformed, oversized, or unparseable payload must trigger an immediate, hard rejection.
3. **Transition Rules Validation**: Implement validation logic to reject backwards chronology (e.g., close-before-pickup) and duplicate correlation IDs. Enforce a hard cap on the number of ledger entries per episode to prevent OOM / unbounded growth and implement strict limits to explicitly prevent cyclical state transition loops (e.g., infinite toggling between `active` and `blocked`).
4. **Evidence Security & State Scrubbing**: Introduce strict validation, sanitization, and sandboxing requirements for any URIs or file paths within `observed_evidence` to prevent symlink traps and SSRF. Add scrub logic to ensure sensitive data inside transition attempts is explicitly redacted from logs and public ledger views when entering `failure`, `cancellation`, or `conflict` states.
5. **Specification Documentation**: Update `docs/specs/TICKET-EPISODE-V1.md` with detailed normative specs on the lifecycle state machine, limits/bounds, fail-closed assertions, and scrubbing procedures for failure states.
6. **Adversarial Test Development**: In `tests/ticket-episode-v1.test.mjs`, create test blocks verifying:
    * Rejection of close-before-pickup and reversed chronologies.
    * Rejection of completion attempts driven by caller assertions rather than authoritative evidence.
    * Failure on cross-segment correlation ID collisions.
    * Explicit, deterministic behavior for concurrent conflicts.
    * OOM/Bounds: Assert hard cap limits on ledger entry counts and payload sizes.
    * Cyclical Loops: Assert failure when transition loops exceed defined cycle limits.
    * Fail-closed: Ensure malformed or unparseable payloads are hard-rejected.
    * SSRF / Symlinks: Validate rejection of malicious URIs and symlink traps in `observed_evidence`.
    * State Leakage: Assert sensitive payloads are scrubbed in terminal failure/conflict states.
7. **Regeneration and Verification**: Run `npm run generate:ticket-episode-schema` to update the exported JSON schema, then run `npm run validate:ticket-episode-schema`, and `npm test` to ensure compliance.

## Test Matrix
| Scenario / Feature | Test Case | Expected Outcome |
| :--- | :--- | :--- |
| Chronology Validation | Submit `completion` before `pickup` event is recorded | Validation Failure (Close-before-pickup) |
| Chronology Validation | Submit events with reversed chronological timestamps | Validation Failure |
| Authoritative Completion | Attempt state transition to `completion` using caller claims without `observed_evidence` | Validation Failure |
| Correlation Invariants | Submit transition introducing duplicate cross-segment correlation IDs | Validation Failure |
| Conflict Handling | Submit conflicting concurrent transitions | Explicit deterministic resolution |
| OOM / Ledger Bounds | Exceed maximum allowed ledger entries or payload sizes | Validation Failure (Hard rejection) |
| Cyclic Boundaries | Attempt infinite transition loops (e.g. `active` <-> `blocked`) | Validation Failure (Cycle limits exceeded) |
| Security (SSRF/Symlinks)| Pass external SSRF URIs or symlink paths in `observed_evidence` | Hard fail-closed rejection |
| Fail-Closed Payload | Pass malformed, unparseable, or bloated payload | Immediate Hard Rejection |
| State Leakage / Privacy | Trigger `conflict` or `failure` state with sensitive payload | Sensitive data explicitly scrubbed from logs/ledger view |
