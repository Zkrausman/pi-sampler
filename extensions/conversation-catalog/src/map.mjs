import { escapeHtml } from "./catalog.mjs";

const text = (v) => typeof v === "string" ? v.trim() : "";
const bounded = (v, n = 180) => Array.from(text(v)).slice(0, n).join("");

/** Builds only graph relationships already present in the flow projection. */
export function projectRelationshipMap(projection) {
  const events = Array.isArray(projection?.events) ? projection.events : [];
  const nodes = events.map((event, index) => ({
    id: text(event.id) || `event-${index + 1}`,
    label: bounded(event.title || event.category || "Event"),
    detail: bounded(event.summary || "No readable content"),
    type: text(event.category) || "unsupported",
  }));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(projection?.edges) ? projection.edges : []).flatMap((edge) =>
    ids.has(edge?.from) && ids.has(edge?.to) && edge.from !== edge.to
      ? [{ from: edge.from, to: edge.to, type: bounded(edge.label || "related", 60) }] : []);
  return { nodes, edges };
}

export function generateRelationshipMapHtml(session, graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const payload = JSON.stringify({ nodes, edges }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi relationship map</title><style>:root{font-family:system-ui;color-scheme:light dark}body{margin:0;padding:1rem}#map{border:1px solid #9997;height:70vh;overflow:hidden;position:relative;touch-action:none}svg{width:100%;height:100%}.node{cursor:pointer}.node text{font-size:12px;pointer-events:none}.edge{stroke:#789;stroke-width:2}.selected{stroke:#f80;stroke-width:4}button{margin:.2rem}.detail{max-width:60rem}</style></head><body><h1>Conversation relationship map</h1><p>Session ${escapeHtml(text(session?.id) || "selected conversation")}. Edges are only persisted parent/tool-result/chronological relationships. Drag to pan; wheel to zoom; select a node to focus direct connections.</p><p id="filters"></p><div id="map"></div><p class="detail" id="detail">Select a node to inspect it.</p><script type="application/json" id="data">${payload}</script><script>const g=JSON.parse(document.getElementById('data').textContent),box=document.getElementById('map'),svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),layer=document.createElementNS(svg.namespaceURI,'g');svg.append(layer);box.append(svg);let scale=1,x=0,y=0,active=null,types=[...new Set(g.edges.map(e=>e.type))],hidden=new Set;document.getElementById('filters').append(...types.map(t=>{let b=document.createElement('button');b.textContent='Hide '+t;b.onclick=()=>{hidden.has(t)?hidden.delete(t):hidden.add(t);b.textContent=(hidden.has(t)?'Show ':'Hide ')+t;draw()};return b}));const pos=id=>{let i=g.nodes.findIndex(n=>n.id===id);return{x:100+(i%5)*180,y:100+Math.floor(i/5)*130}};function draw(){layer.replaceChildren();layer.setAttribute('transform','translate('+x+' '+y+') scale('+scale+')');for(const e of g.edges)if(!hidden.has(e.type)){let a=pos(e.from),b=pos(e.to),l=document.createElementNS(svg.namespaceURI,'line');l.setAttribute('x1',a.x);l.setAttribute('y1',a.y);l.setAttribute('x2',b.x);l.setAttribute('y2',b.y);l.setAttribute('class','edge '+(active&&(e.from===active||e.to===active)?'selected':''));layer.append(l)}for(const n of g.nodes){let p=pos(n.id),q=document.createElementNS(svg.namespaceURI,'g');q.setAttribute('class','node');q.setAttribute('transform','translate('+p.x+' '+p.y+')');q.onclick=()=>{active=n.id;document.getElementById('detail').textContent=n.type+': '+n.label+' — '+n.detail;draw()};let c=document.createElementNS(svg.namespaceURI,'circle');c.setAttribute('r',30);c.setAttribute('fill','#579');q.append(c);let t=document.createElementNS(svg.namespaceURI,'text');t.setAttribute('text-anchor','middle');t.setAttribute('y',5);t.textContent=n.label.slice(0,18);q.append(t);layer.append(q)}}let drag;svg.onpointerdown=e=>drag=[e.clientX,e.clientY];svg.onpointermove=e=>{if(drag){x+=e.clientX-drag[0];y+=e.clientY-drag[1];drag=[e.clientX,e.clientY];draw()}};svg.onpointerup=()=>drag=null;svg.onwheel=e=>{e.preventDefault();scale=Math.max(.3,Math.min(3,scale*(e.deltaY<0?1.1:.9)));draw()};draw()</script></body></html>`;
}
