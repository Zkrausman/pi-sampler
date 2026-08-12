import assert from "node:assert/strict";
import test from "node:test";
import { projectConversation } from "../extensions/conversation-catalog/src/conversation.mjs";
import { attachEvidenceReferences } from "../extensions/conversation-catalog/src/evidence.mjs";
import { compileSensitivePatterns, findSensitiveContent, pseudonymizeSession, redactProjection } from "../extensions/conversation-catalog/src/redaction.mjs";

const projection = { events: [{ id: "event-1", category: "user", title: "User", timestamp: "Unknown time", summary: "Email jane@example.com and use Bearer abcdefghijklmnop.", metadata: [{ label: "Arguments", value: "contact=jane@example.com" }] }], edges: [] };

test("redaction detects defaults and configured patterns in hindsight-visible fields", () => {
  const patterns = compileSensitivePatterns([{ name: "customer number", expression: "CUST-[0-9]{4}", flags: "iy" }, { name: "bad", expression: "[", flags: "g" }]);
  const findings = findSensitiveContent({ events: [...projection.events, { id: "event-2", summary: "prefix CUST-1234", metadata: [] }], edges: [] }, patterns);
  assert.deepEqual(findings.map((finding) => finding.pattern), ["email address", "bearer token", "email address", "customer number"]);
  assert.ok(findings.every((finding) => finding.preview.length <= 120));
});

test("redaction replaces selected values before cited hindsight evidence is attached", () => {
  const findings = findSensitiveContent(projection); const decisions = Object.fromEntries(findings.map((finding) => [finding.id, finding.pattern === "email address" ? "redact" : "retain"]));
  const redacted = redactProjection(projection, findings, decisions); const cited = attachEvidenceReferences("session-safe", redacted);
  assert.match(cited.events[0].summary, /\[REDACTED: email address\]/); assert.match(cited.events[0].summary, /Bearer abcdefghijklmnop/); assert.match(cited.events[0].metadata[0].value, /\[REDACTED: email address\]/);
  assert.doesNotMatch(cited.events[0].evidence.reference, /jane@example\.com|abcdefghijklmnop/); assert.match(projection.events[0].summary, /jane@example\.com/);
});

test("required Slack findings cannot be retained and projected opaque IDs are replaced", () => {
  const token = "xoxb-1234567890-AbCdEfGhIjKl"; const source = { events: [{ id: "ghp_abcdefghijklmnopqrstuv", summary: `Use ${token}.`, metadata: [] }], edges: [] };
  const findings = findSensitiveContent(source); const retain = Object.fromEntries(findings.map((finding) => [finding.id, "retain"]));
  assert.throws(() => redactProjection(source, findings, retain), /required_redaction/);
  const redacted = redactProjection(source, findings, Object.fromEntries(findings.map((finding) => [finding.id, "redact"])));
  assert.equal(redacted.events[0].id, "event-1"); assert.doesNotMatch(JSON.stringify(redacted), new RegExp(token));
  assert.match(pseudonymizeSession({ id: "ghp_abcdefghijklmnopqrstuv" }), /^session-[a-z0-9]+$/);
});

test("conversation projection retains usable source evidence without rendering a flow export", () => {
  const projected = projectConversation([{ id: "private-entry", type: "message", timestamp: "2025-01-01", message: { role: "user", content: "A reviewed prompt" } }]);
  const cited = attachEvidenceReferences("conversation-1", redactProjection(projected, findSensitiveContent(projected), {}));
  assert.equal(cited.events.length, 1); assert.equal(cited.events[0].id, "event-1"); assert.equal(cited.events[0].evidence.reference, "conversation-1:event-0001");
});

test("only exact matched subagent pairs and their immediate chronological assistant follow-up become safely remapped delegation evidence", () => {
  const rawCallId = "raw-call-secret"; const rawEntryId = "raw-entry-secret";
  const entries = [
    { id: rawEntryId, type: "message", timestamp: "2025-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: rawCallId, name: "subagent", arguments: { task: "Review safely" } }] } },
    { id: "near", type: "message", timestamp: "2025-01-01T00:01:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "near-call", name: "subagent_helper", arguments: { task: "not delegation" } }] } },
    { id: "result", type: "message", timestamp: "2025-01-01T00:02:00Z", message: { role: "toolResult", toolCallId: rawCallId, toolName: "subagent", content: "Reviewed result", isError: false } },
    { id: "mismatch", type: "message", timestamp: "2025-01-01T00:03:00Z", message: { role: "toolResult", toolCallId: "missing-call", toolName: "subagent", content: "Unmatched result" } },
    { id: "wrong-name", type: "message", timestamp: "2025-01-01T00:03:30Z", message: { role: "toolResult", toolCallId: rawCallId, toolName: "subagent_helper", content: "Wrong tool name" } },
    { id: "follow-up", type: "message", timestamp: "2025-01-01T00:03:45Z", message: { role: "assistant", content: "Chronological follow-up" } },
    { id: "prose", type: "message", timestamp: "2025-01-01T00:04:00Z", message: { role: "user", content: "please subagent this" } },
  ];
  const projected = projectConversation(entries); const activities = projected.events.filter((event) => event.subagentActivity);
  assert.deepEqual(activities.map((event) => event.subagentActivity), ["delegation-call", "delegation-result", "delegation-follow-up"]);
  const redacted = redactProjection(projected, findSensitiveContent(projected), {}); const cited = attachEvidenceReferences("safe", redacted);
  assert.deepEqual(cited.events.filter((event) => event.subagentActivity).map((event) => event.evidence.reference), ["safe:event-0002", "safe:event-0005", "safe:event-0008"]);
  const serialized = JSON.stringify(cited); assert.doesNotMatch(serialized, /raw-call-secret|raw-entry-secret|near-call/); assert.doesNotMatch(serialized, /Call ID|Entry|Parent/);
});

test("lone exact calls and unmatched results never receive delegation markers", () => {
  const entries = [
    { id: "call", type: "message", timestamp: "2025-01-01", message: { role: "assistant", content: [{ type: "toolCall", id: "lone", name: "subagent", arguments: { task: "private" } }] } },
    { id: "result", type: "message", timestamp: "2025-01-02", message: { role: "toolResult", toolCallId: "missing", toolName: "subagent", content: "Unmatched" } },
  ];
  assert.deepEqual(projectConversation(entries).events.filter((event) => event.subagentActivity), []);
});
