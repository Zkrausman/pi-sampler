# Revised Implementation Plan: AIDEV-151

## 1. Effort & Risk
- **Effort:** High (Increased complexity due to strict security mandates, secure state management, and bounded streaming requirements).
- **Risk:** High (Requires diligent execution to prevent OOM Denial-of-Service, symlink directory traversal attacks, and state leakage. Careful management of dependency isolation and strict provenance tagging is essential).

## 2. Expected File Changes
- **New Files:**
  - `docs/specs/LIFECYCLE-RECEIPT-MIGRATION-V1.md`
  - `contracts/lifecycle-receipt-migration-v1.mjs`
  - `contracts/lifecycle-receipt-migration-v1.schema.json`
  - `scripts/export-lifecycle-receipt-migration-v1-schema.mjs`
  - `tests/fixtures/lifecycle-receipts/` (Directory for categorized versioned fixtures)
  - `tests/lifecycle-receipt-migration.test.mjs`
- **Modified Files:**
  - `package.json`

## 3. Step-by-Step Execution
1. **Documentation & Specification:** Draft `docs/specs/LIFECYCLE-RECEIPT-MIGRATION-V1.md` outlining the migration invariants. Document the necessity of strict unidirectional dependency graphs (V1 models/schemas must never reference V0 types or migration logic) and explicitly define the requirement for governance-compliant provenance tagging (e.g., `origin: legacy-v0`).
2. **Schema Definition:** Define the `contracts/lifecycle-receipt-migration-v1.schema.json` ensuring it strictly requires metadata tagging (`origin: legacy-v0` or `migrated: true`) to distinguish native V1 records from migrated V0 records. Create the schema export script in `scripts/export-lifecycle-receipt-migration-v1-schema.mjs`.
3. **Fixture Curation:** Populate `tests/fixtures/lifecycle-receipts/` with comprehensive fixtures including valid, malformed, ambiguous, and authority-bearing receipts. Add malicious fixtures (e.g., excessively large files, deeply nested JSONs, and invalid signatures) to test fail-closed operational bounds.
4. **Contract Implementation:** Implement `contracts/lifecycle-receipt-migration-v1.mjs` enforcing the following critical security measures:
   - **OOM Prevention:** Mandate streaming JSON parsing and strict file size limits when reading inputs.
   - **Symlink Trap Mitigation:** Strictly reject symlinks and enforce sanitized absolute path resolution to prevent directory traversal.
   - **Secure Checkpointing:** Persist restartable checkpoint states in secure, permission-restricted storage, ensuring raw receipt contents and sensitive identities do not leak into standard logs or globally readable temporary files.
   - **Architectural Isolation:** Maintain a strict unidirectional dependency graph.
5. **Testing & Validation:** Implement tests in `tests/lifecycle-receipt-migration.test.mjs` to comprehensively validate the migration behavior against all fixture categories, fail-closed assertions, and security boundaries.

## 4. Test Matrix
| Category | Scenario | Expected Outcome |
|---|---|---|
| **Valid** | Well-formed v0 receipt. | Migration succeeds. `TicketEpisodeV1` generated with required `origin: legacy-v0` provenance tag. |
| **Malformed** | Corrupted JSON or missing structural fields. | Immediate fail-closed rejection. Emits deterministic error code. |
| **Ambiguous** | Valid structure but conflicting legacy states. | Explicit rejection with incompatibility error code. |
| **Authority-Bearing** | Receipt containing caller claims/text. | Secure extraction without elevating untrusted text into authoritative observations. |
| **Operational Bounds (OOM/Depth)** | Excessively large file size or JSON nesting depth exceeding limits. | Immediately rejected prior to full memory load. Fail-closed assertion triggered. |
| **Path/Symlink Security** | Source path is a symlink or contains traversal vectors. | Fails immediately. Strict absolute path resolution enforced. |
| **Checkpoint Security** | Interrupted migration process. | Resumes securely. Verifies state data is permission-restricted and omitted from logs. |
| **Signature Bounds** | Invalid cryptographic signatures on source receipt. | Fail-closed assertion triggered. Migration explicitly aborted. |
