---
type: analysis
title: Durable signed lesson admission
status: reviewed
category: architecture
created: 2026-08-20
updated: 2026-08-25
confidence: high
slug: durable-signed-lesson-admission
---

# Durable signed lesson admission

Lesson admission uses a manifest-bound Ed25519 authority rather than a self-issuable in-memory marker. `ledgers/episode-evolution-ledger.mjs` reserves lesson events for the dedicated admission path and validates the signed immutable-envelope binding. `ledgers/lesson-registry.mjs` re-verifies that binding during rebuild.

The private authority is persisted in a local authority file managed by `ledgers/lesson-registry-authority.mjs` and excluded from Git. This blocks a generic ledger from minting its own trusted lesson marker, but it does not protect against an actor that can read the same-user local authority file. Consumer threat models must add stronger key custody when that actor is in scope.

The authoritative contract is `docs/specs/LESSON-REGISTRY-V1.md` in the repository.
