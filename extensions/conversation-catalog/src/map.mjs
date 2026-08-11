import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { escapeHtml } from "./catalog.mjs";

const EVENT_TYPES = new Set(["user", "assistant", "tool-call", "tool-result", "skill", "unsupported"]);
const EDGE_TYPES = new Map([
  ["parent entry", "parent entry"],
  ["tool result", "tool result"],
  ["next assistant (chronological)", "chronological order"],
]);

const text = (value) => typeof value === "string" ? value.trim() : "";
const bounded = (value, length = 240, fallback = "No readable content") => {
  const characters = Array.from(text(value));
  if (!characters.length) return fallback;
  return characters.length > length ? `${characters.slice(0, length).join("")}…` : characters.join("");
};
const safeCitation = (value) => /^[a-z0-9][a-z0-9_-]{0,79}:event-\d{4}$/i.test(text(value)) ? text(value) : "";
const safeTime = (value) => bounded(value, 40, "Unknown time");

function reviewedDetails(event) {
  // Flow metadata includes opaque Pi entry, parent, and tool-call identifiers.
  // A map never needs those identifiers to explain a reviewed relationship.
  const metadata = (Array.isArray(event?.metadata) ? event.metadata : []).flatMap((item) => {
    const label = bounded(item?.label, 60, "");
    if (!label || /^(entry|parent|call id)$/i.test(label)) return [];
    return [{ label, value: bounded(item?.value, 180) }];
  });
  return { summary: bounded(event?.summary, 480), metadata };
}

/**
 * Builds a local, redaction-reviewed relationship projection. It deliberately
 * assigns map-local IDs, so source event IDs cannot enter map HTML or metadata.
 */
export function projectRelationshipMap(projection) {
  const events = Array.isArray(projection?.events) ? projection.events : [];
  const sourceToMapId = new Map();
  const nodes = events.map((event, index) => {
    const mapId = `map-event-${index + 1}`;
    const sourceId = text(event?.id);
    if (sourceId && !sourceToMapId.has(sourceId)) sourceToMapId.set(sourceId, mapId);
    const order = Number.isInteger(event?.order) && event.order >= 0 ? event.order + 1 : index + 1;
    const type = EVENT_TYPES.has(text(event?.category)) ? text(event.category) : "unsupported";
    const details = reviewedDetails(event);
    return {
      id: mapId,
      order,
      type,
      label: bounded(event?.title || event?.category || "Event", 120, "Event"),
      timestamp: safeTime(event?.timestamp),
      evidenceReference: safeCitation(event?.evidence?.reference),
      citationAnchor: `map-citation-${index + 1}`,
      flowAnchor: `map-flow-${index + 1}`,
      ...details,
    };
  });
  const seen = new Set();
  const edges = (Array.isArray(projection?.edges) ? projection.edges : []).flatMap((edge, index) => {
    const from = sourceToMapId.get(text(edge?.from));
    const to = sourceToMapId.get(text(edge?.to));
    const type = EDGE_TYPES.get(text(edge?.label));
    if (!from || !to || from === to || !type) return [];
    const key = `${from}\u0000${to}\u0000${type}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: `map-edge-${index + 1}`, from, to, type, label: type }];
  });
  return { schemaVersion: 1, nodes, edges };
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function mapContext(node) {
  const metadata = node.metadata.length ? ` ${node.metadata.map((item) => `${item.label}: ${item.value}`).join(" · ")}` : "";
  return `Event ${node.order} · ${node.type} · ${node.timestamp}. ${node.summary}${metadata}`;
}

/** Generates an accessible, CSP-restricted standalone map from local data only. */
export function generateRelationshipMapHtml(session, graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const payload = jsonForScript({ nodes, edges });
  const eventTypes = [...new Set(nodes.map((node) => node.type))];
  const edgeTypes = [...new Set(edges.map((edge) => edge.type))];
  const suppliedSessionReference = text(session?.id);
  const sessionReference = /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(suppliedSessionReference)
    ? suppliedSessionReference
    : "selected conversation";
  const sidebar = nodes.length === 0
    ? '<p id="timeline-status" role="status">No reviewed events are available for this map.</p>'
    : `<ol id="chronological-events" class="chronological-events">${nodes.map((node) => `<li data-sidebar-node="${escapeHtml(node.id)}"><a href="#${escapeHtml(node.citationAnchor)}">${node.order}. ${escapeHtml(node.type)} — ${escapeHtml(node.label)}</a><span>${escapeHtml(node.timestamp)}</span><a class="flow-link" href="#${escapeHtml(node.flowAnchor)}">Flow context</a></li>`).join("\n")}</ol>`;
  const contexts = nodes.length === 0 ? "" : nodes.map((node) => `<article id="${escapeHtml(node.citationAnchor)}" class="citation-context"><h3>Evidence ${node.evidenceReference ? escapeHtml(node.evidenceReference) : `for event ${node.order}`}</h3><p class="provenance">direct evidence · reviewed/redacted local event</p><p>${escapeHtml(node.summary)}</p>${node.metadata.length ? `<dl>${node.metadata.map((item) => `<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`).join("")}</dl>` : ""}<section id="${escapeHtml(node.flowAnchor)}"><h4>Flow context</h4><p>${escapeHtml(mapContext(node))}</p></section></article>`).join("\n");
  const edgeContexts = edges.length === 0 ? '<p class="empty">No supported relationships were present in the reviewed session data.</p>' : `<ul class="edge-contexts">${edges.map((edge) => {
    const from = nodes.find((node) => node.id === edge.from);
    const to = nodes.find((node) => node.id === edge.to);
    if (!from || !to) return "";
    return `<li id="${escapeHtml(edge.id)}"><strong>${escapeHtml(edge.type)}</strong>: <a href="#${escapeHtml(from.citationAnchor)}">${escapeHtml(from.evidenceReference || `event ${from.order}`)}</a> → <a href="#${escapeHtml(to.flowAnchor)}">${escapeHtml(to.evidenceReference || `event ${to.order}`)} flow context</a>${edge.type === "chronological order" ? " (time order only; not causal)" : ""}</li>`;
  }).join("")}</ul>`;
  const typeControls = `<fieldset><legend>Event types</legend>${eventTypes.map((type) => `<label><input type="checkbox" data-event-filter value="${escapeHtml(type)}" checked> ${escapeHtml(type)}</label>`).join("")}</fieldset><fieldset><legend>Relationship types</legend>${edgeTypes.map((type) => `<label><input type="checkbox" data-edge-filter value="${escapeHtml(type)}" checked> ${escapeHtml(type)}</label>`).join("")}</fieldset>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Pi relationship map</title><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0 auto;max-width:100rem;padding:1rem;line-height:1.45}.layout{display:grid;gap:1rem;grid-template-columns:minmax(16rem,25rem) minmax(0,1fr)}aside,#map,.citation-context,.edge-panel{border:1px solid #9997;border-radius:.5rem;padding:1rem}aside{max-height:72vh;overflow:auto}.chronological-events{padding-left:1.5rem}.chronological-events li{margin:.65rem 0}.chronological-events span{color:#777;display:block;font-size:.85rem}.flow-link{font-size:.85rem}.controls{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.6rem}.filters{display:flex;flex-wrap:wrap;gap:1rem;margin:.5rem 0}.filters fieldset{border:1px solid #9997}.filters label{display:inline-block;margin:.15rem .45rem .15rem 0}#map{height:62vh;overflow:hidden;padding:0;position:relative;touch-action:none}svg{height:100%;width:100%}.node{cursor:pointer}.node:focus{outline:none}.node circle{fill:#3975a8;stroke:#dcefff;stroke-width:2}.node text{fill:#fff;font-size:12px;pointer-events:none}.edge{cursor:pointer;stroke:#789;stroke-width:2}.edge.selected{stroke:#f80;stroke-width:4}.node.selected circle{stroke:#f80;stroke-width:4}.detail{min-height:2.5rem}.citation-context{margin:1rem 0;scroll-margin-top:1rem}.citation-context p{overflow-wrap:anywhere;white-space:pre-wrap}.citation-context dl div{display:grid;gap:.5rem;grid-template-columns:10rem minmax(0,1fr)}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}.provenance,.empty{color:#777}.edge-contexts li{margin:.5rem 0;scroll-margin-top:1rem}button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid #3983c4;outline-offset:2px}@media(max-width:50rem){.layout{grid-template-columns:1fr}aside{max-height:none}}</style></head><body><h1>Conversation relationship map</h1><p>Session ${escapeHtml(sessionReference)}. This map uses only reviewed, redacted local session data. Each event has a direct-evidence reference and is ordered chronologically. Relationships are persisted parent, tool-result, or chronological-order links; chronological order is not a causal claim.</p><div class="layout"><aside aria-labelledby="chronological-heading"><h2 id="chronological-heading">Chronological evidence</h2>${sidebar}</aside><main><div class="controls" aria-label="Map view controls"><button type="button" id="map-fit">Fit map</button><button type="button" id="map-reset">Reset view</button><button type="button" id="map-zoom-in">Zoom in</button><button type="button" id="map-zoom-out">Zoom out</button><label><input type="checkbox" id="focus-connected-evidence"> Focus connected evidence</label></div><div class="filters" aria-label="Map filters">${typeControls}</div><div id="map" aria-label="Interactive relationship map"></div><p id="map-detail" class="detail" role="status">Select a node or relationship to inspect its embedded citation and flow context.</p></main></div><section class="edge-panel" aria-labelledby="relationships-heading"><h2 id="relationships-heading">Supported relationship context</h2>${edgeContexts}</section><section aria-labelledby="citation-heading"><h2 id="citation-heading">Embedded citation and flow context</h2>${contexts}</section><script type="application/json" id="relationship-map-data">${payload}</script><script>(() => { const dataElement=document.getElementById("relationship-map-data"),box=document.getElementById("map"),detail=document.getElementById("map-detail"); if(!dataElement||!box||!detail)return; let graph;try{graph=JSON.parse(dataElement.textContent)}catch{return} const svg=document.createElementNS("http://www.w3.org/2000/svg","svg"),layer=document.createElementNS(svg.namespaceURI,"g");svg.append(layer);box.append(svg);let scale=1,x=0,y=0,activeNode="",activeEdge="",drag;const eventFilters=()=>new Set(Array.from(document.querySelectorAll("[data-event-filter]:checked"),input=>input.value)),edgeFilters=()=>new Set(Array.from(document.querySelectorAll("[data-edge-filter]:checked"),input=>input.value));const position=id=>{const index=graph.nodes.findIndex(node=>node.id===id);return{x:100+(index%5)*180,y:100+Math.floor(index/5)*135}};const selected=()=>activeNode||"";const visible=()=>{const eventTypes=eventFilters(),edgeTypes=edgeFilters(),focus=document.getElementById("focus-connected-evidence").checked;let nodeIds=new Set(graph.nodes.filter(node=>eventTypes.has(node.type)).map(node=>node.id));const edges=graph.edges.filter(edge=>edgeTypes.has(edge.type)&&nodeIds.has(edge.from)&&nodeIds.has(edge.to));if(focus&&selected()){const connected=new Set([selected(),...edges.filter(edge=>edge.from===selected()||edge.to===selected()).flatMap(edge=>[edge.from,edge.to])]);nodeIds=new Set([...nodeIds].filter(id=>connected.has(id)));}return{nodeIds,edges:edges.filter(edge=>nodeIds.has(edge.from)&&nodeIds.has(edge.to))}};function showNode(node){activeNode=node.id;activeEdge="";detail.replaceChildren(document.createTextNode("Event "+node.order+" · "+node.type+". "));const citation=document.createElement("a");citation.href="#"+node.citationAnchor;citation.textContent=node.evidenceReference||"Embedded citation";detail.append(citation,document.createTextNode(" · "));const flow=document.createElement("a");flow.href="#"+node.flowAnchor;flow.textContent="Flow context";detail.append(flow);draw()}function showEdge(edge){activeEdge=edge.id;activeNode="";const from=graph.nodes.find(node=>node.id===edge.from),to=graph.nodes.find(node=>node.id===edge.to);detail.replaceChildren(document.createTextNode(edge.type+": "));const context=document.createElement("a");context.href="#"+edge.id;context.textContent="embedded relationship context";detail.append(context,document.createTextNode(" · "));const flow=document.createElement("a");flow.href="#"+(to?to.flowAnchor:"");flow.textContent="target flow context";detail.append(flow);draw()}function draw(){layer.replaceChildren();layer.setAttribute("transform","translate("+x+" "+y+") scale("+scale+")");const state=visible();for(const edge of state.edges){const a=position(edge.from),b=position(edge.to),line=document.createElementNS(svg.namespaceURI,"line");line.setAttribute("x1",a.x);line.setAttribute("y1",a.y);line.setAttribute("x2",b.x);line.setAttribute("y2",b.y);line.setAttribute("class","edge "+(activeEdge===edge.id?"selected":""));line.setAttribute("role","button");line.setAttribute("tabindex","0");line.setAttribute("aria-label",edge.type+" relationship");line.addEventListener("click",()=>showEdge(edge));line.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();showEdge(edge)}});layer.append(line)}for(const node of graph.nodes)if(state.nodeIds.has(node.id)){const p=position(node.id),group=document.createElementNS(svg.namespaceURI,"g");group.setAttribute("class","node "+(activeNode===node.id?"selected":""));group.setAttribute("transform","translate("+p.x+" "+p.y+")");group.setAttribute("role","button");group.setAttribute("tabindex","0");group.setAttribute("aria-label","Event "+node.order+": "+node.type+". Open citation and flow context.");group.addEventListener("click",()=>showNode(node));group.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();showNode(node)}});const circle=document.createElementNS(svg.namespaceURI,"circle");circle.setAttribute("r",32);group.append(circle);const label=document.createElementNS(svg.namespaceURI,"text");label.setAttribute("text-anchor","middle");label.setAttribute("y",5);label.textContent=(node.order+". "+node.label).slice(0,20);group.append(label);layer.append(group)}}function reset(){scale=1;x=0;y=0;draw()}function fit(){if(!graph.nodes.length){reset();return}const cols=Math.min(5,graph.nodes.length),rows=Math.ceil(graph.nodes.length/5),width=100+(cols-1)*180+100,height=100+(rows-1)*135+100;const rect=box.getBoundingClientRect();scale=Math.max(.3,Math.min(2,Math.min(rect.width/width,rect.height/height)));x=Math.max(10,(rect.width-width*scale)/2);y=Math.max(10,(rect.height-height*scale)/2);draw()}document.getElementById("map-fit").addEventListener("click",fit);document.getElementById("map-reset").addEventListener("click",reset);document.getElementById("map-zoom-in").addEventListener("click",()=>{scale=Math.min(3,scale*1.2);draw()});document.getElementById("map-zoom-out").addEventListener("click",()=>{scale=Math.max(.3,scale/1.2);draw()});for(const input of document.querySelectorAll("[data-event-filter],[data-edge-filter],#focus-connected-evidence"))input.addEventListener("change",draw);svg.addEventListener("pointerdown",event=>{drag=[event.clientX,event.clientY];svg.setPointerCapture?.(event.pointerId)});svg.addEventListener("pointermove",event=>{if(!drag)return;x+=event.clientX-drag[0];y+=event.clientY-drag[1];drag=[event.clientX,event.clientY];draw()});svg.addEventListener("pointerup",()=>{drag=undefined});svg.addEventListener("wheel",event=>{event.preventDefault();scale=Math.max(.3,Math.min(3,scale*(event.deltaY<0?0.9:1.1)));draw()},{passive:false});fit()})();</script></body></html>`;
}

/**
 * Stages both export files before either final path changes. If staging metadata
 * fails, no map path is created or replaced. Final-path failures restore any
 * prior pair best-effort and remove newly committed files.
 */
export async function writeRelationshipMapExport(outputPath, html, metadata, operations = {}) {
  const fs = { mkdir, writeFile, rename, rm, ...operations };
  const metadataPath = outputPath.replace(/\.html$/i, ".redaction.json");
  const token = randomUUID();
  const htmlTemporary = `${outputPath}.${token}.tmp`;
  const metadataTemporary = `${metadataPath}.${token}.tmp`;
  const htmlBackup = `${outputPath}.${token}.bak`;
  const metadataBackup = `${metadataPath}.${token}.bak`;
  const moved = { html: false, metadata: false };
  const committed = { html: false, metadata: false };
  const moveAside = async (path, backup, kind) => {
    try { await fs.rename(path, backup); moved[kind] = true; } catch (error) { if (error?.code !== "ENOENT") throw error; }
  };
  try {
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await fs.writeFile(htmlTemporary, html, "utf8");
    await fs.writeFile(metadataTemporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await moveAside(outputPath, htmlBackup, "html");
    await moveAside(metadataPath, metadataBackup, "metadata");
    await fs.rename(metadataTemporary, metadataPath); committed.metadata = true;
    await fs.rename(htmlTemporary, outputPath); committed.html = true;
    await fs.rm(htmlBackup, { force: true });
    await fs.rm(metadataBackup, { force: true });
  } catch (error) {
    if (committed.html) await fs.rm(outputPath, { force: true }).catch(() => undefined);
    if (committed.metadata) await fs.rm(metadataPath, { force: true }).catch(() => undefined);
    if (moved.html) await fs.rename(htmlBackup, outputPath).catch(() => undefined);
    if (moved.metadata) await fs.rename(metadataBackup, metadataPath).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(htmlTemporary, { force: true }).catch(() => undefined);
    await fs.rm(metadataTemporary, { force: true }).catch(() => undefined);
    await fs.rm(htmlBackup, { force: true }).catch(() => undefined);
    await fs.rm(metadataBackup, { force: true }).catch(() => undefined);
  }
  return { outputPath, metadataPath };
}
