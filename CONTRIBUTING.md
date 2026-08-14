# Contributing to pi-sampler

Thanks for improving pi-sampler. By submitting a pull request, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

## Before opening a pull request

- Keep changes focused and explain the user-facing behavior they change.
- Never commit credentials, session archives, generated delivery evidence, or consumer-owned configuration.
- Add or update tests for behavior changes.
- Update package documentation when installation, configuration, or commands change.
- Add a Changeset for every tracked source, package, or documentation change to a publishable extension. Repository-only maintenance is automatically exempt; PR titles and labels are not release-policy inputs.
- If a publishable-package change intentionally needs no release, add a changed file at `.changeset/exemptions/<descriptive-name>.json` with exactly a non-empty `reason` and the affected `packages`, for example:

  ```json
  {
    "packages": ["@zkrausman/pi-example"],
    "reason": "This correction changes development-only guidance and does not affect the published package."
  }
  ```

  The CI validator accepts an exemption only when that exemption file is added or modified in the same PR, so an older exemption cannot cover later package work.

## Adversarial review evidence for AIDEV ticket branches

AIDEV ticket branches use this strict convention: `zkrausman/aidev-<positive-ticket-number>-<lowercase-kebab-description>` (for example, `zkrausman/aidev-108-enforce-adversarial-review-evidence`). A pull request whose head branch matches that exact convention requires an independent adversarial review in a fresh context before merge. Branches that do not match it do not require an attestation; a near match such as `zkrausman/AIDEV-108-example` is intentionally not a ticket branch.

The reviewer keeps their report, prompts, sessions, credentials, and any generated review material local. Review the deterministic commit-only packet for the exact PR base and head, resolve every blocker or high finding, then add **one** single-line marker to the PR body. The marker is metadata only; do not include review text, session identifiers, personal identifiers, reviewer identities, or credentials. The independent reviewer must also submit a GitHub `APPROVED` review on that exact PR head commit; CI obtains the reviewer login privately from GitHub's review API and rejects an approval by the PR author.

```html
<!-- pi-sampler-adversarial-review-attestation:v2 {"format":"pi-sampler.adversarial-review-attestation","version":2,"base":"<exact-lowercase-40-or-64-character-base-sha>","head":"<exact-lowercase-40-or-64-character-head-sha>","outcome":"clean","packetSha256":"<lowercase-sha256-of-the-commit-only-packet>"} -->
```

`outcome` must be exactly `clean`, which attests that no blocker or high finding remains unresolved. CI evaluates only each login's latest GitHub review state: a later comment, change request, dismissal, or review on another commit invalidates that login's earlier approval. To calculate the digest locally, use the same immutable commits that will be in the PR (for example `base=$(git rev-parse origin/main)` and `head=$(git rev-parse HEAD)`), then run:

```sh
node --input-type=module -e "import { generateReviewPacket, reviewPacketSha256 } from './scripts/generate-review-packet.mjs'; const [base, head] = process.argv.slice(1); console.log(reviewPacketSha256(await generateReviewPacket({ base, head })));" "$base" "$head"
```

Before opening or updating the PR, replace the placeholders in the marker with those exact SHAs and digest. The complete check runs in GitHub Actions because it securely retrieves the PR author and review metadata; do not copy reviewer identities or review JSON into the PR body.

The required **Adversarial review evidence** CI job reads the PR body as a bounded environment value, fetches paginated review metadata using read-only pull-request permission into the runner temporary directory, never executes or logs either input, regenerates the packet from the checked-out base/head commits, and fails for missing, malformed, multiple, stale, mismatched, self-authored, or no-longer-effective approval evidence. CI verifies the exact commit-bound marker and GitHub review relationship; maintainers must still ensure the reviewer used fresh context before merge.

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

## Local checks

```powershell
npm ci
npm test
npm run build
npm run validate:compliance
npm run validate:adversarial-review # requires the PR base/head/branch/body environment values
cd governance; go test -race ./...
```

Each extension is independently versioned. See [the release guide](docs/RELEASING.md) before changing package versions or publishing.

## Pull requests

Pull requests should describe the problem, approach, validation performed, and any compatibility or release impact. Keep generated or local-only files out of the change. Generated package compliance artifacts (`THIRD-PARTY-NOTICES.md` and `sbom.cdx.json`) are the exception: regenerate and commit them whenever a supported package version or dependency declaration changes.

Report security issues through the process in [SECURITY.md](SECURITY.md), not through public issues or pull requests.
