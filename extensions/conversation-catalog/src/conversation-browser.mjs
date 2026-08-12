const UNKNOWN_LOCATION = "Unknown location";
const UNTITLED_SESSION = "Untitled session";
const UNKNOWN_TIME = "Unknown time";
const MAX_FIRST_PROMPT_LENGTH = 200;

const text = (value) => typeof value === "string" ? value.trim() : "";
const bounded = (value, fallback = "", max = 4000) => {
  const chars = Array.from(text(value));
  return chars.length ? (chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("")) : fallback;
};
const timeValue = (value) => {
  const date = value instanceof Date ? value : (typeof value === "string" || typeof value === "number" ? new Date(value) : undefined);
  return date && Number.isFinite(date.getTime()) ? date.getTime() : Number.NEGATIVE_INFINITY;
};
const formatTime = (value) => {
  const timestamp = timeValue(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : UNKNOWN_TIME;
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Reduces a saved session to metadata used only inside Pi's interactive browser. */
export function browserSession(session, index = 0) {
  const name = text(session?.name);
  const prompt = bounded(session?.firstMessage, "", MAX_FIRST_PROMPT_LENGTH);
  const id = text(session?.id);
  return {
    key: index,
    id,
    title: name || prompt || UNTITLED_SESSION,
    location: text(session?.cwd) || UNKNOWN_LOCATION,
    modified: formatTime(session?.modified),
    messageCount: typeof session?.messageCount === "number" && Number.isFinite(session.messageCount) ? Math.max(0, Math.trunc(session.messageCount)) : 0,
  };
}

export function browserLabel(session, index = 0) {
  const item = browserSession(session, index);
  return `${index + 1}. ${item.title} — ${item.location} · ${item.modified} · ${item.messageCount} messages · ID ${item.id || "unavailable"}`;
}

/** Resolves only an exact ID obtained from the current local SessionManager listing. */
export function sessionById(sessions, sessionId) {
  const requested = text(sessionId);
  if (!requested || !Array.isArray(sessions)) return undefined;
  const matches = sessions.filter((session) => text(session?.id) === requested);
  return matches.length === 1 ? matches[0] : undefined;
}

/** A local command handoff. It contains no filesystem path. */
export function hindsightCommand(sessionId, outputPath = "") {
  const id = text(sessionId);
  if (!id) throw new Error("A selected conversation identifier is required.");
  const output = text(outputPath);
  return `/hindsight-document ${id}${output ? ` ${output}` : ""}`;
}

/** Resolves new exact-ID syntax while retaining legacy HTML output paths. */
export function resolveHindsightRequest(sessions, request = {}) {
  const session = sessionById(sessions, request?.sessionId);
  if (session) return { session, outputPath: text(request?.outputPath), unavailable: false };
  const raw = text(request?.raw) || text(request?.outputPath);
  if (raw && /\.html$/i.test(raw)) return { session: undefined, outputPath: raw, unavailable: false };
  return { session: undefined, outputPath: "", unavailable: Boolean(text(request?.sessionId)) };
}

function json(value, fallback) {
  try { return JSON.stringify(value, null, 2); } catch { return fallback; }
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!object(block)) return "[Unsupported content]";
    if (block.type === "text") return typeof block.text === "string" ? block.text : "";
    if (block.type === "thinking") return "[Thinking omitted]";
    if (block.type === "image") return "[Image omitted]";
    if (block.type === "toolCall") return `Tool call: ${text(block.name) || "Unnamed tool"}\n${json(block.arguments, "[Tool arguments unavailable]")}`;
    return `[${text(block.type) || "Unsupported"} content omitted]`;
  }).filter(Boolean).join("\n\n");
}

/**
 * Formats saved content only for a local interactive editor. It is never sent
 * to the model, written to a report, or persisted by this extension.
 */
export function formatConversationForLocalRead(entries) {
  const sections = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const message = object(entry?.message) ? entry.message : undefined;
    const timestamp = formatTime(entry?.timestamp || message?.timestamp);
    if (message?.role === "user" || message?.role === "assistant" || message?.role === "toolResult" || message?.role === "custom") {
      const label = message.role === "toolResult" ? `Tool result: ${text(message.toolName) || "Unnamed tool"}` : message.role[0].toUpperCase() + message.role.slice(1);
      const body = contentText(message.content);
      if (body) sections.push(`## ${label} — ${timestamp}\n\n${body}`);
      continue;
    }
    if (message?.role === "bashExecution") {
      sections.push(`## Bash — ${timestamp}\n\n$ ${text(message.command)}\n\n${text(message.output)}`);
      continue;
    }
    if (entry?.type === "compaction" && text(entry.summary)) sections.push(`## Compaction summary — ${timestamp}\n\n${text(entry.summary)}`);
    if (entry?.type === "branch_summary" && text(entry.summary)) sections.push(`## Branch summary — ${timestamp}\n\n${text(entry.summary)}`);
  }
  return sections.join("\n\n---\n\n") || "No readable conversation messages were found.";
}
