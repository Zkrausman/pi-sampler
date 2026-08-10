import { appendFile, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export const States = Object.freeze([
  "requested", "dispatched", "implementation-ready", "review-requested",
  "changes-requested", "merge-ready", "merged", "failed", "human-escalated",
]);
const TERMINAL = new Set(["merged", "failed", "human-escalated"]);
const NEXT = new Map([
  ["requested", new Set(["dispatched", "human-escalated", "failed"])],
  ["dispatched", new Set(["implementation-ready", "human-escalated", "failed"])],
  ["implementation-ready", new Set(["review-requested", "human-escalated", "failed"])],
  ["review-requested", new Set(["changes-requested", "merge-ready", "human-escalated", "failed"])],
  ["changes-requested", new Set(["dispatched", "human-escalated", "failed"])],
  ["merge-ready", new Set(["merged", "human-escalated", "failed"])],
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const SAFE_CATEGORY = /^[a-z][a-z0-9_-]{0,63}$/;

export class LedgerError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new LedgerError(code); };

function cleanID(value, field) { if (typeof value !== "string" || !ID.test(value)) fail(`invalid_${field}`); return value; }
function cleanTimestamp(value) { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail("invalid_timestamp"); return value; }
function cleanEvidence(value) {
  if (!Array.isArray(value) || value.length > 32) fail("invalid_evidence");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Object.keys(entry).some((key) => key !== "ref" && key !== "sha256")) fail("invalid_evidence");
    if (typeof entry.ref !== "string" || !ID.test(entry.ref) || !SHA.test(entry.sha256)) fail("invalid_evidence");
    return { ref: entry.ref, sha256: entry.sha256 };
  });
}
export function validateEvent(event) {
  if (!event || typeof event !== "object") fail("invalid_event");
  if (Object.keys(event).some((key) => !["event_id", "job_id", "at", "state", "outcome", "evidence", "error_category"].includes(key))) fail("invalid_event_field");
  const state = event.state;
  if (!States.includes(state)) fail("invalid_state");
  const normalized = { event_id: cleanID(event.event_id, "event_id"), job_id: cleanID(event.job_id, "job_id"), at: cleanTimestamp(event.at), state, outcome: cleanID(event.outcome, "outcome"), evidence: cleanEvidence(event.evidence ?? []) };
  if (event.error_category !== undefined) {
    if (typeof event.error_category !== "string" || !SAFE_CATEGORY.test(event.error_category)) fail("invalid_error_category");
    normalized.error_category = event.error_category;
  }
  if (state === "human-escalated" && event.outcome === "cancellation-uncertain" && normalized.error_category !== "cancellation_uncertain") fail("cancellation_must_escalate");
  return normalized;
}
export function transitionAllowed(from, to) { return from === undefined ? to === "requested" : !TERMINAL.has(from) && NEXT.get(from)?.has(to) === true; }
export function replay(events) {
  const jobs = new Map(); const eventIDs = new Set();
  for (const raw of events) {
    const event = validateEvent(raw);
    if (eventIDs.has(event.event_id)) continue; // duplicate delivery is idempotent
    eventIDs.add(event.event_id);
    const previous = jobs.get(event.job_id);
    if (!transitionAllowed(previous?.state, event.state)) fail("invalid_transition");
    jobs.set(event.job_id, { state: event.state, event_id: event.event_id, at: event.at, evidence: event.evidence, error_category: event.error_category });
  }
  return jobs;
}
async function readEvents(path) {
  try { const text = await readFile(path, "utf8"); return text.trim() === "" ? [] : text.trim().split("\n").map((line) => JSON.parse(line)); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}
async function acquire(lockPath, leaseMs, now) {
  await mkdir(dirname(lockPath), { recursive: true });
  try { const handle = await open(lockPath, "wx"); await handle.writeFile(JSON.stringify({ acquired_at: now.toISOString(), lease_ms: leaseMs })); return handle; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const lock = await stat(lockPath); if (now.getTime() - lock.mtimeMs <= leaseMs) fail("ledger_locked");
    await unlink(lockPath).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
    return acquire(lockPath, leaseMs, now);
  }
}
export class JobLedger {
  constructor(root, { leaseMs = 30_000, now = () => new Date() } = {}) { this.path = join(root, "jobs.ndjson"); this.lockPath = join(root, "jobs.lock"); this.leaseMs = leaseMs; this.now = now; }
  async snapshot() { return replay(await readEvents(this.path)); }
  async append(raw) {
    const event = validateEvent(raw); const handle = await acquire(this.lockPath, this.leaseMs, this.now());
    try {
      const events = await readEvents(this.path);
      if (events.some((current) => current.event_id === event.event_id)) return { appended: false, state: replay(events).get(event.job_id) };
      const jobs = replay(events); const current = jobs.get(event.job_id);
      if (!transitionAllowed(current?.state, event.state)) fail("invalid_transition");
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
      return { appended: true, state: { state: event.state, event_id: event.event_id, at: event.at, evidence: event.evidence, error_category: event.error_category } };
    } finally { await handle.close(); await unlink(this.lockPath).catch(() => {}); }
  }
}
