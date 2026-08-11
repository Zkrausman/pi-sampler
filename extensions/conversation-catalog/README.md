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
`pi-conversation-flow-<session-id>.html`. The command uses Pi's
`SessionManager.open()` for the selected saved session; it does not parse or
modify JSONL logs itself.

The flow document shows every persisted entry from all branches in timestamp
order. Colored cards distinguish user, assistant, tool-call, tool-result,
skill, and unsupported activity. Visible arrow links connect entry parents,
matched tool calls to results, and a result to the next chronological assistant
entry. The latter is labeled as a chronological inference and can cross a
branch. Missing correlations, malformed entries, images, thinking, and unknown
content are kept compact or marked unsupported rather than preventing output.

## Privacy and behavior

The catalog groups sessions by their recorded working directory/run location.
Each row shows only an identifying title (the saved name, or a bounded first
prompt fallback), modified timestamp, location, and message count.
`SessionManager.listAll()` may parse source session logs internally as required
by Pi, but the catalog neither renders, serializes, logs, caches, nor transmits
transcript text or raw session JSON; it never changes a source session log.

A flow is intentionally different: it is produced only by the explicit
`/conversation-flow` request and contains bounded text from the selected local
conversation, including tool-result text that may contain sensitive material.
It has no external assets, network requests, or scripts, and the extension does
not log, cache, transmit, or modify its source session. Protect or delete the
generated local HTML as appropriate.

If no saved sessions exist, the catalog shows an empty-state message. Older
sessions with a missing or blank recorded location are grouped under **Unknown
location**.
