import { escapeHtml } from "./catalog.mjs";

const MAX_SUMMARY_LENGTH = 480;
const UNKNOWN_TIME = "Unknown time";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function bounded(value, fallback = "No readable content", maxLength = MAX_SUMMARY_LENGTH) {
  const characters = Array.from(text(value));
  if (characters.length === 0) return fallback;
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength).join("")}…`
    : characters.join("");
}

function timeValue(value) {
  const date = value instanceof Date ? value : (typeof value === "string" || typeof value === "number" ? new Date(value) : undefined);
  return date && Number.isFinite(date.getTime()) ? date.getTime() : Number.NEGATIVE_INFINITY;
}

function formatTime(value) {
  const parsed = timeValue(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : UNKNOWN_TIME;
}

function safeToken(value) {
  const token = text(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60);
  return token || "entry";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSkill(value) {
  return /skill/i.test(text(value));
}

function argumentSummary(argumentsValue) {
  if (typeof argumentsValue === "string") return bounded(argumentsValue, "Arguments omitted");
  if (!isObject(argumentsValue)) return "Arguments omitted";
  try {
    return bounded(JSON.stringify(argumentsValue), "Arguments omitted");
  } catch {
    return "Arguments omitted";
  }
}

function contentSummary(content, fallback) {
  if (typeof content === "string") return bounded(content, fallback);
  if (!Array.isArray(content)) return fallback;

  const parts = [];
  for (const block of content) {
    if (!isObject(block)) {
      parts.push("[Unsupported content]");
    } else if (block.type === "text") {
      parts.push(text(block.text));
    } else if (block.type === "thinking") {
      parts.push("[Thinking omitted]");
    } else if (block.type !== "toolCall") {
      parts.push(`[${bounded(block.type, "Unsupported", 80)} content omitted]`);
    }
  }
  return bounded(parts.filter(Boolean).join(" "), fallback);
}

function metadata(entry, message, extras = []) {
  const values = [];
  const add = (label, value) => {
    const cleaned = text(value);
    if (cleaned) values.push({ label, value: bounded(cleaned, "", 160) });
  };
  add("Entry", entry.id);
  add("Parent", entry.parentId);
  add("Role", message?.role);
  add("Provider", message?.provider);
  add("Model", message?.model);
  return values.concat(extras);
}

function eventFor(entry, sourceIndex, category, title, summary, message, extras) {
  const entryId = text(entry.id);
  return {
    id: `event-${sourceIndex}-${safeToken(entryId)}`,
    entryId,
    parentId: text(entry.parentId),
    sourceIndex,
    timestampValue: timeValue(entry.timestamp),
    timestamp: formatTime(entry.timestamp),
    category,
    title,
    summary: bounded(summary),
    metadata: metadata(entry, message, extras),
  };
}

/**
 * Converts Pi SessionEntry-shaped values into a compact chronological audit view.
 * All persisted branches are shown. The "next assistant" connection is a labeled,
 * chronological inference rather than a claim about tree-branch causality.
 */
export function projectConversation(entries) {
  const ordered = (Array.isArray(entries) ? entries : [])
    .map((entry, sourceIndex) => ({ entry: isObject(entry) ? entry : {}, sourceIndex }))
    .sort((left, right) => timeValue(left.entry.timestamp) - timeValue(right.entry.timestamp) || left.sourceIndex - right.sourceIndex);
  const events = [];
  const primaryByEntryId = new Map();
  const callsById = new Map();
  const results = [];

  for (const { entry, sourceIndex } of ordered) {
    const message = isObject(entry.message) ? entry.message : undefined;
    let primary;
    if (entry.type !== "message" || !message) {
      const customType = text(entry.customType) || text(message?.customType);
      const category = isSkill(customType) ? "skill" : "unsupported";
      primary = eventFor(entry, sourceIndex, category, category === "skill" ? "Skill activity" : "Unsupported entry", contentSummary(entry.content, "This entry cannot be rendered as a Pi message."), message, customType ? [{ label: "Custom type", value: bounded(customType) }] : []);
      events.push(primary);
    } else if (message.role === "user") {
      primary = eventFor(entry, sourceIndex, "user", "User", contentSummary(message.content, "User message has no readable text."), message);
      events.push(primary);
    } else if (message.role === "assistant") {
      primary = eventFor(entry, sourceIndex, "assistant", "Assistant", contentSummary(message.content, "Assistant message has no readable text."), message);
      events.push(primary);
      const blocks = Array.isArray(message.content) ? message.content : [];
      let toolIndex = 0;
      for (const block of blocks) {
        if (!isObject(block) || block.type !== "toolCall") continue;
        const callId = text(block.id);
        const toolName = text(block.name) || "Unnamed tool";
        const category = isSkill(toolName) ? "skill" : "tool-call";
        const tool = eventFor(entry, sourceIndex, category, category === "skill" ? "Skill tool call" : "Tool call", bounded(toolName), message, [
          { label: "Tool", value: bounded(toolName) },
          ...(callId ? [{ label: "Call ID", value: bounded(callId) }] : []),
          { label: "Arguments", value: argumentSummary(block.arguments) },
        ]);
        tool.id = `${primary.id}-call-${toolIndex++}`;
        tool.callId = callId;
        events.push(tool);
        if (callId && !callsById.has(callId)) callsById.set(callId, tool);
      }
    } else if (message.role === "toolResult") {
      const callId = text(message.toolCallId);
      const toolName = text(message.toolName) || "Unnamed tool";
      const category = isSkill(toolName) ? "skill" : "tool-result";
      primary = eventFor(entry, sourceIndex, category, category === "skill" ? "Skill result" : "Tool result", contentSummary(message.content, "Tool result has no readable text."), message, [
        { label: "Tool", value: bounded(toolName) },
        ...(callId ? [{ label: "Call ID", value: bounded(callId) }] : []),
        ...(message.isError === true ? [{ label: "Status", value: "Error" }] : []),
      ]);
      primary.callId = callId;
      primary.isResult = true;
      events.push(primary);
      results.push(primary);
    } else if (message.role === "custom" && isSkill(message.customType)) {
      primary = eventFor(entry, sourceIndex, "skill", "Skill activity", contentSummary(message.content, "Skill activity has no readable text."), message, [{ label: "Custom type", value: bounded(message.customType) }]);
      events.push(primary);
    } else {
      primary = eventFor(entry, sourceIndex, "unsupported", "Unsupported message", contentSummary(message.content, "This message role is not supported."), message);
      events.push(primary);
    }
    primary.isPrimary = true;
    if (primary.entryId && !primaryByEntryId.has(primary.entryId)) primaryByEntryId.set(primary.entryId, primary);
  }

  events.forEach((event, order) => { event.order = order; });
  const edges = [];
  const seen = new Set();
  const addEdge = (from, to, label) => {
    if (!from || !to || from.id === to.id) return;
    const key = `${from.id}|${to.id}|${label}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({ from: from.id, to: to.id, label });
    }
  };
  for (const event of events) {
    if (event.isPrimary && event.parentId) addEdge(primaryByEntryId.get(event.parentId), event, "parent entry");
  }
  for (const result of results) {
    const call = result.callId ? callsById.get(result.callId) : undefined;
    if (call) addEdge(call, result, "tool result");
    else result.metadata.push({ label: "Connection", value: "No matching tool call" });

    const nextAssistant = events.find((event) => event.category === "assistant" && event.order > result.order);
    if (nextAssistant) addEdge(result, nextAssistant, "next assistant (chronological)");
    else result.metadata.push({ label: "Next response", value: "No later assistant entry" });
  }
  return { events, edges };
}

function renderMetadata(values) {
  return values.length === 0 ? "" : `<dl class="event-meta">${values.map(({ label, value }) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

/** Generates a script-free standalone conversation-flow document from projected events. */
export function generateConversationFlowHtml(session, projection) {
  const events = Array.isArray(projection?.events) ? projection.events : [];
  const edges = Array.isArray(projection?.edges) ? projection.edges : [];
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }
  const sessionTitle = bounded(session?.name || session?.id, "Pi conversation");
  const sessionId = text(session?.id) || "Unknown session";
  const cards = events.length === 0
    ? '<p class="empty">No renderable conversation entries were found.</p>'
    : events.map((event, index) => {
      const links = (outgoing.get(event.id) || []).map((edge) => `<a class="connector" href="#${escapeHtml(edge.to)}">→ ${escapeHtml(edge.label)}</a>`).join("");
      return `<article id="${escapeHtml(event.id)}" class="event event-${escapeHtml(event.category)}">
        <div class="event-head"><span class="sequence">${index + 1}</span><span class="kind">${escapeHtml(event.category.replace(/-/g, " "))}</span><time>${escapeHtml(event.timestamp)}</time></div>
        <h2>${escapeHtml(event.title)}</h2><p class="summary">${escapeHtml(event.summary)}</p>
        ${renderMetadata(Array.isArray(event.metadata) ? event.metadata : [])}
        ${links ? `<nav class="connections" aria-label="Related events">${links}</nav>` : ""}
      </article>`;
    }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi conversation flow — ${escapeHtml(sessionTitle)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 70rem; padding: 2rem; line-height: 1.45; }
    h1 { margin-bottom: .2rem; } .intro, .empty { color: #666; }
    .legend { display: flex; flex-wrap: wrap; gap: .4rem; margin: 1rem 0 1.5rem; }
    .legend span, .kind { border-radius: 999px; font-size: .8rem; font-weight: 700; padding: .15rem .55rem; text-transform: capitalize; }
    .timeline { border-left: 3px solid #7898; display: grid; gap: 1rem; padding-left: 1.25rem; }
    .event { border: 1px solid #9997; border-left: .55rem solid #777; border-radius: .45rem; padding: .8rem 1rem; scroll-margin-top: 1rem; }
    .event-user { border-left-color: #2c78c4; } .event-assistant { border-left-color: #5b9b54; } .event-tool-call { border-left-color: #a66b12; } .event-tool-result { border-left-color: #815ab5; } .event-skill { border-left-color: #a43c72; } .event-unsupported { border-left-color: #777; }
    .event-head { align-items: center; display: flex; flex-wrap: wrap; gap: .45rem; color: #666; font-size: .85rem; } .sequence { font-weight: 700; }
    .event h2 { font-size: 1rem; margin: .55rem 0 .25rem; overflow-wrap: anywhere; } .summary { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .event-meta { display: grid; gap: .25rem; margin: .7rem 0 0; } .event-meta div { display: grid; gap: .5rem; grid-template-columns: 7rem minmax(0, 1fr); } dt { font-weight: 700; } dd { margin: 0; overflow-wrap: anywhere; }
    .connections { border-top: 1px dashed #9998; display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; padding-top: .55rem; } .connector { color: inherit; font-size: .85rem; font-weight: 700; text-decoration: none; } .connector:hover, .connector:focus { text-decoration: underline; }
  </style>
</head>
<body>
  <header><h1>Pi conversation flow</h1><p class="intro">Session ${escapeHtml(sessionId)}. All persisted entries are shown in timestamp order; “next assistant” links are chronological inferences and may cross branches.</p>
    <div class="legend" aria-label="Event types"><span>user</span><span>assistant</span><span>tool call</span><span>tool result</span><span>skill</span><span>unsupported</span></div>
  </header>
  <main class="timeline">${cards}</main>
</body>
</html>`;
}
