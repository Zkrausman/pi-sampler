---
type: source
title: "Observation: Luna-backed hindsight session descriptions added"
tags:
  - pi
  - hindsight
  - luna
  - session
  - summaries
  - cache
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-luna-backed-hindsight-session-descriptions-added
relevance: high
observed_at: 2026-08-10T06:45:49.645Z
source_context: Adding lazy Luna descriptions to hindsight session picker
---

# ⭐ Observation: Luna-backed hindsight session descriptions added

Enhanced .pi/extensions/hindsight-picker.ts. /hindsight now includes a picker action, “Generate Luna descriptions for recent sessions,” which uses only openai-codex/gpt-5.6-luna (no fallback), batches up to 15 uncached session excerpts, parses JSON summaries, and caches one-sentence descriptions at ~/.pi/agent/hindsight-session-summaries.json keyed by session ID/path plus modified time. The picker displays cached Luna descriptions and retains a local first-prompt fallback. It sends redacted first-prompt and final-transcript excerpts, not complete logs. Pi loader validation passed; direct node --test tests/*.test.mjs passed 20 tests. npm test remains unusable in this shell because npm's Windows child process cannot resolve node.

*Relevance: high*
*Context: Adding lazy Luna descriptions to hindsight session picker*
*Tags: pi hindsight luna session summaries cache*

---
*Observed: 2026-08-10T06:45:49.645Z*
