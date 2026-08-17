---
type: specification
title: Authoritative adapter and artifact receipt v1
status: proposed
schema_id: https://pi-sampler.dev/contracts/authoritative-receipt/v1
schema_version: 1.0.0
---

# Authoritative adapter and artifact receipt v1

AIDEV-125 defines the narrow boundary through which an external system may
contribute a *verified observation*. It is not an adapter implementation,
lifecycle transition, delivery API, closeout authority, generic tool API, or a
replacement identity/evidence system. It reuses [Ticket Episode v1](TICKET-EPISODE-V1.md)
for project/ticket/episode/revision/evidence semantics and the AIDEV-124
bounded ledger for immutable artifact and admission primitives.

The canonical executable source is
[`contracts/authoritative-receipt-v1.mjs`](../../contracts/authoritative-receipt-v1.mjs).
It generates the editor-facing structural schema at
[`contracts/authoritative-receipt-v1.schema.json`](../../contracts/authoritative-receipt-v1.schema.json)
with `npm run generate:authoritative-receipt-schema`; CI checks it with
`npm run validate:authoritative-receipt-schema`. The executable validator,
not JSON Schema, is authoritative for canonical time, content addressing,
freshness, configured roots, verifier behavior, and cross-field binding.

## Trust boundary

A submitted receipt has two deliberately separate portions:

- `observed` is the proposed authority-bound observation. It names immutable
  project, repository revision, ticket, episode, operation, producer,
  authority, receipt, artifact content addresses, coverage, and sensitivity.
- `claims` is caller-supplied, untrusted context. It can only be
  `caller_claim` or `model_inference`; it has no authority or observed-evidence
  fields. Each value is a digest, size, and required sensitivity label rather
  than inline body text. Claims participate in idempotency content comparison
  but never become evidence by relabeling.

An accepted observed receipt requires all of the following, with no default or
fallback path:

1. Its schema version and every identity are exact and its repository revision
   is a lowercase immutable 40- or 64-character Git object ID.
2. The authority ID resolves to exactly one configured connected-authority
   root. That root names the allowed external producer IDs and exposes a
   verifier function with a bounded timeout.
3. The receipt computes a canonical binding over the producer, authority,
   project, ticket, episode, immutable revision, operation, receipt,
   idempotency key, observation, payload digest/size, artifact references,
   coverage, and sensitivity. The receipt attestation and verifier response
   must both equal that binding digest.
4. The verifier returns exactly `{ accepted: true, bindingDigest }` before
   any authoritative record is admitted. Rejection, exception, timeout,
   malformed response, wrong digest, absent root, or missing verifier fails
   closed.
5. The `AuthoritativeReceiptLedger` then materializes only the declared
   content-addressed artifact bytes through the AIDEV-124 ledger and persists
   one Ticket Episode `observed_evidence` event whose producer is the configured
   authority. The adapter/caller identity remains inside the immutable receipt
   artifact; it is never promoted to the authority producer.

Thus an adapter can transport a receipt, a caller can request admission, and a
model or generic tool can supply an untrusted claim, but none can self-attest
or mint authority. The authority-bound receipt `producer` is adapter-only and
must differ from its authority; callers, models, and generic tools cannot
occupy that field. A configured authority verifier is the only route to an
accepted `observed_evidence` event.

## Receipt, identity, artifact, and sensitivity rules

The receipt contains stable opaque IDs for `producer`, `authority`, `receipt`,
`operation`, `project`, `ticket`, `episode`, and each `artifact`. A receipt is
always tied to `repository.id` plus an immutable `repository.revision`; branch
names, paths, and mutable checkout state are excluded. Where Ticket Episode v1
has a shorter identity boundary, the facade derives fixed-length,
domain-separated SHA-256 identities. Each derived Ticket Episode `attempt`,
`session`, and `agentRun.runId` hashes the complete canonical ownership tuple:
project ID, ticket system and ID, episode ID, external producer ID, authority
ID, its external receipt or operation ID, and the identity domain. Attempt and
run use the operation ID; session uses the receipt ID. This prevents locally
scoped external IDs from colliding across tickets while retaining deterministic
replay within one scope. It never prefixes an external ID into a Ticket Episode
ID, so every contract-valid minimum or 128-character input remains representable.

Each large evidence body is an out-of-line `observed.artifacts` entry plus a
supplied `Uint8Array` at the admission boundary. Inline evidence bodies do not
exist in the schema. Every artifact requires:

| Field | Rule |
| --- | --- |
| `digest`, `size` | SHA-256 address and exact byte length; materialized bytes must match both. |
| `identity` | Opaque identity and kind of the artifact source. |
| `evidenceClass` | Must be the AIDEV-123 `observed_evidence` class for an authoritative observation. |
| `coverage` | Explicit complete/partial counts and missing IDs. Partial remains partial. |
| `provenance` | Exact producer, authority, receipt, and operation IDs. |
| `sensitivity` | Required `public`, `internal`, `confidential`, or `restricted` classification. |

`observed.payload` repeats the selected artifact ID/digest/size and must match
one declared artifact. The outer observation sensitivity must be at least the
most restrictive artifact sensitivity. A receiver must retain every artifact
classification; omission or downgrade is rejected. Any partial artifact makes
complete observation coverage invalid. A projection may only preserve or raise
sensitivity and may only preserve or reduce coverage, never silently upgrade
it.

## Freshness and idempotency

`receipt.issuedAt`, `receipt.expiresAt`, and `observed.observedAt` are canonical
UTC RFC 3339 strings with milliseconds. A configured freshness policy has a
maximum observation age, future clock-skew bound, and (by default) mandatory
expiration. Stale, expired, future-dated, and noncanonical evidence is not
accepted. Lookup rereads the original persisted receipt artifact and evaluates
all three original timestamps against the configured policy; an expired receipt
returns `stale` with `evidence_expired`. It never fabricates timestamps or
reports unreverified stored material as current evidence.

`idempotency.key` is globally bound by a deterministic Ticket Episode event ID,
while its canonical receipt digest binds at least project, ticket, episode,
operation, producer, authority, revision, payload/artifact content, coverage,
sensitivity, and claims. Exact replay of the same canonical receipt under the
same key returns `idempotent`. A changed payload or reuse of that key across a
ticket, episode, operation, or producer is an explicit `idempotency_conflict`.
The AIDEV-124 immutable admission path rebuilds that binding on restart. Before
an `AuthoritativeReceiptLedger` is returned after restart, it rereads every
persisted receipt artifact and reruns the configured verifier against its
original observation time; any missing/tampered artifact, binding mismatch, or
verifier failure fails closed without exposing the ledger facade.

Verifier failure occurs before artifact/record publication. Before any durable
write, the facade validates every supplied body and one-to-one reference,
derives and validates the Ticket Episode record, and asks the AIDEV-124 ledger
to reserve aggregate capacity for every new evidence artifact, the receipt
artifact, commit, and durable acknowledgement. The narrow batch admission
publishes an authenticated staging marker before its first artifact. Its HMAC
and the immutable commit envelope bind one batch ID to the exact commit and its
complete artifact references; a retained post-fsync acknowledgement is the
only durable acceptance proof. Recovery validates all of those bindings before
performing any cleanup. A valid but unacknowledged batch removes only its
specific commit and newly-published artifacts after proving no other commit
references them. An acknowledged batch is retained even if a stale pending
marker is replayed. Malformed, legacy, forged, or mismatched markers are
quarantined rather than used as deletion authority. Thus rejected work
(including a process crash after artifact publication) exposes no accepted
receipt event, no orphan artifact capacity, and deterministic retry, while a
forged marker cannot delete accepted state. A fault after the acknowledgement
is reconciled as the already durable accepted commit. Conflicts leave the
earlier accepted event unchanged.

## Limits, conformance, and exclusions

Default bounds are 64 KiB canonical receipt bytes, 32 artifact references, 32
claim entries, and a five-second maximum verifier deadline. Artifact byte and
storage bounds are enforced by the reused AIDEV-124 ledger. Oversized receipts
or artifacts fail before receipt acceptance. Trust-root configuration is also
fail-closed in both the facade and exported verifier: empty, malformed, and
duplicate authority IDs (including duplicate values supplied through a `Map`)
are rejected rather than selecting an order-dependent root.

`tests/helpers/authoritative-receipt-conformance.mjs` provides fake connected
authorities and a table-driven harness. The adversarial matrix covers valid
receipts; forged/unconfigured authority; absent/rejecting/throwing/timing-out
or malformed verifiers; producer mismatch; stale/future/noncanonical time;
partial coverage; unknown versions; missing/downgraded sensitivity; caller
observed-evidence attempts; digest/size/revision mismatch; exact replay;
content and ownership-key conflicts; bounds; pre-publication failure; and
restart recovery.

This contract intentionally does **not** implement production test, Git,
GitHub, Linear, Wiki, provider, or delivery adapters (AIDEV-131/AIDEV-137), nor
lifecycle transitions, closeout authority, accounting, annotations,
retrospectives, promotion, UI, or a parallel episode identity/persistence or
evidence-class system.
