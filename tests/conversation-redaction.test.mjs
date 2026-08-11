import assert from "node:assert/strict";
import test from "node:test";
import { compileSensitivePatterns, createRedactionMetadata, findSensitiveContent, generateExcludedConversationHtml, pseudonymizeSession, redactProjection } from "../extensions/conversation-catalog/src/redaction.mjs";
import { generateConversationFlowHtml } from "../extensions/conversation-catalog/src/flow.mjs";

const projection = {
  events: [{
    id: "event-1", category: "user", title: "User", timestamp: "Unknown time", summary: "Email jane@example.com and use Bearer abcdefghijklmnop.",
    metadata: [{ label: "Arguments", value: "contact=jane@example.com" }],
  }],
  edges: [],
};

test("redaction detects defaults and configured patterns only in visible flow fields", () => {
  const patterns = compileSensitivePatterns([{ name: "customer number", expression: "CUST-[0-9]{4}", flags: "iy" }, { name: "bad", expression: "[", flags: "g" }]);
  const findings = findSensitiveContent({
    events: [...projection.events, { id: "event-2", summary: "prefix CUST-1234", metadata: [] }],
    edges: [],
  }, patterns);
  assert.deepEqual(findings.map((finding) => finding.pattern), ["email address", "bearer token", "email address", "customer number"]);
  assert.ok(findings.every((finding) => finding.preview.length <= 120));
});

test("redaction replaces only chosen visible values and metadata omits secrets", () => {
  const findings = findSensitiveContent(projection);
  const decisions = Object.fromEntries(findings.map((finding) => [finding.id, finding.pattern === "email address" ? "redact" : "retain"]));
  const redacted = redactProjection(projection, findings, decisions);

  assert.match(redacted.events[0].summary, /\[REDACTED: email address\]/);
  assert.match(redacted.events[0].summary, /Bearer abcdefghijklmnop/);
  assert.match(redacted.events[0].metadata[0].value, /\[REDACTED: email address\]/);
  assert.match(projection.events[0].summary, /jane@example.com/);

  const metadata = createRedactionMetadata("session-1", findings, decisions, false);
  const serialized = JSON.stringify(metadata);
  assert.doesNotMatch(serialized, /jane@example\.com|abcdefghijklmnop/);
  assert.equal(metadata.findingCount, 3);
  assert.equal(metadata.decisions[0].eventIndex, 1);
  assert.equal(Object.hasOwn(metadata.decisions[0], "eventId"), false);
  assert.equal(metadata.decisions.filter((decision) => decision.action === "redact").length, 2);
});

test("required Slack findings reject retain decisions and redact before rendering", () => {
  const slackToken = "xoxb-1234567890-AbCdEfGhIjKl";
  const source = { events: [{ id: "event-1", category: "user", title: "User", timestamp: "Unknown time", summary: `Use ${slackToken}.`, metadata: [] }], edges: [] };
  const findings = findSensitiveContent(source);
  const retain = Object.fromEntries(findings.map((finding) => [finding.id, "retain"]));
  assert.deepEqual(findings.map((finding) => finding.pattern), ["Slack token"]);
  assert.throws(() => redactProjection(source, findings, retain), /required_redaction/);
  assert.throws(() => createRedactionMetadata("session-1", findings, retain, false), /required_redaction/);
  const redacted = redactProjection(source, findings, Object.fromEntries(findings.map((finding) => [finding.id, "redact"])));
  const html = generateConversationFlowHtml({ id: "session-safe", name: "Selected conversation" }, redacted);
  assert.doesNotMatch(html, new RegExp(slackToken));
  assert.match(html, /\[REDACTED: Slack token\]/);
});

test("overlapping findings redact their complete union", () => {
  const source = { events: [{ id: "event-1", summary: "Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ", metadata: [] }], edges: [] };
  const findings = findSensitiveContent(source, compileSensitivePatterns([{ name: "inner token", expression: "ABC", flags: "g" }]));
  const redacted = redactProjection(source, findings, Object.fromEntries(findings.map((finding) => [finding.id, "redact"])));
  assert.equal(redacted.events[0].summary, "[REDACTED: bearer token]");
});

test("redacted projection is what reaches the flow renderer and excluded view has no content", () => {
  const source = { ...projection, events: [{ ...projection.events[0], id: "ghp_abcdefghijklmnopqrstuv" }] };
  const findings = findSensitiveContent(source);
  const redacted = redactProjection(source, findings, Object.fromEntries(findings.map((finding) => [finding.id, "redact"])));
  const rawSession = { id: "ghp_abcdefghijklmnopqrstuv", name: "jane@example.com" };
  const exportSession = { id: pseudonymizeSession(rawSession), name: "Selected conversation" };
  const html = generateConversationFlowHtml(exportSession, redacted);
  const metadata = JSON.stringify(createRedactionMetadata(exportSession.id, findings, {}, false));
  assert.doesNotMatch(html, /jane@example\.com|abcdefghijklmnop|ghp_/);
  assert.doesNotMatch(metadata, /jane@example\.com|abcdefghijklmnop|ghp_/);
  assert.match(html, /\[REDACTED: email address\]/);

  const excluded = generateExcludedConversationHtml(exportSession);
  assert.match(excluded, /^<!doctype html>/i);
  assert.doesNotMatch(excluded, /<script>|jane@example\.com|ghp_/i);
  assert.match(excluded, /No conversation content was rendered/);
});
