# Bounded Episode and Evolution Ledger v1

AIDEV-124 is a local durable source ledger for canonical Ticket Episode v1
records. Ticket Episode v1 remains the record contract; ledger storage format v2
adds recovery mechanics and does not import, interpret, or restore retired
extensions, receipt ledgers, lifecycle state, adapters, or authority assumptions.

## Layout and admission

The root has an immutable-by-default `manifest.json`, hashed episode partitions
in `commits/`, content-addressed `artifacts/`, durable `quarantine/`, immutable
`projections/` and `exports/`, physical `backups/`, and restart checkpoints in
`migrations/`. Caller identifiers are SHA-256 partition keys, never paths.
Commit envelopes contain the canonical record, deterministic digest, and a
per-episode previous-digest chain. Evolution envelopes require `event.kind`
`evolution` and exactly one explainable terminal outcome: `accepted`,
`rejected`, `failed`, or `rolled_back`.

Admission is a bounded global FIFO. It rescans durable commits before every
write and completes all validation (v1 schema, uniqueness, owner binding,
sequence, chronology, chain, artifact references, limits) before it changes an
in-memory index or publishes a file. A failed admission therefore cannot claim
an identifier. Publication is private-stage write, file fsync, hard-link,
directory fsync. A failure before publication is invisible. For every uncertain
result (including a post-publish fault or `EEXIST`), the writer reconciles disk
before another admission; if reconciliation cannot prove a usable state it
fails closed and requires reopening.

## Locking, recovery, and isolation

`.writer.lock` contains a PID and random ownership token, is fsynced with its
parent directory, and only its token owner may release it. A live PID excludes
another writer; a dead PID left by process crash is removed atomically enough to
retry acquisition. Failed opens release a lock they acquired. `close()` rejects
new queue entries, drains submitted work, and releases its own lock.

Opening and integrity checking inspect physical storage, not just an in-memory
index. They reject symlinks and unexpected entry types; check partition/name
binding, checksums, event/global ownership, sequence/time/previous chains and
artifact regular-file/size/digest boundaries. Bad files, unsafe entries, and
unreadable partitions are moved or diagnosed in fsynced quarantine without
preventing independent partitions from loading. Quarantine inventory makes a
snapshot and integrity result partial/failed rather than silently omitting
material. As with any local filesystem ledger, deletion of an entire latest
chain tail cannot be distinguished from a prior state without retaining an
external immutable backup anchor.

## Bounds and streamed work

All configured positive integer limits fail with `LedgerLimitError` before
publication: encoded record, artifact, storage, index, pending writes, query
records/bytes, projection and migration batches, and export/backup bytes.
Directory walks use `opendir` with a bounded entry count. Query copies only
returned records. Projection work hits a real batch boundary; snapshot/export
build incrementally and stop at their byte limit rather than first serializing
an unlimited result. The index itself is bounded by `maxIndexEntries`.

## Backup, restore, and migration

`exportLedger()` is a bounded logical deterministic snapshot. `backup()` is
separate: it creates a bounded physical archive under `backups/<anchor>/` with
an archive manifest, original ledger manifest, commit files, artifact bytes,
and quarantine diagnostics/material. Every archived file has a size and SHA-256
anchor. `EpisodeEvolutionLedger.restore({ backupPath, root })` verifies those
anchors, requires an empty target, recreates the physical root, then opens it;
restored terminal outcomes and artifact references remain queryable and
verifiable.

Version-1 storage roots remain readable. A v1 root stores format-1 envelopes
under `commits/`; `migrate({ fromVersion: 1 })` materializes format-2 envelopes
under `commits-v2/`, each binding its `sourceDigest` and a rewritten v2 chain.
The durable checkpoint records the source anchor, cursor, and per-batch
source/target anchors. Source files remain intact until the complete target has
been read, artifact-verified, chain-verified, and source-bound; only then does
the manifest atomically select `commits-v2/`. Restart resumes the cursor.
Replacement publication uncertainty (checkpoint or manifest) reloads the
manifest and reconciles the selected tree before another admission. A failure
before manifest publication leaves the v1 root readable; unknown/future formats
fail closed. This migration is only for this new ledger's v1 storage format,
not retired M0 data.

## Scope

The module persists classified episode/evolution material only. It creates no
lifecycle authority, conversation/cost schema, connected authority adapter,
promotion/delivery flow, cloud API, telemetry, or legacy bridge.
