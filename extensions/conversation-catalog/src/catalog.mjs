const UNKNOWN_LOCATION = "Unknown location";
const UNTITLED_SESSION = "Untitled session";
const UNKNOWN_TIME = "Unknown time";
const MAX_FIRST_PROMPT_LENGTH = 200;

const CATALOG_STYLE = `
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --bg: #161923; --surface: #202536; --surface-raised: #292f43; --text: #e7eaf2; --muted: #aab2c9; --line: #3b4562; --blue: #7aa2f7; --aqua: #7dcfff; --green: #9ece6a; --focus: #e0af68; }
    * { box-sizing: border-box; }
    body { background: radial-gradient(circle at top right, #263552 0, var(--bg) 38rem); color: var(--text); margin: 0; min-width: 20rem; }
    .page { margin: 0 auto; max-width: 76rem; padding: clamp(1.25rem, 4vw, 4rem) clamp(1rem, 4vw, 2rem) 4rem; }
    .eyebrow { color: var(--aqua); font-size: .78rem; font-weight: 750; letter-spacing: .11em; margin: 0 0 .6rem; text-transform: uppercase; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: clamp(2rem, 5vw, 3.6rem); letter-spacing: -.04em; line-height: 1.05; margin-bottom: 1rem; max-width: 18ch; }
    h2 { font-size: clamp(1.25rem, 3vw, 1.7rem); letter-spacing: -.02em; }
    h3 { font-size: 1.08rem; line-height: 1.3; }
    .lede { color: var(--muted); font-size: 1.08rem; max-width: 68ch; }
    .privacy { border-left: .25rem solid var(--aqua); color: var(--muted); margin: 1.5rem 0 2.25rem; max-width: 74ch; padding-left: 1rem; }
    .privacy strong { color: var(--text); }
    .launcher { background: linear-gradient(135deg, #293a60, var(--surface)); border: 1px solid #5b75ae; border-radius: 1rem; box-shadow: 0 1.25rem 3.5rem #0004; margin: 0 0 3rem; padding: clamp(1.25rem, 3vw, 2rem); }
    .launcher h2 { margin-bottom: .55rem; }
    .launcher-copy { color: var(--muted); max-width: 65ch; }
    .command-row { align-items: stretch; display: flex; gap: .7rem; margin: 1.25rem 0 .85rem; max-width: 42rem; }
    .command-box { background: #111522; border: 1px solid #6a7da8; border-radius: .5rem; color: #f4f7ff; flex: 1; font: 600 1rem/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; min-width: 0; padding: .8rem .9rem; }
    button { background: var(--blue); border: 1px solid transparent; border-radius: .5rem; color: #101626; cursor: pointer; font: inherit; font-weight: 750; padding: .75rem 1rem; }
    button:hover { background: #a8c1ff; }
    button:focus-visible, input:focus-visible { outline: .2rem solid var(--focus); outline-offset: .18rem; }
    .copy-status { color: var(--muted); display: block; min-height: 1.5em; }
    .steps { color: var(--muted); margin: 1.2rem 0 .55rem; padding-left: 1.3rem; }
    .steps li { margin: .45rem 0; padding-left: .2rem; }
    .local-note { color: var(--muted); font-size: .94rem; margin-bottom: 0; }
    .catalog-heading { align-items: baseline; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: .5rem 1rem; justify-content: space-between; margin-bottom: 1rem; padding-bottom: .8rem; }
    .catalog-heading h2 { margin-bottom: 0; }
    .catalog-heading p, .empty { color: var(--muted); margin-bottom: 0; }
    .location-group { margin-top: 2.5rem; }
    .location-group > h2 { color: var(--aqua); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 1rem; overflow-wrap: anywhere; }
    .sessions { display: grid; gap: .85rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr)); }
    .session { background: var(--surface); border: 1px solid var(--line); border-radius: .75rem; display: flex; flex-direction: column; padding: 1.1rem; }
    .session h3 { margin-bottom: .9rem; overflow-wrap: anywhere; }
    dl { display: grid; gap: .6rem; margin: 0; }
    dl div { display: grid; gap: .2rem; grid-template-columns: 5.75rem minmax(0, 1fr); }
    dt { color: var(--muted); font-size: .82rem; font-weight: 700; } dd { margin: 0; overflow-wrap: anywhere; }
    .selection-hint { border-top: 1px solid var(--line); color: var(--muted); font-size: .89rem; margin: 1rem 0 0; padding-top: .8rem; }
    @media (max-width: 34rem) { .command-row { flex-direction: column; } button { min-height: 2.75rem; } dl div { grid-template-columns: 1fr; gap: .1rem; } }
`;

const CATALOG_SCRIPT = `
    (() => {
      const command = "/hindsight-document";
      const button = document.getElementById("copy-command");
      const commandBox = document.getElementById("hindsight-command");
      const status = document.getElementById("copy-status");
      const announce = (message) => { status.textContent = message; };
      const copyCommand = async () => {
        let copied = false;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          try {
            await navigator.clipboard.writeText(command);
            copied = true;
          } catch (_) {}
        }
        if (!copied) {
          try {
            commandBox.focus();
            commandBox.select();
            copied = document.execCommand("copy");
          } catch (_) {}
        }
        announce(copied
          ? "Command copied. Paste and run it in Pi to choose one conversation."
          : "Clipboard access is unavailable. Select and copy the command box, then run it in Pi.");
      };
      button.addEventListener("click", copyCommand);
    })();
`;

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boundedFirstPrompt(value) {
  const characters = Array.from(trimmedString(value));
  return characters.length > MAX_FIRST_PROMPT_LENGTH
    ? `${characters.slice(0, MAX_FIRST_PROMPT_LENGTH).join("")}…`
    : characters.join("");
}

function timestamp(value) {
  const date = value instanceof Date
    ? value
    : typeof value === "string" || typeof value === "number"
      ? new Date(value)
      : undefined;

  return date && Number.isFinite(date.getTime()) ? date.getTime() : Number.NEGATIVE_INFINITY;
}

function formatModified(value) {
  const time = timestamp(value);
  if (!Number.isFinite(time)) return UNKNOWN_TIME;
  return new Date(time).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/**
 * Reduces a SessionInfo-shaped value to the only metadata this catalog renders.
 * Session identifiers, paths, transcript text, and all other fields are intentionally ignored.
 */
export function normalizeSession(session) {
  const name = trimmedString(session?.name);
  const firstPrompt = boundedFirstPrompt(session?.firstMessage);
  const location = trimmedString(session?.cwd) || UNKNOWN_LOCATION;
  const messageCount = typeof session?.messageCount === "number" && Number.isFinite(session.messageCount)
    ? Math.max(0, Math.trunc(session.messageCount))
    : 0;

  return {
    title: name || firstPrompt || UNTITLED_SESSION,
    modified: formatModified(session?.modified),
    location,
    messageCount,
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Groups normalized session metadata by recorded working directory. */
export function groupSessions(sessions) {
  const grouped = new Map();

  for (const session of Array.isArray(sessions) ? sessions : []) {
    const metadata = normalizeSession(session);
    const record = { metadata, modifiedAt: timestamp(session?.modified) };
    const records = grouped.get(metadata.location) || [];
    records.push(record);
    grouped.set(metadata.location, records);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([location, records]) => ({
      location,
      sessions: records
        .sort((left, right) => right.modifiedAt - left.modifiedAt || compareText(left.metadata.title, right.metadata.title))
        .map(({ metadata }) => metadata),
    }));
}

/** Escapes untrusted saved-session metadata for HTML text and attribute contexts. */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Generates a complete browser-ready document from grouped, metadata-only sessions. */
export function generateCatalogHtml(groups) {
  const safeGroups = Array.isArray(groups) ? groups : [];
  const groupContent = safeGroups.length === 0
    ? '<p class="empty">No saved Pi sessions were found.</p>'
    : safeGroups.map((group) => {
      const location = escapeHtml(group.location);
      const rows = group.sessions.map((session) => `
          <article class="session">
            <h3>${escapeHtml(session.title)}</h3>
            <dl>
              <div><dt>Modified</dt><dd>${escapeHtml(session.modified)}</dd></div>
              <div><dt>Location</dt><dd>${escapeHtml(session.location)}</dd></div>
              <div><dt>Messages</dt><dd>${escapeHtml(session.messageCount)}</dd></div>
            </dl>
            <p class="selection-hint">Use these displayed details to recognize a conversation. Selection happens in Pi&apos;s picker, not on this page.</p>
          </article>`).join("");
      return `
        <section class="location-group">
          <h2>${location}</h2>
          <div class="sessions">${rows}
          </div>
        </section>`;
    }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-onBugW2/p9HyUiPftMZz9921eQyU1dh6rWhvpRjLYu0='; style-src 'sha256-26flaycL+su2Kw9JGO2o0lzto0A1/7wEZDQbqocS2Dw='; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <title>Pi conversation catalog</title>
  <style>${CATALOG_STYLE}</style>
</head>
<body>
  <div class="page">
    <header>
      <p class="eyebrow">Local, read-only metadata view</p>
      <h1>Pi conversation catalog</h1>
      <p class="lede">Browse saved conversations by the small set of details that helps you recognize one without opening its content.</p>
      <p class="privacy"><strong>Privacy boundary:</strong> this page renders only a title or bounded first-prompt fallback, recorded location, modified time, and message count. It does not include transcripts, raw session data, stored paths, or session identifiers.</p>
    </header>
    <section class="launcher" aria-labelledby="hindsight-launcher-title">
      <p class="eyebrow">Next step</p>
      <h2 id="hindsight-launcher-title">Generate a hindsight report</h2>
      <p class="launcher-copy">After you recognize a conversation from its metadata, copy this command and run it in Pi.</p>
      <div class="command-row">
        <input class="command-box" id="hindsight-command" type="text" value="/hindsight-document" readonly aria-label="Hindsight command">
        <button id="copy-command" type="button">Copy command</button>
      </div>
      <span id="copy-status" class="copy-status" role="status" aria-live="polite"></span>
      <ol class="steps">
        <li>Browse/identify a session here.</li>
        <li>Copy/run <strong>/hindsight-document</strong> in Pi.</li>
        <li>Select exactly one session and finish the redaction review.</li>
      </ol>
      <p class="local-note">A static local page cannot run Pi commands. Selection and redaction stay in Pi.</p>
    </section>
    <main aria-labelledby="catalog-title">
      <div class="catalog-heading">
        <h2 id="catalog-title">Saved conversations</h2>
        <p>Metadata only · grouped by recorded location</p>
      </div>${groupContent}
    </main>
  </div>
  <script>${CATALOG_SCRIPT}</script>
</body>
</html>`;
}
