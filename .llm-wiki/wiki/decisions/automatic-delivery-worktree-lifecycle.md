---
type: decision
title: Automatic delivery worktree lifecycle
status: accepted
timestamp: 2026-08-20T14:20:00Z
created: 2026-08-20
updated: 2026-08-20
confidence: high
---

# Automatic delivery worktree lifecycle

## Context

AIDEV-133 experiments exposed that prose-only worktree rules were insufficient. Agents reused stale ticket worktrees, recreated static paths, or handcrafted leases, causing work to start from different commits and occasionally validate against a stale primary checkout.

## Decision

Planning and implementation use the repository-owned delivery worktree provisioner rather than ad hoc `git worktree` commands.

- Resolve the configured base to an immutable commit before provisioning.
- Give every branch and worktree a unique six-character lowercase hexadecimal suffix.
- Separate planning and implementation under purpose-specific namespaces and leases.
- Require the approved plan to exist on the selected base before implementation starts.
- Validate profile content and `HEAD` through the invoking checkout while managing shared refs, leases, rollback, and cleanup through the common repository.
- Fail closed when ownership, cleanliness, base identity, or cleanup safety cannot be proven.

## Consequences

Parallel workers can share a pinned base commit without sharing mutable checkout state. Minimal prompts remain possible because infrastructure owns provisioning details. A separate experiment coordinator is still needed when several models must be pre-provisioned and launched together; purpose-scoped provisioning alone cannot prevent a model from bypassing the helper.

The delivered implementation is summarized in [delivery worktree provisioning](/changes/delivery-worktree-provisioning.md). See the [decision index](/decisions/index.md) and [project changes](/changes/index.md) for related project history.
