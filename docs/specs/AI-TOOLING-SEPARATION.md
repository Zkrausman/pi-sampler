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
- `extensions/delivery-controller/` contains portable dispatch, ledger,
  redaction, and review mechanisms.
- `governance/` holds deterministic, offline governance validators.
- `profiles/` holds schemas and examples. A profile is required for all
  repository-specific behavior.

## Non-goals

- Automatic project discovery, ticket selection, merge authorization, or status
  changes.
- Shipping consumer secrets, transcripts, source packets, or local Pi state.

## Completion criteria

1. Legacy consumer-specific Pi extension sources no longer live with a
   consumer's product code.
2. Generic source contains no consuming repository default, ticket prefix,
   environment-variable prefix, domain-specific verification, or binary name.
3. A profile supplies verification commands, paths, identifiers, and required
   checks.
4. Tests cover generic defaults and a generic example profile.
