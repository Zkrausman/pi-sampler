---
name: project-delivery
description: Plan, implement, verify, and hand off a repository change using an explicit project profile.
---

# Project delivery

Use a project profile for repository source, work-item identifiers, automatic worktree provisioning, verification commands, evidence paths, required checks, and publication policy. Never infer those values from a package default or a ticket-named Git branch.

## Mandatory Herdr delegation topology

When an Orchestrator is running inside Herdr, the only supported parent-level delivery delegation is the tab-owned workflow in [`docs/HERDR-DELEGATION.md`](../../../docs/HERDR-DELEGATION.md). This is a hard topology and authority boundary, not a set of interchangeable options:

- the coordinating session remains the Orchestrator tab and is not a Dev or Review final-result lane;
- every mutation-owning final result runs in a separate Dev tab using `openai-codex/gpt-5.6-luna` with `--thinking max`;
- every independent review final result runs in a separate Review tab using `openai-codex/gpt-5.6-sol` with `--thinking medium`;
- each tab returns exactly one explicit durable final handoff to the Orchestrator;
- Dev and Review tabs may use subagents internally, but their children are only aids and cannot become parent-level results;
- the Orchestrator must not replace these tabs with parent-launched headless subagents, `workflowScript` children, Herdr project panes opened through `project.open`, or split-pane delivery lanes.

The model ID and thinking level are exact; do not silently substitute a model,
effort level, same-tab pane, or fallback. Keep the Review tab idle until the
Orchestrator freezes and supplies its complete input. That complete input is the
complete frozen review input, including the exact repository, immutable
base/head, complete packet, acceptance matrix, verification evidence, profile,
and required review identity. Any change to a bound input invalidates the
result and requires a new complete freeze; do not use delta-only review. The
Review tab uses a distinct managed review workspace
with its own lease and never shares the Dev tab's writable worktree. If Herdr
or a required separate tab is unavailable, stop and ask the human rather than
silently changing topology.

The Dev tab owns mutations in its managed leased worktree. The Orchestrator
may coordinate, validate identities, freeze inputs, route handoffs, and perform
separately authorized lifecycle actions, but it must not mutate the candidate
in a shared or unleased checkout. A Dev or Review handoff is evidence only:
`do not merge` remains sticky until the exact user action `Merge PR #N`, and no
review, marker, or tool result grants commit, push, PR, tracker, publication,
or merge authority.

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
- Terra retains early and remediation review continuity, then launches exactly one fresh-context final child only after provisional clean. Freeze the exact repository/PR/base/head, complete v3 packet, acceptance matrix, verification evidence, reviewer model claim, and review-profile version before launch. Every resume must rebind all complete inputs to the new exact head; delta-only review is prohibited.
- A clean final-review receipt is current only when its canonical digest and packet/matrix/evidence digests match the frozen inputs, its one child lineage is fresh, and it has at most two resumes. Any blocker/high finding, later authenticated Terra blocker, head change, child failure, malformed receipt, or third correction immediately invalidates the clean state, even when HEAD is unchanged. A replacement child requires explicit user authorization and a new lineage.

## Delivery

1. Inspect the clean base, integration points, and existing tests before editing.
2. Implement only the approved scope and keep an inventory of owned paths. Every approved-plan acceptance ID must appear exactly once in the final sibling acceptance matrix as `observed`, `waived`, or `blocked`; a unit-test result cannot stand in for a benchmark, external-evidence, or requirement row.
3. Run only the profile's declared verification commands and the declared acceptance-class verifiers. Record exit status, failure markers, correction, and rerun result. Bind the final matrix to the exact plan digest, manifest digest, immutable base, candidate head, repository, and PR identity. After verification completes and immediately before reporting, re-check repository root, worktree path, branch, expected `HEAD`, lease, status, and the owned-path inventory. Any unexpected post-verification change blocks delivery.
4. Keep credentials, lease tokens, raw tool output, sessions, source packets, acceptance waivers, replay state, and unrelated local files out of Git.
5. Merge authority is explicit and sticky: `do not merge` remains in force until the user says exactly `Merge PR #N`. `Ready to merge`, `Refresh PR #N`, `Push PR #N`, rebase, enable auto-merge, admin-merge, or any tool result never overrides that prohibition. Refresh/rebase, push, PR-body mutation, auto-merge, and merge are separate authorities; repository scripts have none. Do not commit, publish, merge, or change a tracker status unless the user explicitly authorizes it; each individual action still requires its own authority. A passing v3 final-review marker is review evidence only and never merge authority.
6. Report the artifact truthfully. A blocked or missing acceptance row is a delivery blocker, not a report-only success:
   - Do not call a baseline a pass when no approved threshold exists.
   - Do not treat the smaller CI regression or unit tests as evidence for the local 10M class.
   - Do not treat a candidate-authored or unsigned waiver as an override.
   - Do not claim merge readiness while the sticky `do not merge` instruction is active.

7. Report the artifact truthfully:
   - Say **implemented on branch** only when the branch contains the reviewed implementation commit.
   - For authorized commits, report the exact commit and verify a clean worktree.
   - Without commit authorization, say **prepared as uncommitted changes** and report the worktree path, base `HEAD`, and complete owned-path inventory. Do not imply that the branch ref contains the changes.
8. Hand off the exact implementation base SHA and candidate head SHA to the independent reviewer; the reviewer provisions its own managed review workspace and must not mutate this implementation checkout. Retain the leased implementation worktree while unmerged work is awaiting review. On explicit cancellation, or after confirming the delivery commit is merged into the configured base, run `npm run delivery:worktree -- cleanup --worktree <PATH> --lease <TOKEN> --delete-branch`. Cleanup fails closed for dirty worktrees, invalid leases, changed identities, and unmerged commits.

The generic mechanism is fail-closed: unavailable profiles, provisioning failures, dirty or shared delivery worktrees, missing leases, ownership conflicts, unexpected identity changes, verification failures, missing evidence, or unavailable independent review are blockers rather than permission to invent a replacement or continue in mixed state.
