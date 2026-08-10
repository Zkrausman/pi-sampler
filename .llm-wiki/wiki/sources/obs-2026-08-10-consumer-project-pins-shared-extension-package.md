---
type: source
title: "Observation: Consumer project pins shared extension package"
tags:
  - integration
  - output-optimizer
  - release
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-consumer-project-pins-shared-extension-package
relevance: high
observed_at: 2026-08-10T02:31:35.765Z
source_context: Publishing shared extension consumption PR
---

# ⭐ Observation: Consumer project pins shared extension package

Created Gelt pull request #377 to consume pi-sampler as a Git Pi package pinned at eb8837a and to add .pi/output-optimizer.json with safe defaults. The consumer keeps only the package manifest and policy file tracked; all other .pi runtime state remains ignored. PR verification passed go test -race ./..., go build, and git diff checks; the integrated diagnostic exited 0 but printed its existing broker pre-market [FAIL] marker.

*Relevance: high*
*Context: Publishing shared extension consumption PR*
*Tags: integration output-optimizer release*

---
*Observed: 2026-08-10T02:31:35.765Z*
