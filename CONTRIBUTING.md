# Contributing to pi-sampler

Thanks for improving pi-sampler. By submitting a pull request, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

## Before opening a pull request

- Keep changes focused and explain the user-facing behavior they change.
- Never commit credentials, session archives, generated delivery evidence, or consumer-owned configuration.
- Add or update tests for behavior changes.
- Update documentation when installation, configuration, or commands change.
- M0 has no publishable extension packages. Do not introduce a package, Changeset, compatibility layer, or package release without an approved later-milestone contract and release policy.
- If a future publishable-package change intentionally needs no release, add a changed file at `.changeset/exemptions/<descriptive-name>.json` with exactly a non-empty `reason` and the affected `packages`, for example:

  ```json
  {
    "packages": ["@zkrausman/pi-example"],
    "reason": "This correction changes development-only guidance and does not affect the published package."
  }
  ```

  The CI validator accepts an exemption only when that exemption file is added or modified in the same PR, so an older exemption cannot cover later package work.

## Adversarial review evidence for AIDEV ticket branches

AIDEV ticket branches use this strict convention: `zkrausman/aidev-<positive-ticket-number>-<lowercase-kebab-description>` (for example, `zkrausman/aidev-109-make-adversarial-review-gate-solo-maintainer-compatible`). A pull request whose head branch matches that exact convention requires the final-review gate before merge. Branches that do not match it do not require an attestation; a near match such as `zkrausman/AIDEV-109-example` is intentionally not a ticket branch.

Terra keeps the early review and remediation continuity, then launches exactly one fresh-context final child after the complete candidate is provisionally clean. The child receives only the exact final v3 packet, acceptance matrix, verification evidence, and versioned read-only profile. A blocker/high result revokes the clean state immediately. Luna fixes and pushes; Terra freezes a complete input set for the new head and resumes the same child for no more than two corrections. A third correction, child loss, timeout, provider failure, malformed receipt, or changed binding blocks. A replacement child requires explicit user authorization and a new local receipt lineage.

The reviewer and Terra keep reports, prompts, sessions, credentials, receipts, findings, and generated review material local. Publish only one minimal marker; it contains no identity, sessions, runs, transcript, finding text, paths, usage, latency, cost, or credentials. Model/profile values are bounded maintainer-attested caller claims, not cryptographic proof that a model ran. The marker is review evidence only; the user remains the merge authority.

```html
<!-- pi-sampler-adversarial-review-attestation:v3 {"format":"pi-sampler.adversarial-review-attestation","version":3,"base":"<exact-lowercase-40-or-64-character-base-sha>","head":"<exact-lowercase-40-or-64-character-head-sha>","outcome":"clean","packetSha256":"<v3-packet-sha256>","acceptanceMatrixSha256":"<acceptance-matrix-sha256>","verificationEvidenceSha256":"<verification-evidence-sha256>","reviewerModelId":"<bounded-model-id>","reviewProfileVersion":"<bounded-profile-version>","receiptSha256":"<opaque-local-receipt-sha256>"} -->
```

Render the marker only from a current clean local receipt after validating all
three complete inputs:

```sh
node scripts/final-review-receipt.mjs --receipt <local-receipt.json> --base <exact-base-sha> --head <exact-head-sha> --packet <packet-v3.json> --acceptance-matrix <matrix.json> --verification-evidence <verification.json> --emit-marker
```

The trusted `pull_request_target` job checks out and executes only the immutable PR base-branch validator, fetches the PR head as Git objects without checking it out, regenerates the v3 packet, and validates the minimal marker. CI can validate public digests and exact commit binding but cannot inspect the opaque local receipt or prove the claimed model execution. It fails for missing, malformed, multiple, stale, mismatched, downgraded, non-clean, or sensitive markers. The v2 marker remains frozen historical packet-consistency evidence and cannot satisfy the v3 final-review gate.

**Bootstrap boundary:** the validator selects activation only by inspecting the exact trusted base's validator bytes; candidate workflow flags, environment variables, and CLI claims cannot select the rule. When that base does not contain the v3 activation declaration, the bootstrap PR uses only the trusted-base legacy behavior: no v3 receipt/marker is required, a v2 marker remains historical evidence, and a candidate-supplied v3 marker is rejected. Once v3 is present on the trusted base, every AIDEV ticket PR requires one exact, current v3 final-review marker; missing, malformed, stale, mismatched, downgraded, or sensitive evidence fails closed. A PR that first adds or changes this trusted validator/workflow therefore cannot enforce its own new v3 gate; activation begins only for later PRs whose trusted base contains the declaration.

## Contribution provenance and DCO

Every pull-request commit must carry a Developer Certificate of Origin (DCO)
1.1 sign-off. By signing off, a contributor attests that they have the right to
submit the contribution under the repository's Apache-2.0 license. Use Git to
add the trailer:

```powershell
git commit --signoff -m "Describe the change"
```

The required trailer has this form and must contain the contributor's own name
and email address:

```text
Signed-off-by: Name <email@example.com>
```

The pull-request CI validates every commit introduced by the pull request. To
correct an existing unsigned commit, amend it with `git commit --amend
--signoff` and update the branch according to the repository's contribution
process. Do not sign off on work you are not authorized to contribute.

## Project wiki changes

The public project wiki uses company mode. Version `.llm-wiki/config.json`, `.llm-wiki/WIKI_SCHEMA.md`, templates, and redacted Markdown under `.llm-wiki/wiki/`. Keep `.llm-wiki/raw/`, `.llm-wiki/meta/`, outputs, discoveries, logs, credentials, sessions, and unredacted tool output local.

Before every handoff, run `git status --short -- .llm-wiki`. Include durable wiki pages directly related to the current change in that pull request. Put durable but unrelated knowledge in a focused `docs(wiki): ...` pull request. Do not publish transient observations or personal working memory: move personal knowledge to the personal vault, and scrub credentials, lease tokens, personal identifiers, absolute machine paths, raw prompts, transcripts, and tool output from anything staged for this public repository.

Run `npm test` and inspect the staged wiki diff; the root policy test verifies that runtime and sensitive wiki paths remain ignored. When changing the nested governance collaboration fixture itself, also validate it from `governance/` with `go run ./cmd/wiki-governance validate -repo-root .`. Generated metadata may be rebuilt locally but must not be committed.

## Local checks

```powershell
npm ci
npm test
npm run build
npm run validate:compliance
npm run validate:adversarial-review # requires the PR base/head/branch/body environment values
cd governance; go test -race ./...
```

See [the release status](docs/RELEASING.md) before proposing a future package or publication.

## Pull requests

Pull requests should describe the problem, approach, validation performed, and any compatibility or release impact. Keep generated or local-only files out of the change. Generated package compliance artifacts (`THIRD-PARTY-NOTICES.md` and `sbom.cdx.json`) are permitted only for a future approved package; M0 has none.

Report security issues through the process in [SECURITY.md](SECURITY.md), not through public issues or pull requests.
