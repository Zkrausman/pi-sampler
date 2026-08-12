import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  escapeHtml,
  generateCatalogHtml,
  groupSessions,
  normalizeSession,
} from "../extensions/conversation-catalog/src/catalog.mjs";

const modified = new Date("2025-02-03T04:05:06.000Z");

function inlineContent(html, tag) {
  const start = `<${tag}>`;
  const end = `</${tag}>`;
  return html.slice(html.indexOf(start) + start.length, html.indexOf(end));
}

function cspHash(text) {
  return `sha256-${createHash("sha256").update(text).digest("base64")}`;
}

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

test("sessions group by normalized location and sort predictably without retaining identifiers", () => {
  const groups = groupSessions([
    { id: "z", name: "later title", cwd: "Beta", modified: "2024-01-01T00:00:00Z", messageCount: 1 },
    { id: "a", name: "earlier title", cwd: "Beta", modified: "2024-01-01T00:00:00Z", messageCount: 1 },
    { id: "missing", name: "unknown", cwd: " ", modified: "invalid", messageCount: 1 },
    { id: "new", name: "newest", cwd: "Alpha", modified: "2025-01-01T00:00:00Z", messageCount: 2 },
    { id: "old", name: "older", cwd: "Alpha", modified: "2023-01-01T00:00:00Z", messageCount: 2 },
  ]);

  assert.deepEqual(groups.map((group) => group.location), ["Alpha", "Beta", "Unknown location"]);
  assert.deepEqual(groups[0].sessions.map((session) => session.title), ["newest", "older"]);
  assert.deepEqual(groups[1].sessions.map((session) => session.title), ["earlier title", "later title"]);
  assert.equal(groups[2].sessions[0].location, "Unknown location");
  assert.deepEqual(Object.keys(groups[0].sessions[0]), ["title", "modified", "location", "messageCount"]);
});

test("HTML catalog is a responsive reader-first metadata launcher", () => {
  const html = generateCatalogHtml(groupSessions([{
    id: "one", name: "Named session", cwd: "E:/project", modified, messageCount: 7,
  }]));

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<style>/);
  assert.match(html, /Generate a hindsight report/);
  assert.match(html, /value="\/hindsight-document" readonly/);
  assert.match(html, /Browse\/identify a session here/);
  assert.match(html, /Copy\/run <strong>\/hindsight-document<\/strong> in Pi/);
  assert.match(html, /Select exactly one session and finish the redaction review/);
  assert.match(html, /A static local page cannot run Pi commands\. Selection and redaction stay in Pi/);
  assert.match(html, /Selection happens in Pi&apos;s picker, not on this page/);
  assert.match(html, /Named session/);
  assert.match(html, /2025-02-03 04:05:06 UTC/);
  assert.match(html, /E:\/project/);
  assert.match(html, />7</);
  assert.match(html, /@media \(max-width: 34rem\)/);
  assert.match(generateCatalogHtml([]), /No saved Pi sessions were found/);
});

test("launcher CSP permits only its exact local inline assets and has no remote capability", () => {
  const html = generateCatalogHtml([]);
  const style = inlineContent(html, "style");
  const script = inlineContent(html, "script");
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];

  assert.ok(csp);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.ok(csp.includes(`style-src '${cspHash(style)}'`));
  assert.ok(csp.includes(`script-src '${cspHash(script)}'`));
  assert.doesNotMatch(csp, /unsafe-inline|https?:|\*/i);
  assert.doesNotMatch(html, /<(?:link|img|iframe|form)\b/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test("copy control is keyboard-accessible and safely uses clipboard then a selectable fallback", () => {
  const html = generateCatalogHtml([]);
  const script = inlineContent(html, "script");

  assert.match(html, /<button id="copy-command" type="button">Copy command<\/button>/);
  assert.match(html, /<input class="command-box" id="hindsight-command" type="text" value="\/hindsight-document" readonly aria-label="Hindsight command">/);
  assert.match(html, /id="copy-status" class="copy-status" role="status" aria-live="polite"/);
  assert.match(script, /navigator\.clipboard\.writeText\(command\)/);
  assert.match(script, /typeof navigator\.clipboard\.writeText === "function"/);
  assert.match(script, /try \{[\s\S]*?await navigator\.clipboard\.writeText\(command\)[\s\S]*?\} catch \(_\) \{\}/);
  assert.match(script, /commandBox\.focus\(\);[\s\S]*?commandBox\.select\(\);[\s\S]*?document\.execCommand\("copy"\)/);
  assert.match(script, /Clipboard access is unavailable\. Select and copy the command box/);
  assert.match(script, /Command copied\. Paste and run it in Pi/);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|Function\(|<\/script/i);
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|WebSocket|window\.open/i);
});

test("HTML escapes hostile allowed metadata and excludes session IDs, paths, and transcript content", () => {
  const transcriptSentinel = "TRANSCRIPT-DO-NOT-RENDER";
  const rawJsonSentinel = "RAW-SESSION-JSON-DO-NOT-RENDER";
  const pathSentinel = "PATH-DO-NOT-RENDER";
  const idSentinel = "SESSION-ID-DO-NOT-RENDER";
  const html = generateCatalogHtml(groupSessions([
    {
      id: idSentinel, name: '<img src=x onerror="alert(1)">',
      firstMessage: "ignored prompt", cwd: 'x"><svg onload="alert(2)">',
      modified, messageCount: 1, allMessagesText: transcriptSentinel, path: pathSentinel, raw: rawJsonSentinel,
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
  for (const forbidden of [transcriptSentinel, rawJsonSentinel, pathSentinel, idSentinel, "prompt-id"]) {
    assert.doesNotMatch(html, new RegExp(forbidden));
  }
});
