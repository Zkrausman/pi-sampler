# Implementation Plan: AIDEV-161

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** L
*   **Estimated Effort:** 2-5 days after the threat-model decision
*   **Primary Risk:** Treating an Ed25519 signature as an authority boundary even when the same-user model/adapter can read the private-key sidecar and invoke the exported signing path.

This ticket is separate from AIDEV-155's five children. It begins with a decision gate. No authority implementation changes are allowed until the user explicitly decides whether a same-user filesystem-capable actor is in scope. The conservative recommendation is that it is in scope because local Pi agents can be granted file and shell access within the project environment.

## Expected File Changes
*   `[MODIFY]` `docs/specs/LESSON-REGISTRY-V1.md`: State actors, capabilities, storage boundary, and in-scope/out-of-scope same-user access explicitly.
*   `[MODIFY]` `ledgers/lesson-registry-authority.mjs`: Narrow exported key/signing surface or replace local key ownership after the decision.
*   `[MODIFY]` `ledgers/lesson-registry.mjs`: Consume the approved signer boundary without exposing private authority.
*   `[MODIFY]` `ledgers/episode-evolution-ledger.mjs`: Preserve namespace rejection and exact admission verification.
*   `[MODIFY]` `tests/lesson-registry.test.mjs`: Add extracted-key, raw append, signer, reopen, backup, and restore regressions.
*   `[MODIFY]` `tests/lesson-v1.test.mjs`: Validate any changed public contract or error behavior.
*   `[NEW]` `.llm-wiki/wiki/requirements/AIDEV-161-lesson-admission-authority-boundary.md`: Durable decision requirement, created through AIDEV-160 policy when available.

If the user decides same-user filesystem readers are out of scope, implementation may be documentation/test narrowing only and must not claim protection against that actor. If they are in scope, the private signer must move behind a process/service/OS authority that the model and generic ledger caller cannot read or invoke directly; merely renaming, hiding, encrypting with a colocated key, or changing file permissions under the same user is insufficient.

## Step-by-Step Execution
1.  **Phase 1: Reproduce and decide**
    *   Step 1.1: In an isolated test root, open a legitimate registry, read the authority sidecar using same-user access, construct the exported signer/admission, append through the strongest public raw-ledger path, and attempt registry reopen.
    *   Step 1.2: Record the exact result, current documented claim, and available deployment boundaries without publishing the private key or raw output.
    *   Step 1.3: Ask the user to approve one explicit threat model: same-user filesystem actor in scope or out of scope. Keep implementation blocked until answered.
2.  **Phase 2A: In-scope implementation**
    *   Step 2.1: Select a signer boundary not readable/invokable by the model process, with authenticated request scope, least privilege, replay protection, key rotation, backup/restore, and fail-closed unavailability.
    *   Step 2.2: Remove public private-key parsing/signing exports from model-accessible code and bind every admission to repository/root/ledger/envelope identity.
    *   Step 2.3: Preserve exact envelope, predecessor, receipt, lifecycle, and public-key verification on rebuild.
3.  **Phase 2B: Out-of-scope narrowing**
    *   Step 3.1: State that Ed25519 prevents generic API marker forgery and storage tampering without private-key access, not same-user compromise.
    *   Step 3.2: Add a regression documenting that extracted-key signing is possible by design and ensure no stronger claim appears in specs, plans, or review prompts.
4.  **Phase 3: Validate recovery and compatibility**
    *   Step 4.1: Test owned/injected ledgers, reopen, crash windows, authority loss, rotation, backup/restore, wrong signer, raw writer, and historical records.
    *   Step 4.2: Keep generic ledger backup from exposing private authority and reject partial/mismatched recovery.
5.  **Phase 4: Rollback**
    *   Step 5.1: If an external signer migration fails, keep admission blocked and preserve historical verification. Never fall back to the readable sidecar while claiming the stronger boundary.

## Test Matrix
*   **Target Command**: `node --test tests/lesson-registry.test.mjs tests/lesson-v1.test.mjs && npm test`
*   **Validation Scenarios**:
    *   [ ] `A161-T01` Extracted sidecar key plus public signing/raw-append path is reproduced and classified before design selection.
    *   [ ] `A161-T02` No implementation branch proceeds without the explicit user threat-model decision.
    *   [ ] `A161-T03` In-scope design prevents the model/raw writer from reading or invoking the signer and rejects replay/wrong scope.
    *   [ ] `A161-T04` Out-of-scope design contains no claim that same-user key readers are prevented from signing.
    *   [ ] `A161-T05` Generic ledger append without valid authority remains rejected.
    *   [ ] `A161-T06` Signatures remain bound to complete immutable envelope, predecessor, and receipt fields.
    *   [ ] `A161-T07` Reopen, injected ledger, crash, loss, rotation, backup, restore, and mismatch paths fail closed without corrupting durable history.
    *   [ ] `A161-T08` Historical valid records remain readable or a separately approved migration is required before cutover.
