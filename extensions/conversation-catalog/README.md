# Pi conversation catalog

`@zkrausman/pi-conversation-catalog` writes standalone, local HTML views of saved Pi conversations. It has no network capability.

## Install

```powershell
pi install -l npm:@zkrausman/pi-conversation-catalog
```

For local development, add `extensions/conversation-catalog/src/index.ts` to Pi's extensions setting and reload Pi.

## Commands

```text
/conversation-catalog [output-path]
/hindsight-document [output-path]
```

`/conversation-catalog` writes a read-only catalog of session metadata. Its local HTML page renders only a title (or bounded first-prompt fallback), recorded location, modified time, and message count. It does not include transcripts, raw session data, session paths, or session IDs.

## Catalog to hindsight workflow

1. Run `/conversation-catalog [output-path]`, then open the generated local HTML file in a browser.
2. Browse the metadata to recognize a conversation. The session cards are for recognition only; they cannot select or launch a session.
3. Use the catalog's **Copy command** button (or select the visible command box if clipboard access is unavailable), then paste and run the literal `/hindsight-document` command in Pi.
4. In Pi's picker, select exactly one conversation and finish the interactive redaction review.

A static local page cannot run Pi commands. Selection and redaction remain in Pi.

`/hindsight-document` asks you to select exactly one saved conversation, requires an interactive redaction review, and submits only the reviewed/redacted evidence to the active model. The model can call one safe structured writer with claims, optional story steps, and Fix or Harden proposals. The extension validates and escapes that structure, then generates reader-first HTML with cited evidence snippets in every surfaced strength and lesson, matching proposals, and a closed full cited-evidence appendix. Citations link locally to embedded redacted source context. An excluded conversation produces only a content-free redaction fallback.

When the selected saved conversation contains an exact `subagent` tool call and exact same-ID result, the report can also include a compact **Subagent efficiency** section. A lone call or unmatched result is not delegation evidence. The report separately assesses delegation timing and delivery quality: timing cites marked delegation call/result/follow-up evidence and includes a call or result; delivery is always an inference and requires a matched result and its own safely redacted marker for the immediate subsequent primary assistant event. That marker is chronological follow-up only, not proof of causality. Findings pair strengths with Harden proposals and risks with Fix proposals that share cited evidence. A successful tool result alone is not proof of delivery quality. Near tool names, prose, unmatched results, and other orchestration tools are not treated as delegation. Conversations without a qualifying pair render a concise no-activity state instead.

`/conversation-catalog` output paths are relative to Pi's current working directory unless absolute and must end in `.html`. For `/hindsight-document`, an explicit output path has the same behavior. Without one, hindsight reports are written under your per-user platform data directory (not the current project): `%LOCALAPPDATA%\\pi\\hindsight-reports` on Windows (or `~/.pi/hindsight-reports` when unavailable), `~/Library/Application Support/pi/hindsight-reports` on macOS, and `$XDG_DATA_HOME/pi/hindsight-reports` (or `~/.local/share/pi/hindsight-reports`) on Linux and other Unix platforms. Default report names are unique and pseudonymous; explicit paths are never overwritten. Generated HTML is standalone, CSP-restricted, and contains no remote assets. Protect or delete local HTML when no longer needed.
