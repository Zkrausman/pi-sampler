import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryTicketLifecycleAdapter } from "../extensions/delivery-controller/src/ticket-lifecycle-adapter.mjs";

async function project(t) { const root = await mkdtemp(join(tmpdir(), "pi-delivery-lifecycle-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function writeJson(path, value) { await mkdir(join(path, ".."), { recursive: true }).catch(() => {}); await writeFile(path, `${JSON.stringify(value)}\n`); }
async function manifest(root) { const path = join(root, ".pi", "delivery-controller", "work-items"); await mkdir(path, { recursive: true }); await writeFile(join(path, "AIDEV-77.json"), JSON.stringify({ version: 1, ticket: "AIDEV-77", workItem: { bounded: true } })); }
async function attestation(root, kind, value = { ok: true }) { const path = join(root, ".pi", "delivery-controller", "attestations"); await mkdir(path, { recursive: true }); await writeFile(join(path, `AIDEV-77-${kind}.json`), JSON.stringify({ version: 1, ticket: "AIDEV-77", kind, ref: `${kind}-77`, evidence: value })); }
function bus() { const listeners = new Map(); return { on(name, handler) { const values = listeners.get(name) ?? new Set(); values.add(handler); listeners.set(name, values); return () => values.delete(handler); }, emit(name, value) { for (const handler of listeners.get(name) ?? []) handler(value); } }; }
function piWith(handler) { const events = bus(); events.on("ticket-cost:v1:lifecycle", handler(events)); return { events }; }
function success(events) { return (signal) => { if (signal.action === "begin") events.emit("ticket-cost:v1:lifecycle-result", { version: 1, requestId: signal.requestId, action: "begin", ticket: signal.ticket, ok: true }); else events.emit("ticket-cost:v1:lifecycle-result", { version: 1, requestId: signal.requestId, action: "close", ticket: signal.ticket, ok: true, receipt: { total: 3, parentDelta: 1, subagentTotal: 2, subagentRuns: 1 } }); }; }
function adapter(pi, root, timeoutMs = 15) { return new DeliveryTicketLifecycleAdapter({ pi, cwd: root, sessionId: "session-77", timeoutMs, clock: () => "2026-01-01T00:00:00.000Z" }); }

test("host-only happy path persists pickup authority before lifecycle transitions and finalizes", async (t) => {
  const root = await project(t); await manifest(root); const events = bus(); const pi = { events }; events.on("ticket-cost:v1:lifecycle", success(events)); const value = adapter(pi, root); const picked = await value.pickup("AIDEV-77"); assert.match(picked.handle, /^hdl-/);
  const authority = JSON.parse(await readFile(join(root, ".pi", "delivery-controller", "lifecycle-authority", `${picked.handle}.json`), "utf8")); assert.equal(authority.state, "picked-up");
  await value.start(picked.handle); await value.settle(picked.handle); await value.awaitingMerge(picked.handle); await attestation(root, "merged"); await value.attest(picked.handle, "merged"); await attestation(root, "closed"); await value.attest(picked.handle, "closed");
  const receipt = JSON.parse(await readFile(join(root, ".pi", "ticket-lifecycle", "receipts", "AIDEV-77.json"), "utf8")); assert.equal(receipt.total, 3); assert.equal(receipt.coverage, "complete");
});

test("missing receiver and close failure settle explicit coverage gaps", async (t) => {
  for (const expected of ["missing-receiver", "settle-failed"]) { const root = await project(t); await manifest(root); const events = bus(); const pi = { events }; events.on("ticket-cost:v1:lifecycle", (signal) => { if (expected === "settle-failed") events.emit("ticket-cost:v1:lifecycle-result", { version: 1, requestId: signal.requestId, action: signal.action, ticket: signal.ticket, ok: false }); }); const value = adapter(pi, root); const picked = await value.pickup("AIDEV-77"); await value.start(picked.handle); const record = await value.load(picked.handle); assert.equal(record.segment.coverage, expected); }
});

test("correlation ignores mismatched cost results and shutdown interrupts pending work", async (t) => {
  const root = await project(t); await manifest(root); const events = bus(); const pi = { events }; events.on("ticket-cost:v1:lifecycle", (signal) => events.emit("ticket-cost:v1:lifecycle-result", { version: 1, requestId: `${signal.requestId}-wrong`, action: signal.action, ticket: signal.ticket, ok: true })); const value = adapter(pi, root); const picked = await value.pickup("AIDEV-77"); await value.start(picked.handle); assert.equal((await value.load(picked.handle)).segment.coverage, "missing-receiver");
  const root2 = await project(t); await manifest(root2); const pendingPi = { events: bus() }; let beginObserved; const beginSeen = new Promise((resolve) => { beginObserved = resolve; }); pendingPi.events.on("ticket-cost:v1:lifecycle", (signal) => { if (signal.action === "begin") beginObserved(); }); const pending = adapter(pendingPi, root2, 1_000); const second = await pending.pickup("AIDEV-77"); const work = pending.start(second.handle); await beginSeen; await pending.interruptPending(); await work.catch(() => {}); assert.equal((await pending.load(second.handle)).segment.coverage, "interrupted");
});

test("reference adapter registers no model lifecycle tool and host commands trust-gate", async (t) => {
  const source = await readFile(new URL("../extensions/delivery-controller/src/index.ts", import.meta.url), "utf8");
  assert.match(source, /registerCommand\("ticket-lifecycle-pickup"/); assert.match(source, /if \(!commandCtx\.isProjectTrusted\(\)\)/);
  assert.equal(/name:\s*["']ticket.lifecycle/.test(source), false);
});

test("invalid/missing attestations and missing manifest fail closed; adapter has no dispatch integration", async (t) => {
  const root = await project(t); const value = adapter({ events: bus() }, root); await assert.rejects(value.pickup("AIDEV-77"), /invalid_work_item_manifest|ENOENT/); await manifest(root); const picked = await value.pickup("AIDEV-77"); await value.start(picked.handle); await value.awaitingMerge(picked.handle); await assert.rejects(value.attest(picked.handle, "merged"), /ENOENT/);
  assert.equal(typeof value.dispatch, "undefined");
});
