# Pi conversation catalog

`@zkrausman/pi-conversation-catalog` adds a read-only Pi command that writes a
standalone HTML index of saved Pi sessions. The resulting file has embedded CSS,
needs no server, and can be opened directly from disk in any browser.

## Prerequisite

Use a Pi version that supports `SessionManager.listAll()` (the command was
verified with Pi 0.84.1 or later-compatible releases).

## Install

With GitHub Packages access configured, install the released package in the
consumer project:

```powershell
pi install -l npm:@zkrausman/pi-conversation-catalog
```

For local development, add this entry point to Pi's `extensions` setting:

```json
{
  "extensions": [
    "E:/Repos/pi-sampler/extensions/conversation-catalog/src/index.ts"
  ]
}
```

Restart Pi or run `/reload`. For a one-session local smoke test:

```powershell
pi -e E:/Repos/pi-sampler/extensions/conversation-catalog/src/index.ts
```

## Use

In Pi, run:

```text
/conversation-catalog [output-path]
/conversation-flow <session-id> [output-path]
/hindsight-document [output-path]
```

With no argument, `/conversation-catalog` writes
`pi-conversation-catalog.html` in Pi's current working directory. A supplied
path is resolved relative to that directory unless absolute, must end in
`.html`, and may include a new parent directory, which the command creates.
Existing HTML output at that path is replaced. Pi reports the absolute output
path when complete; open that local `.html` file directly in a browser.

`/conversation-flow` is an explicit, historical-session view. Supply the full
saved session ID, or an unambiguous prefix (obtain one from Pi's session UI or
its saved-session listing). With no output path it writes
`pi-conversation-flow-session-<local-reference>.html`. The command uses Pi's
`SessionManager.open()` for the selected saved session; it does not parse or
modify JSONL logs itself. It requires Pi's interactive UI: before it writes an
export, it presents every detected sensitive finding and lets you **redact**,
**retain**, or **exclude the entire conversation**. Canceling makes no export.

The command writes a companion `pi-conversation-flow-session-<local-reference>.redaction.json`
file beside the HTML. It records a local pseudonymous session reference, excluded
state, finding locations/pattern names, redact/retain choices, and the stable
direct-evidence reference/anchor index, but never matched sensitive text, source
context, or a raw session ID/name. An excluded export is an HTML notice with no conversation content.

`/hindsight-document` provides a multi-select workflow across recorded location groups. Select at least two conversations, remove selections if needed, and review each conversation's redactions or exclude it. Excluding one of two selected conversations does not cancel generation: the report keeps a pseudonymous, navigable excluded-source fallback with no conversation content. The active model submits structured claims to the extension's safe report contract; it does not write report HTML directly. The contract escapes model text and generates every citation anchor, embedded redacted source-context section, and available flow/relationship-map context. Every material claim must cite an included source. Excluded conversations remain navigable only as explicit redaction-review fallbacks, and neither fallbacks nor citations reveal a raw session/event ID or unredacted text.

The flow document shows every persisted entry from all branches in timestamp
order. Colored cards distinguish user, assistant, tool-call, tool-result,
skill, and unsupported activity. Each rendered event has a deterministic,
pseudonymous **direct-evidence** citation (for example
`session-abc:event-0001`); the cited card is the inspectable source context.
The companion decision metadata preserves the citation reference and event
anchor without source text or raw Pi entry IDs. Visible arrow links connect
entry parents, matched tool calls to results, and a result to the next
chronological assistant entry. The latter is labeled as a chronological
inference and can cross a branch. Missing correlations, malformed entries,
images, thinking, and unknown content are kept compact or marked unsupported
rather than preventing output.

## Privacy and behavior

The catalog groups sessions by their recorded working directory/run location.
Each row shows only an identifying title (the saved name, or a bounded first
prompt fallback), modified timestamp, location, and message count.
`SessionManager.listAll()` may parse source session logs internally as required
by Pi, but the catalog neither renders, serializes, logs, caches, nor transmits
transcript text or raw session JSON; it never changes a source session log.

A flow is intentionally different: it is produced only by the explicit
`/conversation-flow` request and can contain bounded text from the selected local
conversation, including tool-result text that may contain sensitive material.
The required redaction review defaults to detecting email addresses, bearer/API
keys, and GitHub tokens. Add project-specific patterns in
`.pi/conversation-redaction-patterns.json` when needed:

```json
{
  "patterns": [
    { "name": "customer number", "expression": "CUST-[0-9]{4}", "flags": "i" }
  ]
}
```

Invalid configured patterns are ignored; defaults remain active. It has no
external assets, network requests, or scripts, and the extension does not log,
cache, transmit, or modify its source session. Protect or delete the generated
local HTML and its decision metadata as appropriate.

If no saved sessions exist, the catalog shows an empty-state message. Older
sessions with a missing or blank recorded location are grouped under **Unknown
location**.
