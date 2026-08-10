---
type: source
title: "Observation: Hindsight prompt and patched answer package installed"
tags:
  - pi
  - prompt
  - hindsight
  - pi-answer
  - installation
  - audit
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-hindsight-prompt-and-patched-answer-package-installed
relevance: high
observed_at: 2026-08-10T06:32:50.233Z
source_context: Implemented native export/hindsight prompt/questions UI workflow
---

# ⭐ Observation: Hindsight prompt and patched answer package installed

Created project-local prompt template E:\repos\pi-sampler\.pi\prompts\hindsight-html.md. It expands as /hindsight-html [report-path], directs the agent to inspect PI_SESSION_FILE when available, redact sensitive data, and write a static evidence-backed HTML report without changing the repository. Audited pi-answer@0.1.9 and found its published dependency uses unsupported npm spec workspace:^, so direct installation fails. Installed a project-local patched copy at .pi/local-packages/pi-answer with only @siddr/pi-shared-qna pinned to 0.1.7; registered it in .pi/settings.json. Pi's own extension loader successfully loaded it and found the /answer command. Run /reload before use.

*Relevance: high*
*Context: Implemented native export/hindsight prompt/questions UI workflow*
*Tags: pi prompt hindsight pi-answer installation audit*

---
*Observed: 2026-08-10T06:32:50.233Z*
