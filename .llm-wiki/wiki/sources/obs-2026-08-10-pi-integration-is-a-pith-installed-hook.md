---
type: source
title: "Observation: Pi integration is a Pith-installed hook"
tags:
  - pith
  - pi
  - integration
  - architecture
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-pi-integration-is-a-pith-installed-hook
relevance: high
observed_at: 2026-08-10T03:29:34.851Z
source_context: Clarifying Pith-managed Pi integration design
---

# ⭐ Observation: Pi integration is a Pith-installed hook

Clarified the integration boundary: Pi needs only a Pith-installed extension hook on its tool_result event. The hook invokes Pith for eligible completed results and returns the transformed or unchanged result. This is equivalent to using hooks in other harnesses; “lifecycle adapter” is not a separate architecture. Pith remains the sole command-aware optimization engine.

*Relevance: high*
*Context: Clarifying Pith-managed Pi integration design*
*Tags: pith pi integration architecture*

---
*Observed: 2026-08-10T03:29:34.851Z*
