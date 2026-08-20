---
name: project-delivery
description: Plan, implement, verify, and hand off a repository change using an explicit project profile.
---

# Project delivery

Use a project profile for repository source, work-item identifier format, verification commands, evidence paths, required checks, and publication policy. Never infer those values from a package default.

1. Read the target repository's contributor instructions and the approved profile.
2. Require a specific work item or user-approved scope. **CRITICAL:** You MUST check `docs/techPlans/` for a pre-approved implementation plan matching the work item (e.g., `docs/techPlans/[TICKET-ID]-implementation-plan.md`). If it exists, you MUST strictly follow it as your exact architectural boundary and execution checklist.
3. Inspect the clean base, integration points, and existing tests before editing.
4. Use one writer per worktree. Independent reviewers use a separate clean worktree and identity.
5. Run only the profile's declared verification commands. Record exit status, failure markers, correction, and rerun result.
6. Keep credentials, raw tool output, sessions, and source packets out of Git.
7. Do not commit, publish, merge, or change a tracker status unless the user explicitly authorizes it.

The generic mechanism is fail-closed: unavailable profiles, verification, evidence, or independent review are blockers rather than permission to invent a replacement.
