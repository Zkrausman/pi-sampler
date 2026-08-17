---
type: specification
title: Ticket Episode v1
status: proposed
schema_id: https://pi-sampler.dev/contracts/ticket-episode/v1
schema_version: 1.0.0
---

# Ticket Episode v1

Ticket Episode v1 is the versioned correlation and invariant contract for every
future conversation, annotation, usage record, artifact, outcome,
retrospective, lesson, and evolution event. It establishes terminology and
fail-closed validation rules; it does **not** implement persistence, adapters,
accounting, retrospective processing, lesson promotion, delivery, or a
`pi-evolution` interface.

The canonical executable schema is
[`contracts/ticket-episode-v1.mjs`](../../contracts/ticket-episode-v1.mjs).
It drives both the executable validator and the checked, editor-facing JSON
Schema export at
[`contracts/ticket-episode-v1.schema.json`](../../contracts/ticket-episode-v1.schema.json).
The exported schema is structural; its cross-record identity, chronology,
coverage, and authority invariants are enforced by the executable validator.

## Identity and ordering contract

Every v1 event has exactly these correlated identities:

| Field | Normative rule |
| --- | --- |
| `project.id` | Stable opaque project identity; a project name or local path is not an identity. |
| `repository.id` and `repository.revision` | Repository ID plus a lowercase immutable 40- or 64-character Git object ID. A branch, tag, mutable checkout, or filesystem path is not a revision. |
| `ticket.system` and `ticket.id` | Work-item tracker namespace and stable work-item identity. |
| `episode.id` | Correlation identity for one ticket episode. An episode ID cannot be rebound to a different ticket. |
| `attempt.id`, `session.id`, `agentRun.agentId`, and `agentRun.runId` | Opaque correlation identities. Attempt, session, and run IDs cannot be rebound across tickets. |
| `event.id` and `event.kind` | Globally one-use event ID and one of `conversation`, `annotation`, `usage`, `artifact`, `outcome`, `retrospective`, `lesson`, or `evolution`. |
| `producer.id` and `producer.kind` | Identity of the actor that emitted the record, never proof that the actor has authority. |
| `schema.id` and `schema.version` | Must exactly identify Ticket Episode v1. An unknown version is rejected rather than coerced. |
| `occurredAt` and `sequence` | Canonical UTC RFC 3339 timestamp with milliseconds and a non-negative sequence that strictly increases within an episode in supplied order. Timestamp order must not move backward. |

An event is therefore always scoped to a project, immutable repository revision,
ticket, episode, attempt, session, and run. Consumers must preserve all those
links when projecting records. They must not manufacture a missing link from a
filename, branch, tracker lookup, current session, or model output.

## Evidence classes

Evidence class expresses what a record is allowed to claim, not whether it is
useful or true. The four classes are mutually exclusive:

| Class | Required producer | Allowed claim | Prohibited claim |
| --- | --- | --- | --- |
| `observed_evidence` | `connected_authority` with verified attestation | An observation supplied by a configured authority verifier. | A receipt or outcome without a configured trust root and positive verifier result. |
| `human_annotation` | `human` | A human's annotation, judgment, or correction. | An automatically authoritative receipt or an observation from a service. |
| `caller_claim` | `pi_extension`, `adapter`, or `system` | A claim supplied by the caller and explicitly untrusted. | Authority, completion, or coverage not independently verified. |
| `model_inference` | `model` | A model-derived interpretation, hypothesis, or summary. | A source observation, human decision, authority attestation, or promotion decision. |

`producer.kind` is one of `human`, `pi_extension`, `adapter`, `model`,
`connected_authority`, or `system`. A producer is a provenance label, not a
permission grant. `observed_evidence` always requires `authority.level` to be `attested`. It must
name an authority and attestation ID, have a `connected_authority` producer with
the same ID, appear in the caller-supplied trusted-authority set, and pass the
caller-supplied attestation verifier. No other evidence class may set
`authority.level` to `attested`. The contract intentionally supplies no default
trust root and no signature scheme.

## State and coverage invariants

A record state is exactly one of `complete`, `partial`, `quarantined`,
`superseded`, or `conflicting`.

- `complete` requires complete coverage: expected and observed event counts
  match, there are no missing IDs, and the record is attested
  `observed_evidence`. No human annotation, caller claim, or model inference
  can assert complete state or complete coverage.
- `partial` requires partial coverage: observed count is lower than expected
  and every known missing item is named. A consumer must display or propagate
  the partial state; it must not silently upgrade it.
- `quarantined` means the record is retained for correlation but cannot support
  an authority-bearing decision until a later contract resolves it.
- `superseded` must name the replacement event ID.
- `conflicting` must name at least one conflicting event ID. It does not choose
  a winner.

The contract does not define a lifecycle state machine, a conflict-resolution
process, or a receipt ledger. Those are intentionally later-owner concerns.

## Threat model

### Trust boundaries and threats

| Boundary | Threat | Required v1 defense |
| --- | --- | --- |
| Project and work-item tracker | Caller swaps project/ticket context or uses mutable tracker text as proof. | Bind opaque project and ticket identities to every event; do not treat current tracker state as evidence. |
| Repository and filesystem | Branch movement, path traversal, symlink replacement, or local file contents are represented as an immutable revision or trusted receipt. | Require immutable revision IDs; do not accept local paths or raw file/transcript content in this contract. |
| Pi extensions | An extension forges a completion, authority, or coverage claim. | Classify extension input as `caller_claim`; it cannot self-attest. |
| Adapters | An adapter turns transformed input into an authoritative receipt. | Classify adapter output as `caller_claim` unless a later connected-authority verifier establishes observed evidence. |
| Models | Prompt injection or hallucination mints an action, receipt, or decision. | Restrict model output to `model_inference`; it cannot attest, promote, dispatch, or resolve conflict. |
| Connected authorities | A forged authority ID, stale receipt, or verifier bypass is accepted. | Require a configured trust root, producer/authority binding, attestation ID, and a positive verifier callback; reject by default. |

The M0 audit found legacy model-facing reconciliation capable of writing through
an attacker-controlled ledger path. That implementation is retired and Git
history is reference-only. No retired extension, historical receipt, local
session, raw transcript, mutable path, or model assertion is authoritative in
this contract.

Residual risk remains outside this contract: a configured verifier can be
misconfigured or compromised; a trusted source can emit false data; and clocks
can be wrong even when their order is monotonic. V1 preserves those conditions
as classified records rather than claiming to solve them.

## Migration boundary and successor ownership

There is no compatibility package or automatic migration from the retired
extensions. Existing data is historical input only and must be reclassified and
revalidated by its successor owner:

| Retired data family | v1 handling | Successor owner |
| --- | --- | --- |
| Ticket lifecycle state | Correlate only after explicit project/ticket/revision binding; do not import lifecycle authority. | AIDEV-124 then AIDEV-130. |
| Cost and usage records | Preserve as untrusted caller claims until exact attribution/evidence rules exist. | AIDEV-128 and AIDEV-129. |
| Closeout summaries and outcomes | Preserve as annotation, claim, or quarantined material; do not treat text as a receipt. | AIDEV-130 and later AIDEV-136. |
| Conversation and hindsight material | Preserve only through the M2 memory and annotation contracts, with evidence class retained. | AIDEV-126 and AIDEV-127. |
| Delivery and Wiki adapter material | Never restore or bridge legacy adapters; require later authoritative receipts. | AIDEV-125, AIDEV-131, and AIDEV-137. |

AIDEV-123 owns this foundational identity, evidence-class, invariant, and threat
model contract. AIDEV-124 owns bounded ledgers; AIDEV-130 owns lifecycle schema
authority; and later M2–M5 tickets own their named data, adapter, receipt, and
user-experience contracts. Nothing here creates authority for those later
systems.
