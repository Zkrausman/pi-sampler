import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_NATIVE_FILE_BYTES,
  MAX_SCENE_ELEMENTS,
  WorkspaceConflictError,
  openExcalidrawWorkspace,
  resolveProjectScenePath,
  resolveWorkspacePaths,
  startExcalidrawWorkspaceServer,
} from "../src/extensions/pi-excalidraw/workspace.mjs";

function project() { return mkdtempSync(join(tmpdir(), "pi-excalidraw-workspace-")); }
function rawRequest(url, path, headers) {
  const target = new URL(`${url}${path}`);
  return new Promise((resolveRequest, rejectRequest) => {
    const outbound = httpRequest({ hostname: target.hostname, port: target.port, path, headers }, (response) => {
      response.resume(); response.once("end", () => resolveRequest(response));
    });
    outbound.once("error", rejectRequest); outbound.end();
  });
}
function scene(extra = {}) {
  return { type: "excalidraw", version: 2, elements: [{ id: "rectangle-1", type: "rectangle", customNativeField: { retained: true } }], appState: { viewBackgroundColor: "#ffffff" }, files: { image: { id: "image", dataURL: "data:image/png;base64,AA==", customFileMetadata: { retained: true } } }, ...extra };
}

test("workspace migrates, preserves native scene/files values, and applies conditional revisions", async () => {
  const root = project(); const store = await openExcalidrawWorkspace(root);
  try {
    assert.equal(store.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 2);
    assert.equal(store.database.prepare("SELECT value FROM workspace_metadata WHERE key = 'format'").get().value, "pi-excalidraw-workspace-v1");
    const first = store.save("architecture", scene(), 0);
    assert.equal(first.revision, 1); assert.deepEqual(first.scene.files.image.customFileMetadata, { retained: true });
    assert.deepEqual(first.scene.elements[0].customNativeField, { retained: true });
    assert.throws(() => store.save("architecture", scene({ appState: { zoom: 2 } }), 0), WorkspaceConflictError);
    const second = store.save("architecture", scene({ appState: { zoom: 2 } }), 1);
    assert.equal(second.revision, 2); assert.equal(second.scene.appState.zoom, 2);
    const exported = store.exportDrawing("architecture");
    assert.equal(exported.type, "pi-excalidraw-workspace"); assert.equal(exported.version, 1); assert.equal(exported.drawing.revision, 2);
    const imported = store.importDrawing({ ...exported, drawing: { ...exported.drawing, id: "copied" } }, 0);
    assert.equal(imported.id, "copied"); assert.equal(imported.revision, 1);
  } finally { store.close(); }
  const reopened = await openExcalidrawWorkspace(root);
  try { assert.equal(reopened.get("architecture").revision, 2); } finally { reopened.close(); }
});

test("workspace upgrades a v1 database transactionally", async () => {
  const paths = resolveWorkspacePaths(project()); const { DatabaseSync } = await import("node:sqlite"); const database = new DatabaseSync(paths.databasePath);
  try {
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL) STRICT; CREATE TABLE drawings (id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1), scene_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;");
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
  } finally { database.close(); }
  const store = await openExcalidrawWorkspace(paths.projectRoot);
  try {
    assert.equal(store.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 2);
    assert.equal(store.database.prepare("SELECT value FROM workspace_metadata WHERE key = 'format'").get().value, "pi-excalidraw-workspace-v1");
  } finally { store.close(); }
});

test("workspace rejects oversize native files, unsafe JSON, and malformed recovery input", async () => {
  const root = project(); const store = await openExcalidrawWorkspace(root);
  try {
    assert.throws(() => store.save("large-file", scene({ files: { a: { payload: "x".repeat(MAX_NATIVE_FILE_BYTES + 1) } } }), 0), /file exceeds/);
    assert.throws(() => store.save("large-elements", scene({ elements: Array.from({ length: MAX_SCENE_ELEMENTS + 1 }, () => ({ type: "rectangle" })) }), 0), /element limit/);
    assert.throws(() => store.save("unsafe", JSON.parse('{"type":"excalidraw","elements":[],"__proto__":{}}'), 0), /unsafe object keys/);
  } finally { store.close(); }
  // Opening a malformed fixed database fails closed rather than silently repairing it.
  const corrupt = project(); const initial = await openExcalidrawWorkspace(corrupt); const database = initial.paths.databasePath; initial.close();
  writeFileSync(database, "not a database");
  await assert.rejects(openExcalidrawWorkspace(corrupt), (error) => error.code === "workspace_open_failed");
  // The store path is fixed, so a caller cannot redirect it to an arbitrary database.
  assert.throws(() => resolveProjectScenePath(corrupt, "../bad.sqlite", false), /project-relative/);
  assert.equal(existsSync(database), true);
});

test("native file import/export is contained, bounded, and atomically replaces the destination", async () => {
  const root = project(); const store = await openExcalidrawWorkspace(root);
  try {
    writeFileSync(join(root, "input.excalidraw"), JSON.stringify(scene()));
    const imported = store.importNativeFile("native", "input.excalidraw", 0);
    const exported = store.exportNativeFile("native", "nested/output.excalidraw");
    assert.equal(exported.revision, imported.revision);
    assert.deepEqual(JSON.parse(readFileSync(exported.path, "utf8")).files, scene().files);
    assert.throws(() => store.importNativeFile("escape", "../outside.excalidraw", 0), /project-relative/);
    assert.throws(() => store.exportNativeFile("native", "/tmp/outside.excalidraw"), /project-relative/);
  } finally { store.close(); }
});

test("native export rejects a symlinked parent without creating external directories", async () => {
  const root = project(); const external = project(); const store = await openExcalidrawWorkspace(root);
  try {
    store.save("native", scene(), 0);
    symlinkSync(external, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => store.exportNativeFile("native", "linked/new-dir/output.excalidraw"), /non-symlink project directories/);
    assert.equal(existsSync(join(external, "new-dir")), false);
  } finally { store.close(); }
});

test("loopback service exposes only bounded document persistence and reports conflicts", async () => {
  const root = project(); const store = await openExcalidrawWorkspace(root); const service = await startExcalidrawWorkspaceServer(store);
  try {
    assert.equal(service.server.address().address, "127.0.0.1");
    assert.equal((await fetch(`${service.url}/health`)).status, 200);
    const created = await fetch(`${service.url}/api/drawings/server`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: scene(), expectedRevision: 0 }) });
    assert.equal(created.status, 201); assert.equal((await created.json()).revision, 1);
    const conflict = await fetch(`${service.url}/api/drawings/server`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: scene(), expectedRevision: 0 }) });
    assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { error: "revision_conflict", revision: 1 });
    const exported = await fetch(`${service.url}/api/drawings/server/export`); assert.equal(exported.status, 200); assert.equal((await exported.json()).drawing.id, "server");
    const hostileHost = await rawRequest(service.url, "/health", { Host: "example.test" });
    assert.equal(hostileHost.statusCode, 403);
    await assert.rejects(startExcalidrawWorkspaceServer(store, { host: "0.0.0.0" }), /127\.0\.0\.1/);
  } finally { service.close(); store.close(); }
});
