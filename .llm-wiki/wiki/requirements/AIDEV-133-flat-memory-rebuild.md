---
type: requirement
title: "AIDEV-133 flat-memory rebuild evidence"
status: blocked
priority: high
issue: AIDEV-133
created: 2026-08-21
updated: 2026-08-21
confidence: high
traceability:
  - docs/techPlans/AIDEV-133-implementation-plan.md
  - docs/techPlans/AIDEV-158-implementation-plan.md
---

# AIDEV-133 flat-memory rebuild evidence

The versioned Lesson Registry must demonstrate the approved flat-memory rebuild
scale criteria with a complete local 10,000,000-event benchmark. The evidence
must include event completeness, bounded timeout, peak RSS, robust memory slope,
variance, workload identity, runtime and hardware classification, and a
separately approved threshold envelope. The smaller CI regression uses the same
measurement implementation but cannot satisfy the local scale row.

This requirement remains **blocked** until an external acceptance matrix records
the benchmark as observed or supplies a valid consumer-owned signed waiver.
The first 10M run is a baseline only and does not create thresholds or a pass
claim. Unit tests, a candidate-authored waiver, a missing verifier, or a local
repository marker cannot resolve this requirement.
