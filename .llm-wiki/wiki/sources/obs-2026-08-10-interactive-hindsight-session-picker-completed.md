---
type: source
title: "Observation: Interactive hindsight session picker completed"
tags:
  - pi
  - hindsight
  - session-picker
  - extension
  - tui
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-interactive-hindsight-session-picker-completed
relevance: high
observed_at: 2026-08-10T06:40:57.223Z
source_context: Making hindsight session selection interactive
---

# ⭐ Observation: Interactive hindsight session picker completed

Added .pi/extensions/hindsight-picker.ts, a project-local /hindsight command. It calls SessionManager.listAll(), presents up to 100 recent sessions in a searchable TUI selector with modified time, saved name/first prompt, project path, message count, and short ID; asks for confirmation; forks the selected session into the current project; switches to the fork; then submits /hindsight-html. Pi's own extension loader loaded it without errors and confirmed /hindsight is registered. It awaits /reload in the active TUI.

*Relevance: high*
*Context: Making hindsight session selection interactive*
*Tags: pi hindsight session-picker extension tui*

---
*Observed: 2026-08-10T06:40:57.223Z*
