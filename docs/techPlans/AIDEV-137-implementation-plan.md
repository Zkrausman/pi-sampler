# Implementation Plan: AIDEV-137 (Rebuild Delivery Controller and Wiki Delivery as authoritative adapters)

## Effort & Risk
* **Effort:** High. Involves rebuilding two critical components (Delivery Controller and Wiki Delivery) to adhere to strict new v1 contracts (authoritative-receipt-v1 and ticket-episode-v1) while integrating with durable ledgers and governance validators.
* **Risk:** High. Dealing with trust boundary separation, two-phase commits, deterministic idempotency, fail-closed mechanics, and strict validation increases the risk of edge-case failures (e.g., race conditions, crash recovery gaps, quarantine mishandling).

## Expected File Changes
* `adapters/delivery-controller.mjs` (New/Rebuilt): Implementation of the authoritative delivery controller adapter.
* `adapters/wiki-delivery.mjs` (New/Rebuilt): Implementation of the authoritative wiki delivery adapter.
* `governance/docs/delivery-evidence/README.md` (Update): Align examples with `delivery-evidence/v1` rules.
* `tests/adapters/delivery-controller.test.mjs` (New): Test suite for delivery controller adapter.
* `tests/adapters/wiki-delivery.test.mjs` (New): Test suite for wiki delivery adapter.

## Step-by-Step Execution
1. **Scaffold Adapter Structures:**
   * Create `adapters/delivery-controller.mjs` and `adapters/wiki-delivery.mjs`.
   * Define dependencies on `contracts/authoritative-receipt-v1.mjs`, `contracts/ticket-episode-v1.mjs`, `ledgers/authoritative-receipt-ledger.mjs`, and `ledgers/episode-evolution-ledger.mjs`.

2. **Implement Delivery Controller Adapter:**
   * Implement two-phase intent and acknowledgement pattern with durable run IDs.
   * Implement deterministic idempotency key generation `(project, ticket, episode, operation, producer, authority)` using cryptographic hashing (e.g., SHA-256) to prevent state leakage.
   * Enforce bounds on idempotency key cache and in-flight intent tracking by utilizing strict limits, TTLs, or LRU eviction policies to prevent OOM vulnerabilities.
   * Ensure trust boundary separation (enforcing `observed_evidence` requires a verified authority response).
   * Integrate quarantine logic for malformed or conflicting records, ensuring records are sanitized of sensitive tokens/credentials before persistence.
   * Implement explicit authorization contract (interactive approval or single documented environment-based contract).
   * Enforce strict fail-closed handling: If validation fails, if the authority times out, or if quarantine storage is unavailable, the operation MUST immediately halt, reject the request, and fail-closed.

3. **Implement Wiki Delivery Adapter:**
   * Restrict operations strictly to the `.llm-wiki/` path space. Before any file operations, use strict `realpath()` resolution to ensure the resolved absolute path starts strictly within the absolute path of the `.llm-wiki/` directory (mitigating symlink traps).
   * Bind wiki receipts generation to observed results (`page_ids`, `source_ids`, `observation_ids`).
   * Implement transactional updates for `delivery-evidence/v1` manifests and tie into pull request sync validation.
   * Enforce strict fail-closed handling across operations (e.g., validation/resolution failures halt immediately).

4. **Update Governance Documentation:**
   * Update `governance/docs/delivery-evidence/README.md` to ensure all JSON examples pass the `governance/pkg/deliveryevidence/validator.go` production validator.

5. **Test Integration & Conformance:**
   * Wire the adapters to use the `tests/helpers/authoritative-receipt-conformance.mjs` helpers for tests.
   * Run the Go validators (`delivery-evidence-validator`) against generated artifacts to confirm standard compliance.

## Test Matrix
| Test Category | Target | Description |
| :--- | :--- | :--- |
| **Unit** | Delivery Controller | Verify two-phase intent and ack process, including crash recovery scenarios without duplicated/lost dispatches. |
| **Unit** | Delivery Controller | Verify deterministic idempotency key scoping (SHA-256 generation), LRU/TTL eviction behavior, and rejection of key reuse/collisions (`idempotency_conflict`). |
| **Unit** | Delivery Controller | Verify fail-closed assertions on validation failures, authority timeouts, and quarantine storage unavailability. |
| **Unit** | Wiki Delivery | Verify path isolation (strictly `.llm-wiki/`), strictly testing symlink traps via `realpath()` resolution, and rejection of path traversals (`../`). |
| **Unit** | Wiki Delivery | Verify that wiki receipts accurately bind to `observed_evidence` from the authority response and fail-closed on tampering. |
| **Integration** | Both Adapters | Verify malformed/tampered records are sanitized of sensitive tokens, properly caught, isolated to `quarantine/`, and marked `quarantined`. |
| **Governance** | Docs | Ensure all examples in `governance/docs/delivery-evidence/README.md` pass the Go validator CLI. |
| **Conformance** | Both Adapters | Ensure passes `runReceiptConformance` suite (rejecting forged authorities, missing verifiers, stale timestamps). |
