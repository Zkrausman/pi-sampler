# Bounded Episode and Evolution Ledger v1

AIDEV-124 provides the durable source ledger for canonical Ticket Episode v1
records. It is deliberately a new, standalone implementation: it neither reads
nor restores retired extensions, receipt ledgers, lifecycle state, adapters, or
historical authority assumptions.

## API and layout

`ledgers/episode-evolution-ledger.mjs` exports `EpisodeEvolutionLedger`.
`appendEpisode(record)` admits a canonical Ticket Episode v1 event.
`appendEvolution(record, { id, outcome, explanation })` additionally requires
`event.kind: "evolution"` and one explicit terminal outcome: `accepted`,
`rejected`, `failed`, or `rolled_back`. Thus unsuccessful attempts are immutable
and queryable through `queryEvolutions`; they are not deleted or collapsed.

A root contains an immutable `manifest.json` (`format: episode-evolution-ledger`,
version 1), content-addressed `artifacts/`, hashed episode partitions under
`commits/`, diagnostics and moved bad material under `quarantine/`, immutable
`projections/`, and bounded `exports/`. Caller-controlled identifiers never form
filesystem paths. Unknown, future, or malformed format versions fail closed.

## Durability, recovery, and consistency

One event is one immutable commit file. The implementation writes a private
staging file, fsyncs it, links it atomically into the episode commit directory,
and fsyncs that directory. Publication is the commit boundary: a fault before it
is invisible and staging is removed on reopen; a fault after it is committed and
recovered. A commit includes a deterministic checksum and a per-episode previous
checksum chain. Loading verifies canonical v1 validation, partition/file binding,
checksums, chain, ownership, event uniqueness, sequence, and chronology.

Malformed, truncated, tampered, out-of-order, conflicting, or unsafe material is
isolated into durable quarantine diagnostics. A damaged partition never prevents
other partitions loading. Intrinsic checksums/chains detect changed records and
missing interior links; no local filesystem alone can prove an attacker did not
delete the newest entire tail, so retain immutable exported snapshot identities
for that threat.

A process-wide `writer.lock` rejects simultaneous processes. Within one process,
a bounded FIFO admission queue serializes global identity checks and publication;
this avoids cross-partition duplicate-ID races while retaining bounded backpressure.
`close()` first rejects queued work, drains the active operation, then releases the
process lock. A process must call `close()` before another process opens the same
root. Readers exposed by this API see only post-publication commits.

## Bounds and failures

All limits are configurable at open and fail with typed `LedgerLimitError`
(`code: limit_exceeded`) before publication: encoded record (256 KiB), artifact
(16 MiB), records per append (32), query records (1,000), query bytes (4 MiB),
total storage (512 MiB), in-memory index (100,000), pending writes (128),
projection rebuild batch (256), migration batch (256), and snapshot/export or
backup data (64 MiB). Cache capacity is also reserved as an explicit 4,096-entry
limit; v1 intentionally uses no unbounded cache.

## Artifacts, snapshots, projections, and migration

`writeArtifact(bytes, metadata)` uses SHA-256 content addressing and requires
identity, evidence class, coverage, provenance, and sensitivity metadata. Both
append and integrity verification re-read and verify the artifact digest, size,
and regular-file (non-symlink) boundary. Ledger events carry only those references.

`finalSnapshot()` deterministically sorts source commits and includes quarantine
names, making `partial` true whenever any quarantine exists; a snapshot cannot
silently conceal bad, omitted, rejected, failed, or rolled-back material.
`rebuildProjection()` writes a versioned immutable deterministic projection from
source records. It does not mutate source data. `migrate()` is intentionally
fail-closed for anything other than v1-to-v1: no retired data is automatically
coerced, and unsupported data remains in its last readable form. Staged files
are safely removed after interrupted work, so restart is safe.

`verifyIntegrity()` returns actionable per-event findings and quarantine state.
`backup()` and `exportLedger()` are bounded immutable snapshots, including all
terminal evolution outcomes and quarantine inventory. Restore means opening a
copy of a verified v1 root with a single writer; it does not repair deletion of
an unexported tail, recover unknown future formats, or confer authority on old
records.

## Ownership boundary

This module persists classified episode/evolution material only. It creates no
lifecycle authority (AIDEV-130), conversations/annotations/cost contracts,
connected-authority adapters or receipts, promotion, delivery, UI, or automatic
migration from M0 packages. Ticket Episode v1 remains the canonical identity,
ordering, evidence, state, and trust validator.
