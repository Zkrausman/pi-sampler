# Contracts

The contracts package contains bounded, versioned data contracts. TypeBox
values are the canonical structural source; the executable validators enforce
cross-field and provenance rules that JSON Schema cannot express.

```mermaid
flowchart TD
  Annotation["Annotation v1 payload"] --> Schema["AnnotationV1Schema"]
  Schema --> Export["annotation-v1.schema.json"]
  Annotation --> Validator["validateAnnotationV1"]
  Validator --> Human["human_annotation only"]
  Validator --> Digest["content digest and revision ancestry"]
  Ticket["Ticket Episode v1"] --> Ledger["EpisodeEvolutionLedger"]
  Annotation --> Ledger
```

Annotation v1 deliberately has `evidenceClass: human_annotation` as a
structural literal. An annotation can cite and describe an external event, but
no annotation contract path can create `observed_evidence`.
