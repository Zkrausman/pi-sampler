# Implementation Plan: AIDEV-163

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** M
*   **Estimated Effort:** 1-2 days
*   **Primary Risk:** The current external shared-Q&A dependency owns option rendering, so adding a marker there would either be undistributable or silently alter response/draft semantics instead of remaining a display-only recommendation.

## Expected File Changes
*   `[MODIFY]` `extensions/pi-answer/package.json`: Remove the external shared-Q&A runtime dependency after its required TUI behavior is made package-local; retain the AIDEV-154 Pi peer/runtime contract and packed-file allowlist.
*   `[MODIFY]` `extensions/pi-answer/index.ts`: Use package-local TUI/trust-mode helpers without changing the `/answer` command, extraction-model selection, or answer submission flow.
*   `[MODIFY]` `extensions/pi-answer/qna-adapter.ts`: Import the package-local Q&A component/types and preserve draft, navigation, custom-answer, and compiled-answer behavior.
*   `[MODIFY]` `extensions/pi-answer/utils.ts`: Add a validated optional recommended-option field to the extraction contract, default prompt, and parser without changing questions that omit it.
*   `[NEW]` `extensions/pi-answer/qna-tui.ts`: Create a provenance-attributed, package-local fork of the shared Q&A TUI with a display-only `(Recommended)` option marker.
*   `[MODIFY]` `extensions/pi-answer/UPSTREAM-PROVENANCE.md`: Record the immutable source/release/hash/license evidence for the copied shared-Q&A code and the deliberate local ownership boundary.
*   `[MODIFY]` `extensions/pi-answer/LICENSE`: Preserve the applicable upstream MIT text and notices for the copied shared-Q&A source.
*   `[MODIFY]` `extensions/pi-answer/README.md`: Document recommendation semantics: an optional agent suggestion is a visible hint, never an answer or automatic selection.
*   `[MODIFY]` `extensions/pi-answer/THIRD-PARTY-NOTICES.md`: Regenerate the notice after the dependency boundary changes.
*   `[MODIFY]` `extensions/pi-answer/sbom.cdx.json`: Regenerate the SBOM after the dependency boundary changes.
*   `[MODIFY]` `tests/pi-answer-package.test.mjs`: Cover extraction-contract validation, the marker’s UI/rendering contract, draft/output invariants, copied-source provenance, and the removed external dependency.
*   `[NEW]` `.changeset/<generated-name>.md`: Declare the feature release for `@zkrausman/pi-answer`.

## Step-by-Step Execution
1.  **Phase 1: Confirm the package and provenance boundary**
    *   Step 1.1: Start only after AIDEV-154 is merged and its `@zkrausman/pi-answer` package boundary, contract, and public release policy are available; do not edit the ignored local installation tree.
    *   Step 1.2: Obtain the authoritative MIT license/provenance and immutable source hashes for the `@siddr/pi-shared-qna@0.1.7` Q&A renderer used by the AIDEV-154 baseline. Record the copied files, source directory, release, retrieval evidence, and hashes in `UPSTREAM-PROVENANCE.md`.
    *   Step 1.3: Verify the local renderer fork can replace only the shared-Q&A functions/types consumed by pi-answer. Keep Pi’s built-in TUI/mode/trust APIs as Pi dependencies rather than copying unrelated shared-package code.
2.  **Phase 2: Add the recommendation contract and package-local renderer**
    *   Step 2.1: Extend an extracted question with optional `recommendedOptionIndex`, defined as a zero-based index into that question’s presented options. Update the extraction system prompt to request it only when the extraction model can justify one choice from the assistant text.
    *   Step 2.2: Make parsing fail closed when `recommendedOptionIndex` is non-integer, negative, supplied without options, or outside the option array; retain exact current behavior when absent. Do not infer a recommendation from a label or description.
    *   Step 2.3: Copy the minimal shared Q&A renderer into `extensions/pi-answer/qna-tui.ts`, retaining required MIT attribution. Extend its question type and option row rendering to append an accessible `(Recommended)` hint only to the validated recommended index. At constrained terminal widths, preserve the option’s selectable label and render the hint on a distinct wrapped/indented line rather than truncating either into ambiguity.
    *   Step 2.4: Preserve keyboard navigation, numeric selection, Other/custom-text editing, templates, draft persistence, cancellation, and response formatting. The hint must neither change selected state nor appear in the compiled answer text.
    *   Step 2.5: Switch `qna-adapter.ts` and `index.ts` to package-local renderer/mode helpers, remove `@siddr/pi-shared-qna` from runtime dependencies, and regenerate the lockfile/compliance artifacts.
3.  **Phase 3: Test and document the user contract**
    *   Step 3.1: Add parsing tests for no recommendation, each valid in-range index, malformed/non-integer/negative/out-of-range indexes, options omitted, and multiple questions with independent recommendations.
    *   Step 3.2: Add TUI/component tests proving exactly one matching option is marked, no marker is rendered without a recommendation, and navigation/numeric/custom-answer interactions are identical with and without a marker. Exercise the renderer at its minimum supported and normal terminal widths, asserting the selectable option label remains visible and the marker is separately visible/wrapped rather than truncated.
    *   Step 3.3: Add draft-resume and compiled-output tests proving a recommendation is never persisted as a chosen answer and the `(Recommended)` label never leaks into submitted answer text.
    *   Step 3.4: Update package documentation and provenance/compliance artifacts, then add the Changeset only after the final manifest is settled.
4.  **Phase 4: Validate and hand off**
    *   Step 4.1: Run the package’s focused tests, root test/build, package/compliance/Pi-extension validators, Changeset/DCO validation, and governance race tests against the implementation PR base.
    *   Step 4.2: Pack the workspace package, install its tarball into a clean temporary npm consumer, and run the Pi extension smoke/import path there. Verify the local renderer and required MIT/provenance artifacts are included and that `@siddr/pi-shared-qna` is neither installed nor required at runtime; package/Pi validators alone are insufficient evidence for that consumer boundary.
    *   Step 4.3: Perform fresh-context adversarial review of the final implementation commit; resolve blocker/high findings and bind a clean review-packet attestation to the final PR base/head commits.

## Test Matrix
*   **Target Command**: `npm test`
*   **Target Command**: `npm run build`
*   **Target Command**: `npm run validate:compliance`
*   **Target Command**: `npm run validate:pi-extensions`
*   **Target Command**: `npm run validate:packages`
*   **Target Command**: `npm run validate:changesets -- --base "$CHANGESET_BASE_REF" --head HEAD`
*   **Target Command**: `npm run validate:dco -- --base "$DCO_BASE_REF" --head HEAD`
*   **Target Command**: `cd governance && go test -race ./...`
*   **Validation Scenarios**:
    *   [ ] Absent recommendation preserves byte-for-byte existing question, navigation, draft, and compiled-answer behavior.
    *   [ ] Only a validated in-range index renders `(Recommended)`; malformed recommendation metadata fails extraction rather than selecting or marking an arbitrary option.
    *   [ ] The marker is display-only: it never changes response state, template output, stored draft answers, or submitted answer text.
    *   [ ] A clean temporary consumer installs the packed package and runs its Pi extension smoke/import path with the package-local renderer, complete upstream MIT/provenance evidence, and no installed or runtime-required `@siddr/pi-shared-qna`.
    *   [ ] All required repository, compliance, Changeset, DCO, and governance checks pass, and final adversarial-review evidence binds the exact implementation commits.
