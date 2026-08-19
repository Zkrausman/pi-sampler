# Implementation Plan: AIDEV-148 Capture versioned expected and realized human value

**T-Shirt Size Estimate:** L

## 1. Effort & Risk

* **Effort Level**: Large. Involves cross-boundary updates across Node.js schemas, ledger persistence, and the independent Go governance tier.
* **Primary Risks**:
  * **OOM Vulnerabilities**: Ledger parsing could exhaust memory if the full episode history is loaded; strict memory-bounded pagination or snapshots must be utilized.
  * **Silent Data Corruption**: Mishandled or missing concurrency keys (`previousAssessmentDigest`) require strict fail-closed ingestion blocks before disk I/O.
  * **State Leakage & Cognitive Bias**: Concurrent independent human assessors might see parallel unfinalized assessments if read-isolation boundaries fail.
  * **Scope Creep Extensibility**: Schemas must structurally reject properties meant for subsequent cohort/efficiency tickets (AIDEV-129) to prevent domain bleeding.

## 2. Expected File Changes

| File Path | Action | Description |
| :--- | :--- | :--- |
| `docs/specs/VALUE-ASSESSMENT-V1.md` | Add | Specification defining expected/realized value contracts, multi-assessor isolation, and optimistic locking mechanics. |
| `contracts/value-assessment-v1.mjs` | Add | TypeBox schema definitions enforcing `additionalProperties: false` and strict invariant checks. |
| `contracts/value-assessment-v1.schema.json` | Add | Exported JSON Schema for external tools and independent Go validation. |
| `ledgers/value-assessment-ledger.mjs` | Add | Ledger facade managing admission, fail-closed validation, read-isolation, and bounded pagination over `EpisodeEvolutionLedger`. |
| `scripts/export-value-assessment-v1-schema.mjs` | Add | Script to compile and export the TypeBox schema to static JSON. |
| `governance/pkg/assessmentvalidator/validator.go` | Add | Go policy enforcement reading the JSON schema to independently assert anti-masquerading invariants (`producer.kind === "human"`). |
| `governance/pkg/assessmentvalidator/validator_test.go` | Add | Go test suite validating the independent policy checks against JSON fixtures. |
| `tests/value-assessment-v1.test.mjs` | Add | Node.js test suite validating strict schema bounds, anti-masquerading, and scope creep rejection. |
| `tests/value-assessment-ledger.test.mjs` | Add | Node.js test suite verifying persistence, fail-closed conditions, memory bounds, and read-isolation. |
| `tests/fixtures/value-assessments/` | Add | Valid and adversarial JSON fixture data (shared between Node and Go). |
| `package.json` | Modify | Add schema generation and validation NPM scripts. |

## 3. Step-by-Step Execution

**Step 1: Domain Specification Definition**
* Draft `docs/specs/VALUE-ASSESSMENT-V1.md`.
* Document expected (pickup) and realized (closeout) value phases.
* Define strict read-isolation boundaries preventing concurrent `producer.id` branches from leaking across evaluation contexts prior to episode closeout (preventing cognitive bias).
* Establish the specific rules for optimistic locking and multi-assessor coexistence.

**Step 2: Schema and Strict Contract Implementation**
* Create `contracts/value-assessment-v1.mjs` utilizing TypeBox.
* Apply `additionalProperties: false` (or equivalent strict mode) at the root and all nested levels to structurally reject arbitrary fields like `cohortId` or `efficiencyScore`.
* Define explicit validation rules enforcing `producer.kind === "human"` and `evidence.class === "human_annotation"`.
* Create `scripts/export-value-assessment-v1-schema.mjs` and execute it to generate `contracts/value-assessment-v1.schema.json`.

**Step 3: Governance & Independent Policy Validation**
* Implement `governance/pkg/assessmentvalidator/validator.go`.
* Ingest `contracts/value-assessment-v1.schema.json` within the Go tier.
* Implement independent Go validation logic to explicitly assert the `producer.kind === "human"` anti-masquerading rule, ensuring models cannot subvert the checks at the governance layer.

**Step 4: Protected Ledger Implementation**
* Create `ledgers/value-assessment-ledger.mjs` over `EpisodeEvolutionLedger`.
* Implement a strict **fail-closed ingestion boundary**: drop any payload failing TypeBox schema validation *before* any disk I/O is attempted.
* Implement **fail-closed concurrency assertions**: reject updates outright if `previousAssessmentDigest` or `revisionSequence` is missing or malformed.
* Implement **memory-bounded pagination** or a compacted snapshot model for ledger resolution to prevent OOM crashes on heavily-annotated episodes.
* Enforce **read-isolation** logic to mask parallel assessment branches until the operational episode is closed.

**Step 5: Adversarial & Structural Testing Implementation**
* Populate `tests/fixtures/value-assessments/` with adversarial edge cases.
* Write Node test `tests/value-assessment-v1.test.mjs` asserting strict property rejection (e.g., submitting `efficiencyScore` fails) and anti-masquerading bounds.
* Write Node test `tests/value-assessment-ledger.test.mjs` asserting OOM pagination limits, fail-closed missing digests, and cross-assessor read-isolation limits.
* Write Go test `governance/pkg/assessmentvalidator/validator_test.go` asserting the governance tier catches model-masquerading attempts.

## 4. Test Matrix

| Test Category | Target Component | Description / Goal |
| :--- | :--- | :--- |
| **Fail-Closed Concurrency** | `value-assessment-ledger.mjs` | Submit an assessment update missing `previousAssessmentDigest`. Expect immediate rejection before any disk write. |
| **OOM Defenses** | `value-assessment-ledger.mjs` | Request resolution on an episode with 10,000+ mock revisions. Verify memory stays within bounds via pagination/snapshotting. |
| **Read-Isolation Boundary** | `value-assessment-ledger.mjs` | Query ledger as `assessor_A` while `assessor_B` has an unfinalized concurrent assessment. Expect `assessor_B`'s branch to be invisible. |
| **Scope Creep Rejection** | `value-assessment-v1.mjs` | Submit a payload containing `efficiencyScore: 0.9` or `cohortId: 123`. Expect TypeBox to fail validation due to `additionalProperties: false`. |
| **Go Tier Anti-Masquerading** | `governance/pkg/assessmentvalidator` | Process a fixture claiming `human_annotation` but generated by `producer.kind === "model"`. Expect the Go policy validator to reject it independently. |
| **Strict Schema Ingestion** | `value-assessment-ledger.mjs` | Submit a structurally malformed assessment. Expect immediate rejection prior to any filesystem I/O locks. |
