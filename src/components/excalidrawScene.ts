export type LocalExcalidrawScene = Readonly<{
  elements: readonly Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}>;

type FetchResponse = Readonly<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

type FetchScene = (url: string) => Promise<FetchResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSupportedElementType(value: unknown): value is "rectangle" | "text" | "arrow" {
  return value === "rectangle" || value === "text" || value === "arrow";
}

function hasUnsafeObjectKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsafeObjectKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    key === "__proto__" || key === "constructor" || key === "prototype" || hasUnsafeObjectKey(child)
  ));
}

function isFinitePoint(value: unknown): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
}

function isSupportedElement(element: Record<string, unknown>): boolean {
  if (
    typeof element.id !== "string" || element.id.length === 0 ||
    !isSupportedElementType(element.type) ||
    !["x", "y", "width", "height", "angle"].every((field) => isFiniteNumber(element[field]))
  ) {
    return false;
  }

  if (element.type === "text") {
    return typeof element.text === "string" &&
      typeof element.originalText === "string" &&
      isFiniteNumber(element.fontSize) &&
      isFiniteNumber(element.fontFamily) &&
      isFiniteNumber(element.lineHeight) &&
      isFiniteNumber(element.baseline);
  }

  if (element.type === "arrow") {
    return Array.isArray(element.points) &&
      element.points.length >= 2 &&
      element.points.every(isFinitePoint) &&
      (element.startBinding === null || isRecord(element.startBinding)) &&
      (element.endBinding === null || isRecord(element.endBinding));
  }

  return true;
}

/**
 * Restrict viewer inputs to a simple ASCII fixture filename in Vite's local
 * public diagram directory. Rejecting all encoding and path syntax prevents
 * browser URL normalization from changing the resource that is fetched.
 */
export function assertLocalDiagramUrl(url: string): void {
  if (!/^\/diagrams\/[A-Za-z0-9_-]+\.excalidraw$/.test(url)) {
    throw new TypeError("sceneUrl must be a local /diagrams/*.excalidraw path");
  }
}

/**
 * Parse the portable Excalidraw JSON envelope without executing its contents.
 * The local viewer intentionally supports only generator-compatible rectangle,
 * text, and arrow elements; other Excalidraw element types are rejected.
 */
export function parseExcalidrawScene(text: string): LocalExcalidrawScene {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("The diagram is not valid JSON");
  }

  if (!isRecord(parsed) || parsed.type !== "excalidraw" || !Array.isArray(parsed.elements)) {
    throw new TypeError("The diagram is not an Excalidraw scene");
  }
  if (hasUnsafeObjectKey(parsed)) {
    throw new TypeError("The diagram contains unsafe object keys");
  }
  if (!parsed.elements.every((element) => isRecord(element) && isSupportedElement(element))) {
    throw new TypeError("The diagram contains an invalid Excalidraw element");
  }
  if (parsed.appState !== undefined && !isRecord(parsed.appState)) {
    throw new TypeError("The diagram contains an invalid appState");
  }
  if (parsed.files !== undefined && !isRecord(parsed.files)) {
    throw new TypeError("The diagram contains invalid files");
  }

  return {
    elements: parsed.elements,
    appState: parsed.appState ?? {},
    files: parsed.files ?? {},
  };
}

/** Fetch and parse a scene from the local Vite public directory. */
export async function loadLocalExcalidrawScene(url: string, fetchScene: FetchScene = fetch): Promise<LocalExcalidrawScene> {
  assertLocalDiagramUrl(url);
  const response = await fetchScene(url);
  if (!response.ok) {
    throw new Error(`Could not load diagram (${response.status})`);
  }
  return parseExcalidrawScene(await response.text());
}
