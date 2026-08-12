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
    JSON.stringify({ type: "session", id, timestamp: "2025-02-03T04:05:06.000Z", cwd: "PATH-DO-NOT-EXPOSE" }),
    JSON.stringify({ type: "message", id: "entry-secret", timestamp: "2025-02-03T04:06:06.000Z", message: { role: "user", content: "Selected transcript only" } }),
    JSON.stringify({ type: "message", id: "assistant-secret", timestamp: "2025-02-03T04:07:06.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Selected local reasoning only", thinkingSignature: "signature-not-rendered" }] } }),
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
  assert.deepEqual(found.map(({ id: sessionId, messageCount }) => ({ id: sessionId, messageCount })), [{ id, messageCount: 2 }]);
  assert.deepEqual((await discoverReports({ reportDirectory: reports })).map((report) => report.name), ["report.html"]);
  assert.deepEqual(await discoverSessions({ sessionDirectory: join(sessions, "missing") }), []);
});

test("viewer renders transcript only after selection and reports in a sandboxed local frame", async () => {
  const { sessions, reports, id } = await fixture();
  const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "a".repeat(43), idleMs: 60_000 });
  try {
    const list = await (await get(viewer.url, "api/sessions")).json();
    assert.equal(list[0].id, id);
    assert.doesNotMatch(JSON.stringify(list), /Selected transcript only|Selected local reasoning only|PATH-DO-NOT-EXPOSE|entry-secret/);
    const detail = await (await get(viewer.url, "api/sessions/0")).json();
    assert.match(JSON.stringify(detail), /Selected transcript only/);
    assert.match(JSON.stringify(detail), /Selected local reasoning only/);
    assert.equal(detail.events[0].category, "user"); assert.equal(detail.events[1].category, "assistant");
    assert.match(detail.reference, /^session-[a-z0-9]+$/);
    assert.equal(detail.reference, pseudonymizeSession({ id }));
    assert.equal(resolveSessionReference([{ id }], detail.reference).id, id);
    assert.doesNotMatch(JSON.stringify(detail), /PATH-DO-NOT-EXPOSE|entry-secret/);
    const report = await (await get(viewer.url, "api/reports/0")).text();
    assert.match(report, /Local report/); assert.match(report, /default-src 'none'/);
    assert.match(sandboxedReportHtml("<script>bad()</script>"), /default-src 'none'/);
    assert.match(viewerPage(), /sandbox/); assert.match(viewerScript(), /navigator\.clipboard/); assert.match(viewerScript(), /execCommand\('copy'\)/);
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
  assert.match(script, /q\('#conversation-only'\)\.checked\?events\.filter\(isConversation\):events/);
  assert.match(script, /q\('#handoff-command'\)\.textContent='\/hindsight-document '\+selected/);
  assert.match(script, /icon\.textContent='✓'/);
  assert.match(script, /event\.key==='Escape'/);
  assert.match(script, /event\.key==='Tab'/);
  assert.match(script, /drawerFocusables/);
  assert.match(script, /opener&&typeof opener\.focus==='function'/);
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

test("viewer package assets are local and read-only implementation has no write, model, or network client", async () => {
  const source = await readFile(new URL("../extensions/conversation-catalog/src/viewer.mjs", import.meta.url), "utf8");
  for (const forbidden of ["writeFile", "mkdir", "SessionManager", "sendUserMessage", "node:https", "https://"]) assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /createServer/); assert.match(source, /readFile/);
});

test("Windows launcher imports its package-local ESM module using a file URL", async () => {
  const launcher = await readFile(new URL("../extensions/conversation-catalog/bin/pi-conversation-viewer.mjs", import.meta.url), "utf8");
  assert.match(launcher, /pathToFileURL/);
  assert.match(launcher, /import\(pathToFileURL\(join\(root, "src", "viewer\.mjs"\)\)\.href\)/);
});
