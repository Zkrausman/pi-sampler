---
type: specification
title: Lesson Registry v1
status: proposed
schema_id: https://pi-sampler.dev/contracts/lesson/v1
schema_version: 1.0.0
---

# Lesson Registry v1

A Lesson is a versioned, inspectable hypothesis about a behavior that may be
repeated, avoided, or tested. The registry is a durable facade over the
bounded `EpisodeEvolutionLedger`; it is not a replacement ledger and it does
not grant a model, extension, or adapter authority to promote a rule.

The executable contract is
[`contracts/lesson-v1.mjs`](../../contracts/lesson-v1.mjs). It is the sole
source for the structural JSON Schema. `validateLessonV1` additionally checks
cross-field provenance, content identity, canonical timestamps, and emergency
policy metadata that JSON Schema cannot safely express.

## Lesson identity and immutable content

A lesson has an opaque `id` and positive `version`. Its `contentDigest` is a
SHA-256 digest of canonical JSON after removing only lifecycle and other
mutable status fields (`state`, `stateHistory`, `updatedAt`, evaluation,
rejection, retirement, supersession target, and the digest itself). A lifecycle
transition therefore preserves the exact content identity, while a new lesson
version must use a new immutable content digest.

Every lesson records:

- bounded applicability conditions;
- exactly one behavior kind: `repeat`, `avoid`, or `test`;
- supporting evidence citations bound to episode, event, and ticket identities;
- annotations and counterevidence without elevating either to authority;
- confidence and an explicit risk level/rationale;
- source episodes, source tickets, at least one human decision, and creator
  provenance; and
- evaluator ID and version, preserving the evaluator identity used to produce
  the lesson.

No current tracker lookup, branch name, filesystem path, model statement, or
mutable local session may replace an immutable citation or provenance field.

## Lifecycle state machine

The lifecycle is append-only and directed:

```text
proposed -> evaluated -> promoted -> monitored -> reverted -> retired
                    |          |          |
                    v          v          v
                 rejected   superseded  superseded
```

A proposed lesson may use the narrow emergency path described below and move
directly to `promoted`. `rejected`, `retired`, `reverted`, and `superseded`
preserve the prior content and all transition history; they are not deletions.
A transition records the previous state, next state, canonical time, actor, and
optional human decision ID. Silent state jumps and cycles are rejected.

Promotion, supersession, rejection, retirement, and rollback are durable
lesson events. The in-memory active cache is changed only after the underlying
immutable event and its content-addressed artifact have been durably admitted.
A failed append, validation error, conflict check, or detection timeout leaves
the cache unchanged.

## Evidence and promotion policy

Promotion is fail-closed:

1. Zero evidence is always rejected.
2. Normal promotion requires evidence from at least two distinct source
   tickets. One episode or one ticket cannot silently become a general rule.
3. A lesson with contradictory applicability/behavior against an active lesson
   is rejected. The caller must explicitly supersede or reject the competing
   lesson; the registry never tie-breaks by insertion order, confidence, or
   version number.
4. Stale repository/evaluator evidence is rejected on the normal path.
5. Conflict and overlap detection errors, malformed results, timeouts, and
   incomplete bounded ledger pages reject promotion rather than permitting a
   best-effort decision.

Overlapping but compatible applicability is surfaced to callers and retained
as a diagnostic. Contradictory overlap is a conflict and blocks promotion.
Terminal lessons are retained for history but are not active conflict winners.

## Catastrophic safety exception

A single catastrophic safety episode may create one narrow immediate
prohibition. The exception is explicit metadata, not a caller-controlled
boolean bypass. It must:

- have `kind: catastrophic_safety` and the exact supported policy version;
- bind one cited episode, event, and ticket;
- bind a cited `humanDecisionId` whose decision is `approve`, whose author is
  exactly `approvedBy`, and whose episode/event/ticket bindings match the
  exception;
- pass the registry's configured `authorizedHumanIdentities` trust boundary;
  an empty authorization set disables the one-ticket exception;
- name a bounded reason and a human approver;
- scope only an `avoid` behavior and no more than four applicability
  conditions; and
- remain within one source ticket, one episode, and one event.

A malformed, expired, unbound, broadened, or unparsable exception is rejected.
The exception bypasses only the two-ticket breadth rule; it never bypasses
structural validation, evidence presence, content identity, conflict/overlap
analysis, or lifecycle authorization. Emergency policy remains human-governed
and must not be inferred from a high risk score.

## Durable flow and bounded rebuilds

The data flow is unidirectional:

```text
LessonRegistry -> EpisodeEvolutionLedger
              -> content-addressed lesson artifact
```

The contract module does not import the registry or ledger. A registry event
contains a classified `lesson` Ticket Episode record and one canonical JSON
artifact. The ledger emits a registry-admission marker only through its private
capability-gated lesson append path; generic ledger appends do not enter the
registry event namespace. When an already-open ledger is injected, the caller
must provide the same private capability used to configure that ledger; otherwise
`LessonRegistry.open` fails closed. Rebuilding reads bounded pages or an async
ledger stream, validates each artifact, and swaps the cache only after the complete stream succeeds.
Malformed lesson artifacts, conflicting content identities, missing pages, and
truncated streams fail closed. Rebuild also requires the capability-bound registry
admission marker, contiguous episode sequence, an initial unevaluated proposal,
and a complete state-history chain for every later version/state. Registry queries
return clones and never expose raw ledger packets.

Conflict, overlap, stale-evidence, and accumulation queries use the same
bounded stream boundary. Limits apply to lesson bytes, conditions, evidence,
rebuild pages, active rules, and returned records. No registry operation may
serialize an unbounded ledger or use a partial page as a complete decision.

## Threat model

| Threat | Required defense |
| --- | --- |
| One ticket generalizes an accident into a rule | Distinct-ticket promotion gate; explicit emergency policy only for a narrow avoid lesson. |
| Conflicting rules are ordered by arrival or confidence | Streamed conflict detection and explicit supersession/rejection; no silent tie-break. |
| Model or adapter mints authority | Episode evidence remains classified and human decisions/evaluator identity are required. |
| Raw ledger append mints a promoted lesson | Generic ledger appends cannot emit the private capability-bound registry-admission marker; rebuild rejects unmarked events before lifecycle replay. |
| Forged catastrophic approval bypasses the two-ticket rule | The exception binds an approving human decision and author to the cited evidence, then checks the configured human-identity trust boundary. |
| Stale evaluation is reused after repository/evaluator drift | Immutable revision/evaluator identity and fail-closed staleness checks. |
| Malformed emergency metadata bypasses policy | Strict structural and semantic exception validation; malformed data denies promotion. |
| OOM or partial rebuild hides accumulated rules | Bounded stream/page interfaces, configured limits, and atomic cache replacement. |
| Symlink/path or raw-packet leakage through persistence | Registry writes through the ledger's content-addressed artifact API and exposes only sanitized error summaries. |
| Failed append leaves a phantom promoted rule | Durable publication precedes cache mutation; failed transitions restore the prior maps. |

The registry does not implement evaluation, canaries, delivery, rollback of
source code, connected-authority verification, or user-interface policy. Those
remain successor-owner boundaries for later tickets.
