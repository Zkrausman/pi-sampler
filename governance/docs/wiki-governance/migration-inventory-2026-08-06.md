# Local vault migration inventory

This inventory is aggregate-only: it classifies every governed local artifact without reading, copying, or listing its content or path.

| Classification | Artifact count | Migration action |
| --- | ---: | --- |
| `canonical_versioned` | 120 | Review for redaction, then share through Git. |
| `external_immutable_evidence` | 11 | Keep outside Git; record only immutable ID/digest reference after an approved store is available. |
| `generated_local` | 8 | Regenerate locally; do not commit. |
| `sensitive_never_commit` | 1839 | Do not share or commit; rotate/escalate if exposure is suspected. |

No raw evidence, credentials, session state, tool output, or individual source-packet paths are present in this report.
