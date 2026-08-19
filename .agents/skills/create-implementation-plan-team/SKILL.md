---
name: create-implementation-plan-team
description: "Orchestrates an autonomous 3-agent brain trust (Researcher, Architect, Red-Teamer) to generate a deeply reasoned, adversarially audited tech plan."
---

# Skill: Team Implementation Plan

This skill turns you into a pure Orchestrator. Your role is not to write the plan yourself, but to coordinate a dedicated 3-agent team using your native `invoke_subagent` capabilities.

This multi-agent architecture guarantees strict adherence to the Pi-Sampler Definition of Done, minimizes context poisoning, and ensures every plan passes rigorous adversarial critique before being shown to the user.

## The Workflow

When invoked with a target issue (e.g. `AIDEV-148`), you must strictly follow this orchestration sequence:

### 1. Workspace Preparation (You)
*   Run `squire prep [TICKET-ID]` to generate a clean, isolated worktree.
*   Change into that directory (`cd ../ai-workspaces/[TICKET-ID]`).

### 2. Spawn The Researcher (Model: `flash`)
*   **Action**: Use `invoke_subagent` to spawn the officially registered `codebase-researcher` subagent.
*   **Prompt**: *"Read the ticket details for [TICKET-ID] and map the affected boundaries."*

### 3. Spawn The Lead Architect (Model: `pro`)
*   **Action**: Once the Researcher returns their map, spawn the officially registered `lead-architect` subagent.
*   **Prompt**: *"Using the Researcher's map and ticket requirements, draft the initial Implementation Plan for [TICKET-ID]."*

### 4. Spawn The Red-Teamer (Model: `pro`)
*   **Action**: Take the Architect's draft and pass it to the officially registered `adversarial-red-teamer` subagent.
*   **Prompt**: *"Critique this proposed Implementation Plan for [TICKET-ID] and return a list of required fixes."*

### 5. Final Revision & Commit (You)
*   Pass the Red-Teamer's critiques back to the Architect for a final revision.
*   Once the plan is bulletproof, you (the Orchestrator) use `write_to_file` to save it to `docs/techPlans/[TICKET-ID]-implementation-plan.md`.
*   Generate the required cryptographic JSON attestation (e.g. via the `generate-review-packet.mjs` script) and append it to the PR body.
*   Set the appropriate Linear ticket labels (`AI-Planned` or `High-Risk`) and commit the branch with the `-s` (DCO) flag.

---

*Note for Platform Engines (Antigravity, Pi, Codex): Because this skill relies purely on the `invoke_subagent` primitive and Markdown text, it natively executes on any platform running the underlying agentic engine.*
