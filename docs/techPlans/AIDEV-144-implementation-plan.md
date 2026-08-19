# Implementation Plan: AIDEV-144

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** L
*   **Estimated Effort:** 3-4 days
*   **Primary Risk:** Ensuring optimistic concurrency race conditions (stale edits) are correctly bounded and rejected natively, while strict Actor Authority and Trust Boundaries are consistently enforced without degrading the real-time UX feel.

## Expected File Changes
*   `[NEW]` `contracts/annotation-review-v1.mjs`: TypeBox schemas for review models, findings (`proposed`, `approved`, `rejected`, `deferred`), annotation revisions, pagination envelopes, and optimistic concurrency tokens (`expectedRevision`), and crucially, the `reference pointer`.
*   `[NEW]` `contracts/annotation-review-v1.schema.json`: JSON Schema export artifact.
*   `[NEW]` `docs/specs/ANNOTATION-FINDING-REVIEW-UX-V1.md`: Architectural specification detailing revision lineage, actor authority boundaries, `no_self_approval`, optimistic locking, pagination bounds, and provenance recording.
*   `[NEW]` `src/components/annotationReviewState.ts`: Pure TypeScript domain logic managing pagination bounding, filtering, conflict detection (stale vs current revision rejection), and actor bounds (`no_self_approval`).
*   `[NEW]` `src/components/AnnotationReview.tsx`: Accessible React 19 UI component utilizing borderless layouts with tonal shifts via Stitch UI primitives (`Box`, `Flex`, `Grid`) from `ThemeProvider.tsx`, complete with `aria-live` polite regions.
*   `[NEW]` `tests/annotation-review.test.mjs`: Node test suite covering strict positive and negative tests (pagination bounds, stale edit rejection, `no_self_approval`, missing provenance).
*   `[MODIFY]` `src/App.tsx`: Mounts the AnnotationReview interface.
*   `[MODIFY]` `package.json`: Script additions for schema export/validation.
*   `[MODIFY]` `governance/path-policy-v1.json`: Register `docs/specs/ANNOTATION-FINDING-REVIEW-UX-V1.md` as governed documentation.

## Step-by-Step Execution
1.  **Phase 1: Core Contracts & Schemas**
    *   Step 1.1: Define TypeBox schemas in `contracts/annotation-review-v1.mjs` ensuring provenance records require `reviewerId`, `decision`, `rationale`, and a `reference pointer`.
    *   Step 1.2: Enforce Actor Authority rules (controller, implementer, reviewer) inside the model bounds, requiring `no_self_approval: true`.
    *   Step 1.3: Export the JSON Schema artifact to `contracts/annotation-review-v1.schema.json`.
    *   Step 1.4: Update `governance/path-policy-v1.json` to include the new spec path.
    *   Step 1.5: Draft architectural specifications in `docs/specs/ANNOTATION-FINDING-REVIEW-UX-V1.md`.
2.  **Phase 2: Domain State Logic**
    *   Step 2.1: Implement pure domain logic in `src/components/annotationReviewState.ts` to handle offline/deterministic concurrency checks (`expectedRevision` !== `currentRevision` rejection).
    *   Step 2.2: Implement logic for provenance tracking (capturing `reference pointer`, mapping `model_inference` to `human_annotation`) and bounded pagination.
3.  **Phase 3: Testing**
    *   Step 3.1: Write Node test suite in `tests/annotation-review.test.mjs` using `node:test` and `node:assert/strict` ensuring deterministic, offline evaluation with no API calls.
    *   Step 3.2: Verify all negative validation cases (bounds, missing refs, self-approval) fail closed.
4.  **Phase 4: UI Implementation**
    *   Step 4.1: Build `src/components/AnnotationReview.tsx` using exclusively Stitch UI primitives (`Box`, `Flex`, `Grid`). Avoid raw `.css` files.
    *   Step 4.2: Implement `aria-live="polite"` regions for asynchronous status, provenance changes, and optimistic lock conflicts.
5.  **Phase 5: Delivery & Attestation**
    *   Step 5.1: Stage changes and generate the adversarial review attestation packet using the repo script (e.g., `generate-review-packet.mjs`).
    *   Step 5.2: Commit changes using DCO 1.1 standard (`git commit -s`) to bind PR identity and commit-sha.
    *   Step 5.3: Append the generated attestation marker to the PR body.

## Test Matrix
*   **Target Command**: `node --test tests/annotation-review.test.mjs`
*   **Validation Scenarios**:
    *   [ ] Valid creation of `human_annotation` from `model_inference` including `reference pointer` and `rationale`.
    *   [ ] Rejection of edit due to `STALE_REVISION_CONFLICT` (`expectedRevision` mismatch).
    *   [ ] Rejection of pagination requests that exceed the upper bounds limit.
    *   [ ] Rejection of human annotation creation missing required provenance fields (e.g., omitted rationale or reference pointer).
    *   [ ] Verification that validation is deterministic and offline (no external broker/API calls).
    *   [ ] Rejection due to self-approval (`no_self_approval: true`).
