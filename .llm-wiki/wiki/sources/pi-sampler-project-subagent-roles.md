---
type: source
title: Project-local pi-sampler subagent roles
status: insight
category: devops
created: 2026-08-10
updated: 2026-08-10
slug: pi-sampler-project-subagent-roles
---

# Project-local pi-sampler subagent roles

[[pi-sampler]] now tracks three custom Pi subagents in `.pi/agents/`: `extension-engineer` is the sole writer for extension/package/test changes; `governance-auditor` is a read-only reviewer for optional governance and consumer-policy boundaries; and `release-verifier` is a read-only reviewer for npm workspaces, Changesets, manifests, and release readiness. `.gitignore` deliberately ignores other `.pi` local state while allowing `.pi/agents/**/*.md` to be versioned.

*Category: devops*

---
*Captured: 2026-08-10*

## Related

_Add links to related pages._
