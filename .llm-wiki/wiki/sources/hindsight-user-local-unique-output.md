---
type: source
title: Hindsight user-local unique report output
status: insight
category: architecture
created: 2026-08-12
updated: 2026-08-12
slug: hindsight-user-local-unique-output
---

# Hindsight user-local unique report output

Default `/hindsight-document` outputs should not use the active project directory or depend on `.gitignore`, because the extension can be installed outside the source repository. AIDEV-62 implements platform-native per-user report directories, timestamps plus pseudonymous session labels and UUIDs for unique filenames, and atomic no-overwrite semantics for explicit destinations. The output logic is isolated in `extensions/conversation-catalog/src/hindsight-output.mjs` with cross-platform unit tests. Related: [[sources/obs-2026-08-12-user-local-hindsight-report-output-pr-opened]].

*Category: architecture*

---
*Captured: 2026-08-12*

## Related

_Add links to related pages._
