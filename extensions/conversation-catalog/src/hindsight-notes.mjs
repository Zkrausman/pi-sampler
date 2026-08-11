import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const SESSION_REFERENCE = /^[a-f0-9]{64}$/;
const NOTE_ID = /^note-[a-f0-9]{32}$/;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;
const RENAME_ATTEMPTS = 8;
const localLocks = new Map();

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

// Notes are user-authored context, not an alternate transcript or credential store.
const UNSAFE_NOTE_TEXT = /\b(?:raw[- ]?session(?:[- ]?id)?|session[_-]?id|pi_session_file|bearer\s+|api[_-]?key|authorization\s*:|gh[pousr]_[A-Za-z0-9_]{20,}|(?:akia|asia|aida|aroa)[a-z0-9]{16}|(?:aws_)?(?:secret_access_key|access_key_id)\s*[:=]|(?:password|secret|token|credential)s?\s*(?:=|:)\s*\S+)\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

export function safeHindsightNoteText(value) {
  const note = boundedText(value);
  if (UNSAFE_NOTE_TEXT.test(note)) throw new HindsightNotesError("unsafe_note_text");
  return note;
}

/** Opaque SHA-256 key derived from Pi's actual session ID, never its display name. */
export function hindsightNotesSessionReference(sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.includes("\0") || Array.from(sessionId).length > 512) throw new HindsightNotesError("invalid_session_reference");
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
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

/** Strict local-only schema; raw session IDs are never accepted or persisted. */
export function parseHindsightNotes(value) {
  if (!exactKeys(value, ["schemaVersion", "kind", "sessionReference", "notes"])
    || value.schemaVersion !== 1 || value.kind !== "pi-hindsight-session-notes"
    || typeof value.sessionReference !== "string" || !SESSION_REFERENCE.test(value.sessionReference)
    || !Array.isArray(value.notes) || value.notes.length > 100) throw new HindsightNotesError("malformed_notes");
  const notes = value.notes.map(normalizeNote);
  if (new Set(notes.map((note) => note.noteId)).size !== notes.length) throw new HindsightNotesError("malformed_notes");
  return { schemaVersion: 1, kind: "pi-hindsight-session-notes", sessionReference: value.sessionReference, notes };
}

function contained(root, candidate) {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`);
}

async function checkedDirectory(path, create) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new HindsightNotesError("unsafe_notes_path");
    return true;
  } catch (error) {
    if (error instanceof HindsightNotesError) throw error;
    if (!missing(error)) throw new HindsightNotesError("unsafe_notes_path");
    if (!create) return false;
  }
  try { await mkdir(path); }
  catch (error) { if (error?.code !== "EEXIST") throw new HindsightNotesError("unsafe_notes_path"); }
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new HindsightNotesError("unsafe_notes_path");
    return true;
  } catch (error) { throw error instanceof HindsightNotesError ? error : new HindsightNotesError("unsafe_notes_path"); }
}

async function checkedRegularFile(path) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new HindsightNotesError("unsafe_notes_path");
    return true;
  } catch (error) {
    if (error instanceof HindsightNotesError) throw error;
    if (missing(error)) return false;
    throw new HindsightNotesError("unsafe_notes_path");
  }
}

/**
 * Derives the only store path internally. Existing store directories and the
 * sidecar leaf must be ordinary directories/files, never symlinks.
 *
 * This is a reliability/privacy boundary for a trusted project directory, not
 * a privileged-store guarantee against a hostile same-user process replacing
 * project paths between filesystem operations.
 */
async function noteStore(projectRoot, sessionReference, { create = false } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot || projectRoot.includes("\0")) throw new HindsightNotesError("invalid_notes_path");
  emptyHindsightNotes(sessionReference);
  let root;
  try { root = await realpath(projectRoot); }
  catch { throw new HindsightNotesError("invalid_notes_path"); }
  try {
    const rootDetails = await lstat(root);
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) throw new HindsightNotesError("invalid_notes_path");
  } catch (error) { throw error instanceof HindsightNotesError ? error : new HindsightNotesError("invalid_notes_path"); }
  const piDirectory = resolve(root, ".pi");
  const notesDirectory = resolve(piDirectory, "hindsight-notes");
  const path = resolve(notesDirectory, `${sessionReference}.json`);
  if (!contained(root, piDirectory) || !contained(root, notesDirectory) || !contained(root, path)
    || relative(notesDirectory, path) !== `${sessionReference}.json`) throw new HindsightNotesError("invalid_notes_path");
  if (!(await checkedDirectory(piDirectory, create))) return { root, notesDirectory, path };
  if (!(await checkedDirectory(notesDirectory, create))) return { root, notesDirectory, path };
  await checkedRegularFile(path);
  return { root, notesDirectory, path };
}

/** Display-only; persistence APIs always derive and validate this location themselves. */
export function hindsightNotesPath(projectRoot, sessionReference) {
  if (typeof projectRoot !== "string" || !projectRoot || projectRoot.includes("\0")) throw new HindsightNotesError("invalid_notes_path");
  emptyHindsightNotes(sessionReference);
  const root = resolve(projectRoot);
  const path = resolve(root, ".pi", "hindsight-notes", `${sessionReference}.json`);
  if (!contained(root, path)) throw new HindsightNotesError("invalid_notes_path");
  return path;
}

async function readStore(store, sessionReference) {
  await checkedDirectory(store.notesDirectory, false);
  if (!(await checkedRegularFile(store.path))) return undefined;
  try {
    const parsed = parseHindsightNotes(JSON.parse(await readFile(store.path, "utf8")));
    if (parsed.sessionReference !== sessionReference) throw new HindsightNotesError("session_mismatch");
    return parsed;
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof HindsightNotesError) throw error;
    throw new HindsightNotesError("malformed_notes");
  }
}

export async function readHindsightNotes(projectRoot, sessionReference) {
  return readStore(await noteStore(projectRoot, sessionReference), sessionReference);
}

const ownerPath = (lockPath) => `${lockPath}${sep}owner.json`;
function ownerRecord(value) {
  return ownObject(value) && value.schemaVersion === 1 && typeof value.token === "string" && /^[a-f0-9-]{36}$/.test(value.token)
    && Number.isInteger(value.pid) && value.pid > 0 && validTimestamp(value.createdAt) ? value : undefined;
}
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; } }
async function staleLock(lockPath, { now, staleMs, alive }) {
  let owner;
  try { owner = ownerRecord(JSON.parse(await readFile(ownerPath(lockPath), "utf8"))); } catch { /* incomplete/crashed lock creation */ }
  if (owner) return now() - Date.parse(owner.createdAt) >= staleMs && alive(owner.pid) !== true;
  try { return now() - (await stat(lockPath)).mtimeMs >= staleMs; } catch { return false; }
}

/** Bounded, ordinary cross-process lock for concurrent Pi operations. */
export async function acquireCrossProcessHindsightNotesLock(projectRoot, sessionReference, {
  delayImpl = delay, now = () => Date.now(), processAliveImpl = processAlive, randomUUIDImpl = randomUUID,
  timeoutMs = LOCK_TIMEOUT_MS, staleMs = STALE_LOCK_MS,
} = {}) {
  const store = await noteStore(projectRoot, sessionReference, { create: true });
  const lockPath = `${store.path}.lock`;
  const deadline = now() + timeoutMs;
  let wait = 5;
  while (true) {
    const token = randomUUIDImpl();
    try {
      await mkdir(lockPath);
      await writeFile(ownerPath(lockPath), `${JSON.stringify({ schemaVersion: 1, token, pid: process.pid, createdAt: new Date(now()).toISOString() })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return { ...store, lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw new HindsightNotesError("unsafe_notes_path");
      try {
        const details = await lstat(lockPath);
        if (details.isSymbolicLink() || !details.isDirectory()) throw new HindsightNotesError("unsafe_notes_path");
      } catch (lockError) {
        if (lockError instanceof HindsightNotesError) throw lockError;
        if (!missing(lockError)) throw new HindsightNotesError("unsafe_notes_path");
        if (now() >= deadline) throw new HindsightNotesError("notes_lock_timeout");
        await delayImpl(wait); wait = Math.min(wait * 2, 100);
        continue;
      }
      if (await staleLock(lockPath, { now, staleMs, alive: processAliveImpl })) {
        const stale = `${lockPath}.stale-${randomUUIDImpl()}`;
        try { await rename(lockPath, stale); await rm(stale, { recursive: true, force: true }); continue; } catch { /* another writer changed it */ }
      }
      if (now() >= deadline) throw new HindsightNotesError("notes_lock_timeout");
      await delayImpl(wait); wait = Math.min(wait * 2, 100);
    }
  }
}

async function releaseLock(lock) {
  try {
    const owner = ownerRecord(JSON.parse(await readFile(ownerPath(lock.lockPath), "utf8")));
    if (owner?.token === lock.token) await rm(lock.lockPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  } catch { /* never remove a replacement owner's lock */ }
}

async function withNotesLock(projectRoot, sessionReference, operation) {
  const key = `${resolve(projectRoot)}\0${sessionReference}`;
  const previous = localLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((done) => { release = done; });
  localLocks.set(key, current);
  await previous;
  let lock;
  try { lock = await acquireCrossProcessHindsightNotesLock(projectRoot, sessionReference); return await operation(lock); }
  finally {
    if (lock) await releaseLock(lock);
    release();
    if (localLocks.get(key) === current) localLocks.delete(key);
  }
}

function retryableRenameError(error) { return ["EACCES", "EBUSY", "EPERM"].includes(error?.code); }
async function atomicWrite(store, value) {
  await checkedDirectory(store.notesDirectory, false);
  await checkedRegularFile(store.path);
  const temporary = resolve(store.notesDirectory, `.${store.path.slice(store.path.lastIndexOf(sep) + 1)}.${randomUUID()}.tmp`);
  if (!contained(store.notesDirectory, temporary)) throw new HindsightNotesError("unsafe_notes_path");
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) { throw error instanceof HindsightNotesError ? error : new HindsightNotesError("unsafe_notes_path"); }
  finally { await handle?.close().catch(() => undefined); }
  try {
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
      try { await rename(temporary, store.path); return; }
      catch (error) {
        if (!retryableRenameError(error) || attempt === RENAME_ATTEMPTS - 1) throw error;
        await delay(5 * (attempt + 1));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new HindsightNotesError("unsafe_notes_path");
  }
}

function newNote(text, timestamp) {
  if (!validTimestamp(timestamp)) throw new HindsightNotesError("malformed_notes");
  return { noteId: `note-${randomUUID().replace(/-/g, "")}`, text: safeHindsightNoteText(text), provenance: { source: "user-authored", confirmation: "user-confirmed", createdAt: timestamp } };
}

export async function addHindsightNote(projectRoot, sessionReference, text, { now = () => new Date().toISOString() } = {}) {
  return withNotesLock(projectRoot, sessionReference, async (store) => {
    const current = await readStore(store, sessionReference) || emptyHindsightNotes(sessionReference);
    if (current.notes.length >= 100) throw new HindsightNotesError("notes_limit_reached");
    const note = newNote(text, now());
    await atomicWrite(store, { ...current, notes: [...current.notes, note] });
    return note;
  });
}

export async function editHindsightNote(projectRoot, sessionReference, noteId, text, { now = () => new Date().toISOString() } = {}) {
  if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) throw new HindsightNotesError("invalid_note_id");
  return withNotesLock(projectRoot, sessionReference, async (store) => {
    const current = await readStore(store, sessionReference);
    if (!current) throw new HindsightNotesError("notes_missing");
    const index = current.notes.findIndex((note) => note.noteId === noteId);
    if (index < 0) throw new HindsightNotesError("note_missing");
    const prior = current.notes[index];
    const editedAt = now();
    if (!validTimestamp(editedAt) || Date.parse(editedAt) < Date.parse(prior.provenance.createdAt)) throw new HindsightNotesError("malformed_notes");
    const note = { ...prior, text: safeHindsightNoteText(text), provenance: { ...prior.provenance, editedAt } };
    const notes = [...current.notes]; notes[index] = note;
    await atomicWrite(store, { ...current, notes });
    return note;
  });
}

export async function deleteHindsightNote(projectRoot, sessionReference, noteId) {
  if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) throw new HindsightNotesError("invalid_note_id");
  return withNotesLock(projectRoot, sessionReference, async (store) => {
    const current = await readStore(store, sessionReference);
    if (!current) throw new HindsightNotesError("notes_missing");
    if (!current.notes.some((note) => note.noteId === noteId)) throw new HindsightNotesError("note_missing");
    await atomicWrite(store, { ...current, notes: current.notes.filter((note) => note.noteId !== noteId) });
  });
}
