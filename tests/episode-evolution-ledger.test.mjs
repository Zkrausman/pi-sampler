import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TICKET_EPISODE_V1_SCHEMA_ID, TICKET_EPISODE_V1_SCHEMA_VERSION } from "../contracts/ticket-episode-v1.mjs";
import { EpisodeEvolutionLedger, InjectedFaultError, LedgerConflictError, LedgerError, LedgerLimitError } from "../ledgers/episode-evolution-ledger.mjs";

async function withLedger(options, body) { const root = await mkdtemp(join(tmpdir(), "episode-ledger-")); let ledger; try { ledger = await EpisodeEvolutionLedger.open({ root, ...options }); await body(ledger, root); } finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); } }
function record(overrides = {}) { const base = { schema: { id: TICKET_EPISODE_V1_SCHEMA_ID, version: TICKET_EPISODE_V1_SCHEMA_VERSION }, project: { id: "pi-sampler" }, repository: { id: "github.com/Zkrausman/pi-sampler", revision: "a".repeat(40) }, ticket: { system: "linear", id: "AIDEV-124" }, episode: { id: "episode-1" }, attempt: { id: "attempt-1" }, session: { id: "session-1" }, agentRun: { agentId: "agent-1", runId: "run-1" }, event: { id: "event-1", kind: "conversation" }, producer: { id: "extension-1", kind: "pi_extension" }, occurredAt: "2026-08-17T00:00:00.000Z", sequence: 0, evidence: { class: "caller_claim", authority: { level: "untrusted" } }, state: "partial", coverage: { status: "partial", expectedEventCount: 2, observedEventCount: 1, missingEventIds: ["missing-1"] } }; return { ...base, ...overrides, schema: { ...base.schema, ...overrides.schema }, project: { ...base.project, ...overrides.project }, repository: { ...base.repository, ...overrides.repository }, ticket: { ...base.ticket, ...overrides.ticket }, episode: { ...base.episode, ...overrides.episode }, attempt: { ...base.attempt, ...overrides.attempt }, session: { ...base.session, ...overrides.session }, agentRun: { ...base.agentRun, ...overrides.agentRun }, event: { ...base.event, ...overrides.event }, producer: { ...base.producer, ...overrides.producer }, evidence: { ...base.evidence, ...overrides.evidence, authority: { ...base.evidence.authority, ...overrides.evidence?.authority } }, coverage: { ...base.coverage, ...overrides.coverage } }; }
const next = (id, sequence, overrides = {}) => record({ event: { id, kind: "usage" }, sequence, occurredAt: `2026-08-17T00:00:0${sequence}.000Z`, ...overrides });
const stable = (v) => v === undefined ? "null" : v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const v1Envelope = (value, previousDigest = null) => { const envelope = { format: 1, type: "episode", record: value, artifacts: [], previousDigest }; envelope.digest = hash(stable({ format: envelope.format, type: envelope.type, record: envelope.record, evolution: envelope.evolution, artifacts: envelope.artifacts, previousDigest: envelope.previousDigest })); return envelope; };
async function createV1Fixture(root, count = 2) { await mkdir(join(root, "commits"), { recursive: true }); let previous = null; for (let i = 0; i < count; i++) { const envelope = v1Envelope(i ? next(`v1-event-${i}`, i) : record({ event: { id: "v1-event-0", kind: "conversation" } }), previous); previous = envelope.digest; const partition = hash(envelope.record.episode.id), dir = join(root, "commits", partition); await mkdir(dir, { recursive: true }); await writeFile(join(dir, `commit-${String(i).padStart(16, "0")}-${envelope.digest}.json`), stable(envelope)); } await writeFile(join(root, "manifest.json"), stable({ format: "episode-evolution-ledger", version: 1 })); }
async function createOutOfOrderV1Fixture(root, reverse = false) {
  const ordered = [[record({ event: { id: "ordered-a-0", kind: "conversation" } }), next("ordered-a-1", 1)], [unrelated("ordered-b"), record({ episode: { id: "episode-ordered-b" }, attempt: { id: "attempt-ordered-b" }, session: { id: "session-ordered-b" }, agentRun: { runId: "run-ordered-b" }, event: { id: "ordered-b-1", kind: "usage" }, sequence: 1, occurredAt: "2026-08-17T00:00:01.000Z" })]];
  const partitions = ordered.map((records) => { let previous = null; const envelopes = records.map((value) => { const envelope = v1Envelope(value, previous); previous = envelope.digest; return envelope; }); return { partition: hash(records[0].episode.id), envelopes }; }).sort((a, b) => reverse ? b.partition.localeCompare(a.partition) : a.partition.localeCompare(b.partition));
  await mkdir(join(root, "commits"), { recursive: true }); for (const { partition, envelopes } of partitions) { const dir = join(root, "commits", partition); await mkdir(dir); for (const envelope of (reverse ? [...envelopes].reverse() : envelopes)) await writeFile(join(dir, `commit-${String(envelope.record.sequence).padStart(16, "0")}-${envelope.digest}.json`), stable(envelope)); }
  await writeFile(join(root, "manifest.json"), stable({ format: "episode-evolution-ledger", version: 1 }));
}
async function managedBytes(root) { let total = 0; const walk = async (path) => { for (const name of await readdir(path)) { const target = join(path, name), info = await lstat(target); if (info.isDirectory()) await walk(target); else total += info.size; } }; await walk(root); return total; }
async function assertEmptyStaging(root) { assert.deepEqual((await readdir(join(root, ".staging"))).filter((name) => name !== ".receipt-batch-key"), []); }
const unrelated = (suffix) => record({ episode: { id: `episode-${suffix}` }, attempt: { id: `attempt-${suffix}` }, session: { id: `session-${suffix}` }, agentRun: { runId: `run-${suffix}` }, event: { id: `event-${suffix}`, kind: "usage" } });

test("append is immutable, idempotent on exact replay, and detects identity/ordering conflicts", async () => withLedger({}, async (ledger) => {
  assert.equal((await ledger.appendEpisode(record())).status, "committed");
  assert.equal((await ledger.appendEpisode(record())).status, "idempotent");
  await assert.rejects(ledger.appendEpisode(record({ producer: { id: "other", kind: "pi_extension" } })), LedgerConflictError);
  await assert.rejects(ledger.appendEpisode(next("event-2", 0)), (e) => e.code === "sequence_reversed");
  await assert.rejects(ledger.appendEpisode(next("event-3", 1, { occurredAt: "2026-08-16T00:00:00.000Z" })), (e) => e.code === "chronology_reversed");
  await assert.rejects(ledger.appendEpisode(next("event-4", 1, { ticket: { id: "OTHER" } })), LedgerConflictError);
}));

test("a paused pre-publication append is invisible to queries and exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "episode-ledger-paused-")); let reached, release;
  const reachedPromise = new Promise((resolveReached) => { reached = resolveReached; });
  const releasePromise = new Promise((resolveRelease) => { release = resolveRelease; });
  const ledger = await EpisodeEvolutionLedger.open({ root, faultInjector: async (boundary) => {
    if (boundary !== "before_commit_publish") return false;
    reached(); await releasePromise; return true;
  } });
  try {
    const append = ledger.appendEpisode(record()); await reachedPromise;
    assert.equal((await ledger.queryEpisode("episode-1")).records.length, 0);
    const exported = await ledger.exportLedger();
    assert.equal(JSON.parse(exported.contents).records.length, 0);
    release(); await assert.rejects(append, InjectedFaultError);
    assert.equal((await ledger.queryEpisode("episode-1")).records.length, 0);
    await ledger.close(); const reopened = await EpisodeEvolutionLedger.open({ root });
    assert.equal((await reopened.queryEpisode("episode-1")).records.length, 0); await reopened.close();
  } finally { await ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test("evolution terminal outcomes remain explainable and snapshots are deterministic", async () => withLedger({}, async (ledger) => {
  const evolution = record({ event: { id: "evolution-1", kind: "evolution" } });
  await ledger.appendEvolution(evolution, { id: "try-1", outcome: "rolled_back", explanation: "tests failed" });
  const queried = await ledger.queryEvolutions({ outcome: "rolled_back" });
  assert.equal(queried.records[0].evolution.explanation, "tests failed");
  assert.equal((await ledger.finalSnapshot()).digest, (await ledger.finalSnapshot()).digest);
  assert.equal((await ledger.rebuildProjection()).records, 1);
}));

test("bounded cross-episode evolution queries retain canonical order after reopen", async () => {
  const roots = await Promise.all([mkdtemp(join(tmpdir(), "episode-ledger-evolution-order-a-")), mkdtemp(join(tmpdir(), "episode-ledger-evolution-order-b-"))]);
  const evolutionRecord = (episodeId, suffix) => record({ episode: { id: episodeId }, attempt: { id: `attempt-${suffix}` }, session: { id: `session-${suffix}` }, agentRun: { runId: `run-${suffix}` }, event: { id: `cross-evolution-${suffix}`, kind: "evolution" } });
  const queryAfterReopen = async (root, order) => { let ledger;
    try {
      ledger = await EpisodeEvolutionLedger.open({ root });
      for (const suffix of order) await ledger.appendEvolution(evolutionRecord(`episode-${suffix}`, suffix), { id: `try-${suffix}`, outcome: "accepted", explanation: suffix });
      const beforeReopen = await ledger.queryEvolutions({ limit: 1 });
      assert.deepEqual(beforeReopen.records.map((entry) => entry.record.event.id), ["cross-evolution-alpha"]);
      assert.equal(beforeReopen.truncated, true);
      await ledger.close(); ledger = await EpisodeEvolutionLedger.open({ root });
      const afterReopen = await ledger.queryEvolutions({ limit: 1 });
      assert.deepEqual(afterReopen.records.map((entry) => entry.record.event.id), beforeReopen.records.map((entry) => entry.record.event.id));
      assert.equal(afterReopen.truncated, true);
      return afterReopen.records.map((entry) => entry.record.event.id);
    } finally { await ledger?.close(); }
  };
  try {
    const results = await Promise.all([queryAfterReopen(roots[0], ["beta", "alpha"]), queryAfterReopen(roots[1], ["alpha", "beta"])]);
    assert.deepEqual(results[0], results[1]);
  } finally { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); }
});

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

test("post-publication reconciliation gives the next same-process append the durable head", async () => {
  const root = await mkdtemp(join(tmpdir(), "episode-ledger-reconcile-"));
  let ledger = await EpisodeEvolutionLedger.open({ root, faultInjector: (b) => b === "after_commit_dirsync" });
  await assert.rejects(ledger.appendEpisode(record()), InjectedFaultError);
  ledger.faultInjector = undefined;
  assert.equal((await ledger.appendEpisode(next("event-2", 1))).status, "committed");
  assert.equal((await ledger.queryEpisode("episode-1")).records.length, 2);
  await ledger.close(); await rm(root, { recursive: true, force: true });
});

test("stale subprocess lock is recovered while a live writer remains excluded", async () => {
  const root = await mkdtemp(join(tmpdir(), "episode-ledger-lock-"));
  const moduleUrl = new URL("../ledgers/episode-evolution-ledger.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { EpisodeEvolutionLedger } from ${JSON.stringify(moduleUrl)}; await EpisodeEvolutionLedger.open({root:${JSON.stringify(root)}}); console.log('locked'); setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  await assert.rejects(EpisodeEvolutionLedger.open({ root }), (e) => e.code === "writer_locked");
  child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve));
  const ledger = await EpisodeEvolutionLedger.open({ root }); await ledger.close(); await rm(root, { recursive: true, force: true });
});

test("failed open releases a lock it acquired", async () => {
  const root = await mkdtemp(join(tmpdir(), "episode-ledger-open-failure-")); let ledger = await EpisodeEvolutionLedger.open({ root }); await ledger.appendEpisode(record()); await ledger.close();
  await assert.rejects(EpisodeEvolutionLedger.open({ root, limits: { maxStorageBytes: 1 } }), (e) => e.code === "reconciliation_failed");
  ledger = await EpisodeEvolutionLedger.open({ root }); await ledger.close(); await rm(root, { recursive: true, force: true });
});

test("physical backup restores records, artifacts, terminal outcomes, and integrity", async () => withLedger({}, async (ledger, root) => {
  const artifact = await ledger.writeArtifact(new TextEncoder().encode("restore-me"), { identity: "x", evidenceClass: "caller_claim", coverage: "partial", provenance: "test", sensitivity: "internal" });
  await ledger.appendEpisode(record(), { artifacts: [artifact] });
  await ledger.appendEvolution(next("evolution-backup", 1, { event: { id: "evolution-backup", kind: "evolution" } }), { id: "try", outcome: "failed", explanation: "kept" });
  const backup = await ledger.backup(); const target = join(root, "restored");
  const restored = await EpisodeEvolutionLedger.restore({ backupPath: backup.path, root: target });
  assert.equal((await restored.queryEpisode("episode-1")).records.length, 2); assert.equal((await restored.verifyIntegrity()).ok, true);
  await restored.close();
}));

test("restore rejects anchored manifest subsets and missing, extra, or replaced archive files before copying", async () => withLedger({}, async (ledger, root) => {
  const artifact = await ledger.writeArtifact(new TextEncoder().encode("anchored-artifact"), { identity: "anchor", evidenceClass: "caller_claim", coverage: "partial", provenance: "test", sensitivity: "internal" });
  await ledger.appendEpisode(record(), { artifacts: [artifact] });
  const backup = await ledger.backup(), manifestPath = join(backup.path, "backup-manifest.json"), original = JSON.parse(await readFile(manifestPath, "utf8"));
  const artifactFile = original.files.find((file) => file.path === `artifacts/${artifact.digest}`), artifactPath = join(backup.path, ...artifactFile.path.split("/")), artifactBody = await readFile(artifactPath);
  const assertUncopied = async (name, check) => { const target = join(root, name); await assert.rejects(check(target), (error) => ["backup_invalid", "backup_integrity_failed"].includes(error.code)); await assert.rejects(lstat(target), (error) => error.code === "ENOENT"); };
  const subset = { ...original, files: original.files.filter((file) => file.path !== artifactFile.path) }; subset.anchor = hash(stable(subset.files));
  await writeFile(manifestPath, stable(subset)); await assertUncopied("restore-subset", (target) => EpisodeEvolutionLedger.restore({ backupPath: backup.path, root: target }));
  await writeFile(manifestPath, stable(original)); await mkdir(join(backup.path, "quarantine"), { recursive: true }); await writeFile(join(backup.path, "quarantine", "unexpected.json"), "unexpected");
  await assertUncopied("restore-extra", (target) => EpisodeEvolutionLedger.restore({ backupPath: backup.path, root: target }));
  await rm(join(backup.path, "quarantine", "unexpected.json")); await rm(artifactPath);
  await assertUncopied("restore-missing", (target) => EpisodeEvolutionLedger.restore({ backupPath: backup.path, root: target }));
  await writeFile(artifactPath, artifactBody); await writeFile(artifactPath, "replaced");
  await assertUncopied("restore-replaced", (target) => EpisodeEvolutionLedger.restore({ backupPath: backup.path, root: target }));
}));

test("backup and restore preserve recursively archived quarantine material directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "episode-ledger-quarantine-backup-")); let ledger, restored;
  try {
    ledger = await EpisodeEvolutionLedger.open({ root }); await ledger.appendEpisode(record());
    await mkdir(join(root, "commits", "unsafe-directory", "nested"), { recursive: true }); await writeFile(join(root, "commits", "unsafe-directory", "nested", "retained.txt"), "quarantined material");
    await ledger.close(); ledger = await EpisodeEvolutionLedger.open({ root });
    const material = (await readdir(join(root, "quarantine"))).find((name) => name.endsWith(".material")); assert.ok(material);
    const backup = await ledger.backup(), target = join(root, "restored"); await ledger.close(); ledger = undefined;
    restored = await EpisodeEvolutionLedger.restore({ backupPath: backup.path, root: target });
    const restoredMaterial = (await readdir(join(target, "quarantine"))).find((name) => name.endsWith(".material")); assert.ok(restoredMaterial);
    assert.equal(await readFile(join(target, "quarantine", restoredMaterial, "nested", "retained.txt"), "utf8"), "quarantined material");
  } finally { await restored?.close(); await ledger?.close(); await rm(root, { recursive: true, force: true }); }
});

test("genuine v1 fixtures migrate into a materialized, checkpointed v2 target while preserving source", async () => {
  const root = await mkdtemp(join(tmpdir(), "episode-ledger-migrate-")); await createV1Fixture(root); const sourceBefore = await readFile(join(root, "commits", hash("episode-1"), (await readdir(join(root, "commits", hash("episode-1"))))[0]), "utf8");
  let ledger = await EpisodeEvolutionLedger.open({ root, faultInjector: (b) => b === "after_migration_batch" }); await assert.rejects(ledger.migrate({ fromVersion: 1, batchSize: 1 }), InjectedFaultError); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 2); await ledger.close();
  ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.migrate({ fromVersion: 1, batchSize: 1 })).status, "migrated"); assert.equal(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")).commitDirectory, "commits-v2"); const targetDir = join(root, "commits-v2", hash("episode-1")); const target = JSON.parse(await readFile(join(targetDir, (await readdir(targetDir))[0]), "utf8")); assert.equal(target.format, 2); assert.match(target.sourceDigest, /^[a-f0-9]{64}$/); assert.equal(await readFile(join(root, "commits", hash("episode-1"), (await readdir(join(root, "commits", hash("episode-1"))))[0]), "utf8"), sourceBefore); assert.equal((await ledger.verifyIntegrity()).ok, true); await ledger.close(); await rm(root, { recursive: true, force: true });
});

test("reopen verifies referenced artifact bytes, quarantines only the corrupted episode, and accepts unrelated append", async () => withLedger({}, async (ledger, root) => {
  const ref = await ledger.writeArtifact(new TextEncoder().encode("reopen-evidence"), { identity: "artifact", evidenceClass: "caller_claim", coverage: "partial", provenance: "test", sensitivity: "internal" }); await ledger.appendEpisode(record(), { artifacts: [ref] }); await ledger.appendEpisode(unrelated("survives")); await ledger.close(); await writeFile(join(root, "artifacts", ref.digest), "tampered");
  ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 0); assert.equal((await ledger.queryEpisode("episode-survives")).records.length, 1); assert.equal((await ledger.appendEpisode(unrelated("after-corruption"))).status, "committed");
}));

test("directory setup faults reconcile admitted indexes before the caller can query", async () => withLedger({ faultInjector: (b) => b === "before_commit_directory" }, async (ledger) => { await assert.rejects(ledger.appendEpisode(record()), InjectedFaultError); ledger.faultInjector = undefined; assert.equal((await ledger.queryEpisode("episode-1")).records.length, 0); assert.equal((await ledger.appendEpisode(record())).status, "committed"); }));

test("out-of-order v1 partitions have deterministic integrity, snapshots, projections, and migrations", async () => {
  const roots = await Promise.all([mkdtemp(join(tmpdir(), "episode-ledger-ordered-a-")), mkdtemp(join(tmpdir(), "episode-ledger-ordered-b-"))]); const results = [];
  try { for (const [index, root] of roots.entries()) { await createOutOfOrderV1Fixture(root, index === 0); let ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.verifyIntegrity()).ok, true); const snapshot = await ledger.finalSnapshot(), projection = await ledger.rebuildProjection({ name: "ordered", version: 1 }); assert.equal((await ledger.migrate({ fromVersion: 1, batchSize: 1 })).status, "migrated"); const migratedSnapshot = await ledger.finalSnapshot(), manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")); results.push({ snapshot: snapshot.digest, projection: projection.digest, migratedSnapshot: migratedSnapshot.digest, migration: manifest.migrationTargetAnchor }); await ledger.close(); ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.verifyIntegrity()).ok, true); assert.equal((await ledger.finalSnapshot()).digest, migratedSnapshot.digest); await ledger.close(); }
    assert.deepEqual(results[0], results[1]);
  } finally { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); }
});

test("capacity preflight rejects producers without results and permits reopen", async () => {
  for (const [name, work, output] of [["export", (ledger) => ledger.exportLedger(), "exports"], ["projection", (ledger) => ledger.rebuildProjection(), "projections"], ["backup", (ledger) => ledger.backup(), "backups"]]) { const root = await mkdtemp(join(tmpdir(), `episode-ledger-capacity-${name}-`)); let ledger;
    try { ledger = await EpisodeEvolutionLedger.open({ root, limits: { maxStorageBytes: 100 } }); await assert.rejects(work(ledger), LedgerLimitError); assert.deepEqual(await readdir(join(root, output)), []); await assertEmptyStaging(root); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 0); await ledger.close(); ledger = await EpisodeEvolutionLedger.open({ root, limits: { maxStorageBytes: 100 } }); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 0); }
    finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
  }
  const root = await mkdtemp(join(tmpdir(), "episode-ledger-capacity-migration-")); let ledger;
  try { await createV1Fixture(root, 1); const limit = await managedBytes(root); ledger = await EpisodeEvolutionLedger.open({ root, limits: { maxStorageBytes: limit } }); await assert.rejects(ledger.migrate({ fromVersion: 1 }), LedgerLimitError); assert.deepEqual(await readdir(join(root, "commits-v2")), []); assert.deepEqual(await readdir(join(root, "migrations")), []); await assertEmptyStaging(root); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 1); await ledger.close(); ledger = await EpisodeEvolutionLedger.open({ root, limits: { maxStorageBytes: limit } }); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 1); }
  finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
});

test("concurrent partition writers retain both events and migrations reject unknown versions", async () => withLedger({}, async (ledger) => {
  const other = record({ episode: { id: "episode-2" }, attempt: { id: "attempt-2" }, session: { id: "session-2" }, agentRun: { runId: "run-2" }, event: { id: "event-2", kind: "usage" } });
  await Promise.all([ledger.appendEpisode(record()), ledger.appendEpisode(other)]); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 1); assert.equal((await ledger.queryEpisode("episode-2")).records.length, 1);
  const conflict = record({ episode: { id: "episode-3" }, attempt: { id: "attempt-3" }, session: { id: "session-3" }, agentRun: { runId: "run-3" } }); await assert.rejects(Promise.all([ledger.appendEpisode(conflict), ledger.appendEpisode(record({ episode: { id: "episode-4" }, attempt: { id: "attempt-4" }, session: { id: "session-4" }, agentRun: { runId: "run-4" } }))]), LedgerConflictError); assert.equal((await ledger.queryEpisode("episode-4")).records.length, 0);
  await assert.rejects(ledger.migrate({ fromVersion: 0 }), (e) => e.code === "migration_unsupported"); assert.equal((await ledger.migrate({ fromVersion: 2 })).status, "already_current");
}));

test("repeated atomic-create failures clean staging in-process and reopen safely", async (t) => {
  for (const boundary of ["before_commit_stage", "after_commit_write", "after_commit_sync", "before_commit_publish", "after_commit_publish", "after_commit_dirsync"]) await t.test(boundary, async () => {
    const root = await mkdtemp(join(tmpdir(), "episode-ledger-repeat-fault-")); let ledger;
    try { ledger = await EpisodeEvolutionLedger.open({ root, faultInjector: (value) => value === boundary }); for (const suffix of ["repeat-a", "repeat-b"]) { await assert.rejects(ledger.appendEpisode(unrelated(suffix)), InjectedFaultError); await assertEmptyStaging(root); } const post = ["after_commit_publish", "after_commit_dirsync"].includes(boundary); ledger.faultInjector = undefined; assert.equal((await ledger.queryEpisode("episode-repeat-a")).records.length, post ? 1 : 0); await ledger.close(); ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.queryEpisode("episode-repeat-a")).records.length, post ? 1 : 0); assert.equal((await ledger.queryEpisode("episode-repeat-b")).records.length, post ? 1 : 0); assert.equal((await ledger.verifyIntegrity()).ok, true); await assertEmptyStaging(root); }
    finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
  });
});

test("table-driven persistence boundaries recover pre- and post-publication outcomes", async (t) => {
  const phases = [["before", "stage"], ["after", "write"], ["after", "sync"], ["before", "publish"], ["after", "publish"], ["after", "dirsync"]];
  const cases = ["manifest", "commit", "artifact", "quarantine", "projection", "export", "backup", "migration_target", "migration_checkpoint", "migration_manifest"];
  for (const purpose of cases) for (const [when, phase] of phases) await t.test(`${purpose}: ${when}_${phase}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "episode-ledger-boundary-")); const boundary = `${when}_${purpose}_${phase}`; const post = boundary.startsWith(`after_${purpose}_publish`) || boundary.startsWith(`after_${purpose}_dirsync`); let ledger;
    try {
      if (purpose === "manifest") {
        await assert.rejects(EpisodeEvolutionLedger.open({ root, faultInjector: (b) => b === boundary }), InjectedFaultError); await assertEmptyStaging(root);
        ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 0);
      } else if (purpose === "quarantine") {
        ledger = await EpisodeEvolutionLedger.open({ root }); await ledger.appendEpisode(record()); await ledger.close(); ledger = undefined;
        const partition = hash("episode-1"), [file] = await readdir(join(root, "commits", partition)); await writeFile(join(root, "commits", partition, file), "{broken");
        await assert.rejects(EpisodeEvolutionLedger.open({ root, faultInjector: (b) => b === boundary }), (e) => e instanceof InjectedFaultError || e.code === "reconciliation_failed"); await assertEmptyStaging(root); ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.queryEpisode("episode-1")).records.length, 0);
      } else if (purpose.startsWith("migration_")) {
        await createV1Fixture(root); ledger = await EpisodeEvolutionLedger.open({ root, faultInjector: (b) => b === boundary }); await assert.rejects(ledger.migrate({ fromVersion: 1, batchSize: 1 }), InjectedFaultError); await assertEmptyStaging(root); await ledger.close(); ledger = await EpisodeEvolutionLedger.open({ root }); const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")); assert.equal(manifest.version, purpose === "migration_manifest" && post ? 2 : 1); if (manifest.version === 1) assert.equal((await ledger.migrate({ fromVersion: 1, batchSize: 1 })).status, "migrated"); else assert.equal((await ledger.migrate({ fromVersion: 2 })).status, "already_current"); assert.equal((await ledger.verifyIntegrity()).ok, true);
      } else {
        ledger = await EpisodeEvolutionLedger.open({ root }); if (purpose !== "artifact") await ledger.appendEpisode(record()); ledger.faultInjector = (b) => b === boundary;
        const work = purpose === "commit" ? () => ledger.appendEpisode(unrelated("boundary")) : purpose === "artifact" ? () => ledger.writeArtifact(new TextEncoder().encode("boundary-artifact"), { identity: "boundary", evidenceClass: "caller_claim", coverage: "partial", provenance: "test", sensitivity: "internal" }) : purpose === "projection" ? () => ledger.rebuildProjection({ name: "boundary", version: 1, batchSize: 1 }) : purpose === "export" ? () => ledger.exportLedger() : () => ledger.backup();
        await assert.rejects(work(), InjectedFaultError); await assertEmptyStaging(root); ledger.faultInjector = undefined;
        if (purpose === "commit") assert.equal((await ledger.queryEpisode("episode-boundary")).records.length, post ? 1 : 0);
        if (purpose === "commit") await ledger.appendEpisode(unrelated("boundary"));
        if (purpose === "artifact") await ledger.writeArtifact(new TextEncoder().encode("boundary-artifact"), { identity: "boundary", evidenceClass: "caller_claim", coverage: "partial", provenance: "test", sensitivity: "internal" });
        if (purpose === "projection") await ledger.rebuildProjection({ name: "boundary", version: 1, batchSize: 1 });
        if (purpose === "export") await ledger.exportLedger();
        if (purpose === "backup") await ledger.backup();
        await ledger.close(); ledger = await EpisodeEvolutionLedger.open({ root }); assert.equal((await ledger.verifyIntegrity()).ok, true);
      }
    } finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
  });
});
