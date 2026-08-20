# Lesson Registry v1

## Purpose

Lesson Registry v1 turns cited retrospective findings into inspectable, versioned candidate behaviors. A lesson is never an implicit instruction to rewrite the system. It remains subject to human decisions, evaluation, promotion policy, monitoring, and an immutable history.

## Contract and version identity

`contracts/lesson-v1.mjs` is the canonical TypeBox source. A lesson has a stable `id` and monotonically increasing integer `version`. Version 1 has no parent. Every later version binds the immediately preceding version of the same lesson by identity, version, and SHA-256 digest. The schema records:

- bounded applicability scope, conditions, and optional expiration;
- one inspectable `repeat`, `avoid`, or `test` behavior;
- exact episode/event/ticket citations, annotations, and counterevidence;
- confidence, risk, human decisions, creator, evaluator, and timestamps;
- optional explicit catastrophic-safety policy and conflict disposition.

All timestamps are canonical UTC RFC 3339 values with milliseconds. Schema and semantic validation are independent from persistence.

The JSON Schema exporter writes only to standard output. A caller that wants an artifact must choose and secure the redirection target; the exporter performs no filesystem I/O.

## Lifecycle

The permitted directed transitions are:

```text
proposed -> evaluated -> promoted -> monitored
    |           |           |           |
    +-> rejected+           +-> reverted+-> reverted
                            +-> retired  +-> retired
                            +-> superseded
                                        +-> superseded
reverted -> retired | superseded
```

`rejected`, `retired`, and `superseded` are terminal. Terminal transitions create a new immutable version; they never remove history. Invalid jumps fail before durable admission. Cache state changes only after the underlying ledger acknowledges the atomic artifact-and-event batch.

## Durable unidirectional flow

`LessonRegistry` depends on `EpisodeEvolutionLedger`; the ledger does not import lesson contracts or registry code. Each lesson version is canonical JSON stored as a content-addressed artifact and admitted atomically with a Ticket Episode event whose kind is `lesson`. Artifact identity and content digest are checked during rebuild.

Rebuild accepts a bounded async `streamRecords` adapter and discards each batch after processing. The compatibility fallback uses the ledger's bounded `listRecords` API and fails closed if the result is truncated. It never silently treats a partial scan as the complete registry. Missing lineage, conflicting version claims, corrupt artifacts, and invalid transitions abort rebuild before replacing the active cache.

## Promotion policy

Promotion requires at least one evidence citation and evidence from at least two distinct tickets. A one-ticket hypothesis remains evaluated. There is exactly one exception: a lesson may be promoted from one ticket when all of the following are structurally valid:

1. risk is `catastrophic`;
2. behavior is `avoid`;
3. the policy is an explicitly named narrow prohibition;
4. a human authorizer, time, and rationale are recorded.

Malformed metadata, zero evidence, broad emergency behavior, and non-human-governed bypasses are denied. The exception creates a prohibition only; it cannot introduce a repeat or test behavior.

## Conflict, overlap, staleness, and accumulation

Applicability overlaps and behavior conflicts are evaluated against active evaluated/promoted/monitored lessons. Detector exceptions and timeouts fail promotion closed and expose only a stable error code, not raw ledger packets. A conflicting lesson cannot be promoted unless a human-authored conflict disposition explicitly names every conflicting lesson; there is no insertion-order tie-break.

Overlap results are returned to callers even when they are not contradictory. `listStale` surfaces active lessons whose applicability has expired. `ruleAccumulation` reports the active promoted/monitored rule count for a scope, a configured threshold breach, and bounded lesson identities.

## Threat model and fail-closed behavior

| Threat | Control |
| --- | --- |
| One episode silently changes behavior | Two-ticket promotion floor; narrow human-governed catastrophic prohibition only |
| Zero or fabricated evidence | Structural non-empty citations with episode, event, ticket, time, and exact citation |
| Silent conflict ordering | Explicit conflict detection and complete human conflict disposition |
| Detector outage or exception | Promotion fails closed with sanitized error details |
| OOM during rebuild | Async batches, hard record bound, truncated fallback rejection |
| Partial persistence or cache leakage | Atomic ledger artifact/event batch; cache mutation only after acknowledgement |
| Corrupt or substituted lesson bytes | Content-addressed artifact, canonical digest, schema and lineage validation |
| Symlink overwrite through schema generation | Exporter has no filesystem access and writes exclusively to stdout |
| Rule accumulation and staleness | Explicit bounded accumulation report and expiration query |
| Cyclic policy dependency | Strict registry-to-ledger dependency direction |

The registry is a policy and persistence facade, not an evaluator, signing authority, scheduler, or autonomous configuration writer.
