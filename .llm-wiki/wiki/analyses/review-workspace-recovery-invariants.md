---
type: analysis
title: Review workspace recovery invariants
status: reviewed
category: devops
created: 2026-08-21
updated: 2026-08-25
confidence: high
slug: review-workspace-recovery-invariants
---

# Review workspace recovery invariants

A review-workspace cleanup state machine must keep its abstract lease identity discoverable across every rename, or provide a recovery scan that validates both the old and new paths by immutable identity. A process interruption after rename but before state persistence must not strand retained content or make later authorized cleanup ambiguous.

Provisioning binds the review profile to a trusted immutable base rather than candidate bytes. Reviewer identity comes from the review contract and isolated context, not mutable global Git identity.

Public documentation should describe these invariants without publishing concrete lease tokens, lease or run identifiers, owner identities, retention values, machine paths, or workspace evidence.
