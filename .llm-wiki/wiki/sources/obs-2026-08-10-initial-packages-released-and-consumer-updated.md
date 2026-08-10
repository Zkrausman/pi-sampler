---
type: source
title: "Observation: Initial packages released and consumer updated"
tags:
  - release
  - github-packages
  - consumer-integration
status: observation
created: 2026-08-10
updated: 2026-08-10
slug: obs-2026-08-10-initial-packages-released-and-consumer-updated
relevance: high
observed_at: 2026-08-10T02:49:02.609Z
source_context: Publishing initial extension packages and updating consumer PR
---

# ⭐ Observation: Initial packages released and consumer updated

Published @zkrausman/pi-output-optimizer, @zkrausman/pi-delivery-controller, and @zkrausman/pi-wiki-delivery version 0.1.0 to private GitHub Packages using the Release Pi packages workflow. Updated Gelt PR #377 to use unpinned npm:@zkrausman/pi-output-optimizer so Pi can surface update notices, with a project .npmrc that reads GITHUB_PACKAGES_TOKEN. The GitHub CLI OAuth token lacked read:packages, so npm installation was not verified locally; consumers require a token with that scope.

*Relevance: high*
*Context: Publishing initial extension packages and updating consumer PR*
*Tags: release github-packages consumer-integration*

---
*Observed: 2026-08-10T02:49:02.609Z*
