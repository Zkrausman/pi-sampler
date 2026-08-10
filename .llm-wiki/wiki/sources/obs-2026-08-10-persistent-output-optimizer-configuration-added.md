---
type: source
title: "Observation: Persistent output optimizer configuration added"
tags:
  - extensions
  - output-optimizer
  - configuration
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-persistent-output-optimizer-configuration-added
relevance: high
observed_at: 2026-08-10T02:29:30.690Z
source_context: Adding persistent output optimizer configuration
---

# ⭐ Observation: Persistent output optimizer configuration added

Added trusted-project configuration at .pi/output-optimizer.json. It permits only bounded threshold changes, enable/disable, count-only telemetry, and explicit custom-tool names. Secret redaction and trusted-project transformation remain non-configurable. A custom tool additionally needs details.outputOptimizerEligible: true. Tests cover loading, validation, safety constraints, and custom-tool opt-in.

*Relevance: high*
*Context: Adding persistent output optimizer configuration*
*Tags: extensions output-optimizer configuration*

---
*Observed: 2026-08-10T02:29:30.690Z*
