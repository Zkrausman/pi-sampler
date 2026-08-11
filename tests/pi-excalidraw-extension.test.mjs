import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function loadExtensionCore() {
  const generator = readFileSync(join(root, "src/extensions/excalidraw/generator.ts"), "utf8");
  let extension = readFileSync(join(root, "src/extensions/pi-excalidraw/index.ts"), "utf8");
  extension = extension.replace(/import type \{ ExtensionAPI \}[^\n]+\n/, "type ExtensionAPI = { registerTool: (tool: unknown) => void };\n");
  extension = extension.replace(/import \{ withFileMutationQueue \}[^\n]+\n/, "const withFileMutationQueue = async (_path, fn) => fn();\n");
  extension = extension.replace(/import \{ Type \} from "typebox";\r?\n/, "const Type = { Object: (x) => x, String: () => ({}), Optional: (x) => x };\n");
  extension = extension.replace(/import[^\n]+from "\.\.\/excalidraw\/generator";\r?\n/, "");
  const source = `${generator}\n${extension}`;
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: "pi-excalidraw.ts" }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("parses constrained natural-language architecture descriptions deterministically", async () => {
  const { parseArchitectureDescription } = await loadExtensionCore();
  const architecture = parseArchitectureDescription("nodes: Client, API, Database; Client -> API -> Database");
  assert.deepEqual(architecture.nodes.map(({ id, label }) => ({ id, label })), [
    { id: "client-1", label: "Client" }, { id: "api-2", label: "API" }, { id: "database-3", label: "Database" },
  ]);
  assert.deepEqual(architecture.edges.map(({ from, to }) => ({ from, to })), [
    { from: "client-1", to: "api-2" }, { from: "api-2", to: "database-3" },
  ]);
  assert.throws(() => parseArchitectureDescription("make something nice"), /unsupported architecture statement/);
});

test("parser rejects oversized descriptions and limits nodes and edges while parsing", async () => {
  const { parseArchitectureDescription } = await loadExtensionCore();
  assert.throws(() => parseArchitectureDescription(`nodes: ${"A".repeat(17 * 1024)}`), /parsing limits/);
  assert.throws(() => parseArchitectureDescription(`nodes: ${Array.from({ length: 51 }, (_, i) => `N${i}`).join(", ")}`), /diagram limits/);
  assert.throws(() => parseArchitectureDescription(Array.from({ length: 102 }, (_, i) => i % 2 ? "B" : "A").join(" -> ")), /diagram limits/);
});

test("tool-facing generator writes a valid local Excalidraw file without network access", async () => {
  const { generateDiagram } = await loadExtensionCore();
  const cwd = mkdtempSync(join(tmpdir(), "pi-excalidraw-tool-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network must not be used"); };
  try {
    const result = generateDiagram(cwd, "Client connects to API; API connects to Database", "diagrams/system.excalidraw");
    const scene = JSON.parse(readFileSync(result.path, "utf8"));
    assert.equal(scene.type, "excalidraw");
    assert.equal(scene.version, 2);
    assert.equal(scene.elements.filter((element) => element.type === "arrow").length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("reader returns structured visual nodes and arrow connections", async () => {
  const { generateDiagram, readDiagram } = await loadExtensionCore();
  const cwd = mkdtempSync(join(tmpdir(), "pi-excalidraw-read-"));
  generateDiagram(cwd, "Client -> API -> Database");
  const result = readDiagram(cwd, "diagram.excalidraw");
  assert.deepEqual(result.summary.nodes.map((node) => node.label), ["Client", "API", "Database"]);
  assert.deepEqual(result.summary.connections.map(({ from, to }) => ({ from, to })), [{ from: "Client", to: "API" }, { from: "API", to: "Database" }]);
  assert.match(result.text, /"connections"/);
});

test("reader bounds oversized scenes, nesting, fanout, and labels", async () => {
  const { readDiagram } = await loadExtensionCore();
  const cwd = mkdtempSync(join(tmpdir(), "pi-excalidraw-bounds-"));
  const scene = (elements, extra = "") => JSON.stringify({ type: "excalidraw", elements, extra });
  writeFileSync(join(cwd, "large.excalidraw"), " ".repeat(5 * 1024 * 1024 + 1));
  assert.throws(() => readDiagram(cwd, "large.excalidraw"), /5MB/);
  writeFileSync(join(cwd, "deep.excalidraw"), `{"type":"excalidraw","elements":[],"extra":${"[".repeat(33)}${"]".repeat(33)}}`);
  assert.throws(() => readDiagram(cwd, "deep.excalidraw"), /nesting limit/);
  writeFileSync(join(cwd, "fanout.excalidraw"), scene([{ id: "node", type: "rectangle" }, ...Array.from({ length: 101 }, (_, i) => ({ id: `a${i}`, type: "arrow" }))]));
  assert.throws(() => readDiagram(cwd, "fanout.excalidraw"), /summary limits/);
  writeFileSync(join(cwd, "label.excalidraw"), scene([{ id: "text", type: "text", text: "x".repeat(257) }]));
  assert.throws(() => readDiagram(cwd, "label.excalidraw"), /label exceeds/);
});

test("reader rejects FIFO files where mkfifo is available", async (t) => {
  if (process.platform === "win32") return t.skip("mkfifo is not portable on Windows");
  const { readDiagram } = await loadExtensionCore();
  const cwd = mkdtempSync(join(tmpdir(), "pi-excalidraw-fifo-"));
  const fifo = join(cwd, "pipe.excalidraw");
  try {
    execFileSync("mkfifo", [fifo]);
    assert.throws(() => readDiagram(cwd, "pipe.excalidraw"), /regular file/);
  } finally { if (existsSync(fifo)) unlinkSync(fifo); }
});

test("reader and generator reject traversal and malformed local JSON", async () => {
  const { generateDiagram, readDiagram, resolveLocalDiagramPath } = await loadExtensionCore();
  const cwd = mkdtempSync(join(tmpdir(), "pi-excalidraw-safe-"));
  assert.throws(() => resolveLocalDiagramPath(cwd, "../outside.excalidraw"), /local relative/);
  assert.throws(() => generateDiagram(cwd, "A -> B", "/tmp/outside.excalidraw"), /local relative/);
  writeFileSync(join(cwd, "bad.excalidraw"), '{"type":"excalidraw","elements":[null]}');
  assert.throws(() => readDiagram(cwd, "bad.excalidraw"), /malformed Excalidraw elements/);
  writeFileSync(join(cwd, "proto.excalidraw"), '{"type":"excalidraw","elements":[],"__proto__":{}}');
  assert.throws(() => readDiagram(cwd, "proto.excalidraw"), /unsafe object keys/);
});

test("extension registers exactly the two local diagram tools", async () => {
  const module = await loadExtensionCore();
  const tools = [];
  module.default({ registerTool: (tool) => tools.push(tool) });
  assert.deepEqual(tools.map((tool) => tool.name), ["generate_diagram", "read_diagram"]);
  assert.doesNotMatch(readFileSync(join(root, "src/extensions/pi-excalidraw/index.ts"), "utf8"), /\bfetch\s*\(|https?:\/\/|\bexec\s*\(/);
});
