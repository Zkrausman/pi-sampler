---
type: source
title: "Observation: Gelt Pi package install lacks GitHub Packages configuration"
tags:
  - npm
  - pi
  - github-packages
  - Gelt
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-gelt-pi-package-install-lacks-github-packages-configuration
relevance: high
observed_at: 2026-08-10T04:14:55.320Z
source_context: Diagnosing Pi startup package-install error
---

# ⭐ Observation: Gelt Pi package install lacks GitHub Packages configuration

Gelt `.pi/settings.json` declares `npm:@zkrausman/pi-output-optimizer`, but Pi invokes npm with `--prefix E:\repos\Gelt\.pi\npm`, so the repository-root `E:\repos\Gelt\.npmrc` scope mapping is not applied. User-level npm configuration lacks the `@zkrausman` GitHub Packages registry mapping, and `GITHUB_PACKAGES_TOKEN` is unset in the current, user, and machine environments. npm therefore queries registry.npmjs.org and returns E404; correctly routing to GitHub Packages would currently return E401 until a read token is supplied.

*Relevance: high*
*Context: Diagnosing Pi startup package-install error*
*Tags: npm pi github-packages Gelt*

---
*Observed: 2026-08-10T04:14:55.320Z*
