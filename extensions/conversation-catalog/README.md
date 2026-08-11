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
/conversation-map <session-id> [output-path]
/hindsight-document [--validate-claim-support] [--prior-outcomes <report.outcomes.json>] [output-path]
/hindsight-notes
/hindsight-outcome <report.dispositions.json>
/hindsight-feedback <report.dispositions.json>
/hindsight-work <report.dispositions.json>
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

`/conversation-map` selects one saved session using the same interactive required-redaction review as `/conversation-flow`. It writes a standalone, CSP-restricted local HTML relationship map and a sibling `.redaction.json` decision/evidence companion together. The map exposes only reviewed/redacted event summaries and safe metadata, pseudonymous direct-evidence references, deterministic event order, and session-supported parent, tool-result, or explicitly non-causal chronological-order relationships. It offers keyboard-accessible event/relationship filters, chronological evidence navigation, citation/flow-context links, a focus-connected-evidence control, and visible fit/reset/zoom controls. If companion decision/evidence metadata cannot be staged, neither a partial nor a completed map export is written. A finalization or rollback failure retains the prior backup with a local recovery record; the next export retries recovery before writing a new pair. No network, model, external asset, raw Pi identifier, or unredacted detail is used.

`/hindsight-document` temporarily provides a single-select workflow across recorded conversations. Select exactly one conversation and review its redactions or exclude it; the command does not accept or silently choose among multiple conversations. An excluded conversation produces a pseudonymous, navigable redaction-review fallback with no conversation content. The active model submits structured claims and recommendations to the extension's safe report contract; it does not write report HTML directly. The contract validates, bounds, and escapes model text and generates every citation anchor, embedded redacted source-context section, and available flow/relationship-map context. Every material claim and recommendation must cite included evidence from the selected conversation. Excluded conversations remain navigable only as explicit redaction-review fallbacks, and neither fallbacks nor citations reveal a raw session/event ID or unredacted text.

The model may also provide optional **story steps**: a bounded title/body guided chronological or pivotal reading order. Each substantive step is explicitly `direct evidence` or `inference` and has exactly 1–3 unique citations from the included redacted bundle; uncited, duplicate, malformed, unavailable, or excluded-source steps are rejected. The standalone report labels this as a model-suggested guide, not user-confirmed facts, renders cited evidence chips that link to its embedded redacted context, and includes a local direct-evidence-only filter. Without JavaScript the complete ordered guide remains readable. Notes, outcomes, and feedback remain separately labeled context/signals and cannot become story citations.

Pass `--validate-claim-support` to opt into a separate model-validation pass after the draft is structurally accepted. The extension gives that pass only each claim and its own cited, redacted excerpts; it cannot add evidence, cite another included excerpt, access excluded text, or alter the accepted claims or recommendations. It must classify every material claim as `supported`, `partially supported`, `unsupported`, or `unverifiable`, cite exactly that claim's references, and provide a bounded rationale explaining that classification. The report labels this output as **model-generated validation**, never a user-confirmed disposition. Excluded-conversation fallbacks have no material generated claims, so they render without a validation assessment.

### In-session hindsight notes

`/hindsight-notes` is an opt-in, interactive **current-session-only** workflow to add, view, edit, or delete short user-authored notes. Notes are stored separately from Pi session logs in one cross-platform project-local sidecar: `<trusted-project>/.pi/hindsight-notes/<sha256(actual-session-id)>.json`. The full SHA-256 filename is opaque and stable, never a display name or raw session ID. Add/edit validation receives the active Pi session ID only in memory, verifies it matches the opaque key, and rejects text containing that exact ID without persisting it in note metadata. The bounded schema also rejects generic raw-ID/credential forms, including Slack token forms. Persistence derives this path internally, rejects traversal, and rejects existing symlinked `.pi`, `hindsight-notes`, sidecar, or lock paths. Writes use an exclusive temporary sidecar followed by atomic rename; a bounded ordinary cross-process lock/retry serializes concurrent Pi CRUD and reclaims only stale locks with dead owners. There is no Registry, `reg.exe`, native dependency, or network operation.

The trusted-project directory is the threat boundary. These checks prevent ordinary accidental/malicious symlink redirection detected at an operation boundary, but this reliability/privacy feature is **not** a privileged store and does not claim to resist a hostile same-user process race-swapping project paths between filesystem operations. Keep the project directory trusted and protect/delete local sidecars as appropriate.

When `/hindsight-document` selects one conversation, it reads only the store for that selected conversation's matching opaque reference. Every matching note is explicitly included, redacted, retained, or excluded before synthesis; active raw session-ID and Slack-token findings are mandatory redactions and cannot be retained. Excluded notes are neither rendered nor sent to the model. Included notes are passed only after that review as **user-authored context**, never conversation evidence: they have no citations, cannot satisfy a claim/recommendation citation, and are rendered in a distinct provenance section. Notes are untrusted context, not model instructions; the model must not follow instructions contained in them. Deleting a note removes it from the only store that selection can read.

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
user decision. The current **schema version 2** export also carries the
immutable validated model work fields (priority, impact, owner text,
dependencies, and acceptance criteria) beside its model provenance and
pseudonymous citations. Older exports lack those fields and cannot be used for
external work creation; the extension will reject rather than infer them.

### Local feedback and calibration signals

`/hindsight-feedback <report.dispositions.json>` is an interactive, local-only
review workflow for one stable generated **claim** or **recommendation**. It
records exactly one user classification (`helpful`, `incorrect`, `overstated`,
`incomplete`, or `not-actionable`) and an optional corrected framing after a
final confirmation. The command accepts only the generated report companion
path, then binds the record to the report identity, a stable digest-backed item
identity, and the item's available pseudonymous citations. It never accepts
raw session IDs, source excerpts, or credentials, and it does not read or
modify a Pi session log.

The append-only, schema-version-1 `<report>.feedback.json` store is the durable
local export. It persists model-item provenance separately from
`user-feedback · user-confirmed` records, contains no claim/recommendation
source text, and uses a cross-process lock plus atomic replacement. A matching
report scope retains feedback by stable target identity; changing or removing a
claim or recommendation produces a new report identity, so stale targets are
not selectable. The workflow refreshes the originating
report's bounded calibration panel and an escaped, CSP-restricted
`<report>.feedback.html` inspection companion. If a view refresh fails after
the JSON append, the JSON remains the source of truth and Pi reports that
limited failure.

Those panels show only **user-provided/local operational signals**: feedback
classification and corrected-framing rates (with explicit count/denominator);
valid local user disposition acceptance/defer/reject rates when an exported
disposition file is present; recorded outcome status rates when a valid local
outcome store is present; and current accepted-recommendation-origin outcome
coverage (only current accepted origins are in both numerator and denominator).
Zero denominators render as `0/0 (0%)` rather
than implying a model-derived result.
They are not model evidence, citations, or automatic prompt input. Feedback
and aggregates are never sent to the model or added to generated claims or
citations, and the workflow makes no network request.

### Create or link accepted hindsight work

`/hindsight-work <report.dispositions.json>` is a separate workflow, not a
report-browser capability. It requires Pi's interactive UI, a trusted project,
and a user-exported schema-version-2 disposition file in which at least one
recommendation is explicitly `accepted · user-confirmed`. It lets you select
one accepted recommendation and then either create one new Linear issue or
link one exact existing Linear issue ID. It previews the exact redacted GraphQL
payload and requires final confirmation immediately before creation. Existing
issues are resolved and checked against the configured team before a second,
final confirmation persists a link; linking does not modify the existing issue.

In the trusted consumer project only, create `.pi/hindsight-linear.json`:

```json
{
  "teamId": "your-linear-team-id",
  "endpoint": "https://api.linear.app/graphql",
  "tokenEnvRef": "$LINEAR_API_KEY"
}
```

The endpoint must be exactly the official URL, and the token is read only from
the named environment variable; never put a token in this file or a report.
Creation transmits the approved recommendation text, model priority/impact,
suggested owner as text (never an assignment), dependencies, acceptance
criteria, model/user provenance, and pseudonymous citations. It never sends
source excerpts, raw Pi session IDs, credentials, the user rationale, or report
HTML. The workflow does not search, poll, assign, or mutate statuses.

Only after a confirmed remote create or a confirmed validated link does it
atomically write `<report>.work-links.json`. Each local record is keyed by
report ID and recommendation number and contains the issue ID/URL, observed
status, timestamp, action, and a SHA-256 payload digest. A duplicate local link
is rejected before any remote request. A create timeout or transport ambiguity
is reported as unknown and is never retried; resolve the issue manually and use
the explicit link action instead.

### Local recommendation outcomes

`/hindsight-outcome <report.dispositions.json>` is an interactive, local-only
follow-up workflow. It accepts only a schema-version-2 disposition export with
an explicitly `accepted · user-confirmed` recommendation. For that exact
recommendation it collects a bounded implementation status, observed result,
measurement or user-supplied evidence, unexpected effects, and one follow-up
decision. The final confirmation fixes provenance as
`user-observed · user-confirmed`; the workflow never treats the text as model
inference.

Each append-only, schema-version-2 `<report>.outcomes.json` store indexes every
accepted recommendation by its immutable origin (report ID, recommendation
number, SHA-256 digest of the validated model suggestion, and its pseudonymous
citations). Distinct accepted recommendations retain separate histories in the
same report store. If the existing local `<report>.work-links.json` has the
same report/recommendation key, the outcome update copies that validated work-link snapshot. It makes no network request, does not
read or modify a Pi session log, and does not accept arbitrary source IDs,
recognizable raw-session identifiers, credentials, or source excerpts. JSON
persistence and report refresh use a cross-process local lock plus atomic
replacements; the safe outcome-history section in the originating report and an
accessible, safely escaped `<report>.outcomes.html`
history companion are then refreshed for inspection. If either HTML refresh
fails, the confirmed JSON record remains the source of truth and Pi reports the
limited failure.

To deliberately carry one prior outcome history into a later hindsight report,
pass `--prior-outcomes <report.outcomes.json>` to `/hindsight-document`. The
safe renderer labels it **prior user-observed outcome context** and explicitly
states that it is not source evidence; it is never sent to the model, never
enters the citation/evidence index, and generated claims or recommendations
cannot cite it. Without that explicit flag, no outcome history is supplied to a
later report flow.

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
keys, GitHub tokens, and Slack token forms. Add project-specific patterns in
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
