---
type: analysis
title: Final-gate evidence ordering
status: reviewed
category: governance
created: 2026-08-25
updated: 2026-08-25
confidence: high
slug: final-gate-evidence-ordering
---

# Final-gate evidence ordering

A final-review acceptance matrix must not name an in-progress review as an already completed verifier. Freeze implementation evidence without future review claims, complete the persistent-parent review, and only then bind the completed review result in a newly frozen verification-evidence set before launching or resuming the final child.

If circular provenance is found before child launch, preserve the superseded complete input set locally, create a new complete input set, and have the same parent verify the correction. Superseded inputs, reports, receipts, prompts, and lineage details remain local evidence rather than public wiki content.

This ordering prevents the gate from proving itself with a result that did not exist when its inputs were frozen.
