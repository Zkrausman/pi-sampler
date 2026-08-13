import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export const TICKET_LIFECYCLE_VERSION = 1;
export const TICKET_LIFECYCLE_STATES = Object.freeze(["picked-up", "active", "awaiting-merge", "merged", "closed"]);
export const MAX_SEGMENTS = 1_000;
const TICKET = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_EVIDENCE = 32;
const NEXT = new Map([
  [undefined, new Set(["picked-up"])], ["picked-up", new Set(["active"])],
  ["active", new Set(["awaiting-merge"])], ["awaiting-merge", new Set(["merged"])], ["merged", new Set(["closed"])],
]);

export class TicketLifecycleError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new TicketLifecycleError(code); };
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const safeNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SAFE;
const add = (left, right) => { if (!safeNumber(left) || !safeNumber(right) || left + right > MAX_SAFE) fail("unsafe_cost"); return left + right; };
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function cleanId(value, field) { if (typeof value !== "string" || !ID.test(value)) fail(`invalid_${field}`); return value; }
function cleanTicket(value) { if (typeof value !== "string" || !TICKET.test(value)) fail("invalid_ticket"); return value; }
function cleanAt(value) { if (typeof value !== "string" || !ISO.test(value) || Number.isNaN(Date.parse(value))) fail("invalid_at"); return value; }
function cleanEvidence(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVIDENCE) fail("invalid_evidence");
  return value.map((entry) => {
    if (!isObject(entry) || Object.keys(entry).some((key) => key !== "ref" && key !== "sha256") || typeof entry.ref !== "string" || !ID.test(entry.ref) || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) fail("invalid_evidence");
    return { ref: entry.ref, sha256: entry.sha256 };
  });
}
function cleanReceipt(value) {
  if (!isObject(value) || Object.keys(value).some((key) => !["total", "parentDelta", "subagentTotal", "subagentRuns"].includes(key))) fail("invalid_receipt");
  const { total, parentDelta, subagentTotal } = value;
  if (!safeNumber(total) || !safeNumber(parentDelta) || !safeNumber(subagentTotal) || total !== add(parentDelta, subagentTotal) || (value.subagentRuns !== undefined && (!Number.isSafeInteger(value.subagentRuns) || value.subagentRuns < 0))) fail("invalid_receipt");
  return { total, parentDelta, subagentTotal, subagentRuns: value.subagentRuns ?? 0 };
}
function cleanSegment(value) {
  if (!isObject(value) || Object.keys(value).some((key) => !["id", "session", "startRequestId", "settleRequestId", "receipt", "coverage"].includes(key))) fail("invalid_segment");
  const id = cleanId(value.id, "segment_id"); const session = cleanId(value.session, "session"); const startRequestId = cleanId(value.startRequestId, "start_request_id"); const coverage = value.coverage;
  if (!new Set(["pending", "complete", "interrupted", "missing-receiver", "settle-failed", "abandoned"]).has(coverage)) fail("invalid_coverage");
  if (coverage === "pending") { if (value.settleRequestId !== undefined || value.receipt !== undefined) fail("invalid_segment"); return { id, session, startRequestId, coverage }; }
  if (coverage === "complete") {
    if (typeof value.settleRequestId !== "string" || !ID.test(value.settleRequestId) || value.receipt === undefined) fail("invalid_segment");
    return { id, session, startRequestId, settleRequestId: value.settleRequestId, receipt: cleanReceipt(value.receipt), coverage };
  }
  if (value.settleRequestId !== undefined || value.receipt !== undefined) fail("invalid_segment"); return { id, session, startRequestId, coverage };
}

/** Strict, tracker-neutral adapter contract. Receipts/evidence are supplied as data. */
export function validateTransition(input) {
  if (!isObject(input) || input.version !== TICKET_LIFECYCLE_VERSION || Object.keys(input).some((key) => !["version", "eventId", "ticket", "at", "action", "segment", "evidence"].includes(key))) fail("invalid_transition");
  const eventId = cleanId(input.eventId, "event_id"); const ticket = cleanTicket(input.ticket); const at = cleanAt(input.at);
  if (!["pickup", "segment-start", "segment-settle", "awaiting-merge", "merged", "closed"].includes(input.action)) fail("invalid_action");
  if (input.action === "segment-start" || input.action === "segment-settle") {
    if (input.evidence !== undefined) fail("invalid_transition"); const segment = cleanSegment(input.segment);
    if ((input.action === "segment-start" && segment.coverage !== "pending") || (input.action === "segment-settle" && segment.coverage === "pending")) fail("invalid_segment");
    return { version: 1, eventId, ticket, at, action: input.action, segment };
  }
  if (input.segment !== undefined) fail("invalid_transition");
  let evidence = [];
  if (input.action === "merged" || input.action === "closed") evidence = cleanEvidence(input.evidence);
  else if (input.evidence !== undefined) { if (!Array.isArray(input.evidence) || input.evidence.length > MAX_EVIDENCE) fail("invalid_evidence"); evidence = input.evidence.length ? cleanEvidence(input.evidence) : []; }
  return { version: 1, eventId, ticket, at, action: input.action, evidence };
}
function targetState(event) { return ({ pickup: "picked-up", "segment-start": "active", "awaiting-merge": "awaiting-merge", merged: "merged", closed: "closed" })[event.action]; }
export function replayTransitions(rawEvents) {
  if (!Array.isArray(rawEvents)) fail("invalid_ledger"); const tickets = new Map(); const eventIds = new Set();
  for (const raw of rawEvents) {
    const event = validateTransition(raw); if (eventIds.has(event.eventId)) continue; eventIds.add(event.eventId);
    const current = tickets.get(event.ticket) ?? { state: undefined, segments: new Map(), evidence: {}, pickedUpAt: undefined, closedAt: undefined };
    if (event.action === "segment-start") {
      if (current.state !== "picked-up" && current.state !== "active") fail("invalid_transition");
      if (current.segments.size >= MAX_SEGMENTS) fail("too_many_segments");
      if (current.segments.has(event.segment.id) || [...current.segments.values()].some((segment) => segment.startRequestId === event.segment.startRequestId)) fail("duplicate_segment");
      current.state = "active"; current.segments.set(event.segment.id, event.segment);
    } else if (event.action === "segment-settle") {
      const existing = current.segments.get(event.segment.id);
      if (!existing || existing.session !== event.segment.session || existing.startRequestId !== event.segment.startRequestId || existing.coverage !== "pending" || [...current.segments.values()].some((segment) => segment.id !== event.segment.id && segment.settleRequestId === event.segment.settleRequestId)) fail("invalid_segment_settlement");
      current.segments.set(event.segment.id, event.segment);
    } else {
      const next = targetState(event); if (!NEXT.get(current.state)?.has(next)) fail("invalid_transition");
      if (event.action === "pickup") current.pickedUpAt = event.at;
      if (event.action === "merged") current.evidence.merged = event.evidence;
      if (event.action === "closed") {
        if (!current.evidence.merged || current.segments.size === 0 || [...current.segments.values()].some((segment) => segment.coverage === "pending")) fail("cannot_finalize");
        current.evidence.closed = event.evidence; current.closedAt = event.at;
      }
      current.state = next;
    }
    tickets.set(event.ticket, current);
  }
  return tickets;
}
function recoverEvents(text) {
  if (text === "") return { events: [], recovered: false };
  const lines = text.split("\n"); if (lines.at(-1) === "") lines.pop(); const events = [];
  for (let index = 0; index < lines.length; index++) {
    try { events.push(JSON.parse(lines[index])); } catch { if (index === lines.length - 1) return { events, recovered: true }; fail("invalid_ledger"); }
  }
  return { events, recovered: false };
}
function contained(root, candidate) { const result = resolve(candidate); const rel = relative(root, result); if (rel === "" || (!rel.startsWith("../") && !rel.startsWith("..\\") && rel !== "..")) return result; fail("path_escaped"); }
async function statOrMissing(path) { try { return await lstat(path); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; } }
async function safeDirectory(path) { await mkdir(path, { recursive: true }); const entry = await lstat(path); if (!entry.isDirectory() || entry.isSymbolicLink()) fail("unsafe_storage_path"); }
async function safeFile(path) { const entry = await statOrMissing(path); if (entry && (!entry.isFile() || entry.isSymbolicLink())) fail("unsafe_storage_path"); return entry; }
async function durableReplace(directory, target, contents) {
  await safeDirectory(directory); await safeFile(target); const temporary = contained(directory, join(directory, `.${randomUUID()}.tmp`)); const handle = await open(temporary, "wx");
  try { await handle.writeFile(contents, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
  // fsync of a directory is not portable (notably Windows); the file is synced before rename.
  try { const directoryHandle = await open(directory, "r"); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); } } catch { /* documented platform caveat */ }
}

/** Acquires a bounded, non-reclaimed lock. Operators must verify a stopped owner before manual recovery. */
export async function acquireLedgerLock(path) {
  await safeDirectory(dirname(path)); await safeFile(path); const token = randomUUID();
  try { const handle = await open(path, "wx"); await handle.writeFile(JSON.stringify({ version: 1, token })); await handle.sync(); await handle.close(); return { path, token }; }
  catch (error) { if (error?.code === "EEXIST") fail("ledger_locked"); throw error; }
}
/**
 * Best-effort release: token comparison rejects ordinary stale cleanup, but
 * portable Node cannot atomically compare-token-and-unlink. It therefore
 * requires a trusted filesystem and no concurrent manual lock recovery.
 */
export async function releaseLedgerLock(lock) {
  try {
    const entry = await safeFile(lock.path); if (!entry) return false;
    const value = JSON.parse(await readFile(lock.path, "utf8")); if (!isObject(value) || value.version !== 1 || value.token !== lock.token) return false;
    // This check is a defense against ordinary stale cleanup, not a guarantee: a replacement can race after read.
    await unlink(lock.path); return true;
  } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
function receiptFor(ticket, state) {
  if (state.state !== "closed" || !state.evidence.merged || !state.evidence.closed) fail("cannot_finalize");
  let total = 0; let parentDelta = 0; let subagentTotal = 0; let subagentRuns = 0; const segments = [];
  for (const segment of [...state.segments.values()].sort((left, right) => compare(left.id, right.id))) {
    segments.push({ id: segment.id, session: segment.session, startRequestId: segment.startRequestId, ...(segment.settleRequestId ? { settleRequestId: segment.settleRequestId } : {}), coverage: segment.coverage, ...(segment.receipt ? { receipt: segment.receipt } : {}) });
    if (segment.coverage === "complete") { total = add(total, segment.receipt.total); parentDelta = add(parentDelta, segment.receipt.parentDelta); subagentTotal = add(subagentTotal, segment.receipt.subagentTotal); subagentRuns = add(subagentRuns, segment.receipt.subagentRuns); }
  }
  const attributionGaps = segments.filter((segment) => segment.coverage !== "complete").map(({ id, coverage: reason }) => ({ id, reason }));
  return { version: 1, ticket, pickedUpAt: state.pickedUpAt, closedAt: state.closedAt, coverage: attributionGaps.length ? "partial" : "complete", total, parentDelta, subagentTotal, subagentRuns, segments, attributionGaps, evidence: { merged: state.evidence.merged, closed: state.evidence.closed } };
}

export class TicketLifecycleLedger {
  constructor(root) { this.root = resolve(root); }
  async layout() {
    const root = await realpath(this.root); const pi = contained(root, join(root, ".pi")); const directory = contained(root, join(pi, "ticket-lifecycle")); const receipts = contained(root, join(directory, "receipts"));
    await safeDirectory(pi); await safeDirectory(directory); return { directory, receipts, path: contained(root, join(directory, "events.ndjson")), lockPath: contained(root, join(directory, "events.lock")), root };
  }
  async readJournal() { const { path } = await this.layout(); if (!(await safeFile(path))) return { events: [], recovered: false }; return recoverEvents(await readFile(path, "utf8")); }
  async events() { return (await this.readJournal()).events; }
  async snapshot() { return replayTransitions(await this.events()); }
  async append(raw) {
    const event = validateTransition(raw); const layout = await this.layout(); const lock = await acquireLedgerLock(layout.lockPath);
    try {
      const journal = await this.readJournal(); const duplicate = journal.events.find((entry) => entry.eventId === event.eventId);
      if (duplicate) { if (JSON.stringify(validateTransition(duplicate)) !== JSON.stringify(event)) fail("duplicate_event_conflict"); return { appended: false, state: replayTransitions(journal.events).get(event.ticket)?.state, recovered: journal.recovered }; }
      const next = [...journal.events, event]; const state = replayTransitions(next).get(event.ticket)?.state;
      await durableReplace(layout.directory, layout.path, `${next.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      return { appended: true, state, recovered: journal.recovered };
    } finally { await releaseLedgerLock(lock); }
  }
  async finalize(ticket) {
    cleanTicket(ticket); const layout = await this.layout(); const state = (await this.snapshot()).get(ticket); if (!state) fail("ticket_not_found"); const receipt = receiptFor(ticket, state);
    await safeDirectory(layout.receipts); const path = contained(layout.root, join(layout.receipts, `${ticket}.json`));
    if (await safeFile(path)) { const current = JSON.parse(await readFile(path, "utf8")); if (JSON.stringify(current) !== JSON.stringify(receipt)) fail("immutable_receipt_conflict"); return { receipt: current, path, published: false }; }
    await durableReplace(layout.receipts, path, `${JSON.stringify(receipt, null, 2)}\n`); return { receipt, path, published: true };
  }
}
