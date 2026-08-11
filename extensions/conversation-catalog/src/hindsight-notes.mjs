import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

const SESSION_REFERENCE = /^session-[a-f0-9]{32}$/;
const NOTE_ID = /^note-[a-f0-9]{32}$/;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;
const localLocks = new Map();

export class HindsightNotesError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const ownObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => ownObject(value) && Object.keys(value).every((key) => keys.includes(key));
const validTimestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

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

/** Opaque stable key derived from Pi's actual session ID, never its display name. */
export function hindsightNotesSessionReference(sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.includes("\0") || Array.from(sessionId).length > 512) {
    throw new HindsightNotesError("invalid_session_reference");
  }
  return `session-${createHash("sha256").update("pi-hindsight-notes:v1\0").update(sessionId).digest("hex").slice(0, 32)}`;
}

function normalizeProvenance(value) {
  if (!exactKeys(value, ["source", "confirmation", "createdAt", "editedAt"]) || value.source !== "user-authored" || value.confirmation !== "user-confirmed"
    || !validTimestamp(value.createdAt) || (value.editedAt !== undefined && (!validTimestamp(value.editedAt) || Date.parse(value.editedAt) < Date.parse(value.createdAt)))) {
    throw new HindsightNotesError("malformed_notes");
  }
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

function missing(error) { return error?.code === "ENOENT"; }
function contained(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !resolve(root, path).startsWith(`${root}${sep}${sep}`);
}

async function existingDirectory(path) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new HindsightNotesError("unsafe_notes_path");
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/**
 * Derives the only note-store path internally. Existing .pi/note directories
 * and the note file may not be symlinks, so no read or write can escape the
 * trusted project root through traversal or a swapped link.
 */
async function noteStorePath(projectRoot, sessionReference, { create = false } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot || projectRoot.includes("\0")) throw new HindsightNotesError("invalid_notes_path");
  emptyHindsightNotes(sessionReference);
  let root;
  try { root = await realpath(projectRoot); } catch { throw new HindsightNotesError("invalid_notes_path"); }
  const piDirectory = resolve(root, ".pi");
  const notesDirectory = resolve(piDirectory, "hindsight-notes");
  const path = resolve(notesDirectory, `${sessionReference}.json`);
  if (!contained(root, piDirectory) || !contained(root, notesDirectory) || !contained(root, path)
    || relative(notesDirectory, path) !== `${sessionReference}.json`) throw new HindsightNotesError("invalid_notes_path");
  if (create) {
    await mkdir(piDirectory, { recursive: true });
    await existingDirectory(piDirectory);
    await mkdir(notesDirectory, { recursive: true });
    await existingDirectory(notesDirectory);
  } else {
    if (!(await existingDirectory(piDirectory))) return path;
    if (!(await existingDirectory(notesDirectory))) return path;
  }
  let details;
  try { details = await lstat(path); } catch (error) { if (missing(error)) return path; throw error; }
  if (details.isSymbolicLink() || !details.isFile()) throw new HindsightNotesError("unsafe_notes_path");
  return path;
}

/** Public lexical display path only; persistence APIs always re-derive and validate it. */
export function hindsightNotesPath(projectRoot, sessionReference) {
  if (typeof projectRoot !== "string" || !projectRoot || projectRoot.includes("\0")) throw new HindsightNotesError("invalid_notes_path");
  emptyHindsightNotes(sessionReference);
  const root = resolve(projectRoot);
  const path = resolve(root, ".pi", "hindsight-notes", `${sessionReference}.json`);
  if (!contained(root, path)) throw new HindsightNotesError("invalid_notes_path");
  return path;
}

export async function readHindsightNotes(projectRoot, sessionReference) {
  const path = await noteStorePath(projectRoot, sessionReference);
  try {
    const store = parseHindsightNotes(JSON.parse(await readFile(path, "utf8")));
    if (store.sessionReference !== sessionReference) throw new HindsightNotesError("session_mismatch");
    return store;
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof HindsightNotesError) throw error;
    throw new HindsightNotesError("malformed_notes");
  }
}

const ownerPath = (lockPath) => `${lockPath}/owner.json`;
function ownerRecord(value) {
  return ownObject(value) && value.schemaVersion === 1 && typeof value.token === "string" && /^[a-f0-9-]{36}$/.test(value.token)
    && Number.isInteger(value.pid) && value.pid > 0 && validTimestamp(value.createdAt) ? value : undefined;
}
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; } }
async function isStale(lockPath, { readFileImpl, statImpl, now, staleMs, alive }) {
  let owner;
  try { owner = ownerRecord(JSON.parse(await readFileImpl(ownerPath(lockPath), "utf8"))); } catch { /* crashed creation */ }
  if (owner) return now() - Date.parse(owner.createdAt) >= staleMs && alive(owner.pid) !== true;
  try { return now() - (await statImpl(lockPath)).mtimeMs >= staleMs; } catch { return false; }
}

/** Process-safe, session-derived lock; active lock owners are never reclaimed. */
export async function acquireCrossProcessHindsightNotesLock(projectRoot, sessionReference, {
  mkdirImpl = mkdir, readFileImpl = readFile, statImpl = stat, renameImpl = rename, rmImpl = rm,
  delayImpl = delay, now = () => Date.now(), processAliveImpl = processAlive, randomUUIDImpl = randomUUID,
  timeoutMs = LOCK_TIMEOUT_MS, staleMs = STALE_LOCK_MS,
} = {}) {
  const path = await noteStorePath(projectRoot, sessionReference, { create: true });
  const lockPath = `${path}.lock`;
  const deadline = now() + timeoutMs;
  let wait = 5;
  while (true) {
    const token = randomUUIDImpl();
    try {
      await mkdirImpl(lockPath);
      await writeFile(ownerPath(lockPath), `${JSON.stringify({ schemaVersion: 1, token, pid: process.pid, createdAt: new Date(now()).toISOString() })}\n`, "utf8");
      return { path, lockPath, token };
    } catch (error) {
      const transient = error?.code === "EEXIST" || (error?.code === "EPERM" && error?.syscall === "mkdir" && error?.path === lockPath);
      if (!transient) throw error;
      try { if ((await lstat(lockPath)).isSymbolicLink()) throw new HindsightNotesError("unsafe_notes_path"); } catch (lockError) { if (lockError instanceof HindsightNotesError) throw lockError; }
      if (await isStale(lockPath, { readFileImpl, statImpl, now, staleMs, alive: processAliveImpl })) {
        const stale = `${lockPath}.stale-${randomUUIDImpl()}`;
        try { await renameImpl(lockPath, stale); await rmImpl(stale, { recursive: true, force: true }); continue; } catch { /* contender changed it */ }
      }
      if (now() >= deadline) throw new HindsightNotesError("notes_lock_timeout");
      await delayImpl(wait); wait = Math.min(wait * 2, 100);
    }
  }
}

async function releaseLock(lock) {
  try {
    const owner = ownerRecord(JSON.parse(await readFile(ownerPath(lock.lockPath), "utf8")));
    if (owner?.token === lock.token) await rm(lock.lockPath, { recursive: true, force: true });
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
  try { lock = await acquireCrossProcessHindsightNotesLock(projectRoot, sessionReference); return await operation(lock.path); }
  finally {
    if (lock) await releaseLock(lock);
    release();
    if (localLocks.get(key) === current) localLocks.delete(key);
  }
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

function newNote(text, timestamp) {
  if (!validTimestamp(timestamp)) throw new HindsightNotesError("malformed_notes");
  return { noteId: `note-${randomUUID().replace(/-/g, "")}`, text: safeHindsightNoteText(text), provenance: { source: "user-authored", confirmation: "user-confirmed", createdAt: timestamp } };
}

export async function addHindsightNote(projectRoot, sessionReference, text, { now = () => new Date().toISOString() } = {}) {
  return withNotesLock(projectRoot, sessionReference, async (path) => {
    const prior = await readHindsightNotes(projectRoot, sessionReference);
    const store = prior || emptyHindsightNotes(sessionReference);
    if (store.notes.length >= 100) throw new HindsightNotesError("notes_limit_reached");
    const note = newNote(text, now());
    await atomicWrite(path, { ...store, notes: [...store.notes, note] });
    return note;
  });
}

export async function editHindsightNote(projectRoot, sessionReference, noteId, text, { now = () => new Date().toISOString() } = {}) {
  if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) throw new HindsightNotesError("invalid_note_id");
  return withNotesLock(projectRoot, sessionReference, async (path) => {
    const store = await readHindsightNotes(projectRoot, sessionReference);
    if (!store) throw new HindsightNotesError("notes_missing");
    const index = store.notes.findIndex((note) => note.noteId === noteId);
    if (index < 0) throw new HindsightNotesError("note_missing");
    const prior = store.notes[index];
    const editedAt = now();
    if (!validTimestamp(editedAt) || Date.parse(editedAt) < Date.parse(prior.provenance.createdAt)) throw new HindsightNotesError("malformed_notes");
    const note = { ...prior, text: safeHindsightNoteText(text), provenance: { ...prior.provenance, editedAt } };
    const notes = [...store.notes]; notes[index] = note;
    await atomicWrite(path, { ...store, notes });
    return note;
  });
}

export async function deleteHindsightNote(projectRoot, sessionReference, noteId) {
  if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) throw new HindsightNotesError("invalid_note_id");
  return withNotesLock(projectRoot, sessionReference, async (path) => {
    const store = await readHindsightNotes(projectRoot, sessionReference);
    if (!store) throw new HindsightNotesError("notes_missing");
    if (!store.notes.some((note) => note.noteId === noteId)) throw new HindsightNotesError("note_missing");
    await atomicWrite(path, { ...store, notes: store.notes.filter((note) => note.noteId !== noteId) });
  });
}
