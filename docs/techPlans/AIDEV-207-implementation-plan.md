# AIDEV-207 implementation plan — serial trusted planner bootstrap

## 0. Remediation binding, authority, and frozen identity

This is remediation cycle 1 of the complete AIDEV-207 plan/manifest pair. It
replaces the rejected one-slice delivery with the exact serial
`AIDEV-208 -> AIDEV-209 -> AIDEV-210` execution graph and a separately
authorized plan-publication gate. The pair is still an uncommitted planning
handoff. This plan grants no implementation, staging, commit, push, PR or
Linear mutation, publication, activation, merge, or cleanup authority. `do not
merge` remains sticky; only the exact user action `Merge PR #N` can authorize
an individual merge.

| Fact | Frozen value |
|---|---|
| Work item | `AIDEV-207` |
| Repository/profile | `Zkrausman/pi-sampler`; `profiles/pi-sampler.json` |
| Planning branch | `zkrausman/aidev-207-plan-implementation-plan-4bbb3f` |
| Original trusted base and current `HEAD` | `b57cb97b8f110c5f40bcefee3476a6013a6c7cd0` |
| Remediated parent ticket revision | `7495f11df9288325c211328128d19e21b44c0e9bb91b1c3b9d6ed219ecb58ea1` |
| Previous parent ticket revision | `18831c945a18f61fd4b9f0497c439965b4130207e0511958c68830e559d0d5c7` |
| Parent revision change | Child creation and the Orchestrator's serial-decomposition comment changed Linear metadata; the scope/acceptance text remains bound and is re-frozen below. |
| Child snapshot evidence | `.git/pi-handoffs/AIDEV-207/planning/pi-bootstrap/remediation-1/ticket-snapshots/` (external, local only) |
| Base profile SHA-256 | `96e4b00bc78b16b5e544ee48f369137c74a2ef040c7b226b5c88d542d2e6a6c9` |
| Base profile-schema SHA-256 | `7c83a3d308d5b7e193a7333316c55cdbfbbc9b3e181b6fadd4f67fba63fae954` |
| Current review-policy SHA-256 | `12d32a4b589dc1d1b05089409cc65e4fffcd7867b5eee438b140688a01cc7b4f` |

The remediated parent revision is the SHA-256 of the exact selected current
Linear AIDEV-207 issue, including the current comments, plus the selected
GitHub `Zkrausman/pith#74` mirror, serialized as
`JSON.stringify({ticket:<selected Linear issue>,githubMirror:<selected GitHub issue mirror>}) + LF`.
The old and new basis, selected objects, child snapshots, and derivation are
external evidence. No credential or lease token is copied into this plan,
the manifest, or repository history.

### One-time Pi-authored bootstrap exception

The operator explicitly authorized this Pi-authored planning bootstrap because
the old exact-base planning text required a named external planner while the
ticket requires that subscription to become optional. This exception permits
bounded research, remediation drafting, one integrated revision, and local
handoff preparation only. Pi does not impersonate Gemini, claim external-model
execution, select or contact the independent reviewer, approve the pair,
publish it, or receive commit/push/PR/tracker/publication/activation/merge
authority. The durable implementation uses policy-selected backends and does
not encode this session exception as a provider identity.

## 1. Outcome, plan-publication gate, and non-goals

The delivery outcome is the trusted, versioned, model-neutral
`delivery.rolePolicy` bootstrap. The eventual resolver selects an admitted Pi
planner by default; an operator launches the selected backend manually. An
optional `external-manual` Gemini/Antigravity assignment is configuration and
fallback/override only, never a required subscription, Pi provider/model, or
automatic launch.

The complete corrected delivery has two distinct gates before AIDEV-208:

1. **Planning approval.** The same Sol/medium independent reviewer who issued
   `independent-review-v1` must verify the complete corrected plan and manifest
   after this remediation. That approval is read-only plan approval and does
   not authorize publication or coding. No second challenge or reviewer is
   permitted.
2. **Separate plan publication.** The Orchestrator may prepare a publication
   candidate containing exactly the two approved planning files:
   `docs/techPlans/AIDEV-207-implementation-plan.md` and
   `docs/techPlans/AIDEV-207-acceptance-manifest-v2.json`. It must revalidate
   AIDEV-207's parent/revision and the child graph, pass exact allowlist and
   protected CI checks, DCO, and exact-head review, then obtain explicit user
   `Merge PR #N` authority. The resulting immutable merge commit is captured as
   `AIDEV207_PLAN_SHA` under the output contract
   `pi-sampler.aidev-207-plan-publication/v1`, together with the raw plan and
   manifest digests, original trusted base, ticket revision, and two-file
   allowlist. No implementation path may be included in that publication.

`AIDEV-208` must start from the exact merged publication commit
`AIDEV207_PLAN_SHA`; it must also preserve the original trusted base
`b57cb97b8f110c5f40bcefee3476a6013a6c7cd0` in every child packet and output.
`AIDEV207_PLAN_SHA` is a future JIT commit value and is not fabricated in this
pair. Planning approval is not publication authority, and publication/merge is
not implementation approval.

This bootstrap does not add packet-v4, receipt-v2, marker-v4, context
admission, provider dispatch, successor interfaces, acceptance activation,
new lifecycle automation, or unrelated review/policy changes. AIDEV-187 owns
the broader role-policy/successor rollout and must reconcile this subset rather
than duplicate it. AIDEV-190 owns trusted context admission and replay/recovery
interfaces. AIDEV-202 activation remains unchanged and must regenerate its own
plan and independent approval only after AIDEV-210 is merged.

## 2. Exact-base repository facts and preserved boundaries

At the original trusted base, `profiles/project-profile.schema.json` and
`profiles/pi-sampler.json` have strict additional-property boundaries, and the
profile has no `delivery.rolePolicy`. `scripts/review-policy.mjs` is the
separate exact-base `delivery.review` loader and remains byte-and-result
frozen; the new role-policy contract does not import, replace, or extend it.
The implementation-plan-manifest/v2 contract and deterministic validator are
present at the original base and remain the validator for this pair.

The canonical planning skill and `docs/IMPLEMENTATION-PLANNING.md` currently
name Gemini as the initial planner. Their existing test assertions must be
updated only in AIDEV-210 with the model-neutral policy-selected workflow.
The planning-agent definitions do not pin runtime models. Packet-v3,
receipt-v1, marker-v3, DCO, hooks, workflows, `project-delivery`,
`project-code-review`, and AIDEV-202 activation paths are not modified by the
three child scopes.

The exact compatibility authority is
`tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md`
(44,524 bytes, SHA-256
`e88bafec7997fa247e56451dc72fd49007e9ac1128679d9ee21a6cc061848744`). Its
role-policy format/version, catalogs, profile admission, bounds, canonical
serialization, digest prefix, resolution precedence, and exact envelopes are
reused. Its packet-v4/context-admission/successor sections are not imported.

## 3. AIDEV-187-compatible role-policy contract

### 3.1 Grammar, catalogs, and configured policy

AIDEV-208 adds an **optional** `delivery.rolePolicy` property to the general
profile schema, preserving existing profiles that omit it. The property has
`additionalProperties:false`, required root keys `format`, `version`,
`assignments`, and `roles`, and constants
`pi-sampler.delivery-role-policy` / `1`.

Assignments are 1–32 unique IDs matching
`[a-z0-9][a-z0-9-]{0,63}`, each with one to four unique roles from
`planner|implementer|primary-reviewer|final-reviewer`. A Pi assignment has
exactly `id`, `roles`, `backend`, `provider`, `model`, `thinking`, and
`profile`. An external manual planner has exactly `id`, `roles`, `backend`,
`mode`, `label`, and `effort`, with no Pi provider/model/thinking/profile
fields. Role objects are exactly `planner`, `implementer`, `primaryReviewer`,
and `finalReviewer`; each has exactly `selected`, `fallbacks`, and
`allowedOverrides`.

The semantic contract enforces the compatible catalog and admission rules:

- Pi provider is `openai-codex`; models are exactly
  `gpt-5.6-luna|gpt-5.6-sol|gpt-5.6-terra`; thinking is exactly
  `medium|high|xhigh`.
- `implementation-planner-v1` admits only `planner`;
  `project-delivery-v1` only `implementer`; `project-code-review-v1` only
  `primary-reviewer`; `final-review-v2` only `final-reviewer`.
- The manual compatibility assignment is exactly
  `backend:"external-manual"`, `mode:"manual-antigravity"`,
  `label:"Gemini"`, `effort:"high"`, and role `planner`.
- Selected/fallback/override references exist and role-match. Fallbacks are
  ordered, unique, no more than eight, and exclude selected. Overrides are
  unique, no more than eight, and include selected.
- Policy canonical bytes are at most 64 KiB, JSON depth at most 8, nodes at
  most 512, and each UTF-8 string at most 2048 bytes.

AIDEV-210 configures this logical policy in `profiles/pi-sampler.json`:

```json
{
  "format": "pi-sampler.delivery-role-policy",
  "version": 1,
  "assignments": [
    {"id":"pi-luna-planner","roles":["planner"],"backend":"pi","provider":"openai-codex","model":"gpt-5.6-luna","thinking":"xhigh","profile":"implementation-planner-v1"},
    {"id":"manual-gemini-planner","roles":["planner"],"backend":"external-manual","mode":"manual-antigravity","label":"Gemini","effort":"high"},
    {"id":"pi-terra-planner","roles":["planner"],"backend":"pi","provider":"openai-codex","model":"gpt-5.6-terra","thinking":"high","profile":"implementation-planner-v1"},
    {"id":"pi-sol-planner","roles":["planner"],"backend":"pi","provider":"openai-codex","model":"gpt-5.6-sol","thinking":"high","profile":"implementation-planner-v1"},
    {"id":"pi-luna-implementer","roles":["implementer"],"backend":"pi","provider":"openai-codex","model":"gpt-5.6-luna","thinking":"high","profile":"project-delivery-v1"},
    {"id":"pi-sol-implementer","roles":["implementer"],"backend":"pi","provider":"openai-codex","model":"gpt-5.6-sol","thinking":"high","profile":"project-delivery-v1"},
    {"id":"pi-sol-primary-reviewer","roles":["primary-reviewer"],"backend":"pi","provider":"openai-codex","model":"gpt-5.6-sol","thinking":"high","profile":"project-code-review-v1"},
    {"id":"pi-sol-final-reviewer","roles":["final-reviewer"],"backend":"pi","provider":"openai-codex","model":"gpt-5.6-sol","thinking":"high","profile":"final-review-v2"}
  ],
  "roles": {
    "planner": {"selected":"pi-luna-planner","fallbacks":["pi-terra-planner","pi-sol-planner","manual-gemini-planner"],"allowedOverrides":["pi-luna-planner","pi-terra-planner","pi-sol-planner","manual-gemini-planner"]},
    "implementer": {"selected":"pi-luna-implementer","fallbacks":["pi-sol-implementer"],"allowedOverrides":["pi-luna-implementer","pi-sol-implementer"]},
    "primaryReviewer": {"selected":"pi-sol-primary-reviewer","fallbacks":[],"allowedOverrides":["pi-sol-primary-reviewer"]},
    "finalReviewer": {"selected":"pi-sol-final-reviewer","fallbacks":[],"allowedOverrides":["pi-sol-final-reviewer"]}
  }
}
```

The planner order is Pi Luna, Pi Terra, Pi Sol, then optional manual Gemini.
A normal resolution with Gemini unavailable selects `pi-luna-planner`. A
manual result is an operator handoff only. Implementer retains Luna with Sol
fallback; primary and final reviewers retain Pi Sol with no fallback.

The current operator planning envelope is `openai-codex/gpt-5.6-luna` with
reasoning `max`. The compatible AIDEV-187 catalog admits only
`medium|high|xhigh`, so the persisted assignment uses Luna/`xhigh`; `max`
remains session-only metadata. A `max` policy value fails with
`role_thinking_not_catalogued` unless a refreshed authority explicitly admits
it before implementation, in which case the pair must be refreshed and
re-approved.

For this logical policy, normalized sorted-key JSON is 1,989 UTF-8 bytes and
the domain-separated digest is
`6a5580c2d7548cf1e54ad381bd18a8486b898530780b51b115a6d4bbe84772ed`.
It is SHA-256 of
`UTF8("pi-sampler.delivery-role-policy/v1\\0") || canonicalBytes`.

### 3.2 Runtime contract and exact-base loading

AIDEV-209 adds `contracts/delivery-role-policy-v1.mjs` with exactly these
public exports:

- `DeliveryRolePolicyV1`
- `normalizeDeliveryRolePolicyV1`
- `serializeDeliveryRolePolicyV1`
- `deliveryRolePolicySha256V1`
- `loadTrustedDeliveryRolePolicy`
- `resolveDeliveryRoleAssignment`

Normalization recursively sorts object keys, sorts assignment IDs and
set-valued `roles`/`allowedOverrides`, and preserves fallback order.
Serialization is compact UTF-8 JSON with no BOM or trailing newline. The digest
uses the domain separator above and lowercase SHA-256.

`loadTrustedDeliveryRolePolicy({repo,baseSha})` accepts exactly `repo` and
`baseSha`. The exact public envelopes are success
`{"ok":true,"policy":<normalized-policy>,"rolePolicySha256":"<64-hex>"}`
with an internal non-enumerable trusted brand, or failure
`{"ok":false,"code":"<stable-code>"}` with no path, provider, model, raw
Git error, or input echo. Stable loader codes are
`role_policy_input_invalid`, `role_policy_base_invalid`,
`role_policy_unspecified`, `role_policy_invalid`,
`role_provider_not_catalogued`, `role_model_not_catalogued`,
`role_thinking_not_catalogued`, `role_profile_not_catalogued`, and
`role_policy_internal_blocked`.

The loader must require a full lowercase 40- or 64-character commit SHA and
reject refs, `HEAD`, profile/loader paths, callbacks, candidate selectors,
provider values, and extra keys. It resolves only an approved real Git root
whose trusted profile identifies project `pi-sampler` and repository
`Zkrausman/pi-sampler`; it rejects shallow/alternate/replaced object databases,
path traversal, symlink/reparse roots, command failure, and output overflow.
It reads only `baseSha:profiles/project-profile.schema.json` and
`baseSha:profiles/pi-sampler.json` as verified regular `100644` Git blobs.
Before either blob is captured it checks `cat-file -s` and rejects sizes over
`131072` bytes, then streams with a hard cap and verifies blob type, object ID,
size, raw hash, UTF-8, duplicate keys, and trailing-data rejection. Policy
content additionally obeys the 64 KiB/depth/node/string bounds. Worktree,
candidate commit, ambient `HEAD`, and caller-selected profile/schema/loader
paths are never read.

The optional policy property is absent only in the pre-AIDEV-207 base and
returns `role_policy_unspecified`. A malformed trusted schema/profile/policy,
invalid grammar, bounds, reference, or canonical bytes returns
`role_policy_invalid`; catalog failures return their specific codes. The
loader is read-only and candidate-independent.

`resolveDeliveryRoleAssignment({trustedPolicy,role,operatorOverrideId,availability})`
accepts exactly those four keys and never launches a backend. It requires the
trusted-loader brand, validates policy before role selection, validates the
role enum (`role_invalid`), checks a non-null override against the allowlist
before availability (`role_override_not_allowed`), constructs
`[selected,...fallbacks]` or `[override,...fallbacks excluding override]`
without implicit selected insertion, and requires availability keys to be
exactly the considered set with values `available|unavailable`. It chooses the
first available assignment or returns `role_unavailable`. A success envelope
has exactly `ok`, `role`, `assignment`, `source`, `fallbackIndex`, and
`rolePolicySha256`; selected/override indexes are `null`, and fallback indexes
are zero-based indexes in the original fallback array. Resolver failures have
exactly `ok:false` and a stable code, without value echoing.

## 4. Exact serial child graph and responsibilities

The following graph is frozen from the current read-only Linear snapshots.
The child ticket revisions are local snapshot hashes
`sha256(JSON.stringify(<selected child issue>) + LF)` and are not invented
commit SHAs. A child starts only after its listed predecessor output and
immutable merge SHA are revalidated.

| Child | Current ticket snapshot | Parent | Blocks | Blocked by | Exact scope | Required named output |
|---|---|---|---|---|---|---|
| `AIDEV-208` | `a831c4ca220d57da6a232177e30f19fc7482a2b6bfb2ad9da8458992bbc39b9e` | `AIDEV-207` | `AIDEV-209` | none | `profiles/project-profile.schema.json`; `tests/project-profiles.test.mjs` | `ROLE_POLICY_SCHEMA_SHA` |
| `AIDEV-209` | `a6dfea9aa1570dbd176c6e1b5343e95a9257f4266a1cd38b21a382cd2bd1ac55` | `AIDEV-207` | `AIDEV-210` | `AIDEV-208` | `contracts/delivery-role-policy-v1.mjs`; `tests/delivery-role-policy.test.mjs`; `tests/fixtures/role-policy/aidev-207-bootstrap-vectors.json` | `ROLE_POLICY_RUNTIME_SHA` |
| `AIDEV-210` | `da3974aa92adc06851c63c59844b9a5386b501ad2c3f0d5be0fbd8d870776a68` | `AIDEV-207` | `AIDEV-202` | `AIDEV-209` | `profiles/pi-sampler.json`; `.agents/skills/create-implementation-plan/SKILL.md`; `docs/IMPLEMENTATION-PLANNING.md`; `tests/implementation-plan-skills.test.mjs` | `PLANNER_POLICY_SHA` |

The parent relations are `AIDEV-207` parent `AIDEV-168`, `AIDEV-207` blocks
`AIDEV-202`, and `AIDEV-202` remains parent `AIDEV-191`. Current AIDEV-202
also reports blocked-by `AIDEV-210`, `AIDEV-207`, and AIDEV-201; this plan does
not remove or reinterpret those edges. AIDEV-187/AIDEV-190 are related
authority boundaries, not hidden hard dependencies.

The v2 manifest cannot encode the required underscore spelling in its portable
identifier grammar. Its `predecessor_outputs` use the exact schema-compatible
aliases `AIDEV207-PLAN-SHA`, `ROLE-POLICY-SCHEMA-SHA`,
`ROLE-POLICY-RUNTIME-SHA`, and `PLANNER-POLICY-SHA`; each maps one-to-one to
the externally named `AIDEV207_PLAN_SHA`, `ROLE_POLICY_SCHEMA_SHA`,
`ROLE_POLICY_RUNTIME_SHA`, and `PLANNER_POLICY_SHA` in the child output
contracts. The alias is not a filesystem path, Git ref, or permission to
invent a value.

### 4.1 Child P1 — AIDEV-208 optional schema bridge

**Predecessor and trust.** After the separately authorized plan-publication
merge, create a clean AIDEV-208 candidate whose immediate predecessor is the
exact `AIDEV207_PLAN_SHA` commit. Bind its parent `AIDEV-207`, child ID,
original ticket revision, original trusted base
`b57cb97b8f110c5f40bcefee3476a6013a6c7cd0`, branch, and exact two-path scope
from the fresh snapshot. The candidate may not create or mutate Linear state.

**Cohesive scope.** Modify only `profiles/project-profile.schema.json` and
`tests/project-profiles.test.mjs`. Add the optional bounded AIDEV-187-compatible
`delivery.rolePolicy` structural bridge, preserving the existing `delivery.review`
shape and all profiles that omit rolePolicy. Expand profile tests for absent,
valid, unknown-key, backend/catalog, role/profile, duplicate-reference, and
limit cases. Do not configure `pi-sampler.json`, add the runtime, or change any
planning/review behavior.

**Planning-size evidence, not authority.** The base schema is 121 lines/6281
bytes and the profile test is 93 lines/4989 bytes. A repository-grounded
planning range is schema 90–120 plus tests 80–110, upper estimate 230
meaningful changed lines. This estimate is only planning evidence; it is not a
future-candidate measurement or permission to code. Before P1 coding, the
Orchestrator must record a child-specific size-gate record containing the exact
two paths, existing-line/function inventory, upper estimate, predecessor, and
`credible_le_1500:true`. If the estimate is not credible at or below 1,500,
P1 blocks before coding and the Orchestrator must create a new cohesive child
graph with new Linear IDs; it may not split arbitrary file fragments.

**Verification and output.** Run `node --test tests/project-profiles.test.mjs`
and the complete `npm test` from the candidate, then exact allowlist/mode/
status checks, DCO, protected CI, and a fresh read-only exact-head independent
review. Obtain explicit user `Merge PR #N` authority and capture the immutable
AIDEV-208 merge SHA. Publish external output contract
`pi-sampler.aidev-208-role-policy-schema/v1` with named
`ROLE_POLICY_SCHEMA_SHA` equal to the raw SHA-256 of the merged
`profiles/project-profile.schema.json`, plus `merge_sha`, `AIDEV207_PLAN_SHA`,
original trusted base, ticket/revision, exact paths, tests, review, CI, DCO,
and user-authorization evidence. The named output value is JIT; `merge_sha`
is the only next-child Git predecessor.

P1 owns A207-T01. It supplies carried evidence for the serial gate and frozen
lifecycle rows but cannot claim runtime, configured-policy, or final A207
satisfaction. Its complete child packet reports all ten A207 rows as observed,
carried, not-in-scope, or blocked without silently promoting inherited facts.

### 4.2 Child P2 — AIDEV-209 trusted resolver

**Predecessor and trust.** Start only from the exact immutable AIDEV-208
`merge_sha` recorded with `ROLE_POLICY_SCHEMA_SHA`, after revalidating the
AIDEV-208 snapshot, parent/dependency edges, complete P1 packet, exact-head
review, protected CI, DCO, user authorization, and schema output. Preserve
`AIDEV207_PLAN_SHA`, original trusted base, parent ticket revision, repository,
and the exact three-path P2 scope. No P2 candidate code may create, update, or
select tracker state.

**Cohesive scope.** Add only
`contracts/delivery-role-policy-v1.mjs`,
`tests/delivery-role-policy.test.mjs`, and
`tests/fixtures/role-policy/aidev-207-bootstrap-vectors.json`. Implement the
self-contained exact-base loader, bounded parser, trusted profile/schema
validation, catalogs/profile admission, normalizer, serializer, digest,
trusted brand, deterministic resolver, stable no-echo diagnostics, and the
non-secret vectors specified in Section 3. Keep the current profile and
canonical planning documents unchanged/inert. Do not add a candidate verifier,
packet/receipt/marker successor, or review-policy integration.

**Planning-size evidence, not authority.** The current 911-line
`scripts/review-policy.mjs` is an analog, not an imported implementation; it
also covers a broader review-root policy. The P2 function/test inventory gives
this repository-grounded upper range:

| P2 component | Upper planning allocation | Basis |
|---|---:|---|
| Fixed Git-root/blob loader and bounded input plumbing | 300 | Two fixed blobs, exact commit/root checks, size-before-read and no-echo failure paths; no review-root policy. |
| Policy grammar/catalog/profile admission, normalization, brand, digest, resolver | 520 | Six public exports plus fixed precedence and bounds; no lifecycle/provider launch. |
| Runtime/security/precedence/cross-platform tests | 470 | Temporary Git fixtures, mutation probes, exact envelopes, catalog/availability and malformed-input vectors. |
| Canonical JSON fixture vectors | 100 | Non-secret policy, availability, override, fallback, diagnostic, and digest cases. |
| **P2 upper planning estimate** | **1,390** | Explicit function/test inventory, below 1,500 with 110-line headroom. |

This is planning evidence only and deliberately does not claim that a future
candidate has been measured. Before P2 coding, the Orchestrator and child
owner must record the exact three-path inventory, function/test accounting,
predecessor, and `credible_le_1500:true`. If that accounting is not credible,
P2 blocks before coding and the Orchestrator must create new cohesive serial
children and bind their Linear IDs; arbitrary fragment splitting is forbidden.

**Verification and output.** Run:

```sh
node --test tests/delivery-role-policy.test.mjs tests/project-profiles.test.mjs
npm test
```

Also run exact P2 allowlist/mode/status checks, DCO, protected CI, and a fresh
read-only exact-head independent review. Obtain explicit user `Merge PR #N`
authority and capture the immutable AIDEV-209 merge SHA. Publish external
contract `pi-sampler.aidev-209-role-policy-runtime/v1` with named
`ROLE_POLICY_RUNTIME_SHA` equal to the raw SHA-256 of the merged
`contracts/delivery-role-policy-v1.mjs`, plus `merge_sha`, predecessor
`ROLE_POLICY_SCHEMA_SHA` and its merge SHA, `AIDEV207_PLAN_SHA`, original base,
ticket/revision, exact paths, vectors, tests, review, CI, DCO, and user
authorization. Only `merge_sha` becomes the AIDEV-210 Git predecessor.

P2 owns A207-T03, T04, T05, T06, and T08. It carries T01 from P1 and supplies
serial evidence for T09/T10; it cannot claim configured planner/docs adoption
or final completion. Its child packet reports every A207 row and every
inherited output by exact digest.

### 4.3 Child P3 — AIDEV-210 configured planner and model-neutral planning

**Predecessor and trust.** Start only from the exact immutable AIDEV-209
`merge_sha` recorded with `ROLE_POLICY_RUNTIME_SHA`, after revalidating P2's
snapshot, parent/dependency edges, complete packet, review, CI, DCO, user
authorization, runtime output, `AIDEV207_PLAN_SHA`, original base, and parent
revision. The P3 candidate has exactly the four paths listed by AIDEV-210 and
cannot mutate tracker state.

**Cohesive scope.** Modify only `profiles/pi-sampler.json`,
`.agents/skills/create-implementation-plan/SKILL.md`,
`docs/IMPLEMENTATION-PLANNING.md`, and
`tests/implementation-plan-skills.test.mjs`. Configure the exact policy in
Section 3.1, with Pi Luna selected for planning and Pi Terra/Pi Sol/manual
Gemini in the stated order. Replace normative named-planner language with
trusted policy selection plus operator launch. Preserve the exact-base leased
worktree, uncommitted plan/manifest, one challenge, one integrated revision,
one fresh independent review, defect classification, two remediation cycles,
v1/v2 compatibility, evidence, DCO, and separate lifecycle authorities.

**Planning-size evidence, not authority.** The repository-grounded upper range
is profile 80, planning skill 120, documentation 130, and test updates 180,
for an upper estimate of 510 meaningful changed lines. Before P3 coding, record
the exact four-path inventory, document/function/test accounting, predecessor,
and `credible_le_1500:true`. If it is not credible at or below 1,500, P3
blocks before coding and the Orchestrator must create new cohesive child IDs;
no arbitrary documentation/file-fragment split is allowed.

**Verification and output.** Run:

```sh
node --test tests/delivery-role-policy.test.mjs tests/project-profiles.test.mjs tests/implementation-plan-skills.test.mjs
npm test
```

Run exact P3 allowlist/mode/status checks, DCO, protected CI, and a fresh
read-only exact-head independent review. Obtain explicit user `Merge PR #N`
authority and capture the immutable AIDEV-210 merge SHA. Publish external
contract `pi-sampler.aidev-210-planner-policy/v1` with named
`PLANNER_POLICY_SHA` equal to the canonical configured policy digest
`6a5580c2d7548cf1e54ad381bd18a8486b898530780b51b115a6d4bbe84772ed`, plus
`merge_sha`, `ROLE_POLICY_RUNTIME_SHA` and predecessor merge SHA,
`AIDEV207_PLAN_SHA`, original base, ticket/revision, exact paths, tests,
review, CI, DCO, and user authorization. The canonical policy digest must be
recomputed; if it differs, block and refresh rather than silently accepting
configuration drift.

P3 owns A207-T02 and T07, completes end-to-end T08, and supplies the final
serial evidence for T09/T10. It cannot claim AIDEV-202 activation or replace
AIDEV-202's independent plan gate. After P3 merge, AIDEV-202 regenerates and
independently reviews its own plan under the trusted policy.

## 5. Child lifecycle, output binding, and acceptance routing

Each child has one strict predecessor and one exact allowlist. No child starts
until all of the following are revalidated from fresh read-only Linear and Git
evidence: child ID, title/scope, parent `AIDEV-207`, ticket revision, dependency
edges, predecessor merge SHA, original trusted base, repository, clean root,
branch/head, and output contract. Candidate code cannot create/update Linear,
choose a different child, change a dependency edge, or approve its own
completion.

Every child must produce a complete scope-specific packet with exact
`base/head`, path/mode/status inventory, plan-publication binding,
original-base binding, child ticket snapshot, output contract, tests, DCO,
independent exact-head review, protected CI, user merge authorization, and
immutable merge SHA. A child packet includes all ten A207 rows; only its
routed rows may be `observed`, earlier rows are `carried` by exact output, and
later rows are `not-yet`/`blocked`. No aggregate packet or stale child output
may be reused.

| A207 row | Primary child | Required final evidence |
|---|---|---|
| T01 | AIDEV-208 | Optional schema bridge and profile-schema tests; `ROLE_POLICY_SCHEMA_SHA`. |
| T02 | AIDEV-210 | Configured Pi default/manual fallback policy; `PLANNER_POLICY_SHA`. |
| T03 | AIDEV-209 | Exact-base loader/root/blob binding and stable loader envelopes. |
| T04 | AIDEV-209 | Canonical normalized bytes and domain-separated digest vectors. |
| T05 | AIDEV-209 | Selected/override/fallback/availability envelopes and indexes. |
| T06 | AIDEV-209 | Catalog, role, reference, override, availability, forged-policy, exhaustion, and no-echo failures. |
| T07 | AIDEV-210 | Model-neutral canonical skill/documentation and mutation tests. |
| T08 | AIDEV-209, completed by AIDEV-210 | Candidate/worktree/env/prompt/pane independence and no authority from model diversity. |
| T09 | Every child, final route AIDEV-210 | Publication separation, exact-base workflow, review/remediation, v1/v2, packet/receipt/marker, DCO, and user-only merge evidence. |
| T10 | Every child, final route AIDEV-210 | Serial graph, child-specific credible size gates, exact outputs, reviews, CI, DCO, user merge, and immutable SHAs. |

The parent plan is complete only after plan publication and all three child
outputs are bound. Earlier child success is not final A207 approval and no
child output satisfies the same-reviewer verification of this corrected pair.

## 6. Exact implementation allowlist and exclusions

The union of the three child scopes is the only implementation allowlist:

| Path | Child | Status |
|---|---|---|
| `profiles/project-profile.schema.json` | AIDEV-208 | modified |
| `tests/project-profiles.test.mjs` | AIDEV-208 | modified |
| `contracts/delivery-role-policy-v1.mjs` | AIDEV-209 | new |
| `tests/delivery-role-policy.test.mjs` | AIDEV-209 | new |
| `tests/fixtures/role-policy/aidev-207-bootstrap-vectors.json` | AIDEV-209 | new |
| `profiles/pi-sampler.json` | AIDEV-210 | modified |
| `.agents/skills/create-implementation-plan/SKILL.md` | AIDEV-210 | modified |
| `docs/IMPLEMENTATION-PLANNING.md` | AIDEV-210 | modified |
| `tests/implementation-plan-skills.test.mjs` | AIDEV-210 | modified |

The v2 manifest represents the dot-prefixed skill path with the exact
portable symbol `path:.agents/skills/create-implementation-plan/SKILL.md`.
The implementation gate expands this symbol and compares it to the actual
allowlist; it is not decorative metadata and no fake alias/directory is
created. The manifest uses portable hyphenated aliases for the four required
underscore-named outputs as explained in Section 4.

No child changes `profiles/example-project.json`,
`profiles/gelt-trading.example.json`, `scripts/review-policy.mjs`,
`contracts/implementation-plan-manifest-v2.mjs`,
`scripts/validate-implementation-plan.mjs`, project-delivery/code-review
skills, packet/receipt/marker schemas or generators, hooks, workflows,
lockfiles, AIDEV-202 activation/map/controller paths, or unrelated policy.

## 7. Required acceptance outcomes

- [ ] A207-T01: Add an optional strict `delivery.rolePolicy` property using the AIDEV-187-compatible format/version, assignment grammar, role keys, profile admission, bounds, and closed-key behavior while preserving profiles that omit the policy.
- [ ] A207-T02: Configure `profiles/pi-sampler.json` with an admitted Pi planner selected by default, exact trusted role IDs, ordered Pi fallbacks, and an optional manual Gemini/Antigravity assignment that is never a required subscription.
- [ ] A207-T03: Load policy and schema only as verified regular blobs from the supplied exact trusted Git commit, reject mutable/candidate/worktree selectors, and return stable fail-closed diagnostics without leaking raw values.
- [ ] A207-T04: Normalize policy deterministically, preserve fallback order, serialize identical compact UTF-8 bytes across Windows and Linux, and compute the domain-separated v1 SHA-256 digest.
- [ ] A207-T05: Resolve selected, allowlisted-override, and ordered-fallback assignments using the exact considered availability set and exact success envelopes, including correct null/zero-based fallback indexes.
- [ ] A207-T06: Reject unsupported provider/model/thinking/profile/role/reference/override/availability inputs, malformed policy, missing policy, forged policy, and exhausted fallbacks with deterministic precedence and no implicit fallback or launch behavior.
- [ ] A207-T07: Make canonical planning skill/documentation backend/model-neutral so trusted policy selects the planner and an operator launches the selected backend, with no normative named-provider subscription requirement.
- [ ] A207-T08: Prove candidate code, prompts, panes, environment variables, working-tree bytes, and candidate profile values cannot change trusted policy admission or role resolution; keep model/provider identity separate from authority.
- [ ] A207-T09: Preserve exact-base worktree rules, the separately authorized two-file plan-publication gate, one challenge, one integrated revision, one fresh independent review, two-cycle remediation limit, v2 plan validation, packet-v3, receipt-v1, marker-v3, review lifecycle, DCO, and explicit user-only merge authority.
- [ ] A207-T10: Deliver the cohesive implementation through exact serial AIDEV-208 -> AIDEV-209 -> AIDEV-210 children with child-specific credible-at-or-below-1,500 pre-coding gates, exact predecessor outputs, independent exact-head review, protected CI, DCO, explicit `Merge PR #N`, and immutable merge output; block before coding if any child estimate is not credible and never split arbitrary fragments.

## 8. Validation and authority protocol

### 8.1 Pre-publication pair validation

After this one integrated remediation revision, run the deterministic validator
on the complete pair with the original trusted base, remediated parent ticket
revision, approved profile, and exact repository. It must return `ok:true`,
exit 0, zero diagnostics, ten acceptance lines, exact plan/manifest digest
binding, and exact requirement/order parity. Validation is evidence only; it
is not approval by the same Sol/medium reviewer, plan publication authority,
or implementation authority.

Before plan publication, the Orchestrator must revalidate the parent ticket
revision and the complete child graph from read-only Linear snapshots, verify
that the publication candidate contains exactly the two planning files, and
obtain the separate publication PR's exact-head review, protected CI, DCO, and
explicit `Merge PR #N`. Capture `AIDEV207_PLAN_SHA` and its complete output
contract externally. No child can begin from a branch or mutable ref.

### 8.2 Per-child pre-coding and merge sequence

For each child, in strict order:

1. Re-query and snapshot the parent/child ticket IDs, parent IDs, exact titles/
   scope, current parent revision, child revision, blocks/blocked-by edges, and
   downstream AIDEV-202 edge. Compare to the frozen graph and block on any
   drift. Candidate code cannot perform this query or mutate tracker state.
2. Resolve the immediate predecessor as an exact immutable merge commit. Bind
   its output contract, predecessor merge SHA, `AIDEV207_PLAN_SHA`, original
   trusted base, repository, ticket revision, and exact allowlist. Reject a
   missing/stale/ambiguous output or mutable ref.
3. Record the child-specific planning-size gate from the function/path/test
   inventory. The gate is a credibility decision before coding, not a diff of
   a future candidate. If `credible_le_1500` is not true, stop and create/bind
   a new cohesive Linear decomposition; do not code or split arbitrary files.
4. Start a clean candidate from the exact predecessor, run exact path/mode/
   status checks, implement only that child's scope, and run the complete
   named focused tests plus `npm test`. Candidate tests are evidence only.
5. Run DCO, exact-head read-only independent review, protected CI, and all
   child-specific evidence validators. A child cannot self-approve, publish a
   marker, alter a tracker edge, authorize the next child, or merge.
6. Obtain explicit user `Merge PR #N`, capture the immutable merge SHA and
   output contract, and only then unblock the next child. Refresh all exact
   bindings at the next child; do not reuse a prior packet or review.

The child output contract records at least `ticket_id`, `parent_id`,
`ticket_revision`, `repository`, `original_trusted_base_sha`,
`AIDEV207_PLAN_SHA`, `predecessor_merge_sha`, `merge_sha`, named output value,
exact paths/modes/digests, tests/CI/DCO/review/authorization, and status. All
future SHAs/PR numbers and protected results are JIT and unknown now.

### 8.3 Planning validator command

Run before same-reviewer verification and before the separately authorized
publication gate:

```sh
node scripts/validate-implementation-plan.mjs \
  --plan docs/techPlans/AIDEV-207-implementation-plan.md \
  --manifest docs/techPlans/AIDEV-207-acceptance-manifest-v2.json \
  --base b57cb97b8f110c5f40bcefee3476a6013a6c7cd0 \
  --profile profiles/pi-sampler.json \
  --repository Zkrausman/pi-sampler \
  --ticket AIDEV-207 \
  --ticket-revision 7495f11df9288325c211328128d19e21b44c0e9bb91b1c3b9d6ed219ecb58ea1 \
  --json
```

The final status of this remediation is
`ready_for_same_reviewer_verification` only if the validator passes with zero
errors, final plan/manifest hashes match, child/parent snapshots and edges are
frozen, and worktree inventory is exactly the two untracked planning files.
Otherwise it is `blocked`. The same Sol/medium reviewer from
`independent-review-v1` must inspect the complete corrected pair; no new
challenge or reviewer is permitted in this cycle.

## 9. Compatibility, staleness, and downstream boundary

The serial decomposition preserves the non-defect strengths from the prior
pair: exact-base loading, bounded blobs, approved repository binding,
canonical/digest semantics, exact resolver precedence, no-echo diagnostics,
optional manual planning, model-neutral documentation, candidate independence,
v1/v2 readability, packet-v3/receipt-v1/marker-v3, review lifecycle, DCO, and
human-only merge authority.

The pair is stale when the parent/child ticket descriptions, revisions,
parent/edge graph, plan-publication output, original base, profile/schema/
review-policy/validator bytes, AIDEV-187 compatibility semantics, assignment
IDs/catalogs/fallbacks/overrides, digest/diagnostic rules, child allowlists or
size credibility, output contracts, acceptance requirements, or approval state
changes. The manifest records portable predecessor-output aliases and
`predecessor_output_changed` triggers; child output values and merge SHAs are
JIT evidence and are never fabricated here. A descendant campaign change does
not silently rewrite this pair; each child must rebind its own predecessor.

After authorized P3 merge, AIDEV-202 must regenerate and independently approve
its own plan against the new trusted planner policy. AIDEV-187 must reconcile
AIDEV-208/AIDEV-209/AIDEV-210 as its first merged role-policy subset and
remains authority for broader roles, packet-v4, receipt-v2, marker-v4,
context-admission, and successor interfaces. No planner choice, validator
success, child output, or merge substitutes for those approvals.
