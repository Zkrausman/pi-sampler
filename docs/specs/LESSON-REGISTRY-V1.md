---
type: specification
title: Versioned Lesson Registry v1
status: proposed
schema_id: https://pi-sampler.dev/contracts/lesson/v1
schema_version: 1.0.0
---

# Versioned Lesson Registry v1

AIDEV-133 introduces the bounded, versioned registry for candidate lessons. A
lesson is an immutable behavioral rule plus cited evidence, applicability, and
provenance. It is not an evaluation engine, delivery workflow, policy editor,
or automatic code-change mechanism.

The executable contract is [`contracts/lesson-v1.mjs`](../../contracts/lesson-v1.mjs).
`node scripts/export-lesson-v1-schema.mjs` emits its JSON Schema exclusively to
stdout. The repository intentionally does not write or version a generated
`lesson-v1.schema.json`; callers may redirect stdout in a controlled location.

## Schema and immutable fields

Every document has the fixed v1 schema ID/version, a stable `lesson.id`, and a
monotonic `lesson.revision`. `applicability`, `behavior`, `evidence`,
`provenance`, and the optional catastrophic-safety exception are immutable once
proposed. A successor can change only `state` and increment revision by exactly
one. Evidence citations bind a ticket system/ID, event ID, and content digest;
zero citations and duplicate citations are rejected. Provenance has a canonical
UTC creation timestamp, immutable source revision digest, and non-self-referential
source lesson IDs.

Applicability must explicitly name repository and task-kind sets. Behavior has a
single subject, guidance text, and one action: `avoid`, `prefer`, or `require`.
This lets overlap analysis use deterministic set intersection instead of
interpreting unbounded prose.

## Lifecycle

The directed lifecycle is:

```
proposed -> evaluated -> promoted -> monitored -> {reverted|retired|superseded}
                  \-> rejected
```

`evaluated` may instead retire; every terminal state is terminal. Invalid jumps,
identity changes, revision skips, or mutable-field changes are rejected before
any cache update. A failed lower-ledger append also leaves the registry's active
cache unchanged.

## Persistence and unidirectional flow

`LessonRegistry` is a narrow facade over `EpisodeEvolutionLedger`. It serializes
a canonical lesson snapshot as one content-addressed artifact and appends an
immutable Ticket Episode `lesson` event. The lower ledger has no import of the
lesson contract and therefore cannot invoke lifecycle, promotion, or conflict
logic. On open, the registry rebuilds its active cache from bounded record
batches and rereads/validates each artifact; corrupt, missing, conflicting, or
truncated persistence fails closed.

The registry accepts a cursor/batch `streamRecords` backing interface where it
is available and bounds both total records and total batches (including empty
batches). The legacy bounded `listRecords` fallback rejects truncation. Conflict and overlap analysis rescan
the persisted stream rather than trusting caller input or silently choosing a
winner; their result count is bounded. A scan error, malformed artifact,
truncation, or bound exhaustion denies promotion.

## Promotion guardrails and conflicts

Promotion is permitted only from `evaluated`. It independently revalidates the
lesson and requires at least one citation; normally the citations must span two
or more tickets. The sole narrow exception is an `avoid` lesson with a fully
structural `catastrophicSafetyException` whose category and severity are both
exactly catastrophic-safety/catastrophic and whose rationale is non-empty.
Malformed, partial, or inapplicable exception metadata never bypasses the
evidence-breadth rule.

An overlap shares a repository, task kind, and behavior subject with a live
proposed/evaluated/promoted/monitored lesson. A conflict is an overlap where one
rule requires and the other avoids the same subject. Promotion fails if conflict
detection fails or finds any conflict; callers must explicitly reject or
supersede the competing lesson. There is no recency, lexical, or priority-based
tie breaker.

## Threat model and exclusions

- **Fabricated or thin evidence:** structural validation and promotion both
  reject zero citations; multi-ticket breadth is fail-closed.
- **Emergency-bypass abuse:** only the exact typed catastrophic `avoid` block
  can narrow the breadth rule. Parsing failures deny promotion.
- **State leakage after failure:** cache replacement happens only after durable
  append success; rebuild uses replacement rather than partial mutation.
- **OOM or hostile persistence:** record scans are bounded/batched, artifact
  reads are delegated to the ledger's content-address checks, and a truncated
  scan is an error rather than partial authority.
- **Conflicting rules:** deterministic overlap/conflict scans deny promotion;
  no automatic resolution exists.
- **Path and symlink attacks:** the registry writes no paths itself. The backing
  ledger owns its hardened content-addressed storage and filesystem handling.

This contract deliberately does not create evaluators, human approvals,
canaries, remote adapters, policy mutation, automatic implementation, or
cross-project authority.
