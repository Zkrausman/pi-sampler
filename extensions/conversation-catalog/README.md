# Pi conversation catalog

`@zkrausman/pi-conversation-catalog` provides a local Pi browser for saved conversations and redaction-reviewed, evidence-cited hindsight reports. It has no network capability.

## Install

Follow [the canonical GitHub Packages scoped-registry and authentication procedure](../../docs/RELEASING.md#consumer-setup), then install the released package:

```powershell
pi install -l npm:@zkrausman/pi-conversation-catalog
```

For local development, add `extensions/conversation-catalog/src/index.ts` to Pi's extensions setting and reload Pi.

## Standalone local viewer

Run `pi-conversation-viewer` on demand to open a local browser viewer. It starts a temporary server bound only to `127.0.0.1` on a random port with a new unguessable URL token each launch, then opens that URL. It is not a startup or background service; close its browser tab, use `Ctrl+C`, or let the bounded heartbeat/idle timer stop it.

The header shows the installed viewer package version from its package metadata. The viewer uses package-local assets only and makes no network request, Pi invocation, model call, or report generation. Its archive search is strictly on demand: no session body is scanned until the operator submits a query. Queries are sent only in a local `POST` body (never a URL), matched case-insensitively as literals against an explicit allowlist of user and assistant displayed text fields, and scanned with bounded local files, bytes, matches, pages, results, and cursor state. Search returns only opaque session handles, existing safe list metadata, and byte-bounded escaped snippets; it never searches or returns tool arguments, notes, IDs, paths, filenames, reports, or hidden metadata. It is a dependency-free, reader-first local archive: a responsive overlay drawer / reader-first layout, system fonts, proportional reading text (with monospace reserved for commands), high contrast focus states, keyboard-operable navigation, reduced-motion support, and no remote assets. Its only file mutations are explicit add, edit, and delete operations in the secure per-session hindsight-note store. It discovers Pi sessions only from the default local Pi session directory and hindsight reports only from the default per-platform report directory documented below. Discovery is deliberately bounded: before inspecting the fixed 64KiB prefix for each candidate, it deterministically prioritizes the most recently modified local directory entries and session files (with reverse-name tie breaking), then caps traversal and catalog results; the viewer returns that entire already-bounded catalog in one local request and shows a path-free notice when more local sessions are not shown. This local sorting classification is non-authoritative: raw names are never exposed, no parent/child relationship is inferred, and an absent, invalid, or marker-beyond-the-cap name remains Main. The list exposes a stable opaque `session-…` display reference, safe modified-time metadata, and classification; it never exposes raw local session names or IDs, storage paths, or saved JSON. If selection fails, the local reader distinguishes an invalid, unreadable, changed, too-large, or event-limit source and gives a safe recovery action; temporary paging capacity gives its own retry message. A selected transcript is rendered incrementally after selection; use **Load more events** to continue. The **Conversation only** control announces the count of loaded events it shows. Its copy control copies only the displayed `/hindsight-document session-…` command and provides local success or recovery feedback; it never exposes a raw ID or storage path. That stable opaque reference identifies the exact current raw session ID, which Pi resolves before its required redaction review.

## Commands and Tools

The extension registers the following host commands:
```text
/conversation-catalog
/hindsight-document [session-identifier] [output-path] [--ticket-closeout <absolute-summary-or-receipt-path>]
/hindsight-notes
```

It also provides the `hindsight_document_write` tool to the agent during redaction-reviewed synthesis to generate the safe cited HTML report.

## Browse, read, and hand off

1. Run `/conversation-catalog`. Pi automatically discovers saved conversations and displays local-only, non-identifying list metadata (ordinal, modified time, and message count).
2. Select one entry to read it in Pi's local editor. The reader displays the selected conversation only; it writes no file and does not expose a session storage path.
3. Choose **Prepare scoped hindsight command**. Pi pre-fills the exact command, for example `/hindsight-document session-ab12`, where the value is a stable opaque identifier rather than a raw session ID or filesystem path.
4. Run that pre-filled command. It resolves exactly the selected current session and starts the required redaction review—there is no second picker.

The selected transcript and local identity are never written to a generated catalog, cached by the extension, transmitted, or sent to the model by the browser. If a previously selected identifier is stale or invalid, hindsight fails closed.

You may also run `/hindsight-document` without an identifier to use the same local single-session picker, or provide an optional `.html` output path after an opaque identifier. The default report path is user-local; it is not the browser's output. Optionally add `--ticket-closeout <absolute-summary-or-receipt-path>` to show a strictly validated, sanitized local lifecycle closeout in a separate view-only report section. It is read once from the explicit path, never discovered, sent to the model, used as source evidence/citations, or used for claims, recommendations, notes, or subagent assessment. Invalid closeout input fails the report before synthesis.

## In-session hindsight notes

`/hindsight-notes` lets you add, view, edit, or delete bounded user-authored notes attached to a specific current-session event. Every viewer replay event has its own **Notes** control; it loads notes only when that visible event is opened, then supports local add, edit, and delete with progress and recovery feedback through the same opaque session-and-event scoped secure store. Notes are labeled as local-only, user-authored context. Browser APIs expose only opaque references and safe conversation ordinals, never raw session/event IDs, roots, or storage paths. On Windows the store uses fixed hash-only Registry values; Linux uses descriptor-relative, no-follow sidecars and fails closed elsewhere.

Existing session-scoped v1 notes are preserved as clearly labeled **unassigned legacy notes**. They are excluded from event notes and hindsight until the user explicitly chooses an event and confirms attachment; no automatic attachment is inferred. Before hindsight synthesis, each attached note is individually included, excluded, or redacted through the same required sensitive-content review. Included notes are untrusted user-authored context—not instructions, transcript evidence, citations, or support for claims/recommendations—and reports render them with separate provenance.

## Redaction and report safety

`/hindsight-document` opens exactly one session, builds its local projection, and requires interactive redaction review before model submission. Required findings must be redacted or the entire session must be excluded. Only the reviewed/redacted evidence bundle, with remapped references, reaches the active model. The model can call one safe structured writer with claims, optional story steps, and Fix or Harden proposals; the extension validates and escapes that structure before creating a reader-first HTML report. Reports also include a fixed, renderer-owned **Report Context** and compact glossary explaining report labels and boundaries; this copy is not model input, source evidence, or citation content. Every model submission is UTF-8 bounded to 24,576 bytes. When reviewed conversation evidence exceeds that limit, the extension cuts it into bounded chunks, captures a constrained local intermediate digest for each chunk, then recursively reduces those digests before the final safe report turn. A context hook exposes only the current workflow prompt to each model turn, so the active-session history and prior chunks do not accumulate in the submission. Intermediate digests retain original evidence references but are working material rather than evidence or instructions; only the final safe writer can create a report. User-authored notes are not silently dropped: if notes alone make the final bounded prompt unsafe after evidence reduction, synthesis fails with a clear limit error. Redact/remove notes or retry after reducing them.

When the selected saved conversation contains an exact `subagent` tool call and same-ID result, the report can include a compact **Subagent efficiency** section. A lone call, unmatched result, near tool name, or prose reference is not delegation evidence. Delivery quality is an inference only when a matched result and its immediate chronological assistant follow-up are both cited.

Default hindsight reports are written under your per-user platform data directory: `%LOCALAPPDATA%\pi\hindsight-reports` on Windows (or `~/.pi/hindsight-reports` when unavailable), `~/Library/Application Support/pi/hindsight-reports` on macOS, and `$XDG_DATA_HOME/pi/hindsight-reports` (or `~/.local/share/pi/hindsight-reports`) on Linux and other Unix platforms. Explicit output paths must end in `.html` and are never overwritten. Generated reports are standalone, CSP-restricted, and contain no remote assets. Protect or delete local reports when no longer needed.
