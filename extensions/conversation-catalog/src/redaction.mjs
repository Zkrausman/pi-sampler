const MAX_PATTERN_NAME_LENGTH = 80;
const MAX_PREVIEW_LENGTH = 120;

export const DEFAULT_SENSITIVE_PATTERNS = Object.freeze([
  { name: "email address", expression: "\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b", flags: "gi" },
  { name: "bearer token", expression: "\\bBearer\\s+[A-Z0-9._~+/-]{12,}\\b", flags: "gi" },
  { name: "API key", expression: "\\b(?:sk|pk|api)[_-][A-Z0-9_-]{12,}\\b", flags: "gi" },
  { name: "GitHub token", expression: "\\bgh[pousr]_[A-Za-z0-9_]{20,}\\b", flags: "g" },
  { name: "Slack token", expression: "\\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|xoxe(?:\\.xox[abprs])?-[A-Za-z0-9-]{10,})\\b", flags: "g", requiredRedaction: true },
]);

function text(value) {
  return typeof value === "string" ? value : "";
}

function bounded(value, maxLength = MAX_PREVIEW_LENGTH) {
  const characters = Array.from(text(value));
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join("")}…` : characters.join("");
}

function safeName(value, index) {
  const name = text(value).trim().replace(/[\r\n]/g, " ");
  return (name || `configured pattern ${index + 1}`).slice(0, MAX_PATTERN_NAME_LENGTH);
}

/**
 * Validates default and user-configured patterns without accepting arbitrary
 * executable input. Invalid entries are ignored rather than weakening the
 * default policy.
 */
export function compileSensitivePatterns(configured = []) {
  const candidates = [...DEFAULT_SENSITIVE_PATTERNS, ...(Array.isArray(configured) ? configured : [])];
  return candidates.flatMap((candidate, index) => {
    const expression = text(candidate?.expression);
    // Sticky regexes only search at lastIndex and can silently miss a later secret.
    const suppliedFlags = text(candidate?.flags).replace(/[^gimsu]/g, "");
    if (!expression || expression.length > 500) return [];
    try {
      return [{ name: safeName(candidate?.name, index), regex: new RegExp(expression, suppliedFlags.includes("g") ? suppliedFlags : `${suppliedFlags}g`), requiredRedaction: candidate?.requiredRedaction === true }];
    } catch {
      return [];
    }
  });
}

function visibleFields(event) {
  const fields = [{ key: "summary", value: text(event?.summary) }];
  for (const [index, item] of (Array.isArray(event?.metadata) ? event.metadata : []).entries()) {
    fields.push({ key: `metadata:${index}`, value: text(item?.value) });
  }
  return fields;
}

/** Finds only strings that the hindsight source bundle would otherwise include. */
export function findSensitiveContent(projection, patterns = compileSensitivePatterns()) {
  const findings = [];
  const events = Array.isArray(projection?.events) ? projection.events : [];
  for (const [eventIndex, event] of events.entries()) {
    for (const field of visibleFields(event)) {
      for (const pattern of patterns) {
        pattern.regex.lastIndex = 0;
        let match;
        while ((match = pattern.regex.exec(field.value))) {
          if (!match[0]) {
            pattern.regex.lastIndex += 1;
            continue;
          }
          findings.push({
            id: `finding-${findings.length + 1}`,
            eventId: text(event?.id),
            eventIndex: eventIndex + 1,
            field: field.key,
            pattern: pattern.name,
            requiredRedaction: pattern.requiredRedaction === true,
            start: match.index,
            end: match.index + match[0].length,
            preview: bounded(match[0]),
          });
        }
      }
    }
  }
  return findings;
}

function fieldValue(event, key) {
  if (key === "summary") return text(event.summary);
  const match = /^metadata:(\d+)$/.exec(key);
  return match ? text(event.metadata?.[Number(match[1])]?.value) : "";
}

function replaceRanges(value, findings) {
  const merged = [];
  for (const finding of [...findings].sort((left, right) => left.start - right.start || right.end - left.end)) {
    const previous = merged[merged.length - 1];
    // Merge any overlap before rendering so original string offsets cannot leak
    // a suffix after an earlier replacement changed the value length.
    if (previous && finding.start <= previous.end) {
      previous.end = Math.max(previous.end, finding.end);
    } else {
      merged.push({ start: finding.start, end: finding.end, pattern: finding.pattern });
    }
  }
  let cursor = 0;
  let redacted = "";
  for (const finding of merged) {
    redacted += `${value.slice(cursor, finding.start)}[REDACTED: ${finding.pattern}]`;
    cursor = finding.end;
  }
  return `${redacted}${value.slice(cursor)}`;
}

/** Deterministic local-only label that prevents opaque source IDs/names leaking into exports. */
export function pseudonymizeSession(session) {
  const value = `${text(session?.id)}\u0000${text(session?.name)}`;
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `session-${(hash >>> 0).toString(36)}`;
}

function requireRedactionDecisions(findings, decisions, { excluded = false } = {}) {
  for (const finding of (Array.isArray(findings) ? findings : [])) {
    if (finding?.requiredRedaction !== true) continue;
    const action = decisions?.[finding.id];
    // A persisted/manual retain is never a valid fallback for a mandatory
    // finding. An excluded whole projection carries no renderable content.
    if (action === "retain" || (!excluded && action !== "redact")) throw new Error("required_redaction");
  }
}

/** Returns a renderer-safe copy. Only findings chosen for redaction are changed. */
export function redactProjection(projection, findings, decisions) {
  requireRedactionDecisions(findings, decisions);
  const redactIds = new Set((Array.isArray(findings) ? findings : [])
    .filter((finding) => decisions?.[finding.id] === "redact")
    .map((finding) => finding.id));
  const byEventAndField = new Map();
  for (const finding of (Array.isArray(findings) ? findings : [])) {
    if (!redactIds.has(finding.id)) continue;
    const key = `${finding.eventId}\u0000${finding.field}`;
    const values = byEventAndField.get(key) || [];
    values.push(finding);
    byEventAndField.set(key, values);
  }
  const sourceEvents = Array.isArray(projection?.events) ? projection.events : [];
  // Entry IDs are opaque implementation values, so render deterministic IDs instead.
  // This prevents a secret-looking ID from bypassing content redaction in anchors or metadata.
  const eventIds = new Map(sourceEvents.map((event, index) => [event.id, `event-${index + 1}`]));
  const events = sourceEvents.map((event) => {
    // Keep only renderer-safe fields. Raw entry/call/parent IDs are useful while
    // projecting relationships but must not survive into the reviewed bundle.
    const copy = {
      id: eventIds.get(event.id),
      category: text(event.category),
      timestamp: text(event.timestamp),
      title: text(event.title),
      summary: text(event.summary),
      metadata: (Array.isArray(event.metadata) ? event.metadata : [])
        .map((item, sourceIndex) => ({ label: text(item?.label), value: text(item?.value), sourceIndex }))
        .filter((item) => !["Entry", "Parent", "Call ID"].includes(item.label)),
      ...(event.subagentActivity ? { subagentActivity: event.subagentActivity } : {}),
      // This locally derived ordinal is deliberately opaque and never rendered.
      ...( /^delegation-[1-9][0-9]*$/.test(text(event.delegationPair)) ? { delegationPair: text(event.delegationPair) } : {} ),
    };
    for (const field of visibleFields(event)) {
      const relevant = byEventAndField.get(`${event.id}\u0000${field.key}`);
      if (!relevant) continue;
      if (field.key === "summary") copy.summary = replaceRanges(fieldValue(event, field.key), relevant);
      else {
        const metadataIndex = Number(field.key.slice("metadata:".length));
        const target = copy.metadata.find((item) => item.sourceIndex === metadataIndex);
        if (target) target.value = replaceRanges(fieldValue(event, field.key), relevant);
      }
    }
    return { ...copy, metadata: copy.metadata.map(({ label, value }) => ({ label, value })) };
  });
  const edges = (Array.isArray(projection?.edges) ? projection.edges : [])
    .map((edge) => ({ ...edge, from: eventIds.get(edge.from), to: eventIds.get(edge.to) }))
    .filter((edge) => edge.from && edge.to);
  return { ...projection, events, edges };
}
