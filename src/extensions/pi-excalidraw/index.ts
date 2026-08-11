// Project-local, process-free Excalidraw tools for Pi.
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Diagram, writeExcalidrawScene } from "../excalidraw/generator";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DESCRIPTION_BYTES = 16 * 1024;
const MAX_STATEMENTS = 100;
const MAX_NODES = 50;
const MAX_EDGES = 100;
const MAX_ELEMENTS = 250;
const MAX_JSON_NESTING = 32;
const MAX_LABEL_BYTES = 256;
const MAX_ID_BYTES = 256;
const MAX_SUMMARY_BYTES = 32 * 1024;

export type ArchitectureNode = Readonly<{ id: string; label: string; x: number; y: number }>;
export type ArchitectureEdge = Readonly<{ id: string; from: string; to: string }>;
export type Architecture = Readonly<{ nodes: readonly ArchitectureNode[]; edges: readonly ArchitectureEdge[] }>;
export type DiagramSummary = Readonly<{
  nodes: readonly Readonly<{ id: string; label: string; type: string }>[],
  connections: readonly Readonly<{ from: string; to: string; type: string }>[],
}>;

function cleanPath(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

/** Resolve a diagram path inside cwd, rejecting absolute paths, traversal, and symlink escapes. */
export function resolveLocalDiagramPath(cwd: string, requestedPath: string): string {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new TypeError("path must be a non-empty string");
  const candidate = cleanPath(requestedPath.trim());
  if (isAbsolute(candidate) || candidate.includes("\\") || candidate.split("/").includes("..") || extname(candidate).toLowerCase() !== ".excalidraw") {
    throw new RangeError("path must be a local relative .excalidraw path without traversal");
  }
  const root = resolve(cwd);
  const target = resolve(root, candidate);
  if (relative(root, target).startsWith("..") || relative(root, target) === "" || !target.startsWith(root + sep)) {
    throw new RangeError("path must be a local relative .excalidraw path without traversal");
  }
  const realRoot = realpathSync(root);
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new RangeError("path has no local parent");
    existing = parent;
  }
  if (lstatSync(existing).isSymbolicLink() || !realpathSync(existing).startsWith(realRoot + sep) && realpathSync(existing) !== realRoot) {
    throw new RangeError("path must remain inside the local project");
  }
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !realpathSync(target).startsWith(realRoot + sep))) {
    throw new RangeError("path must remain inside the local project");
  }
  return target;
}

function canonicalLabel(value: string): string {
  const label = value.trim().replace(/^[\s,:-]+|[\s,.!?;:]+$/g, "").replace(/\s+/g, " ");
  if (!label || label.length > 80 || !/^[\p{L}\p{N}][\p{L}\p{N} ._/-]*$/u.test(label)) throw new TypeError(`unsupported component label: ${value}`);
  return label;
}

function splitLabels(value: string): string[] {
  // Count separators before split() allocates an unbounded array.
  const parts = (value.match(/,|\band\b/gi)?.length ?? 0) + 1;
  if (parts > MAX_NODES) throw new RangeError("architecture exceeds local diagram limits");
  return value.split(/\s*(?:,|\band\b)\s*/i).map(canonicalLabel).filter(Boolean);
}

function countStatements(value: string): number {
  let count = 0;
  let content = false;
  for (const character of value) {
    if (character === "\n" || character === ";") { if (content) count += 1; content = false; }
    else if (!/\s/.test(character)) content = true;
  }
  return count + Number(content);
}

function assertJsonNesting(text: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_NESTING) throw new RangeError("diagram JSON exceeds nesting limit");
    } else if (character === "}" || character === "]") depth -= 1;
  }
}

/** Deterministically parses a deliberately small architecture-description grammar. */
export function parseArchitectureDescription(description: string): Architecture {
  if (typeof description !== "string") throw new TypeError("description must be a non-empty string");
  if (Buffer.byteLength(description, "utf8") > MAX_DESCRIPTION_BYTES || countStatements(description) > MAX_STATEMENTS) throw new RangeError("architecture description exceeds local parsing limits");
  if (!description.trim()) throw new TypeError("description must be a non-empty string");
  const labels: string[] = [];
  const addLabel = (value: string) => {
    const label = canonicalLabel(value);
    if (!labels.some((item) => item.toLocaleLowerCase() === label.toLocaleLowerCase())) {
      if (labels.length >= MAX_NODES) throw new RangeError("architecture exceeds local diagram limits");
      labels.push(label);
    }
  };
  const edges: Array<{ from: string; to: string }> = [];
  const addEdge = (from: string, to: string) => {
    addLabel(from); addLabel(to);
    if (edges.length >= MAX_EDGES) throw new RangeError("architecture exceeds local diagram limits");
    edges.push({ from: canonicalLabel(from), to: canonicalLabel(to) });
  };
  for (const raw of description.split(/[\n;]/)) {
    const statement = raw.trim();
    if (!statement) continue;
    const declaration = statement.match(/^(?:nodes?|components?|services?|systems?)\s*:\s*(.+)$/i);
    if (declaration) { splitLabels(declaration[1]).forEach(addLabel); continue; }
    if (statement.includes("->") || statement.includes("→")) {
      const links = statement.match(/->|→/g)?.length ?? 0;
      if (links > MAX_EDGES || edges.length + links > MAX_EDGES) throw new RangeError("architecture exceeds local diagram limits");
      const chain = statement.split(/\s*(?:->|→)\s*/).map(canonicalLabel);
      for (let index = 0; index < chain.length - 1; index += 1) addEdge(chain[index], chain[index + 1]);
      continue;
    }
    const relationship = statement.match(/^(.+?)\s+(?:connects?\s+to|sends?\s+to|calls?|routes?\s+to|flows?\s+to)\s+(.+)$/i);
    if (relationship) { addEdge(relationship[1], relationship[2]); continue; }
    if (/^[\p{L}\p{N}][\p{L}\p{N} ._/-]*(?:\s*,\s*[\p{L}\p{N}][\p{L}\p{N} ._/-]*)+$/u.test(statement)) { splitLabels(statement).forEach(addLabel); continue; }
    throw new TypeError(`unsupported architecture statement: ${statement}`);
  }
  if (!labels.length) throw new TypeError("description contains no components");
  const ids = new Map<string, string>();
  labels.forEach((label, index) => ids.set(label.toLocaleLowerCase(), `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node"}-${index + 1}`));
  const columns = Math.max(1, Math.ceil(Math.sqrt(labels.length)));
  const nodes = labels.map((label, index) => ({ id: ids.get(label.toLocaleLowerCase())!, label, x: 80 + (index % columns) * 320, y: 80 + Math.floor(index / columns) * 180 }));
  const uniqueEdges = edges.filter((edge, index) => edges.findIndex((other) => other.from.toLocaleLowerCase() === edge.from.toLocaleLowerCase() && other.to.toLocaleLowerCase() === edge.to.toLocaleLowerCase()) === index);
  return { nodes, edges: uniqueEdges.map((edge, index) => ({ id: `edge-${index + 1}`, from: ids.get(edge.from.toLocaleLowerCase())!, to: ids.get(edge.to.toLocaleLowerCase())! })) };
}

export function generateDiagram(cwd: string, description: string, requestedPath = "diagram.excalidraw") {
  const architecture = parseArchitectureDescription(description);
  const path = resolveLocalDiagramPath(cwd, requestedPath);
  const result = writeExcalidrawScene(architecture as Diagram, path);
  return { path: result.path, architecture, scene: result.scene };
}

function assertSafeJson(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const key of Object.keys(current)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new TypeError("diagram contains unsafe object keys");
      pending.push((current as Record<string, unknown>)[key]);
    }
  }
}

function assertBoundedString(value: unknown, name: string, maxBytes: number): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) throw new RangeError(`${name} exceeds local parsing limit`);
}

/** Parse visual rectangle/text nodes and arrow bindings without executing embedded data. */
export function summarizeExcalidrawJson(json: string): DiagramSummary {
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_FILE_BYTES) throw new RangeError("diagram exceeds 5MB local parsing limit");
  assertJsonNesting(json);
  let scene: unknown;
  try { scene = JSON.parse(json); } catch { throw new TypeError("diagram is not valid JSON"); }
  assertSafeJson(scene);
  if (!scene || typeof scene !== "object" || (scene as { type?: unknown }).type !== "excalidraw" || !Array.isArray((scene as { elements?: unknown }).elements)) throw new TypeError("diagram is not an Excalidraw scene");
  const elements = (scene as { elements: unknown[] }).elements;
  if (elements.length > MAX_ELEMENTS) throw new RangeError("diagram exceeds element limit");
  const valid = elements.filter((element): element is Record<string, unknown> => !!element && typeof element === "object" && typeof (element as Record<string, unknown>).id === "string" && typeof (element as Record<string, unknown>).type === "string" && (element as Record<string, unknown>).isDeleted !== true);
  if (valid.length !== elements.length) throw new TypeError("diagram contains malformed Excalidraw elements");
  for (const element of valid) {
    assertBoundedString(element.id, "element id", MAX_ID_BYTES);
    if (element.type === "text") assertBoundedString(element.text, "element label", MAX_LABEL_BYTES);
  }
  const textForContainer = new Map<string, string>();
  valid.filter((element) => element.type === "text" && typeof element.containerId === "string").forEach((element) => textForContainer.set(element.containerId as string, element.text as string));
  const nodes = valid.filter((element) => element.type === "rectangle" || (element.type === "text" && !element.containerId)).map((element) => ({ id: element.id as string, label: element.type === "rectangle" ? textForContainer.get(element.id as string) ?? "(unlabeled)" : element.text as string, type: element.type as string }));
  const connections = valid.filter((element) => element.type === "arrow").map((element) => ({ from: labelFor((element.startBinding as Record<string, unknown> | null)?.elementId, nodes), to: labelFor((element.endBinding as Record<string, unknown> | null)?.elementId, nodes), type: "arrow" }));
  if (nodes.length > MAX_NODES || connections.length > MAX_EDGES) throw new RangeError("diagram exceeds summary limits");
  const summary = { nodes, connections };
  if (Buffer.byteLength(JSON.stringify(summary), "utf8") > MAX_SUMMARY_BYTES) throw new RangeError("diagram summary exceeds output limit");
  return summary;
}

function labelFor(id: unknown, nodes: readonly Readonly<{ id: string; label: string }>[]): string {
  return typeof id === "string" ? nodes.find((node) => node.id === id)?.label ?? id : "(unbound)";
}

export function readDiagram(cwd: string, requestedPath: string): { path: string; summary: DiagramSummary; text: string } {
  const path = resolveLocalDiagramPath(cwd, requestedPath);
  // Open once, then inspect/read that descriptor: pathname checks alone can race a symlink swap.
  const before = lstatSync(path);
  if (!before.isFile()) throw new TypeError("diagram must be a regular file");
  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new TypeError("diagram must be a regular file");
    if (opened.size > MAX_FILE_BYTES) throw new RangeError("diagram exceeds 5MB local parsing limit");
    const summary = summarizeExcalidrawJson(readFileSync(descriptor, "utf8"));
    const text = JSON.stringify(summary, null, 2);
    if (Buffer.byteLength(text, "utf8") > MAX_SUMMARY_BYTES) throw new RangeError("diagram summary exceeds output limit");
    return { path, summary, text };
  } finally { closeSync(descriptor); }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_diagram", label: "Generate Diagram", description: "Locally convert constrained architecture statements (for example, 'Client -> API -> Database') into a valid .excalidraw file. No network or process calls.",
    parameters: Type.Object({ description: Type.String({ description: "Statements separated by semicolons/newlines: nodes: A, B; A -> B" }), path: Type.Optional(Type.String({ description: "Project-relative .excalidraw output path; default diagram.excalidraw" })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveLocalDiagramPath(ctx.cwd, params.path ?? "diagram.excalidraw");
      const result = await withFileMutationQueue(path, async () => generateDiagram(ctx.cwd, params.description, params.path ?? "diagram.excalidraw"));
      return { content: [{ type: "text", text: `Wrote ${result.path}\n${JSON.stringify(result.architecture, null, 2)}` }], details: { path: result.path, architecture: result.architecture } };
    },
  });
  pi.registerTool({
    name: "read_diagram", label: "Read Diagram", description: "Safely summarize a local project-relative .excalidraw JSON file into nodes and arrow connections. No network or process calls.",
    parameters: Type.Object({ path: Type.String({ description: "Project-relative .excalidraw file path" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = readDiagram(ctx.cwd, params.path);
      return { content: [{ type: "text", text: result.text }], details: { path: result.path, ...result.summary } };
    },
  });
}
