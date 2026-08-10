---
type: source
title: "Observation: Output optimizer package withdrawn from GitHub Packages"
tags:
  - Pith
  - npm
  - GitHub-Packages
  - deprecation
  - cleanup
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-output-optimizer-package-withdrawn-from-github-packages
relevance: high
observed_at: 2026-08-10T04:27:27.460Z
source_context: Withdrawing unused output optimizer package
---

# ⭐ Observation: Output optimizer package withdrawn from GitHub Packages

After user confirmed there were no consumers, deleted the only GitHub Packages version of `@zkrausman/pi-output-optimizer` (0.1.0, package-version id 1115126026) through the GitHub REST API. The npm CLI unpublish endpoint is disabled by GitHub Packages; the DELETE succeeded despite PowerShell returning an empty-response handling error, and a subsequent API read verified the package is absent with 404. Updated pi-sampler README, release guide, and historical optimizer README to say it was withdrawn and direct users to Pith. `npm test` passed (20 tests).

*Relevance: high*
*Context: Withdrawing unused output optimizer package*
*Tags: Pith npm GitHub-Packages deprecation cleanup*

---
*Observed: 2026-08-10T04:27:27.460Z*
