// @ts-ignore This browser-oriented root tsconfig intentionally has no @types/node; this local-only module runs in Node.
import { mkdirSync, writeFileSync } from "node:fs";
// @ts-ignore This browser-oriented root tsconfig intentionally has no @types/node; this local-only module runs in Node.
import { dirname, resolve } from "node:path";

/**
 * The interoperable Excalidraw scene envelope used by the public Excalidraw
 * editor. It is the stable JSON export shape (`type: "excalidraw"`,
 * `version: 2`) documented by the Excalidraw open-source project:
 * https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/element/types.ts
 *
 * This module intentionally emits only the common rectangle, text, and arrow
 * element fields so it remains a local, dependency-free scene generator.
 */
export type DiagramNode = Readonly<{
  /** Caller-owned identifier used by edges; it is not reused as a scene element id. */
  id: string;
  label: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
}>;

export type DiagramEdge = Readonly<{
  /** Optional caller-owned identifier, used only to make generated ids readable. */
  id?: string;
  from: string;
  to: string;
}>;

export type Diagram = Readonly<{
  nodes: readonly DiagramNode[];
  edges: readonly DiagramEdge[];
}>;

export type ExcalidrawElement = Record<string, unknown>;

export type ExcalidrawScene = Readonly<{
  type: "excalidraw";
  version: 2;
  source: "https://excalidraw.com";
  elements: readonly ExcalidrawElement[];
  appState: Readonly<{
    gridSize: null;
    viewBackgroundColor: string;
  }>;
  files: Record<string, never>;
}>;

export type WriteExcalidrawSceneResult = Readonly<{
  path: string;
  scene: ExcalidrawScene;
}>;

type SizedNode = DiagramNode & { width: number; height: number };

type Point = Readonly<{ x: number; y: number }>;

const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 100;
const DEFAULT_BACKGROUND = "#a5d8ff";
const STROKE_COLOR = "#1e1e1e";
const TEXT_FONT_SIZE = 20;
const TEXT_LINE_HEIGHT = 1.25;
const MAX_GENERATION_NODES = 50;
const MAX_GENERATION_EDGES = 100;
const MAX_GENERATION_LABEL_BYTES = 256;

function assertFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function validateDiagram(diagram: Diagram): Map<string, SizedNode> {
  if (!diagram || !Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges)) {
    throw new TypeError("diagram must contain nodes and edges arrays");
  }
  if (diagram.nodes.length > MAX_GENERATION_NODES || diagram.edges.length > MAX_GENERATION_EDGES) {
    throw new RangeError("diagram exceeds local generation limits");
  }

  const nodes = new Map<string, SizedNode>();
  for (const node of diagram.nodes) {
    assertNonEmptyString(node.id, "node.id");
    if (nodes.has(node.id)) throw new TypeError(`duplicate node id: ${node.id}`);
    if (typeof node.label !== "string") throw new TypeError(`node ${node.id} label must be a string`);
    if (Buffer.byteLength(node.label, "utf8") > MAX_GENERATION_LABEL_BYTES) throw new RangeError(`node ${node.id} label exceeds local generation limit`);
    assertFiniteNumber(node.x, `node ${node.id} x`);
    assertFiniteNumber(node.y, `node ${node.id} y`);
    const width = node.width ?? DEFAULT_WIDTH;
    const height = node.height ?? DEFAULT_HEIGHT;
    assertFiniteNumber(width, `node ${node.id} width`);
    assertFiniteNumber(height, `node ${node.id} height`);
    if (width <= 0 || height <= 0) throw new RangeError(`node ${node.id} dimensions must be positive`);
    nodes.set(node.id, { ...node, width, height });
  }

  for (const edge of diagram.edges) {
    assertNonEmptyString(edge.from, "edge.from");
    assertNonEmptyString(edge.to, "edge.to");
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      throw new RangeError(`edge references an unknown node: ${edge.from} -> ${edge.to}`);
    }
    if (edge.from === edge.to) {
      throw new RangeError(`self-referencing edges are not supported: ${edge.from}`);
    }
  }
  return nodes;
}

/** A deterministic positive integer for Excalidraw's required seed-like fields. */
function stableNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

function commonElement(id: string, index: string, seedSuffix: string): ExcalidrawElement {
  return {
    id,
    angle: 0,
    strokeColor: STROKE_COLOR,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    seed: stableNumber(`${seedSuffix}:seed`),
    version: 1,
    versionNonce: stableNumber(`${seedSuffix}:nonce`),
    isDeleted: false,
    updated: 1,
    link: null,
    locked: false,
  };
}

function assertFiniteDerivedNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`unsupported diagram layout: ${name} is not finite`);
  }
}

function assertFiniteElementNumbers(value: unknown, name: string): void {
  if (typeof value === "number") {
    assertFiniteDerivedNumber(value, name);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteElementNumbers(item, `${name}[${index}]`));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => assertFiniteElementNumbers(item, `${name}.${key}`));
  }
}

function textMetrics(label: string): { width: number; height: number; baseline: number } {
  const lines = label.split("\n");
  const widestLine = lines.reduce((widest, line) => Math.max(widest, line.length), 0);
  // Excalidraw recalculates text on import; these conservative metrics centre it before that pass.
  const width = Math.max(TEXT_FONT_SIZE, widestLine * TEXT_FONT_SIZE * 0.6);
  const height = Math.max(TEXT_FONT_SIZE * TEXT_LINE_HEIGHT, lines.length * TEXT_FONT_SIZE * TEXT_LINE_HEIGHT);
  assertFiniteDerivedNumber(width, "text width");
  assertFiniteDerivedNumber(height, "text height");
  return { width, height, baseline: TEXT_FONT_SIZE };
}

function centre(node: SizedNode): Point {
  const x = node.x + node.width / 2;
  const y = node.y + node.height / 2;
  assertFiniteDerivedNumber(x, `node ${node.id} centre x`);
  assertFiniteDerivedNumber(y, `node ${node.id} centre y`);
  return { x, y };
}

function pointOnBoundary(node: SizedNode, toward: Point): Point {
  const middle = centre(node);
  const dx = toward.x - middle.x;
  const dy = toward.y - middle.y;
  assertFiniteDerivedNumber(dx, "arrow direction x");
  assertFiniteDerivedNumber(dy, "arrow direction y");
  const scale = Math.max(Math.abs(dx) / (node.width / 2), Math.abs(dy) / (node.height / 2));
  assertFiniteDerivedNumber(scale, "arrow boundary scale");
  if (scale === 0) {
    throw new RangeError("unsupported diagram layout: connected nodes have coincident centres");
  }
  const x = middle.x + dx / scale;
  const y = middle.y + dy / scale;
  assertFiniteDerivedNumber(x, "arrow boundary x");
  assertFiniteDerivedNumber(y, "arrow boundary y");
  return { x, y };
}

function arrowGeometry(from: SizedNode, to: SizedNode): { x: number; y: number; width: number; height: number; points: readonly (readonly [number, number])[] } {
  const start = pointOnBoundary(from, centre(to));
  const end = pointOnBoundary(to, centre(from));
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  assertFiniteDerivedNumber(deltaX, "arrow length x");
  assertFiniteDerivedNumber(deltaY, "arrow length y");
  if (deltaX === 0 && deltaY === 0) {
    throw new RangeError("unsupported diagram layout: connected rectangles have touching or overlapping arrow endpoints");
  }
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(deltaX);
  const height = Math.abs(deltaY);
  const points: readonly (readonly [number, number])[] = [[start.x - x, start.y - y], [end.x - x, end.y - y]];
  assertFiniteElementNumbers({ x, y, width, height, points }, "arrow geometry");
  return { x, y, width, height, points };
}

/**
 * Create an Excalidraw JSON scene without I/O. Element ids and seeds are
 * deterministic for a given diagram, which makes generated scenes diffable.
 */
export function createExcalidrawScene(diagram: Diagram): ExcalidrawScene {
  const nodesById = validateDiagram(diagram);
  const elements: ExcalidrawElement[] = [];
  const nodeElementIds = new Map<string, { rectangleId: string; textId: string }>();
  const rectangleElements = new Map<string, ExcalidrawElement>();

  diagram.nodes.forEach((node, nodeIndex) => {
    const sized = nodesById.get(node.id)!;
    const rectangleId = `rectangle-${nodeIndex}`;
    const textId = `text-${nodeIndex}`;
    const metrics = textMetrics(sized.label);
    const rectangle = {
      ...commonElement(rectangleId, `a${nodeIndex * 2}`, rectangleId),
      type: "rectangle",
      x: sized.x,
      y: sized.y,
      width: sized.width,
      height: sized.height,
      backgroundColor: sized.backgroundColor ?? DEFAULT_BACKGROUND,
      roundness: { type: 3 },
      boundElements: [{ id: textId, type: "text" }],
    };
    const text = {
      ...commonElement(textId, `a${nodeIndex * 2 + 1}`, textId),
      type: "text",
      x: sized.x + (sized.width - metrics.width) / 2,
      y: sized.y + (sized.height - metrics.height) / 2,
      width: metrics.width,
      height: metrics.height,
      text: sized.label,
      fontSize: TEXT_FONT_SIZE,
      fontFamily: 5,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: rectangleId,
      originalText: sized.label,
      autoResize: true,
      lineHeight: TEXT_LINE_HEIGHT,
      baseline: metrics.baseline,
    };
    elements.push(rectangle, text);
    nodeElementIds.set(node.id, { rectangleId, textId });
    rectangleElements.set(node.id, rectangle);
  });

  diagram.edges.forEach((edge, edgeIndex) => {
    const from = nodesById.get(edge.from)!;
    const to = nodesById.get(edge.to)!;
    const edgeIdPart = edge.id ? `-${edge.id.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
    const arrowId = `arrow-${edgeIndex}${edgeIdPart}`;
    const geometry = arrowGeometry(from, to);
    const fromIds = nodeElementIds.get(edge.from)!;
    const toIds = nodeElementIds.get(edge.to)!;
    const arrow = {
      ...commonElement(arrowId, `b${edgeIndex}`, arrowId),
      type: "arrow",
      ...geometry,
      lastCommittedPoint: null,
      startBinding: { elementId: fromIds.rectangleId, focus: 0, gap: 1 },
      endBinding: { elementId: toIds.rectangleId, focus: 0, gap: 1 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
      boundElements: null,
    };
    elements.push(arrow);
    (rectangleElements.get(edge.from)!.boundElements as Array<Record<string, string>>).push({ id: arrowId, type: "arrow" });
    (rectangleElements.get(edge.to)!.boundElements as Array<Record<string, string>>).push({ id: arrowId, type: "arrow" });
  });

  // Reject arithmetic overflow before callers can receive or serialize an invalid scene.
  elements.forEach((element, index) => assertFiniteElementNumbers(element, `elements[${index}]`));

  return {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements,
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

/**
 * Create parent directories and write a formatted local Excalidraw scene.
 * The default path deliberately fulfils the narrow tool contract: diagram.excalidraw.
 */
export function writeExcalidrawScene(diagram: Diagram, outputPath = "diagram.excalidraw"): WriteExcalidrawSceneResult {
  assertNonEmptyString(outputPath, "outputPath");
  const path = resolve(outputPath);
  const scene = createExcalidrawScene(diagram);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(scene, null, 2)}\n`, "utf8");
  return { path, scene };
}
