import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeHtml,
  generateCatalogHtml,
  groupSessions,
  normalizeSession,
} from "../extensions/conversation-catalog/src/catalog.mjs";

const modified = new Date("2025-02-03T04:05:06.000Z");

test("normalization prefers names, bounds first prompts, and supplies safe fallbacks", () => {
  assert.deepEqual(normalizeSession({
    name: "  Saved name  ", firstMessage: "ignored", cwd: "  E:/work  ", modified, messageCount: 4,
  }), {
    title: "Saved name",
    modified: "2025-02-03 04:05:06 UTC",
    location: "E:/work",
    messageCount: 4,
  });

  const longPrompt = "x".repeat(205);
  assert.equal(normalizeSession({ name: " ", firstMessage: `  ${longPrompt}  ` }).title, `${"x".repeat(200)}…`);
  assert.deepEqual(normalizeSession({ cwd: " ", modified: "not a date", messageCount: -2 }), {
    title: "Untitled session",
    modified: "Unknown time",
    location: "Unknown location",
    messageCount: 0,
  });
});

test("sessions group by normalized location and sort predictably", () => {
  const groups = groupSessions([
    { id: "z", name: "later id", cwd: "Beta", modified: "2024-01-01T00:00:00Z", messageCount: 1 },
    { id: "a", name: "earlier id", cwd: "Beta", modified: "2024-01-01T00:00:00Z", messageCount: 1 },
    { id: "missing", name: "unknown", cwd: " ", modified: "invalid", messageCount: 1 },
    { id: "new", name: "newest", cwd: "Alpha", modified: "2025-01-01T00:00:00Z", messageCount: 2 },
    { id: "old", name: "older", cwd: "Alpha", modified: "2023-01-01T00:00:00Z", messageCount: 2 },
  ]);

  assert.deepEqual(groups.map((group) => group.location), ["Alpha", "Beta", "Unknown location"]);
  assert.deepEqual(groups[0].sessions.map((session) => session.title), ["newest", "older"]);
  assert.deepEqual(groups[1].sessions.map((session) => session.title), ["earlier id", "later id"]);
  assert.equal(groups[2].sessions[0].location, "Unknown location");
});

test("HTML catalog is standalone, shows required metadata, and has an empty state", () => {
  const html = generateCatalogHtml(groupSessions([{
    id: "one", name: "Named session", cwd: "E:/project", modified, messageCount: 7,
  }]));

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /Named session/);
  assert.match(html, /2025-02-03 04:05:06 UTC/);
  assert.match(html, /E:\/project/);
  assert.match(html, />7</);
  assert.match(generateCatalogHtml([]), /No saved Pi sessions were found/);
});

test("HTML escapes hostile metadata and excludes transcript and path fields", () => {
  const transcriptSentinel = "TRANSCRIPT-DO-NOT-RENDER";
  const pathSentinel = "PATH-DO-NOT-RENDER";
  const html = generateCatalogHtml(groupSessions([
    {
      id: "private-id", name: '<img src=x onerror="alert(1)">',
      firstMessage: "ignored prompt", cwd: 'x"><svg onload="alert(2)">',
      modified, messageCount: 1, allMessagesText: transcriptSentinel, path: pathSentinel,
    },
    {
      id: "prompt-id", name: " ", firstMessage: '<script>alert("prompt")</script>',
      cwd: 'x"><svg onload="alert(2)">', modified, messageCount: 1,
    },
  ]));

  assert.match(escapeHtml(`&<>"'`), /&amp;&lt;&gt;&quot;&#39;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;alert\(&quot;prompt&quot;\)&lt;\/script&gt;/);
  assert.match(html, /x&quot;&gt;&lt;svg onload=&quot;alert\(2\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<svg onload/);
  assert.doesNotMatch(html, new RegExp(transcriptSentinel));
  assert.doesNotMatch(html, new RegExp(pathSentinel));
  assert.doesNotMatch(html, /private-id/);
});
