import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { TicketLifecycleError, TicketLifecycleLedger, MAX_SEGMENTS, acquireLedgerLock, releaseLedgerLock, replayTransitions, validateTransition } from "../extensions/ticket-lifecycle/src/index.mjs";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("../extensions/ticket-lifecycle/", import.meta.url));
const at = (n) => `2026-01-01T00:00:0${n}.000Z`;
const evidence = (ref) => [{ ref, sha256: "a".repeat(64) }];
const pickup = () => ({ version: 1, eventId: "pickup-123", ticket: "AIDEV-123", at: at(0), action: "pickup" });
const started = (id = "segment-1", session = "session-1", request = "start-1") => ({ version: 1, eventId: `start-${id}`, ticket: "AIDEV-123", at: at(1), action: "segment-start", segment: { id, session, startRequestId: request, coverage: "pending" } });
const settled = (id = "segment-1", session = "session-1", startRequestId = "start-1", coverage = "complete", receipt = { total: 3, parentDelta: 1, subagentTotal: 2, subagentRuns: 1 }) => ({ version: 1, eventId: `settle-${id}`, ticket: "AIDEV-123", at: at(2), action: "segment-settle", segment: { id, session, startRequestId, ...(coverage === "complete" ? { settleRequestId: `settle-request-${id}`, receipt } : {}), coverage } });
const awaiting = () => ({ version: 1, eventId: "await-123", ticket: "AIDEV-123", at: at(3), action: "awaiting-merge" });
const merge = () => ({ version: 1, eventId: "merged-123", ticket: "AIDEV-123", at: at(4), action: "merged", evidence: evidence("merge-123") });
const close = () => ({ version: 1, eventId: "closed-123", ticket: "AIDEV-123", at: at(5), action: "closed", evidence: evidence("close-123") });
async function root(t) { const path = await mkdtemp(join(tmpdir(), "pi-ticket-lifecycle-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function complete(ledger, segments = [settled()]) { await ledger.append(pickup()); for (const segment of segments) { const { id, session, startRequestId } = segment.segment; await ledger.append(started(id, session, startRequestId)); await ledger.append(segment); } await ledger.append(awaiting()); await ledger.append(merge()); await ledger.append(close()); }

test("published package root resolves to the documented import entry", async (t) => {
  const require = createRequire(import.meta.url); const manifest = require("../extensions/ticket-lifecycle/package.json"); assert.equal(manifest.exports, "./src/index.mjs");
  const sandbox = await root(t); const installed = join(sandbox, "node_modules", "@zkrausman"); await mkdir(installed, { recursive: true }); await symlink(packageDirectory, join(installed, "pi-ticket-lifecycle"), "junction");
  const probe = join(sandbox, "probe.mjs"); await writeFile(probe, 'import { TicketLifecycleLedger } from "@zkrausman/pi-ticket-lifecycle"; if (typeof TicketLifecycleLedger !== "function") process.exit(1);');
  await execFileAsync(process.execPath, [probe]);
});

test("v1 contract rejects widened, invalid, and malformed authoritative input", () => {
  assert.equal(validateTransition(pickup()).version, 1);
  for (const value of [{ ...pickup(), version: 2 }, { ...pickup(), ticket: "aidev-123" }, { ...pickup(), action: "closed" }, { ...started(), segment: { ...started().segment, coverage: "complete" } }, { ...settled(), segment: { ...settled().segment, receipt: { total: 3, parentDelta: 2, subagentTotal: 2 } } }, { ...pickup(), tracker: "linear" }]) assert.throws(() => validateTransition(value), TicketLifecycleError);
});

test("replay requires exact correlation, correct transitions, and terminal evidence", () => {
  assert.throws(() => replayTransitions([pickup(), merge()]), /invalid_transition/);
  assert.throws(() => replayTransitions([pickup(), started(), { ...settled(), segment: { ...settled().segment, startRequestId: "other" } }]), /invalid_segment_settlement/);
  assert.throws(() => replayTransitions([pickup(), started(), settled(), awaiting(), merge(), { ...close(), evidence: [] }]), /invalid_evidence/);
});

test("start enforces MAX_SEGMENTS before inserting the next segment", () => {
  const events = [pickup()];
  for (let index = 0; index < MAX_SEGMENTS; index++) events.push(started(`segment-${index}`, `session-${index}`, `request-${index}`));
  assert.equal(replayTransitions(events).get("AIDEV-123").segments.size, MAX_SEGMENTS);
  assert.throws(() => replayTransitions([...events, started("segment-over", "session-over", "request-over")]), /too_many_segments/);
});

test("append supports exact retries and concurrent writers fail bounded rather than reclaim locks", async (t) => {
  const directory = await root(t); const ledger = new TicketLifecycleLedger(directory);
  const attempts = await Promise.allSettled([ledger.append(pickup()), ledger.append(pickup())]); assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1); assert.equal(attempts.filter((attempt) => attempt.status === "rejected" && attempt.reason?.code === "ledger_locked").length, 1);
  assert.equal((await ledger.append(pickup())).appended, false); await assert.rejects(ledger.append({ ...pickup(), at: at(1) }), /duplicate_event_conflict/);
  const layout = await ledger.layout(); const owner = await acquireLedgerLock(layout.lockPath); await assert.rejects(ledger.append(started()), /ledger_locked/); assert.equal(await releaseLedgerLock(owner), true);
});

test("lock release verifies ownership and never removes a successor token", async (t) => {
  const directory = await root(t); const lockPath = join(directory, "lock"); const first = await acquireLedgerLock(lockPath);
  await rm(lockPath); const successor = await acquireLedgerLock(lockPath); assert.equal(await releaseLedgerLock(first), false);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, successor.token); assert.equal(await releaseLedgerLock(successor), true);
});

test("atomic journal rewrite recovers only a malformed trailing record and rewrites it on next append", async (t) => {
  const directory = await root(t); const ledger = new TicketLifecycleLedger(directory); await ledger.append(pickup()); const { path } = await ledger.layout();
  await writeFile(path, `${await readFile(path, "utf8")}{\"truncated\"`); assert.deepEqual(await ledger.events(), [validateTransition(pickup())]);
  const result = await ledger.append(started()); assert.equal(result.recovered, true); assert.equal((await ledger.events()).length, 2);
  await writeFile(path, `${JSON.stringify(pickup())}\nnot-json\n${JSON.stringify(started())}\n`); await assert.rejects(ledger.events(), /invalid_ledger/);
});

test("two sessions aggregate costs, and interruption states remain explicit partial gaps", async (t) => {
  const ledger = new TicketLifecycleLedger(await root(t)); await complete(ledger, [settled("segment-1", "session-1", "start-1", "complete", { total: 3, parentDelta: 1, subagentTotal: 2, subagentRuns: 1 }), settled("segment-2", "session-2", "start-2", "complete", { total: 7, parentDelta: 4, subagentTotal: 3, subagentRuns: 2 })]);
  const first = await ledger.finalize("AIDEV-123"); assert.deepEqual({ total: first.receipt.total, parent: first.receipt.parentDelta, subagents: first.receipt.subagentTotal, runs: first.receipt.subagentRuns }, { total: 10, parent: 5, subagents: 5, runs: 3 }); assert.equal((await ledger.finalize("AIDEV-123")).published, false);
  for (const coverage of ["interrupted", "missing-receiver", "settle-failed", "abandoned"]) {
    const partial = new TicketLifecycleLedger(await root(t)); await complete(partial, [settled(coverage, "session-3", `start-${coverage}`, coverage)]); const receipt = (await partial.finalize("AIDEV-123")).receipt; assert.deepEqual(receipt.attributionGaps, [{ id: coverage, reason: coverage }]);
  }
});

test("finalization requires merge/close evidence and settled segments", async (t) => {
  const ledger = new TicketLifecycleLedger(await root(t)); await ledger.append(pickup()); await ledger.append(started()); await ledger.append(settled()); await ledger.append(awaiting()); await assert.rejects(ledger.finalize("AIDEV-123"), /cannot_finalize/); await ledger.append(merge()); await assert.rejects(ledger.finalize("AIDEV-123"), /cannot_finalize/); await ledger.append(close()); assert.equal((await ledger.finalize("AIDEV-123")).receipt.coverage, "complete");
});

test("storage refuses symlinked lifecycle directories and receipt targets", async (t) => {
  const directory = await root(t); const outside = await root(t); await mkdir(join(directory, ".pi")); await symlink(outside, join(directory, ".pi", "ticket-lifecycle"), "junction"); await assert.rejects(new TicketLifecycleLedger(directory).events(), /unsafe_storage_path/);
  const clean = await root(t); const ledger = new TicketLifecycleLedger(clean); await complete(ledger); const layout = await ledger.layout(); await mkdir(layout.receipts); await symlink(join(outside, "receipt.json"), join(layout.receipts, "AIDEV-123.json")); await assert.rejects(ledger.finalize("AIDEV-123"), /unsafe_storage_path/);
});
