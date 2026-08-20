# Implementation Plan: AIDEV-162

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** M
*   **Estimated Effort:** 1-2 days
*   **Primary Risk:** A chat handoff could accidentally trigger a model turn, lose the in-progress answer draft, or resume against a later assistant message rather than the question the user intended to discuss.

## Expected File Changes
*   `[MODIFY]` `extensions/pi-answer/index.ts`: Add explicit chat-handoff and resume orchestration while preserving normal `/answer` extraction and explicit answer submission. No package manifest or lockfile change is expected: AIDEV-163 must already have delivered the package-local renderer/dependency migration.
*   `[MODIFY]` `extensions/pi-answer/qna-adapter.ts`: Represent a user-selected chat-handoff outcome separately from cancellation/submission and flush the bound draft before handoff.
*   `[MODIFY]` `extensions/pi-answer/qna-tui.ts`: Add a keyboard-accessible `Chat about this` action for the active question to the package-local renderer delivered by AIDEV-163.
*   `[MODIFY]` `extensions/pi-answer/utils.ts`: Add strict helpers/types for versioned handoff payload validation and question identity comparison.
*   `[MODIFY]` `extensions/pi-answer/README.md`: Document the explicit handoff/resume flow, keyboard behavior, draft preservation, and model/privacy boundary.
*   `[MODIFY]` `docs/PRIVACY.md`: Clarify that this feature only preloads user-reviewable editor text; a model/provider receives chat text only after the user submits it through Pi.
*   `[MODIFY]` `tests/pi-answer-package.test.mjs`: Cover handoff payload validation, no-implicit-send behavior, same-session draft restoration, resume binding, cancellation, and submission invariants.
*   `[NEW]` `.changeset/<generated-name>.md`: Declare the feature release for `@zkrausman/pi-answer`.

## Step-by-Step Execution
1.  **Phase 1: Establish bounded handoff semantics**
    *   Step 1.1: Start only after AIDEV-154 delivers the package and AIDEV-163 delivers the package-local Q&A renderer; retain both Linear blockers until their implementation PRs are merged.
    *   Step 1.2: Implement `Chat about this` as a same-session, user-controlled escape hatch—not `ctx.newSession`, `ctx.fork`, `pi.sendUserMessage`, or `pi.sendMessage`. Pi’s supported session-replacement APIs have no automatic return path, and send APIs trigger turns.
    *   Step 1.3: Define a versioned `answer:chat-handoff` custom session entry containing the original complete assistant source-entry ID, a validated question identity/snapshot, active-question position, and handoff state. Custom entries must remain extension state, not model context. Its entry ID is the lineage anchor: a resume is valid only when that exact entry is an ancestor returned by the current `getBranch()`; descendants of that entry intentionally share the resumable handoff, while branches created before it cannot resume it.
    *   Step 1.4: Define `/answer resume` as the explicit re-entry command. It must locate the latest unresolved handoff on the current branch, verify its payload, source/question identity, and ancestor relationship, restore the associated draft and active question, and reject stale/malformed/non-ancestor handoffs with an actionable notification rather than silently choosing a different assistant message.
2.  **Phase 2: Implement a no-implicit-model, draft-safe interaction**
    *   Step 2.1: Add a discoverable, keyboard-accessible `Chat about this` action to the active-question TUI. It must be separate from option selection, Other/custom input, Submit, and Cancel, with an accessible focus/confirmation state.
    *   Step 2.2: On user confirmation, flush the existing answer draft, append the handoff entry, close the Q&A UI, and call only `ctx.ui.setEditorText()` with a concise, editable discussion prompt containing the selected question and necessary context. Do not submit the editor, invoke a model, select an answer, clear the draft, or append an `answers` message.
    *   Step 2.3: Let the user decide whether to edit/send the preloaded text. After any normal same-session conversation, `/answer resume` must restore the original questionnaire state without re-running question extraction or treating the later chat response as the questionnaire source.
    *   Step 2.4: On normal Submit, clear matching draft/handoff state and preserve the current `customType: "answers"` output. On Cancel or an abandoned editor, retain the draft/handoff for explicit resume; prevent duplicate resume entries and reject question/source mismatches.
3.  **Phase 3: Document and test state, privacy, and accessibility**
    *   Step 3.1: Add unit tests for valid handoff payloads plus missing/unknown-version, malformed, source-ID mismatch, question-fingerprint mismatch, duplicate, completed, and non-ancestor handoffs; each invalid case must fail closed without opening a UI or sending a message. Test that a descendant branch of the handoff entry is intentionally resumable, while a branch created before the handoff is not.
    *   Step 3.2: Add TUI tests for keyboard focus, confirmation, cancellation, active-question targeting, and coexistence with option selection, numeric input, custom answers, templates, and the AIDEV-163 recommendation marker.
    *   Step 3.3: Stub Pi UI/session/send APIs to prove chat handoff flushes/appends state and calls editor prefill only; assert it never calls `sendUserMessage`, `sendMessage`, `modelRegistry.complete`, session replacement, or the answer-submission path.
    *   Step 3.4: Test same-session resume after an intervening assistant chat response: the original questions, responses, current question, and draft are restored; no new extraction call occurs; explicit final submit emits exactly one compiled `answers` message.
    *   Step 3.5: Update package and privacy documentation to distinguish editor prefill from an actual provider request, then add the Changeset after behavior and manifest boundaries are final.
4.  **Phase 4: Validate and hand off**
    *   Step 4.1: Run focused tests, root test/build, package/compliance/Pi-extension validators, Changeset/DCO validation, and governance race tests against the implementation PR base.
    *   Step 4.2: Perform a manual TUI smoke test covering chat handoff, editor review without sending, user-sent discussion, `/answer resume`, and final explicit answer submission.
    *   Step 4.3: Perform fresh-context adversarial review of the exact final implementation commit; resolve blocker/high findings and bind a clean review-packet attestation to the final PR base/head commits.

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
    *   [ ] The chat action targets only the active question, is accessible by keyboard, and never changes a selected/custom response unless the user separately edits it.
    *   [ ] Handoff writes/flushes extension state and preloads editable editor text only; it sends no model/provider request, user message, answer message, fork, or replacement session.
    *   [ ] `/answer resume` after a user-led same-session chat restores the original source-bound questionnaire and draft without re-extraction or accidental attachment to the later assistant reply.
    *   [ ] Invalid, stale, duplicate, completed, or non-ancestor handoffs fail closed and preserve user data; descendants of the handoff entry resume deterministically, and explicit final submit emits one normal compiled answer message and clears matching state.
    *   [ ] Documentation accurately describes user control and provider disclosure, and all required repository, package, compliance, Changeset, DCO, governance, manual-TUI, and final-review checks pass.
