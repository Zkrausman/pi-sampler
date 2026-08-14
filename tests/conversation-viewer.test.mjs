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
  viewerStyles,
  sandboxedReportHtml,
  VIEWER_HEADER_BYTES,
  VIEWER_MAX_SESSION_FILE_BYTES,
  VIEWER_MAX_SNAPSHOTS,
  VIEWER_MAX_CURSORS,
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
async function catalog(viewer) { return (await get(viewer.url, "api/sessions")).json(); }
async function sessionHandle(viewer, index = 0) { return (await catalog(viewer)).sessions[index].handle; }
async function eventPage(viewer, handle, suffix = "") { return (await get(viewer.url, `api/sessions/${handle}/events${suffix}`)).json(); }
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
  assert.deepEqual(found.map(({ id: sessionId, messageCount, entries }) => ({ id: sessionId, messageCount, entries })), [{ id, messageCount: undefined, entries: undefined }]);
  assert.deepEqual((await discoverReports({ reportDirectory: reports })).map((report) => report.name), ["report.html"]);
  assert.deepEqual(await discoverSessions({ sessionDirectory: join(sessions, "missing") }), []);
});

test("viewer returns the complete bounded opaque catalog immediately while selected event pages remain lazy", async () => {
  const { sessions, reports, id, directory } = await fixture();
  for (let index = 0; index < 60; index += 1) {
    const classification = index % 2 ? [{ type: "session_info", name: "private subagent work" }] : [];
    await writeFile(join(sessions, "project", `extra-${index}.jsonl`), [
      JSON.stringify({ type: "session", id: `019fd4f3-b574-7953-a984-ffb49a519${String(index).padStart(3, "0")}`, timestamp: `2025-03-01T00:00:${String(index).padStart(2, "0")}.000Z`, cwd: directory }),
      ...classification.map(JSON.stringify),
      JSON.stringify({ type: "message", timestamp: `2025-03-01T01:00:${String(index).padStart(2, "0")}.000Z`, message: { role: "user", content: `event ${index}` } }),
    ].join("\n"));
  }
  const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "a".repeat(43), idleMs: 60_000 });
  try {
    const response = await catalog(viewer);
    assert.equal(response.sessions.length, 61, "one catalog response contains every discovered bounded entry");
    assert.equal(response.nextCursor, undefined);
    assert.equal((await get(viewer.url, "api/sessions?cursor=c_forged")).status, 404);
    assert.equal((await get(viewer.url, "api/sessions/0")).status, 404);
    assert.equal(response.sessions.filter((session) => session.classification === "main").length, 31);
    assert.equal(response.sessions.filter((session) => session.classification === "subagent").length, 30);
    for (const session of response.sessions) {
      assert.match(session.handle, /^s_[A-Za-z0-9_-]{32}$/);
      assert.deepEqual(Object.keys(session).sort(), ["classification", "handle", "modified"]);
    }
    assert.doesNotMatch(JSON.stringify(response), new RegExp(`${id}|cwd|file|index|private subagent work`));

    let handle; let page;
    for (const candidate of response.sessions) {
      const trial = await eventPage(viewer, candidate.handle, "?limit=2");
      if (trial.events.length === 2 && trial.nextCursor) { handle = candidate.handle; page = trial; break; }
    }
    assert.ok(handle, "catalog lookup does not create an event snapshot until a handle is selected");
    assert.equal(page.events.length, 2); assert.match(page.nextCursor, /^c_[A-Za-z0-9_-]{32}$/);
    assert.doesNotMatch(JSON.stringify(page), new RegExp(`${id}|entry-secret|projectRoot|cwd|file|token`));
    const later = await eventPage(viewer, handle, `?cursor=${page.nextCursor}&limit=2`);
    assert.equal(new Set([...page.events, ...later.events].map((event) => event.noteReference)).size, page.events.length + later.events.length);
    const laterNotes = `api/sessions/${handle}/events/${later.events[0].noteReference}/notes`;
    assert.equal((await get(viewer.url, laterNotes, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Later page context." }) })).status, 200);
    assert.equal((await get(viewer.url, `api/sessions/${response.sessions.at(-1).handle}/events?cursor=${page.nextCursor}`)).status, 404);
    assert.equal((await get(viewer.url, `api/sessions/${handle}/events?limit=101`)).status, 404);
    const report = await (await get(viewer.url, `api/reports/${(await (await get(viewer.url, "api/reports")).json()).reports[0].handle}`)).text();
    assert.match(report, /Local report/); assert.match(report, /default-src 'none'/); assert.match(sandboxedReportHtml("<script>bad()</script>"), /default-src 'none'/);
  } finally { viewer.close(); }
});

test("viewer snapshot eviction invalidates held cursors without crossing sessions", async () => {
  const { directory, sessions, reports } = await fixture();
  for (let index = 0; index <= VIEWER_MAX_SNAPSHOTS; index += 1) {
    const id = `019fd4f3-b574-7953-a984-ffb49a51${String(index).padStart(4, "0")}`;
    await writeFile(join(sessions, "project", `snapshot-${String(index).padStart(2, "0")}.jsonl`), [
      JSON.stringify({ type: "session", id, timestamp: `2025-03-01T00:${String(index).padStart(2, "0")}:00.000Z`, cwd: directory }),
      JSON.stringify({ type: "message", timestamp: "2025-03-01T01:00:00.000Z", message: { role: "user", content: `first ${index}` } }),
      JSON.stringify({ type: "message", timestamp: "2025-03-01T01:01:00.000Z", message: { role: "assistant", content: `second ${index}` } }),
    ].join("\n"));
  }
  const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "e".repeat(43), idleMs: 60_000 });
  try {
    const handles = (await catalog(viewer)).sessions.map((session) => session.handle); assert.equal(handles.length, VIEWER_MAX_SNAPSHOTS + 2);
    const first = await eventPage(viewer, handles[0], "?limit=1"); assert.ok(first.nextCursor);
    let current;
    for (const handle of handles.slice(1)) current = await eventPage(viewer, handle, "?limit=1");
    assert.equal((await get(viewer.url, `api/sessions/${handles[0]}/events?cursor=${first.nextCursor}&limit=1`)).status, 404);
    const retained = await eventPage(viewer, handles.at(-1), `?cursor=${current.nextCursor}&limit=1`); assert.equal(retained.events.length, 1);
  } finally { viewer.close(); }
});

test("viewer preserves held cursors at capacity and explicitly rejects a new initial page", async () => {
  const { sessions, reports } = await fixture(); const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "p".repeat(43), idleMs: 60_000 });
  try {
    const handle = await sessionHandle(viewer); const held = await eventPage(viewer, handle, "?limit=1"); assert.match(held.nextCursor, /^c_[A-Za-z0-9_-]{32}$/);
    for (let index = 1; index < VIEWER_MAX_CURSORS; index += 1) { const page = await eventPage(viewer, handle, "?limit=1"); assert.match(page.nextCursor, /^c_[A-Za-z0-9_-]{32}$/); }
    const capacity = await get(viewer.url, `api/sessions/${handle}/events?limit=1`);
    assert.equal(capacity.status, 429); assert.deepEqual(await capacity.json(), { capacity: true }, "a saturated initial page reports retryable capacity instead of silently omitting nextCursor");
    const continuedResponse = await get(viewer.url, `api/sessions/${handle}/events?cursor=${held.nextCursor}&limit=1`);
    assert.equal(continuedResponse.status, 200, "a held oldest continuation remains valid after other requests fill capacity");
    const continued = await continuedResponse.json(); assert.match(continued.nextCursor, /^c_[A-Za-z0-9_-]{32}$/);
    const later = await eventPage(viewer, handle, `?cursor=${continued.nextCursor}&limit=1`);
    assert.equal(later.events.length, 1, "consuming a continuation reserves and reuses its freed cursor slot");
  } finally { viewer.close(); }
});

test("viewer browser keeps the reader-first a11y and local-only UI contract", async () => {
  const page = viewerPage(); const script = viewerScript();
  assert.match(page, /id="navigation-drawer"[^>]*role="dialog"/); assert.match(page, /id="drawer-toggle"[^>]*aria-expanded="false"/); assert.match(page, /id="load-more-events"[^>]*aria-label="Load more conversation events"/);
  assert.match(page, /id="transcript"[^>]*aria-busy="false"/); assert.doesNotMatch(page, /id="transcript"[^>]*aria-live/); assert.match(page, /id="copy-status"[^>]*role="status"/);
  assert.match(script, /navigator\.clipboard\?\.writeText/); assert.match(script, /document\.execCommand\('copy'\)/); assert.match(script, /Could not copy Pi handoff/);
  assert.match(script, /events\.filter\(e=>e\.category==='user'\|\|e\.category==='assistant'\)/); assert.match(script, /Showing '\+shown\.length\+' loaded events/); assert.match(script, /time\.dateTime=e\.timestamp/);
  assert.match(script, /api\/sessions\/'.*events.*notes/); assert.match(script, /method:'POST'/); assert.match(script, /method:'PUT'/); assert.match(script, /method:'DELETE'/); assert.match(script, /Local-only, user-authored context/); assert.match(script, /async function openNotes/); assert.doesNotMatch(script, /loadNotes\(.*S\.events/);
  assert.match(script, /toggle\.setAttribute\('aria-expanded','true'\)/); assert.match(script, /e\.key==='Escape'/); assert.match(script, /document\.activeElement===last/); assert.match(script, /aria-current','page/);
  assert.match(page, /id="sessions-capped"[^>]*role="status"/); assert.match(script, /S\.catalog=d\.sessions/); assert.match(page, /Conversation list is capped for local performance/); assert.match(script, /r\.status===429&&body\?\.capacity===true/); assert.match(script, /Conversation paging is temporarily at capacity\. Retry opening it\./); assert.match(script, /Conversation paging is temporarily at capacity\. Retry loading more events\./); assert.doesNotMatch(script, /Load more conversations|catalogCursor|sessions-more|Promise\.all\(\[catalog/);
  assert.doesNotMatch(script, /api\(base\)/); assert.doesNotMatch(script, /https:\/\//);
  const syntaxDirectory = await mkdtemp(join(tmpdir(), "pi-viewer-syntax-")); const syntaxFile = join(syntaxDirectory, "viewer-script.mjs"); await writeFile(syntaxFile, script);
  await new Promise((resolveCheck, rejectCheck) => { const child = spawn(process.execPath, ["--check", syntaxFile]); child.once("error", rejectCheck); child.once("exit", (code) => code === 0 ? resolveCheck() : rejectCheck(new Error("Viewer script has invalid syntax."))); });
});

test("viewer styles retain the dark green palette without light-paper variables", () => {
  const styles = viewerStyles();
  assert.match(styles, /^:root\{color-scheme:dark;/);
  for (const token of ["--canvas:#101411", "--surface:#151b16", "--green:#a8dba8", "--cyan:#8fd5d1", "--amber:#dfbd7a"]) assert.match(styles, new RegExp(token));
  assert.doesNotMatch(styles, /color-scheme:light|--(?:paper|ink|accent(?:-quiet)?|focus):|#fbfaf6|#fffefa/);
  assert.match(styles, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(styles, /@media \(forced-colors:active\)/);
});

test("viewer note errors retain recovery controls and reset before retry or success", () => {
  const script = viewerScript();
  assert.match(script, /if\(e\.noteError\)\{const p=document\.createElement\('p'\),retry=document\.createElement\('button'\).*?retry\.textContent='Retry notes'.*?box\.append\(p,retry\)\}if\(e\.noteLoading\)/);
  assert.match(script, /async function noteRequest\(e,box,error,request,loading=false\)\{e\.noteError=undefined;.*?try\{await request\(\);e\.noteError=undefined;/);
  assert.match(script, /box\.append\(list\);const form=.*?box\.append\(form\)\}/);
  assert.match(script, /close\.textContent='Close notes'/);
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
  try { const handle = await sessionHandle(viewer); const detail = await eventPage(viewer, handle); const event = detail.events[0]; assert.match(event.noteReference, /^event-[a-f0-9]{32}$/); assert.doesNotMatch(JSON.stringify(detail), new RegExp(`${id}|entry-secret|projectRoot|cwd`)); const base = `api/sessions/${handle}/events/${event.noteReference}/notes`; assert.deepEqual((await (await get(viewer.url, base)).json()).notes, []); const created = await get(viewer.url, base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Local reviewed context." }) }); assert.equal(created.status, 200); const after = await created.json(); assert.equal(after.notes.length, 1); assert.equal(after.notes[0].eventReference, event.noteReference); const noteId = after.notes[0].noteId; assert.equal((await get(viewer.url, `${base}/${noteId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Updated local context." }) })).status, 200); const deleted = await get(viewer.url, `${base}/${noteId}`, { method: "DELETE" }); assert.equal(deleted.status, 200); assert.deepEqual((await deleted.json()).notes, []); assert.equal((await get(viewer.url, `api/sessions/0/events/event-${"a".repeat(32)}/notes`)).status, 404); } finally { viewer.close(); }
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


test("viewer discovery caps candidate files, recursion depth, and catalog results deterministically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-viewer-discovery-")); const sessions = join(directory, "sessions"); await mkdir(join(sessions, "nested", "deeper"), { recursive: true });
  const header = (id, timestamp) => `${JSON.stringify({ type: "session", id, timestamp, cwd: directory })}\n`;
  await writeFile(join(sessions, "a.jsonl"), header("019fd4f3-b574-7953-a984-ffb49a519201", "2025-01-01T00:00:00.000Z"));
  await writeFile(join(sessions, "b.jsonl"), header("019fd4f3-b574-7953-a984-ffb49a519202", "2025-01-02T00:00:00.000Z"));
  await writeFile(join(sessions, "nested", "deeper", "hidden.jsonl"), header("019fd4f3-b574-7953-a984-ffb49a519203", "2025-01-03T00:00:00.000Z"));
  const candidateCapped = await discoverSessions({ sessionDirectory: sessions, maxCandidates: 1 }); assert.equal(candidateCapped.length, 1); assert.equal(candidateCapped.capped, true);
  const depthCapped = await discoverSessions({ sessionDirectory: sessions, maxDepth: 0 }); assert.equal(depthCapped.length, 2); assert.equal(depthCapped.capped, true);
  const resultCapped = await discoverSessions({ sessionDirectory: sessions, maxCandidates: 10, maxDepth: 8, maxResults: 1 }); assert.equal(resultCapped.length, 1); assert.equal(resultCapped.capped, true); assert.match(resultCapped[0].file, /hidden\.jsonl$/);
  for (const bounds of [
    { maxCandidates: Number.NaN, maxDepth: Number.NaN, maxResults: Number.NaN },
    { maxCandidates: Infinity, maxDepth: Infinity, maxResults: Infinity },
    { maxCandidates: -Infinity, maxDepth: -Infinity, maxResults: -Infinity },
  ]) { const normalized = await discoverSessions({ sessionDirectory: sessions, ...bounds }); assert.equal(normalized.length, 3); assert.equal(normalized.capped, false); }
  const fractionalCandidates = await discoverSessions({ sessionDirectory: sessions, maxCandidates: 1.9, maxDepth: 8, maxResults: 10 }); assert.equal(fractionalCandidates.length, 1); assert.equal(fractionalCandidates.capped, true);
  const fractionalDepth = await discoverSessions({ sessionDirectory: sessions, maxCandidates: 10, maxDepth: 0.9, maxResults: 10 }); assert.equal(fractionalDepth.length, 2); assert.equal(fractionalDepth.capped, true);
  const fractionalResults = await discoverSessions({ sessionDirectory: sessions, maxCandidates: 10, maxDepth: 8, maxResults: 1.9 }); assert.equal(fractionalResults.length, 1); assert.equal(fractionalResults.capped, true);
});

test("viewer returns a capped notice with the complete hard-bounded catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-viewer-catalog-cap-")); const sessions = join(directory, "sessions"); const reports = join(directory, "reports"); await mkdir(sessions); await mkdir(reports);
  await Promise.all(Array.from({ length: 251 }, async (_, index) => writeFile(join(sessions, `${String(index).padStart(3, "0")}.jsonl`), `${JSON.stringify({ type: "session", id: `019fd4f3-b574-7953-a984-ffb49a51${String(index).padStart(4, "0")}`, timestamp: "2025-04-01T00:00:00.000Z", cwd: directory })}
`)));
  const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "k".repeat(43), idleMs: 60_000 });
  try { const response = await catalog(viewer); assert.equal(response.sessions.length, 250); assert.equal(response.capped, true); assert.equal(response.nextCursor, undefined); } finally { viewer.close(); }
});

test("viewer discovery and full catalog fetch do not project transcripts before selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-viewer-metadata-")); const sessions = join(directory, "sessions"); const reports = join(directory, "reports"); await mkdir(sessions); await mkdir(reports);
  const id = "019fd4f3-b574-7953-a984-ffb49a519207"; const oversized = "x".repeat(VIEWER_MAX_SESSION_FILE_BYTES);
  await writeFile(join(sessions, "large.jsonl"), `${JSON.stringify({ type: "session", id, timestamp: "2025-02-03T04:05:06.000Z", cwd: directory })}
${JSON.stringify({ type: "message", message: { role: "user", content: oversized } })}
`);
  const found = await discoverSessions({ sessionDirectory: sessions });
  assert.equal(found.length, 1); assert.equal(found[0].entries, undefined); assert.equal(found[0].messageCount, undefined); assert.match(found[0].file, /large\.jsonl$/);
  const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "m".repeat(43), idleMs: 60_000 });
  try {
    const response = await catalog(viewer); assert.equal(response.sessions.length, 1); assert.deepEqual(Object.keys(response.sessions[0]).sort(), ["classification", "handle", "modified"]);
    assert.equal((await get(viewer.url, `api/sessions/${response.sessions[0].handle}/events`)).status, 404, "oversized transcript is opened and rejected only after selection");
  } finally { viewer.close(); }
});

test("viewer classifies only complete bounded session_info.name markers and never exposes names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-viewer-classification-")); const sessions = join(directory, "sessions"); const reports = join(directory, "reports"); await mkdir(sessions); await mkdir(reports);
  const id = (index) => `019fd4f3-b574-7953-a984-ffb49a519${String(index).padStart(3, "0")}`;
  const header = (index) => JSON.stringify({ type: "session", id: id(index), timestamp: `2025-04-01T00:00:${String(index).padStart(2, "0")}.000Z`, cwd: join(directory, "subagent-path") });
  const file = async (name, index, records) => writeFile(join(sessions, name), [header(index), ...records.map(JSON.stringify)].join("\n") + "\n");
  await file("main.jsonl", 1, [{ type: "session_info", name: "A main conversation" }]);
  await file("case.jsonl", 2, [{ type: "session_info", name: "Background SuBaGeNt work" }]);
  await file("subagent-filename.jsonl", 3, [{ type: "message", name: "subagent", path: "subagent", message: { role: "assistant", content: [{ type: "toolCall", name: "subagent" }] } }]);
  await file("invalid.jsonl", 4, [{ type: "session_info", name: { marker: "subagent" } }, { type: "message", content: "subagent" }]);
  await writeFile(join(sessions, "malformed.jsonl"), `${header(8)}\n{"type":"session_info","name":"subagent"\n`);
  const exactHeader = header(5); const exactPrefix = `${exactHeader}\n{"type":"session_info","name":"`; const exactName = `subagent${"x".repeat(VIEWER_HEADER_BYTES - Buffer.byteLength(exactPrefix) - Buffer.byteLength("subagent") - Buffer.byteLength("\"}\n"))}`;
  await writeFile(join(sessions, "exact-cap.jsonl"), `${exactPrefix}${exactName}"}\n`);
  const afterHeader = header(6); const paddingPrefix = `${afterHeader}\n{"type":"message","content":"`; const padding = "x".repeat(VIEWER_HEADER_BYTES - Buffer.byteLength(paddingPrefix) - Buffer.byteLength("\"}\n"));
  await writeFile(join(sessions, "beyond-cap.jsonl"), `${paddingPrefix}${padding}"}\n${JSON.stringify({ type: "session_info", name: "subagent beyond cap" })}\n`);
  await writeFile(join(sessions, "header-beyond-cap.jsonl"), `${" ".repeat(VIEWER_HEADER_BYTES)}\n${header(7)}\n${JSON.stringify({ type: "session_info", name: "subagent" })}\n`);

  const found = await discoverSessions({ sessionDirectory: sessions });
  assert.equal(found.length, 7, "a header outside the fixed prefix is not discoverable");
  const byId = new Map(found.map((session) => [session.id, session]));
  assert.equal(byId.get(id(1)).classification, "main"); assert.equal(byId.get(id(2)).classification, "subagent");
  for (const index of [3, 4, 6, 8]) assert.equal(byId.get(id(index)).classification, "main");
  assert.equal(byId.get(id(5)).classification, "subagent", "a record ending exactly at the cap is complete");

  const viewer = await startViewer({ sessionDirectory: sessions, reportDirectory: reports, token: "g".repeat(43), idleMs: 60_000 });
  try {
    const response = await catalog(viewer); const serialized = JSON.stringify(response);
    assert.deepEqual(new Set(response.sessions.map((session) => session.classification)), new Set(["main", "subagent"]));
    for (const group of [response.sessions.filter((session) => session.classification === "main"), response.sessions.filter((session) => session.classification === "subagent")]) assert.deepEqual(group.map((session) => session.modified), [...group].sort((left, right) => right.modified.localeCompare(left.modified)).map((session) => session.modified));
    for (const secret of ["A main conversation", "Background SuBaGeNt work", "subagent beyond cap", "subagent-path", "exactName"]) assert.doesNotMatch(serialized, new RegExp(secret));
    for (const session of response.sessions) assert.deepEqual(Object.keys(session).sort(), ["classification", "handle", "modified"]);
  } finally { viewer.close(); }
});

test("viewer drawer has three independent semantic groups and keeps conversation groups separate", () => {
  const page = viewerPage(); const script = viewerScript();
  assert.match(page, /<details class="drawer-section" open><summary id="main-sessions-heading">Conversations — Main<\/summary>/);
  assert.match(page, /<details class="drawer-section" open><summary id="subagent-sessions-heading">Conversations — Subagent<\/summary>/);
  assert.match(page, /<details class="drawer-section" open><summary id="reports-heading">Hindsight Reports<\/summary>/);
  assert.match(script, /#sessions-main/); assert.match(script, /#sessions-subagent/); assert.match(script, /x\.classification==='subagent'/);
  assert.match(script, /No main conversations found\./); assert.match(script, /No subagent conversations found\./); assert.match(script, /No hindsight reports found\./);
  assert.match(page, /id="sessions-capped"/); assert.match(script, /S\.catalog=d\.sessions/); assert.doesNotMatch(page + script, /Load more conversations|sessions-more|catalogCursor/); assert.match(script, /summary,\[href\]/);
});
