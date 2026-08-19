# Implementation Plan: AIDEV-140 (Boundary & Governance Mapping)

**Recommended T-Shirt Size:** M

## Effort & Risk
**Effort:** Medium. The work involves rigorous governance documentation, test-enforcement, and critical security validations including payload constraints, logging redactions, and symlink auditing.
**Risk:** Medium. While legacy packages are retired, introducing fail-closed enforcement and strict bounds requires precision to avoid breaking valid data streams. The critical security implementations (OOM prevention, logging redaction, symlink purges, and strict WAL isolation) mitigate vulnerabilities but must be tested comprehensively to ensure architectural soundness.

## Expected File Changes
- `docs/architecture/package-boundaries.md`: Update to define the final supported architecture, migration paths, and the explicit dependency graph separating standalone extensions and self-evolution plugins.
- `docs/governance/release-decisions.md` (New/Updated): Publish the keep/fold/replace/pause/deprecate matrix and specific evidence gates.
- `README.md`: Update to reflect repository architecture changes.
- `tests/legacy-self-evolution-retirement.test.mjs`: Expand to verify boundary blocks against obsolete receipt writers, internal validation errors, and OOM limits.
- `tests/architecture-lint.test.mjs` (New): Add static analysis to guarantee zero visibility / strict one-way dependency flow between components.
- `scripts/audit-symlinks.mjs` (New): Add script to detect and prevent dangling symlinks in `node_modules` or `.bin`.
- `package.json`: Cleanup deprecated workspace references and integrate the symlink audit and architecture linting into the CI steps.

## Step-by-Step Execution
1. **Document the Evidence-Backed Matrix**: Draft the release-decision documentation mapping the M0 retirement state and measured evidence requirements for new components.
2. **Define Consumer Migration Paths & Dependency Graph**: Formalize compatibility windows. Explicitly define the dependency graph in `package-boundaries.md` to ensure a strict one-way dependency flow (or zero visibility) between Pi Excalidraw and the self-evolution plugin, actively preventing cycle-dependency loops.
3. **Enforce Ledger Boundaries & Prevent OOM/Leakage**: Update core ledger validation to:
   - Enforce strict byte-size limits on incoming receipt writes *prior* to parsing to prevent OOM crashes from malicious/rogue large payloads.
   - Guarantee deprecated authority boundaries cannot write `AuthoritativeReceiptV1` objects.
   - Ensure the `AuthoritativeReceiptLedger` fails-closed strictly on any internal validation errors (missing schemas, timeouts, malformed signatures).
   - Ensure fail-closed logic explicitly redacts all `AuthoritativeReceiptV1` payload contents from error logs, recording only the unauthorized trust root ID and timestamp to prevent unprotected state leakage.
4. **Clean Symlink Traps**: Audit, detect, and explicitly purge any dangling symlinks in `node_modules` or `.bin` that could inadvertently resolve to cached M0 legacy code.
5. **Validate Standalone Extension Preservation & WAL Isolation**: Ensure Pi Excalidraw boots independently. Implement and enforce exclusive file locking and strict directory isolation for the SQLite WAL, proving that self-evolution components absolutely cannot read or write to it.
6. **Publish Architecture & Documentation**: Sync final updates to repository READMEs, architecture docs, and Linear release notes.

## Test Matrix
- **OOM & Payload Limit Test**: Assert that the ledger immediately rejects overly large payloads *before* parsing is attempted.
- **Authority Trust Root Validation & Redaction Test**: Assert that the ledger rejects arbitrary receipt writes from deprecated boundaries or mock legacy packages, and explicitly verify that the error logs redact sensitive payload data in the process.
- **Internal Validation Error Test**: Assert that the ledger defaults to a hard REJECT in the event of any internal validation failures (e.g., timeouts, missing schemas, or malformed signatures).
- **Circular Dependency Static Analysis Test**: Enforce through a linter or static analysis tool that zero dependency cycles exist between the standalone extension and the self-evolution plugin.
- **Retirement & Symlink Trap Audit**: Validate that no legacy workspace packages are active and that an automated script catches any dangling symlink traps in the workspace.
- **Excalidraw WAL Isolation Test**: Test that the SQLite WAL is exclusively locked and directory-isolated, failing any concurrent access attempts from self-evolution components.
