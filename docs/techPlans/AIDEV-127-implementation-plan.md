# Implementation Plan: AIDEV-127

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** L
*   **Estimated Effort:** 3-5 days
*   **Primary Risk:** Bounded packet limits across UI, properly maintaining exact file/size constraints (64KB max per event/record), and correct preservation of revision history without unbounded memory allocations during ledger hydration.

## Expected File Changes
*   `[NEW]` `contracts/human-annotation-v1.mjs`: *Schema validation extending `ticket-episode-v1.mjs` for human annotations with strict sensitivity tags (`public`, `internal`, `confidential`, `restricted`), author, target referencing, bounded rationale length, and downgrade validation.*
*   `[NEW]` `ledgers/annotation-ledger.mjs`: *Bounded, append-only, portable filesystem ledger extending or instantiating EpisodeEvolutionLedger patterns (LEDGER_FORMAT_VERSION = 2) for human annotations. Max 64KB per record limits, strictly fail-closed.*
*   `[NEW]` `docs/planning-rubric/AIDEV-127-rubric.json`: *Strict offline validation manifest defining trust boundaries, controller/implementer/reviewer actors, overlap search, and non-go verification steps.*
*   `[NEW]` `src/ui/ReviewUX.tsx`: *React component for targeting specific scopes (`events/ranges`, `decisions`) and presenting model-proposed findings with Approve/Reject/Edit capabilities via isolated, bounded projection streams.*
*   `[NEW]` `src/ui/AnnotationCard.tsx`: *React component displaying individual annotations with revision history presentation and sensitivity classification visualization.*
*   `[MODIFY]` `src/App.tsx`: *Integrate the ReviewUX flow and UI routing.*

## Step-by-Step Execution
1.  **Phase 1: Contract, Rubric, & Schema Definitions**
    *   Step 1.1: Produce `docs/planning-rubric/AIDEV-127-rubric.json` containing the required offline verification manifest (actor separation, repository-contained cited paths, behavioral test definitions, overlap search context).
    *   Step 1.2: Define the `contracts/human-annotation-v1.mjs` utilizing the existing `human_annotation` evidence class. Implement strict downgrade validation (annotation's sensitivity >= target's sensitivity), `untrusted` authority validation, and bounded rationale/length checks.
2.  **Phase 2: Immutable Storage Engine**
    *   Step 2.1: Implement `ledgers/annotation-ledger.mjs` utilizing Format Version 2 (`LEDGER_FORMAT_VERSION = 2`), relying on `.staging` directory fsyncs for safe concurrency. Limit max sizes strictly (e.g., `maxEncodedRecordBytes: 64 KiB`) to prevent unbounded packet reading.
    *   Step 2.2: Implement the event revision update logic: when updating an annotation, append the new annotation event, and explicitly append a state update replacing the old record with its state set to `superseded` and `supersededByEventId` pointing strictly to the **newer replacement event**.
    *   Step 2.3: Implement deterministic snapshot and export/migration boundaries utilizing platform-portable `/` separator logic and avoiding OS-specific registry references completely.
3.  **Phase 3: Review UX Implementation**
    *   Step 3.1: Build `src/ui/AnnotationCard.tsx` to safely present rationale and revision history based on the `supersededByEventId` chain.
    *   Step 3.2: Implement `src/ui/ReviewUX.tsx` to handle bounding logic and present retrospective findings with Approve/Reject/Edit capabilities. Read exclusively from bounded packets.
    *   Step 3.3: Wire the UX to the Annotation Ledger, ensuring isolated reads that strictly enforce sensitivity classification and redaction layers.

## Test Matrix
*   **Target Command**: `npm run test -- contracts/ ledgers/ src/ui/ && go run ./cmd/planning-rubric-validator -manifest docs/planning-rubric/AIDEV-127-rubric.json -repo-root .`
*   **Validation Scenarios**:
    *   [ ] Scenario A (Rubric Compliance): Offline Go validator strictly passes the defined rubric matrix.
    *   [ ] Scenario B (Event Replacements): Editing an existing annotation correctly produces a new replacement event, and the old event's `supersededByEventId` explicitly points to the new event ID.
    *   [ ] Scenario C (Negative case / Bounding Limits): Verify that exceeding the ledger byte size per event (e.g. > 64 KiB) triggers a quarantine/fail-closed state without corrupting existing records and without unbounded memory allocations.
    *   [ ] Scenario D (Cross-platform portability): Ensure ledger paths use normalized `/` for portability and never access Windows Registry.
    *   [ ] Scenario E (Sensitivity Downgrade Validation): Inserting an annotation with `internal` sensitivity attached to a `confidential` artifact is rejected by the schema validator.
