## Summary

<!-- What changes, and why? -->

## Validation

<!-- Commands/tests run, or why validation was not applicable. -->

## Release impact

<!-- Changeset added / no package release needed / follow-up required. -->

## AIDEV adversarial review evidence

<!-- Required only when the head branch is exactly zkrausman/aidev-<positive-number>-<lowercase-kebab-description>.
     Independently review the local commit-only packet in fresh context, resolve blocker/high findings,
     calculate its SHA-256, and replace every placeholder below. Keep review reports, session IDs,
     prompts, credentials, and generated review content out of this PR body. -->

<!-- pi-sampler-adversarial-review-attestation:v1 {"format":"pi-sampler.adversarial-review-attestation","version":1,"base":"<exact-lowercase-40-or-64-character-base-sha>","head":"<exact-lowercase-40-or-64-character-head-sha>","reviewerRole":"independent-fresh-context-reviewer","outcome":"clean","packetSha256":"<lowercase-sha256-of-the-commit-only-packet>"} -->

<!-- CI verifies this commit-bound evidence, not reviewer judgment. An independent fresh-context review is mandatory before merge. Delete this placeholder marker for non-ticket branches. -->

## Checklist

- [ ] I kept credentials, session data, generated evidence, and consumer-owned configuration out of this change.
- [ ] I updated tests and documentation where applicable.
- [ ] I identified the package/release impact.
- [ ] For an AIDEV ticket branch, an independent fresh-context adversarial review was completed and its privacy-safe, commit-bound marker is present.
