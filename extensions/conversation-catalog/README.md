# Pi conversation catalog

`@zkrausman/pi-conversation-catalog` provides an in-Pi, local-only browser for saved Pi conversations and evidence-cited hindsight reports. It has no network capability.

## Install

```powershell
pi install -l npm:@zkrausman/pi-conversation-catalog
```

For local development, add `extensions/conversation-catalog/src/index.ts` to Pi's extensions setting and reload Pi.

## Commands

```text
/conversation-catalog
/hindsight-document [session-id] [output-path]
```

## Browse, reread, then start hindsight

1. Run `/conversation-catalog` in Pi's interactive terminal UI. It automatically discovers saved Pi conversations across their known locations; it creates no HTML file or other catalog artifact.
2. Select a conversation to read it locally in Pi. The reader displays its saved messages and tool activity only in the local editor; it does not write, cache, or send that content to a model.
3. After rereading it, either start hindsight immediately or choose **Put its hindsight command in the Pi editor**. That prepares `/hindsight-document <session-id>` for exactly the conversation you reviewed.
4. Running that command resolves the exact currently saved session, then requires the same interactive redaction review before any evidence is submitted to the active model.

The `session-id` is a local saved-session identifier, never a filesystem path. It is intentionally displayed only in the in-Pi browser and its selected-session command handoff. A stale or invalid ID is rejected without falling back to an arbitrary session. When the first token exactly matches a currently saved session ID, selected-session syntax takes precedence over a legacy output path.

`/hindsight-document` without a session ID retains its interactive picker for compatibility. It always requires an interactive redaction review and submits only the reviewed/redacted evidence to the active model. The model can call one safe structured writer with claims, optional story steps, and Fix or Harden proposals. The extension validates and escapes that structure, then generates reader-first HTML with cited evidence snippets in every surfaced strength and lesson, matching proposals, and a closed full cited-evidence appendix. Citations link locally to embedded redacted source context. An excluded conversation produces only a content-free redaction fallback.

When the selected saved conversation contains an exact `subagent` tool call and exact same-ID result, the report can also include a compact **Subagent efficiency** section. A lone call or unmatched result is not delegation evidence. The report separately assesses delegation timing and delivery quality: timing cites marked delegation call/result/follow-up evidence and includes a call or result; delivery is always an inference and requires a matched result and its own safely redacted marker for the immediate subsequent primary assistant event. That marker is chronological follow-up only, not proof of causality. Findings pair strengths with Harden proposals and risks with Fix proposals that share cited evidence. A successful tool result alone is not proof of delivery quality. Near tool names, prose, unmatched results, and other orchestration tools are not treated as delegation. Conversations without a qualifying pair render a concise no-activity state instead.

For `/hindsight-document <session-id> [output-path]`, an explicit output path is optional and follows the selected session ID. The legacy `/hindsight-document [output-path]` form is also supported, including paths containing spaces. Without one, hindsight reports are written under your per-user platform data directory (not the current project): `%LOCALAPPDATA%\\pi\\hindsight-reports` on Windows (or `~/.pi/hindsight-reports` when unavailable), `~/Library/Application Support/pi/hindsight-reports` on macOS, and `$XDG_DATA_HOME/pi/hindsight-reports` (or `~/.local/share/pi/hindsight-reports`) on Linux and other Unix platforms. Default report names are unique and pseudonymous; explicit paths are never overwritten. Generated HTML is standalone, CSP-restricted, and contains no remote assets. Protect or delete local HTML when no longer needed.
