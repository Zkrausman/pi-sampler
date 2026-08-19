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
   * Run `squire prep [TICKET-ID]` to fetch the latest `main` branch and create an isolated git worktree.
   * Command: `cd ../ai-workspaces/[TICKET-ID]` to move into the isolated workspace before doing any research or code changes.
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
*   **Constraint 3: Test Case Definition.** 
    *   Define exact test cases required to validate the feature.
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
4. **Adversarial Review Evidence:** Any branch matching a ticket pattern (e.g. `zkrausman/aidev-*`) strictly requires a JSON attestation marker in the PR body. You **must** generate it and append it to the PR body using the repository's generator utility (e.g. `node scripts/generate-review-packet.mjs` or a custom script wrapping its output). For example, write and run this temporary script:
   ```javascript
   import { generateReviewPacket, reviewPacketSha256 } from "./scripts/generate-review-packet.mjs";
   import { execSync } from "child_process";
   async function main() {
     const head = execSync("git rev-parse HEAD").toString().trim();
     const base = execSync("git merge-base origin/main HEAD").toString().trim();
     const packet = await generateReviewPacket({ base, head });
     const sha = reviewPacketSha256(packet);
     console.log(`<!-- pi-sampler-adversarial-review-attestation:v2 {"base":"${packet.base}","format":"pi-sampler.adversarial-review-attestation","head":"${packet.head}","outcome":"clean","packetSha256":"${sha}","version":2} -->`);
   }
   main();
   ```
   Append the output to your PR body using the `gh` CLI or similar.

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
```
