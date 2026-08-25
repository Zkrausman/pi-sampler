---
type: analysis
title: Input-only final-review discovery
status: reviewed
category: review-governance
created: 2026-08-24
updated: 2026-08-25
confidence: high
slug: input-only-final-review-discovery
---

# Input-only final-review discovery

Project-agent discovery is rooted at the launch directory. An input-only final-review directory must therefore include the exact trusted project profile bytes needed to discover this repository's `scoped-reviewer`, alongside only the frozen packet, acceptance matrix, and verification evidence.

Preflight verifies that the profile bytes are identical at the trusted base and candidate head before launch. The input directory excludes source checkouts, Git metadata, credentials, prompts, transcripts, sessions, receipts, and concrete run or lineage identifiers.

`scoped-reviewer` is a pi-sampler project role, not a reusable governance default. Other repositories must supply their own trusted review profile.
