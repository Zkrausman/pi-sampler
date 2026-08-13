import { appendFile, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export const TICKET_LIFECYCLE_VERSION = 1;
export const TICKET_LIFECYCLE_STATES = Object.freeze(["picked-up", "active", "awaiting-merge", "merged", "closed"]);
const TICKET = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_EVIDENCE = 32;
const MAX_SEGMENTS = 1_000;
const FINAL = new Set(["closed"]);
const NEXT = new Map([
  [undefined, new Set(["picked-up"])],
  ["picked-up", new Set(["active"])],
  ["active", new Set(["awaiting-merge"])],
  ["awaiting-merge", new Set(["merged"])],
  ["merged", new Set(["closed"])],
]);

export class TicketLifecycleError extends Error {
  constructor(code) { super(code); this.code = code; }
}
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
  const total = value.total; const parentDelta = value.parentDelta; const subagentTotal = value.subagentTotal;
  if (!safeNumber(total) || !safeNumber(parentDelta) || !safeNumber(subagentTotal) || total !== add(parentDelta, subagentTotal) || (value.subagentRuns !== undefined && (!Number.isSafeInteger(value.subagentRuns) || value.subagentRuns < 0))) fail("invalid_receipt");
  return { total, parentDelta, subagentTotal, subagentRuns: value.subagentRuns ?? 0 };
}
function cleanSegment(value) {
  if (!isObject(value) || Object.keys(value).some((key) => !["id", "session", "startRequestId", "settleRequestId", "receipt", "coverage"].includes(key))) fail("invalid_segment");
  const id = cleanId(value.id, "segment_id"); const session = cleanId(value.session, "session"); const startRequestId = cleanId(value.startRequestId, "start_request_id");
  const coverage = value.coverage;
  if (coverage !== "pending" && coverage !== "complete" && coverage !== "interrupted" && coverage !== "missing-receiver" && coverage !== "settle-failed" && coverage !== "abandoned") fail("invalid_coverage");
  if (coverage === "pending") {
    if (value.settleRequestId !== undefined || value.receipt !== undefined) fail("invalid_segment");
    return { id, session, startRequestId, coverage };
  }
  if (coverage === "complete") {
    if (typeof value.settleRequestId !== "string" || !ID.test(value.settleRequestId) || value.receipt === undefined) fail("invalid_segment");
    return { id, session, startRequestId, settleRequestId: value.settleRequestId, receipt: cleanReceipt(value.receipt), coverage };
  }
  if (value.settleRequestId !== undefined || value.receipt !== undefined) fail("invalid_segment");
  return { id, session, startRequestId, coverage };
}

/** Validates the narrow, adapter-facing v1 transition contract. */
export function validateTransition(input) {
  if (!isObject(input) || input.version !== TICKET_LIFECYCLE_VERSION || Object.keys(input).some((key) => !["version", "eventId", "ticket", "at", "action", "segment", "evidence"].includes(key))) fail("invalid_transition");
  const eventId = cleanId(input.eventId, "event_id"); const ticket = cleanTicket(input.ticket); const at = cleanAt(input.at);
  if (!["pickup", "segment-start", "segment-settle", "awaiting-merge", "merged", "closed"].includes(input.action)) fail("invalid_action");
  if (input.action === "segment-start" || input.action === "segment-settle") {
    if (input.evidence !== undefined) fail("invalid_transition");
    const segment = cleanSegment(input.segment);
    if ((input.action === "segment-start" && segment.coverage !== "pending") || (input.action === "segment-settle" && segment.coverage === "pending")) fail("invalid_segment");
    return { version: 1, eventId, ticket, at, action: input.action, segment };
  }
  if (input.segment !== undefined) fail("invalid_transition");
  let evidence;
  if (input.action === "pickup" || input.action === "awaiting-merge") {
    if (input.evidence === undefined) evidence = [];
    else {
      if (!Array.isArray(input.evidence) || input.evidence.length > MAX_EVIDENCE) fail("invalid_evidence");
      evidence = input.evidence.length === 0 ? [] : cleanEvidence(input.evidence);
    }
  } else evidence = cleanEvidence(input.evidence);
  return { version: 1, eventId, ticket, at, action: input.action, evidence };
}
function targetState(transition) {
  if (transition.action === "pickup") return "picked-up";
  if (transition.action === "segment-start") return "active";
  if (transition.action === "awaiting-merge") return "awaiting-merge";
  if (transition.action === "merged") return "merged";
  if (transition.action === "closed") return "closed";
  return undefined;
}
function coverage(segment) { return segment.coverage === "complete" ? "complete" : "partial"; }
export function replayTransitions(rawEvents) {
  if (!Array.isArray(rawEvents)) fail("invalid_ledger");
  const tickets = new Map(); const eventIds = new Set();
  for (const raw of rawEvents) {
    const event = validateTransition(raw);
    if (eventIds.has(event.eventId)) continue;
    eventIds.add(event.eventId);
    const current = tickets.get(event.ticket) ?? { state: undefined, segments: new Map(), evidence: { merged: undefined, closed: undefined }, pickedUpAt: undefined, closedAt: undefined };
    if (event.action === "segment-settle") {
      if (!current.segments.has(event.segment.id)) fail("segment_not_started");
      const existing = current.segments.get(event.segment.id);
      if (existing.session !== event.segment.session || existing.startRequestId !== event.segment.startRequestId || existing.coverage !== "pending" || [...current.segments.values()].some((segment) => segment.id !== event.segment.id && segment.settleRequestId === event.segment.settleRequestId)) fail("invalid_segment_settlement");
      if (current.segments.size > MAX_SEGMENTS) fail("too_many_segments");
      current.segments.set(event.segment.id, event.segment);
    } else if (event.action === "segment-start") {
      if (current.state !== "picked-up" && current.state !== "active") fail("invalid_transition");
      if (current.segments.has(event.segment.id) || [...current.segments.values()].some((segment) => segment.startRequestId === event.segment.startRequestId)) fail("duplicate_segment");
      current.state = "active";
      current.segments.set(event.segment.id, { ...event.segment, coverage: "pending" });
    } else {
      const next = targetState(event);
      if (!NEXT.get(current.state)?.has(next)) fail("invalid_transition");
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
function readEvents(text) {
  if (text.trim() === "") return [];
  try { return text.trim().split("\n").map((line) => JSON.parse(line)); } catch { fail("invalid_ledger"); }
}
function assertContained(root, path) {
  const result = resolve(path); const rel = relative(root, result);
  if (rel === "" || (!rel.startsWith("../") && !rel.startsWith("..\\") && rel !== "..")) return result;
  fail("path_escaped");
}
async function acquire(path, now, leaseMs, attempts = 0) {
  await mkdir(dirname(path), { recursive: true });
  try { const handle = await open(path, "wx"); await handle.writeFile(JSON.stringify({ at: now.toISOString() })); return handle; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const lock = await lstat(path); if (now.getTime() - lock.mtimeMs > leaseMs) {
      await unlink(path).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; }); return acquire(path, now, leaseMs, attempts + 1);
    }
    if (attempts >= 200) fail("ledger_locked");
    await new Promise((done) => setTimeout(done, 5)); return acquire(path, now, leaseMs, attempts + 1);
  }
}
function receiptFor(ticket, state) {
  if (state.state !== "closed" || !state.evidence.merged || !state.evidence.closed) fail("cannot_finalize");
  let total = 0; let parentDelta = 0; let subagentTotal = 0; let subagentRuns = 0; const segments = [];
  for (const segment of [...state.segments.values()].sort((left, right) => compare(left.id, right.id))) {
    const status = coverage(segment); segments.push({ id: segment.id, session: segment.session, startRequestId: segment.startRequestId, ...(segment.settleRequestId ? { settleRequestId: segment.settleRequestId } : {}), coverage: segment.coverage, ...(segment.receipt ? { receipt: segment.receipt } : {}) });
    if (status === "complete") { total = add(total, segment.receipt.total); parentDelta = add(parentDelta, segment.receipt.parentDelta); subagentTotal = add(subagentTotal, segment.receipt.subagentTotal); subagentRuns = add(subagentRuns, segment.receipt.subagentRuns); }
  }
  const gaps = segments.filter((segment) => segment.coverage !== "complete").map(({ id, coverage: reason }) => ({ id, reason }));
  return { version: 1, ticket, pickedUpAt: state.pickedUpAt, closedAt: state.closedAt, coverage: gaps.length ? "partial" : "complete", total, parentDelta, subagentTotal, subagentRuns, segments, attributionGaps: gaps, evidence: { merged: state.evidence.merged, closed: state.evidence.closed } };
}

/** Local append-only ledger. Adapter supplies authoritative transitions and cost receipts as data. */
export class TicketLifecycleLedger {
  constructor(root, { now = () => new Date(), leaseMs = 30_000 } = {}) { this.root = resolve(root); this.directory = assertContained(this.root, join(this.root, ".pi", "ticket-lifecycle")); this.path = assertContained(this.root, join(this.directory, "events.ndjson")); this.lockPath = assertContained(this.root, join(this.directory, "events.lock")); this.receiptDirectory = assertContained(this.root, join(this.directory, "receipts")); this.now = now; this.leaseMs = leaseMs; }
  async events() { try { return readEvents(await readFile(this.path, "utf8")); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } }
  async snapshot() { return replayTransitions(await this.events()); }
  async append(raw) {
    const event = validateTransition(raw); const handle = await acquire(this.lockPath, this.now(), this.leaseMs);
    try {
      const events = await this.events(); const duplicate = events.find((entry) => entry.eventId === event.eventId);
      if (duplicate) {
        if (JSON.stringify(validateTransition(duplicate)) !== JSON.stringify(event)) fail("duplicate_event_conflict");
        return { appended: false, state: replayTransitions(events).get(event.ticket)?.state };
      }
      replayTransitions([...events, event]);
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
      return { appended: true, state: replayTransitions([...events, event]).get(event.ticket)?.state };
    } finally { await handle.close(); await unlink(this.lockPath).catch(() => {}); }
  }
  async finalize(ticket) {
    cleanTicket(ticket); const state = (await this.snapshot()).get(ticket); if (!state) fail("ticket_not_found"); const receipt = receiptFor(ticket, state);
    await mkdir(this.receiptDirectory, { recursive: true }); const finalPath = assertContained(this.root, join(this.receiptDirectory, `${ticket}.json`));
    try { await lstat(finalPath); const current = JSON.parse(await readFile(finalPath, "utf8")); if (JSON.stringify(current) !== JSON.stringify(receipt)) fail("immutable_receipt_conflict"); return { receipt: current, path: finalPath, published: false }; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const temp = assertContained(this.root, join(this.receiptDirectory, `.${ticket}.${process.pid}.${Date.now()}.tmp`));
    try { await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" }); await rename(temp, finalPath); return { receipt, path: finalPath, published: true }; }
    catch (error) { await rm(temp, { force: true }); if (error?.code === "EEXIST") return this.finalize(ticket); throw error; }
  }
}
