import { escapeHtml } from "./catalog.mjs";

const text = (value) => typeof value === "string" ? value.trim() : "";
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/i;
const CLASSIFICATIONS = new Set(["direct relationship", "inference"]);
const MARKUP_PATTERN = /<\s*\/?\s*(?:[a-z][\w:-]*|!doctype)\b[^>]*>/i;

function requiredText(value, field, maxLength) {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length === 0 || length > maxLength) throw new Error(`${field} must be between 1 and ${maxLength} characters.`);
  // Narrative-map prose is deliberately text-only. Escaping remains defense in
  // depth in the fixed renderer, but model markup is not a supported directive.
  if (MARKUP_PATTERN.test(normalized)) throw new Error(`${field} must not contain markup or script.`);
  return normalized;
}

function requiredId(value, field) {
  const id = requiredText(value, field, 40);
  if (!ID_PATTERN.test(id)) throw new Error(`${field} must be a simple identifier.`);
  return id;
}

function exactObject(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) throw new Error(`${label} is malformed or contains an unsupported directive.`);
}

function boundedArray(value, field, minItems, maxItems) {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    throw new Error(`${field} must contain between ${minItems} and ${maxItems} items.`);
  }
  return value;
}

function includedReferences(value, field, evidenceByReference) {
  const references = boundedArray(value, field, 1, 3).map((reference, index) => requiredText(reference, `${field}[${index + 1}]`, 100));
  if (new Set(references).size !== references.length) throw new Error(`${field} must not contain duplicate references.`);
  for (const reference of references) {
    const evidence = evidenceByReference.get(reference);
    if (!evidence || text(evidence.availability) === "excluded" || text(evidence.availability) === "missing") {
      throw new Error(`${field} cites unknown or excluded evidence outside the included redacted source bundle.`);
    }
  }
  return references;
}

/**
 * Validates the only model-controlled portion of a hindsight narrative map.
 * The fixed renderer owns all HTML, chronology, geometry, and interaction.
 */
export function normalizeHindsightNarrativeMap(value, evidenceByReference) {
  if (value === undefined) return undefined;
  exactObject(value, "Narrative map", ["layout", "groups", "nodes", "edges"]);
  if (requiredText(value.layout, "Narrative map layout", 32) !== "chronological") {
    throw new Error("Narrative map layout must be the supported chronological layout.");
  }
  if (!(evidenceByReference instanceof Map)) throw new Error("Narrative map requires an included evidence index.");

  const groups = boundedArray(value.groups, "Narrative map groups", 1, 12).map((group, index) => {
    const label = `Narrative map group ${index + 1}`;
    exactObject(group, label, ["id", "title"]);
    return { id: requiredId(group.id, `${label} id`), title: requiredText(group.title, `${label} title`, 160) };
  });
  if (new Set(groups.map((group) => group.id)).size !== groups.length) throw new Error("Narrative map groups must not have duplicate identifiers.");
  const groupIds = new Set(groups.map((group) => group.id));

  const identities = new Set();
  const nodes = boundedArray(value.nodes, "Narrative map nodes", 1, 30).map((node, index) => {
    const label = `Narrative map node ${index + 1}`;
    exactObject(node, label, ["id", "groupId", "title", "body", "classification", "evidenceReferences"]);
    const classification = requiredText(node.classification, `${label} classification`, 32);
    if (!CLASSIFICATIONS.has(classification)) throw new Error(`${label} must be explicitly classified as direct relationship or inference.`);
    const normalized = {
      id: requiredId(node.id, `${label} id`),
      groupId: requiredId(node.groupId, `${label} groupId`),
      title: requiredText(node.title, `${label} title`, 160),
      body: requiredText(node.body, `${label} body`, 1000),
      classification,
      references: includedReferences(node.evidenceReferences, `${label} evidenceReferences`, evidenceByReference),
    };
    if (!groupIds.has(normalized.groupId)) throw new Error(`${label} refers to an unknown group.`);
    const identity = JSON.stringify({ ...normalized, id: undefined, references: [...normalized.references].sort() });
    if (identities.has(identity)) throw new Error(`${label} duplicates an earlier narrative-map node.`);
    identities.add(identity);
    return normalized;
  });
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error("Narrative map nodes must not have duplicate identifiers.");
  if (groups.some((group) => !nodes.some((node) => node.groupId === group.id))) throw new Error("Every narrative map group must contain a cited node.");
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const edgeKeys = new Set();
  const edges = boundedArray(value.edges, "Narrative map edges", 0, 50).map((edge, index) => {
    const label = `Narrative map edge ${index + 1}`;
    exactObject(edge, label, ["from", "to", "label", "classification", "evidenceReferences"]);
    const from = requiredId(edge.from, `${label} from`);
    const to = requiredId(edge.to, `${label} to`);
    if (!nodesById.has(from) || !nodesById.has(to) || from === to) throw new Error(`${label} must connect two distinct known narrative-map nodes.`);
    const classification = requiredText(edge.classification, `${label} classification`, 32);
    if (!CLASSIFICATIONS.has(classification)) throw new Error(`${label} must be explicitly classified as direct relationship or inference.`);
    const references = includedReferences(edge.evidenceReferences, `${label} evidenceReferences`, evidenceByReference);
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) throw new Error(`${label} duplicates an earlier narrative-map edge.`);
    edgeKeys.add(key);
    // A direct relationship must at minimum retain a citation used by one end
    // of the relationship; inference edges remain visibly labeled as inference.
    if (classification === "direct relationship") {
      const endpointReferences = new Set([...nodesById.get(from).references, ...nodesById.get(to).references]);
      if (!references.some((reference) => endpointReferences.has(reference))) {
        throw new Error(`${label} direct relationship must cite evidence used by a connected node.`);
      }
    }
    return { from, to, label: requiredText(edge.label, `${label} label`, 160), classification, references };
  });
  return { layout: "chronological", groups, nodes, edges };
}

function chronology(node, evidenceOrder) {
  return Math.min(...node.references.map((reference) => evidenceOrder.get(reference) ?? Number.MAX_SAFE_INTEGER));
}

/** Renders a fixed, text-only, no-JS narrative map with local citation links. */
export function renderHindsightNarrativeMapHtml(map, citationLinks, evidenceOrder) {
  if (!map) return '<p class="empty" role="status">No model-provided narrative map was supplied.</p>';
  const orderedGroups = map.groups.map((group, index) => ({
    ...group,
    index,
    nodes: map.nodes.filter((node) => node.groupId === group.id).sort((left, right) => chronology(left, evidenceOrder) - chronology(right, evidenceOrder) || left.id.localeCompare(right.id)),
  })).sort((left, right) => chronology(left.nodes[0], evidenceOrder) - chronology(right.nodes[0], evidenceOrder) || left.index - right.index);
  const nodes = new Map(map.nodes.map((node) => [node.id, node]));
  const groupHtml = orderedGroups.map((group) => `<section class="narrative-map-group" aria-labelledby="narrative-map-group-${escapeHtml(group.id)}"><h3 id="narrative-map-group-${escapeHtml(group.id)}">${escapeHtml(group.title)}</h3><ol>${group.nodes.map((node) => `<li><article class="narrative-map-node narrative-map-${node.classification.replace(/\s+/g, "-")}"><h4>${escapeHtml(node.title)}</h4><p class="classification">${node.classification === "inference" ? "Inference · model-suggested relationship" : "Direct relationship · model-suggested relationship"}</p><p>${escapeHtml(node.body)}</p><p class="citations"><span class="empty">Cited evidence:</span> ${citationLinks(node.references)}</p></article></li>`).join("")}</ol></section>`).join("");
  const edgeHtml = map.edges.length === 0
    ? '<p class="empty">No narrative-map relationships were supplied.</p>'
    : `<ul class="narrative-map-edges">${map.edges.map((edge) => `<li><strong>${escapeHtml(nodes.get(edge.from).title)}</strong> <span class="narrative-map-arrow" aria-hidden="true">→</span> <strong>${escapeHtml(nodes.get(edge.to).title)}</strong>: ${escapeHtml(edge.label)} <span class="classification">${edge.classification === "inference" ? "Inference" : "Direct relationship"}</span><br><span class="citations"><span class="empty">Cited evidence:</span> ${citationLinks(edge.references)}</span></li>`).join("")}</ul>`;
  return `<p class="story-provenance">Model-provided grouping hints use the fixed chronological layout. Groups and nodes are ordered by their earliest cited event; order does not imply causation.</p><div class="narrative-map-groups">${groupHtml}</div><section class="narrative-map-relationships" aria-labelledby="narrative-map-relationships-heading"><h3 id="narrative-map-relationships-heading">Cited relationships</h3>${edgeHtml}</section>`;
}
