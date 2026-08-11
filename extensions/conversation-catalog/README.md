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
```

With no argument, the command writes
`pi-conversation-catalog.html` in Pi's current working directory. A supplied
path is resolved relative to that directory unless absolute, must end in
`.html`, and may include a new parent directory, which the command creates.
Existing HTML output at that path is replaced. Pi reports the absolute output
path when complete; open that local `.html` file directly in a browser.

## Privacy and behavior

The catalog groups sessions by their recorded working directory/run location.
Each row shows only an identifying title (the saved name, or a bounded first
prompt fallback), modified timestamp, location, and message count.
`SessionManager.listAll()` may parse source session logs internally as required
by Pi, but the extension neither renders, serializes, logs, caches, nor
transmits transcript text or raw session JSON; it never changes a source
session log.

If no saved sessions exist, the document shows an empty-state message. Older
sessions with a missing or blank recorded location are grouped under **Unknown
location**.
