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

`/conversation-catalog` writes a read-only catalog of session metadata.

`/hindsight-document` asks you to select exactly one saved conversation, requires an interactive redaction review, and submits only the reviewed/redacted evidence to the active model. The model can call one safe structured writer with claims, optional story steps, and Fix or Harden proposals. The extension validates and escapes that structure, then generates reader-first HTML with cited evidence snippets in every surfaced strength and lesson, matching proposals, and a closed full cited-evidence appendix. Citations link locally to embedded redacted source context. An excluded conversation produces only a content-free redaction fallback.

When the selected saved conversation contains an exact `subagent` tool call and its matching result, the report can also include a compact **Subagent efficiency** section. It separates hindsight assessment of delegation timing from delivery quality, labels every finding as direct evidence or inference, cites only the redacted marked call/result evidence, and pairs strengths with Harden proposals and risks with Fix proposals. A successful tool result alone is not proof of delivery quality. Near tool names, prose, unmatched results, and other orchestration tools are not treated as delegation. Conversations without qualifying activity render a concise no-activity state instead.

`/conversation-catalog` output paths are relative to Pi's current working directory unless absolute and must end in `.html`. For `/hindsight-document`, an explicit output path has the same behavior. Without one, hindsight reports are written under your per-user platform data directory (not the current project): `%LOCALAPPDATA%\\pi\\hindsight-reports` on Windows (or `~/.pi/hindsight-reports` when unavailable), `~/Library/Application Support/pi/hindsight-reports` on macOS, and `$XDG_DATA_HOME/pi/hindsight-reports` (or `~/.local/share/pi/hindsight-reports`) on Linux and other Unix platforms. Default report names are unique and pseudonymous; explicit paths are never overwritten. Generated HTML is standalone, CSP-restricted, and contains no remote assets. Protect or delete local HTML when no longer needed.
