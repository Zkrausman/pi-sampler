import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { projectConversation } from "./conversation.mjs";
import { defaultHindsightReportDirectory } from "./hindsight-output.mjs";
import { pseudonymizeSession } from "./redaction.mjs";
import { addHindsightNote, deleteHindsightNote, editHindsightNote, hindsightNotesEventReference, hindsightNotesSessionReference, migrateLegacyHindsightNote, readHindsightNotes } from "./hindsight-notes.mjs";

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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"><title>Pi Conversation Viewer</title><link rel="stylesheet" href="assets/viewer.css"></head><body><div class="app-shell"><header class="app-header"><button id="drawer-toggle" class="icon-button" type="button" aria-controls="navigation-drawer" aria-expanded="false" aria-label="Open conversation navigation"><span aria-hidden="true">☰</span></button><div><p class="eyebrow">LOCAL REPLAY</p><h1>Pi Conversation Viewer</h1></div><p class="local-state"><span aria-hidden="true">●</span> Read-only local</p></header><div id="drawer-backdrop" class="drawer-backdrop" hidden></div><aside id="navigation-drawer" class="navigation-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" hidden><header class="drawer-header"><div><p class="eyebrow">NAVIGATION</p><h2 id="drawer-title">Sessions &amp; reports</h2></div><button id="drawer-close" class="icon-button" type="button" aria-label="Close conversation navigation"><span aria-hidden="true">×</span></button></header><section class="drawer-section" aria-labelledby="sessions-heading"><h3 id="sessions-heading">Saved conversations</h3><div id="sessions" aria-live="polite">Loading conversations…</div></section><section class="drawer-section" aria-labelledby="reports-heading"><h3 id="reports-heading">Hindsight reports</h3><div id="reports" aria-live="polite">Loading reports…</div></section></aside><main id="reader" tabindex="-1"><p class="notice">Local, read-only replay. Selecting a conversation does not invoke Pi, a model, or report generation.</p><section id="reader-empty" class="reader-state" aria-labelledby="reader-empty-title"><p class="eyebrow">READY</p><h2 id="reader-empty-title">Choose a local conversation</h2><p>Open navigation to select a saved Pi session or a local hindsight report.</p><button id="empty-open-drawer" type="button">Open navigation</button></section><section id="detail" class="conversation-reader" hidden aria-labelledby="detail-title"><header class="reader-header"><div><p class="eyebrow">SESSION REPLAY</p><h2 id="detail-title">Selected conversation</h2></div><div class="handoff"><div class="handoff-label">PI HANDOFF</div><code id="handoff-command">/hindsight-document session-reference</code><button id="copy" class="copy-button" type="button" aria-label="Copy Pi handoff command" title="Copy Pi handoff command"><span id="copy-icon" aria-hidden="true">⧉</span><span class="sr-only">Copy Pi handoff command</span></button><p id="copy-status" class="sr-only" role="status" aria-live="polite"></p></div></header><label class="filter-control"><input id="conversation-only" type="checkbox"><span>Conversation only</span><span class="filter-help">Hide tool, skill, and system/status events</span></label><section id="legacy-notes" class="legacy-notes" hidden aria-labelledby="legacy-notes-heading"><h3 id="legacy-notes-heading">Unassigned legacy notes</h3><p>These older session notes are not attached to an event and are excluded from hindsight until you explicitly attach each one.</p><div id="legacy-notes-list" aria-live="polite"></div><p id="legacy-notes-status" role="status" aria-live="polite"></p></section><div id="transcript" class="transcript" aria-live="polite"></div></section><section id="report-detail" class="report-reader" hidden aria-labelledby="report-title"><header class="reader-header"><div><p class="eyebrow">LOCAL REPORT</p><h2 id="report-title">Selected report</h2></div></header><iframe id="report-frame" sandbox title="Local hindsight report"></iframe></section></main></div><script src="assets/viewer.js"></script></body></html>`;
}

export function sandboxedReportHtml(html) {
  // srcdoc does not inherit the HTTP response CSP, so add a restrictive policy
  // before placing a user-local report into the sandboxed frame.
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">${typeof html === "string" ? html : ""}`;
}

export function viewerStyles() { return `:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;color:#d7e1d5;background:#101411;--surface:#151b16;--surface-raised:#1b231c;--line:#344037;--muted:#99a89a;--green:#a8dba8;--cyan:#8fd5d1;--amber:#dfbd7a;--danger:#e6a39b}*{box-sizing:border-box}body{margin:0;min-width:320px;background:radial-gradient(circle at top,#1c271e 0,#101411 42rem);min-height:100vh}button,input{font:inherit}button{cursor:pointer;color:inherit;background:#202a21;border:1px solid #465348;border-radius:.45rem;padding:.55rem .7rem}button:hover{background:#2a352b}button:focus-visible,input:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}.app-shell{min-height:100vh}.app-header{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:.85rem;min-height:4.4rem;padding:.75rem clamp(1rem,4vw,3rem);border-bottom:1px solid var(--line);background:rgba(16,20,17,.95);backdrop-filter:blur(12px)}h1,h2,h3,p{margin:0}h1{font-size:1rem;letter-spacing:.02em}.eyebrow{color:var(--green);font-size:.67rem;font-weight:700;letter-spacing:.12em}.local-state{margin-left:auto;color:var(--muted);font-size:.75rem}.local-state span{color:var(--green)}.icon-button{display:grid;place-items:center;width:2.4rem;height:2.4rem;padding:0;font-size:1.25rem}.drawer-backdrop{position:fixed;inset:0;z-index:4;background:rgba(0,0,0,.55)}.navigation-drawer{position:fixed;z-index:5;top:0;bottom:0;left:0;width:min(25rem,92vw);padding:1.25rem;overflow:auto;border-right:1px solid var(--line);background:#121813;box-shadow:1rem 0 3rem rgba(0,0,0,.38)}.drawer-header,.reader-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.drawer-header h2,.reader-header h2{margin-top:.2rem;font-size:1.05rem}.drawer-section{margin-top:1.6rem}.drawer-section h3{color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.08em}.drawer-section ul{display:grid;gap:.5rem;padding:0;margin:.75rem 0 0;list-style:none}.nav-item{width:100%;text-align:left;line-height:1.35}.nav-item.is-selected{border-color:var(--green);background:#273227}.nav-item-meta{display:block;margin-top:.2rem;color:var(--muted);font-size:.7rem}main{width:min(1100px,100%);margin:0 auto;padding:clamp(1rem,4vw,3rem)}.notice{margin:0 0 1rem;color:var(--muted);font-size:.78rem;line-height:1.5}.reader-state,.conversation-reader,.report-reader{border:1px solid var(--line);border-radius:.7rem;background:rgba(21,27,22,.94);box-shadow:0 1.2rem 3.5rem rgba(0,0,0,.16)}.reader-state{padding:clamp(1.5rem,6vw,4rem);text-align:center}.reader-state h2{margin:.45rem 0;font-size:clamp(1.2rem,3vw,1.7rem)}.reader-state p:not(.eyebrow){max-width:40rem;margin:0 auto 1.25rem;color:var(--muted);line-height:1.6}.conversation-reader,.report-reader{overflow:hidden}.reader-header{padding:1.1rem 1.15rem;border-bottom:1px solid var(--line)}.handoff{display:grid;grid-template-columns:1fr auto;gap:.25rem .5rem;min-width:min(31rem,58vw);padding:.55rem .65rem;border:1px solid #405143;border-radius:.55rem;background:#101511}.handoff-label{grid-column:1/-1;color:var(--muted);font-size:.62rem;font-weight:700;letter-spacing:.11em}.handoff code{min-width:0;overflow:auto;color:var(--green);font-size:.72rem;white-space:nowrap}.copy-button{grid-column:2;grid-row:2;width:2rem;height:1.75rem;padding:0;border-color:transparent;background:transparent}.filter-control{display:flex;align-items:center;gap:.55rem;padding:.8rem 1.15rem;border-bottom:1px solid var(--line);color:#c3cec1;font-size:.78rem}.filter-control input{accent-color:var(--green)}.filter-help{color:var(--muted);font-size:.7rem}.transcript{padding:.3rem 1.15rem 1rem}.event{position:relative;padding:1rem 0 1rem 1rem;border-bottom:1px solid rgba(52,64,55,.72)}.event:last-child{border:0}.event::before{position:absolute;top:1.15rem;left:0;width:.35rem;height:.35rem;border-radius:50%;background:var(--muted);content:""}.event--user::before{background:var(--green)}.event--assistant::before{background:var(--cyan)}.event--tool-call::before,.event--tool-result::before{background:var(--amber)}.event--unsupported::before{background:var(--danger)}.event-head{display:flex;align-items:center;gap:.55rem;color:var(--muted);font-size:.7rem}.event-kind{padding:.13rem .35rem;border:1px solid currentColor;border-radius:.25rem;color:var(--green);font-size:.61rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.event--tool-call .event-kind,.event--tool-result .event-kind,.event--skill .event-kind{color:var(--amber)}.event--extension-message .event-kind,.event--thinking-level .event-kind,.event--model-change .event-kind,.event--session-info .event-kind,.event--compaction .event-kind,.event--extension-state .event-kind{color:var(--cyan)}.event--unsupported .event-kind{color:var(--danger)}.event-title{color:#e0e9df;font-size:.82rem}.event-body{margin:.55rem 0 0;overflow:auto;color:#c6d1c5;font:inherit;font-size:.82rem;line-height:1.65;white-space:pre-wrap;word-break:break-word}.transcript-empty{padding:2rem 0;color:var(--muted);text-align:center}.event-notes,.legacy-notes{margin-top:.8rem;padding:.75rem;border:1px solid var(--line);border-radius:.45rem;background:#121813}.event-notes header{display:flex;align-items:center;justify-content:space-between;gap:.5rem}.event-notes h4,.legacy-notes h3{font-size:.8rem}.event-notes ul,.legacy-notes ul{padding:0;margin:.65rem 0 0;list-style:none}.event-notes li,.legacy-notes li{padding:.55rem 0;border-top:1px solid var(--line)}.event-notes p,.legacy-notes p{margin:.3rem 0;color:var(--muted);font-size:.76rem;white-space:pre-wrap}.event-notes form{display:grid;gap:.5rem;margin-top:.6rem}.event-notes textarea{min-height:5rem;width:100%;resize:vertical;color:inherit;background:#101511;border:1px solid var(--line);border-radius:.4rem;padding:.55rem}.event-note-actions{display:flex;gap:.5rem;flex-wrap:wrap}.report-reader iframe{display:block;width:100%;min-height:70vh;border:0;background:#fff}.notes{padding:1.15rem;border-top:1px solid var(--line)}.notes header{display:flex;justify-content:space-between;align-items:start;gap:1rem}.notes h3{margin-top:.2rem;font-size:1rem}.notes>p{margin:.65rem 0;color:var(--muted);font-size:.78rem;line-height:1.5}.notes ul{padding:0;margin:.8rem 0;list-style:none}.note{padding:.75rem 0;border-top:1px solid var(--line)}.note p{margin:0 0 .6rem;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.82rem}.note-actions{display:flex;gap:.5rem}.notes form{display:grid;gap:.6rem;margin-top:.8rem}.notes textarea{min-height:7rem;width:100%;resize:vertical;color:inherit;background:#101511;border:1px solid var(--line);border-radius:.4rem;padding:.55rem}.notes form div{display:flex;gap:.5rem}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media (max-width:620px){.app-header{min-height:4rem}.local-state{display:none}.reader-header{display:block}.handoff{margin-top:1rem;min-width:0}.filter-control{align-items:flex-start;flex-wrap:wrap}.filter-help{flex-basis:100%;padding-left:1.45rem}.event-head{align-items:flex-start;flex-wrap:wrap}.report-reader iframe{min-height:62vh}}@media (min-width:900px){.navigation-drawer{top:4.4rem;width:22rem;border-top:0}.drawer-backdrop{background:rgba(0,0,0,.24)}}`; }

export function viewerScript() { return `(()=>{const q=s=>document.querySelector(s);let selected,selectedIndex,events=[],selectionEpoch=0,opener;const api=(path,options)=>fetch(path,options).then(response=>response.ok?response.json():Promise.reject(Error('Request unavailable')));const noteApi=(path,method,body)=>api(path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const drawer=q('#navigation-drawer'),backdrop=q('#drawer-backdrop'),toggle=q('#drawer-toggle');const conversation=event=>event.category==='user'||event.category==='assistant';const drawerFocusables=()=>Array.from(drawer.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter(node=>!node.disabled);const setDrawer=open=>{if(open){const active=document.activeElement;opener=active&&typeof active.focus==='function'?active:toggle}drawer.hidden=!open;backdrop.hidden=!open;toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Close conversation navigation':'Open conversation navigation');if(open)q('#drawer-close').focus();else if(opener&&typeof opener.focus==='function')opener.focus()};const list=(target,values,make,empty)=>{const node=q(target);node.replaceChildren();if(!values.length){node.textContent=empty;return}const ul=document.createElement('ul');for(const value of values)ul.append(make(value));node.append(ul)};const item=(label,meta,click)=>{const li=document.createElement('li'),button=document.createElement('button'),detail=document.createElement('span');button.type='button';button.className='nav-item';button.textContent=label;detail.className='nav-item-meta';detail.textContent=meta;button.append(detail);button.onclick=click;li.append(button);return li};const formFor=(note,save,cancel)=>{const form=document.createElement('form'),label=document.createElement('label'),area=document.createElement('textarea'),actions=document.createElement('div'),submit=document.createElement('button'),close=document.createElement('button');const id='note-text-'+crypto.randomUUID();label.htmlFor=id;label.textContent=note?'Edit note':'Note text';area.id=id;area.maxLength=2000;area.required=true;area.value=note?.text||'';submit.type='submit';submit.textContent='Save note';close.type='button';close.textContent='Cancel';close.onclick=cancel;form.onsubmit=async event=>{event.preventDefault();await save(area.value)};actions.className='event-note-actions';actions.append(submit,close);form.append(label,area,actions);return form};const notePanel=async(event,sessionIndex,epoch)=>{const base='api/sessions/'+sessionIndex+'/events/'+event.noteReference+'/notes',container=document.createElement('div'),panel=document.createElement('section'),header=document.createElement('header'),heading=document.createElement('h4'),add=document.createElement('button'),status=document.createElement('p');let notes=[],form;container.className='event-note-control';panel.className='event-notes';status.className='sr-only';status.setAttribute('role','status');status.setAttribute('aria-live','polite');heading.textContent='Notes';add.type='button';add.textContent='Add note';header.append(heading,add);const renderCompact=()=>{container.replaceChildren(add,status)};const render=()=>{if(!notes.length&&!form){renderCompact();return}panel.replaceChildren(header,status);if(notes.length){const ul=document.createElement('ul');for(const note of notes){const li=document.createElement('li'),text=document.createElement('p'),actions=document.createElement('div'),edit=document.createElement('button'),remove=document.createElement('button');text.textContent=note.text;actions.className='event-note-actions';edit.type=remove.type='button';edit.textContent='Edit';remove.textContent='Delete';edit.dataset.noteAction='edit';edit.dataset.noteId=note.noteId;remove.dataset.noteAction='delete';remove.dataset.noteId=note.noteId;edit.onclick=()=>{form=formFor(note,async value=>{if(!confirm('Save this explicit note edit?'))return;try{notes=(await noteApi(base+'/'+note.noteId,'PUT',{text:value})).notes;if(sessionIndex===selectedIndex&&epoch===selectionEpoch){form=undefined;render();status.textContent='Note updated.';panel.querySelector('button[data-note-action="edit"][data-note-id="'+note.noteId+'"]').focus()}}catch{if(sessionIndex===selectedIndex&&epoch===selectionEpoch)status.textContent='Unable to save note.'}},()=>{form=undefined;render()});render();form.querySelector('textarea').focus()};remove.onclick=async()=>{if(!confirm('Delete this local note permanently?'))return;try{notes=(await noteApi(base+'/'+note.noteId,'DELETE')).notes;if(sessionIndex===selectedIndex&&epoch===selectionEpoch){render();status.textContent='Note deleted.';add.focus()}}catch{if(sessionIndex===selectedIndex&&epoch===selectionEpoch)status.textContent='Unable to delete note.'}};actions.append(edit,remove);li.append(text,actions);ul.append(li)}panel.append(ul)}if(form)panel.append(form);container.replaceChildren(panel)};add.onclick=()=>{form=formFor(undefined,async text=>{if(!confirm('Save this local note?'))return;try{notes=(await noteApi(base,'POST',{text})).notes;if(sessionIndex===selectedIndex&&epoch===selectionEpoch){form=undefined;render();status.textContent='Note added.';add.focus()}}catch{if(sessionIndex===selectedIndex&&epoch===selectionEpoch)status.textContent='Unable to save note.'}},()=>{form=undefined;render()});render();form.querySelector('textarea').focus()};try{notes=(await api(base)).notes;if(sessionIndex===selectedIndex&&epoch===selectionEpoch)render()}catch{if(sessionIndex===selectedIndex&&epoch===selectionEpoch){renderCompact();status.textContent='Notes are unavailable.'}}return container};const renderLegacy=async(sessionIndex,epoch)=>{const target=q('#legacy-notes'),listTarget=q('#legacy-notes-list'),status=q('#legacy-notes-status');target.hidden=true;listTarget.replaceChildren();status.textContent='';try{const data=await api('api/sessions/'+sessionIndex+'/legacy-notes');if(sessionIndex!==selectedIndex||epoch!==selectionEpoch||!data.notes.length)return;target.hidden=false;const ul=document.createElement('ul');for(const note of data.notes){const li=document.createElement('li'),text=document.createElement('p'),attach=document.createElement('button');text.textContent=note.text;attach.type='button';attach.textContent='Attach to an event';attach.onclick=()=>{const select=document.createElement('select'),save=document.createElement('button');save.type='button';save.textContent='Attach';select.append(...events.map(event=>Object.assign(document.createElement('option'),{value:event.noteReference,textContent:event.noteLabel})));save.onclick=async()=>{if(!confirm('Attach this legacy note to the selected event?'))return;try{await noteApi('api/sessions/'+sessionIndex+'/legacy-notes/'+note.noteId,'POST',{eventReference:select.value});if(sessionIndex===selectedIndex&&epoch===selectionEpoch){renderLegacy(sessionIndex,epoch);renderEvents();status.textContent='Legacy note attached to the selected event.'}}catch{if(sessionIndex===selectedIndex&&epoch===selectionEpoch)status.textContent='Unable to attach legacy note.'}};li.append(select,save)};li.append(text,attach);ul.append(li)}listTarget.append(ul)}catch{}};const renderEvents=()=>{const filtered=q('#conversation-only').checked?events.filter(conversation):events,transcript=q('#transcript'),sessionIndex=selectedIndex,epoch=selectionEpoch;transcript.replaceChildren();if(!filtered.length){transcript.replaceChildren(Object.assign(document.createElement('p'),{className:'transcript-empty',textContent:'No conversation messages match this filter.'}));return}for(const event of filtered){const article=document.createElement('article'),head=document.createElement('header'),kind=document.createElement('span'),title=document.createElement('strong'),body=document.createElement('pre');article.className='event event--'+event.category;head.className='event-head';kind.className='event-kind';kind.textContent=event.category.replace(/-/g,' ');title.className='event-title';title.textContent=event.timestamp+' — '+event.title;body.className='event-body';body.textContent=event.summary;head.append(kind,title);article.append(head,body);transcript.append(article);notePanel(event,sessionIndex,epoch).then(panel=>{if(sessionIndex===selectedIndex&&epoch===selectionEpoch)article.append(panel)})}};async function load(){try{const[sessions,reports]=await Promise.all([api('api/sessions'),api('api/reports')]);list('#sessions',sessions,session=>item('Conversation '+(session.index+1),session.modified+' · '+session.messageCount+' messages',()=>selectSession(session.index)),'No saved conversations found.');list('#reports',reports,report=>item(report.name,report.modified,()=>selectReport(report.index)),'No hindsight reports found.')}catch{q('#sessions').textContent='Viewer data is unavailable.';q('#reports').textContent='Viewer data is unavailable.'}}async function selectSession(index){const epoch=++selectionEpoch;try{const data=await api('api/sessions/'+index);if(epoch!==selectionEpoch)return;selected=data.reference;selectedIndex=index;events=data.events;q('#detail-title').textContent='Selected conversation';q('#handoff-command').textContent='/hindsight-document '+selected;q('#reader-empty').hidden=true;q('#detail').hidden=false;q('#report-detail').hidden=true;renderEvents();renderLegacy(index,epoch);setDrawer(false);q('#reader').focus()}catch{if(epoch!==selectionEpoch)return;q('#detail').hidden=true;q('#reader-empty').hidden=false}}async function selectReport(index){const epoch=++selectionEpoch;try{const response=await fetch('api/reports/'+index);if(!response.ok)throw Error();const report=await response.text();if(epoch!==selectionEpoch)return;q('#report-frame').srcdoc=report;q('#reader-empty').hidden=true;q('#detail').hidden=true;q('#report-detail').hidden=false;setDrawer(false);q('#reader').focus()}catch{if(epoch!==selectionEpoch)return;q('#report-detail').hidden=true;q('#reader-empty').hidden=false}}q('#copy').onclick=async()=>{if(!selected)return;const command='/hindsight-document '+selected;try{await navigator.clipboard.writeText(command);q('#copy-status').textContent='Pi handoff command copied.'}catch{q('#copy-status').textContent='Copy failed. Select and copy the Pi handoff command manually: '+command}};toggle.onclick=()=>setDrawer(drawer.hidden);q('#drawer-close').onclick=()=>setDrawer(false);backdrop.onclick=()=>setDrawer(false);q('#empty-open-drawer').onclick=()=>setDrawer(true);q('#conversation-only').onchange=renderEvents;document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!drawer.hidden){event.preventDefault();setDrawer(false);return}if(event.key==='Tab'&&!drawer.hidden){const focusables=drawerFocusables();if(!focusables.length){event.preventDefault();return}const first=focusables[0],last=focusables[focusables.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}}});setInterval(()=>fetch('api/heartbeat',{method:'POST'}).catch(()=>{}),30000);load()})();`; }

async function readJsonBody(request, key = "text") {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new Error("invalid"); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value[key] !== "string") throw new Error("invalid"); return value; } catch { throw new Error("invalid"); }
}
function safeLegacyNotes(notes) { return notes.map(({ noteId, text, provenance }) => ({ noteId, text, provenance: { source: provenance.source, confirmation: provenance.confirmation, createdAt: provenance.createdAt, ...(provenance.editedAt ? { editedAt: provenance.editedAt } : {}) } })); }
function safeNotes(notes) { return notes.map(({ noteId, eventReference, eventLabel, text, provenance }) => ({ noteId, eventReference, eventLabel, text, provenance: { source: provenance.source, confirmation: provenance.confirmation, createdAt: provenance.createdAt, ...(provenance.editedAt ? { editedAt: provenance.editedAt } : {}) } })); }
function viewerEventLabel(event) { return `${event.timestamp} — ${event.title}`.slice(0, 240); }
function viewerEvents(session) { const projection = projectConversation(session.entries, { includeThinking: true }); return projection.events.map((event) => ({ ...event, noteReference: hindsightNotesEventReference(session.id, event.noteIdentity), noteLabel: viewerEventLabel(event) })); }

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
    const legacyMatch = /^api\/sessions\/(\d+)\/legacy-notes(?:\/(note-[a-f0-9]{32}))?$/.exec(route);
    if (legacyMatch) {
      const session = sessions[Number(legacyMatch[1])]; if (!session || !session.projectRoot) return genericError(response);
      const reference = hindsightNotesSessionReference(session.id);
      try {
        const store = await readHindsightNotes(session.projectRoot, reference); const legacyNotes = store?.legacyNotes || [];
        if (request.method === "GET" && !legacyMatch[2]) return response.end(JSON.stringify({ notes: safeLegacyNotes(legacyNotes) }));
        if (request.method === "POST" && legacyMatch[2]) { const body = await readJsonBody(request, "eventReference"); const event = viewerEvents(session).find((candidate) => candidate.noteReference === body.eventReference); if (!event || !legacyNotes.some((note) => note.noteId === legacyMatch[2])) return genericError(response); await migrateLegacyHindsightNote(session.projectRoot, reference, legacyMatch[2], event.noteReference, event.noteLabel, { actualSessionId: session.id, eventIdentity: event.noteIdentity }); return response.end(JSON.stringify({ ok: true })); }
      } catch { return genericError(response, 400); }
      return genericError(response);
    }
    const noteMatch = /^api\/sessions\/(\d+)\/events\/(event-[a-f0-9]{32})\/notes(?:\/(note-[a-f0-9]{32}))?$/.exec(route);
    if (noteMatch) {
      const session = sessions[Number(noteMatch[1])]; if (!session || !session.projectRoot) return genericError(response);
      const reference = hindsightNotesSessionReference(session.id); const event = viewerEvents(session).find((candidate) => candidate.noteReference === noteMatch[2]); if (!event) return genericError(response);
      const currentNotes = async () => safeNotes(((await readHindsightNotes(session.projectRoot, reference))?.notes || []).filter((note) => note.eventReference === event.noteReference));
      try {
        if (request.method === "GET" && !noteMatch[3]) return response.end(JSON.stringify({ notes: await currentNotes() }));
        if (request.method === "POST" && !noteMatch[3]) { const body = await readJsonBody(request); await addHindsightNote(session.projectRoot, reference, event.noteReference, event.noteLabel, body.text, { actualSessionId: session.id, eventIdentity: event.noteIdentity }); return response.end(JSON.stringify({ notes: await currentNotes() })); }
        if (request.method === "PUT" && noteMatch[3]) { const body = await readJsonBody(request); const all = (await readHindsightNotes(session.projectRoot, reference))?.notes || []; if (!all.some((note) => note.noteId === noteMatch[3] && note.eventReference === event.noteReference)) return genericError(response); await editHindsightNote(session.projectRoot, reference, noteMatch[3], body.text, { actualSessionId: session.id }); return response.end(JSON.stringify({ notes: await currentNotes() })); }
        if (request.method === "DELETE" && noteMatch[3]) { const all = (await readHindsightNotes(session.projectRoot, reference))?.notes || []; if (!all.some((note) => note.noteId === noteMatch[3] && note.eventReference === event.noteReference)) return genericError(response); await deleteHindsightNote(session.projectRoot, reference, noteMatch[3]); return response.end(JSON.stringify({ notes: safeNotes(all.filter((note) => note.eventReference === event.noteReference && note.noteId !== noteMatch[3])) })); }
      } catch { return genericError(response, 400); }
      return genericError(response);
    }
    if (request.method !== "GET") return genericError(response, 404);
    if (route === "" || route === "index.html") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return response.end(viewerPage()); }
    if (route === "assets/viewer.css") { response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }); return response.end(viewerStyles()); }
    if (route === "assets/viewer.js") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); return response.end(viewerScript()); }
    if (route === "api/sessions") return response.end(JSON.stringify(sessions.map((session, index) => ({ index, modified: session.modified, messageCount: session.messageCount }))));
    if (route === "api/reports") return response.end(JSON.stringify(reports.map((report, index) => ({ index, name: report.name, modified: report.modified }))));
    const sessionMatch = /^api\/sessions\/(\d+)$/.exec(route);
    if (sessionMatch) { const session = sessions[Number(sessionMatch[1])]; if (!session) return genericError(response); const events = viewerEvents(session); return response.end(JSON.stringify({ reference: pseudonymizeSession(session), events: events.map(({ timestamp, category, title, summary, noteReference, noteLabel }) => ({ timestamp, category, title, summary, noteReference, noteLabel })) })); }
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
