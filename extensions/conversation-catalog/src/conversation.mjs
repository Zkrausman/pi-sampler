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
