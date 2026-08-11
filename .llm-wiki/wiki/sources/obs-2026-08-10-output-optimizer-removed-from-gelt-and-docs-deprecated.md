---
type: source
title: "Observation: Output optimizer removed from Gelt and docs deprecated"
tags:
  - Pith
  - npm
  - deprecation
  - Gelt
  - documentation
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-output-optimizer-removed-from-gelt-and-docs-deprecated
relevance: high
observed_at: 2026-08-10T04:23:42.131Z
source_context: Deprecating pi-output-optimizer in favor of Pith
---

# ⭐ Observation: Output optimizer removed from Gelt and docs deprecated

Removed `npm:@zkrausman/pi-output-optimizer` from `E:\repos\Gelt\.pi\settings.json`; Pi removed the installed package and the settings now contain an empty `packages` array. Updated pi-sampler README, release guide, and output optimizer README to direct users to `pith install --pi`; `npm test` passed (20 tests). Attempted remote `npm deprecate @zkrausman/pi-output-optimizer@0.1.0` against GitHub Packages using the configured user token, but GitHub Packages returned HTTP 400 `unmarshalling packument failed: version.ID cannot be empty`; registry deprecation was not applied.

*Relevance: high*
*Context: Deprecating pi-output-optimizer in favor of Pith*
*Tags: Pith npm deprecation Gelt documentation*

---
*Observed: 2026-08-10T04:23:42.131Z*
