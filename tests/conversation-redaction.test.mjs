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
