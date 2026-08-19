# Implementation Plan: AIDEV-131 (Integrate authoritative test, Git, review, provider, GitHub/Linear, and Wiki receipts)

## Effort & Risk

* **Effort**: **High (XL)** - This is an integration parent ticket requiring the implementation of four distinct slices, bridging existing contracts with robust adapter domains. The scope includes strict boundary enforcement, cryptographic/IPC isolation, and bounded memory processing.
* **Risk**: **High** - Key risks include OOM vulnerabilities from unbounded test outputs/diffs, potential network partition hangs from external trackers, escaping sandbox via symlinks, and masquerading vulnerabilities where caller strings bypass evidence gates. The plan mitigates these through strict size limits, fail-closed timeouts, canonical sandbox evaluation, restricted IPC instantiation, and strict separation of duties enforcement.

## Expected File Changes

**Slice 1: Conformance Harness & Core Isolation**
* `contracts/authoritative-receipt-v1.mjs` (Update): Implement cryptographic signatures or restricted IPC trust boundaries (e.g., trusted local socket) to ensure `observed_evidence` can strictly only be instantiated by the connected authority, isolating it from `caller_claim`.
* `tests/helpers/authoritative-receipt-conformance.mjs` (Update): Expand the `fakeTrustRoot` and `runReceiptConformance` matrix to include `Unresponsive Node` (network partition/timeout) and `Self-Approval` failure modes.

**Slice 2: Test-runner plus Git/review receipts**
* `contracts/authorities/test-runner-authority.mjs` (Create): Implement validation for test executions, including bounded-buffer streaming and maximum byte limits to prevent OOM vulnerabilities during output digesting.
* `contracts/authorities/git-review-authority.mjs` (Create): Implement git commit, diff, and review validators. Includes mandatory `realpath` canonicalization to trap symlink traversal out of the workspace sandbox, bounded diff evaluation, and strict `Author != Reviewer` separation of duties validation.
* `tests/authorities/test-runner-git-review.test.mjs` (Create): Conformance test suite asserting all fail-closed boundaries (OOM evasion, symlink trapping, separation of duties).

**Slice 3: Provider plus GitHub/Linear receipts**
* `contracts/authorities/provider-authority.mjs` (Create): Implement provider run validations. Explicitly sanitize all payloads to capture only aggregated metrics/counts, strictly stripping all raw tokens, secrets, and environment strings.
* `contracts/authorities/tracker-authority.mjs` (Create): Implement GitHub PR and Linear states with aggressive fail-closed timeouts for external fetches. Enforce `Author != Reviewer` on PR merge/approval states.
* `tests/authorities/provider-tracker.test.mjs` (Create): Conformance test suite targeting tracker network partitions and provider token sanitization.

**Slice 4: Wiki receipts and End-to-End**
* `contracts/authorities/wiki-authority.mjs` (Create): Implement Wiki ID and lint result validations with strict fail-closed network timeouts.
* `tests/authorities/wiki.test.mjs` (Create): Test suite for Wiki authority conformance.
* `tests/e2e/episode-authoritative-closeout.test.mjs` (Create): Definitive end-to-end fixture proving episode closeout strictly via IPC-signed authoritative receipts, safely rejecting all caller-authored string masquerade attempts.

## Step-by-Step Execution

### Slice 1: Shared Conformance Harness & Cryptographic Isolation
1. **Implement Trust Boundary**: In `contracts/authoritative-receipt-v1.mjs`, enforce a restricted IPC socket trust boundary or internal cryptographic signing so that `observed_evidence` structs cannot be forged by generic `caller_claim` inputs.
2. **Implement Fake Trust Roots & Matrix**: In `tests/helpers/authoritative-receipt-conformance.mjs`, build programmable fakes simulating successes, timeouts (`Unresponsive Node`), and validation failures. Expand `runReceiptConformance` to enforce these states.

### Slice 2: Test-Runner & Git/Review Authorities
1. **Test-Runner Memory Protection**: Implement test-runner contracts, explicitly using bounded streams and max-byte configurations for test output extraction. Drop or immediately reject outputs exceeding memory thresholds rather than loading into RAM.
2. **Git/Review Sandbox & Governance**: Implement Git payload parsers. Canonically resolve all filesystem paths via `realpath` and assert they fall cleanly within the trusted workspace sandbox (defeating symlink traversal). For reviews, aggressively reject evidence where `Author == Reviewer`.
3. **Validation**: Test the authorities through the conformance matrix, specifically targeting large file ingestion and symlink out-of-bound attempts.

### Slice 3: Provider & GitHub/Linear Trackers
1. **Provider Sanitization**: Implement execution provider schemas. Apply strict sanitization routines that aggressively drop token values and authorization headers, persisting only token counts, duration, and terminal results.
2. **Tracker Timeouts & Separation of Duties**: Implement GitHub/Linear integration using configured strict fail-closed timeouts. Verify that network partitions instantly abort evidence collection. Apply the `Author != Reviewer` mandate to GitHub PR state evaluations.
3. **Validation**: Execute the conformance harness to prove node unresponsiveness causes atomic failures and secrets do not leak.

### Slice 4: Wiki Receipts & End-to-End Fixture
1. **Wiki Timeouts**: Build schemas enforcing standard Wiki identifiers and observation tracking, wrapped in the identical strict network timeout boundary.
2. **End-to-End Closeout**: Construct the final test in `tests/e2e/episode-authoritative-closeout.test.mjs` demonstrating the entire lifecycle closing out via valid IPC-endorsed adapter signals.

## Test Matrix

| Authority Domain | Valid (Accepted) | Forged / Spoofed | Unresponsive (Hang) | Self-Approval / Perms | Mismatched / OOM | Partial / Idempotent | Cross-Repo / Escaped |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Fake / Baseline** | Pass | Fail (Reject) | Fail (Timeout) | Fail (Governance) | Fail (Schema) | Fail / Idempotent | Fail (Scope) |
| **Test-Runner** | Pass | Fail (IPC Bound) | N/A (Local) | N/A | Fail (Size Bound) | Fail / Idempotent | Fail (Sandbox) |
| **Git & Review** | Pass | Fail (IPC Bound) | N/A (Local) | Fail (Author==Rev) | Fail (Size Bound) | Fail / Idempotent | Fail (Symlink Trap) |
| **Execution Provider**| Pass | Fail (IPC Bound) | N/A (Local) | N/A | Fail (Raw Leakage)| Fail / Idempotent | Fail (Scope) |
| **GitHub / Linear** | Pass | Fail (IPC Bound) | Fail (Timeout) | Fail (Author==Rev) | Fail (Schema) | Fail / Idempotent | Fail (Scope) |
| **Wiki Governance** | Pass | Fail (IPC Bound) | Fail (Timeout) | N/A | Fail (Schema) | Fail / Idempotent | Fail (Scope) |
| **End-to-End Close**| Pass | N/A (Atomic fail) | N/A (Atomic fail) | N/A (Atomic fail) | N/A (Atomic fail) | N/A | N/A (Atomic fail) |
