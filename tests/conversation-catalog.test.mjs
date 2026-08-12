import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { browserLabel, browserSession, formatConversationForLocalRead, hindsightCommand, resolveHindsightRequest, sessionById } from "../extensions/conversation-catalog/src/conversation-browser.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modified = new Date("2025-02-03T04:05:06.000Z");

test("browser session metadata is bounded and keeps the local selection identifier", () => {
  const session = browserSession({ id: "session-opaque-1", name: "  Saved name  ", firstMessage: "ignored", cwd: "  E:/work  ", modified, messageCount: 4 });
  assert.deepEqual(session, { key: 0, id: "session-opaque-1", title: "Saved name", location: "E:/work", modified: "2025-02-03 04:05:06 UTC", messageCount: 4 });
  assert.match(browserLabel({ id: "session-opaque-1", name: "Saved name", cwd: "E:/work", modified, messageCount: 4 }), /Saved name.*E:\/work.*4 messages/);
  assert.equal(browserSession({ firstMessage: "x".repeat(205) }).title, `${"x".repeat(200)}…`);
});

test("exact local IDs resolve a selected session without accepting partial or stale identifiers", () => {
  const sessions = [{ id: "session-one", path: "private-one" }, { id: "session-two", path: "private-two" }];
  assert.equal(sessionById(sessions, "session-two"), sessions[1]);
  assert.equal(sessionById(sessions, "session"), undefined);
  assert.equal(sessionById(sessions, "missing"), undefined);
  assert.equal(sessionById([{ id: "duplicate" }, { id: "duplicate" }], "duplicate"), undefined);
  assert.equal(sessionById(sessions, ""), undefined);
  assert.equal(hindsightCommand("session-two"), "/hindsight-document session-two");
  assert.equal(hindsightCommand("session-two", "reports/final.html"), "/hindsight-document session-two reports/final.html");
  assert.throws(() => hindsightCommand(""), /identifier/);
  assert.deepEqual(resolveHindsightRequest(sessions, { sessionId: "session-two", outputPath: "reports/one.html" }), { session: sessions[1], outputPath: "reports/one.html", unavailable: false });
  assert.deepEqual(resolveHindsightRequest(sessions, { raw: "reports/final report.html", sessionId: "reports/final", outputPath: "report.html" }), { session: undefined, outputPath: "reports/final report.html", unavailable: false });
  assert.deepEqual(resolveHindsightRequest(sessions, { raw: "stale-session", sessionId: "stale-session", outputPath: "" }), { session: undefined, outputPath: "", unavailable: true });
});

test("local reader formats saved messages without persisting or sending their content", () => {
  const transcriptSentinel = "TRANSCRIPT-ONLY-IN-TUI";
  const output = formatConversationForLocalRead([
    { type: "message", timestamp: "2025-01-01T00:00:00.000Z", message: { role: "user", content: transcriptSentinel } },
    { type: "message", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Assistant reply" }, { type: "thinking", thinking: "secret chain" }, { type: "toolCall", name: "read", arguments: { path: "private.txt" } }] } },
    { type: "message", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "Tool output" }] } },
    { type: "message", timestamp: "2025-01-01T00:00:03.000Z", message: { role: "bashExecution", command: "git status", output: "clean" } },
  ]);
  for (const expected of [transcriptSentinel, "Assistant reply", "Tool call: read", "private.txt", "Tool result: read", "Tool output", "$ git status", "clean"]) assert.ok(output.includes(expected), expected);
  assert.match(output, /Thinking omitted/);
  assert.doesNotMatch(output, /secret chain/);
});

test("extension exposes only native browsing and hindsight commands with no generated catalog website", () => {
  const index = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8");
  assert.equal((index.match(/registerCommand\(/g) || []).length, 2);
  for (const command of ["conversation-catalog", "hindsight-document"]) assert.ok(index.includes(`registerCommand("${command}"`));
  assert.match(index, /SessionManager\.listAll\(\)/);
  assert.match(index, /formatConversationForLocalRead/);
  assert.match(index, /ctx\.ui\.editor\(/);
  assert.match(index, /hindsightCommand\(session\.id\)/);
  assert.doesNotMatch(index, /writeFile|generateCatalogHtml|pi-conversation-catalog\.html/);
  assert.equal(existsSync(join(root, "extensions/conversation-catalog/src/catalog.mjs")), false);
});

test("hindsight arguments accept the native selected-session handoff and preserve legacy output paths", async () => {
  const extension = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8").replace(/^import[^\n]+;\r?\n/gm, "");
  const compiled = ts.transpileModule(extension, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { hindsightArguments } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  assert.deepEqual(hindsightArguments(""), {});
  assert.deepEqual(hindsightArguments("reports/final report.html"), { raw: "reports/final report.html", sessionId: "reports/final", outputPath: "report.html" });
  assert.deepEqual(hindsightArguments("session-opaque-1"), { raw: "session-opaque-1", sessionId: "session-opaque-1", outputPath: "" });
  assert.deepEqual(hindsightArguments("session-opaque-1 reports/one.html"), { raw: "session-opaque-1 reports/one.html", sessionId: "session-opaque-1", outputPath: "reports/one.html" });
  assert.throws(() => hindsightArguments("--narrative-map"), /Unsupported hindsight option/);
});
