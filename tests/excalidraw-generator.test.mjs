import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatorPath = join(repositoryRoot, "src", "extensions", "excalidraw", "generator.ts");

async function loadGenerator() {
  const source = readFileSync(generatorPath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: generatorPath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

function assertFiniteNumericFields(value, path = "scene") {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} must be finite`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteNumericFields(item, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => assertFiniteNumericFields(item, `${path}.${key}`));
  }
}

function assertNonZeroArrowPath(arrow) {
  const [start, end] = arrow.points;
  assert.ok(start[0] !== end[0] || start[1] !== end[1], "arrow points must form a non-zero path");
}

test("writes a parseable diagram.excalidraw with bound rectangles, text, and arrows", async () => {
  const { writeExcalidrawScene } = await loadGenerator();
  const outputDirectory = mkdtempSync(join(tmpdir(), "pi-sampler-excalidraw-"));
  const outputPath = join(outputDirectory, "diagram.excalidraw");
  const diagram = {
    nodes: [
      { id: "start", label: "Start", x: 80, y: 80 },
      { id: "finish", label: "Finish", x: 420, y: 230, width: 240, height: 120 },
    ],
    edges: [{ id: "start-to-finish", from: "start", to: "finish" }],
  };

  const result = writeExcalidrawScene(diagram, outputPath);
  assert.equal(result.path, outputPath);
  const scene = JSON.parse(readFileSync(outputPath, "utf8"));

  // Stable Excalidraw ExportedDataState envelope used by the public editor.
  assert.equal(scene.type, "excalidraw");
  assert.equal(scene.version, 2);
  assert.equal(scene.source, "https://excalidraw.com");
  assert.deepEqual(scene.appState, { gridSize: null, viewBackgroundColor: "#ffffff" });
  assert.deepEqual(scene.files, {});

  const byType = (type) => scene.elements.filter((element) => element.type === type);
  const rectangles = byType("rectangle");
  const texts = byType("text");
  const arrows = byType("arrow");
  assert.equal(rectangles.length, 2);
  assert.equal(texts.length, 2);
  assert.equal(arrows.length, 1);

  assertFiniteNumericFields(scene);
  for (const element of scene.elements) {
    assert.equal(typeof element.id, "string");
    assert.equal(element.isDeleted, false);
    assert.equal(element.version, 1);
    assert.equal(typeof element.seed, "number");
    assert.equal(typeof element.versionNonce, "number");
    assert.ok(Array.isArray(element.groupIds));
  }

  for (const text of texts) {
    const container = rectangles.find((rectangle) => rectangle.id === text.containerId);
    assert.ok(container, "each text element belongs to a generated rectangle");
    assert.ok(container.boundElements.some((binding) => binding.id === text.id && binding.type === "text"));
    assert.equal(text.originalText, text.text);
    assert.equal(text.textAlign, "center");
  }

  const [arrow] = arrows;
  const startRectangle = rectangles.find((rectangle) => rectangle.id === arrow.startBinding.elementId);
  const endRectangle = rectangles.find((rectangle) => rectangle.id === arrow.endBinding.elementId);
  assert.ok(startRectangle, "arrow start binding references a rectangle");
  assert.ok(endRectangle, "arrow end binding references a rectangle");
  assert.notEqual(startRectangle.id, endRectangle.id);
  assert.equal(arrow.endArrowhead, "arrow");
  assert.equal(arrow.points.length, 2);
  assertNonZeroArrowPath(arrow);
  assert.ok(startRectangle.boundElements.some((binding) => binding.id === arrow.id && binding.type === "arrow"));
  assert.ok(endRectangle.boundElements.some((binding) => binding.id === arrow.id && binding.type === "arrow"));
});

test("generates finite non-zero horizontal and vertical arrows", async () => {
  const { createExcalidrawScene } = await loadGenerator();
  for (const [axis, destination] of [["horizontal", { x: 400, y: 0 }], ["vertical", { x: 0, y: 300 }]]) {
    const scene = createExcalidrawScene({
      nodes: [
        { id: "from", label: "From", x: 0, y: 0, width: 100, height: 100 },
        { id: "to", label: "To", ...destination, width: 100, height: 100 },
      ],
      edges: [{ from: "from", to: "to" }],
    });
    const arrow = scene.elements.find((element) => element.type === "arrow");
    assert.ok(arrow, `${axis} scene contains an arrow`);
    assertFiniteNumericFields(scene);
    assertNonZeroArrowPath(arrow);
    assert.equal(axis === "horizontal" ? arrow.height : arrow.width, 0);
  }
});

test("rejects coincident, touching, and overflowed layouts before serialization", async () => {
  const { createExcalidrawScene } = await loadGenerator();
  const edge = [{ from: "from", to: "to" }];
  assert.throws(
    () => createExcalidrawScene({
      nodes: [
        { id: "from", label: "From", x: 0, y: 0, width: 100, height: 100 },
        { id: "to", label: "To", x: 25, y: 25, width: 50, height: 50 },
      ],
      edges: edge,
    }),
    /coincident centres/,
  );
  assert.throws(
    () => createExcalidrawScene({
      nodes: [
        { id: "from", label: "From", x: 0, y: 0, width: 100, height: 100 },
        { id: "to", label: "To", x: 100, y: 0, width: 100, height: 100 },
      ],
      edges: edge,
    }),
    /touching or overlapping arrow endpoints/,
  );
  assert.throws(
    () => createExcalidrawScene({
      nodes: [{ id: "only", label: "Only", x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 100 }],
      edges: [],
    }),
    /not finite/,
    "overflowed text positions are rejected even without an edge",
  );
  assert.throws(
    () => createExcalidrawScene({
      nodes: [
        { id: "from", label: "From", x: -Number.MAX_VALUE, y: 0, width: 1, height: 100 },
        { id: "to", label: "To", x: Number.MAX_VALUE, y: 300, width: 1, height: 100 },
      ],
      edges: edge,
    }),
    /arrow direction x is not finite/,
    "overflowed arrow geometry is rejected before serialization",
  );
});

test("rejects edges that cannot form Excalidraw rectangle bindings", async () => {
  const { createExcalidrawScene } = await loadGenerator();
  assert.throws(
    () => createExcalidrawScene({ nodes: [{ id: "only", label: "Only", x: 0, y: 0 }], edges: [{ from: "only", to: "missing" }] }),
    /unknown node/,
  );
  assert.throws(
    () => createExcalidrawScene({ nodes: [{ id: "only", label: "Only", x: 0, y: 0 }], edges: [{ from: "only", to: "only" }] }),
    /self-referencing/,
  );
});
