import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const SESSION_REFERENCE = /^session-[a-f0-9]{32}$/;
const NOTE_ID = /^note-[a-f0-9]{32}$/;
const EVENT_REFERENCE = /^event-[a-f0-9]{32}$/;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;
const localLocks = new Map();
const WINDOWS_REGISTRY_PREFIX = "HKCU\\Software\\Zkrausman\\PiConversationCatalog\\HindsightNotes\\v1";
const WINDOWS_REGISTRY_EXECUTABLE = "C:\\Windows\\System32\\reg.exe";
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

const UNSAFE_NOTE_TEXT = /\b(?:raw[- ]?session(?:[- ]?id)?|session[_-]?id|pi_session_file|bearer\s+|api[_-]?key|authorization\s*:|gh[pousr]_[A-Za-z0-9_]{20,}|(?:akia|asia|aida|aroa)[a-z0-9]{16}|(?:aws_)?(?:secret_access_key|access_key_id)\s*[:=]|(?:password|secret|token|credential)s?\s*(?:=|:)\s*\S+)\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[A-Za-z]:[\\/]\S*|\\\\[^\s]+|(?:^|\s)\/(?:[A-Za-z0-9._-]+\/)+\S*|\\[^\s]+/i;

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
export function hindsightNotesEventReference(sessionId, eventIdentity) {
  if (typeof sessionId !== "string" || !sessionId || typeof eventIdentity !== "string" || !eventIdentity || eventIdentity.includes("\0")) throw new HindsightNotesError("invalid_event_reference");
  return `event-${createHash("sha256").update("pi-hindsight-event-notes:v1\0").update(sessionId).update("\0").update(eventIdentity).digest("hex").slice(0, 32)}`;
}
function normalizeEventReference(value) { if (typeof value !== "string" || !EVENT_REFERENCE.test(value)) throw new HindsightNotesError("invalid_event_reference"); return value; }
function normalizeEventLabel(value) { return boundedText(value, "malformed_notes").slice(0, 240); }
function normalizeNote(value) {
  if (!exactKeys(value, ["noteId", "eventReference", "eventLabel", "text", "provenance"]) || typeof value.noteId !== "string" || !NOTE_ID.test(value.noteId)) throw new HindsightNotesError("malformed_notes");
  return { noteId: value.noteId, eventReference: normalizeEventReference(value.eventReference), eventLabel: normalizeEventLabel(value.eventLabel), text: safeHindsightNoteText(value.text), provenance: normalizeProvenance(value.provenance) };
}
function normalizeLegacyNote(value) {
  if (!exactKeys(value, ["noteId", "text", "provenance"]) || typeof value.noteId !== "string" || !NOTE_ID.test(value.noteId)) throw new HindsightNotesError("malformed_notes");
  return { noteId: value.noteId, text: safeHindsightNoteText(value.text), provenance: normalizeProvenance(value.provenance) };
}
export function emptyHindsightNotes(sessionReference) {
  if (typeof sessionReference !== "string" || !SESSION_REFERENCE.test(sessionReference)) throw new HindsightNotesError("invalid_session_reference");
  return { schemaVersion: 2, kind: "pi-hindsight-event-notes", sessionReference, notes: [], legacyNotes: [] };
}
export function parseHindsightNotes(value) {
  if (ownObject(value) && value.schemaVersion === 1 && value.kind === "pi-hindsight-session-notes") {
    if (typeof value.sessionReference !== "string" || !SESSION_REFERENCE.test(value.sessionReference) || !Array.isArray(value.notes) || value.notes.length > 100) throw new HindsightNotesError("malformed_notes");
    const legacyNotes = value.notes.map(normalizeLegacyNote);
    if (new Set(legacyNotes.map((note) => note.noteId)).size !== legacyNotes.length) throw new HindsightNotesError("malformed_notes");
    return { schemaVersion: 2, kind: "pi-hindsight-event-notes", sessionReference: value.sessionReference, notes: [], legacyNotes };
  }
  if (!exactKeys(value, ["schemaVersion", "kind", "sessionReference", "notes", "legacyNotes"])
    || value.schemaVersion !== 2 || value.kind !== "pi-hindsight-event-notes"
    || typeof value.sessionReference !== "string" || !SESSION_REFERENCE.test(value.sessionReference)
    || !Array.isArray(value.notes) || !Array.isArray(value.legacyNotes) || value.notes.length + value.legacyNotes.length > 100) throw new HindsightNotesError("malformed_notes");
  const notes = value.notes.map(normalizeNote); const legacyNotes = value.legacyNotes.map(normalizeLegacyNote);
  if (new Set([...notes, ...legacyNotes].map((note) => note.noteId)).size !== notes.length + legacyNotes.length) throw new HindsightNotesError("malformed_notes");
  return { schemaVersion: 2, kind: "pi-hindsight-event-notes", sessionReference: value.sessionReference, notes, legacyNotes };
}

function windowsProjectDigest(canonicalRoot) {
  return createHash("sha256").update("pi-hindsight-notes-project:v1\0").update(canonicalRoot.toLowerCase()).digest("hex");
}
function windowsValueName(noteId) {
  return `n_${createHash("sha256").update("pi-hindsight-note:v1\0").update(noteId).digest("hex").slice(0, 32)}`;
}
function registryRecord(sessionReference, note) {
  return { schemaVersion: 2, kind: "pi-hindsight-event-note", sessionReference, note };
}
function parseRegistryRecord(value, sessionReference, expectedValueName) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8")); } catch { throw new HindsightNotesError("malformed_notes"); }
  if (!exactKeys(parsed, ["schemaVersion", "kind", "sessionReference", "note"]) || parsed.sessionReference !== sessionReference) throw new HindsightNotesError("malformed_notes");
  const legacy = parsed.schemaVersion === 1 && parsed.kind === "pi-hindsight-session-note";
  if (!legacy && (parsed.schemaVersion !== 2 || parsed.kind !== "pi-hindsight-event-note")) throw new HindsightNotesError("malformed_notes");
  const note = legacy ? normalizeLegacyNote(parsed.note) : normalizeNote(parsed.note);
  if (windowsValueName(note.noteId) !== expectedValueName) throw new HindsightNotesError("malformed_notes");
  return legacy ? { ...note, legacy: true } : note;
}

/** Runs only the fixed Windows Registry utility with fixed command verbs and generated hash-only names. */
async function directWindowsRegistry(args) {
  if (process.platform !== "win32") throw new HindsightNotesError("secure_storage_unavailable");
  return new Promise((resolveResult, reject) => {
    let child;
    try { child = spawn(WINDOWS_REGISTRY_EXECUTABLE, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
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
export function createWindowsRegistryBackend({ runRegistry = directWindowsRegistry } = {}) {
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
  const absent = (result) => result.code === 1 && /unable to find|cannot find/i.test(`${result.stdout}\n${result.stderr}`);
  const list = async (projectRoot, sessionReference) => {
    const key = await keyFor(projectRoot, sessionReference);
    const result = await invoke(["query", key]);
    if (absent(result)) return undefined;
    if (result.code !== 0 || result.stderr.trim()) throw new HindsightNotesError("registry_query_failed");
    const lines = result.stdout.replace(/\r/g, "").split("\n").filter(Boolean);
    // reg.exe reports an existing key with no values as a successful blank response.
    // Treat it as an empty note store so a prior empty registry key cannot block adds.
    if (lines.length === 0) return emptyHindsightNotes(sessionReference);
    const canonicalHeader = `HKEY_CURRENT_USER${key.slice("HKCU".length)}`;
    if (lines[0].trim().toLowerCase() !== canonicalHeader.toLowerCase()) throw new HindsightNotesError("registry_response_invalid");
    const notes = [];
    for (const line of lines.slice(1)) {
      const match = /^\s*(n_[a-f0-9]{32})\s+REG_SZ\s+([A-Za-z0-9+/=]+)\s*$/.exec(line);
      if (!match) throw new HindsightNotesError("registry_response_invalid");
      notes.push(parseRegistryRecord(match[2], sessionReference, match[1]));
    }
    if (new Set(notes.map((note) => note.noteId)).size !== notes.length || notes.length > 100) throw new HindsightNotesError("malformed_notes");
    const legacyNotes = notes.filter((note) => note.legacy).map(({ legacy: _legacy, ...note }) => note);
    const eventNotes = notes.filter((note) => !note.legacy);
    return { schemaVersion: 2, kind: "pi-hindsight-event-notes", sessionReference, notes: eventNotes.sort((left, right) => left.noteId.localeCompare(right.noteId)), legacyNotes: legacyNotes.sort((left, right) => left.noteId.localeCompare(right.noteId)) };
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
    // `reg delete /f` is the atomic operation for this individual hash-only
    // value. Do not query an empty key afterward: localized reg.exe variants
    // emit non-data footer text for an empty key, which is intentionally not
    // accepted by the strict query parser.
  };
  const migrate = async (projectRoot, sessionReference, noteId, eventReference, eventLabel) => {
    const current = await list(projectRoot, sessionReference);
    const legacy = current?.legacyNotes.find((note) => note.noteId === noteId);
    if (!legacy) throw new HindsightNotesError("note_missing");
    const note = { ...legacy, eventReference: normalizeEventReference(eventReference), eventLabel: normalizeEventLabel(eventLabel) };
    await put(projectRoot, sessionReference, note);
    return note;
  };
  return { list, put, remove, migrate };
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
        // Another writer can release the lock after mkdir reports EEXIST. Retry
        // acquisition rather than dereferencing a disappeared lock directory.
        if (!existing) continue;
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

function newNote(eventReference, eventLabel, text, timestamp) {
  if (!validTimestamp(timestamp)) throw new HindsightNotesError("malformed_notes");
  return { noteId: `note-${randomUUID().replace(/-/g, "")}`, eventReference: normalizeEventReference(eventReference), eventLabel: normalizeEventLabel(eventLabel), text: safeHindsightNoteText(text), provenance: { source: "user-authored", confirmation: "user-confirmed", createdAt: timestamp } };
}
function migrateLegacy(current, noteId, eventReference, eventLabel) {
  const index = current.legacyNotes.findIndex((note) => note.noteId === noteId);
  if (index < 0) throw new HindsightNotesError("note_missing");
  const legacy = current.legacyNotes[index];
  const migrated = { ...legacy, eventReference: normalizeEventReference(eventReference), eventLabel: normalizeEventLabel(eventLabel) };
  return { ...current, notes: [...current.notes, migrated], legacyNotes: current.legacyNotes.filter((_note, legacyIndex) => legacyIndex !== index) };
}

function validateActualSession(sessionReference, text, actualSessionId) {
  if (actualSessionId === undefined) return;
  if (typeof actualSessionId !== "string" || hindsightNotesSessionReference(actualSessionId) !== sessionReference || text.includes(actualSessionId)) throw new HindsightNotesError("unsafe_note_text");
}
function validateEvent(eventReference, eventLabel, actualSessionId, eventIdentity) {
  normalizeEventReference(eventReference); normalizeEventLabel(eventLabel);
  if (typeof actualSessionId !== "string" || !actualSessionId || typeof eventIdentity !== "string" || !eventIdentity || eventIdentity.includes("\0") || hindsightNotesEventReference(actualSessionId, eventIdentity) !== eventReference || eventLabel.includes(actualSessionId)) throw new HindsightNotesError("invalid_event_reference");
}
export async function addHindsightNote(projectRoot, sessionReference, eventReference, eventLabel, text, { now = () => new Date().toISOString(), actualSessionId, eventIdentity } = {}) {
  validateActualSession(sessionReference, text, actualSessionId); validateEvent(eventReference, eventLabel, actualSessionId, eventIdentity);
  if (process.platform === "win32") {
    const current = await windowsRegistry.list(projectRoot, sessionReference);
    if (((current?.notes.length || 0) + (current?.legacyNotes.length || 0)) >= 100) throw new HindsightNotesError("notes_limit_reached");
    // UUID note identities make independent concurrent adds distinct registry values.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const note = newNote(eventReference, eventLabel, text, now());
      try { await windowsRegistry.put(projectRoot, sessionReference, note); return note; }
      catch (error) { if (!(error instanceof HindsightNotesError) || error.code !== "notes_conflict" || attempt === 2) throw error; }
    }
  }
  return withNotesLock(projectRoot, sessionReference, async (store) => {
    const prior = await readStoreAt(store);
    const current = prior || emptyHindsightNotes(sessionReference);
    if (current.notes.length + current.legacyNotes.length >= 100) throw new HindsightNotesError("notes_limit_reached");
    const note = newNote(eventReference, eventLabel, text, now());
    await atomicWriteAt(store, { ...current, notes: [...current.notes, note] });
    return note;
  });
}
export async function migrateLegacyHindsightNote(projectRoot, sessionReference, noteId, eventReference, eventLabel, { actualSessionId, eventIdentity } = {}) {
  if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) throw new HindsightNotesError("invalid_note_id");
  validateActualSession(sessionReference, "", actualSessionId); validateEvent(eventReference, eventLabel, actualSessionId, eventIdentity);
  if (process.platform === "win32") return windowsRegistry.migrate(projectRoot, sessionReference, noteId, eventReference, eventLabel);
  return withNotesLock(projectRoot, sessionReference, async (store) => {
    const current = await readStoreAt(store);
    if (!current) throw new HindsightNotesError("notes_missing");
    const migrated = migrateLegacy(current, noteId, eventReference, eventLabel);
    await atomicWriteAt(store, migrated);
    return migrated.notes.find((note) => note.noteId === noteId);
  });
}
export async function editHindsightNote(projectRoot, sessionReference, noteId, text, { now = () => new Date().toISOString(), actualSessionId } = {}) {
  validateActualSession(sessionReference, text, actualSessionId);
  if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) throw new HindsightNotesError("invalid_note_id");
  if (process.platform === "win32") {
    const current = await windowsRegistry.list(projectRoot, sessionReference);
    const prior = current?.notes.find((note) => note.noteId === noteId);
    if (!prior) throw new HindsightNotesError("note_missing");
    const editedAt = now();
    if (!validTimestamp(editedAt) || Date.parse(editedAt) < Date.parse(prior.provenance.createdAt)) throw new HindsightNotesError("malformed_notes");
    const note = { ...prior, text: safeHindsightNoteText(text), provenance: { ...prior.provenance, editedAt } };
    await windowsRegistry.put(projectRoot, sessionReference, note);
    return note;
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
    await windowsRegistry.remove(projectRoot, sessionReference, noteId);
    return;
  }
  return withNotesLock(projectRoot, sessionReference, async (store) => {
    const current = await readStoreAt(store);
    if (!current) throw new HindsightNotesError("notes_missing");
    if (!current.notes.some((note) => note.noteId === noteId)) throw new HindsightNotesError("note_missing");
    await atomicWriteAt(store, { ...current, notes: current.notes.filter((note) => note.noteId !== noteId) });
  });
}
