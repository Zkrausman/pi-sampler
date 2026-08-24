# Implementation Plan: AIDEV-182

## 1. Concrete Architectural Decisions

This plan consolidates overlapping implementation-plan skills into one grounded, token-efficient manual planning workflow that produces implementation-ready plans.

### Selected Mechanisms and Rejected Alternatives
- **Canonical Skill**: Retain one canonical `create-implementation-plan` skill. **Rejected**: Retaining overlapping wrappers (like `create-implementation-plan-team`); these cause confusion and split authority.
- **Planning Handoff**: Manual Antigravity handoff. **Rejected**: An automated Gemini adapter; automatic Antigravity launch, UI scraping, credential automation, browser automation, and live planner adapters are non-goals, as implementation/publication must be manually separated from automated Pi tasks.
- **Validation Base**: Exact immutable Git-object validation. **Rejected**: Mutable refs or working-tree assumptions, which create race conditions and drift.
- **Schema Management**: TypeBox runtime schema plus generated JSON Schema and parity checks. **Rejected**: Independently maintained drifting schemas, which lead to desynchronization between validators and documentation.
- **Validation Execution**: Deterministic bounded validation. **Rejected**: Executing candidate files or commands (prompts, hooks, PR candidate logic), which violates security boundaries.
- **Built-in Challenge**: One risk-tiered built-in challenge. **Rejected**: Zero challenge (leads to shallow plans) or repeated open-ended red teams (wastes resources without bounds).

### Independent Reviewable Slices

Implementation will be split into three independently reviewable slices with explicit dependencies (to avoid a multi-purpose mega-PR):
1. **Canonical Skill & Authority**: Canonical skill consolidation (`.agents/skills/create-implementation-plan/SKILL.md`), deletion of the team wrapper, and authoritative documentation (`docs/IMPLEMENTATION-PLANNING.md`).
2. **Manifest v2 Contract**: The Manifest-v2 TypeBox contract (`contracts/implementation-plan-manifest-v2.mjs`), exporter script (`scripts/export-implementation-plan-manifest-v2-schema.mjs`), generated schema, and parity tests (`tests/implementation-plan-manifest-v2.test.mjs`).
3. **Deterministic Plan Validator**: The deterministic plan validator (`scripts/validate-implementation-plan.mjs`), negative fixtures, audit corpus, and final integration tests.

*Compatibility Boundary*:
- Slice 1 may merge independently while preserving v1 behavior.
- Slice 2 introduces the v2 contract/exporter/schema/parity foundation.
- Slice 3 depends on Slice 2’s trusted contract and adds the validator, negative fixtures, audit corpus, and integration.
- V2 cannot become the default until every required slice is merged and activated from the trusted base.

## 2. Expected File Changes

### Slice 1: Canonical Skill & Authority
- `[MODIFY]` `.agents/skills/create-implementation-plan/SKILL.md`: Update to become the single canonical planning skill. Strip automatic commit/push/PR and Linear SDLC sync capabilities. Add instructions for exact-base worktree provisioning and manual Antigravity handoff.
- `[DELETE]` `.agents/skills/create-implementation-plan-team/SKILL.md`: Delete redundant team wrapper.
- `[NEW]` `docs/IMPLEMENTATION-PLANNING.md`: Authoritative repository documentation target specifying canonical workflow, migration procedures, authority boundaries, manual Antigravity handoff, and rollback behavior.

### Slice 2: Manifest v2 Contract
- `[NEW]` `contracts/implementation-plan-manifest-v2.mjs`: Define executable TypeBox schemas for `implementation-plan-manifest/v2`, supporting epic metadata, dependencies, and bounded resource limits.
- `[NEW]` `scripts/export-implementation-plan-manifest-v2-schema.mjs`: Schema export script for the v2 manifest.
- `[NEW]` `contracts/implementation-plan-manifest-v2.schema.json`: Generated JSON Schema artifact for the v2 manifest.
- `[NEW]` `tests/implementation-plan-manifest-v2.test.mjs`: Parity tests proving runtime and generated-schema agreement.

### Slice 3: Deterministic Plan Validator
- `[MODIFY]` `tests/implementation-plan-skills.test.mjs`: Migrate tests to enforce uncommitted-only authority, manual handoff, and exact-base constraints, using existing plans as a read-only audit corpus.
- `[NEW]` `scripts/validate-implementation-plan.mjs`: Executable deterministic local validation utility.

## 3. Step-by-Step Execution

### Phase 1: Trusted Boundary and Bounded Single-Ticket Protocol

Specify exactly two stages for the planning protocol:

**Stage 1 — In-depth construction**
One manual Antigravity Gemini planner session:
1. Receives the exact planning base, ticket revision, bounded output contract, and research packet.
2. Runs or consumes bounded parallel research for repository reality, contracts/governance, and ticket requirements/dependencies.
3. Synthesizes exactly one draft.
4. Runs exactly one built-in challenge round (risk-tiered: ordinary plans receive focused completeness/repository-reality challenge; only trusted high/critical risk or explicit threat-model triggers use an adversarial red-team profile). Never add extra challenge rounds or open-ended issue hunting.
5. Performs exactly one integrated revision.
6. Emits the uncommitted plan and sibling manifest.

**Stage 2 — Lightweight independent review**
Exactly one fresh read-only reviewer (independent review before implementation):
- Verifies artifact and base identity, explicit ticket requirements, repository grounding, scope/authority, and acceptance coverage/implementation readiness.
- Cannot edit the plan and is not a second open-ended adversarial architecture exercise.

*State progression*: `researching -> drafting -> internal_challenge -> internal_revision -> independent_review -> remediation_1? -> verification_1? -> remediation_2? -> verification_2? -> approved | human_escalation`

For defects, resume the planner to correct complete artifacts; the independent reviewer verifies them. At most two planner-fix/reviewer-verify cycles total. Hardening and preferences do not consume cycles. Unresolved defects after cycle two require human escalation. Do not launch additional reviewers or ratchet requirements.

### Phase 2: Manual Handoff and Authority
- **Trusted selection**: Operator-owned trusted project policy selects the manual Gemini planning model and high planning effort. Candidate code, plan contents, CLI flags, environment variables, prompts, pane metadata, or workspace metadata cannot select trusted policy, planning models, reviewer roles, hard dependencies, or final-review configuration. Research, repository-reality, and risk-triggered roles remain separately configurable through trusted policy.
- **Pi and Antigravity boundary**: Pi gathers bounded repository research and verification material inside the exact leased planning worktree. Pi cannot invoke, automate, impersonate, or represent Gemini as a local/provider model or subagent. The operator manually opens the exact leased worktree in Antigravity and supplies Gemini the frozen research packet and bounded output contract. Gemini writes only the uncommitted plan and sibling manifest. Automatic Antigravity launch, UI scraping, credential automation, browser automation, and a live planner adapter are non-goals.
- **Separate authorities**: Explicitly separate planning, repository research, internal challenge, independent plan review, deterministic validation, commit, push, PR creation/update, tracker/Linear mutation, exact-head/final publication review, and merge. No planning output grants later lifecycle authority.
- **Trusted publication/exact-head gate**: Verifies the already approved artifacts and their exact binding. It cannot restart substantive plan design or add requirements.

### Phase 3: Repository Grounding
- `scripts/delivery-worktree.mjs` (and its exported `prepareDeliveryWorktree` and `cleanupDeliveryWorktree` functions) bounds the exact-base worktree provisioning.
- `contracts/implementation-plan-manifest-v2.mjs` will align with existing TypeBox contract/exporter/test patterns in `contracts/` and `scripts/` (e.g. `scripts/export-ticket-episode-v1-schema.mjs`).
- Validation will cite exact existing repository schemas. All proposed paths must be classified as existing-modified, existing-deleted, or new.

### Phase 4: Implementation Readiness & Manifest Constraints
The `implementation-plan-manifest/v2` TypeBox contract must include bounded machine-readable fields for:
- Hard dependencies and expected predecessor outputs.
- Proposed soft dependencies with evidence and confidence.
- Planning effort and implementation size.
- Requirement readiness, information gain, downstream unblock set.
- Affected contracts and packages, conflict surface, staleness horizon, risk-reduction value.
- Unresolved human decisions, exact issue revision, exact repository revision.
- Owned files, symbols, and contracts; compatibility assumptions, staleness triggers, just-in-time revalidation inputs.

Epic advance planning remains an umbrella dependency/contract map plus independently approved per-ticket plans and manifests—never a mega-plan, mega-branch, or mega-PR. The skill must not silently choose portfolio priority or promote inferred edges into hard blockers.

Require centralized reviewed numeric limits, deterministic boundary tests, and fail-closed behavior without inventing unsupported values. Do not reopen the previously arbitrated need for exact numeric constants.

### Phase 5: Deterministic Validation, Observability, and Recovery
Implement `scripts/validate-implementation-plan.mjs` with stable CLI invocation.

**Platform**: Support Windows local-development behavior; Linux protected-CI behavior; portable Git and path handling. Deterministically reject Windows drive/device paths, backslashes, absolute paths, traversal, and encoded traversal.
**Recovery**: The validator is intentionally deterministic and stateless. Support stateless retry behavior after dependency or historical-object availability is restored. No mutation or partial state requiring recovery. Bounded temporary fixture cleanup. Concurrency and restart-state semantics are non-applicable rather than inventing mutable state.
**Observability**: Define deterministic, bounded JSON diagnostics and stable error codes. Do not log or emit unbounded candidate content, prompts, credentials, local paths unnecessarily, reviewer sessions or identities, or raw sensitive artifacts. The validator’s deterministic result envelope and diagnostic codes serve as validation evidence.

### Explicit Ownership Mapping
- **Implementation evidence**: The exporter owns the generated JSON Schema artifact.
- **Negative fixtures**: Test-owned evidence (independently authored), rather than generator-produced fixtures.
- **Generated-schema evidence**: Runtime/schema parity tests prove generated-artifact consistency.
- **Acceptance owner**: The deterministic validation utility defines and owns bounded acceptance results/diagnostics.
- **Independent approval evidence**: The independent reviewer is the owner of plan-approval evidence.
- **Authoritative protected-CI evidence**: The trusted-base CI serves as the authoritative verification owner after publication.

### Phase 6: Migration, Rollback, and Residual Decisions
- AIDEV-182 itself remains `acceptance-manifest/v1`.
- v2 becomes the default only after its contract, validator, canonical skill, and documentation are merged into the trusted base.
- Historical v1 artifacts remain readable and are never silently rewritten.
- Rollback restores the previous trusted skill version without restoring automatic lifecycle authority.
- Relevant predecessor drift pauses queued implementation for manual Gemini refresh and renewed approval.
- Unresolved operator policy choices remain human decisions; repository docs are authoritative; wiki material is non-authoritative.
- Implementation cannot begin until independent plan approval is complete.

## 4. Exact Verification Commands
The implemented repository must support the following intended stable CLI invocations for verification:
```bash
node --test tests/implementation-plan-skills.test.mjs
node --test tests/implementation-plan-manifest-v2.test.mjs
node scripts/export-implementation-plan-manifest-v2-schema.mjs --check
npm test
git diff --check
```

Also define the intended stable CLI invocation for validation:
```bash
node scripts/validate-implementation-plan.mjs \
  --plan "docs/techPlans/AIDEV-182-implementation-plan.md" \
  --manifest "docs/techPlans/AIDEV-182-acceptance-manifest-v1.json" \
  --base "5c1e144b0ab8e36378050996a1c112a06d2b5a30" \
  --profile "profiles/pi-sampler.json" \
  --repository "Zkrausman/pi-sampler" \
  --ticket "AIDEV-182" \
  --ticket-revision "<trusted-exact-ticket-revision>" \
  --json
```
These arguments are strict validation inputs mapping to the contract expectations, not candidate-selected trust policies. Specifically:
- the caller obtains the exact ticket revision from the trusted ticket snapshot;
- the validator compares it to manifest v2;
- v1 compatibility does not silently invent a missing revision;
- the profile path is selected by trusted policy;
- profile bytes and repository binding are read from the exact immutable base, not candidate working-tree bytes;
- `--repository`, `--ticket`, and `--ticket-revision` are comparison inputs, not authority selectors;
- `--json` requests the deterministic bounded JSON result envelope.

## 5. Test Matrix & Acceptance Coverage
*   [ ] A182-T01: Canonical skill strictly requires manual handoff, deleting team wrapper, and matching docs.
*   [ ] A182-T02: Manual Antigravity handoff uses Gemini as the initial lead planner; Gemini receives the exact-base planning requirements and research and produces the uncommitted implementation plan and sibling manifest. Gemini must not be represented or invoked as a Pi provider/model; implementation, review, publication, and merge authority remain separate, with no automatic lifecycle authority.
*   [ ] A182-T03: Exact-base worktree provisioning is verified and bounded by delivery-worktree.mjs.
*   [ ] A182-T04: Validator ensures strict input, path, and security bounds, and performs no mutations.
*   [ ] A182-T05: Implement implementation-plan-manifest/v2 with exporter and generated schema in contracts/.
*   [ ] A182-T06: Exact runtime and generated-schema parity verification passes.
*   [ ] A182-T07: Preserve read/validation for existing v1 plans; no silent rewrites.
*   [ ] A182-T08: V2 manifest carries hard dependencies, predecessor outputs, and portfolio metadata.
*   [ ] A182-T09: Defines explicit drift triggers without claiming descendant-base campaign staleness.
*   [ ] A182-T10: Digest and acceptance IDs match exactly between plan and manifest over UTF-8 bytes.
*   [ ] A182-T11: AIDEV-132–AIDEV-140 audit corpus tests verify detections via independent classes.
*   [ ] A182-T12: Independent tests cover JSON faults, bounds, traversal, Git refs, base-drifts, and ID mismatches.
*   [ ] A182-T13: Classifies defects vs preferences, bounding revisions and adversarial paths.
*   [ ] A182-T14: Ensures AIDEV-182 emits valid v1 artifacts until v2 merges.
*   [ ] A182-T15: Tests rollback restoring previous skill versions without auto-publication.
*   [ ] A182-T16: Bounded two-stage protocol explicitly enforces Stage 1 vs Stage 2 boundaries and exact state progression.
*   [ ] A182-T17: Trusted model/policy selection correctly defines operator-owned choices and lifecycle authority boundaries.
*   [ ] A182-T18: Validator accurately enforces constraints against malformed inputs, missing objects, bounded resources, Windows/Linux handling, and stateless behavior.
*   [ ] A182-T19: Evaluates ownership constraints for evidence owner, fixture owner, acceptance owner, and repository-document authority.
*   [ ] A182-T20: Requires independent plan approval before implementation.
*   [ ] A182-T21: Validates implementation slices (1, 2, 3) merge according to explicit dependency boundaries.
*   [ ] A182-T22: Validates deterministic bounded observability (error codes and envelope outputs without prompt/credential leakage).
*   [ ] A182-T23: V2 manifest correctly parses bounded portfolio metadata and validates just-in-time staleness revalidation inputs.
