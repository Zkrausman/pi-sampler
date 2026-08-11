---
type: source
title: "Observation: Pith hook follow-up PR opened with preexisting binary issue"
tags:
  - Pith
  - PR
  - Pi
  - hook
  - binary
  - diagnostics
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-pith-hook-follow-up-pr-opened-with-preexisting-binary-issue
relevance: high
observed_at: 2026-08-10T05:44:55.151Z
source_context: Opening Pith follow-up PR and diagnosing CLI output
---

# ⭐ Observation: Pith hook follow-up PR opened with preexisting binary issue

Opened Pith PR #4 (`https://github.com/Zkrausman/Pith/pull/4`) from commit `ecb266d`, after an independent review found and the patch fixed a failure-exit classification bug. The PR removes Pi hook thresholds, delegates all completed Bash results, preserves failures via nonzero exits, and enables aggregate Pi telemetry. During investigation of `pith stats` output, verified that the same noisy test/install output is emitted by the preexisting `pith.exe.old` and `pith.test.exe` backups as well as the temporary development binary; it predates the hook changes. Restored `pith.exe` from `pith.exe.old`; that older v0.10.0 binary lacks `gain --by-harness`.

*Relevance: high*
*Context: Opening Pith follow-up PR and diagnosing CLI output*
*Tags: Pith PR Pi hook binary diagnostics*

---
*Observed: 2026-08-10T05:44:55.151Z*
