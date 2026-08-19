# Implementation Plan: AIDEV-145 - Define Usage Observation v1 and exact price snapshots (Revised)

## 1. Effort & Risk
- **Effort**: Medium-High. Requires defining robust schema validation that handles financial invariants (avoiding IEEE 754 float precision issues), strict depth/size bounding, secure payload filtering, and safe filesystem operations. 
- **Risk**: High. Usage metrics feed into immutable ledgers and authoritative receipts. Failures in numerical precision, unbounded schema parsing (OOM), cyclic module dependencies, or PII leakage present significant security and architectural risks.

## 2. Expected File Changes

### Contracts & Schema Definitions
- `contracts/usage-observation-v1.mjs` *(New)*: Implementation of the exact canonical schema. Will enforce strict unidirectional dependency (imported *by* legacy contracts, not importing them). Uses string-based exact decimals or `BigInt` for cost/price fields to avoid float corruption. Includes bounded array limits and max-depth limits for parent/subagent chains. Strict allowed-key filtering for request/claim data.
- `contracts/usage-observation-v1.schema.json` *(New)*: The static exported JSON schema defining the shape. Will include explicit `maxItems` constraints and regex constraints for string-based numeric types.
- `scripts/export-usage-observation-v1-schema.mjs` *(New)*: Export tooling to generate the static JSON schema from the MJS contract definition. Will utilize safe, atomic file writing with strict path resolution and `fs.lstat` symlink rejection.

### Documentation & Specifications
- `docs/specs/USAGE-OBSERVATION-V1.md` *(New)*: Markdown specification detailing invariants (precision, depth limits, PII sanitization), token categories, price snapshots, and failure scenarios.

### Test Suites & Fixtures
- `tests/usage-observation-v1.test.mjs` *(New)*: Tests validating float rejection, bounded array limits, max-depth recursion, PII leakage prevention, strict schema version matching, and fail-closed mechanisms.
- `tests/helpers/usage-observation-conformance.mjs` *(New)*: Helpers for generating valid, invalid, malformed, float-corrupted, cyclic, and PII-laden state fixtures.

### Repository Configuration & Package Scripts
- `package.json` *(Modify)*: Append package scripts for building and validating the usage observation schemas.
  - Add `"generate:usage-observation-schema": "node scripts/export-usage-observation-v1-schema.mjs"`
  - Add `"validate:usage-observation-schema": "node scripts/export-usage-observation-v1-schema.mjs --check"`

## 3. Step-by-Step Execution

1. **Write Documentation & Specs**: Draft `docs/specs/USAGE-OBSERVATION-V1.md`. Document the mandate for string-based exact decimals/BigInt for all costs/prices. Define the unidirectional dependency rule, maximum array sizes (`maxItems`), subagent recursion max-depth, and strict allowed-key constraints to prevent PII leakage.
2. **Implement Core Contract Schema**: Create `contracts/usage-observation-v1.mjs`. 
   - Define exact attribution identities and token categories.
   - **Fix 1**: Mandate string-based exact decimals or `BigInt` for `price` and `cost` fields. Reject IEEE 754 floats.
   - **Fix 2**: Implement a strict max-depth limit for `parent`/`subagent` runs to prevent cycle loops. Ensure module dependencies are strictly unidirectional (this module has no dependencies on episode/receipt contracts).
   - **Fix 3**: Enforce strict `maxItems` limits on unbounded arrays (segments, sessions, attempts).
   - **Fix 4**: Implement explicit allowed-key filtering to silently drop or actively reject unauthorized keys (API keys, prompt text, PII) in request/provider/claim objects.
3. **Build Secure Export Tools**: Create `scripts/export-usage-observation-v1-schema.mjs`. 
   - **Fix 5**: Implement strict `path.resolve` checks. Pre-check the destination with `fs.lstat` to explicitly fail if a symlink is detected. Write the file atomically (e.g., write to a `.tmp` file and rename).
4. **Update NPM Scripts**: Modify `package.json` to include `"generate:usage-observation-schema"` and `"validate:usage-observation-schema"`.
5. **Create Test Helpers**: Author `tests/helpers/usage-observation-conformance.mjs` to build fixtures, including edge cases like deeply nested runs, oversized arrays, and payloads with simulated PII.
6. **Implement Test Suite**: Author `tests/usage-observation-v1.test.mjs`.
   - Assert floating-point numbers fail-closed.
   - Assert subagent depth > max-depth fails closed.
   - Assert arrays > `maxItems` fail closed.
   - Assert sensitive metadata (e.g., keys, prompts) is systematically stripped or fails closed.
   - Assert all standard component sum, missing field, and chronology invariants.
7. **Verify Interactions & Review**: Run tests and linting. Ensure zero cyclic module dependencies exist.

## 4. Test Matrix

| Scenario | Description | Expected Outcome |
|----------|-------------|------------------|
| **Floating-Point Rejection** | Provide costs/prices as IEEE 754 floats instead of string decimals/BigInt. | Fail closed. |
| **Max-Depth Validation** | Provide a parent/subagent attribution chain exceeding the max-depth limit. | Fail closed (Recursion error prevention). |
| **Unbounded Array Limits** | Provide an array of `segments` or `attempts` exceeding `maxItems`. | Fail closed (OOM prevention). |
| **PII / Secret Stripping** | Inject API keys, prompt text, or unauthorized headers in caller claims/request metadata. | Fail closed or strictly strip unauthorized keys. |
| **Symlink Trap in Export** | Attempt to export schema to a destination that is a symlink. | Export script aborts safely without overwriting target. |
| **Valid Canonical Schema** | Provide string-based decimals, bounded arrays, shallow depths, and exact model identities. | Pass validation smoothly. |
| **Missing Required Attribution** | Omit exact model, provider, request, or session identities. | Fail closed. Reject complete usage assertion. |
| **Inconsistent Token Totals** | Component sums (input + output + reasoning) do not match the declared `total`. | Fail closed. Reject mismatched values. |
| **Chronology Invariants** | Start and end times overlap incorrectly or start occurs after end. | Fail closed. |
| **Future Schema Versions** | Schema version field is set to a future, unrecognized version. | Fail closed. |
