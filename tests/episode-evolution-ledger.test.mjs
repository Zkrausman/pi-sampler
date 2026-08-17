import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TICKET_EPISODE_V1_SCHEMA_ID, TICKET_EPISODE_V1_SCHEMA_VERSION } from "../contracts/ticket-episode-v1.mjs";
import { EpisodeEvolutionLedger, InjectedFaultError, LedgerConflictError, LedgerError, LedgerLimitError } from "../ledgers/episode-evolution-ledger.mjs";

async function withLedger(options, body) { const root = await mkdtemp(join(tmpdir(), "episode-ledger-")); let ledger; try { ledger = await EpisodeEvolutionLedger.open({ root, ...options }); await body(ledger, root); } finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); } }
function record(overrides = {}) { const base = { schema: { id: TICKET_EPISODE_V1_SCHEMA_ID, version: TICKET_EPISODE_V1_SCHEMA_VERSION }, project: { id: "pi-sampler" }, repository: { id: "github.com/Zkrausman/pi-sampler", revision: "a".repeat(40) }, ticket: { system: "linear", id: "AIDEV-124" }, episode: { id: "episode-1" }, attempt: { id: "attempt-1" }, session: { id: "session-1" }, agentRun: { agentId: "agent-1", runId: "run-1" }, event: { id: "event-1", kind: "conversation" }, producer: { id: "extension-1", kind: "pi_extension" }, occurredAt: "2026-08-17T00:00:00.000Z", sequence: 0, evidence: { class: "caller_claim", authority: { level: "untrusted" } }, state: "partial", coverage: { status: "partial", expectedEventCount: 2, observedEventCount: 1, missingEventIds: ["missing-1"] } }; return { ...base, ...overrides, schema: { ...base.schema, ...overrides.schema }, project: { ...base.project, ...overrides.project }, repository: { ...base.repository, ...overrides.repository }, ticket: { ...base.ticket, ...overrides.ticket }, episode: { ...base.episode, ...overrides.episode }, attempt: { ...base.attempt, ...overrides.attempt }, session: { ...base.session, ...overrides.session }, agentRun: { ...base.agentRun, ...overrides.agentRun }, event: { ...base.event, ...overrides.event }, producer: { ...base.producer, ...overrides.producer }, evidence: { ...base.evidence, ...overrides.evidence, authority: { ...base.evidence.authority, ...overrides.evidence?.authority } }, coverage: { ...base.coverage, ...overrides.coverage } }; }
const next = (id, sequence, overrides = {}) => record({ event: { id, kind: "usage" }, sequence, occurredAt: `2026-08-17T00:00:0${sequence}.000Z`, ...overrides });

test("append is immutable, idempotent on exact replay, and detects identity/ordering conflicts", async () => withLedger({}, async (ledger) => {
  assert.equal((await ledger.appendEpisode(record())).status, "committed");
  assert.equal((await ledger.appendEpisode(record())).status, "idempotent");
  await assert.rejects(ledger.appendEpisode(record({ producer: { id: "other", kind: "pi_extension" } })), LedgerConflictError);
  await assert.rejects(ledger.appendEpisode(next("event-2", 0)), (e) => e.code === "sequence_reversed");
  await assert.rejects(ledger.appendEpisode(next("event-3", 1, { occurredAt: "2026-08-16T00:00:00.000Z" })), (e) => e.code === "chronology_reversed");
  await assert.rejects(ledger.appendEpisode(next("event-4", 1, { ticket: { id: "OTHER" } })), LedgerConflictError);
}));

test("evolution terminal outcomes remain explainable and snapshots are deterministic", async () => withLedger({}, async (ledger) => {
  const evolution = record({ event: { id: "evolution-1", kind: "evolution" } });
  await ledger.appendEvolution(evolution, { id: "try-1", outcome: "rolled_back", explanation: "tests failed" });
  const queried = await ledger.queryEvolutions({ outcome: "rolled_back" });
  assert.equal(queried.records[0].evolution.explanation, "tests failed");
  assert.equal((await ledger.finalSnapshot()).digest, (await ledger.finalSnapshot()).digest);
  assert.equal((await ledger.rebuildProjection()).records, 1);
}));

test("artifact references are content addressed and reject digest, size, and symlink-style replacement", async () => withLedger({}, async (ledger, root) => {
  const ref = await ledger.writeArtifact(new TextEncoder().encode("evidence"), { identity: "artifact-1", evidenceClass: "caller_claim", coverage: "partial", provenance: "test", sensitivity: "internal" });
  await ledger.appendEpisode(record(), { artifacts: [ref] });
  await writeFile(join(root, "artifacts", ref.digest), "tampered");
  const integrity = await ledger.verifyIntegrity(); assert.equal(integrity.ok, false); assert.equal(integrity.findings[0].code, "artifact_integrity_failed");
}));

test("fault boundaries never expose pre-publication writes and recover post-publication commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "episode-ledger-fault-")); let ledger = await EpisodeEvolutionLedger.open({ root, faultInjector: (boundary) => boundary === "before_commit_publish" });
  await assert.rejects(ledger.appendEpisode(record()), InjectedFaultError); await ledger.close();
  ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 0); await ledger.close();
  ledger = await EpisodeEvolutionLedger.open({ root, faultInjector: (boundary) => boundary === "after_commit_publish" }); await assert.rejects(ledger.appendEpisode(record()), InjectedFaultError); ledger.faultInjector = undefined; assert.equal((await ledger.appendEpisode(record())).status, "idempotent"); await ledger.close();
  ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 1); await ledger.close(); await rm(root, { recursive: true, force: true });
});

test("corruption is quarantined without bricking another episode", async () => withLedger({}, async (ledger, root) => {
  await ledger.appendEpisode(record()); await ledger.appendEpisode(record({ episode: { id: "episode-2" }, attempt: { id: "attempt-2" }, session: { id: "session-2" }, agentRun: { runId: "run-2" }, event: { id: "event-2", kind: "usage" } })); await ledger.close();
  const commits = join(root, "commits"); const [first] = await (await import("node:fs/promises")).readdir(commits); const [file] = await (await import("node:fs/promises")).readdir(join(commits, first)); await writeFile(join(commits, first, file), "{torn");
  ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.queryEpisode("episode-2")).records.length, 1); assert.equal((await ledger.verifyIntegrity()).ok, false);
}));

test("configured resource bounds and hostile identifiers fail safely", async () => {
  await withLedger({ limits: { maxEncodedRecordBytes: 32 } }, async (ledger) => await assert.rejects(ledger.appendEpisode(record()), LedgerLimitError));
  await withLedger({ limits: { maxArtifactBytes: 1 } }, async (ledger) => await assert.rejects(ledger.writeArtifact(new Uint8Array([1, 2]), { identity: "x", evidenceClass: "x", coverage: "x", provenance: "x", sensitivity: "x" }), LedgerLimitError));
  await withLedger({ limits: { maxQueryRecords: 1, maxQueryBytes: 256 } }, async (ledger) => { await ledger.appendEpisode(record()); await assert.rejects(ledger.queryEpisode("episode-1", { limit: 2 }), LedgerLimitError); await assert.rejects(ledger.queryEpisode("episode-1", { limit: Number.NaN }), (e) => e.code === "query_invalid"); });
  await withLedger({}, async (ledger) => await assert.rejects(ledger.appendEpisode(record({ episode: { id: "../../escape" } })), (e) => e instanceof LedgerError && e.code === "ticket_episode_invalid"));
});

test("concurrent partition writers retain both events and migrations reject unknown versions", async () => withLedger({}, async (ledger) => {
  const other = record({ episode: { id: "episode-2" }, attempt: { id: "attempt-2" }, session: { id: "session-2" }, agentRun: { runId: "run-2" }, event: { id: "event-2", kind: "usage" } });
  await Promise.all([ledger.appendEpisode(record()), ledger.appendEpisode(other)]); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 1); assert.equal((await ledger.queryEpisode("episode-2")).records.length, 1);
  const conflict = record({ episode: { id: "episode-3" }, attempt: { id: "attempt-3" }, session: { id: "session-3" }, agentRun: { runId: "run-3" } }); await assert.rejects(Promise.all([ledger.appendEpisode(conflict), ledger.appendEpisode(record({ episode: { id: "episode-4" }, attempt: { id: "attempt-4" }, session: { id: "session-4" }, agentRun: { runId: "run-4" } }))]), LedgerConflictError); assert.equal((await ledger.queryEpisode("episode-4")).records.length, 0);
  await assert.rejects(ledger.migrate({ fromVersion: 0 }), (e) => e.code === "migration_unsupported"); assert.equal((await ledger.migrate({ fromVersion: 1 })).status, "already_current");
}));
