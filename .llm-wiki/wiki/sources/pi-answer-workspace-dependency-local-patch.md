---
type: source
title: Local patch for pi-answer package
status: insight
category: devops
created: 2026-08-10
updated: 2026-08-10
slug: pi-answer-workspace-dependency-local-patch
---

# Local patch for pi-answer package

`pi-answer@0.1.9` declares `@siddr/pi-shared-qna` as `workspace:^`, which makes normal npm installation fail with `EUNSUPPORTEDPROTOCOL`. For this project, a local installed copy in `.pi/local-packages/pi-answer` pins that dependency to `0.1.7`; it is then registered in `.pi/settings.json`. [[Pi]]'s own extension loader confirmed the patched package registers `/answer`. The package sends the last assistant message to a configured extraction model, stores temporary answer drafts in session entries, and is TUI-only. [[Hindsight prompt]]

*Category: devops*

---
*Captured: 2026-08-10*

## Related

_Add links to related pages._
