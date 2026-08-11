---
type: source
title: "Observation: pi-sampler subagent definitions kept local"
tags:
  - pi-subagents
  - gitignore
  - configuration
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-pi-sampler-subagent-definitions-kept-local
relevance: medium
observed_at: 2026-08-10T04:13:23.734Z
source_context: Correcting tracking decision for project-local subagents
---

# 🔍 Observation: pi-sampler subagent definitions kept local

Restored pi-sampler's existing `/.pi/` gitignore policy after recognizing it intentionally excludes Pi project configuration from version control. The three custom agent definitions remain available locally at `.pi/agents/` but are not tracked or intended for commit unless the repository explicitly adopts shared agent policy later.

*Relevance: medium*
*Context: Correcting tracking decision for project-local subagents*
*Tags: pi-subagents gitignore configuration*

---
*Observed: 2026-08-10T04:13:23.734Z*
