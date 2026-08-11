import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sceneModulePath = join(repositoryRoot, "src", "components", "excalidrawScene.ts");

async function loadSceneModule() {
  const source = readFileSync(sceneModulePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: sceneModulePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("parses the local public Excalidraw fixture", async () => {
  const { parseExcalidrawScene } = await loadSceneModule();
  const fixture = readFileSync(join(repositoryRoot, "public", "diagrams", "sample.excalidraw"), "utf8");
  const scene = parseExcalidrawScene(fixture);

  assert.ok(scene.elements.length > 0);
  assert.equal(scene.elements[0].type, "rectangle");
  assert.equal(scene.appState.viewBackgroundColor, "#ffffff");
});

test("loads a local scene through a mocked local fetch and rejects ambiguous paths", async () => {
  const { assertLocalDiagramUrl, loadLocalExcalidrawScene } = await loadSceneModule();
  const fixture = readFileSync(join(repositoryRoot, "public", "diagrams", "sample.excalidraw"), "utf8");
  const requests = [];
  const scene = await loadLocalExcalidrawScene("/diagrams/sample.excalidraw", async (url) => {
    requests.push(url);
    return { ok: true, status: 200, text: async () => fixture };
  });

  assert.deepEqual(requests, ["/diagrams/sample.excalidraw"]);
  assert.ok(scene.elements.length > 0);
  for (const url of [
    "https://example.test/scene.excalidraw",
    "/diagrams/%2e%2e/secret.excalidraw",
    "/diagrams/%2E%2E/secret.excalidraw",
    "/diagrams/.%2e/secret.excalidraw",
    "/diagrams/.%2E/secret.excalidraw",
    "/diagrams/sample.excalidraw?query",
    "/diagrams/sample.excalidraw#fragment",
    "/diagrams/sample.excalidraw/extra",
    "\\\\diagrams\\\\sample.excalidraw",
  ]) {
    assert.throws(() => assertLocalDiagramUrl(url), /local \/diagrams/);
  }
  await assert.rejects(
    () => loadLocalExcalidrawScene("/diagrams/%2e%2e/secret.excalidraw", async () => {
      throw new Error("fetch should not be called");
    }),
    /local \/diagrams/,
  );
});

test("rejects malformed scene data before it reaches Excalidraw", async () => {
  const { parseExcalidrawScene } = await loadSceneModule();
  assert.throws(() => parseExcalidrawScene("not json"), /not valid JSON/);
  assert.throws(() => parseExcalidrawScene('{"type":"excalidraw","elements":[null]}'), /invalid Excalidraw element/);
  assert.throws(() => parseExcalidrawScene('{"type":"excalidraw","elements":[{}]}'), /invalid Excalidraw element/);
  assert.throws(() => parseExcalidrawScene('{"type":"excalidraw","elements":[{"id":"bad","type":"rectangle","x":0,"y":0,"width":1,"height":1,"angle":1e999}]}'), /invalid Excalidraw element/);
  assert.throws(() => parseExcalidrawScene('{"type":"excalidraw","elements":[{"id":"bad","type":"arrow","x":0,"y":0,"width":1,"height":1,"angle":0,"points":[[0,0],[null,1]],"startBinding":null,"endBinding":null}]}'), /invalid Excalidraw element/);
  assert.throws(() => parseExcalidrawScene('{"type":"other","elements":[]}'), /not an Excalidraw scene/);
  assert.throws(() => parseExcalidrawScene('{"type":"excalidraw","elements":[],"__proto__":{}}'), /unsafe object keys/);
});

test("the app uses a bundled package import and has no remote script tag", () => {
  const app = readFileSync(join(repositoryRoot, "src", "components", "ExcalidrawViewer.tsx"), "utf8");
  const html = readFileSync(join(repositoryRoot, "index.html"), "utf8");
  assert.match(app, /from "@excalidraw\/excalidraw"/);
  assert.match(app, /@excalidraw\/excalidraw\/index\.css/);
  assert.match(app, /renderEmbeddable=\{\(\) => null\}/);
  assert.doesNotMatch(app, /https?:\/\//);
  assert.doesNotMatch(html, /<script[^>]+https?:\/\//i);
});
