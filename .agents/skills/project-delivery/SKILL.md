---
name: project-delivery
description: Plan, implement, verify, and hand off a repository change using an explicit project profile.
---

# Project delivery

Use a project profile for repository source, work-item identifier format, verification commands, evidence paths, required checks, and publication policy. Never infer those values from a package default.

## Preconditions

1. Read the target repository's contributor instructions and approved profile.
2. Require a specific work item or user-approved scope. **CRITICAL:** Check `docs/techPlans/` for a pre-approved implementation plan matching the work item (for example, `docs/techPlans/[TICKET-ID]-implementation-plan.md`). If one exists, follow it as the exact architectural boundary and execution checklist.
3. Before editing, record the canonical repository root, worktree path, current branch, base `HEAD`, and `git status --porcelain=v1`. The initial worktree must be clean. Pre-existing tracked, staged, or untracked changes are an ownership conflict: stop and require a separate clean worktree. If those changes must be preserved, capture them as an explicit patch outside the delivery run. Start a new run in a clean, dedicated worktree, complete these preconditions, and then apply the patch as that run's first owned mutation.
4. Use one concurrent writer per worktree, not one writer per repository. Separate clean worktrees may safely host different ticket branches in parallel. Before editing, acquire a worktree-scoped writer lease from the orchestration harness. If the harness has no lease mechanism, require an explicit orchestration attestation that no other active writer uses the exact canonical worktree path and reserve that path for this run. If neither exclusivity mechanism is available, stop. Never use a repository-wide lock that prevents independent worktrees from progressing.
5. If the requested branch is not already checked out in this run's clean, dedicated worktree, create or request a separate worktree for it. Do not use `git switch` or `git checkout` to repurpose a shared or active worktree.

## Ownership guard

- Keep the recorded repository root, worktree path, branch, and expected `HEAD` as the run identity.
- Before every source mutation and before final verification, re-check that identity and inspect status. Track the paths changed by this run. If the branch, `HEAD`, worktree, or an unowned path changes unexpectedly, stop immediately and report a concurrent-writer conflict; do not switch back, copy the mixed files, or continue.
- After an explicitly authorized commit, update the expected `HEAD` to that exact commit. Otherwise the base `HEAD` must remain unchanged.
- Independent reviewers use a distinct clean worktree and identity. Bind review and verification to an exact commit when one exists; otherwise provide an explicit patch or snapshot and label it uncommitted.

## Delivery

1. Inspect the clean base, integration points, and existing tests before editing.
2. Implement only the approved scope and keep an inventory of owned paths.
3. Run only the profile's declared verification commands. Record exit status, failure markers, correction, and rerun result. After verification completes and immediately before reporting, re-check repository root, worktree path, branch, expected `HEAD`, status, and the owned-path inventory. Any unexpected post-verification change is a concurrent-writer conflict and blocks delivery.
4. Keep credentials, raw tool output, sessions, source packets, and unrelated local files out of Git.
5. Do not commit, publish, merge, or change a tracker status unless the user explicitly authorizes it.
6. Report the artifact truthfully:
   - Say **implemented on branch** only when the branch contains the reviewed implementation commit.
   - For authorized commits, report the exact commit and verify a clean worktree.
   - Without commit authorization, say **prepared as uncommitted changes** and report the worktree path, base `HEAD`, and complete owned-path inventory. Do not imply that the branch ref contains the changes.

The generic mechanism is fail-closed: unavailable profiles, dirty or shared worktrees, ownership conflicts, unexpected identity changes, verification failures, missing evidence, or unavailable independent review are blockers rather than permission to invent a replacement or continue in mixed state.
