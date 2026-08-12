---
type: source
title: Hindsight draft design renderer contract
status: insight
category: design
created: 2026-08-12
updated: 2026-08-12
slug: hindsight-draft-design-as-renderer-contract
---

# Hindsight draft design renderer contract

The approved hindsight HTML draft should be treated as the canonical visual and information-architecture contract, while the runtime renderer retains only the minimal single-session product scope. The implemented renderer in `extensions/conversation-catalog/src/evidence.mjs` mirrors the draft’s sticky Tokyo-Night sidebar, editorial headline/verdict, metric grid, action cards, timeline, lessons, and collapsed appendix without reintroducing scripts, visualizations, or retired lifecycle features. Tests in `tests/conversation-synthesis.test.mjs` assert the design markers and safety constraints. Related: [[sources/obs-2026-08-11-hindsight-report-draft-styling-implemented]].

*Category: design*

---
*Captured: 2026-08-12*

## Related

_Add links to related pages._
