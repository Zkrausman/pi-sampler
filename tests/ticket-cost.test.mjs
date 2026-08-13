import assert from "node:assert/strict";
import test from "node:test";
import * as nodeFs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ARTIFACT_DIRECTORY_ENTRIES, TicketCostLifecycle, assistantCostTotal, assistantUsage, majorCostDriverSentence, majorCostDrivers, parseTicketCostArguments,
  receiptMarkdown, scanArtifactMetadata, summarizeCosts, writeReceipt,
} from "../extensions/ticket-cost/src/ticket-cost.mjs";
import ticketCost from "../extensions/ticket-cost/src/ticket-cost.mjs";

async function tempProject() { return mkdtemp(join(tmpdir(), "pi-ticket-cost-")); }
async function artifact(root, name, value, mtime = Date.now()) {
  const directory = join(root, ".pi", "subagents", "artifacts"); await mkdir(directory, { recursive: true });
  const path = join(directory, name); await writeFile(path, value); await utimes(path, mtime / 1000, mtime / 1000); return path;
}

test("parser accepts exactly bounded conservative ticket commands", () => {
  assert.deepEqual(parseTicketCostArguments("begin AIDEV-72"), { action: "begin", ticket: "AIDEV-72" });
  for (const value of ["", "begin A-1", "begin AIDEV-0", "begin aidev-72", "begin AIDEV-72 extra", "status AIDEV-72", "close AIDEV-72 --force"]) assert.throws(() => parseTicketCostArguments(value), /Usage/);
});

test("message filtering only accepts finalized assistant numeric nonnegative cost", () => {
  assert.equal(assistantCostTotal({ message: { role: "assistant", usage: { cost: { total: 1.25 } } } }), 1.25);
  assert.deepEqual(assistantUsage({ message: { role: "assistant", usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 1.25 } } } }), { total: 1.25, tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } });
  for (const event of [{}, { message: { role: "user", usage: { cost: { total: 1 } } } }, { message: { role: "assistant", usage: { cost: { total: -1 } } } }, { message: { role: "assistant", usage: { cost: { total: Infinity } } } }, { message: { role: "assistant", usage: { cost: { total: "1" } } } }]) assert.equal(assistantCostTotal(event), undefined);
});

test("artifact scan is bounded, safe, ordered, windowed, and ignores forbidden siblings", async (t) => {
  const root = await tempProject(); t.after(() => rm(root, { recursive: true, force: true })); const now = Date.now();
  await artifact(root, "z_meta.json", JSON.stringify({ runId: "run-z", agent: "reviewer-2", usage: { cost: { total: 2 } }, model: "forbidden" }), now);
  await artifact(root, "a_meta.json", JSON.stringify({ runId: "run-a", agent: "reviewer-1", usage: { cost: { total: 1 } } }), now);
  await artifact(root, "bad_meta.json", "{not json", now);
  await artifact(root, "outside_meta.json", JSON.stringify({ runId: "old", agent: "old", usage: { cost: { total: 4 } } }), now - 20_000);
  await artifact(root, "oversize_meta.json", "x".repeat(65_537), now);
  await artifact(root, "other.json", JSON.stringify({ runId: "wrong", agent: "wrong", usage: { cost: { total: 9 } } }), now);
  await writeFile(join(root, ".pi", "subagents", "artifacts", "sibling.secret"), "must not be read");
  const records = await scanArtifactMetadata({ cwd: root, startedAt: now - 1_000, endedAt: now + 1_000 });
  assert.deepEqual(records, [{ runId: "run-a", agent: "reviewer-1", cost: 1 }, { runId: "run-z", agent: "reviewer-2", cost: 2 }]);
});

test("artifact scan stops bounded enumeration at the first name over cap and avoids symlink metadata", async (t) => {
  const root = await tempProject(); t.after(() => rm(root, { recursive: true, force: true })); const now = Date.now();
  for (let index = 0; index < 101; index++) await artifact(root, `run-${index}_meta.json`, JSON.stringify({ runId: `run-${index}`, agent: "agent", usage: { cost: { total: 1 } } }), now);
  await assert.rejects(scanArtifactMetadata({ cwd: root, startedAt: now - 1, endedAt: now + 1 }), /safe scan limit/);
  const clean = await tempProject(); t.after(() => rm(clean, { recursive: true, force: true })); await artifact(clean, "target.json", JSON.stringify({ runId: "run", agent: "agent", usage: { cost: { total: 4 } } }), now);
  await symlink(join(clean, ".pi", "subagents", "artifacts", "target.json"), join(clean, ".pi", "subagents", "artifacts", "link_meta.json"));
  assert.deepEqual(await scanArtifactMetadata({ cwd: clean, startedAt: now - 1, endedAt: now + 1 }), []);
  const external = await tempProject(); t.after(() => rm(external, { recursive: true, force: true })); await artifact(external, "external_meta.json", JSON.stringify({ runId: "external", agent: "external", usage: { cost: { total: 9 } } }), now);
  const linked = await tempProject(); t.after(() => rm(linked, { recursive: true, force: true })); await mkdir(join(linked, ".pi", "subagents"), { recursive: true });
  await symlink(join(external, ".pi", "subagents", "artifacts"), join(linked, ".pi", "subagents", "artifacts"));
  assert.deepEqual(await scanArtifactMetadata({ cwd: linked, startedAt: now - 1, endedAt: now + 1 }), []);

  let yielded = 0;
  const boundedFs = { ...await import("node:fs/promises"), opendir: async () => ({
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < 10_000; index++) {
        yielded++;
        yield { name: `unrelated-${index}.log`, isFile: () => true, isSymbolicLink: () => false };
      }
    },
  }) };
  await assert.rejects(scanArtifactMetadata({ cwd: root, startedAt: now - 1, endedAt: now + 1, fs: boundedFs }), /artifact directory reached the safe scan limit/);
  // The cap is checked while streaming: the first entry over it is observed only to detect the limit.
  assert.equal(yielded, MAX_ARTIFACT_DIRECTORY_ENTRIES + 1);
});

test("lifecycle uses in-memory baseline, close failure after reset, and local receipts", async (t) => {
  const root = await tempProject(); t.after(() => rm(root, { recursive: true, force: true })); let now = 1_700_000_000_000; const lifecycle = new TicketCostLifecycle({ now: () => now });
  lifecycle.observeMessage({ message: { role: "assistant", usage: { input: 2, cost: { total: 2 } } } }); lifecycle.begin("AIDEV-72"); lifecycle.observeMessage({ message: { role: "assistant", usage: { input: 3, output: 4, cost: { total: 3 } } } }); now += 100;
  const result = await lifecycle.close("AIDEV-72", root); assert.equal(result.receipt.parentDelta, 3); assert.equal(result.receipt.total, 3); assert.deepEqual(result.receipt.parentTokens, { input: 3, output: 4 });
  assert.match(await readFile(result.markdownPath, "utf8"), /Linear closeout \(paste locally\)/); await assert.rejects(lifecycle.close("AIDEV-72", root), /No active in-memory/);
  lifecycle.begin("AIDEV-73"); lifecycle.reset(); await assert.rejects(lifecycle.close("AIDEV-73", root), /No active in-memory/);
});

test("receipt writes are collision-safe, contained, atomic-style files with deterministic driver order", async (t) => {
  const root = await tempProject(); t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = summarizeCosts({ ticket: "AIDEV-72", startedAt: 0, endedAt: 1_700_000_000_000, parentDelta: 1, records: [{ runId: "b", agent: "zeta", cost: 2 }, { runId: "a", agent: "alpha", cost: 2 }, { runId: "c", agent: "reviewer-1", cost: 1 }] });
  assert.deepEqual(majorCostDrivers(2, [{ agent: "zeta", cost: 2 }, { agent: "alpha", cost: 2 }]), ["1. agent:alpha: $2.000000", "2. agent:zeta: $2.000000", "3. parent: $2.000000"]);
  assert.equal(majorCostDriverSentence(2, [{ agent: "zeta", cost: 2 }, { agent: "alpha", cost: 2 }]), "Major cost driver: agent:alpha at $2.000000.");
  assert.equal(receipt.reviewRounds, 1); const first = await writeReceipt({ cwd: root, receipt }); const second = await writeReceipt({ cwd: root, receipt }); assert.notEqual(first.jsonPath, second.jsonPath);
  assert.equal(JSON.parse(await readFile(first.jsonPath, "utf8")).ticket, "AIDEV-72"); assert.match(receiptMarkdown(receipt), /agent aggregate/i); assert.match(receiptMarkdown(receipt), /Major cost driver: agent:alpha at \$2\.000000\./);
  const unsafe = await tempProject(); t.after(() => rm(unsafe, { recursive: true, force: true })); const target = await tempProject(); t.after(() => rm(target, { recursive: true, force: true }));
  await symlink(target, join(unsafe, ".pi"), "junction"); await assert.rejects(writeReceipt({ cwd: unsafe, receipt }), /symbolic/);
});

test("receipt publication is an atomic completed directory and second-file or publication failure exposes no receipt", async (t) => {
  const root = await tempProject(); t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = summarizeCosts({ ticket: "AIDEV-72", startedAt: 0, endedAt: 1_700_000_000_000, parentDelta: 1, records: [] });
  const secondFileFailureFs = { ...nodeFs, open: async (path, flags, ...rest) => {
    if (String(path).endsWith("receipt.md") && flags === "wx") throw new Error("injected second receipt file failure");
    return nodeFs.open(path, flags, ...rest);
  } };
  await assert.rejects(writeReceipt({ cwd: root, receipt, fs: secondFileFailureFs }), /injected second receipt file failure/);
  const output = join(root, ".pi", "ticket-costs");
  assert.deepEqual(await readdir(output), []);
  const publicationFailureFs = { ...nodeFs, rename: async (from, to) => {
    if (to.endsWith("AIDEV-72-2023-11-14T22-13-20-000Z")) throw new Error("injected publication crash");
    return nodeFs.rename(from, to);
  } };
  await assert.rejects(writeReceipt({ cwd: root, receipt, fs: publicationFailureFs }), /injected publication crash/);
  assert.deepEqual(await readdir(output), []);
  const published = await writeReceipt({ cwd: root, receipt });
  assert.match(published.jsonPath, /\.pi[\\/]ticket-costs[\\/]AIDEV-72-/);
  assert.equal(JSON.parse(await readFile(published.jsonPath, "utf8")).total, 1);
  assert.match(await readFile(published.markdownPath, "utf8"), /Total: \$1\.000000/);
});

test("close snapshots parent costs before asynchronous artifact scanning", async (t) => {
  const root = await tempProject(); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(join(root, ".pi", "subagents", "artifacts"), { recursive: true }); let now = 1_700_000_000_000;
  let scanStarted; const scanning = new Promise((resolve) => { scanStarted = resolve; });
  let releaseScan; const released = new Promise((resolve) => { releaseScan = resolve; });
  const delayedFs = { ...nodeFs, opendir: async (...args) => { scanStarted(); await released; return nodeFs.opendir(...args); } };
  const lifecycle = new TicketCostLifecycle({ now: () => now, fs: delayedFs });
  lifecycle.begin("AIDEV-72"); lifecycle.observeMessage({ message: { role: "assistant", usage: { input: 2, cost: { total: 2 } } } }); now += 100;
  const closing = lifecycle.close("AIDEV-72", root); await scanning;
  lifecycle.observeMessage({ message: { role: "assistant", usage: { input: 3, cost: { total: 3 } } } });
  releaseScan();
  const result = await closing;
  assert.equal(result.receipt.parentDelta, 2);
  assert.deepEqual(result.receipt.parentTokens, { input: 2 });
});

test("reset during pending asynchronous close prevents stale receipt publication", async (t) => {
  const root = await tempProject(); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(join(root, ".pi", "subagents", "artifacts"), { recursive: true }); let now = 1_700_000_000_000;
  let scanStarted; const scanning = new Promise((resolve) => { scanStarted = resolve; });
  let releaseScan; const released = new Promise((resolve) => { releaseScan = resolve; });
  const delayedFs = { ...nodeFs, opendir: async (...args) => { scanStarted(); await released; return nodeFs.opendir(...args); } };
  const lifecycle = new TicketCostLifecycle({ now: () => now, fs: delayedFs });
  lifecycle.begin("AIDEV-72"); lifecycle.observeMessage({ message: { role: "assistant", usage: { cost: { total: 2 } } } }); now += 100;
  const closing = lifecycle.close("AIDEV-72", root); await scanning;
  lifecycle.reset(); releaseScan();
  await assert.rejects(closing, /window changed while receipt was closing/);
  await assert.rejects(readdir(join(root, ".pi", "ticket-costs")), { code: "ENOENT" });
});

test("lifecycle serializes close transitions and preserves reset generation", async (t) => {
  const root = await tempProject(); t.after(() => rm(root, { recursive: true, force: true })); let now = 1_700_000_000_000;
  const lifecycle = new TicketCostLifecycle({ now: () => now }); lifecycle.begin("AIDEV-72");
  const first = lifecycle.close("AIDEV-72", root);
  await assert.rejects(lifecycle.close("AIDEV-72", root), /already closing/);
  assert.throws(() => lifecycle.begin("AIDEV-73"), /is closing/);
  lifecycle.reset();
  await assert.rejects(first, /window changed while receipt was closing/);
  await assert.rejects(lifecycle.close("AIDEV-72", root), /No active in-memory/);
  lifecycle.begin("AIDEV-73"); now += 1;
  await lifecycle.close("AIDEV-73", root);
  assert.equal((await readdir(join(root, ".pi", "ticket-costs"))).filter((name) => !name.startsWith(".")).length, 1);
});

test("unsafe numeric observations and aggregate overflow fail closed", async (t) => {
  const root = await tempProject(); t.after(() => rm(root, { recursive: true, force: true })); const now = Date.now();
  await artifact(root, "unsafe_meta.json", JSON.stringify({ runId: "run", agent: "agent", usage: { cost: { total: null } } }), now);
  await assert.rejects(scanArtifactMetadata({ cwd: root, startedAt: now - 1, endedAt: now + 1 }), /Unsafe or out-of-range/);
  assert.throws(() => summarizeCosts({ ticket: "AIDEV-72", startedAt: 0, endedAt: 1, parentDelta: Number.MAX_SAFE_INTEGER, records: [{ runId: "a", agent: "agent", cost: 1 }] }), /Unsafe or out-of-range/);
  const lifecycle = new TicketCostLifecycle(); lifecycle.begin("AIDEV-72");
  lifecycle.observeMessage({ message: { role: "assistant", usage: { cost: { total: Infinity } } } });
  await assert.rejects(lifecycle.close("AIDEV-72", root), /Unsafe or out-of-range/);
  await assert.rejects(writeReceipt({ cwd: root, receipt: { ticket: "AIDEV-72", parentDelta: Infinity } }), /Unsafe or out-of-range/);
});

test("trust gate prevents untrusted command, message accounting, and filesystem action", async () => {
  const listeners = new Map(); let command; const notices = [];
  ticketCost({ on: (name, handler) => listeners.set(name, handler), registerCommand: (_name, entry) => { command = entry; } });
  const context = { cwd: "never-read", isProjectTrusted: () => false, ui: { notify: (...args) => notices.push(args) } };
  await listeners.get("message_end")({ message: { role: "assistant", usage: { cost: { total: 99 } } } }, context);
  await command.handler("close AIDEV-72", context);
  assert.match(notices[0][0], /trusted project/); assert.equal(notices.length, 1);
});

test("manifest declares a standalone extension with only Pi peer dependency", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extensions/ticket-cost/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "@zkrausman/pi-ticket-cost"); assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]); assert.deepEqual(Object.keys(manifest.peerDependencies), ["@earendil-works/pi-coding-agent"]); assert.equal(manifest.dependencies, undefined);
});
