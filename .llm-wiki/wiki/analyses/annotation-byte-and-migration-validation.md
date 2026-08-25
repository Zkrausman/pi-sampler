---
type: analysis
title: Annotation byte and migration validation
status: reviewed
category: validation
created: 2026-08-21
updated: 2026-08-25
confidence: high
slug: annotation-byte-and-migration-validation
---

# Annotation byte and migration validation

Character-count JSON Schema limits do not enforce UTF-8 byte limits. Annotation validation therefore applies explicit byte checks to bounded text fields such as `content`, `rationale`, and `tombstoneReason`, in addition to structural schema validation.

Versioned migration dispatch also fails closed: it accepts only explicitly supported source and target versions. A request targeting the current version is not automatically valid when its source version is unknown.

The reusable rule is to treat schema shape, encoded byte bounds, and migration-version admission as separate validation layers. Each layer needs independent negative coverage.
