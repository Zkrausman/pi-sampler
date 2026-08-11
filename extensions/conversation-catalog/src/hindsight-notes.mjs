import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { relative, resolve, sep, win32 } from "node:path";

const SESSION_REFERENCE = /^session-[a-f0-9]{32}$/;
const NOTE_ID = /^note-[a-f0-9]{32}$/;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;
const localLocks = new Map();
const WINDOWS_REGISTRY_PREFIX = "HKCU\\Software\\Zkrausman\\PiConversationCatalog\\HindsightNotes\\v1";
const WINDOWS_REGISTRY_RESPONSE_LIMIT = 64 * 1024;
const WINDOWS_VALUE = /^n_[a-f0-9]{32}$/;

export class HindsightNotesError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const ownObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => ownObject(value) && Object.keys(value).every((key) => keys.includes(key));
const validTimestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const missing = (error) => error?.code === "ENOENT";

function boundedText(value, code = "malformed_notes") {
  if (typeof value !== "string") throw new HindsightNotesError(code);
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > 2000) throw new HindsightNotesError(code);
  return trimmed;
}

const UNSAFE_NOTE_TEXT = /\b(?:raw[- ]?session(?:[- ]?id)?|session[_-]?id|pi_session_file|bearer\s+|api[_-]?key|authorization\s*:|gh[pousr]_[A-Za-z0-9_]{20,}|(?:akia|asia|aida|aroa)[a-z0-9]{16}|(?:aws_)?(?:secret_access_key|access_key_id)\s*[:=]|(?:password|secret|token|credential)s?\s*(?:=|:)\s*\S+)\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

export function safeHindsightNoteText(value) {
  const note = boundedText(value);
  if (UNSAFE_NOTE_TEXT.test(note)) throw new HindsightNotesError("unsafe_note_text");
  return note;
}

/** Opaque stable key derived from Pi's actual session ID, never its display name. */
export function hindsightNotesSessionReference(sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.includes("\0") || Array.from(sessionId).length > 512) throw new HindsightNotesError("invalid_session_reference");
  return `session-${createHash("sha256").update("pi-hindsight-notes:v1\0").update(sessionId).digest("hex").slice(0, 32)}`;
}

function normalizeProvenance(value) {
  if (!exactKeys(value, ["source", "confirmation", "createdAt", "editedAt"]) || value.source !== "user-authored" || value.confirmation !== "user-confirmed"
    || !validTimestamp(value.createdAt) || (value.editedAt !== undefined && (!validTimestamp(value.editedAt) || Date.parse(value.editedAt) < Date.parse(value.createdAt)))) throw new HindsightNotesError("malformed_notes");
  return { source: "user-authored", confirmation: "user-confirmed", createdAt: value.createdAt, ...(value.editedAt === undefined ? {} : { editedAt: value.editedAt }) };
}
function normalizeNote(value) {
  if (!exactKeys(value, ["noteId", "text", "provenance"]) || typeof value.noteId !== "string" || !NOTE_ID.test(value.noteId)) throw new HindsightNotesError("malformed_notes");
  return { noteId: value.noteId, text: safeHindsightNoteText(value.text), provenance: normalizeProvenance(value.provenance) };
}
export function emptyHindsightNotes(sessionReference) {
  if (typeof sessionReference !== "string" || !SESSION_REFERENCE.test(sessionReference)) throw new HindsightNotesError("invalid_session_reference");
  return { schemaVersion: 1, kind: "pi-hindsight-session-notes", sessionReference, notes: [] };
}
export function parseHindsightNotes(value) {
  if (!exactKeys(value, ["schemaVersion", "kind", "sessionReference", "notes"])
    || value.schemaVersion !== 1 || value.kind !== "pi-hindsight-session-notes"
    || typeof value.sessionReference !== "string" || !SESSION_REFERENCE.test(value.sessionReference)
    || !Array.isArray(value.notes) || value.notes.length > 100) throw new HindsightNotesError("malformed_notes");
  const notes = value.notes.map(normalizeNote);
  if (new Set(notes.map((note) => note.noteId)).size !== notes.length) throw new HindsightNotesError("malformed_notes");
  return { schemaVersion: 1, kind: "pi-hindsight-session-notes", sessionReference: value.sessionReference, notes };
}

function windowsProjectDigest(canonicalRoot) {
  return createHash("sha256").update("pi-hindsight-notes-project:v1\0").update(canonicalRoot.toLowerCase()).digest("hex");
}
function windowsValueName(noteId) {
  return `n_${createHash("sha256").update("pi-hindsight-note:v1\0").update(noteId).digest("hex").slice(0, 32)}`;
}
function registryRecord(sessionReference, note) {
  return { schemaVersion: 1, kind: "pi-hindsight-session-note", sessionReference, note };
}
function parseRegistryRecord(value, sessionReference, expectedValueName) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8")); } catch { throw new HindsightNotesError("malformed_notes"); }
  if (!exactKeys(parsed, ["schemaVersion", "kind", "sessionReference", "note"])
    || parsed.schemaVersion !== 1 || parsed.kind !== "pi-hindsight-session-note" || parsed.sessionReference !== sessionReference) throw new HindsightNotesError("malformed_notes");
  const note = normalizeNote(parsed.note);
  if (windowsValueName(note.noteId) !== expectedValueName) throw new HindsightNotesError("malformed_notes");
  return note;
}

/** Runs only the fixed Windows Registry utility with fixed command verbs and generated hash-only names. */
async function directWindowsRegistry(args) {
  if (process.platform !== "win32") throw new HindsightNotesError("secure_storage_unavailable");
  const suppliedRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof suppliedRoot !== "string" || suppliedRoot.includes("\0") || !win32.isAbsolute(suppliedRoot)) throw new HindsightNotesError("registry_unavailable");
  const root = win32.resolve(suppliedRoot);
  const executable = win32.join(root, "System32", "reg.exe");
  if (!executable.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) throw new HindsightNotesError("registry_unavailable");
  try { const details = await lstat(executable); if (!details.isFile() || details.isSymbolicLink()) throw new HindsightNotesError("registry_unavailable"); }
  catch (error) { if (error instanceof HindsightNotesError) throw error; throw new HindsightNotesError("registry_unavailable"); }
  return new Promise((resolveResult, reject) => {
    let child;
    try { child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { reject(new HindsightNotesError("registry_unavailable")); return; }
    let stdout = ""; let stderr = ""; let oversized = false;
    const collect = (target) => (chunk) => {
      if (oversized) return;
      target.value += chunk.toString("utf8");
      if (Buffer.byteLength(target.value, "utf8") > WINDOWS_REGISTRY_RESPONSE_LIMIT) { oversized = true; child.kill(); }
    };
    const out = { value: stdout }; const err = { value: stderr };
    child.stdout.on("data", collect(out)); child.stderr.on("data", collect(err));
    child.on("error", () => reject(new HindsightNotesError("registry_unavailable")));
    child.on("close", (code) => oversized ? reject(new HindsightNotesError("registry_response_invalid")) : resolveResult({ code, stdout: out.value, stderr: err.value }));
  });
}

/**
 * Windows backend: individual note records are atomic REG_SZ values. It never
 * receives a registry path; root/session/note value names are fixed SHA-256
 * digests and every `reg.exe` invocation is direct (no shell or evaluator).
 */
function createWindowsRegistryBackendLegacy({ runRegistry = directWindowsRegistry } = {}) {
  const keyFor = async (projectRoot, sessionReference) => {
    emptyHindsightNotes(sessionReference);
    if (typeof projectRoot !== "string" || !projectRoot || projectRoot.includes("\0")) throw new HindsightNotesError("invalid_notes_path");
    let canonical;
    try { canonical = await realpath(projectRoot); } catch { throw new HindsightNotesError("invalid_notes_path"); }
    return `${WINDOWS_REGISTRY_PREFIX}\\${windowsProjectDigest(canonical)}\\${sessionReference}`;
  };
  const invoke = async (args) => {
    const result = await runRegistry(args);
    if (!result || !Number.isInteger(result.code) || typeof result.stdout !== "string" || typeof result.stderr !== "string"
      || Buffer.byteLength(result.stdout, "utf8") > WINDOWS_REGISTRY_RESPONSE_LIMIT || Buffer.byteLength(result.stderr, "utf8") > WINDOWS_REGISTRY_RESPONSE_LIMIT) throw new HindsightNotesError("registry_response_invalid");
    return result;
  };
  // `reg query` exit status 1 is the utility's missing-value contract. Never parse localized response text; other statuses fail closed.
  const absent = (result) => result.code === 1;
  const list = async (projectRoot, sessionReference) => {
    const key = await keyFor(projectRoot, sessionReference);
    const result = await invoke(["query", key]);
    if (absent(result)) return undefined;
    if (result.code !== 0 || result.stderr.trim()) throw new HindsightNotesError("registry_query_failed");
    const lines = result.stdout.replace(/\r/g, "").split("\n").filter(Boolean);
    const canonicalHeader = `HKEY_CURRENT_USER${key.slice("HKCU".length)}`;
    if (lines.length < 1 || lines[0].trim().toLowerCase() !== canonicalHeader.toLowerCase()) throw new HindsightNotesError("registry_response_invalid");
    const notes = [];
    for (const line of lines.slice(1)) {
      const match = /^\s*(n_[a-f0-9]{32})\s+REG_SZ\s+([A-Za-z0-9+/=]+)\s*$/.exec(line);
      if (!match) throw new HindsightNotesError("registry_response_invalid");
      notes.push(parseRegistryRecord(match[2], sessionReference, match[1]));
    }
    if (new Set(notes.map((note) => note.noteId)).size !== notes.length || notes.length > 100) throw new HindsightNotesError("malformed_notes");
    return { schemaVersion: 1, kind: "pi-hindsight-session-notes", sessionReference, notes: notes.sort((left, right) => left.noteId.localeCompare(right.noteId)) };
  };
  const readValue = async (key, valueName) => {
    const result = await invoke(["query", key, "/v", valueName]);
    if (absent(result)) return undefined;
    if (result.code !== 0 || result.stderr.trim()) throw new HindsightNotesError("registry_query_failed");
    const lines = result.stdout.replace(/\r/g, "").split("\n").filter(Boolean);
    const matching = lines.filter((line) => new RegExp(`^\\s*${valueName}\\s+REG_SZ\\s+([A-Za-z0-9+/=]+)\\s*$`).test(line));
    if (matching.length !== 1) throw new HindsightNotesError("registry_response_invalid");
    return /^\s*\S+\s+REG_SZ\s+([A-Za-z0-9+/=]+)\s*$/.exec(matching[0])?.[1] || undefined;
  };
  const put = async (projectRoot, sessionReference, note) => {
    const key = await keyFor(projectRoot, sessionReference); const valueName = windowsValueName(note.noteId);
    const encoded = Buffer.from(JSON.stringify(registryRecord(sessionReference, note)), "utf8").toString("base64");
    if (encoded.length > 12_000) throw new HindsightNotesError("malformed_notes");
    const result = await invoke(["add", key, "/v", valueName, "/t", "REG_SZ", "/d", encoded, "/f"]);
    if (result.code !== 0 || result.stderr.trim()) throw new HindsightNotesError("registry_write_failed");
    // Bounded read-after-write detects a same-note concurrent overwrite without
    // ever serializing or replacing unrelated note values.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await readValue(key, valueName)) === encoded) return;
      if (attempt === 2) throw new HindsightNotesError("notes_conflict");
      await delay(5 * (attempt + 1));
      const retry = await invoke(["add", key, "/v", valueName, "/t", "REG_SZ", "/d", encoded, "/f"]);
      if (retry.code !== 0 || retry.stderr.trim()) throw new HindsightNotesError("registry_write_failed");
    }
  };
  const remove = async (projectRoot, sessionReference, noteId) => {
    const key = await keyFor(projectRoot, sessionReference); const valueName = windowsValueName(noteId);
    const result = await invoke(["delete", key, "/v", valueName, "/f"]);
    if (absent(result)) throw new HindsightNotesError("note_missing");
    if (result.code !== 0 || result.stderr.trim()) throw new HindsightNotesError("registry_write_failed");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await readValue(key, valueName)) === undefined) return;
      if (attempt === 2) throw new HindsightNotesError("notes_conflict");
      await delay(5 * (attempt + 1));
    }
  };
  return { list, put, remove };
}

const noteDigest = (note) => createHash("sha256").update(JSON.stringify(note)).digest("hex");
const INDEX_VALUE = "__pi_hindsight_notes_index_v1";
const INDEX_KIND = "pi-hindsight-session-note-index";
const NOTE_KIND = "pi-hindsight-session-note";
const indexValueName = (noteId) => `n_${createHash("sha256").update(`pi-hindsight-note:v1\0${noteId}`).digest("hex").slice(0, 32)}`;
const encodeRegistry = (value, limit = 12_000) => { const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64"); if (encoded.length > limit) throw new HindsightNotesError("malformed_notes"); return encoded; };

async function namedPipeMutex(name, operation, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  if (process.platform !== "win32") throw new HindsightNotesError("secure_storage_unavailable");
  const deadline = Date.now() + timeoutMs; let wait = 5;
  while (true) {
    const server = createServer();
    try {
      await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(name, () => { server.off("error", reject); resolveListen(); }); });
      try { return await operation(); } finally { await new Promise((done) => server.close(done)); }
    } catch (error) {
      server.close(); if (error?.code !== "EADDRINUSE") throw new HindsightNotesError("registry_mutex_failed");
      if (Date.now() >= deadline) throw new HindsightNotesError("notes_lock_timeout"); await delay(wait); wait = Math.min(wait * 2, 100);
    }
  }
}

/** Bounded-index Windows backend; it never performs a whole-key Registry query. */
export function createWindowsRegistryBackend({ runRegistry = directWindowsRegistry, withMutex = namedPipeMutex } = {}) {
  const scope = async (projectRoot, sessionReference) => {
    emptyHindsightNotes(sessionReference); let root;
    try { root = await realpath(projectRoot); } catch { throw new HindsightNotesError("invalid_notes_path"); }
    const project = windowsProjectDigest(root);
    return { key: `${WINDOWS_REGISTRY_PREFIX}\\${project}\\${sessionReference}`, mutex: `\\\\.\\pipe\\pi-hindsight-notes-${createHash("sha256").update(`${project}\0${sessionReference}`).digest("hex")}` };
  };
  const invoke = async (args) => {
    const result = await runRegistry(args);
    if (!result || !Number.isInteger(result.code) || typeof result.stdout !== "string" || typeof result.stderr !== "string" || Buffer.byteLength(result.stdout) > WINDOWS_REGISTRY_RESPONSE_LIMIT || Buffer.byteLength(result.stderr) > WINDOWS_REGISTRY_RESPONSE_LIMIT) throw new HindsightNotesError("registry_response_invalid");
    return result;
  };
  const query = async (key, name) => {
    const result = await invoke(["query", key, "/v", name]);
    if (result.code === 1) return undefined;
    if (result.code !== 0 || result.stderr.trim()) throw new HindsightNotesError("registry_query_failed");
    const match = result.stdout.replace(/\r/g, "").split("\n").map((line) => new RegExp(`^\\s*${name}\\s+REG_SZ\\s+([A-Za-z0-9+/=]+)\\s*$`).exec(line)).find(Boolean);
    if (!match) throw new HindsightNotesError("registry_response_invalid"); return match[1];
  };
  const write = async (key, name, encoded) => {
    const result = await invoke(["add", key, "/v", name, "/t", "REG_SZ", "/d", encoded, "/f"]);
    if (result.code !== 0 || result.stderr.trim() || (await query(key, name)) !== encoded) throw new HindsightNotesError("registry_write_failed");
  };
  const parseIndex = (encoded, ref) => {
    let value; try { value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); } catch { throw new HindsightNotesError("malformed_notes"); }
    if (!exactKeys(value, ["schemaVersion", "kind", "sessionReference", "revision", "entries"]) || value.schemaVersion !== 1 || value.kind !== INDEX_KIND || value.sessionReference !== ref || !Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries) || value.entries.length > 100) throw new HindsightNotesError("malformed_notes");
    const entries = value.entries.map((entry) => { if (!exactKeys(entry, ["noteId", "valueName", "version"]) || typeof entry.noteId !== "string" || !NOTE_ID.test(entry.noteId) || entry.valueName !== indexValueName(entry.noteId) || !Number.isInteger(entry.version) || entry.version < 1) throw new HindsightNotesError("malformed_notes"); return entry; });
    if (new Set(entries.map((entry) => entry.noteId)).size !== entries.length) throw new HindsightNotesError("malformed_notes"); return { ...value, entries };
  };
  const getIndex = async (key, ref) => { const encoded = await query(key, INDEX_VALUE); return encoded === undefined ? undefined : parseIndex(encoded, ref); };
  const list = async (root, ref) => {
    const { key } = await scope(root, ref); const index = await getIndex(key, ref); if (!index) return undefined;
    const notes = [];
    for (const entry of index.entries) {
      const encoded = await query(key, entry.valueName); if (!encoded) throw new HindsightNotesError("malformed_notes");
      let record; try { record = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); } catch { throw new HindsightNotesError("malformed_notes"); }
      if (!exactKeys(record, ["schemaVersion", "kind", "sessionReference", "version", "note"]) || record.schemaVersion !== 1 || record.kind !== NOTE_KIND || record.sessionReference !== ref || record.version !== entry.version) throw new HindsightNotesError("malformed_notes");
      const note = normalizeNote(record.note); if (note.noteId !== entry.noteId) throw new HindsightNotesError("malformed_notes"); notes.push(note);
    }
    return { schemaVersion: 1, kind: "pi-hindsight-session-notes", sessionReference: ref, notes };
  };
  const put = async (root, ref, note) => {
    const normalized = normalizeNote(note); const target = await scope(root, ref);
    return withMutex(target.mutex, async () => {
      const current = await getIndex(target.key, ref) || { schemaVersion: 1, kind: INDEX_KIND, sessionReference: ref, revision: 0, entries: [] };
      const old = current.entries.find((entry) => entry.noteId === normalized.noteId); if (!old && current.entries.length >= 100) throw new HindsightNotesError("notes_limit_reached");
      const entry = old ? { ...old, version: old.version + 1 } : { noteId: normalized.noteId, valueName: indexValueName(normalized.noteId), version: 1 };
      await write(target.key, entry.valueName, encodeRegistry({ schemaVersion: 1, kind: NOTE_KIND, sessionReference: ref, version: entry.version, note: normalized }));
      const entries = old ? current.entries.map((item) => item.noteId === entry.noteId ? entry : item) : [...current.entries, entry];
      await write(target.key, INDEX_VALUE, encodeRegistry({ ...current, revision: current.revision + 1, entries }, 24_000));
    });
  };
  const readEntry = async (key, ref, entry) => {
    const encoded = await query(key, entry.valueName); if (!encoded) throw new HindsightNotesError("malformed_notes");
    let record; try { record = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); } catch { throw new HindsightNotesError("malformed_notes"); }
    if (!exactKeys(record, ["schemaVersion", "kind", "sessionReference", "version", "note"]) || record.schemaVersion !== 1 || record.kind !== NOTE_KIND || record.sessionReference !== ref || record.version !== entry.version) throw new HindsightNotesError("malformed_notes");
    return normalizeNote(record.note);
  };
  const edit = async (root, ref, noteId, text, expectedDigest, editedAt = new Date().toISOString()) => {
    const target = await scope(root, ref); return withMutex(target.mutex, async () => {
      const current = await getIndex(target.key, ref); const old = current?.entries.find((item) => item.noteId === noteId); if (!old) throw new HindsightNotesError("note_missing");
      const prior = await readEntry(target.key, ref, old); if (expectedDigest && noteDigest(prior) !== expectedDigest) throw new HindsightNotesError("notes_conflict");
      if (!validTimestamp(editedAt) || Date.parse(editedAt) < Date.parse(prior.provenance.createdAt)) throw new HindsightNotesError("malformed_notes");
      const next = { ...prior, text: safeHindsightNoteText(text), provenance: { ...prior.provenance, editedAt } }; const entry = { ...old, version: old.version + 1 };
      await write(target.key, entry.valueName, encodeRegistry({ schemaVersion: 1, kind: NOTE_KIND, sessionReference: ref, version: entry.version, note: next }));
      await write(target.key, INDEX_VALUE, encodeRegistry({ ...current, revision: current.revision + 1, entries: current.entries.map((item) => item.noteId === noteId ? entry : item) })); return next;
    });
  };
  const remove = async (root, ref, noteId, expectedDigest) => {
    const target = await scope(root, ref); return withMutex(target.mutex, async () => {
      const current = await getIndex(target.key, ref); const entry = current?.entries.find((item) => item.noteId === noteId); if (!entry) throw new HindsightNotesError("note_missing");
      const prior = await readEntry(target.key, ref, entry); if (expectedDigest && noteDigest(prior) !== expectedDigest) throw new HindsightNotesError("notes_conflict");
      await write(target.key, INDEX_VALUE, encodeRegistry({ ...current, revision: current.revision + 1, entries: current.entries.filter((item) => item.noteId !== noteId) }, 24_000));
      const result = await invoke(["delete", target.key, "/v", entry.valueName, "/f"]); if (result.code !== 0 && result.code !== 1) throw new HindsightNotesError("registry_write_failed");
    });
  };
  return { list, put, edit, remove };
}

const windowsRegistry = createWindowsRegistryBackend();

// Node has no openat API. On Linux, /proc/self/fd/<directory-fd>/name is the
// kernel's descriptor-relative lookup and does not re-resolve swapped parents.
// Windows/other platforms expose neither an equivalent no-follow directory API
// nor descriptor-relative rename; fail closed rather than offering a TOCTOU-prone store.
const SECURE_DIRECTORY_FDS = process.platform === "linux" && Number.isInteger(constants.O_NOFOLLOW) && Number.isInteger(constants.O_DIRECTORY);
function requireSecureDirectoryFds() {
  if (!SECURE_DIRECTORY_FDS) throw new HindsightNotesError("secure_storage_unavailable");
}
function fdPath(handle, name = "") { return `/proc/self/fd/${handle.fd}${name ? `/${name}` : ""}`; }
function contained(root, candidate) {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`);
}
async function closeAll(handles) { await Promise.all(handles.filter(Boolean).reverse().map((handle) => handle.close().catch(() => undefined))); }

async function openDirectoryAt(parent, name, create) {
  const path = fdPath(parent, name);
  try { return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) {
    if (!create && missing(error)) return undefined;
    if (!create || !missing(error)) throw new HindsightNotesError("unsafe_notes_path");
    try { await mkdir(path); } catch (mkdirError) { if (mkdirError?.code !== "EEXIST") throw new HindsightNotesError("unsafe_notes_path"); }
    try { return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch { throw new HindsightNotesError("unsafe_notes_path"); }
  }
}

/** Opens root/.pi/hindsight-notes through pinned no-follow directory descriptors. */
async function openStoreDirectory(projectRoot, sessionReference, create) {
  requireSecureDirectoryFds();
  emptyHindsightNotes(sessionReference);
  if (typeof projectRoot !== "string" || !projectRoot || projectRoot.includes("\0")) throw new HindsightNotesError("invalid_notes_path");
  let canonicalRoot;
  try { canonicalRoot = await realpath(projectRoot); } catch { throw new HindsightNotesError("invalid_notes_path"); }
  const lexicalRoot = resolve(canonicalRoot);
  const lexicalNotes = resolve(lexicalRoot, ".pi", "hindsight-notes");
  if (!contained(lexicalRoot, lexicalNotes)) throw new HindsightNotesError("invalid_notes_path");
  let root;
  let pi;
  try {
    root = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    pi = await openDirectoryAt(root, ".pi", create);
    if (!pi) return { root, pi: undefined, notes: undefined, fileName: `${sessionReference}.json` };
    const notes = await openDirectoryAt(pi, "hindsight-notes", create);
    return { root, pi, notes, fileName: `${sessionReference}.json` };
  } catch (error) {
    await closeAll([pi, root]);
    if (error instanceof HindsightNotesError) throw error;
    throw new HindsightNotesError("unsafe_notes_path");
  }
}

/** Display-only; persistence never accepts this path from a caller. */
export function hindsightNotesPath(projectRoot, sessionReference) {
  if (typeof projectRoot !== "string" || !projectRoot || projectRoot.includes("\0")) throw new HindsightNotesError("invalid_notes_path");
  emptyHindsightNotes(sessionReference);
  const root = resolve(projectRoot);
  const path = resolve(root, ".pi", "hindsight-notes", `${sessionReference}.json`);
  if (!contained(root, path)) throw new HindsightNotesError("invalid_notes_path");
  return path;
}

async function openRegularAt(directory, name, flags) {
  try {
    const handle = await open(fdPath(directory, name), flags | constants.O_NOFOLLOW);
    const details = await handle.stat();
    if (!details.isFile()) { await handle.close(); throw new HindsightNotesError("unsafe_notes_path"); }
    return handle;
  } catch (error) {
    if (error instanceof HindsightNotesError || missing(error)) throw error;
    throw new HindsightNotesError("unsafe_notes_path");
  }
}

async function readStoreAt(store) {
  if (!store.notes) return undefined;
  let handle;
  try {
    handle = await openRegularAt(store.notes, store.fileName, constants.O_RDONLY);
    const parsed = parseHindsightNotes(JSON.parse(await handle.readFile("utf8")));
    if (parsed.sessionReference !== store.fileName.slice(0, -5)) throw new HindsightNotesError("session_mismatch");
    return parsed;
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof HindsightNotesError) throw error;
    throw new HindsightNotesError("malformed_notes");
  } finally { await handle?.close().catch(() => undefined); }
}

export async function readHindsightNotes(projectRoot, sessionReference) {
  if (process.platform === "win32") return windowsRegistry.list(projectRoot, sessionReference);
  const store = await openStoreDirectory(projectRoot, sessionReference, false);
  try { return await readStoreAt(store); }
  finally { await closeAll([store.notes, store.pi, store.root]); }
}

const ownerName = "owner.json";
function lockName(fileName) { return `${fileName}.lock`; }
function ownerRecord(value) {
  return ownObject(value) && value.schemaVersion === 1 && typeof value.token === "string" && /^[a-f0-9-]{36}$/.test(value.token)
    && Number.isInteger(value.pid) && value.pid > 0 && validTimestamp(value.createdAt) ? value : undefined;
}
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; } }
async function readOwner(lock) {
  let handle;
  try { handle = await openRegularAt(lock, ownerName, constants.O_RDONLY); return ownerRecord(JSON.parse(await handle.readFile("utf8"))); }
  catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}
async function staleLock(lock, { now, staleMs, alive }) {
  const owner = await readOwner(lock);
  if (owner) return now() - Date.parse(owner.createdAt) >= staleMs && alive(owner.pid) !== true;
  try { return now() - (await lock.stat()).mtimeMs >= staleMs; } catch { return false; }
}
async function writeOwner(lock, owner) {
  let handle;
  try {
    handle = await openRegularAt(lock, ownerName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } catch (error) { throw error instanceof HindsightNotesError ? error : new HindsightNotesError("unsafe_notes_path"); }
  finally { await handle?.close().catch(() => undefined); }
}
async function safeRemoveLock(notes, name, token = undefined) {
  let lock;
  try { lock = await openDirectoryAt(notes, name, false); }
  catch { return; }
  try {
    if (token) { const owner = await readOwner(lock); if (owner?.token !== token) return; }
    await unlink(fdPath(lock, ownerName)).catch(() => undefined);
  } finally { await lock.close().catch(() => undefined); }
  // rmdir through the pinned notes descriptor never follows a swapped parent.
  await rmdir(fdPath(notes, name)).catch(() => undefined);
}

/** Process-safe session-derived lock. Stale locks are renamed, never recursively deleted. */
export async function acquireCrossProcessHindsightNotesLock(projectRoot, sessionReference, {
  delayImpl = delay, now = () => Date.now(), processAliveImpl = processAlive, randomUUIDImpl = randomUUID,
  timeoutMs = LOCK_TIMEOUT_MS, staleMs = STALE_LOCK_MS,
} = {}) {
  const store = await openStoreDirectory(projectRoot, sessionReference, true);
  const name = lockName(store.fileName);
  const deadline = now() + timeoutMs;
  let wait = 5;
  try {
    while (true) {
      const token = randomUUIDImpl();
      try {
        await mkdir(fdPath(store.notes, name));
        const lock = await openDirectoryAt(store.notes, name, false);
        try { await writeOwner(lock, { schemaVersion: 1, token, pid: process.pid, createdAt: new Date(now()).toISOString() }); }
        finally { await lock.close().catch(() => undefined); }
        return { store, name, token };
      } catch (error) {
        if (error instanceof HindsightNotesError) throw error;
        if (error?.code !== "EEXIST") throw new HindsightNotesError("unsafe_notes_path");
        let existing;
        try { existing = await openDirectoryAt(store.notes, name, false); }
        catch { throw new HindsightNotesError("unsafe_notes_path"); }
        const stale = await staleLock(existing, { now, staleMs, alive: processAliveImpl });
        await existing.close().catch(() => undefined);
        if (stale) {
          // Both names resolve from the same pinned notes fd; a symlink swap is
          // renamed as a link, never followed. Quarantine cleanup is intentionally omitted.
          try { await rename(fdPath(store.notes, name), fdPath(store.notes, `${name}.stale-${randomUUIDImpl()}`)); continue; } catch { /* another contender changed it */ }
        }
        if (now() >= deadline) throw new HindsightNotesError("notes_lock_timeout");
        await delayImpl(wait); wait = Math.min(wait * 2, 100);
      }
    }
  } catch (error) {
    await closeAll([store.notes, store.pi, store.root]);
    throw error;
  }
}

async function releaseLock(lock) {
  try { await safeRemoveLock(lock.store.notes, lock.name, lock.token); }
  finally { await closeAll([lock.store.notes, lock.store.pi, lock.store.root]); }
}

async function withNotesLock(projectRoot, sessionReference, operation) {
  const key = `${resolve(projectRoot)}\0${sessionReference}`;
  const previous = localLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((done) => { release = done; });
  localLocks.set(key, current);
  await previous;
  let lock;
  try { lock = await acquireCrossProcessHindsightNotesLock(projectRoot, sessionReference); return await operation(lock.store); }
  finally {
    if (lock) await releaseLock(lock);
    release();
    if (localLocks.get(key) === current) localLocks.delete(key);
  }
}

async function atomicWriteAt(store, value) {
  const temporary = `.${store.fileName}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await openRegularAt(store.notes, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) { throw error instanceof HindsightNotesError ? error : new HindsightNotesError("unsafe_notes_path"); }
  finally { await handle?.close().catch(() => undefined); }
  // rename replaces a leaf symlink rather than following it; both parents are pinned.
  try { await rename(fdPath(store.notes, temporary), fdPath(store.notes, store.fileName)); }
  catch (error) { await unlink(fdPath(store.notes, temporary)).catch(() => undefined); throw new HindsightNotesError("unsafe_notes_path"); }
}

function newNote(text, timestamp) {
  if (!validTimestamp(timestamp)) throw new HindsightNotesError("malformed_notes");
  return { noteId: `note-${randomUUID().replace(/-/g, "")}`, text: safeHindsightNoteText(text), provenance: { source: "user-authored", confirmation: "user-confirmed", createdAt: timestamp } };
}

export async function addHindsightNote(projectRoot, sessionReference, text, { now = () => new Date().toISOString() } = {}) {
  if (process.platform === "win32") {
    const current = await windowsRegistry.list(projectRoot, sessionReference);
    if ((current?.notes.length || 0) >= 100) throw new HindsightNotesError("notes_limit_reached");
    // UUID note identities make independent concurrent adds distinct registry values.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const note = newNote(text, now());
      try { await windowsRegistry.put(projectRoot, sessionReference, note); return note; }
      catch (error) { if (!(error instanceof HindsightNotesError) || error.code !== "notes_conflict" || attempt === 2) throw error; }
    }
  }
  return withNotesLock(projectRoot, sessionReference, async (store) => {
    const prior = await readStoreAt(store);
    const current = prior || emptyHindsightNotes(sessionReference);
    if (current.notes.length >= 100) throw new HindsightNotesError("notes_limit_reached");
    const note = newNote(text, now());
    await atomicWriteAt(store, { ...current, notes: [...current.notes, note] });
    return note;
  });
}
export async function editHindsightNote(projectRoot, sessionReference, noteId, text, { now = () => new Date().toISOString() } = {}) {
  if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) throw new HindsightNotesError("invalid_note_id");
  if (process.platform === "win32") {
    const current = await windowsRegistry.list(projectRoot, sessionReference);
    const prior = current?.notes.find((note) => note.noteId === noteId);
    if (!prior) throw new HindsightNotesError("note_missing");
    return windowsRegistry.edit(projectRoot, sessionReference, noteId, text, noteDigest(prior), now());
  }
  return withNotesLock(projectRoot, sessionReference, async (store) => {
    const current = await readStoreAt(store);
    if (!current) throw new HindsightNotesError("notes_missing");
    const index = current.notes.findIndex((note) => note.noteId === noteId);
    if (index < 0) throw new HindsightNotesError("note_missing");
    const prior = current.notes[index]; const editedAt = now();
    if (!validTimestamp(editedAt) || Date.parse(editedAt) < Date.parse(prior.provenance.createdAt)) throw new HindsightNotesError("malformed_notes");
    const note = { ...prior, text: safeHindsightNoteText(text), provenance: { ...prior.provenance, editedAt } };
    const notes = [...current.notes]; notes[index] = note;
    await atomicWriteAt(store, { ...current, notes });
    return note;
  });
}
export async function deleteHindsightNote(projectRoot, sessionReference, noteId) {
  if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) throw new HindsightNotesError("invalid_note_id");
  if (process.platform === "win32") {
    const current = await windowsRegistry.list(projectRoot, sessionReference);
    if (!current?.notes.some((note) => note.noteId === noteId)) throw new HindsightNotesError("note_missing");
    await windowsRegistry.remove(projectRoot, sessionReference, noteId, noteDigest(current.notes.find((note) => note.noteId === noteId)));
    return;
  }
  return withNotesLock(projectRoot, sessionReference, async (store) => {
    const current = await readStoreAt(store);
    if (!current) throw new HindsightNotesError("notes_missing");
    if (!current.notes.some((note) => note.noteId === noteId)) throw new HindsightNotesError("note_missing");
    await atomicWriteAt(store, { ...current, notes: current.notes.filter((note) => note.noteId !== noteId) });
  });
}
