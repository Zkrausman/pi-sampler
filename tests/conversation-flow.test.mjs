import assert from "node:assert/strict";
import test from "node:test";
import { generateConversationFlowHtml, projectConversation } from "../extensions/conversation-catalog/src/flow.mjs";

const entries = [
  { id: "assistant-late", parentId: "result-one", timestamp: "2025-01-01T00:03:00Z", type: "message", message: { role: "assistant", model: "test-model", content: [{ type: "text", text: "I used the result." }] } },
  { id: "user", timestamp: "2025-01-01T00:00:00Z", type: "message", message: { role: "user", content: "Find <b>data</b>" } },
  { id: "assistant", parentId: "user", timestamp: "2025-01-01T00:01:00Z", type: "message", message: { role: "assistant", content: [
    { type: "text", text: "I will look." },
    { type: "thinking", text: "private thought" },
    { type: "toolCall", id: "call-one", name: "search", arguments: { q: "<script>bad()</script>", limit: 5 } },
    { type: "toolCall", id: "call-two", name: "read", arguments: "file.txt" },
  ] } },
  { id: "result-one", parentId: "assistant", timestamp: "2025-01-01T00:02:00Z", type: "message", message: { role: "toolResult", toolCallId: "call-one", toolName: "search", content: [{ type: "text", text: "Found result" }] } },
  { id: "orphan", timestamp: "2025-01-01T00:02:30Z", type: "message", message: { role: "toolResult", toolCallId: "missing", toolName: "read", isError: true, content: "not found" } },
  { id: "skill", timestamp: "2025-01-01T00:04:00Z", type: "message", message: { role: "custom", customType: "skill_activity", content: "Ran skill" } },
  { id: "unknown", type: "message", message: { role: "alien", content: { secret: "must not stringify" } } },
];

test("conversation projection sorts entries and correlates tool calls, results, and responses", () => {
  const flow = projectConversation(entries);
  assert.deepEqual(flow.events.filter((event) => event.category !== "unsupported").slice(0, 5).map((event) => event.category), ["user", "assistant", "tool-call", "tool-call", "tool-result"]);
  assert.equal(flow.events.find((event) => event.category === "skill")?.summary, "Ran skill");
  assert.equal(flow.events.find((event) => event.entryId === "unknown")?.category, "unsupported");

  const call = flow.events.find((event) => event.callId === "call-one");
  const result = flow.events.find((event) => event.entryId === "result-one");
  const response = flow.events.find((event) => event.entryId === "assistant-late");
  assert.ok(call && result && response);
  assert.equal(call.metadata.find((item) => item.label === "Arguments")?.value, '{"q":"<script>bad()</script>","limit":5}');
  assert.ok(flow.edges.some((edge) => edge.from === call.id && edge.to === result.id && edge.label === "tool result"));
  assert.ok(flow.edges.some((edge) => edge.from === result.id && edge.to === response.id && edge.label === "next assistant (chronological)"));
  assert.match(flow.events.find((event) => event.entryId === "orphan").metadata.map((item) => item.value).join(" "), /No matching tool call/);
  assert.equal(flow.events.find((event) => event.entryId === "unknown").timestamp, "Unknown time");
});

test("flow HTML is standalone, visibly typed, connected, escaped, and bounded", () => {
  const hostile = '<img src=x onerror="bad()">';
  const flow = projectConversation([...entries, {
    id: "hostile\"><svg", timestamp: "2025-01-01T00:05:00Z", type: "message",
    message: { role: "user", content: hostile + "x".repeat(600) },
  }]);
  const html = generateConversationFlowHtml({ id: 'session"><svg', name: "Flow" }, flow);

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /event-user/);
  assert.match(html, /event-assistant/);
  assert.match(html, /event-tool-call/);
  assert.match(html, /event-tool-result/);
  assert.match(html, /event-skill/);
  assert.match(html, /class="connector"/);
  assert.match(html, /href="#event-/);
  assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.ok(html.length < 25_000);
  assert.match(generateConversationFlowHtml({}, projectConversation([])), /No renderable conversation entries were found/);
});
