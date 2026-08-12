import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { projectConversation } from "./conversation.mjs";
import { defaultHindsightReportDirectory } from "./hindsight-output.mjs";
import { pseudonymizeSession } from "./redaction.mjs";
import { addHindsightNote, deleteHindsightNote, editHindsightNote, hindsightNotesSessionReference, readHindsightNotes } from "./hindsight-notes.mjs";

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
  return { id, projectRoot: asText(header.cwd), modified: safeDate(header.timestamp), timestamp: header.timestamp, messageCount: safeCount(entries), entries };
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"><title>Pi Conversation Viewer</title><link rel="stylesheet" href="assets/viewer.css"></head><body><div class="app-shell"><header class="app-header"><button id="drawer-toggle" class="icon-button" type="button" aria-controls="navigation-drawer" aria-expanded="false" aria-label="Open conversation navigation"><span aria-hidden="true">☰</span></button><div><p class="eyebrow">LOCAL REPLAY</p><h1>Pi Conversation Viewer</h1></div><p class="local-state"><span aria-hidden="true">●</span> Read-only local</p></header><div id="drawer-backdrop" class="drawer-backdrop" hidden></div><aside id="navigation-drawer" class="navigation-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" hidden><header class="drawer-header"><div><p class="eyebrow">NAVIGATION</p><h2 id="drawer-title">Sessions &amp; reports</h2></div><button id="drawer-close" class="icon-button" type="button" aria-label="Close conversation navigation"><span aria-hidden="true">×</span></button></header><section class="drawer-section" aria-labelledby="sessions-heading"><h3 id="sessions-heading">Saved conversations</h3><div id="sessions" aria-live="polite">Loading conversations…</div></section><section class="drawer-section" aria-labelledby="reports-heading"><h3 id="reports-heading">Hindsight reports</h3><div id="reports" aria-live="polite">Loading reports…</div></section></aside><main id="reader" tabindex="-1"><p class="notice">Local, read-only replay. Selecting a conversation does not invoke Pi, a model, or report generation.</p><section id="reader-empty" class="reader-state" aria-labelledby="reader-empty-title"><p class="eyebrow">READY</p><h2 id="reader-empty-title">Choose a local conversation</h2><p>Open navigation to select a saved Pi session or a local hindsight report.</p><button id="empty-open-drawer" type="button">Open navigation</button></section><section id="detail" class="conversation-reader" hidden aria-labelledby="detail-title"><header class="reader-header"><div><p class="eyebrow">SESSION REPLAY</p><h2 id="detail-title">Selected conversation</h2></div><div class="handoff"><div class="handoff-label">PI HANDOFF</div><code id="handoff-command">/hindsight-document session-reference</code><button id="copy" class="copy-button" type="button" aria-label="Copy Pi handoff command" title="Copy Pi handoff command"><span id="copy-icon" aria-hidden="true">⧉</span><span class="sr-only">Copy Pi handoff command</span></button><p id="copy-status" class="sr-only" role="status" aria-live="polite"></p></div></header><label class="filter-control"><input id="conversation-only" type="checkbox"><span>Conversation only</span><span class="filter-help">Hide tool, skill, and system/status events</span></label><div id="transcript" class="transcript" aria-live="polite"></div><section class="notes" aria-labelledby="notes-heading"><header><div><p class="eyebrow">LOCAL CONTEXT</p><h3 id="notes-heading">Notes</h3></div><button id="note-add" type="button">Add note</button></header><p>Current-session user-authored context. Not transcript evidence or citations.</p><div id="notes-list" aria-live="polite">Select a conversation to view its notes.</div><form id="note-form" hidden><label for="note-text">Note text</label><textarea id="note-text" maxlength="2000" required></textarea><div><button id="note-save" type="submit">Save note</button><button id="note-cancel" type="button">Cancel</button></div></form><p id="notes-status" role="status" aria-live="polite"></p></section></section><section id="report-detail" class="report-reader" hidden aria-labelledby="report-title"><header class="reader-header"><div><p class="eyebrow">LOCAL REPORT</p><h2 id="report-title">Selected report</h2></div></header><iframe id="report-frame" sandbox title="Local hindsight report"></iframe></section></main></div><script src="assets/viewer.js"></script></body></html>`;
}

export function sandboxedReportHtml(html) {
  // srcdoc does not inherit the HTTP response CSP, so add a restrictive policy
  // before placing a user-local report into the sandboxed frame.
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">${typeof html === "string" ? html : ""}`;
}

export function viewerStyles() { return `:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;color:#d7e1d5;background:#101411;--surface:#151b16;--surface-raised:#1b231c;--line:#344037;--muted:#99a89a;--green:#a8dba8;--cyan:#8fd5d1;--amber:#dfbd7a;--danger:#e6a39b}*{box-sizing:border-box}body{margin:0;min-width:320px;background:radial-gradient(circle at top,#1c271e 0,#101411 42rem);min-height:100vh}button,input{font:inherit}button{cursor:pointer;color:inherit;background:#202a21;border:1px solid #465348;border-radius:.45rem;padding:.55rem .7rem}button:hover{background:#2a352b}button:focus-visible,input:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}.app-shell{min-height:100vh}.app-header{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:.85rem;min-height:4.4rem;padding:.75rem clamp(1rem,4vw,3rem);border-bottom:1px solid var(--line);background:rgba(16,20,17,.95);backdrop-filter:blur(12px)}h1,h2,h3,p{margin:0}h1{font-size:1rem;letter-spacing:.02em}.eyebrow{color:var(--green);font-size:.67rem;font-weight:700;letter-spacing:.12em}.local-state{margin-left:auto;color:var(--muted);font-size:.75rem}.local-state span{color:var(--green)}.icon-button{display:grid;place-items:center;width:2.4rem;height:2.4rem;padding:0;font-size:1.25rem}.drawer-backdrop{position:fixed;inset:0;z-index:4;background:rgba(0,0,0,.55)}.navigation-drawer{position:fixed;z-index:5;top:0;bottom:0;left:0;width:min(25rem,92vw);padding:1.25rem;overflow:auto;border-right:1px solid var(--line);background:#121813;box-shadow:1rem 0 3rem rgba(0,0,0,.38)}.drawer-header,.reader-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.drawer-header h2,.reader-header h2{margin-top:.2rem;font-size:1.05rem}.drawer-section{margin-top:1.6rem}.drawer-section h3{color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.08em}.drawer-section ul{display:grid;gap:.5rem;padding:0;margin:.75rem 0 0;list-style:none}.nav-item{width:100%;text-align:left;line-height:1.35}.nav-item.is-selected{border-color:var(--green);background:#273227}.nav-item-meta{display:block;margin-top:.2rem;color:var(--muted);font-size:.7rem}main{width:min(1100px,100%);margin:0 auto;padding:clamp(1rem,4vw,3rem)}.notice{margin:0 0 1rem;color:var(--muted);font-size:.78rem;line-height:1.5}.reader-state,.conversation-reader,.report-reader{border:1px solid var(--line);border-radius:.7rem;background:rgba(21,27,22,.94);box-shadow:0 1.2rem 3.5rem rgba(0,0,0,.16)}.reader-state{padding:clamp(1.5rem,6vw,4rem);text-align:center}.reader-state h2{margin:.45rem 0;font-size:clamp(1.2rem,3vw,1.7rem)}.reader-state p:not(.eyebrow){max-width:40rem;margin:0 auto 1.25rem;color:var(--muted);line-height:1.6}.conversation-reader,.report-reader{overflow:hidden}.reader-header{padding:1.1rem 1.15rem;border-bottom:1px solid var(--line)}.handoff{display:grid;grid-template-columns:1fr auto;gap:.25rem .5rem;min-width:min(31rem,58vw);padding:.55rem .65rem;border:1px solid #405143;border-radius:.55rem;background:#101511}.handoff-label{grid-column:1/-1;color:var(--muted);font-size:.62rem;font-weight:700;letter-spacing:.11em}.handoff code{min-width:0;overflow:auto;color:var(--green);font-size:.72rem;white-space:nowrap}.copy-button{grid-column:2;grid-row:2;width:2rem;height:1.75rem;padding:0;border-color:transparent;background:transparent}.filter-control{display:flex;align-items:center;gap:.55rem;padding:.8rem 1.15rem;border-bottom:1px solid var(--line);color:#c3cec1;font-size:.78rem}.filter-control input{accent-color:var(--green)}.filter-help{color:var(--muted);font-size:.7rem}.transcript{padding:.3rem 1.15rem 1rem}.event{position:relative;padding:1rem 0 1rem 1rem;border-bottom:1px solid rgba(52,64,55,.72)}.event:last-child{border:0}.event::before{position:absolute;top:1.15rem;left:0;width:.35rem;height:.35rem;border-radius:50%;background:var(--muted);content:""}.event--user::before{background:var(--green)}.event--assistant::before{background:var(--cyan)}.event--tool-call::before,.event--tool-result::before{background:var(--amber)}.event--unsupported::before{background:var(--danger)}.event-head{display:flex;align-items:center;gap:.55rem;color:var(--muted);font-size:.7rem}.event-kind{padding:.13rem .35rem;border:1px solid currentColor;border-radius:.25rem;color:var(--green);font-size:.61rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.event--tool-call .event-kind,.event--tool-result .event-kind,.event--skill .event-kind{color:var(--amber)}.event--extension-message .event-kind,.event--thinking-level .event-kind,.event--model-change .event-kind,.event--session-info .event-kind,.event--compaction .event-kind,.event--extension-state .event-kind{color:var(--cyan)}.event--unsupported .event-kind{color:var(--danger)}.event-title{color:#e0e9df;font-size:.82rem}.event-body{margin:.55rem 0 0;overflow:auto;color:#c6d1c5;font:inherit;font-size:.82rem;line-height:1.65;white-space:pre-wrap;word-break:break-word}.transcript-empty{padding:2rem 0;color:var(--muted);text-align:center}.report-reader iframe{display:block;width:100%;min-height:70vh;border:0;background:#fff}.notes{padding:1.15rem;border-top:1px solid var(--line)}.notes header{display:flex;justify-content:space-between;align-items:start;gap:1rem}.notes h3{margin-top:.2rem;font-size:1rem}.notes>p{margin:.65rem 0;color:var(--muted);font-size:.78rem;line-height:1.5}.notes ul{padding:0;margin:.8rem 0;list-style:none}.note{padding:.75rem 0;border-top:1px solid var(--line)}.note p{margin:0 0 .6rem;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.82rem}.note-actions{display:flex;gap:.5rem}.notes form{display:grid;gap:.6rem;margin-top:.8rem}.notes textarea{min-height:7rem;width:100%;resize:vertical;color:inherit;background:#101511;border:1px solid var(--line);border-radius:.4rem;padding:.55rem}.notes form div{display:flex;gap:.5rem}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media (max-width:620px){.app-header{min-height:4rem}.local-state{display:none}.reader-header{display:block}.handoff{margin-top:1rem;min-width:0}.filter-control{align-items:flex-start;flex-wrap:wrap}.filter-help{flex-basis:100%;padding-left:1.45rem}.event-head{align-items:flex-start;flex-wrap:wrap}.report-reader iframe{min-height:62vh}}@media (min-width:900px){.navigation-drawer{top:4.4rem;width:22rem;border-top:0}.drawer-backdrop{background:rgba(0,0,0,.24)}}`; }

export function viewerScript() { return `(() => { const q=(s)=>document.querySelector(s); let selected; let selectedIndex; let events=[]; let notes=[]; let editingNoteId; let editingSessionIndex; let opener; const api=(path,options)=>fetch(path,options).then(r=>r.ok?r.json():Promise.reject(new Error('Request unavailable'))); const noteApi=(path,method,body)=>api(path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}); const drawer=q('#navigation-drawer'),backdrop=q('#drawer-backdrop'),toggle=q('#drawer-toggle'); const isConversation=(event)=>event.category==='user'||event.category==='assistant'; const drawerFocusables=()=>Array.from(drawer.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter(node=>!node.disabled); const setDrawer=(open)=>{if(open){const active=document.activeElement;opener=active&&typeof active.focus==='function'?active:toggle;}drawer.hidden=!open;backdrop.hidden=!open;toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Close conversation navigation':'Open conversation navigation');if(open)q('#drawer-close').focus();else if(opener&&typeof opener.focus==='function')opener.focus();}; const list=(target,values,make,empty)=>{const node=q(target);node.replaceChildren();if(!values.length){node.textContent=empty;return;}const ul=document.createElement('ul');for(const value of values)ul.append(make(value));node.append(ul);}; const item=(label,meta,click)=>{const li=document.createElement('li'),button=document.createElement('button'),detail=document.createElement('span');button.type='button';button.className='nav-item';button.textContent=label;detail.className='nav-item-meta';detail.textContent=meta;button.append(detail);button.onclick=click;li.append(button);return li;}; const renderEvents=()=>{const filtered=q('#conversation-only').checked?events.filter(isConversation):events;const transcript=q('#transcript');if(!filtered.length){transcript.replaceChildren(Object.assign(document.createElement('p'),{className:'transcript-empty',textContent:'No conversation messages match this filter.'}));return;}transcript.replaceChildren(...filtered.map(event=>{const article=document.createElement('article'),head=document.createElement('header'),kind=document.createElement('span'),title=document.createElement('strong'),body=document.createElement('pre');article.className='event event--'+event.category;head.className='event-head';kind.className='event-kind';kind.textContent=event.category.replace(/-/g,' ');title.className='event-title';title.textContent=event.timestamp+' — '+event.title;body.className='event-body';body.textContent=event.summary;head.append(kind,title);article.append(head,body);return article;}));}; const noteStatus=(text)=>q('#notes-status').textContent=text; const renderNotes=()=>{const target=q('#notes-list');target.replaceChildren();if(!selected){target.textContent='Select a conversation to view its notes.';return;}if(!notes.length){target.textContent='No local notes for this conversation.';return;}const ul=document.createElement('ul');for(const note of notes){const li=document.createElement('li'),text=document.createElement('p'),actions=document.createElement('div'),edit=document.createElement('button'),remove=document.createElement('button');li.className='note';text.textContent=note.text;actions.className='note-actions';edit.type=remove.type='button';edit.textContent='Edit';remove.textContent='Delete';edit.onclick=()=>{editingNoteId=note.noteId;editingSessionIndex=selectedIndex;q('#note-text').value=note.text;q('#note-form').hidden=false;q('#note-text').focus();};remove.onclick=async()=>{const noteIndex=selectedIndex;if(!confirm('Delete this local note permanently?'))return;try{const data=await noteApi('api/sessions/'+noteIndex+'/notes/'+note.noteId,'DELETE');if(noteIndex!==selectedIndex)return;notes=data.notes;renderNotes();noteStatus('Note deleted.');}catch{if(noteIndex===selectedIndex)noteStatus('Unable to delete note.');}};actions.append(edit,remove);li.append(text,actions);ul.append(li);}target.append(ul);}; const loadNotes=async()=>{const noteIndex=selectedIndex;try{const data=await api('api/sessions/'+noteIndex+'/notes');if(noteIndex!==selectedIndex)return;notes=data.notes;renderNotes();}catch{if(noteIndex!==selectedIndex)return;notes=[];renderNotes();noteStatus('Notes are unavailable.');}}; const closeNoteForm=()=>{editingNoteId=undefined;editingSessionIndex=undefined;q('#note-form').hidden=true;q('#note-text').value='';}; async function load(){try{const [sessions,reports]=await Promise.all([api('api/sessions'),api('api/reports')]);list('#sessions',sessions,s=>item('Session '+s.id,s.modified+' · '+s.messageCount+' messages',()=>selectSession(s.index)),'No saved conversations found.');list('#reports',reports,r=>item(r.name,r.modified,()=>selectReport(r.index)),'No hindsight reports found.');}catch{q('#sessions').textContent='Viewer data is unavailable.';q('#reports').textContent='Viewer data is unavailable.';}} async function selectSession(index){try{closeNoteForm();const data=await api('api/sessions/'+index);selected=data.reference;selectedIndex=index;events=data.events;q('#detail-title').textContent='Session '+data.id;q('#handoff-command').textContent='/hindsight-document '+selected;q('#reader-empty').hidden=true;q('#detail').hidden=false;q('#report-detail').hidden=true;renderEvents();loadNotes();setDrawer(false);q('#reader').focus();}catch{q('#detail').hidden=true;q('#reader-empty').hidden=false;}} async function selectReport(index){try{closeNoteForm();const response=await fetch('api/reports/'+index);if(!response.ok)throw new Error();q('#report-frame').srcdoc=await response.text();q('#reader-empty').hidden=true;q('#detail').hidden=true;q('#report-detail').hidden=false;setDrawer(false);q('#reader').focus();}catch{q('#report-detail').hidden=true;q('#reader-empty').hidden=false;}} q('#note-add').onclick=()=>{if(!selected){noteStatus('Select a conversation first.');return;}closeNoteForm();editingSessionIndex=selectedIndex;q('#note-form').hidden=false;q('#note-text').focus();};q('#note-cancel').onclick=closeNoteForm;q('#note-form').onsubmit=async event=>{event.preventDefault();const text=q('#note-text').value;const wasEditing=Boolean(editingNoteId);const noteIndex=editingSessionIndex;if(noteIndex!==selectedIndex){closeNoteForm();noteStatus('Conversation changed. Reopen Notes to save there.');return;}if(!confirm(wasEditing?'Save this explicit note edit?':'Save this local note?'))return;try{const path='api/sessions/'+noteIndex+'/notes'+(editingNoteId?'/'+editingNoteId:'');const data=await noteApi(path,wasEditing?'PUT':'POST',{text});if(noteIndex!==selectedIndex)return;notes=data.notes;renderNotes();closeNoteForm();noteStatus(wasEditing?'Note updated.':'Note added.');}catch{if(noteIndex===selectedIndex)noteStatus('Unable to save note.');}}; q('#copy').onclick=async()=>{if(!selected)return;const command='/hindsight-document '+selected;const status=q('#copy-status'),icon=q('#copy-icon');const copied=()=>{status.textContent='Pi handoff command copied.';icon.textContent='✓';setTimeout(()=>{icon.textContent='⧉';},1800);};try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(command);copied();}catch{const area=document.createElement('textarea');area.value=command;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();try{if(!document.execCommand('copy'))throw new Error();copied();}catch{status.textContent='Copy failed. Select and copy the Pi handoff command manually: '+command;}finally{area.remove();}}}; toggle.onclick=()=>setDrawer(drawer.hidden);q('#drawer-close').onclick=()=>setDrawer(false);backdrop.onclick=()=>setDrawer(false);q('#empty-open-drawer').onclick=()=>setDrawer(true);q('#conversation-only').onchange=renderEvents;document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!drawer.hidden){event.preventDefault();setDrawer(false);return;}if(event.key==='Tab'&&!drawer.hidden){const focusables=drawerFocusables();if(!focusables.length){event.preventDefault();return;}const first=focusables[0],last=focusables[focusables.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});setInterval(()=>fetch('api/heartbeat',{method:'POST'}).catch(()=>{}),30000);load(); })();`; }

async function readJsonBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new Error("invalid"); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.text !== "string") throw new Error("invalid"); return value; } catch { throw new Error("invalid"); }
}
function safeNotes(notes) { return notes.map(({ noteId, text, provenance }) => ({ noteId, text, provenance: { source: provenance.source, confirmation: provenance.confirmation, createdAt: provenance.createdAt, ...(provenance.editedAt ? { editedAt: provenance.editedAt } : {}) } })); }

export async function startViewer({ host = "127.0.0.1", port = 0, token = randomBytes(32).toString("base64url"), sessionDirectory, reportDirectory, idleMs = VIEWER_IDLE_MS, maxLifetimeMs = VIEWER_MAX_LIFETIME_MS, now = () => Date.now() } = {}) {
  if (host !== "127.0.0.1") throw new Error("The viewer may bind only to 127.0.0.1.");
  if (!TOKEN_PATTERN.test(token)) throw new Error("The viewer token is invalid.");
  const sessions = await discoverSessions({ sessionDirectory });
  const reports = await discoverReports({ reportDirectory });
  let closed = false; let lastHeartbeat = now(); let timer;
  const sockets = new Set();
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
    const noteMatch = /^api\/sessions\/(\d+)\/notes(?:\/(note-[a-f0-9]{32}))?$/.exec(route);
    if (noteMatch) {
      const session = sessions[Number(noteMatch[1])]; if (!session || !session.projectRoot) return genericError(response);
      const reference = hindsightNotesSessionReference(session.id);
      try {
        if (request.method === "GET" && !noteMatch[2]) return response.end(JSON.stringify({ notes: safeNotes((await readHindsightNotes(session.projectRoot, reference))?.notes || []) }));
        if (request.method === "POST" && !noteMatch[2]) { const body = await readJsonBody(request); await addHindsightNote(session.projectRoot, reference, body.text, { actualSessionId: session.id }); return response.end(JSON.stringify({ notes: safeNotes((await readHindsightNotes(session.projectRoot, reference))?.notes || []) })); }
        if (request.method === "PUT" && noteMatch[2]) { const body = await readJsonBody(request); await editHindsightNote(session.projectRoot, reference, noteMatch[2], body.text, { actualSessionId: session.id }); return response.end(JSON.stringify({ notes: safeNotes((await readHindsightNotes(session.projectRoot, reference))?.notes || []) })); }
        if (request.method === "DELETE" && noteMatch[2]) { const before = (await readHindsightNotes(session.projectRoot, reference))?.notes || []; await deleteHindsightNote(session.projectRoot, reference, noteMatch[2]); return response.end(JSON.stringify({ notes: safeNotes(before.filter((note) => note.noteId !== noteMatch[2])) })); }
      } catch { return genericError(response, 400); }
      return genericError(response);
    }
    if (request.method !== "GET") return genericError(response, 404);
    if (route === "" || route === "index.html") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return response.end(viewerPage()); }
    if (route === "assets/viewer.css") { response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }); return response.end(viewerStyles()); }
    if (route === "assets/viewer.js") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); return response.end(viewerScript()); }
    if (route === "api/sessions") return response.end(JSON.stringify(sessions.map((session, index) => ({ index, id: session.id, modified: session.modified, messageCount: session.messageCount }))));
    if (route === "api/reports") return response.end(JSON.stringify(reports.map((report, index) => ({ index, name: report.name, modified: report.modified }))));
    const sessionMatch = /^api\/sessions\/(\d+)$/.exec(route);
    if (sessionMatch) { const session = sessions[Number(sessionMatch[1])]; if (!session) return genericError(response); const projection = projectConversation(session.entries, { includeThinking: true, includeLocalEntries: true }); return response.end(JSON.stringify({ id: session.id, reference: pseudonymizeSession(session), events: projection.events.map(({ timestamp, category, title, summary }) => ({ timestamp, category, title, summary })) })); }
    const reportMatch = /^api\/reports\/(\d+)$/.exec(route);
    if (reportMatch) { const report = reports[Number(reportMatch[1])]; if (!report) return genericError(response); try { const html = sandboxedReportHtml(await readFile(report.file, "utf8")); response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" }); return response.end(html); } catch { return genericError(response); } }
    return genericError(response);
  });
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    server.close();
    // `close()` alone can wait forever for a slow or partial loopback request.
    // Destroy every tracked socket so idle and maximum lifetimes are hard bounds.
    server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
  };
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolveServer, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolveServer(); }); });
  const started = now();
  timer = setInterval(() => { if (viewerShouldClose({ started, lastHeartbeat, now: now(), idleMs, maxLifetimeMs })) close(); }, Math.min(1000, idleMs));
  timer.unref?.();
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}/${token}/`, close, server, token };
}
