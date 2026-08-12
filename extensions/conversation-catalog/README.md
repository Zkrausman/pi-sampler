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
/conversation-flow <session-id> [output-path]
/conversation-map <session-id> [output-path]
/hindsight-document [output-path]
```

`/conversation-catalog` writes a read-only catalog of session metadata.

`/conversation-flow` and `/conversation-map` open exactly one saved session through Pi, require an interactive redaction review, and write a standalone HTML file plus a sibling `.redaction.json` companion. The companion records only pseudonymous citation and redaction decisions, never source text or raw session identifiers.

`/hindsight-document` asks you to select exactly one saved conversation, requires the same redaction review, and submits only the reviewed/redacted evidence to the active model. The model can call one safe structured writer with claims, optional story steps, and recommendations. The extension validates and escapes that structure, then generates reader-first HTML with a table of contents, summary, context, top three actions, timeline, strengths, lessons, and a closed cited-evidence appendix. Citations link locally to embedded redacted source context. An excluded conversation produces only a content-free redaction fallback.

All output paths are relative to Pi's current working directory unless absolute and must end in `.html`. Generated HTML is standalone, CSP-restricted, and contains no remote assets. Protect or delete local HTML and redaction metadata when no longer needed.
