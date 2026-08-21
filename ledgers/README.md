# Ledgers

Ledgers provide durable, bounded persistence facades over the append-only
Episode Evolution ledger.

```mermaid
flowchart TD
  Caller["AnnotationLedger caller"] --> Contract["Annotation v1 validation"]
  Contract --> Batch["Atomic artifact + event batch"]
  Batch --> Episode["EpisodeEvolutionLedger"]
  Episode --> Fsync["fsync and writer lock"]
  Fsync --> History["Immutable revision history"]
  History --> Query["Bounded list and export"]
  History --> Recovery["Backup, restore, migration"]
  Tombstone["Explicit tombstone revision"] --> History
```

`AnnotationLedger` owns annotation identity, revision ancestry, tombstone and
query semantics. `EpisodeEvolutionLedger` owns durable publication, recovery,
content-addressed bytes, physical backup/restore, and ledger-format migration.
