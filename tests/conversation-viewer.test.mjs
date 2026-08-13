import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverReports,
  discoverSessions,
  startViewer,
  viewerPage,
  viewerScript,
  viewerShouldClose,
  sandboxedReportHtml,
} from "../extensions/conversation-catalog/src/viewer.mjs";
import { pseudonymizeSession } from "../extensions/conversation-catalog/src/redaction.mjs";
import { resolveSessionReference } from "../extensions/conversation-catalog/src/browser.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-viewer-"));
  const sessions = join(directory, "sessions");
  const reports = join(directory, "reports");
  await mkdir(join(sessions, "project"), { recursive: true }); await mkdir(reports);
  const id = "019fd4f3-b574-7953-a984-ffb49a519207";
  await writeFile(join(sessions, "project", "one.jsonl"), [
    JSON.stringify({ type: "session", id, timestamp: "2025-02-03T04:05:06.000Z", cwd: directory }),
    JSON.stringify({ type: "message", id: "entry-secret", timestamp: "2025-02-03T04:06:06.000Z", message: { role: "user", content: "Selected transcript only" } }),
    JSON.stringify({ type: "message", id: "assistant-secret", timestamp: "2025-02-03T04:07:06.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Selected local reasoning only", thinkingSignature: "signature-not-rendered" }, { type: "toolCall", id: "tool-call-secret", name: "local-tool", arguments: { safe: true } }] } }),
    JSON.stringify({ type: "message", id: "tool-result-secret", timestamp: "2025-02-03T04:08:06.000Z", message: { role: "toolResult", toolCallId: "tool-call-secret", toolName: "local-tool", content: "Tool result" } }),
  ].join("\n"));
  await writeFile(join(sessions, "project", "bad.jsonl"), "not json\n");
  await writeFile(join(reports, "report.html"), "<h1>Local report</h1>");
  await writeFile(join(reports, "ignore.txt"), "ignore");
  return { directory, sessions, reports, id };
}

async function get(url, path, options) { return fetch(`${url}${path}`, options); }
async function rawRequest(url, path, headers) {
  const requestUrl = new URL(`${url}${path}`);
  return new Promise((resolveRequest, reject) => {
    const outbound = request({ hostname: requestUrl.hostname, port: requestUrl.port, path: requestUrl.pathname, headers }, (response) => {
      let body = "";
      response.on("data", (part) => { body += part; });
      response.on("end", () => resolveRequest({ status: response.statusCode, body }));
    });
    outbound.on("error", reject); outbound.end();
  });
}

test("viewer discovery accepts recognizable local sessions and malformed/stale input fails closed", async () => {
  const { sessions, reports, id } = await fixture();
  const found = await discoverSessions({ sessionDirectory: sessions });
  assert.deepEqual(found.map(({ id: sessionId, messageCount }) => ({ id: sessionId, messageCount })), [{ id, messageCount: 3 }]);
  assert.deepEqual((await discoverReports({ reportDirectory: reports })).map((report) => report.name), ["report.html"]);
  assert.deepEqual(await discoverSessions({ sessionDirectory: join(sessions, "missing") }), []);
});

test("viewer renders transcript only after selection and reports in a sandboxed local frame", async () => {
  const { sessions, reports, id } = await fixture();
  const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "a".repeat(43), idleMs: 60_000 });
  try {
    const list = await (await get(viewer.url, "api/sessions")).json();
    assert.equal(list[0].index, 0);
    assert.doesNotMatch(JSON.stringify(list), new RegExp(`${id}|Selected transcript only|Selected local reasoning only|PATH-DO-NOT-EXPOSE|entry-secret|projectRoot|cwd`));
    const detail = await (await get(viewer.url, "api/sessions/0")).json();
    assert.match(JSON.stringify(detail), /Selected transcript only/);
    assert.match(JSON.stringify(detail), /Selected local reasoning only/);
    assert.equal(detail.events[0].category, "user"); assert.equal(detail.events[1].category, "assistant"); assert.equal(detail.events[2].category, "tool-call"); assert.equal(detail.events[3].category, "tool-result");
    assert.equal(new Set(detail.events.map((event) => event.noteReference)).size, detail.events.length);
    assert.doesNotMatch(JSON.stringify(detail), new RegExp(id));
    assert.match(detail.reference, /^session-[a-z0-9]+$/);
    assert.equal(detail.reference, pseudonymizeSession({ id }));
    assert.equal(resolveSessionReference([{ id }], detail.reference).id, id);
    assert.doesNotMatch(JSON.stringify(detail), /PATH-DO-NOT-EXPOSE|entry-secret/);
    const report = await (await get(viewer.url, "api/reports/0")).text();
    assert.match(report, /Local report/); assert.match(report, /default-src 'none'/);
    assert.match(sandboxedReportHtml("<script>bad()</script>"), /default-src 'none'/);
    assert.match(viewerPage(), /sandbox/); assert.match(viewerScript(), /navigator\.clipboard/);
  } finally { viewer.close(); }
});

test("viewer reader has an accessible on-demand navigation drawer, handoff copy affordance, and full-fidelity filter", async () => {
  const page = viewerPage(); const script = viewerScript();
  assert.match(page, /id="navigation-drawer"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="drawer-title"/);
  assert.match(page, /id="drawer-toggle"[^>]*aria-controls="navigation-drawer"[^>]*aria-expanded="false"/);
  assert.match(page, /id="conversation-only" type="checkbox"/);
  assert.match(page, /id="handoff-command">\/hindsight-document session-reference/);
  assert.match(page, /id="copy"[^>]*aria-label="Copy Pi handoff command"/);
  assert.doesNotMatch(page, /Close Viewer/);
  assert.match(script, /event\.category==='user'\|\|event\.category==='assistant'/);
  assert.match(script, /events\.filter\(conversation\):events/);
  assert.match(script, /q\('#handoff-command'\)\.textContent='\/hindsight-document '\+selected/);
  assert.match(script, /noteReference/); assert.match(script, /drawerFocusables/); assert.match(script, /textarea/); assert.doesNotMatch(script, /prompt\(/);
  assert.match(script, /status\.setAttribute\('role','status'\)/); assert.match(script, /status\.setAttribute\('aria-live','polite'\)/);
  assert.match(script, /status\.textContent='Note added\.'/); assert.match(script, /status\.textContent='Note updated\.'/); assert.match(script, /status\.textContent='Note deleted\.'/);
  assert.match(script, /readerStatus\.textContent='Legacy note attached to the selected event\.'/); assert.match(script, /readerStatus\.textContent='Unable to attach legacy note\.'/);
  assert.match(page, /id="legacy-notes-status" role="status" aria-live="polite"/);
  assert.match(page, /id="reader-status" class="notice" role="status" aria-live="polite"/);
  assert.match(script, /readerStatus=q\('#reader-status'\)/);
  const syntaxDirectory = await mkdtemp(join(tmpdir(), "pi-viewer-syntax-"));
  const syntaxFile = join(syntaxDirectory, "viewer-script.mjs");
  await writeFile(syntaxFile, script);
  await new Promise((resolveCheck, rejectCheck) => {
    const child = spawn(process.execPath, ["--check", syntaxFile]);
    child.once("error", rejectCheck); child.once("exit", (code) => code === 0 ? resolveCheck() : rejectCheck(new Error("Viewer script has invalid syntax.")));
  });
});

test("viewer rejects missing token, unexpected host and origin without echoing data", async () => {
  const { sessions, reports, id } = await fixture();
  const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "b".repeat(43), idleMs: 60_000 });
  try {
    const missing = await fetch(viewer.url.replace(`/${viewer.token}/`, "/"));
    assert.equal(missing.status, 404); assert.doesNotMatch(await missing.text(), new RegExp(id));
    const host = await rawRequest(viewer.url, "api/sessions", { Host: "example.test" }); assert.equal(host.status, 403);
    const origin = await rawRequest(viewer.url, "api/sessions", { Origin: "http://example.test" }); assert.equal(origin.status, 403);
  } finally { viewer.close(); }
});

test("viewer event note API validates selected event ownership and mutates immediately", async () => {
  const { sessions, reports, id } = await fixture(); const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "n".repeat(43), idleMs: 60_000 });
  try { const detail = await (await get(viewer.url, "api/sessions/0")).json(); const event = detail.events[0]; assert.match(event.noteReference, /^event-[a-f0-9]{32}$/); assert.doesNotMatch(JSON.stringify(detail), new RegExp(`${id}|entry-secret|projectRoot|cwd`)); const base = `api/sessions/0/events/${event.noteReference}/notes`; assert.deepEqual((await (await get(viewer.url, base)).json()).notes, []); const created = await get(viewer.url, base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Local reviewed context." }) }); assert.equal(created.status, 200); const after = await created.json(); assert.equal(after.notes.length, 1); assert.equal(after.notes[0].eventReference, event.noteReference); const noteId = after.notes[0].noteId; assert.equal((await get(viewer.url, `${base}/${noteId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Updated local context." }) })).status, 200); const deleted = await get(viewer.url, `${base}/${noteId}`, { method: "DELETE" }); assert.equal(deleted.status, 200); assert.deepEqual((await deleted.json()).notes, []); assert.equal((await get(viewer.url, `api/sessions/0/events/event-${"a".repeat(32)}/notes`)).status, 404); } finally { viewer.close(); }
});

test("hindsight and viewer use the selected session project root and unsupported note backends do not block hindsight", async () => {
  const extension = await readFile(new URL("../extensions/conversation-catalog/src/index.ts", import.meta.url), "utf8");
  assert.match(extension, /readHindsightNotes\(session\.cwd, hindsightNotesSessionReference\(session\.id\)\)/);
  assert.match(extension, /error\.code !== "secure_storage_unavailable"/);
});

test("viewer binds loopback and close, heartbeat, idle, and maximum lifetime rules are bounded", async () => {
  const { sessions, reports } = await fixture();
  await assert.rejects(startViewer({ host: "0.0.0.0" }), /127\.0\.0\.1/);
  const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "c".repeat(43), idleMs: 60_000 });
  assert.equal(viewer.server.address().address, "127.0.0.1");
  assert.equal(viewerShouldClose({ started: 0, lastHeartbeat: 100, now: 200, idleMs: 101, maxLifetimeMs: 1000 }), false);
  assert.equal(viewerShouldClose({ started: 0, lastHeartbeat: 0, now: 101, idleMs: 100, maxLifetimeMs: 1000 }), true);
  assert.equal(viewerShouldClose({ started: 0, lastHeartbeat: 999, now: 1001, idleMs: 10_000, maxLifetimeMs: 1000 }), true);
  const closed = new Promise((resolve) => viewer.server.once("close", resolve));
  await get(viewer.url, "api/close", { method: "POST" }); await closed;
});

test("viewer teardown destroys an incomplete retained loopback connection", async () => {
  const { sessions, reports } = await fixture();
  const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "d".repeat(43), idleMs: 60_000 });
  const address = viewer.server.address();
  const socket = createConnection({ host: "127.0.0.1", port: address.port });
  await new Promise((resolveConnection, reject) => { socket.once("connect", resolveConnection); socket.once("error", reject); });
  const socketClosed = new Promise((resolveClose) => socket.once("close", resolveClose));
  const serverClosed = new Promise((resolveClose) => viewer.server.once("close", resolveClose));
  viewer.close();
  await Promise.all([socketClosed, serverClosed]);
});

test("viewer package assets are local and note CRUD has no model or network client", async () => {
  const source = await readFile(new URL("../extensions/conversation-catalog/src/viewer.mjs", import.meta.url), "utf8");
  for (const forbidden of ["writeFile", "mkdir", "SessionManager", "sendUserMessage", "node:https", "https://"]) assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /createServer/); assert.match(source, /readFile/);
});

test("Windows launcher imports its package-local ESM module using a file URL", async () => {
  const launcher = await readFile(new URL("../extensions/conversation-catalog/bin/pi-conversation-viewer.mjs", import.meta.url), "utf8");
  assert.match(launcher, /pathToFileURL/);
  assert.match(launcher, /import\(pathToFileURL\(join\(root, "src", "viewer\.mjs"\)\)\.href\)/);
});
