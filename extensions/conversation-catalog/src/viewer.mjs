import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { projectConversation } from "./conversation.mjs";
import { defaultHindsightReportDirectory } from "./hindsight-output.mjs";

export const VIEWER_IDLE_MS = 5 * 60 * 1000;
export const VIEWER_MAX_LIFETIME_MS = 30 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/i;

function asText(value) { return typeof value === "string" ? value.trim() : ""; }
function safeDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "Unknown time";
}
function safeCount(entries) { return Array.isArray(entries) ? entries.filter((entry) => entry?.type === "message").length : 0; }
function genericError(response, status = 404) { response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }); response.end(status === 403 ? "Forbidden" : "Not found"); }

/** The only Pi session location inspected by the standalone viewer. */
export function defaultPiSessionDirectory({ home = homedir() } = {}) {
  if (!asText(home)) throw new Error("Unable to determine the local Pi session directory.");
  return join(home, ".pi", "agent", "sessions");
}

async function walkSessionFiles(directory, files = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return files; throw error; }
  for (const entry of entries) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory()) await walkSessionFiles(candidate, files);
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") files.push(candidate);
  }
  return files;
}

async function readSession(file) {
  let lines;
  try { lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean); } catch { return undefined; }
  let header;
  const entries = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value?.type === "session" && !header) header = value;
      else if (value && typeof value === "object") entries.push(value);
    } catch { return undefined; }
  }
  const id = asText(header?.id);
  if (!header || !SESSION_ID_PATTERN.test(id)) return undefined;
  return { id, modified: safeDate(header.timestamp), timestamp: header.timestamp, messageCount: safeCount(entries), entries };
}

/** Reads only regular JSONL files below Pi's default session directory. */
export async function discoverSessions({ sessionDirectory = defaultPiSessionDirectory() } = {}) {
  const root = resolve(sessionDirectory);
  const files = await walkSessionFiles(root);
  const sessions = [];
  for (const file of files) {
    // Defense in depth should a future walker be changed: never follow a path outside the known root.
    if (relative(root, file).startsWith("..")) continue;
    const session = await readSession(file);
    if (session) sessions.push(session);
  }
  return sessions.sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
}

/** Reads only regular HTML reports from the documented default report directory. */
export async function discoverReports({ reportDirectory = defaultHindsightReportDirectory({ home: homedir() }) } = {}) {
  let entries;
  try { entries = await readdir(reportDirectory, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const reports = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".html") continue;
    const file = join(reportDirectory, entry.name);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      reports.push({ name: basename(entry.name), modified: safeDate(info.mtime), file });
    } catch { /* stale report: omit it */ }
  }
  return reports.sort((left, right) => right.modified.localeCompare(left.modified));
}

/** Bounded lifetime rules are pure so the launcher never becomes a background service. */
export function viewerShouldClose({ started, lastHeartbeat, now, idleMs = VIEWER_IDLE_MS, maxLifetimeMs = VIEWER_MAX_LIFETIME_MS }) {
  return now - lastHeartbeat > idleMs || now - started > maxLifetimeMs;
}

export function viewerPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"><title>Pi Conversation Viewer</title><link rel="stylesheet" href="assets/viewer.css"></head><body><main><header><h1>Pi Conversation Viewer</h1><button id="close" type="button">Close Viewer</button></header><p class="notice">Local, read-only viewer. Selecting a conversation does not invoke Pi, a model, or report generation.</p><section><h2>Saved conversations</h2><div id="sessions" aria-live="polite">Loading…</div></section><section><h2>Hindsight reports</h2><div id="reports" aria-live="polite">Loading…</div></section><section id="detail" hidden><h2 id="detail-title">Selected conversation</h2><button id="copy" type="button">Copy Pi handoff command</button><p id="copy-status" role="status"></p><div id="transcript"></div></section><section id="report-detail" hidden><h2>Selected report</h2><iframe id="report-frame" sandbox title="Local hindsight report"></iframe></section></main><script src="assets/viewer.js"></script></body></html>`;
}

export function sandboxedReportHtml(html) {
  // srcdoc does not inherit the HTTP response CSP, so add a restrictive policy
  // before placing a user-local report into the sandboxed frame.
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">${typeof html === "string" ? html : ""}`;
}

export function viewerStyles() { return `:root{font-family:system-ui,sans-serif;color:#172033;background:#f7f8fa}body{margin:0}main{max-width:960px;margin:auto;padding:1.5rem}header{display:flex;justify-content:space-between;gap:1rem;align-items:center}button{padding:.45rem .7rem}section{margin-top:1.5rem;background:#fff;border:1px solid #d8dde6;padding:1rem;border-radius:.4rem}.notice{color:#445}ul{padding-left:1.2rem}li{margin:.5rem 0}.meta{color:#566;font-size:.9rem}article{white-space:pre-wrap;border-top:1px solid #e5e8ed;padding:.75rem 0}article:first-child{border-top:0}iframe{width:100%;min-height:620px;border:1px solid #ccd3dd}`; }

export function viewerScript() { return `(() => { const q=(s)=>document.querySelector(s); let selected; const api=(path, options)=>fetch(path, options).then(r=>r.ok?r.json():Promise.reject(new Error('Request unavailable'))); const list=(target, values, make, empty)=>{const node=q(target);node.replaceChildren();if(!values.length){node.textContent=empty;return;}const ul=document.createElement('ul');for(const value of values)ul.append(make(value));node.append(ul);}; const item=(label, click)=>{const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=click;li.append(button);return li;}; async function load(){try{const [sessions,reports]=await Promise.all([api('api/sessions'),api('api/reports')]);list('#sessions',sessions,s=>item('Session '+s.id+' — '+s.modified+' ('+s.messageCount+' messages)',()=>selectSession(s.index)),'No saved conversations found.');list('#reports',reports,r=>item(r.name+' — '+r.modified,()=>selectReport(r.index)),'No hindsight reports found.');}catch{q('#sessions').textContent='Viewer data is unavailable.';q('#reports').textContent='Viewer data is unavailable.';}} async function selectSession(index){try{const data=await api('api/sessions/'+index);selected=data.id;q('#detail-title').textContent='Session '+data.id;q('#transcript').replaceChildren(...data.events.map(e=>{const a=document.createElement('article'),h=document.createElement('strong'),p=document.createElement('div');h.textContent=e.timestamp+' — '+e.title;p.textContent=e.summary;a.append(h,p);return a;}));q('#detail').hidden=false;q('#report-detail').hidden=true;}catch{q('#detail').hidden=true;}} async function selectReport(index){try{const response=await fetch('api/reports/'+index);if(!response.ok)throw new Error();q('#report-frame').srcdoc=await response.text();q('#report-detail').hidden=false;}catch{q('#report-detail').hidden=true;}} q('#copy').onclick=async()=>{if(!selected)return;const command='/hindsight-document '+selected;try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(command);q('#copy-status').textContent='Pi handoff command copied.';}catch{const area=document.createElement('textarea');area.value=command;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();try{if(!document.execCommand('copy'))throw new Error();q('#copy-status').textContent='Pi handoff command copied.';}catch{q('#copy-status').textContent='Copy failed. Select and copy the Pi handoff command manually: '+command;}finally{area.remove();}}}; q('#close').onclick=()=>fetch('api/close',{method:'POST'}).finally(()=>window.close()); setInterval(()=>fetch('api/heartbeat',{method:'POST'}).catch(()=>{}),30000);load(); })();`; }

export async function startViewer({ host = "127.0.0.1", port = 0, token = randomBytes(32).toString("base64url"), sessionDirectory, reportDirectory, idleMs = VIEWER_IDLE_MS, maxLifetimeMs = VIEWER_MAX_LIFETIME_MS, now = () => Date.now() } = {}) {
  if (host !== "127.0.0.1") throw new Error("The viewer may bind only to 127.0.0.1.");
  if (!TOKEN_PATTERN.test(token)) throw new Error("The viewer token is invalid.");
  const sessions = await discoverSessions({ sessionDirectory });
  const reports = await discoverReports({ reportDirectory });
  let closed = false; let lastHeartbeat = now(); let timer;
  const close = () => { if (!closed) { closed = true; clearInterval(timer); server.close(); } };
  const server = createServer(async (request, response) => {
    const expectedHost = `127.0.0.1:${server.address().port}`;
    const origin = request.headers.origin;
    if (request.headers.host !== expectedHost || (origin && origin !== `http://${expectedHost}`)) return genericError(response, 403);
    const pathname = new URL(request.url, `http://${expectedHost}`).pathname;
    const prefix = `/${token}/`;
    if (!pathname.startsWith(prefix)) return genericError(response, 404);
    const route = pathname.slice(prefix.length);
    response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "POST" && (route === "api/heartbeat" || route === "api/close")) { lastHeartbeat = now(); response.writeHead(204); response.end(); if (route === "api/close") setImmediate(close); return; }
    if (request.method !== "GET") return genericError(response, 404);
    if (route === "" || route === "index.html") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return response.end(viewerPage()); }
    if (route === "assets/viewer.css") { response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }); return response.end(viewerStyles()); }
    if (route === "assets/viewer.js") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); return response.end(viewerScript()); }
    if (route === "api/sessions") return response.end(JSON.stringify(sessions.map((session, index) => ({ index, id: session.id, modified: session.modified, messageCount: session.messageCount }))));
    if (route === "api/reports") return response.end(JSON.stringify(reports.map((report, index) => ({ index, name: report.name, modified: report.modified }))));
    const sessionMatch = /^api\/sessions\/(\d+)$/.exec(route);
    if (sessionMatch) { const session = sessions[Number(sessionMatch[1])]; if (!session) return genericError(response); const projection = projectConversation(session.entries); return response.end(JSON.stringify({ id: session.id, events: projection.events.map(({ timestamp, title, summary }) => ({ timestamp, title, summary })) })); }
    const reportMatch = /^api\/reports\/(\d+)$/.exec(route);
    if (reportMatch) { const report = reports[Number(reportMatch[1])]; if (!report) return genericError(response); try { const html = sandboxedReportHtml(await readFile(report.file, "utf8")); response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" }); return response.end(html); } catch { return genericError(response); } }
    return genericError(response);
  });
  await new Promise((resolveServer, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolveServer(); }); });
  const started = now();
  timer = setInterval(() => { if (viewerShouldClose({ started, lastHeartbeat, now: now(), idleMs, maxLifetimeMs })) close(); }, Math.min(1000, idleMs));
  timer.unref?.();
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}/${token}/`, close, server, token };
}
