# Implementation planning

This document is the repository authority for implementation planning. The
canonical entry point is `.agents/skills/create-implementation-plan/SKILL.md`.
Repository files, the approved project profile, and the explicit trusted Git
commit control the workflow. The LLM Wiki may provide contextual links or
research leads, but it is not authoritative and cannot approve a plan, select
a policy, or override a repository contract.

## Canonical skill invocation

Invoke the `create-implementation-plan` skill with a concrete ticket, the
approved profile path, and an explicit immutable trusted base. The canonical
skill is the only planning entry point:

```text
create-implementation-plan <TICKET-ID> --profile <approved-profile> --base <TRUSTED-BASE-SHA>
```

Before any research or source inspection, the operator or planning harness
must provision the leased planning worktree with the shared delivery helper.
Every planning-worktree preparation requires this explicit immutable base:

```sh
npm run delivery:worktree -- prepare --purpose plan --profile <approved-profile> --work-item [TICKET-ID] --slug implementation-plan --base <TRUSTED-BASE-SHA>
```

`<TRUSTED-BASE-SHA>` is a full lowercase 40- or 64-character hexadecimal Git
commit SHA. The `--base` argument is mandatory for every preparation. If the
exact SHA is unavailable, stop fail-closed before invoking the helper. Omission
or a mutable identity is invalid: never fall back to the profile-declared base
branch, current `HEAD`, a remote branch, a tag, or another mutable ref. The
profile remains trusted policy input, but it cannot supply or select the
planning base.

The helper returns the worktree path, branch, exact base SHA, profile, lease ID,
and lease token and places the worktree under the configured `plan/` namespace.
Confirm a clean worktree and exact `HEAD` before research; perform every read,
edit, command, and verification against that returned worktree. Never
handcraft `git worktree add`, reuse `ai-workspaces/[TICKET-ID]`, or commit a
lease token.

The planning outputs are deliberately limited to an uncommitted
`docs/techPlans/[TICKET-ID]-implementation-plan.md` and one deterministic
sibling manifest. Before trusted-base activation, historical handoffs use
`docs/techPlans/[TICKET-ID]-acceptance-manifest-v1.json`; after Slice 3 is
reviewed and merged, new manual outputs use
`docs/techPlans/[TICKET-ID]-acceptance-manifest-v2.json` with
`schema_version: implementation-plan-manifest/v2`. Research packets and
review material stay local and redacted.

## Migration from the team wrapper

The former `.agents/skills/create-implementation-plan-team/SKILL.md` is retired
and deleted. It is not a compatibility alias and must not be invoked. Existing operators should replace the team-wrapper invocation with the canonical `create-implementation-plan` skill, then follow the same explicit-base provisioning and manual handoff below. No repository automation, provider
registration, or wrapper alias restores the retired entry point.

This migration consolidates authority and preserves historical v1 behavior.
Slice 3 adds the reviewed v2 contract and deterministic validator, but only the
exact trusted base can activate the new default. The current v1 planning output
remains compatible with existing plans and manifests and is never rewritten.

## Manual Antigravity workflow

Pi performs bounded research first, inside the exact leased planning worktree.
The research may cover the ticket revision, trusted profile and explicit base,
relevant file boundaries, contracts, tests, architecture exports, and
governance. The research packet contains bounded repository facts and exact
revision/path bindings; prompts, credentials, sessions, raw tool output, and
other sensitive material stay outside Git.

After Pi freezes that packet, the operator manually opens the exact returned
worktree in Gemini through Antigravity. The operator supplies Gemini the exact
base, ticket revision, approved output paths, bounded requirements, and
research packet. There is no automatic Antigravity launch, browser or UI
scraping, credential automation, or live planner adapter.

Gemini is the initial high-effort lead planner selected by operator-owned
trusted policy. Gemini is an external manual planning tool; it must not be represented or
invoked as a Pi provider/model, Pi model ID, local provider, or Pi subagent.
Candidate plan text, ticket text, prompts, CLI flags,
environment variables, pane metadata, workspace metadata, or candidate
profiles cannot select trusted models, roles, policy, or hard dependencies.
Candidate content may propose dependencies, but only trusted policy and an
operator can accept a dependency as hard.

Gemini writes one implementation plan and one versioned sibling manifest, both
uncommitted. Before trusted-base activation the historical sibling is v1; after
activation new manual planning uses
`docs/techPlans/[TICKET-ID]-acceptance-manifest-v2.json` with
`schema_version: implementation-plan-manifest/v2`. The plan uses stable ASCII
ticket-scoped ID values for acceptance IDs, and the manifest maps every ID to
its requirement and acceptance class. Gemini does not commit, push, create or change a PR, update a tracker, publish review artifacts, or merge.

## Two-stage state model

The bounded state model is:

`researching -> drafting -> internal_challenge -> internal_revision -> independent_review -> remediation_1? -> verification_1? -> remediation_2? -> verification_2? -> approved | human_escalation`

### Stage 1: construction

Stage 1 is one manual Gemini planning session after bounded Pi research:

1. Gemini drafts the plan and sibling manifest from the exact-base research
   packet.
2. Run **exactly one built-in challenge**. For ordinary risk, it is a
   completeness and repository-reality challenge. For high or critical risk,
   or an explicit threat-model trigger, the same single round gains adversarial
   depth. It is not a second challenge, another red-team round, or open-ended
   architecture discovery.
3. Gemini performs **exactly one integrated revision** and emits the complete,
   uncommitted plan and manifest.

### Stage 2: independent approval

Run **one lightweight fresh independent review**. The independent reviewer is
selected by operator-owned trusted policy. Durable workflow documentation is
model-neutral and cannot select a named reviewer model or provider. The
reviewer is read-only and checks exact base/artifact binding, ticket
requirements, repository reality, authority and scope, acceptance coverage,
and implementation readiness. It is not a second architecture process and
cannot edit the plan or implementation worktree.

A finding classified as a defect may start a planner-fix/same-reviewer-verify
cycle. There are **at most two** such cycles, and each verification receives the
complete corrected plan and manifest, never only a delta. Human escalation may
resolve requirements, contradictions, scope, policy, or replacement-session
authority, but human resolution alone cannot approve a plan or begin
implementation. Implementation cannot begin before the independent reviewer
returns `approved`. Unresolved defects at cycle 2 require human escalation and
leave implementation blocked; human resolution alone cannot transition directly
to implementation.

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

Classify review observations as follows:

- **defect**: reproducible and evidence-tied to an explicit acceptance, trusted
  invariant, documented contract, or concrete material harm; blocks approval
  and consumes a cycle;
- **hardening**: useful defense-in-depth outside the current required boundary;
  record for separately authorized work without expanding this plan or
  consuming a cycle;
- **preference**: non-blocking style or operator choice; record without
  architecture churn.

## Authority boundaries and non-goals

Planning authority is separate from each later authority: bounded research,
Gemini planning, the built-in challenge, integrated revision, independent plan
review, deterministic validation, commit, push, PR creation or PR changes,
tracker/Linear mutation, exact-head review, final publication evidence, and
merge are distinct operations. The planning skill grants none of the later
operations. This planning documentation has no authority to commit, push, create
or update a PR, mutate Linear or another tracker, publish a review marker, or
merge. `do not merge` is sticky; only the exact user action `Merge PR #N`
authorizes that individual merge.

Publication and final gates may verify the exact base/head, plan and manifest
digests, acceptance bindings, and review evidence. They cannot restart
architecture, add requirements, promote a preference to a blocker, or grant
lifecycle authority. Automatic commit/push/PR/Linear/merge behavior is out of scope; automatic commit, push, PR, tracker, review publication, merge, campaign scheduling, and Antigravity integration are non-goals for this slice.

The repository is the authority for documentation and contracts. The wiki is
contextual only. Candidate inputs are never a source of trusted policy, model,
role, hard dependency, publication rule, or approval state.

## Trusted-base v2 activation and validation

After Slice 3 is reviewed and merged, the default manual output is
`docs/techPlans/[TICKET-ID]-implementation-plan.md` plus the deterministic
sibling `docs/techPlans/[TICKET-ID]-acceptance-manifest-v2.json` using
`schema_version: implementation-plan-manifest/v2`. Activation is selected only
when the exact trusted base contains both the reviewed
`contracts/implementation-plan-manifest-v2.mjs` contract and
`scripts/validate-implementation-plan.mjs` validator. Candidate bytes,
working-tree files, CLI flags, environment variables, or manifest fields
cannot activate or replace that rule.

Run the validator before the one fresh independent review, using exact
comparison bindings and the trusted ticket revision:

```sh
node scripts/validate-implementation-plan.mjs \
  --plan docs/techPlans/[TICKET-ID]-implementation-plan.md \
  --manifest docs/techPlans/[TICKET-ID]-acceptance-manifest-v2.json \
  --base <TRUSTED-BASE-SHA> \
  --profile <approved-profile> \
  --repository <owner/repository> \
  --ticket [TICKET-ID] \
  --ticket-revision <TRUSTED-TICKET-REVISION> \
  --json
```

Validation success is necessary bounded evidence and never plan approval. A
failed validator result returns to the manual planner only for a reproducible
defect, within the existing two planner-fix/same-reviewer-verify cycles. The
independent reviewer and its bounded remediation protocol remain unchanged.

Historical `acceptance-manifest/v1` artifacts, including AIDEV-182, remain
readable and are never silently upgraded or rewritten. Rollback preserves
manual-only uncommitted planning and separate action authorities; it does not
silently downgrade or upgrade artifacts and never restores automatic commit,
push, PR, tracker, publication, review, or merge behavior.

## AIDEV-159 exact-head publication evidence

Preserve the current trusted review evidence behavior. The exact trusted base
selects the evidence flow before any marker is interpreted:

- **Post-activation v3:** when the exact trusted base contains the v3 activation
declaration, freeze a complete v3 packet, acceptance matrix, and verification
evidence for one exact base/head pair. Validate one current clean local receipt,
revalidate the rendered marker against that receipt with
`validateFinalReviewAttestation`, and publish only the minimal v3 marker. The
pre-push hook invokes that authoritative path against
`artifacts/final-review/receipt.json`; a revoked receipt invalidates an older
marker even when base and head are unchanged. The marker is evidence only, not
merge authority.
- **Bootstrap-only v2:** when v3 is absent from the exact trusted base, preserve
that base's legacy behavior. If the base requires v2, use one frozen v2
packet-consistency marker for the exact base/head. Missing, malformed, stale,
or unbound v2 evidence fails. V2 is historical bootstrap compatibility only and
never satisfies the post-activation v3 gate. Do not publish a v3 marker during
bootstrap, and do not let candidate inputs select the flow.

Full receipts, sessions, prompts, findings, and raw review material remain
local. Model and profile fields are bounded operator/maintainer claims, not
cryptographic proof of model execution. Exact-head evidence must be regenerated
and revalidated whenever the candidate head or any bound input changes.

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
review artifacts without silently rewriting them. Retain leased planning and
review workspaces while the uncommitted handoff awaits independent review; do
not clean or delete them as part of this slice.

## Windows and Linux operator guidance

On Windows PowerShell, quote the approved profile, explicit SHA, and returned
path; use the JSON returned by `delivery:worktree` rather than constructing a
relative `..\ai-workspaces\[TICKET-ID]` path:

```powershell
npm run delivery:worktree -- prepare --purpose plan --profile profiles/pi-sampler.json --work-item AIDEV-182 --slug implementation-plan --base <TRUSTED-BASE-SHA>
Set-Location '<returned worktree path>'
git status --porcelain=v1
```

On Linux or other POSIX shells, use the same helper and quote paths with spaces:

```sh
npm run delivery:worktree -- prepare --purpose plan --profile profiles/pi-sampler.json --work-item AIDEV-182 --slug implementation-plan --base <TRUSTED-BASE-SHA>
cd '<returned worktree path>'
git status --porcelain=v1
```

Both platforms must verify the returned branch, lease, explicit base SHA, exact
`HEAD`, and clean status before research, must keep all work in the returned
worktree, and must retain the lease/workspace for independent review. A
platform difference is not permission to bypass the explicit-base or approval
gates.
