---
name: project-delivery
description: Plan, implement, verify, and hand off a repository change using an explicit project profile.
---

# Project delivery

Use a project profile for repository source, work-item identifiers, automatic worktree provisioning, verification commands, evidence paths, required checks, and publication policy. Never infer those values from a package default or a ticket-named Git branch.

## Preconditions

1. Read the target repository's contributor instructions and approved profile.
2. Require a specific work item or user-approved scope. **CRITICAL:** Check the profile's specification path for a pre-approved implementation plan matching the work item (for example, `docs/techPlans/[TICKET-ID]-implementation-plan.md`). If one exists, follow it as the exact architectural boundary and execution checklist.
3. Establish the delivery worktree before source inspection or mutation:
   - If the user or orchestration harness supplied an existing dedicated worktree, verify its canonical path, branch, base `HEAD`, lease or exclusivity attestation, and clean `git status --porcelain=v1`.
   - Otherwise run `npm run delivery:worktree -- prepare --purpose implement --profile <approved-profile> --work-item <WORK-ITEM>`. The helper fetches the profile-declared base branch, resolves an immutable base commit, verifies that the selected base contains the approved profile and implementation plan, generates a unique branch and leased worktree under the configured worktree root's `implement/` subfolder, and acquires a worktree-scoped writer lease.
   - For a coordinated experiment, pass the coordinator's immutable commit with `--base <SHA>` (or `PI_DELIVERY_BASE_SHA`) so every run receives the same base.
   - Treat the helper's JSON output—worktree path, branch, base SHA, profile, plan, lease ID, and lease token—as the run identity. Never handcraft `git worktree add`, infer a base from a ticket branch, or reuse a similarly named worktree.
4. Use one concurrent writer per worktree, not one writer per repository. Separate leased worktrees may safely host different tickets or model runs in parallel. The control checkout is not the delivery target; perform every read, edit, command, and verification against the returned delivery worktree.
5. The delivery worktree must initially be clean. Pre-existing tracked, staged, or untracked changes are an ownership conflict. If changes must be preserved, stop, capture an explicit patch outside the run, provision another clean worktree, complete these preconditions, and apply the patch as that run's first owned mutation.

## Ownership guard

- Keep the recorded repository root, delivery worktree path, branch, expected `HEAD`, lease ID, and lease token as the run identity. Never commit the lease token.
- Before every source mutation and before final verification, re-check that identity and inspect status. Track the paths changed by this run. If the branch, `HEAD`, worktree, lease, or an unowned path changes unexpectedly, stop immediately and report a concurrent-writer conflict; do not switch back, copy mixed files, or continue.
- After an explicitly authorized commit, update the expected `HEAD` to that exact commit. Otherwise the base `HEAD` must remain unchanged.
- Independent reviewers use a distinct managed review clone and opaque run identity. Bind review and verification to an exact commit (the base/head pair) when one exists; otherwise provide an explicit patch or snapshot and label it uncommitted. Do not hand a reviewer a linked implementation worktree or configure reviewer Git author identity.

## Delivery

1. Inspect the clean base, integration points, and existing tests before editing.
2. Implement only the approved scope and keep an inventory of owned paths.
3. Run only the profile's declared verification commands. Record exit status, failure markers, correction, and rerun result. After verification completes and immediately before reporting, re-check repository root, worktree path, branch, expected `HEAD`, lease, status, and the owned-path inventory. Any unexpected post-verification change blocks delivery.
4. Keep credentials, lease tokens, raw tool output, sessions, source packets, and unrelated local files out of Git.
5. Do not commit, publish, merge, or change a tracker status unless the user explicitly authorizes it.
6. Report the artifact truthfully:
   - Say **implemented on branch** only when the branch contains the reviewed implementation commit.
   - For authorized commits, report the exact commit and verify a clean worktree.
   - Without commit authorization, say **prepared as uncommitted changes** and report the worktree path, base `HEAD`, and complete owned-path inventory. Do not imply that the branch ref contains the changes.
7. Hand off the exact implementation base SHA and candidate head SHA to the independent reviewer; the reviewer provisions its own managed review workspace and must not mutate this implementation checkout. Retain the leased implementation worktree while unmerged work is awaiting review. On explicit cancellation, or after confirming the delivery commit is merged into the configured base, run `npm run delivery:worktree -- cleanup --worktree <PATH> --lease <TOKEN> --delete-branch`. Cleanup fails closed for dirty worktrees, invalid leases, changed identities, and unmerged commits.

The generic mechanism is fail-closed: unavailable profiles, provisioning failures, dirty or shared delivery worktrees, missing leases, ownership conflicts, unexpected identity changes, verification failures, missing evidence, or unavailable independent review are blockers rather than permission to invent a replacement or continue in mixed state.
