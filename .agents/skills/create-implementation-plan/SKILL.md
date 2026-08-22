---
name: create-implementation-plan
description: "AI agent skill defining the Definition of Done for all feature planning. Generates a strict implementation plan committed to docs/techPlans/."
---

# Skill: Create Implementation Plan

This document serves as the **Definition of Done** for all feature planning. It is a strict protocol that any AI agent must follow to generate and commit an implementation plan.

## 1. Required Inputs (The Context)

Before generating the implementation plan, the agent **must** ingest and analyze the following:
*   **Raw Issue Ticket**: The original request, containing the feature description, acceptance criteria, and constraints.
*   **Relevant File Boundaries**: Codebase context and function signatures pulled via **pith's high-fidelity parsers**.
*   **Architecture Exports**: Any provided `.excalidraw` JSON architecture exports that dictate structural design and component relationships.

## 2. Orchestration Rules (The Subagent Workflow)

To protect context limits and maximize reasoning, you **must** orchestrate the following subagents:

0. **Workspace Preparation:**
   * Run `npm run delivery:worktree -- prepare --purpose plan --profile <approved-profile> --work-item [TICKET-ID] --slug implementation-plan` before research or changes. The shared provisioner resolves the profile-declared base, creates a unique leased worktree under the configured worktree root's `plan/` subfolder, and returns its exact identity.
   * Change into the returned worktree path. Retain its branch, base SHA, lease ID, and lease token as the planning-run identity; never handcraft `git worktree add`, reuse `ai-workspaces/[TICKET-ID]`, or fall back to a ticket-named branch.
1. **The Researcher (`Model: flash`)**: 
   * Spawn a `research` subagent to ingest the raw issue ticket, extract `pith` file boundaries, and summarize the relevant `governance/` policies.
   * *Compute Effort: Medium (Fast, efficient lookup).*
2. **The Architect (Primary Agent)**:
   * Use your own context (as Lead Architect) to synthesize the Researcher's summary and draft the initial Implementation Plan.
3. **The Adversary (`Model: inherit`)**:
   * Spawn an `adversary` subagent to review the draft. Instruct it to aggressively critique the plan for logical flaws, missing test cases, and governance violations. You must resolve its critiques before finalizing the output.
   * *Compute Effort: High (Deep reasoning, matches your exact UI configuration).*

## 3. Execution Rules (The Guardrails)

The agent **must** strictly adhere to the following execution constraints:

*   **Constraint 1: You are the Lead Architect.** 
    *   Do **not** write the final implementation code. 
    *   Your role is strictly to design the architecture and define the execution steps.
*   **Constraint 2: Module Governance.**
    *   All proposed changes must strictly comply with the `governance/` Go module policies.
*   **Constraint 3: Explicit merge authority.**
    *   Planning and implementation may prepare evidence and a review handoff only. `do not merge` is sticky; wording such as `Ready to merge`, refresh/rebase, push, auto-merge, or admin merge never authorizes a merge. Only the exact user action `Merge PR #N` authorizes that individual merge.
*   **Constraint 4: Test Case Definition.**
    *   Define exact test cases required to validate the feature.
    *   Give every acceptance scenario a stable, ASCII, ticket-scoped ID such as `A123-T01`; IDs must not depend on Markdown table position and must not be reused or silently deleted.
    *   The plan must produce a sibling `docs/techPlans/[TICKET-ID]-acceptance-manifest-v1.json` (or an explicitly named local handoff artifact) whose rows bind those IDs to the plan digest and immutable base. The final acceptance matrix must map every row exactly once to `observed`, `waived`, or `blocked`.
    *   Mark benchmark, external-evidence, and durable-requirement rows with their own acceptance class; ordinary unit tests cannot satisfy them.
    *   Example: `go test -race <boundaries>` must be explicitly specified for the affected components.

## 4. The Output Template & Handoff (Tech Planning Standard)

As per the Global **Tech Planning Standard**, you must physically write the plan to the repository. **Do not just generate an out-of-band chat artifact.**

1. **Linear SDLC Sync**: Use the `linear` MCP tool's `save_issue` function to:
    *   Set the ticket's **Estimate** (T-Shirt size: XS, S, M, L, XL).
    *   Add the `AI-Planned` label.
    *   Transition the issue's **state** to `"In Review"`.
    *   Apply the `High-Risk` label if the Adversary flagged major architectural dependencies or state migrations.
    *   Apply the `Needs-Human` label if you hit an unresolvable roadblock or context limit.
2. Use the `write_to_file` tool to save the plan to: `docs/techPlans/[TICKET-ID]-implementation-plan.md`
3. Commit and push the file to a new branch, and open a PR. **CRITICAL:** You must sign-off your commits using the `-s` flag (e.g., `git commit -s -m "..."`) or the repository's DCO check will fail.
4. **Adversarial Review Evidence and Version Selection:** For a branch matching a ticket pattern (for example, `zkrausman/aidev-*`), resolve the supplied base only as the exact immutable commit (`base^{commit}`) before selecting the evidence flow.
   * **Post-activation:** When the exact trusted base contains the v3 activation declaration, generate the complete v3 packet, acceptance matrix, and verification evidence. Validate one current clean local receipt, revalidate any rendered marker against that receipt with `validateFinalReviewAttestation`, and publish only the minimal v3 marker. The pre-push hook invokes that authoritative path against `artifacts/final-review/receipt.json`; a revoked receipt invalidates an older marker even when base and head are unchanged.
   * **Bootstrap:** When v3 is absent from the exact trusted base, preserve that base's legacy behavior. If it requires v2 evidence, generate the frozen v2 packet and exactly one v2 packet-consistency marker for the exact base/head; missing, malformed, stale, or unbound v2 evidence fails. V2 is historical bootstrap evidence only and must never satisfy the post-activation v3 gate. Do not publish a v3 marker during bootstrap.
   * The generated plan must identify the selected trusted-base flow, complete v3 inputs, receipt revalidation, revocation handling, and the exact test cases for both bootstrap and post-activation states. Do not use a v2-only attestation example as the default planning guidance.

The content of the file **must** use the rigid, copy-pasteable Markdown template below. Do not deviate from these headers.

```markdown
# Implementation Plan: [TICKET-ID]

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** [XS / S / M / L / XL]
*   **Estimated Effort:** [e.g., 2-4 hours, 1-2 days]
*   **Primary Risk:** [What is the most likely thing to go wrong during execution?]

## Expected File Changes
*List all files that will be modified, created, or deleted.*
*   `[NEW]` `path/to/new/file.go`: *Purpose of the new file.*
*   `[MODIFY]` `path/to/existing/file.go`: *Brief description of the change.*
*   `[DELETE]` `path/to/deprecated/file.go`: *Reason for deletion.*

## Review Evidence Flow
*State how the exact trusted base selects bootstrap legacy v2 versus post-activation v3 evidence, how complete packet/matrix/verification inputs are frozen, how the current receipt is revalidated before publication, and how revocation invalidates a same-head marker. Preserve v2 only as trusted-base bootstrap compatibility; v3 is the default after activation.*

## Step-by-Step Execution
*Provide a granular, sequential list of actions required to implement the feature.*
1.  **Phase 1: [Phase Name]**
    *   Step 1.1: ...
    *   Step 1.2: ...
2.  **Phase 2: [Phase Name]**
    *   Step 2.1: ...

## Test Matrix
*Define the exact test commands and scenarios needed to validate this feature.*
*   **Target Command**: `go test -race ./path/to/package/...`
*   **Validation Scenarios**:
    *   [ ] Scenario A (Success case)
    *   [ ] Scenario B (Edge case handling)
    *   [ ] Every stable acceptance ID is covered exactly once by the final acceptance matrix or an explicit external waiver/blocker.
```
