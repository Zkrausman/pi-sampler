---
type: source
title: "Observation: Pith Pi hook delegates all results and tracks harness savings"
tags:
  - Pith
  - Pi
  - hook
  - telemetry
  - token-savings
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-pith-pi-hook-delegates-all-results-and-tracks-harness-saving
relevance: high
observed_at: 2026-08-10T04:47:46.032Z
source_context: Removing arbitrary Pi hook threshold and matching Antigravity-style Pith integration
---

# ⭐ Observation: Pith Pi hook delegates all results and tracks harness savings

Corrected the Pith Pi hook in `E:\repos\Pith-pi-hook`: removed the hook-level 8 KB threshold and the core `OptimizeHook` threshold guard, stopped skipping `event.isError`, and changed the installed global hook to submit every completed trusted bash result to Pith with `telemetryEnabled: true`. Pith handles parsing/passthrough itself and records aggregate token estimates under harness `pi`; no command or raw output is retained for Pi telemetry. Added focused tests, ran `go test ./...` successfully, regenerated `C:\Users\zkrau\.pi\agent\extensions\pith\index.ts`, and verified a small `git status` is parsed plus `pith gain --by-harness` shows Pi savings. Current Pi session still needs `/reload` to load regenerated extension.

*Relevance: high*
*Context: Removing arbitrary Pi hook threshold and matching Antigravity-style Pith integration*
*Tags: Pith Pi hook telemetry token-savings*

---
*Observed: 2026-08-10T04:47:46.032Z*
