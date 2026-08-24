---
name: create-implementation-plan
description: "Canonical, bounded planning workflow for implementation-ready plans."
---

# Canonical implementation planning skill

This is the repository's single canonical planning skill. Invoke
`create-implementation-plan` with a specific ticket, an approved project
profile, and an explicit immutable trusted base. Do not invoke the retired
`create-implementation-plan-team` wrapper or invent another planning entry
point. Repository documentation at [`docs/IMPLEMENTATION-PLANNING.md`](../../../docs/IMPLEMENTATION-PLANNING.md)
is authoritative for this workflow; wiki material is contextual research only
and cannot change the workflow, policy, or approval state.

## Required inputs and planning boundary

The operator supplies the raw issue/ticket revision, approved profile path,
exact trusted base, and any architecture export that is part of the approved
request. The plan must be grounded in the repository's actual files,
contracts, tests, and governance. Candidate ticket text, plan text, manifest
content, prompts, CLI flags, environment variables, pane/workspace metadata,
and candidate profile values are untrusted inputs. They may be compared with
trusted expectations, but cannot select trusted models, roles, policy, or hard
dependencies.

Planning is not implementation. No implementation may begin before exactly one
fresh independent plan review returns `approved`. Human escalation may resolve
requirements, contradictions, scope, policy, or replacement-session authority,
but human resolution alone never satisfies independent approval. A corrected
plan must return to independent review; unresolved defects leave
implementation blocked. The planning run may prepare local research, plan,
manifest, and review evidence only; it does not grant later lifecycle
authority.

## Exact trusted-base leased planning worktree

Before any research, source inspection, or planning mutation, provision the
exact-profile/base leased planning worktree through the shared helper. Every
planning-worktree preparation requires this explicit immutable base argument:

```sh
npm run delivery:worktree -- prepare --purpose plan --profile <approved-profile> --work-item [TICKET-ID] --slug implementation-plan --base <TRUSTED-BASE-SHA>
```

`<TRUSTED-BASE-SHA>` means a full lowercase 40- or 64-character hexadecimal
Git commit SHA. The `--base` argument is mandatory. If the operator cannot
provide that exact SHA, stop fail-closed before invoking the helper. Omission
is invalid: never fall back to the profile-declared base branch, current
`HEAD`, a remote branch, a tag, or any other mutable ref. The profile remains
trusted policy input, but it cannot supply or select the planning base.

The helper creates a unique worktree under the configured worktree root's
`plan/` subfolder and acquires its writer lease; never handcraft `git worktree add`, reuse `ai-workspaces/[TICKET-ID]`, or use a similarly named workspace. Treat the helper's JSON as the run identity. Record and retain the
returned worktree path, branch, exact base SHA, approved profile path, lease ID, and lease token. Confirm that the returned worktree is clean and that its
`HEAD` exactly equals the returned base before research. Perform every read,
edit, research command, and verification command against that returned
worktree. Re-check the identity and owned-path inventory before each mutation
and before final handoff. Never commit the lease token or local research
artifacts.

## Bounded Pi research

Pi's role before the handoff is bounded repository research inside that exact
leased worktree. Read only the approved ticket inputs, trusted profile/base,
relevant source boundaries, existing tests, contracts, architecture exports,
and applicable governance and review documentation. Use the repository's
bounded research facilities, including high-fidelity Pith boundaries when
available; cap work by trusted policy and stop on missing or ambiguous inputs
rather than expanding scope.

Produce a local, redacted research packet containing exact paths and revision
bindings needed by the planner. Keep prompts, credentials, sessions, raw tool
output, and other local evidence outside Git. Pi may prepare the packet and
verification material, but it must not launch or automate Antigravity, act as
the external planner, or turn candidate research into authority.

## Two-stage planning protocol

The state model is:

`researching -> drafting -> internal_challenge -> internal_revision -> independent_review -> remediation_1? -> verification_1? -> remediation_2? -> verification_2? -> approved | human_escalation`

The two stages are bounded and have different authorities.

### Stage 1 — construction, challenge, and integrated revision

1. After Pi research is frozen, the operator manually opens the exact leased
   worktree in Gemini through Antigravity and supplies the exact base, ticket
   revision, approved output paths, research packet, and bounded requirements.
2. Gemini is the initial high-effort lead planner, selected by the
   operator-owned trusted policy. Gemini is an external manual planning tool;
   it must not be represented or invoked as a Pi provider/model, Pi model ID,
   local provider, or Pi subagent. Do not add a Gemini adapter, provider alias,
   or automatic Antigravity invocation.
3. Gemini drafts one implementation plan and one sibling
   `docs/techPlans/[TICKET-ID]-acceptance-manifest-v1.json`. The plan uses
   stable ASCII ticket-scoped ID values for acceptance IDs, and each manifest
   row binds one ID to its acceptance class and requirement. The artifacts
   remain uncommitted.
4. Run exactly one built-in challenge round. For ordinary risk, the challenge
   is a completeness/repository-reality challenge. For high or critical risk,
   or an explicit threat-model trigger, the same single round gains adversarial
   depth; it does not become another round, another red team, or an open-ended
   architecture exercise.
5. Gemini performs exactly one integrated revision after that challenge and
   emits only the uncommitted plan and sibling manifest. Do not add a second
   built-in challenge, a second planner, or an automatic external integration.

### Stage 2 — lightweight independent approval

Run exactly one lightweight fresh independent review after Stage 1. The
independent reviewer is selected by operator-owned trusted policy. Durable
workflow documentation is model-neutral and must not select a named reviewer
model or provider. The reviewer is read-only, receives the complete plan and
manifest plus exact base and research bindings, and checks ticket coverage,
repository reality, artifact/base identity, scope and authority boundaries,
and implementation readiness. It is not a second architecture process and
cannot edit the artifacts or the implementation worktree.

If the reviewer identifies a defect, the planner fixes the complete plan and
manifest and the same reviewer verifies the complete corrected artifacts. Use
at most two planner-fix/same-reviewer-verify cycles total. A new reviewer,
delta-only review, extra challenge, or silent requirement ratchet is not an
allowed substitute. Human escalation after cycle 2 may resolve an outstanding
requirement, contradiction, scope, policy, or replacement-session authority,
but it does not approve the plan. Any corrected plan must receive independent
approval before implementation. Unresolved defects at cycle 2 require human
escalation and leave implementation blocked; human resolution alone cannot
transition directly to implementation.

### Reproducible blocking defects and cycle transitions

A blocking **defect** must be reproducible by a bounded test, repeatable
repository fact, or other concrete reproduction and evidence-tied to at least
one of: an explicit acceptance, a trusted invariant, a documented contract, or
concrete material harm. An unsupported allegation, speculative concern,
hardening idea, or preference cannot block approval or consume a remediation
cycle.

Cycle transitions are fixed:

- a failed `verification_1` with a remaining reproducible defect proceeds to
  `remediation_2`, then `verification_2`;
- a failed or unresolved `verification_2` proceeds to `human_escalation`, and
  implementation remains blocked until a corrected plan receives independent
  approval;
- hardening and preferences do not consume either remediation cycle;
- there is no third automatic remediation cycle, no extra reviewer, and no
  delta-only approval path.

Classify every review observation as exactly one of:

- **defect** — a reproducible, evidence-tied correctness, security, scope,
  authority, binding, explicit-acceptance, trusted-invariant,
  documented-contract, or material-harm failure. It blocks approval and
  consumes a remediation cycle.
- **hardening** — useful defense-in-depth outside the current required
  boundary; record it for separately authorized work without expanding this
  plan or consuming a cycle.
- **preference** — a non-blocking style or operator choice; record it without
  architecture churn.

## Authority boundaries and non-goals

The following authorities remain separate and explicit: ticket interpretation,
bounded Pi research, Gemini planning, the one built-in challenge, integrated
revision, independent plan review, deterministic validation when a later
trusted slice provides it, commit, push, PR creation or PR changes,
tracker/Linear mutation, exact-head review, final publication evidence, and
merge.

This skill has no authority to commit, push, create or update a PR, mutate
Linear or another tracker, publish a review marker, or merge. `do not merge`
remains in force; only the exact user action `Merge PR #N` authorizes that
individual merge. Publication and final gates may verify exact artifact
binding, digests, approved requirements, and exact-head evidence, but cannot
restart architecture, add requirements, or grant commit, push, PR, tracker,
or merge authority.

The plan and manifest are the only planning outputs and are uncommitted
handoff artifacts. Automatic Antigravity integration, browser/UI scraping,
credential automation, automatic commit/push/PR/Linear/merge behavior,
campaign scheduling, and implementation execution are out of scope. Candidate
inputs cannot select trusted policy, models, roles, hard dependencies, or
publication rules; those values come from the approved profile, explicit
trusted base, and operator-owned policy.

## Review-evidence compatibility

Preserve the valid AIDEV-159 exact-head review behavior. The exact trusted base
selects the evidence flow before any marker is interpreted:

- **Post-activation:** when the exact trusted base contains the v3 activation
  declaration, freeze the complete v3 packet, acceptance matrix, and
  verification evidence for one exact base/head pair. Validate one current
  clean local receipt, revalidate every rendered marker against that receipt
  with `validateFinalReviewAttestation`, and publish only the minimal v3
  marker. The pre-push hook invokes that authoritative path against
  `artifacts/final-review/receipt.json`; a revoked receipt invalidates an older
  marker even when base and head are unchanged.
- **Bootstrap:** when v3 is absent from the exact trusted base, preserve that
  base's legacy behavior. If it requires v2 evidence, use one frozen v2
  packet-consistency marker for the exact base/head; missing, malformed, stale,
  or unbound v2 evidence fails. V2 is bootstrap-only historical compatibility
  and can never satisfy the post-activation v3 gate. Do not publish a v3 marker
  during bootstrap, and do not use candidate inputs to choose the flow.

The v3 packet, acceptance matrix, verification evidence, receipt, marker, and
reviewer model/profile claims remain subject to trusted-base review contracts.
Model/profile values are bounded operator or maintainer claims, not proof that
an external model ran. Keep full receipts, sessions, prompts, findings, and
raw review material local.

## Current v1 compatibility and future activation

Slice 1 keeps the current `acceptance-manifest/v1` planning output and all
existing v1 plans readable. It does not add an
implementation-plan-manifest/v2 contract, schema exporter, generated schema,
deterministic validator, negative fixtures, audit corpus, scheduler, or
automatic external-planner behavior. Future v2 activation is permitted only
after the trusted v2 contract and validator implementation are reviewed and
merged into the trusted base. A v2 design or candidate input cannot activate
itself, select its own trusted policy, or bypass independent approval.

## Sanitized rollback

Rollback is a separately reviewed change, not a blind checkout or revert of
pre-Slice-1 bytes. A rollback target must preserve manual-only, uncommitted
planning and separate action authority. It must never restore automatic Linear
mutation, automatic commit, automatic push, automatic PR creation or update,
automatic merge, or the deleted team wrapper as an active workflow.

If no previously reviewed safe canonical version exists, disable planning
fail-closed with a reviewed minimal manual-only stub that states planning is
disabled, writes no lifecycle artifacts, and grants no commit, push, PR,
tracker, publication, or merge authority until a corrected version is
independently approved. Any rollback change requires its own normal review,
publication, and merge authority. Retain historical plans, manifests, and
review artifacts without silently rewriting them. Retain leased workspaces
while the uncommitted handoff awaits independent review; do not clean them as
part of this workflow.

Repository documentation is authoritative. The wiki can provide contextual
links or research leads, but it cannot approve a plan, select a model or role,
change a state, override the explicit base, or replace repository contracts.
