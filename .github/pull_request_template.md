## Summary

<!-- What changes, and why? -->

## Validation

<!-- Commands/tests run, or why validation was not applicable. -->

## Release impact

<!-- Changeset added / no package release needed / follow-up required. -->

## AIDEV final-review attestation

<!-- Required only when the head branch is exactly zkrausman/aidev-<positive-number>-<lowercase-kebab-description>.
     Terra retains iterative/remediation review, then launches one fresh-context final child.
     The child reviews the complete final v3 packet, acceptance matrix, and verification evidence.
     Resolve blocker/high findings and render exactly one marker from the current local receipt.
     Keep reports, findings, sessions, prompts, credentials, receipt, and reviewer identity out of this body. -->

<!-- pi-sampler-adversarial-review-attestation:v3 {"format":"pi-sampler.adversarial-review-attestation","version":3,"base":"<exact-lowercase-40-or-64-character-base-sha>","head":"<exact-lowercase-40-or-64-character-head-sha>","outcome":"clean","packetSha256":"<v3-packet-sha256>","acceptanceMatrixSha256":"<acceptance-matrix-sha256>","verificationEvidenceSha256":"<verification-evidence-sha256>","reviewerModelId":"<trusted-catalog-model-id>","reviewProfileVersion":"<trusted-catalog-profile-version>","receiptSha256":"<opaque-local-receipt-sha256>"} -->

<!-- CI verifies exact base/head and public digests only. Model/profile values are maintainer-attested caller claims, not external proof. The marker never grants merge authority. Delete this placeholder marker for non-ticket branches. -->

## Checklist

- [ ] I kept credentials, session data, generated evidence, and consumer-owned configuration out of this change.
- [ ] I updated tests and documentation where applicable.
- [ ] I identified the package/release impact.
- [ ] For an AIDEV ticket branch, a fresh-context adversarial review was completed, all blocker/high findings were resolved, and I recorded its privacy-safe commit-bound attestation for this exact PR head.
