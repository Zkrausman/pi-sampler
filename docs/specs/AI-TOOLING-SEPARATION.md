---
type: specification
title: Generic Pi tooling extraction
status: in-progress
---

# Generic Pi tooling extraction

## Goal

Provide reusable Pi extensions and delivery mechanisms without embedding any
consumer repository's domain, ticket system, source location, validation
commands, environment variable names, or evidence layout.

## Architecture

- `extensions/` contains Pi-facing integrations.
- `packages/delivery-core/` contains portable state, redaction, and worktree
  review mechanisms.
- `packages/governance/` holds deterministic, offline governance validators.
- `profiles/` holds schemas and examples. A profile is required for all
  repository-specific behavior.

## Non-goals

- Automatic project discovery, ticket selection, merge authorization, or status
  changes.
- Shipping consumer secrets, transcripts, source packets, or local Pi state.

## Completion criteria

1. Existing Gelt Pi extension sources no longer live in Gelt.
2. Generic source contains no Gelt repository default, ticket prefix,
   environment-variable prefix, broker-specific verification, or binary name.
3. A profile supplies verification commands, paths, identifiers, and required
   checks.
4. Tests cover generic defaults and a non-Gelt profile.
