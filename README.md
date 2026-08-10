# pi-sampler

Reusable Pi extensions and AI-development delivery tooling. This repository owns
mechanisms; consuming repositories provide their own project configuration.

## Boundary

No extension may hard-code a consuming repository's ticket prefix, provider
credentials, source repository, verification commands, evidence paths, or risk
policy. Those values are explicit project-profile inputs.

See [`docs/specs/AI-TOOLING-SEPARATION.md`](docs/specs/AI-TOOLING-SEPARATION.md)
and [`profiles/project-profile.schema.json`](profiles/project-profile.schema.json).
