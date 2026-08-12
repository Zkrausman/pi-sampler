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

All output paths are relative to Pi's current working directory unless absolute and must end in `.html`. Generated HTML is standalone, CSP-restricted, and contains no remote assets. Protect or delete local HTML when no longer needed.
