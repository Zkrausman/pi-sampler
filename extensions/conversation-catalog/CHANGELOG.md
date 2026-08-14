# @zkrausman/pi-conversation-catalog

## 0.5.6

### Patch Changes

- e21868b: Redesign the standalone local viewer as an accessible reader-first archive with working opaque Pi handoff copying and event-local note management.
- a80c6ac: Group standalone viewer conversations by the bounded local session-name marker without exposing raw names.
- 5b8f1f8: Bound local conversation discovery and viewer replay snapshots, and clarify capped catalog availability and hindsight prompt recovery.
- ea14e61: Add a strict local-only lifecycle closeout summary package and optional view-only ticket closeout section for hindsight reports.
- Updated dependencies [ea14e61]
  - @zkrausman/pi-ticket-closeout-summary@0.2.0

## 0.5.5

### Patch Changes

- Treat existing empty Windows Registry note keys as empty stores so they no longer block saving notes; surface Save-note results in the reader status area.

## 0.5.4

### Patch Changes

- Make legacy-note attachment outcomes visible in the standalone viewer after the legacy-note panel closes.

## 0.5.3

### Patch Changes

- Fix standalone viewer session labels and compact empty event-note controls. Also include the prior lock-directory race retry fix for secure hindsight notes.

## 0.5.2

### Patch Changes

- 62a2c8e: Restore secure event-attached hindsight notes, including shared Pi and local viewer CRUD, explicit legacy-note attachment, and reviewed non-evidence provenance.

## 0.5.1

### Patch Changes

- Fix the standalone viewer launcher on Windows by importing its package-local ESM module through a file URL.

## 0.5.0

### Minor Changes

- 111a8f3: Add an on-demand, loopback-only standalone local conversation viewer.

## 0.4.0

### Minor Changes

- d724a38: Replace the generated conversation catalog with a local Pi browse/read flow. Scoped hindsight handoffs now use stable opaque identifiers, avoid a second picker, and preserve mandatory redaction before model submission.

## 0.3.0

### Minor Changes

- 380e1ef: Add cited, redaction-safe subagent efficiency findings for delegation timing and delivery quality in hindsight reports.

### Patch Changes

- 421fe61: Turn the local conversation catalog into a responsive metadata-only launcher for the existing redaction-reviewed hindsight workflow, with a safe copy affordance for `/hindsight-document`.

## 0.2.0

### Minor Changes

- d5e55d4: Add optional cited evidence-first hindsight story steps with safe direct-evidence and inference reading guidance.
- Release the minimal evidence-first hindsight workflow: a local session catalog plus redaction-reviewed single-session reports with cited Fix and Harden proposals. Default reports now use unique, user-local files rather than the active project directory.

### Patch Changes

- 7d9bb5f: Temporarily constrain hindsight document generation to one explicitly selected conversation.
