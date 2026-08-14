// Local-only SQLite persistence and HTTP boundary for a project Excalidraw workspace.
// This module deliberately has no Pi tool registration and no browser UI.
import { createServer } from "node:http";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const WORKSPACE_DIRECTORY = ".pi/excalidraw";
export const WORKSPACE_DATABASE = "workspace.sqlite";
export const MAX_SCENE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_ENTRIES = 100;
export const MAX_SCENE_ELEMENTS = 10_000;
export const MAX_NATIVE_FILE_BYTES = 1024 * 1024;
export const MAX_JSON_DEPTH = 64;
const MAX_ID_LENGTH = 128;
const MAX_HTTP_BODY_BYTES = MAX_SCENE_BYTES + 64 * 1024;
const SCHEMA_VERSION = 2;

export class WorkspaceConflictError extends Error {
  constructor(id, expectedRevision, actualRevision) {
    super(`drawing ${id} changed (expected revision ${expectedRevision}, current revision ${actualRevision ?? "absent"})`);
    this.name = "WorkspaceConflictError";
    this.code = "revision_conflict";
    this.id = id;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function workspaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Fail explicitly rather than relying on an unsupported Node version's import error. */
export async function loadNodeSqlite() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(major) || major < 24) {
    throw workspaceError("node_sqlite_requires_node_24", "Pi Excalidraw workspace requires Node 24+ with node:sqlite; node:sqlite is experimental in Node 24.");
  }
  try {
    const sqlite = await import("node:sqlite");
    if (typeof sqlite.DatabaseSync !== "function") throw new TypeError("DatabaseSync is unavailable");
    return sqlite;
  } catch (cause) {
    throw workspaceError("node_sqlite_unavailable", "Pi Excalidraw workspace requires Node 24+ with node:sqlite; node:sqlite is experimental in Node 24. " + (cause instanceof Error ? cause.message : ""));
  }
}

function isInside(root, target) {
  const between = relative(root, target);
  return between !== "" && !between.startsWith(`..${sep}`) && between !== ".." && !isAbsolute(between);
}

function assertDirectoryNotSymlink(path, label) {
  if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw workspaceError("unsafe_workspace_path", `${label} must be a non-symlink directory`);
  }
}

function assertContainedProjectDirectory(root, path) {
  const stat = lstatSync(path);
  const resolved = realpathSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (resolved !== root && !isInside(root, resolved))) {
    throw workspaceError("unsafe_project_path", "path must remain beneath non-symlink project directories");
  }
}

/** Create the one fixed workspace location below a trusted project root. */
export function resolveWorkspacePaths(projectRoot) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) throw new TypeError("projectRoot must be a non-empty path");
  const root = realpathSync(resolve(projectRoot));
  assertDirectoryNotSymlink(root, "project root");
  const piDirectory = resolve(root, ".pi");
  if (!isInside(root, piDirectory)) throw workspaceError("unsafe_workspace_path", "workspace escapes project root");
  if (!existsSync(piDirectory)) mkdirSync(piDirectory, { recursive: false, mode: 0o700 });
  assertDirectoryNotSymlink(piDirectory, ".pi");
  const workspaceDirectory = resolve(piDirectory, "excalidraw");
  if (!isInside(root, workspaceDirectory)) throw workspaceError("unsafe_workspace_path", "workspace escapes project root");
  if (!existsSync(workspaceDirectory)) mkdirSync(workspaceDirectory, { recursive: false, mode: 0o700 });
  assertDirectoryNotSymlink(workspaceDirectory, "workspace directory");
  const databasePath = resolve(workspaceDirectory, WORKSPACE_DATABASE);
  if (!isInside(root, databasePath)) throw workspaceError("unsafe_workspace_path", "workspace database escapes project root");
  if (existsSync(databasePath) && (!lstatSync(databasePath).isFile() || lstatSync(databasePath).isSymbolicLink())) {
    throw workspaceError("unsafe_workspace_path", "workspace database must be a regular non-symlink file");
  }
  return { projectRoot: root, workspaceDirectory, databasePath };
}

function assertId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new TypeError("drawing id must be 1-128 ASCII letters, digits, dots, underscores, or hyphens");
  }
}

function assertExpectedRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError("expectedRevision must be a non-negative safe integer");
}

function assertSafeValue(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new RangeError("native scene exceeds JSON nesting limit");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("native scene contains a non-finite number"); return; }
  if (Array.isArray(value)) { for (const item of value) assertSafeValue(item, depth + 1); return; }
  if (!value || typeof value !== "object") throw new TypeError("native scene contains an unsupported value");
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new TypeError("native scene contains unsafe object keys");
    assertSafeValue(value[key], depth + 1);
  }
}

function validateScene(scene) {
  if (!scene || typeof scene !== "object" || Array.isArray(scene) || scene.type !== "excalidraw" || !Array.isArray(scene.elements)) {
    throw new TypeError("scene must be a native Excalidraw object with type and elements");
  }
  assertSafeValue(scene);
  if (scene.elements.length > MAX_SCENE_ELEMENTS) throw new RangeError("native scene exceeds element limit");
  const files = scene.files;
  if (files !== undefined) {
    if (!files || typeof files !== "object" || Array.isArray(files)) throw new TypeError("native scene files must be an object");
    const entries = Object.entries(files);
    if (entries.length > MAX_FILE_ENTRIES) throw new RangeError("native scene exceeds file entry limit");
    for (const [id, file] of entries) {
      if (!id || Buffer.byteLength(id, "utf8") > 512) throw new RangeError("native scene file id exceeds limit");
      const bytes = Buffer.byteLength(JSON.stringify(file), "utf8");
      if (bytes > MAX_NATIVE_FILE_BYTES) throw new RangeError("native scene file exceeds local preservation limit");
    }
  }
}

function serializeScene(scene) {
  validateScene(scene);
  let json;
  try { json = JSON.stringify(scene); } catch { throw new TypeError("native scene must be JSON serializable"); }
  if (Buffer.byteLength(json, "utf8") > MAX_SCENE_BYTES) throw new RangeError("native scene exceeds 5MB local preservation limit");
  return json;
}

function parseScene(json) {
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_SCENE_BYTES) throw new RangeError("native scene exceeds 5MB local preservation limit");
  let scene;
  try { scene = JSON.parse(json); } catch { throw new TypeError("native scene is not valid JSON"); }
  validateScene(scene);
  return scene;
}

function migrationSql(version) {
  if (version === 1) return `
    CREATE TABLE drawings (
      id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      scene_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `;
  if (version === 2) return `
    CREATE TABLE workspace_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;
    INSERT INTO workspace_metadata(key, value) VALUES ('format', 'pi-excalidraw-workspace-v1');
  `;
  throw new RangeError("unknown workspace migration");
}

function migrate(database) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL) STRICT;");
  const current = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  if (current > SCHEMA_VERSION) throw workspaceError("workspace_schema_too_new", "workspace schema is newer than this local extension");
  if (current === SCHEMA_VERSION) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
      database.exec(migrationSql(version));
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* rollback only if transaction is still open */ }
    throw error;
  }
}

function assertHealthy(database) {
  const result = database.prepare("PRAGMA quick_check").get();
  if (!result || result.quick_check !== "ok") throw workspaceError("workspace_corrupt", "workspace SQLite integrity check failed; restore a local backup before retrying");
}

function rowToDocument(row) {
  if (!row) return null;
  return { id: row.id, revision: row.revision, scene: parseScene(row.scene_json), createdAt: row.created_at, updatedAt: row.updated_at };
}

export class ExcalidrawWorkspaceStore {
  constructor(paths, database) {
    this.paths = Object.freeze({ ...paths });
    this.database = database;
  }

  get(id) {
    assertId(id);
    return rowToDocument(this.database.prepare("SELECT id, revision, scene_json, created_at, updated_at FROM drawings WHERE id = ?").get(id));
  }

  #saveJson(id, sceneJson, expectedRevision) {
    assertId(id); assertExpectedRevision(expectedRevision);
    parseScene(sceneJson);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT revision FROM drawings WHERE id = ?").get(id);
      if (!existing) {
        if (expectedRevision !== 0) throw new WorkspaceConflictError(id, expectedRevision, null);
        this.database.prepare("INSERT INTO drawings(id, revision, scene_json, created_at, updated_at) VALUES (?, 1, ?, ?, ?)").run(id, sceneJson, now, now);
      } else {
        if (existing.revision !== expectedRevision) throw new WorkspaceConflictError(id, expectedRevision, existing.revision);
        this.database.prepare("UPDATE drawings SET revision = revision + 1, scene_json = ?, updated_at = ? WHERE id = ? AND revision = ?").run(sceneJson, now, id, expectedRevision);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
    return this.get(id);
  }

  save(id, scene, expectedRevision) { return this.#saveJson(id, serializeScene(scene), expectedRevision); }

  exportDrawing(id) {
    const drawing = this.get(id);
    if (!drawing) return null;
    return { type: "pi-excalidraw-workspace", version: 1, drawing };
  }

  importDrawing(envelope, expectedRevision = 0) {
    if (!envelope || typeof envelope !== "object" || envelope.type !== "pi-excalidraw-workspace" || envelope.version !== 1 || !envelope.drawing || typeof envelope.drawing !== "object") {
      throw new TypeError("import must be a pi-excalidraw-workspace v1 export");
    }
    // The export's historical revision is descriptive only; the caller supplies the concurrency precondition.
    return this.save(envelope.drawing.id, envelope.drawing.scene, expectedRevision);
  }

  importNativeFile(id, requestedPath, expectedRevision = 0) {
    const path = resolveProjectScenePath(this.paths.projectRoot, requestedPath, false);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw workspaceError("unsafe_project_path", "import source must be a regular non-symlink file");
    if (stat.size > MAX_SCENE_BYTES) throw new RangeError("native scene exceeds 5MB local preservation limit");
    return this.#saveJson(id, readFileSync(path, "utf8"), expectedRevision);
  }

  exportNativeFile(id, requestedPath) {
    const document = this.get(id);
    if (!document) return null;
    const path = resolveProjectScenePath(this.paths.projectRoot, requestedPath, true);
    const raw = this.database.prepare("SELECT scene_json FROM drawings WHERE id = ?").get(id).scene_json;
    writeAtomicLocalFile(path, `${raw}\n`);
    return { path, revision: document.revision };
  }

  close() { this.database.close(); }
}

/** Open the only database allowed for this store. No caller-supplied database path is accepted. */
export async function openExcalidrawWorkspace(projectRoot) {
  const paths = resolveWorkspacePaths(projectRoot);
  const { DatabaseSync } = await loadNodeSqlite();
  let database;
  try {
    database = new DatabaseSync(paths.databasePath);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    migrate(database);
    assertHealthy(database);
    return new ExcalidrawWorkspaceStore(paths, database);
  } catch (cause) {
    try { database?.close(); } catch { /* preserve original failure */ }
    if (["unsafe_workspace_path", "workspace_schema_too_new", "workspace_corrupt"].includes(cause?.code)) throw cause;
    throw workspaceError("workspace_open_failed", "could not open the project-local Excalidraw SQLite workspace");
  }
}

/** Resolve a project-relative .excalidraw file and reject traversal and symlink components. */
export function resolveProjectScenePath(projectRoot, requestedPath, allowMissing) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new TypeError("path must be a non-empty string");
  const clean = requestedPath.trim();
  if (isAbsolute(clean) || clean.includes("\\") || clean.split("/").includes("..") || !clean.endsWith(".excalidraw")) {
    throw workspaceError("unsafe_project_path", "path must be a project-relative .excalidraw path without traversal");
  }
  const root = realpathSync(resolve(projectRoot));
  const target = resolve(root, clean);
  if (!isInside(root, target)) throw workspaceError("unsafe_project_path", "path escapes project root");
  const parent = dirname(target);
  assertContainedProjectDirectory(root, root);
  let cursor = root;
  for (const part of relative(root, parent).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (existsSync(cursor)) {
      assertContainedProjectDirectory(root, cursor);
      continue;
    }
    if (!allowMissing) throw workspaceError("unsafe_project_path", "path must remain beneath non-symlink project directories");
    // Do not use recursive mkdir: it could traverse an unchecked symlinked ancestor.
    mkdirSync(cursor, { recursive: false, mode: 0o700 });
    assertContainedProjectDirectory(root, cursor);
  }
  if (!allowMissing && !existsSync(target)) throw workspaceError("project_file_not_found", "project-local Excalidraw file does not exist");
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || !isInside(root, realpathSync(target)))) {
    throw workspaceError("unsafe_project_path", "path must be a regular non-symlink project file");
  }
  return target;
}

function writeAtomicLocalFile(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  try {
    renameSync(temporary, path);
    // Best effort: Windows and some filesystems do not permit directory fsync.
    try { const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } } catch { /* documented best effort */ }
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* no recovery cleanup guarantee */ }
    throw error;
  }
}

function send(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(text);
}

async function readJson(request) {
  let total = 0; const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_HTTP_BODY_BYTES) throw workspaceError("request_too_large", "request body exceeds local limit");
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw workspaceError("invalid_request", "request body must be JSON"); }
  assertSafeValue(value);
  return value;
}

function drawingIdFromPath(pathname, suffix = "") {
  const expression = suffix ? new RegExp(`^/api/drawings/([^/]+)${suffix}$`) : /^\/api\/drawings\/([^/]+)$/;
  const match = pathname.match(expression);
  if (!match) return null;
  try { const id = decodeURIComponent(match[1]); assertId(id); return id; } catch { return null; }
}

/**
 * Start the intentionally small local service boundary. It binds IPv4 loopback
 * only, has no CORS policy, and serves no UI or Pi semantic operations.
 */
export async function startExcalidrawWorkspaceServer(store, { host = "127.0.0.1", port = 0 } = {}) {
  if (!(store instanceof ExcalidrawWorkspaceStore)) throw new TypeError("store must be an ExcalidrawWorkspaceStore");
  if (host !== "127.0.0.1") throw new RangeError("Excalidraw workspace server binds only to 127.0.0.1");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError("port must be an integer from 0 to 65535");
  const sockets = new Set();
  let expectedHost;
  const server = createServer(async (request, response) => {
    if (!expectedHost || request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== `http://${expectedHost}`)) {
      send(response, 403, { error: "loopback_only" }); return;
    }
    try {
      const url = new URL(request.url, `http://${expectedHost}`);
      if (url.search || url.hash) { send(response, 404, { error: "not_found" }); return; }
      if (request.method === "GET" && url.pathname === "/health") { send(response, 200, { status: "ok" }); return; }
      const exportId = drawingIdFromPath(url.pathname, "/export");
      if (request.method === "GET" && exportId) {
        const exported = store.exportDrawing(exportId); send(response, exported ? 200 : 404, exported ?? { error: "not_found" }); return;
      }
      const drawingId = drawingIdFromPath(url.pathname);
      if (request.method === "GET" && drawingId) { const drawing = store.get(drawingId); send(response, drawing ? 200 : 404, drawing ?? { error: "not_found" }); return; }
      if (request.method === "PUT" && drawingId) {
        const body = await readJson(request);
        const drawing = store.save(drawingId, body?.scene, body?.expectedRevision);
        send(response, drawing.revision === 1 ? 201 : 200, drawing); return;
      }
      if (request.method === "POST" && url.pathname === "/api/drawings/import") {
        const body = await readJson(request);
        const drawing = store.importDrawing(body?.export, body?.expectedRevision);
        send(response, drawing.revision === 1 ? 201 : 200, drawing); return;
      }
      send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof WorkspaceConflictError) { send(response, 409, { error: error.code, revision: error.actualRevision }); return; }
      if (error?.code === "project_file_not_found") { send(response, 404, { error: "not_found" }); return; }
      if (error?.code === "request_too_large") { send(response, 413, { error: error.code }); return; }
      if (error instanceof TypeError || error instanceof RangeError || error?.code === "invalid_request") { send(response, 400, { error: "invalid_request" }); return; }
      send(response, 500, { error: "workspace_error" });
    }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen({ host, port }, () => { server.off("error", rejectListen); resolveListen(); }); });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") { server.close(); throw workspaceError("loopback_bind_failed", "Excalidraw workspace server did not bind IPv4 loopback"); }
  expectedHost = `127.0.0.1:${address.port}`;
  return Object.freeze({ server, url: `http://${expectedHost}`, close() { for (const socket of sockets) socket.destroy(); server.close(); } });
}
