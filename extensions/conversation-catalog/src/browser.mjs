import { projectConversation } from "./conversation.mjs";
import { pseudonymizeSession } from "./redaction.mjs";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function messageCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function formattedTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")
    : "Unknown time";
}

/** Metadata safe to show before a local user selects a saved session. */
export function browserSessionMetadata(session, index) {
  return {
    ordinal: index + 1,
    modified: formattedTime(session?.modified),
    messageCount: messageCount(session?.messageCount),
  };
}

/** Does not expose a name, path, raw session id, or transcript before selection. */
export function browserPickerLabel(session, index) {
  const metadata = browserSessionMetadata(session, index);
  return `${metadata.ordinal}. Conversation ${pseudonymizeSession(session)} — ${metadata.modified} (${metadata.messageCount} messages)`;
}

/** Creates a short-lived local lookup table; its opaque keys are the only public identifiers. */
export function buildSessionReferenceIndex(sessions) {
  const index = new Map();
  for (const session of (Array.isArray(sessions) ? sessions : [])) {
    const reference = pseudonymizeSession(session);
    if (!/^session-[a-z0-9]+$/.test(reference) || index.has(reference)) {
      throw new Error("Saved conversation identifiers are ambiguous. Restart the browser and try again.");
    }
    index.set(reference, session);
  }
  return index;
}

export function resolveSessionReference(sessions, reference) {
  if (typeof reference !== "string" || !/^session-[a-z0-9]+$/.test(reference)) {
    throw new Error("The selected conversation identifier is invalid.");
  }
  const session = buildSessionReferenceIndex(sessions).get(reference);
  if (!session) throw new Error("The selected conversation is no longer available.");
  return session;
}

/**
 * Formats a selected session for Pi's local editor only. It never writes a
 * file, includes the storage path, or sends transcript content to the model.
 */
export function formatLocalConversationReader(session, entries) {
  const reference = pseudonymizeSession(session);
  const events = projectConversation(entries).events;
  const body = events.map((event, index) => {
    const metadata = (Array.isArray(event.metadata) ? event.metadata : [])
      .filter((item) => !["Entry", "Parent", "Call ID"].includes(item?.label))
      .map((item) => `${item.label}: ${item.value}`);
    return [`${index + 1}. ${event.timestamp} — ${event.title}`, event.summary, ...metadata].filter(Boolean).join("\n");
  }).join("\n\n");
  const title = text(session?.name) || text(session?.firstMessage) || "Untitled session";
  return [
    "Saved Pi conversation (local-only reader)",
    `Selected conversation: ${title}`,
    `Opaque identifier: ${reference}`,
    "This reader is local only. Its contents are not written to a catalog or sent to a model.",
    "",
    body || "This saved conversation has no readable entries.",
  ].join("\n");
}
