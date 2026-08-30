# Herdr delivery delegation

This is the normative repository policy for planned delivery work performed
inside Herdr. It defines one supported parent-level topology; it is not a
menu of equivalent orchestration options. The coordinating session is the
**Orchestrator** tab, and the [project-delivery skill](../.agents/skills/project-delivery/SKILL.md)
and [project-code-review skill](../.agents/skills/project-code-review/SKILL.md)
apply the same boundary.

## Required topology

The parent-level topology is exactly the following:

1. Keep the coordinating session in its existing **Orchestrator** tab. It
   coordinates, freezes inputs, routes handoffs, and records results; it does
   not become a Dev or Review final-result lane.
2. Create a separate **Dev** tab for each mutation-owning result. Start Pi
   with exactly:

   ```text
   pi --model openai-codex/gpt-5.6-luna --thinking max
   ```

   The Dev tab owns the delivery mutation and its one final handoff.
3. Create a separate **Review** tab for each independent review result. Start
   Pi with exactly:

   ```text
   pi --model openai-codex/gpt-5.6-sol --thinking medium
   ```

   The Review tab owns the independent review and its one final handoff.
4. Each Dev or Review tab returns exactly one durable final result to the
   Orchestrator. Intermediate output, a nested child result, a pane status, or
   a marker is not a parent-level final result.
5. Dev and Review tabs may use internal subagents under their own supervision.
   Those children are implementation or review aids only; their output must
   be synthesized by the owning tab and cannot replace that tab's final
   handoff.

The model ID and thinking level above are exact requirements for the role.
There is no fallback model, effort level, same-tab equivalent, or alternate
parent-level lane. A separate tab means a separate Herdr tab, not another pane
or split inside the Orchestrator tab.

## Frozen-input and sequencing gates

- The Orchestrator supplies the Dev tab the approved scope and exact delivery
  identity. The Dev tab works only in its managed leased worktree and reports
  the exact base/head and owned paths.
- Keep the Review tab idle until the Orchestrator supplies the complete frozen
  review input. That input includes the exact repository, immutable base and
  candidate head, complete review packet, acceptance matrix, verification
  evidence, approved profile, and any required review/PR identity.
- Freeze the whole input set before review. If the candidate head, packet,
  matrix, verification evidence, profile, or any other bound input changes,
  invalidate the pending result and create a new complete freeze. A delta-only
  review is not valid.
- A blocker or high finding, changed binding, child failure, malformed receipt,
  or other failed final-review condition invalidates a clean result. Do not
  reuse an earlier approval or handoff after the inputs change.
- The Review tab must produce its own evidence-backed result from the frozen
  input and must not inspect or review the Dev tab's mutable checkout.

## Workspaces and ownership

- Provision the Dev checkout with the repository's managed delivery-worktree
  helper. Keep its lease, exact branch, immutable base, and ownership identity
  local; use one concurrent writer per leased worktree.
- Provision the Review checkout with the managed review-workspace flow for the
  exact candidate. It is a distinct managed review workspace/clone with its
  own opaque lease, not a linked worktree and never the Dev tab's writable
  worktree. Inspect it before and after review and retain it while review is
  pending.
- The Orchestrator may perform bounded read-only coordination, identity
  validation, input freezing, handoff routing, and separately authorized
  lifecycle actions. It must not copy mixed files, bypass a lease, or turn a
  shared checkout into a delivery or review workspace.
- Keep lease tokens, sessions, prompts, raw tool output, receipts, and review
  material outside Git and out of the durable handoffs unless a contract
  explicitly requires a redacted digest or status.

## Unsupported parent-level delegation

For repository delivery, the Orchestrator must not substitute any of these for
the separate Dev and Review tabs:

- orchestrator-launched headless `subagent` or `workflowScript` children;
- Herdr project panes opened through `project.open`;
- ordinary split panes or split-pane final lanes;
- the Orchestrator tab doing the mutation or review itself;
- a reviewer running in the writable Dev worktree or a Dev result reviewed by
  that same workspace;
- an internal child result treated as the tab's final result without the
  owning tab's explicit durable handoff.

If Herdr or the required separate tab cannot be established, stop and ask the
human. Do not silently fall back to a headless child, project pane, split pane,
same-tab operation, or different model/effort setting.

## Authority boundaries

A Dev or Review handoff is evidence and coordination output, not permission
to perform another lifecycle action. Commit, push, PR creation or mutation,
tracker/Linear mutation, publication, cleanup, and merge remain separate
explicit authorities. The sticky **`do not merge`** instruction remains in
force until the user says exactly **`Merge PR #N`**; “ready to merge,” a passing
review, a marker, a tool result, or a tab handoff never overrides it.

## Creating and identifying tabs

Use Herdr tab APIs, parse and retain the returned tab/pane IDs, and make focus
changes explicit:

```text
herdr tab create --workspace <workspace> --cwd <cwd> --label <label> --no-focus
herdr pane run <pane> "pi --model openai-codex/gpt-5.6-luna --thinking max"
herdr pane run <pane> "pi --model openai-codex/gpt-5.6-sol --thinking medium"
```

Preferred ASCII labels are:

```text
AIDEV-N - Dev - gpt-5.6-luna
AIDEV-N - Review - gpt-5.6-sol
```

Wait for the terminal to show the expected model, thinking level, and `Ready`
state before submitting work. If Herdr agent recognition is available, use
`herdr agent prompt`; otherwise enter the prompt explicitly only after
verifying the terminal and returned IDs. Never guess a pane or tab ID.

## Required final handoffs

The Dev handoff is one durable result identifying the exact worktree, branch,
base/head, changed paths, validation, unresolved decisions, and commit/PR
state. It must say whether the result is uncommitted and must not imply that a
branch contains changes that were not committed.

The Review handoff is one durable result identifying the complete frozen input
digests and exact base/head, distinct review workspace and lease state,
findings or approval, validation, and residual risks. It must not claim merge
authority. The Orchestrator remains the sole coordinator and must never infer
approval, publication, or merge authority from either handoff.
