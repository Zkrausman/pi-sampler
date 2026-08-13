import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketLifecycleError, TicketLifecycleLedger, replayTransitions, validateTransition } from "../extensions/ticket-lifecycle/src/index.mjs";

const at = (n) => `2026-01-01T00:00:0${n}.000Z`;
const evidence = (ref) => [{ ref, sha256: "a".repeat(64) }];
const pickup = () => ({ version: 1, eventId: "pickup-123", ticket: "AIDEV-123", at: at(0), action: "pickup" });
const started = (id = "segment-1", session = "session-1", request = "start-1") => ({ version: 1, eventId: `start-${id}`, ticket: "AIDEV-123", at: at(1), action: "segment-start", segment: { id, session, startRequestId: request, coverage: "pending" } });
const settled = (id = "segment-1", session = "session-1", startRequestId = "start-1", coverage = "complete", receipt = { total: 3, parentDelta: 1, subagentTotal: 2, subagentRuns: 1 }) => ({ version: 1, eventId: `settle-${id}`, ticket: "AIDEV-123", at: at(2), action: "segment-settle", segment: { id, session, startRequestId, ...(coverage === "complete" ? { settleRequestId: `settle-request-${id}`, receipt } : {}), coverage } });
const merge = () => ({ version: 1, eventId: "merged-123", ticket: "AIDEV-123", at: at(3), action: "merged", evidence: evidence("merge-123") });
const awaiting = () => ({ version: 1, eventId: "await-123", ticket: "AIDEV-123", at: at(3), action: "awaiting-merge" });
const close = () => ({ version: 1, eventId: "closed-123", ticket: "AIDEV-123", at: at(4), action: "closed", evidence: evidence("close-123") });
async function root(t) { const path = await mkdtemp(join(tmpdir(), "pi-ticket-lifecycle-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function complete(ledger, segments = [settled()]) { await ledger.append(pickup()); for (const segment of segments) { const id = segment.segment.id; await ledger.append(started(id, segment.segment.session, segment.segment.startRequestId)); await ledger.append(segment); } await ledger.append(awaiting()); await ledger.append(merge()); await ledger.append(close()); }

test("v1 contract rejects widened, invalid, and malformed authoritative input", () => {
  assert.equal(validateTransition(pickup()).version, 1);
  for (const value of [{ ...pickup(), version: 2 }, { ...pickup(), ticket: "aidev-123" }, { ...pickup(), action: "closed" }, { ...started(), segment: { ...started().segment, coverage: "complete" } }, { ...settled(), segment: { ...settled().segment, receipt: { total: 3, parentDelta: 2, subagentTotal: 2 } } }, { ...pickup(), tracker: "linear" }]) assert.throws(() => validateTransition(value), TicketLifecycleError);
});

test("replay requires exact state transitions, exact segment correlation, and terminal evidence", () => {
  assert.throws(() => replayTransitions([pickup(), merge()]), /invalid_transition/);
  assert.throws(() => replayTransitions([pickup(), started(), { ...settled(), segment: { ...settled().segment, startRequestId: "other" } }]), /invalid_segment_settlement/);
  assert.throws(() => replayTransitions([pickup(), started("segment-1"), settled("segment-1"), started("segment-2", "session-2", "start-2"), { ...settled("segment-2", "session-2", "start-2"), segment: { ...settled("segment-2", "session-2", "start-2").segment, settleRequestId: "settle-request-segment-1" } }]), /invalid_segment_settlement/);
  assert.throws(() => replayTransitions([pickup(), started(), settled(), awaiting(), merge(), { ...close(), evidence: [] }]), /invalid_evidence/);
});

test("append is idempotent only for an exact retry and rejects conflicting duplicate event IDs", async (t) => {
  const ledger = new TicketLifecycleLedger(await root(t));
  assert.equal((await ledger.append(pickup())).appended, true);
  assert.equal((await ledger.append(pickup())).appended, false);
  await assert.rejects(ledger.append({ ...pickup(), at: at(1) }), /duplicate_event_conflict/);
});

test("concurrent appends serialize one event and preserve the durable ledger", async (t) => {
  const ledger = new TicketLifecycleLedger(await root(t));
  const [left, right] = await Promise.all([ledger.append(pickup()), ledger.append(pickup())]);
  assert.deepEqual([left.appended, right.appended].sort(), [false, true]);
  assert.equal((await ledger.events()).length, 1);
});

test("two session segments aggregate parent and subagent costs into an immutable final receipt", async (t) => {
  const ledger = new TicketLifecycleLedger(await root(t));
  await complete(ledger, [
    settled("segment-1", "session-1", "start-1", "complete", { total: 3, parentDelta: 1, subagentTotal: 2, subagentRuns: 1 }),
    settled("segment-2", "session-2", "start-2", "complete", { total: 7, parentDelta: 4, subagentTotal: 3, subagentRuns: 2 }),
  ]);
  const first = await ledger.finalize("AIDEV-123"); const second = await ledger.finalize("AIDEV-123");
  assert.equal(first.published, true); assert.equal(second.published, false); assert.equal(first.receipt.coverage, "complete");
  assert.deepEqual({ total: first.receipt.total, parent: first.receipt.parentDelta, subagents: first.receipt.subagentTotal, runs: first.receipt.subagentRuns }, { total: 10, parent: 5, subagents: 5, runs: 3 });
  assert.equal(JSON.parse(await readFile(first.path, "utf8")).ticket, "AIDEV-123");
});

test("interrupted, missing receiver, failed settle, and abandoned segments remain explicit partial coverage", async (t) => {
  for (const coverage of ["interrupted", "missing-receiver", "settle-failed", "abandoned"]) {
    const ledger = new TicketLifecycleLedger(await root(t)); await complete(ledger, [settled(`segment-${coverage}`, "session-1", `start-${coverage}`, coverage)]);
    const { receipt } = await ledger.finalize("AIDEV-123"); assert.equal(receipt.coverage, "partial"); assert.deepEqual(receipt.attributionGaps, [{ id: `segment-${coverage}`, reason: coverage }]); assert.equal(receipt.total, 0);
  }
});

test("finalization refuses missing merge/close evidence and unsettled segments", async (t) => {
  const ledger = new TicketLifecycleLedger(await root(t)); await ledger.append(pickup()); await ledger.append(started()); await ledger.append(settled()); await ledger.append(awaiting());
  await assert.rejects(ledger.finalize("AIDEV-123"), /cannot_finalize/);
  await ledger.append(merge()); await assert.rejects(ledger.finalize("AIDEV-123"), /cannot_finalize/);
  await ledger.append(close()); assert.equal((await ledger.finalize("AIDEV-123")).receipt.coverage, "complete");
  const pending = new TicketLifecycleLedger(await root(t)); await pending.append(pickup()); await pending.append(started()); await pending.append(awaiting()); await pending.append(merge()); await assert.rejects(pending.append(close()), /cannot_finalize/);
});
