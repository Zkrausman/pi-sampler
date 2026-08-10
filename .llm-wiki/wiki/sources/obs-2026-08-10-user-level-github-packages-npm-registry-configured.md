---
type: source
title: "Observation: User-level GitHub Packages npm registry configured"
tags:
  - npm
  - github-packages
  - pi
  - configuration
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-user-level-github-packages-npm-registry-configured
relevance: medium
observed_at: 2026-08-10T04:17:59.805Z
source_context: Fixing Pi private package installation
---

# 🔍 Observation: User-level GitHub Packages npm registry configured

Created `C:\Users\zkrau\.npmrc` with the `@zkrausman` scope mapped to `https://npm.pkg.github.com` and token expansion from `${GITHUB_PACKAGES_TOKEN}`. `npm config get @zkrausman:registry` verifies the user-level configuration. A newly launched terminal/Pi process is still required to inherit the newly-set token environment variable.

*Relevance: medium*
*Context: Fixing Pi private package installation*
*Tags: npm github-packages pi configuration*

---
*Observed: 2026-08-10T04:17:59.805Z*
