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
/hindsight-document [--validate-claim-support] [output-path]
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

`/hindsight-document` temporarily provides a single-select workflow across recorded conversations. Select exactly one conversation and review its redactions or exclude it; the command does not accept or silently choose among multiple conversations. An excluded conversation produces a pseudonymous, navigable redaction-review fallback with no conversation content. The active model submits structured claims and recommendations to the extension's safe report contract; it does not write report HTML directly. The contract validates, bounds, and escapes model text and generates every citation anchor, embedded redacted source-context section, and available flow/relationship-map context. Every material claim and recommendation must cite included evidence from the selected conversation. Excluded conversations remain navigable only as explicit redaction-review fallbacks, and neither fallbacks nor citations reveal a raw session/event ID or unredacted text.

Pass `--validate-claim-support` to opt into a separate model-validation pass after the draft is structurally accepted. The extension gives that pass only each claim and its own cited, redacted excerpts; it cannot add evidence, cite another included excerpt, access excluded text, or alter the accepted claims or recommendations. It must classify every material claim as `supported`, `partially supported`, `unsupported`, or `unverifiable`, cite exactly that claim's references, and provide a bounded rationale explaining that classification. The report labels this output as **model-generated validation**, never a user-confirmed disposition. Excluded-conversation fallbacks have no material generated claims, so they render without a validation assessment.

### Hindsight recommendation contract

A model recommendation is accepted only when it contains a bounded action,
`priority` (`critical`, `high`, `medium`, or `low`), `expectedImpact`,
`suggestedOwner`, a `dependencies` array, one or more measurable
`acceptanceCriteria`, and included `evidenceReferences`. It must also set
`status` to `proposed` and `source` to `model-suggestion`. Those fixed values
make it explicit that the report is a model suggestion, **not user-confirmed**;
the safe writer does not accept a model assertion that a user confirmed an
owner, dependency, or recommendation. Malformed recommendations are rejected,
not completed with invented values.

The report renders accepted recommendations in a captioned, keyboard-scrollable
table with priority, impact, owner, dependencies, acceptance criteria,
provenance, and evidence columns. When none are supplied, it renders a clear
fallback instead. Owner and dependency strings are model output derived only
from the reviewed, redacted source bundle; they are not read from, copied to,
or persisted outside the generated cited report.

### Local recommendation dispositions

For every generated recommendation, the standalone report provides native,
keyboard-accessible **Accept**, **Defer**, and **Reject** controls plus a
required rationale. The model suggestion (`proposed · model-suggestion`) stays
visible and separate from the local, **user-confirmed** disposition; selecting
one never changes the recommendation, its pseudonymous citations, or the
source session.

Saving a disposition uses browser local storage only. **Export disposition
metadata JSON** downloads a local JSON record containing the original approved
recommendation text, its pseudonymous evidence references, the model
provenance, and the user-confirmed disposition/rationale. It makes no network
request. At report generation, the extension also writes a sibling
`<report-name>.dispositions.json` model-suggestion seed with no user decision.
If a report write fails, an existing companion seed is preserved. Keep exported
metadata with the report as appropriate and do not treat the initial seed as a
user decision.

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
