import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TicketLifecycleLedger } from "@zkrausman/pi-ticket-lifecycle";

const TICKET = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/;
const HANDLE = /^hdl-[a-f0-9]{24}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMEOUT_MS = 5_000;
const COST_EVENT = "ticket-cost:v1:lifecycle";
const COST_RESULT = "ticket-cost:v1:lifecycle-result";
const safe = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function ticket(value) { if (typeof value !== "string" || !TICKET.test(value)) fail("invalid_ticket"); return value; }
function handle(value) { if (typeof value !== "string" || !HANDLE.test(value)) fail("invalid_handle"); return value; }
function contained(root, candidate) { const resolved = resolve(candidate); if (!resolved.startsWith(`${root}/`) && !resolved.startsWith(`${root}\\`) && resolved !== root) fail("path_escaped"); return resolved; }
async function regular(path, missing = false) { try { const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink()) fail("unsafe_authority_path"); return entry; } catch (error) { if (missing && error?.code === "ENOENT") return undefined; throw error; } }
async function jsonFile(path, missing = false) { if (!(await regular(path, missing))) return undefined; try { return JSON.parse(await readFile(path, "utf8")); } catch { fail("invalid_authority_json"); } }
function exact(value, keys, code) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail(code); return value; }
function attestation(value, expectedTicket, kind) {
  exact(value, ["version", "ticket", "kind", "ref", "evidence"], "invalid_attestation");
  if (value.version !== 1 || value.ticket !== expectedTicket || value.kind !== kind || typeof value.ref !== "string" || !ID.test(value.ref)) fail("invalid_attestation");
  const serialized = JSON.stringify(value.evidence); if (serialized === undefined || Buffer.byteLength(serialized) > 16_384) fail("invalid_attestation");
  return [{ ref: value.ref, sha256: digest(value.evidence) }];
}
function receipt(value) {
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => !["total", "parentDelta", "subagentTotal", "subagentRuns"].includes(key)) || !safe(value.total) || !safe(value.parentDelta) || !safe(value.subagentTotal) || value.total !== value.parentDelta + value.subagentTotal || !Number.isSafeInteger(value.subagentRuns) || value.subagentRuns < 0) fail("invalid_cost_receipt");
  return { total: value.total, parentDelta: value.parentDelta, subagentTotal: value.subagentTotal, subagentRuns: value.subagentRuns };
}

/** Host/human-only reference adapter. It deliberately registers no model-callable lifecycle tool. */
export class DeliveryTicketLifecycleAdapter {
  constructor({ pi, cwd, sessionId = "session-local", timeoutMs = TIMEOUT_MS, clock = now } = {}) { this.pi = pi; this.cwd = resolve(cwd); this.sessionId = sessionId; this.timeoutMs = timeoutMs; this.clock = clock; this.ledger = new TicketLifecycleLedger(this.cwd); this.pendingWaits = new Set(); this.interrupting = false; }
  authorityDirectory() { return contained(this.cwd, join(this.cwd, ".pi", "delivery-controller", "lifecycle-authority")); }
  manifestPath(value) { return contained(this.cwd, join(this.cwd, ".pi", "delivery-controller", "work-items", `${ticket(value)}.json`)); }
  attestationPath(value, kind) { return contained(this.cwd, join(this.cwd, ".pi", "delivery-controller", "attestations", `${ticket(value)}-${kind}.json`)); }
  authorityPath(value) { return contained(this.cwd, join(this.authorityDirectory(), `${handle(value)}.json`)); }
  async save(record) { const directory = this.authorityDirectory(); await mkdir(directory, { recursive: true }); const entry = await lstat(directory); if (!entry.isDirectory() || entry.isSymbolicLink()) fail("unsafe_authority_path"); const path = this.authorityPath(record.handle); await regular(path, true); const temporary = contained(directory, join(directory, `.${randomUUID()}.tmp`)); await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" }); try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; } }
  async load(value) { const record = await jsonFile(this.authorityPath(value)); exact(record, ["version", "handle", "ticket", "manifestDigest", "state", "segment"], "invalid_authority_record"); if (record.version !== 1 || record.handle !== handle(value) || !TICKET.test(record.ticket) || typeof record.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.manifestDigest) || !["picked-up", "active", "awaiting-merge", "merged", "closed"].includes(record.state)) fail("invalid_authority_record"); return record; }
  async transition(record, action, extra = {}) { await this.save({ ...record, ...extra }); await this.ledger.append({ version: 1, eventId: `lifecycle-${record.handle}-${action}`, ticket: record.ticket, at: this.clock(), action, ...extra.lifecycle }); return this.load(record.handle); }
  async pickup(value) {
    const ticketId = ticket(value); const manifest = await jsonFile(this.manifestPath(ticketId)); exact(manifest, ["version", "ticket", "workItem"], "invalid_work_item_manifest"); if (manifest.version !== 1 || manifest.ticket !== ticketId || !manifest.workItem || typeof manifest.workItem !== "object") fail("invalid_work_item_manifest");
    const record = { version: 1, handle: `hdl-${randomUUID().replaceAll("-", "").slice(0, 24)}`, ticket: ticketId, manifestDigest: digest(manifest), state: "picked-up" };
    await this.save(record); await this.ledger.append({ version: 1, eventId: `lifecycle-${record.handle}-pickup`, ticket: ticketId, at: this.clock(), action: "pickup" }); return record;
  }
  waitForResult(requestId, action, ticketId) { return new Promise((resolveResult) => {
    let done = false; let timer; let unsubscribe; const finish = (result) => { if (done) return; done = true; clearTimeout(timer); if (typeof unsubscribe === "function") unsubscribe(); this.pendingWaits.delete(finish); resolveResult(result); };
    this.pendingWaits.add(finish); unsubscribe = this.pi.events?.on?.(COST_RESULT, (result) => { if (result?.version === 1 && result.requestId === requestId && result.action === action && result.ticket === ticketId) finish(result); });
    timer = setTimeout(() => finish(undefined), this.timeoutMs);
  }); }
  cancelPendingWaits() { for (const finish of [...this.pendingWaits]) finish(undefined); }
  async request(requestId, action, ticketId) { const waiting = this.waitForResult(requestId, action, ticketId); this.pi.events?.emit?.(COST_EVENT, { version: 1, requestId, action, ticket: ticketId }); return waiting; }
  async start(value) {
    const record = await this.load(value); if (record.state !== "picked-up") fail("start_not_allowed"); const segment = { id: `segment-${record.handle}`, session: this.sessionId, startRequestId: `cost-begin-${record.handle}`, coverage: "pending" };
    await this.save({ ...record, state: "active", segment }); await this.ledger.append({ version: 1, eventId: `lifecycle-${record.handle}-segment-start`, ticket: record.ticket, at: this.clock(), action: "segment-start", segment });
    const result = await this.request(segment.startRequestId, "begin", record.ticket);
    const current = await this.load(record.handle);
    if (current.segment?.coverage !== "pending" || this.interrupting) return current; // shutdown/reload owns interruption settlement
    if (result?.ok === true) return current;
    return this.settle(record.handle, result ? "settle-failed" : "missing-receiver", undefined, true);
  }
  async settle(value, forcedCoverage, forcedReceipt, beginFailure = false) {
    const record = await this.load(value); if (record.state !== "active" || !record.segment || record.segment.coverage !== "pending") fail("settle_not_allowed"); let coverage = forcedCoverage; let settledReceipt = forcedReceipt;
    if (!coverage) { const requestId = `cost-close-${record.handle}`; const result = await this.request(requestId, "close", record.ticket); if (!result) coverage = "missing-receiver"; else if (result.ok !== true) coverage = "settle-failed"; else { coverage = "complete"; settledReceipt = receipt(result.receipt); record.segment.settleRequestId = requestId; } }
    const segment = { ...record.segment, coverage, ...(coverage === "complete" ? { settleRequestId: record.segment.settleRequestId, receipt: settledReceipt } : {}) }; await this.save({ ...record, segment }); await this.ledger.append({ version: 1, eventId: `lifecycle-${record.handle}-segment-settle`, ticket: record.ticket, at: this.clock(), action: "segment-settle", segment }); return this.load(record.handle);
  }
  async awaitingMerge(value) { const record = await this.load(value); if (record.state !== "active" || !record.segment || record.segment.coverage === "pending") fail("awaiting_merge_not_allowed"); await this.save({ ...record, state: "awaiting-merge" }); await this.ledger.append({ version: 1, eventId: `lifecycle-${record.handle}-awaiting-merge`, ticket: record.ticket, at: this.clock(), action: "awaiting-merge" }); return this.load(record.handle); }
  async attest(value, kind) { const record = await this.load(value); const expected = kind === "merged" ? "awaiting-merge" : "merged"; if (record.state !== expected) fail("attestation_not_allowed"); const evidence = attestation(await jsonFile(this.attestationPath(record.ticket, kind)), record.ticket, kind); const state = kind === "merged" ? "merged" : "closed"; await this.save({ ...record, state }); await this.ledger.append({ version: 1, eventId: `lifecycle-${record.handle}-${kind}`, ticket: record.ticket, at: this.clock(), action: kind, evidence }); if (kind === "closed") await this.ledger.finalize(record.ticket); return this.load(record.handle); }
  async interruptPending() { this.interrupting = true; this.cancelPendingWaits(); const files = await (async () => { try { return await (await import("node:fs/promises")).readdir(this.authorityDirectory()); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } })(); for (const name of files) { if (!/^hdl-[a-f0-9]{24}\.json$/.test(name)) continue; const record = await this.load(name.slice(0, -5)); if (record.state === "active" && record.segment?.coverage === "pending") await this.settle(record.handle, "interrupted", undefined, true); } }
}
