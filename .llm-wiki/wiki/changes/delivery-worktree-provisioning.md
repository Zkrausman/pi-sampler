---
type: change
title: Delivery worktree provisioning hardening
status: merged
timestamp: 2026-08-20T14:20:00Z
created: 2026-08-20
updated: 2026-08-20
confidence: high
---

# Delivery worktree provisioning hardening

Three merged pull requests established the automatic delivery-worktree lifecycle:

- PR #142 added unique leased worktrees, immutable explicit bases, collision handling, and fail-closed rollback and cleanup.
- PR #143 corrected linked-checkout behavior so profile and checkout `HEAD` validation use the invoking checkout while repository-wide refs and leases use the common repository.
- PR #144 introduced mandatory `plan` and `implement` purposes, separated their roots and identities, migrated the planning and delivery skills, and blocked implementation when the approved plan is absent from the selected base.

The changes replaced manual setup assumptions with repository-owned infrastructure. Regression coverage includes stale primary checkouts, legacy leases, collision rollback, unsafe cleanup, and symlink or junction boundaries.

A stopped four-model AIDEV-133 rerun demonstrated the remaining boundary: policy cannot guarantee that independent models invoke the provisioner. Coordinated experiments still require an external launcher that provisions every worker at one pinned commit, verifies distinct leases and identities, and starts sessions inside those worktrees.

See the accepted [automatic delivery worktree lifecycle decision](/decisions/automatic-delivery-worktree-lifecycle.md), the [changes index](/changes/index.md), and the approved [AIDEV-133 implementation plan](../../../docs/techPlans/AIDEV-133-implementation-plan.md).
