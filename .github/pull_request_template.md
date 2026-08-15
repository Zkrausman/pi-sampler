## Summary

<!-- What changes, and why? -->

## Validation

<!-- Commands/tests run, or why validation was not applicable. -->

## Release impact

<!-- Changeset added / no package release needed / follow-up required. -->

## AIDEV adversarial review evidence

<!-- Required only when the head branch is exactly zkrausman/aidev-<positive-number>-<lowercase-kebab-description>.
     Complete a fresh-context adversarial review of the local commit-only packet, resolve blocker/high findings,
     then have the solo maintainer calculate its SHA-256 and record the attestation below. Keep review reports,
     session IDs, prompts, credentials, generated review content, and reviewer identities out of this PR body. -->

<!-- pi-sampler-adversarial-review-attestation:v2 {"format":"pi-sampler.adversarial-review-attestation","version":2,"base":"<exact-lowercase-40-or-64-character-base-sha>","head":"<exact-lowercase-40-or-64-character-head-sha>","outcome":"clean","packetSha256":"<lowercase-sha256-of-the-commit-only-packet>"} -->

<!-- CI verifies this commit-bound evidence only. A fresh-context adversarial review remains operationally required; no separate GitHub reviewer approval is required for this solo-maintainer repository. Delete this placeholder marker for non-ticket branches. -->

## Checklist

- [ ] I kept credentials, session data, generated evidence, and consumer-owned configuration out of this change.
- [ ] I updated tests and documentation where applicable.
- [ ] I identified the package/release impact.
- [ ] For an AIDEV ticket branch, a fresh-context adversarial review was completed, all blocker/high findings were resolved, and I recorded its privacy-safe commit-bound attestation for this exact PR head.
