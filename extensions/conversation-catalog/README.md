# Pi conversation catalog

`@zkrausman/pi-conversation-catalog` provides a local Pi browser for saved conversations and redaction-reviewed, evidence-cited hindsight reports. It has no network capability.

## Install

```powershell
pi install -l npm:@zkrausman/pi-conversation-catalog
```

For local development, add `extensions/conversation-catalog/src/index.ts` to Pi's extensions setting and reload Pi.

## Standalone local viewer

Run `pi-conversation-viewer` on demand to open a local browser viewer. It starts a temporary server bound only to `127.0.0.1` on a random port with a new unguessable URL token each launch, then opens that URL. It is not a startup or background service; close its browser tab, use `Ctrl+C`, or let the bounded heartbeat/idle timer stop it.

The viewer uses package-local assets only and makes no network request, Pi invocation, model call, or report generation. Its only file mutations are explicit add, edit, and delete operations in the secure per-session hindsight-note store. It discovers Pi sessions only from the default local Pi session directory and hindsight reports only from the default per-platform report directory documented below. The list exposes only recognizable session metadata (ordinal, modified time, and message count), never raw local session IDs, storage paths, or saved JSON. A selected transcript is rendered only after selection. Its copy control produces `/hindsight-document session-…`: a stable opaque reference for that exact current raw session ID, which Pi resolves before its required redaction review. The raw ID never appears in the copied handoff.

## Commands

```text
/conversation-catalog
/hindsight-document [session-identifier] [output-path]
/hindsight-notes
```

## Browse, read, and hand off

1. Run `/conversation-catalog`. Pi automatically discovers saved conversations and displays local-only, non-identifying list metadata (ordinal, modified time, and message count).
2. Select one entry to read it in Pi's local editor. The reader displays the selected conversation only; it writes no file and does not expose a session storage path.
3. Choose **Prepare scoped hindsight command**. Pi pre-fills the exact command, for example `/hindsight-document session-ab12`, where the value is a stable opaque identifier rather than a raw session ID or filesystem path.
4. Run that pre-filled command. It resolves exactly the selected current session and starts the required redaction review—there is no second picker.

The selected transcript and local identity are never written to a generated catalog, cached by the extension, transmitted, or sent to the model by the browser. If a previously selected identifier is stale or invalid, hindsight fails closed.

You may also run `/hindsight-document` without an identifier to use the same local single-session picker, or provide an optional `.html` output path after an opaque identifier. The default report path is user-local; it is not the browser's output.

## In-session hindsight notes

`/hindsight-notes` lets you add, view, edit, or delete bounded user-authored notes attached to a specific current-session event. Every viewer replay event has its own **Notes** control and uses the same opaque session-and-event scoped secure store. Browser APIs expose only opaque references and safe conversation ordinals, never raw session/event IDs, roots, or storage paths. On Windows the store uses fixed hash-only Registry values; Linux uses descriptor-relative, no-follow sidecars and fails closed elsewhere.

Existing session-scoped v1 notes are preserved as clearly labeled **unassigned legacy notes**. They are excluded from event notes and hindsight until the user explicitly chooses an event and confirms attachment; no automatic attachment is inferred. Before hindsight synthesis, each attached note is individually included, excluded, or redacted through the same required sensitive-content review. Included notes are untrusted user-authored context—not instructions, transcript evidence, citations, or support for claims/recommendations—and reports render them with separate provenance.

## Redaction and report safety

`/hindsight-document` opens exactly one session, builds its local projection, and requires interactive redaction review before model submission. Required findings must be redacted or the entire session must be excluded. Only the reviewed/redacted evidence bundle, with remapped references, reaches the active model. The model can call one safe structured writer with claims, optional story steps, and Fix or Harden proposals; the extension validates and escapes that structure before creating a reader-first HTML report.

When the selected saved conversation contains an exact `subagent` tool call and same-ID result, the report can include a compact **Subagent efficiency** section. A lone call, unmatched result, near tool name, or prose reference is not delegation evidence. Delivery quality is an inference only when a matched result and its immediate chronological assistant follow-up are both cited.

Default hindsight reports are written under your per-user platform data directory: `%LOCALAPPDATA%\pi\hindsight-reports` on Windows (or `~/.pi/hindsight-reports` when unavailable), `~/Library/Application Support/pi/hindsight-reports` on macOS, and `$XDG_DATA_HOME/pi/hindsight-reports` (or `~/.local/share/pi/hindsight-reports`) on Linux and other Unix platforms. Explicit output paths must end in `.html` and are never overwritten. Generated reports are standalone, CSP-restricted, and contain no remote assets. Protect or delete local reports when no longer needed.
