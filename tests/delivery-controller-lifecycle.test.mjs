import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryTicketLifecycleAdapter } from "../extensions/delivery-controller/src/ticket-lifecycle-adapter.mjs";

async function project(t) { const root = await mkdtemp(join(tmpdir(), "pi-delivery-lifecycle-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function manifest(root) { const dir = join(root, ".pi", "delivery-controller", "work-items"); await mkdir(dir, { recursive: true }); await writeFile(join(dir, "AIDEV-77.json"), JSON.stringify({ version: 1, ticket: "AIDEV-77", workItem: { id: "AIDEV-77", source: "sources/local", branch: "feature/77", baseRef: "main", verificationContract: "test", instructions: ["do work"] } })); }
async function attestation(root, kind) { const dir = join(root, ".pi", "delivery-controller", "attestations"); await mkdir(dir, { recursive: true }); await writeFile(join(dir, `AIDEV-77-${kind}.json`), JSON.stringify({ version: 1, ticket: "AIDEV-77", kind, ref: `${kind}-77`, source: "local-operator-attestation", evidence: { assertion: true } })); }
function bus() { const listeners = new Map(); return { on(name, handler) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); }, emit(name, value) { for (const handler of listeners.get(name) ?? []) handler(value); } }; }
function adapter(root, events, timeoutMs = 20) { return new DeliveryTicketLifecycleAdapter({ pi: { events }, cwd: root, sessionId: "session-77", timeoutMs, clock: () => "2026-01-01T00:00:00.000Z" }); }
function costSuccess(events) { events.on("ticket-cost:v1:lifecycle", (signal) => events.emit("ticket-cost:v1:lifecycle-result", signal.action === "begin" ? { version: 1, requestId: signal.requestId, action: "begin", ticket: signal.ticket, ok: true } : { version: 1, requestId: signal.requestId, action: "close", ticket: signal.ticket, ok: true, receipt: { total: 3, parentDelta: 1, subagentTotal: 2, subagentRuns: 1 } })); }

async function started(t, options = {}) { const root = await project(t); await manifest(root); const events = bus(); if (options.receiver !== false) costSuccess(events); const value = adapter(root, events, options.timeoutMs); const record = await value.pickup("AIDEV-77"); await value.start(record.handle); return { root, events, value, record }; }

test("pickup materializes durable authority then dispatch resolves only its immutable work item", async (t) => {
  const root = await project(t); await manifest(root); const value = adapter(root, bus()); const record = await value.pickup("AIDEV-77"); assert.deepEqual(await value.dispatchWorkItem(record.handle), { id: "AIDEV-77", source: "sources/local", branch: "feature/77", baseRef: "main", verificationContract: "test", instructions: ["do work"] });
  assert.equal(typeof value.dispatch, "undefined"); const raw = await readFile(new URL("../extensions/delivery-controller/src/index.ts", import.meta.url), "utf8"); assert.match(raw, /lifecycleHandle/); assert.equal(/item:\s*workItem/.test(raw), false);
});

test("happy path settles exact results and finalizes only local operator attestations", async (t) => {
  const { root, value, record } = await started(t); await value.settle(record.handle); await value.awaitingMerge(record.handle); await attestation(root, "merged"); await value.attest(record.handle, "merged"); await attestation(root, "closed"); await value.attest(record.handle, "closed"); const receipt = JSON.parse(await readFile(join(root, ".pi", "ticket-lifecycle", "receipts", "AIDEV-77.json"), "utf8")); assert.equal(receipt.total, 3); assert.equal(receipt.coverage, "complete");
});

test("receiver error is settle-failed, while deadline stays unsettled and delayed result cannot create missing-receiver", async (t) => {
  const root = await project(t); await manifest(root); const events = bus(); events.on("ticket-cost:v1:lifecycle", (s) => events.emit("ticket-cost:v1:lifecycle-result", { version: 1, requestId: s.requestId, action: s.action, ticket: s.ticket, ok: false })); const failed = adapter(root, events); const picked = await failed.pickup("AIDEV-77"); await failed.start(picked.handle); assert.equal((await failed.load(picked.handle)).segment.coverage, "settle-failed");
  const timeoutRoot = await project(t); await manifest(timeoutRoot); const delayedEvents = bus(); let signal; delayedEvents.on("ticket-cost:v1:lifecycle", (s) => { signal = s; }); const timeout = adapter(timeoutRoot, delayedEvents, 5); const pending = await timeout.pickup("AIDEV-77"); await assert.rejects(timeout.start(pending.handle), /ticket_cost_timeout/); assert.equal((await timeout.load(pending.handle)).segment.coverage, "pending"); delayedEvents.emit("ticket-cost:v1:lifecycle-result", { version: 1, requestId: signal.requestId, action: "begin", ticket: "AIDEV-77", ok: true }); assert.equal((await timeout.load(pending.handle)).segment.coverage, "pending");
});

test("startup replay completes prior intent and reconciles pending segments as interrupted", async (t) => {
  const { root, value, record } = await started(t); const authority = join(root, ".pi", "delivery-controller", "lifecycle-authority", `${record.handle}.json`); const stored = JSON.parse(await readFile(authority, "utf8")); stored.intent = { event: { version: 1, eventId: `lifecycle-${record.handle}-segment-settle`, ticket: "AIDEV-77", at: "2026-01-01T00:00:00.000Z", action: "segment-settle", segment: { id: stored.segment.id, session: stored.segment.session, startRequestId: stored.segment.startRequestId, coverage: "interrupted" } }, nextState: "active", nextSegment: { id: stored.segment.id, session: stored.segment.session, startRequestId: stored.segment.startRequestId, coverage: "interrupted" } }; await writeFile(authority, JSON.stringify(stored)); const restarted = adapter(root, bus()); await restarted.reconcile(); assert.equal((await restarted.load(record.handle)).segment.coverage, "interrupted");
});

test("parent symlinks, invalid attestations, and model lifecycle tools fail closed", async (t) => {
  const root = await project(t); const outside = await project(t); await mkdir(join(root, ".pi")); await symlink(outside, join(root, ".pi", "delivery-controller"), "junction"); await assert.rejects(adapter(root, bus()).pickup("AIDEV-77"), /unsafe_authority_path/);
  const clean = await started(t); await clean.value.settle(clean.record.handle); await clean.value.awaitingMerge(clean.record.handle); await assert.rejects(clean.value.attest(clean.record.handle, "merged"), /ENOENT/); const source = await readFile(new URL("../extensions/delivery-controller/src/index.ts", import.meta.url), "utf8"); assert.match(source, /registerCommand\("ticket-lifecycle-pickup"/); assert.equal(/name:\s*["']ticket.lifecycle/.test(source), false);
});
