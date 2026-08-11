---
type: source
title: "Observation: Three pi-sampler project subagents added"
tags:
  - pi-subagents
  - agents
  - configuration
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-three-pi-sampler-project-subagents-added
relevance: high
observed_at: 2026-08-10T04:12:19.152Z
source_context: Adding recommended custom subagents to pi-sampler
---

# ⭐ Observation: Three pi-sampler project subagents added

Added tracked project-local definitions under `.pi/agents/`: `extension-engineer` (single-writer extension/package/test work), `governance-auditor` (read-only governance and boundary review), and `release-verifier` (read-only npm workspace/Changesets/release review). Updated `.gitignore` to continue ignoring project-local `.pi` state while tracking only `.pi/agents/**/*.md`. `subagent({ action: "list" })` confirmed all three discover as project agents.

*Relevance: high*
*Context: Adding recommended custom subagents to pi-sampler*
*Tags: pi-subagents agents configuration*

---
*Observed: 2026-08-10T04:12:19.152Z*
