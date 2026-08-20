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
*   Run `npm run delivery:worktree -- prepare --purpose plan --profile <approved-profile> --work-item [TICKET-ID] --slug implementation-plan` to generate a unique leased worktree under the configured worktree root's `plan/` subfolder from the profile-declared base.
*   Change into the returned worktree and retain its branch, base SHA, lease ID, and lease token as the planning-run identity. Never handcraft `git worktree add`, reuse `ai-workspaces/[TICKET-ID]`, or fall back to a ticket-named branch.

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
*   **Linear SDLC Sync**: Use the `linear` MCP tool's `save_issue` function to:
    *   Set the ticket's **Estimate** (T-Shirt size: XS, S, M, L, XL) matching the complexity finalized by the Architect. If the size exceeds XL, halt execution and request the issue be broken down.
    *   Add the `AI-Planned` label (and `High-Risk` if identified).
    *   Transition the issue's **state** to `"In Review"`.
*   Finally, **you must open a Pull Request** using the `gh pr create` command and hand it off to the user.

---

*Note for Platform Engines (Antigravity, Pi, Codex): Because this skill relies purely on the `invoke_subagent` primitive and Markdown text, it natively executes on any platform running the underlying agentic engine.*
