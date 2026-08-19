# Implementation Plan: AIDEV-136 (Ship the coherent pi-evolution plugin UX)

## Effort & Risk
- **Effort:** High. Implementing strict cross-boundary validation, pagination, and architectural constraints across the Node/React boundaries requires thorough design and careful refactoring.
- **Risk:** Medium to High. Fail-closed mechanisms and strict path evaluations (like symlink resolution) might inadvertently break existing workflows if not meticulously configured. Strict payload limits on the bridge might require substantial UI changes to support pagination.

## Expected File Changes
- `package.json` / `.eslintrc.js`: Add ESLint rules for dependency cycles.
- `src/plugins/pi-evolution/index.ts`: Plugin shell entrypoint, capability definitions, and compatibility bounds.
- `src/adapter/validation/path-policy.ts`: Add symlink resolution logic.
- `src/adapter/attestation.ts`: Implement `verifyAuthoritativeReceiptV1` and fail-closed logic.
- `src/bridge/ledger-bridge.ts`: Add pagination, hardcaps, and DTO/sanitization layer safely decoupling from `episode-evolution-ledger.mjs` and `authoritative-receipt-ledger.mjs`.
- `src/bridge/dto-sanitizer.ts`: New file for defining sanitization models.
- `src/ui/components/LedgerView.tsx`: Update to support cursor-based pagination and chunked data reception.
- `src/components/Evolution/`: New Directory containing Stitch UI powered components for Episodes, Costs, Annotations, Lessons, and Evolution tracking dashboards.
- `src/App.tsx` & `src/main.tsx`: Mounting the plugin entry points and wrapping in `ThemeProvider`.
- `tests/pi-evolution-ux.test.mjs`: Validations for the React mounting boundaries, adapter routing, and UI lifecycle states.

## Step-by-Step Execution

### Step 1: Enforce Unidirectional Architecture
- Implement a strict unidirectional dependency graph separating the React UI layer from the Node/Adapter layer.
- Configure ESLint with `eslint-plugin-import` and enforce the `no-circular-dependencies` (or `import/no-cycle`) rule.
- Verify module resolution to ensure UI components never directly import Node adapters.

### Step 2: Module Loading and Isolation
- Bootstrap the new `pi-evolution` plugin package boundary. Ensure no legacy package references exist to satisfy `legacy-self-evolution-retirement.test.mjs`.
- Establish clear interfaces for the adapter layer.
- Verify that module loading adheres to the structural rules defined in Step 1, dropping any cyclical dependencies identified by the static analyzer.

### Step 3: Implement Core Adapters
- Define the base adapter functions that interact with the underlying system state.
- Ensure state structures are well-typed and isolated from the UI rendering context.

### Step 4: Evidence Collection and Attestation Assertions
- Implement strict fail-closed assertions for all evidence gathering.
- Ensure untrusted claims (e.g., `caller_claim`) are programmatically blocked from triggering any actionable workflows or state mutations.
- Enforce `verifyAuthoritativeReceiptV1` on attestations; if verification fails, immediately throw a fail-closed error or definitively drop the payload.
- Introduce an explicit sanitizer/DTO (Data Transfer Object) layer to strip out all non-essential environment and local state data before it moves toward the UI.

### Step 5: Ledger Bridge and State Dispatch
- Integrate the DTO/sanitizer layer into `ledger-bridge.ts` to guarantee unprotected state leakage does not occur when dispatching payloads to the React UI space.
- Implement strict pagination, cursor-based chunking, or streaming mechanisms over the bridge.
- Enforce a hardcap on the maximum payload size sent across the bridge at 5MB or fewer than 500 rows per chunk.

### Step 6: Path Policy Validations and Symlink Safety
- Refactor file and directory policy validators to guarantee adherence to `path-policy-v1.json` (no writes to `.pi/sessions/**`, etc.).
- Explicitly resolve all real paths using `fs.realpath` before executing any pattern matching against the path policy.
- Check resolved paths against the workspace boundaries; any symlinks resolving outside the target workspace MUST trigger an immediate fail-closed error.

### Step 7: Ticket Episode UX (Slice 2) & Dashboards (Slice 3 & 4)
- Create components using Stitch UI primitives (`Box`, `Flex`, `Grid`) to handle the episode workflow (start, resume, inspect, annotate, close). Bind UI actions to `validateTicketEpisodeTimelineV1`.
- Develop data-grids for observing exact-cost snapshots, usage query engine results, task efficiency cohorts, and lessons. Integrate `AuthoritativeReceiptV1Schema` validations to visually distinguish `attested` versus untrusted claims.
- Build the views to execute experiments, canary promotions, and rollbacks. Integrate UI hooks into the `EpisodeEvolutionLedger` memory-bounded queries (`listRecords`, `queryEvolutions`, `findEvent`).

### Step 8: Review & Attestation
- Ensure commits are signed off (`git commit --signoff`).
- Utilize `scripts/generate-review-packet.mjs` to prepare the solo maintainer adversarial review markers.

## Test Matrix
| Component / Feature | Test Type | Acceptance Criteria |
| :--- | :--- | :--- |
| **Dependency Flow** | Static Analysis | CI ensures zero circular dependencies and clear Node/UI boundaries. |
| **Attestation** | Unit | Malicious `caller_claim` inputs are rejected, fail closed, and do not mutate state. |
| **Ledger Bridge** | Integration | Payloads >5MB or >500 rows are blocked/chunked. DTO strips environment variables. |
| **Path Validation** | Integration | `fs.realpath` resolution blocks symlinks pointing outside the workspace. |
| **Plugin Compatibility** | Smoke (`validate-pi-extensions`) | Plugin mounts without crashing and passes entry point static validation. |
| **Ticket Episode Workflows** | UI/Unit | Resuming/closing episodes trigger the correct underlying contract schemas (`TICKET_EPISODE_V1_SCHEMA_ID`). |
| **Evidence Attestation Display** | Contract/UI | Untrusted claims are visibly distinct from `observed_evidence` that passes `verifyAuthoritativeReceiptV1`. |
| **Ledger Query Bounds** | Integration | Ensure `queryEvolutions` respects memory boundaries and limits returned UI rows without stalling the main thread. |
| **Legacy Retirement** | Governance | Automated run of `tests/legacy-self-evolution-retirement.test.mjs` asserts 100% absence of legacy artifacts. |
| **Policy Validation** | Governance | Full pass of `run-governance-tests.mjs` covering path rules and delivery evidence manifests. |
