# Delivery evidence contracts

This directory contains two related, offline contracts:

- `delivery-evidence/v1` is the historical PR delivery manifest. Run it with
  `go run ./cmd/delivery-evidence-validator -mode delivery -manifest <path>
  -repo-root . -expected-commit <delivery-sha>`.
- `acceptance-manifest/v1`, `acceptance-matrix/v1`,
  `benchmark-evidence/v1`, and `delivery-waiver/v1` implement approved-plan
  acceptance. A manifest is the immutable list of stable plan rows. A matrix
  must cover every row exactly once as `observed`, `waived`, or `blocked`.

The acceptance validator binds the canonical implementation-plan bytes, plan
digest, repository, immutable base, candidate head, manifest digest, and pull
request identity. Canonical plan bytes normalize CRLF and lone CR line endings
to LF before hashing, so the digest is independent of checkout settings. Row
IDs are ASCII, normalized, ticket-scoped values such as `A158-T01`; Markdown
table position is never an identity. Unknown, duplicate, confusable, deleted,
or plan-digest-mismatched rows fail closed.

Observed evidence is bounded and must name its class-specific verifier, exact
command, tool version, environment class, zero exit status, timestamps, and
artifact SHA-256 digests. Benchmark rows additionally reference a complete
`benchmark-evidence/v1` artifact. The local class is exactly 10,000,000 events;
the CI regression is intentionally smaller but uses the same robust Theil-Sen
RSS-slope, variance, completeness, timeout, and environment measurements. A
baseline is measurement only. The repository benchmark runner and production
validator reject `passed` evaluations and candidate-authored thresholds; a future
pass requires a separately reviewed, protected external threshold-approval
contract before the schema or policy is widened. Both declared benchmark
commands require immutable base/head bindings; CI injects protected event SHAs,
and local execution resolves the current immutable Git range. Zero-SHA defaults
are rejected.

A waiver is not a claim. It is a signed, scoped, expiring, replay-resistant
external authorization. The operator's Ed25519 private key is consumer-owned
and must remain outside the repository, agent sessions, and subagent
environment. Trusted configuration contains only public verification keys and
revocation references. The validator requires an external trust configuration
and external single-use replay state; missing configuration, candidate-local
keys, unsigned JSON, stale/replayed/expired/revoked signatures, or wrong
repository/PR/row/plan/base/head bindings remain blocked. Repository and agent
code intentionally contains no waiver signing capability.

These validators are evidence gates, not merge authorities. They never contact
GitHub or Linear, mutate PR bodies, push or force-push branches, enable
auto-merge, merge a PR, or transition a tracker. `do not merge` remains sticky
until the user explicitly says exactly `Merge PR #N`; readiness, refresh,
rebase, push, auto-merge, and admin-merge language are separate authorities
and do not override it.

The first local 10M run records a bounded baseline only. Full benchmark output,
raw samples, environment inventory, replay state, waivers, and command output
remain local evidence artifacts unless a later reviewed policy explicitly
approves a redacted publication.
