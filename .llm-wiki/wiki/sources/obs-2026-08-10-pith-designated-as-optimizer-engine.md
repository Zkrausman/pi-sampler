---
type: source
title: "Observation: Pith designated as optimizer engine"
tags:
  - architecture
  - pith
  - output-optimizer
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-pith-designated-as-optimizer-engine
relevance: critical
observed_at: 2026-08-10T03:09:55.238Z
source_context: Correcting output optimizer architecture
---

# 🔴 Observation: Pith designated as optimizer engine

User clarified that Pith is their RTK clone and must be the single command-aware optimization engine. pi-sampler should provide only Pi lifecycle/configuration hooks and call a Pith machine interface; it must not maintain a duplicate JavaScript compactor. Pith's existing pkg/pi API is generic head/tail and must be upgraded to use Pith parsers. The adapter also needs aggregate-only telemetry because Pith's current telemetry records raw content, which conflicts with pi-sampler's no-raw-persistence policy.

*Relevance: critical*
*Context: Correcting output optimizer architecture*
*Tags: architecture pith output-optimizer*

---
*Observed: 2026-08-10T03:09:55.238Z*
