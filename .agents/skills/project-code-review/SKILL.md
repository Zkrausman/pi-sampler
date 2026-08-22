---
name: project-code-review
description: Independently review a project change in an isolated worktree using its explicit project profile.
---

# Project code review

Review from a clean, managed review workspace and a distinct reviewer run. The
consumer profile supplies the base branch, verification commands, required
checks, prohibited paths, and domain policy.

## Review workspace preconditions

- Resolve the exact candidate commit and approved project profile before
  reviewing. Provision the review clone through
  `node scripts/review-workspace.mjs prepare --profile <approved-profile> --base <EXACT-APPROVED-BASE-SHA> --head <EXACT-CANDIDATE-SHA>`. The base commit is the immutable source of approved profile bytes; the candidate profile must match it exactly.
- The provisioner creates a disposable clone under the profile's review root.
  It uses no linked worktree, `--no-hardlinks`, no alternates/reference/shared
  clone mode, a detached exact head, a clone-local disabled hook directory,
  and no publication remote. Do not handcraft `git clone` or `git worktree`
  setup and do not reuse a similarly named workspace.
- Keep the emitted workspace path and lease token as the review identity.
  Inspect with the managed `inspect --base <EXACT-APPROVED-BASE-SHA>` command before and after review. A dirty
  workspace, changed head/config, local branch, remote, hook, lock, symlink,
  case alias, nested repository, unexpected ignored/untracked file, or uncertain
  provenance is preserved rather than deleted.
- Never configure `user.name` or `user.email` for a reviewer. A reviewer run
  identity is opaque metadata, not a Git author. Do not mutate the candidate,
  create commits, push, merge, change tracker status, or write publication
  credentials. If a tool truly needs a Git-writing operation, use a command-
  local identity only in a separately authorized disposable experiment; it is
  not part of candidate review.

## Terra final-review continuity

Terra is the persistent review parent. Terra keeps the early review and
remediation findings, but may launch exactly one fresh-context final child only
after the complete candidate is provisionally clean. The child receives the
exact immutable base/head, complete v3 packet, acceptance matrix, verification
evidence, and versioned read-only review profile; it does not receive a mutable
checkout or any publication capability. It reports only blocker/high findings.

A blocker/high result immediately invalidates the current clean receipt,
including when HEAD is unchanged. Luna must fix and push, then Terra freezes a
new complete packet, matrix, and evidence set and resumes the same child. A
resume is a full-candidate review, never a delta review, and no more than two
resumes are allowed. A child loss, timeout, provider failure, malformed local
receipt, changed base/head, or third correction blocks the gate. A replacement
child requires explicit user authorization and starts a new receipt lineage.
The local receipt binds every pass to exact repository/PR/base/head and all
three input digests. Only its minimal v3 marker may be published; sessions,
runs, findings, prompts, paths, usage, cost, and raw evidence remain local.

## Review and cleanup

- Inspect the complete diff and the declared scope.
- Reject self-review, dirty review workspaces, missing profile requirements,
  unverified claims, leaked credentials, and undeclared behavior changes.
- Run the profile's commands without replacing failures with assumed
  equivalents. Keep review packets, findings, prompts, sessions, and raw tool
  output local.
- Report evidence-backed findings with severity, location, correction, and
  verification requirement.
- Never mutate the candidate branch, merge, or update work-item status.
- Before preparing a review workspace, run the fixed `review-policy.mjs verify`
  preflight from the approved merged base, passing the exact trusted base commit
  and mandatory candidate commit. The executable, `profiles/pi-sampler.json`
  policy bytes, and `profiles/project-profile.schema.json` bytes are all read
  from that immutable base; never load a candidate-selected loader, profile path,
  or default.
- Treat candidate `delivery.review` values, including workspace and quarantine
  roots, as untrusted data. A `ready` result requires candidate policy equivalence
  and must be the only source of review limits for a later workspace consumer.
- A missing trusted policy is the explicit fail-closed `bootstrap_required`
  result. It is a blocking outcome, not a generic configuration warning or
  permission to fall back to candidate values.
- Land the bootstrap change first and record its exact merge SHA. Only then may
  AIDEV-157 be rebased and reviewed: the later controller must run this
  base-bound preflight with that exact base SHA and a mandatory candidate SHA
  before creating any review workspace.
- Quarantine only through
  `node scripts/review-workspace.mjs quarantine --base <EXACT-APPROVED-BASE-SHA> --workspace <PATH> --lease <TOKEN>`
  after the managed inspection is safe. Quarantine is a retention boundary,
  not deletion authorization.
- Delete only through a later, explicitly authorized
  `node scripts/review-workspace.mjs clean --base <EXACT-APPROVED-BASE-SHA> --quarantine <PATH> --lease <TOKEN> --confirm`
  operation after retention. Never force-remove an uncertain, changed, dirty,
  locked, or unleased resource.
