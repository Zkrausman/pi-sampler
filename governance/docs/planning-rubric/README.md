---
type: planning-rubric
title: Planning quality rubric — planning-rubric/v1
---

# Planning quality rubric — `planning-rubric/v1`

This is the single machine-readable contract shared by `.agents/skills/create-ticket` and `.agents/skills/create-epic`. Both skills must produce and validate a rubric artifact **before** Linear publication (WORK-117).

## Contract

- Schema: `docs/planning-rubric/schema-v1.json` (`$schema` draft 2020-12)
- Version: `planning-rubric/v1` (`pkg/planningrubric.SchemaVersion`)
- Authority: `pkg/planningrubric.Validate` is authoritative for path containment and cross-field invariants. The JSON Schema is a structural mirror for editors; CI and `go vet` do not substitute for `pkg/planningrubric`.
- Deterministic offline only: no `linear_get_issue`, broker, MCP, or LLM calls during validation. Validation checks written text, not live services.

### Kinds and work classes

- `kind`: `ticket` or `epic`.
- `work_class`: `project-runtime` (trading loop, risk, backtest, telemetry, broker, data) vs `development-process` (delivery, wiki/OKF, CI, controller, evaluation, experiment). Mislabeling is a rubric error.

## Quality gates (enforced by `pkg/planningrubric.Validate`)

| Gate | What it checks | Failure signal |
|------|---------------|----------------|
| Repository / source-of-truth research | `cited_paths[]` non-empty and repository-contained; `overlap_search.{queries,existing_issues_checked,docs_checked}` each non-empty; `source_of_truth_refs[]` non-empty | validator error mentioning the missing field |
| Actor authority & trust boundaries | three actors required (`controller`, `implementer`, `reviewer`) with `authority` + `trust_boundary` each; `no_self_approval: true`; `mutation_bounds` non-empty | `actor_authority … trust_boundary` / `no_self_approval must be true` |
| Async/agentic safety | when `is_async: true`, all of `state_machine`, `idempotency`, `failure_retry_cancellation`, `evidence`, `observability`, `rollback` required | `async_agentic.state_machine is required for async work` |
| Credentials & integrations | when `requires_integration: true`, `least_privilege` + `secret_redaction` + `merge_completion_policy` required; `secret_redaction` and `merge_completion_policy` required even when false | `credentials_integrations.least_privilege is required for integrations` |
| External capability spike | when `requires_external_capability: true`, `spike_ticket` required; `assumed_apis` must be empty when no capability required | `discovery_spike.spike_ticket is required …` |
| Measurable acceptance | `behavioral_tests[]`, `negative_cases[]`, `verification_commands[]` non-empty; `completion_evidence` + `non_go_verification` non-empty | `acceptance_criteria.non_go_verification must not be empty` |
| Dependency graph | `dependencies[]` (may be empty), `foundation_before_automation` + `rationale` non-empty | `dependency_graph.rationale must not be empty` |
| Planning report | `rubric_outcome` is `pass|fail`; `dependency_rationale` non-empty; `human_escalation_conditions[]` non-empty | `planning_report.human_escalation_conditions must not be empty` |

## CLI

```bash
go run ./cmd/planning-rubric-validator -manifest docs/planning-rubric/WORK-XXX-rubric.json -repo-root .
# exit 0 → planning rubric valid; non-zero → error to stderr
go test ./pkg/planningrubric -count=1
```

Validation writes `planning rubric valid` to stdout on success.

## Examples

Happy paths (each `go run … -manifest <file> -repo-root .` exits zero):

- `docs/planning-rubric/examples/rubric-ticket-go-feature.json` — conventional `project-runtime` Go ticket; synchronous; no integration; negative case + non-Go verification present.
- `docs/planning-rubric/examples/rubric-ticket-external-api.json` — external MPC/robinhood integration; `is_async: true`; spike `WORK-401-SP1`; foundation `spike → execution` dependency.
- `docs/planning-rubric/examples/rubric-epic-jules-pi-controller.json` — `development-process` epic with full async, credential, and merge-policy surface; spike `WORK-111`; controller/implementer/reviewer separation with `PROJECT_DELIVERY_KILL_SWITCH` and `jobs.ndjson` ledger.

Negative fixtures (each exits non-zero and the error is quoted in the planning report):

- `docs/planning-rubric/fixtures/invalid-missing-trust-boundary.json` — `trust_boundary` empty.
- `docs/planning-rubric/fixtures/invalid-assumed-api-without-spike.json` — `assumed_apis` non-empty while `requires_external_capability: false`.
- `docs/planning-rubric/fixtures/invalid-missing-non-go-verification.json` — `non_go_verification` empty.

## How to author a ticket/epic without inventing APIs, capabilities, or links

1. Call `linear_get_issue` for the live issue body — do not copy a stale `docs/specs/` description.
2. Record the exact `queries`, `existing_issues_checked`, and `docs_checked` in `overlap_search` — reviewers audit the strings, not intent.
3. If work touches an external surface, create a named spike ticket first (e.g. `WORK-401-SP1`) and leave `assumed_apis` empty until the spike records schemas.
4. Never synthesize a `linear.app/.../issue/WORK-XXX` URL or a test result. If no Linear connector is available, omit the URL; if no verification has run, set `rubric_outcome: fail` and do not publish.
5. Include an explicit `non_go_verification` sentence even for Go tickets (e.g. `OKF updated; no invented APIs; duplicate search documented`).

## Wiki-governance

Canonical, reviewable paths: `docs/planning-rubric/**` is allowlisted by `docs/wiki-governance/path-policy-v1.json` as `docs/wiki-governance/**` coverage already allows docs, and project canon is `.llm-wiki/wiki/**`, `docs/specs/*.md`, `evidence/delivery/*.json`. Generated `artifacts/` and `evidence/raw/` etc. remain ignored. Never commit secrets or raw packets; `pkg/wikigovernance` rejects credential-like values in canonical artifacts.

## See also

- `.agents/skills/create-ticket/SKILL.md` Phases 1–12
- `.agents/skills/create-epic/SKILL.md` Phases 1–13
- `pkg/planningrubric/rubric_test.go` — three-scenario coverage (Go feature, external API spike, Jules/Pi controller) plus negative cases
