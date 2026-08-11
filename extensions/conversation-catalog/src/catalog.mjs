const UNKNOWN_LOCATION = "Unknown location";
const UNTITLED_SESSION = "Untitled session";
const UNKNOWN_TIME = "Unknown time";
const MAX_FIRST_PROMPT_LENGTH = 200;

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
 * Session paths, transcript text, and all other fields are intentionally ignored.
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
    const record = {
      metadata,
      modifiedAt: timestamp(session?.modified),
      id: trimmedString(session?.id),
    };
    const records = grouped.get(metadata.location) || [];
    records.push(record);
    grouped.set(metadata.location, records);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([location, records]) => ({
      location,
      sessions: records
        .sort((left, right) => right.modifiedAt - left.modifiedAt || compareText(left.id, right.id))
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
        </article>`).join("");
      return `
      <section class="location-group">
        <h2>${location}</h2>${rows}
      </section>`;
    }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi conversation catalog</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 72rem; padding: 2rem; line-height: 1.45; }
    h1 { margin-bottom: .25rem; }
    .intro, .empty { color: #666; }
    .location-group { border-top: 1px solid #9996; margin-top: 2rem; padding-top: 1rem; }
    .session { border: 1px solid #9996; border-radius: .4rem; margin: .75rem 0; padding: 1rem; }
    .session h3 { margin: 0 0 .75rem; overflow-wrap: anywhere; }
    dl { display: grid; gap: .5rem; margin: 0; }
    dl div { display: grid; gap: .25rem; grid-template-columns: 7rem minmax(0, 1fr); }
    dt { font-weight: 700; } dd { margin: 0; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <header>
    <h1>Pi conversation catalog</h1>
    <p class="intro">Saved sessions grouped by recorded run location.</p>
  </header>
  <main>${groupContent}
  </main>
</body>
</html>`;
}
