import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { validateTicketEpisodeV1 } from "../contracts/ticket-episode-v1.mjs";

export const LEDGER_FORMAT_VERSION = 1;
export const DEFAULT_LEDGER_LIMITS = Object.freeze({
  maxEncodedRecordBytes: 256 * 1024,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxRecordsPerAppend: 32,
  maxQueryRecords: 1000,
  maxQueryBytes: 4 * 1024 * 1024,
  maxStorageBytes: 512 * 1024 * 1024,
  maxIndexEntries: 100_000,
  maxPendingWrites: 128,
  maxMigrationBatch: 256,
  maxRebuildBatch: 256,
  maxExportBytes: 64 * 1024 * 1024,
  maxCacheEntries: 4096,
});

export class LedgerError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "LedgerError"; this.code = code; this.details = details; }
}
export class LedgerLimitError extends LedgerError { constructor(limit, actual, maximum) { super("limit_exceeded", `${limit} exceeds its configured bound`, { limit, actual, maximum }); this.name = "LedgerLimitError"; } }
export class LedgerConflictError extends LedgerError { constructor(id, details = {}) { super("id_conflict", `immutable identifier conflict: ${id}`, { id, ...details }); this.name = "LedgerConflictError"; } }
export class InjectedFaultError extends LedgerError { constructor(boundary) { super("injected_fault", `fault injected at ${boundary}`, { boundary }); this.name = "InjectedFaultError"; } }

const OUTCOMES = new Set(["accepted", "rejected", "failed", "rolled_back"]);
const enc = new TextEncoder();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
};
const recordDigest = (value) => hash(stable(value));
const safeSegment = (value) => hash(String(value)); // Never use caller identifiers as filesystem paths.
const asError = (error) => ({ code: error.code ?? "io_error", message: error.message, name: error.name });

async function fsyncFile(path) { const handle = await open(path, "r+"); try { await handle.sync(); } catch (error) { if (!["EINVAL", "EPERM"].includes(error.code)) throw error; } finally { await handle.close(); } }
async function fsyncDirectory(path) { try { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } } catch (error) { if (!["EINVAL", "EPERM", "EISDIR"].includes(error.code)) throw error; } }
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

/**
 * Version-1 durable source ledger. A committed event is one immutable commit file:
 * write+fsync a private staging file, then hard-link it into commits/ and fsync that
 * directory. A fault before publication is invisible; a fault after publication is
 * committed and is recovered on the next open. Files are content checksummed and
 * chained per episode. The process lock deliberately rejects multi-process writers.
 */
export class EpisodeEvolutionLedger {
  static async open(options) { const ledger = new EpisodeEvolutionLedger(options); await ledger.#open(); return ledger; }
  constructor({ root, limits = {}, trustedAuthorityIds = [], verifyAttestation, faultInjector } = {}) {
    if (!root || typeof root !== "string") throw new LedgerError("root_required", "root is required");
    this.root = resolve(root);
    this.limits = Object.freeze({ ...DEFAULT_LEDGER_LIMITS, ...limits });
    for (const [name, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new LedgerError("invalid_limit", `invalid limit ${name}`);
    this.validationOptions = { trustedAuthorityIds, verifyAttestation };
    this.faultInjector = faultInjector;
    this.episodes = new Map(); this.eventIds = new Map(); this.identityOwners = new Map(); this.storageBytes = 0;
    this.pending = 0; this.queues = new Map(); this.closed = false; this.closing = false; this.lockPath = join(this.root, ".writer.lock");
  }
  async close() { if (!this.closed) { this.closing = true; await Promise.all([...this.queues.values()]); this.closed = true; await unlink(this.lockPath).catch(() => {}); } }
  async #hit(boundary) { if (this.faultInjector) { const result = await this.faultInjector(boundary); if (result === true) throw new InjectedFaultError(boundary); } }
  #path(...parts) { const path = resolve(this.root, ...parts); if (!path.startsWith(`${this.root}${sep}`) && path !== this.root) throw new LedgerError("path_escape", "ledger path escaped root"); return path; }
  async #assertSafeDirectory(path) { const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory()) throw new LedgerError("unsafe_path", `${path} must be a real directory`); }
  async #open() {
    await mkdir(this.root, { recursive: true }); await this.#assertSafeDirectory(this.root);
    for (const dir of ["commits", "artifacts", "quarantine", ".staging", "projections", "exports"]) { await mkdir(this.#path(dir), { recursive: true }); await this.#assertSafeDirectory(this.#path(dir)); }
    const manifestPath = this.#path("manifest.json");
    if (!await exists(manifestPath)) await this.#atomicCreate(manifestPath, stable({ format: "episode-evolution-ledger", version: LEDGER_FORMAT_VERSION }), "manifest");
    const manifestInfo = await lstat(manifestPath); if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new LedgerError("unsafe_path", "ledger manifest must be a regular file");
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) { throw new LedgerError("manifest_corrupt", "ledger manifest is corrupt", { error: asError(error) }); }
    if (manifest.format !== "episode-evolution-ledger" || manifest.version !== LEDGER_FORMAT_VERSION) throw new LedgerError("unknown_ledger_version", "unknown or future ledger format is rejected", { manifest });
    try { await open(this.lockPath, "wx").then((h) => h.close()); } catch (error) { if (error.code === "EEXIST") throw new LedgerError("writer_locked", "another ledger writer owns this root"); throw error; }
    await this.#recoverStaging(); await this.#load(); await this.#recountStorage();
  }
  async #atomicCreate(target, contents, purpose) {
    const stage = this.#path(".staging", `${safeSegment(target)}-${randomUUID()}.tmp`);
    await this.#hit(`before_${purpose}_stage`); await writeFile(stage, contents, { flag: "wx", mode: 0o600 });
    await this.#hit(`after_${purpose}_write`); await fsyncFile(stage); await this.#hit(`after_${purpose}_sync`);
    try { await this.#hit(`before_${purpose}_publish`); await link(stage, target); await this.#hit(`after_${purpose}_publish`); await fsyncDirectory(basename(target) === "manifest.json" ? this.root : resolve(target, "..")); await this.#hit(`after_${purpose}_dirsync`); }
    finally { await unlink(stage).catch(() => {}); }
  }
  async #recoverStaging() { for (const name of await readdir(this.#path(".staging"))) await rm(this.#path(".staging", name), { force: true, recursive: true }); }
  async #load() {
    const episodeDirectories = await readdir(this.#path("commits"), { withFileTypes: true });
    for (const dir of episodeDirectories) {
      if (!dir.isDirectory() || !/^[a-f0-9]{64}$/.test(dir.name)) { await this.#quarantine("unsafe_commit_directory", { directory: dir.name }); continue; }
      const episodeKey = dir.name; const commits = this.#path("commits", episodeKey); let files = await readdir(commits, { withFileTypes: true });
      files = files.filter((f) => f.isFile()).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of files) {
        if (!/^commit-[0-9]{16}-[a-f0-9]{64}\.json$/.test(entry.name)) { await this.#quarantine("unsafe_commit_name", { episodeKey, name: entry.name }); continue; }
        const path = this.#path("commits", episodeKey, entry.name);
        try { const envelope = JSON.parse(await readFile(path, "utf8")); this.#admitLoaded(envelope, episodeKey, entry.name); }
        catch (error) { await this.#quarantine("commit_corrupt", { episodeKey, name: entry.name, error: asError(error) }, path); }
      }
    }
  }
  #admitLoaded(envelope, episodeKey, fileName) {
    if (envelope.format !== 1 || typeof envelope.digest !== "string" || envelope.digest !== recordDigest({ format: envelope.format, type: envelope.type, record: envelope.record, evolution: envelope.evolution, artifacts: envelope.artifacts, previousDigest: envelope.previousDigest })) throw new LedgerError("digest_mismatch", "commit checksum mismatch");
    if (fileName !== `commit-${String(envelope.record.sequence).padStart(16, "0")}-${envelope.digest}.json` || safeSegment(envelope.record.episode.id) !== episodeKey) throw new LedgerError("commit_identity_mismatch", "commit name or partition does not match its record");
    this.#validateEnvelope(envelope); this.#admit(envelope, true);
  }
  #validateEnvelope(envelope) {
    if (!envelope || (envelope.type !== "episode" && envelope.type !== "evolution")) throw new LedgerError("envelope_invalid", "unknown ledger envelope type");
    const result = validateTicketEpisodeV1(envelope.record, this.validationOptions);
    if (!result.ok) throw new LedgerError("ticket_episode_invalid", "canonical Ticket Episode v1 validation failed", { errors: result.errors });
    if (!Array.isArray(envelope.artifacts ?? [])) throw new LedgerError("artifact_references_invalid", "artifact references must be an array");
    for (const ref of envelope.artifacts ?? []) this.#validateArtifactRef(ref);
    if (envelope.type === "evolution") {
      if (envelope.record.event.kind !== "evolution" || !envelope.evolution || typeof envelope.evolution.id !== "string" || !OUTCOMES.has(envelope.evolution.outcome) || typeof envelope.evolution.explanation !== "string") throw new LedgerError("evolution_invalid", "evolution records require an evolution event and explicit terminal outcome");
    } else if (envelope.evolution !== undefined) throw new LedgerError("envelope_invalid", "episode events cannot carry evolution details");
  }
  #validateArtifactRef(ref) {
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.digest) || !Number.isSafeInteger(ref.size) || ref.size < 0 || typeof ref.identity !== "string" || typeof ref.evidenceClass !== "string" || typeof ref.coverage !== "string" || typeof ref.sensitivity !== "string" || typeof ref.provenance !== "string") throw new LedgerError("artifact_reference_invalid", "invalid artifact reference");
  }
  #assertAppendable(envelope) {
    const r = envelope.record; const existing = this.eventIds.get(r.event.id);
    if (existing) throw new LedgerConflictError(r.event.id, { existingDigest: existing });
    const ticket = `${r.project.id}\u0000${r.ticket.system}\u0000${r.ticket.id}`;
    for (const [kind, id] of [["episode", r.episode.id], ["attempt", r.attempt.id], ["session", r.session.id], ["agentRun", r.agentRun.runId]]) { const owner = this.identityOwners.get(`${kind}\u0000${id}`); if (owner && owner !== ticket) throw new LedgerConflictError(id, { kind, owner, receivedOwner: ticket }); }
    const head = this.episodes.get(r.episode.id)?.head;
    if (!head && envelope.previousDigest !== null) throw new LedgerError("chain_mismatch", "first commit must have null previous digest");
    if (head) { if (r.sequence <= head.record.sequence) throw new LedgerError("sequence_reversed", "sequence must strictly increase within an episode"); if (Date.parse(r.occurredAt) < Date.parse(head.record.occurredAt)) throw new LedgerError("chronology_reversed", "occurredAt must not move backward within an episode"); if (envelope.previousDigest !== head.digest) throw new LedgerError("chain_mismatch", "commit chain does not extend the episode head"); }
  }
  #admit(envelope, enforceOrder) {
    const r = envelope.record; const eventDigest = envelope.digest; const existing = this.eventIds.get(r.event.id);
    if (existing) { if (existing === eventDigest) return "idempotent"; throw new LedgerConflictError(r.event.id, { existingDigest: existing, receivedDigest: eventDigest }); }
    const ticket = `${r.project.id}\0${r.ticket.system}\0${r.ticket.id}`;
    for (const [kind, id] of [["episode", r.episode.id], ["attempt", r.attempt.id], ["session", r.session.id], ["agentRun", r.agentRun.runId]]) {
      const key = `${kind}\0${id}`, owner = this.identityOwners.get(key); if (owner && owner !== ticket) throw new LedgerConflictError(id, { kind, owner, receivedOwner: ticket }); this.identityOwners.set(key, ticket);
    }
    const episode = this.episodes.get(r.episode.id) ?? { records: [], head: undefined, corrupt: false };
    if (enforceOrder && episode.head) { if (r.sequence <= episode.head.record.sequence) throw new LedgerError("sequence_reversed", "sequence must strictly increase within an episode"); if (Date.parse(r.occurredAt) < Date.parse(episode.head.record.occurredAt)) throw new LedgerError("chronology_reversed", "occurredAt must not move backward within an episode"); if (envelope.previousDigest !== episode.head.digest) throw new LedgerError("chain_mismatch", "commit chain does not extend the episode head"); }
    else if (!episode.head && envelope.previousDigest !== null) throw new LedgerError("chain_mismatch", "first commit must have null previous digest");
    episode.records.push(envelope); episode.head = envelope; this.episodes.set(r.episode.id, episode); this.eventIds.set(r.event.id, eventDigest); return "committed";
  }
  async #quarantine(reason, context, materialPath) {
    const id = `${Date.now()}-${randomUUID()}`, base = this.#path("quarantine", id);
    const diagnostic = stable({ format: 1, reason, context, quarantinedAt: new Date().toISOString() });
    await writeFile(`${base}.json`, diagnostic, { flag: "wx", mode: 0o600 }); await fsyncFile(`${base}.json`);
    if (materialPath && await exists(materialPath)) await rename(materialPath, `${base}.material`).catch(() => {});
  }
  async #recountStorage() {
    let total = 0;
    const visit = async (directory) => { await this.#assertSafeDirectory(directory); for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); const info = await lstat(path); if (info.isSymbolicLink()) throw new LedgerError("unsafe_path", "managed ledger paths must not be symlinks", { path }); if (info.isDirectory()) await visit(path); else if (info.isFile()) total += info.size; else throw new LedgerError("unsafe_path", "managed ledger paths must be regular files", { path }); } };
    for (const directory of ["commits", "artifacts", "quarantine", "projections", "exports"]) await visit(this.#path(directory));
    total += (await lstat(this.#path("manifest.json"))).size;
    if (total > this.limits.maxStorageBytes) throw new LedgerLimitError("maxStorageBytes", total, this.limits.maxStorageBytes); this.storageBytes = total;
  }
  #enqueue(partition, operation) {
    if (this.closed || this.closing) return Promise.reject(new LedgerError("closed", "ledger is closing or closed"));
    if (this.pending >= this.limits.maxPendingWrites) return Promise.reject(new LedgerLimitError("maxPendingWrites", this.pending + 1, this.limits.maxPendingWrites));
    this.pending += 1; const prior = this.queues.get(partition) ?? Promise.resolve(); const next = prior.catch(() => {}).then(async () => { if (this.closing || this.closed) throw new LedgerError("closed", "ledger is closing or closed"); return operation(); });
    const tracked = next.then(() => { this.pending -= 1; if (this.queues.get(partition) === tracked) this.queues.delete(partition); }, () => { this.pending -= 1; if (this.queues.get(partition) === tracked) this.queues.delete(partition); });
    this.queues.set(partition, tracked); return next;
  }
  async appendEpisode(record, { artifacts = [] } = {}) { return this.#append("episode", record, undefined, artifacts); }
  async appendEvolution(record, evolution, { artifacts = [] } = {}) { return this.#append("evolution", record, evolution, artifacts); }
  async #append(type, record, evolution, artifacts) {
    if (!record?.episode?.id) throw new LedgerError("record_invalid", "record must include an episode identity");
    return this.#enqueue("global-admission", async () => {
      if (1 > this.limits.maxRecordsPerAppend) throw new LedgerLimitError("maxRecordsPerAppend", 1, this.limits.maxRecordsPerAppend);
      const refs = await this.#verifyArtifactRefs(artifacts); const episode = this.episodes.get(record.episode.id);
      const envelope = { format: 1, type, record, artifacts: refs, previousDigest: episode?.head?.digest ?? null };
      if (type === "evolution") envelope.evolution = evolution;
      envelope.digest = recordDigest({ format: envelope.format, type: envelope.type, record: envelope.record, evolution: envelope.evolution, artifacts: envelope.artifacts, previousDigest: envelope.previousDigest });
      const encoded = stable(envelope); const bytes = enc.encode(encoded).byteLength;
      if (bytes > this.limits.maxEncodedRecordBytes) throw new LedgerLimitError("maxEncodedRecordBytes", bytes, this.limits.maxEncodedRecordBytes);
      this.#validateEnvelope(envelope); const existing = this.eventIds.get(record.event.id);
      if (existing) { const committed = [...this.episodes.values()].flatMap((entry) => entry.records).find((entry) => entry.record.event.id === record.event.id); if (committed && stable({ type: committed.type, record: committed.record, evolution: committed.evolution, artifacts: committed.artifacts }) === stable({ type, record, evolution, artifacts: refs })) return { status: "idempotent", digest: existing }; throw new LedgerConflictError(record.event.id, { existingDigest: existing, receivedDigest: envelope.digest }); }
      if (this.storageBytes + bytes > this.limits.maxStorageBytes) throw new LedgerLimitError("maxStorageBytes", this.storageBytes + bytes, this.limits.maxStorageBytes);
      if (this.eventIds.size >= this.limits.maxIndexEntries) throw new LedgerLimitError("maxIndexEntries", this.eventIds.size + 1, this.limits.maxIndexEntries);
      this.#assertAppendable(envelope);
      const targetDirectory = this.#path("commits", safeSegment(record.episode.id)); await mkdir(targetDirectory, { recursive: true }); await this.#assertSafeDirectory(targetDirectory); const target = join(targetDirectory, `commit-${String(record.sequence).padStart(16, "0")}-${envelope.digest}.json`);
      try { await this.#atomicCreate(target, encoded, "commit"); } catch (error) { if (error.code !== "EEXIST") throw error; const published = JSON.parse(await readFile(target, "utf8")); this.#admitLoaded(published, safeSegment(record.episode.id), basename(target)); this.storageBytes += (await stat(target)).size; return { status: "idempotent", digest: published.digest }; }
      this.#admit(envelope, true); this.storageBytes += bytes; return { status: "committed", digest: envelope.digest };
    });
  }
  async writeArtifact(bytes, metadata) {
    return this.#enqueue("global-admission", async () => {
      if (!(bytes instanceof Uint8Array) || !metadata || typeof metadata.identity !== "string" || typeof metadata.evidenceClass !== "string" || typeof metadata.coverage !== "string" || typeof metadata.provenance !== "string" || typeof metadata.sensitivity !== "string") throw new LedgerError("artifact_invalid", "artifact bytes and identity/evidence metadata are required");
      if (bytes.byteLength > this.limits.maxArtifactBytes) throw new LedgerLimitError("maxArtifactBytes", bytes.byteLength, this.limits.maxArtifactBytes);
      const digest = hash(bytes); const ref = { digest, size: bytes.byteLength, ...metadata }; const target = this.#path("artifacts", digest); await this.#assertSafeDirectory(this.#path("artifacts"));
      if (await exists(target)) { await this.#verifyArtifactRefs([ref]); return ref; }
      if (this.storageBytes + bytes.byteLength > this.limits.maxStorageBytes) throw new LedgerLimitError("maxStorageBytes", this.storageBytes + bytes.byteLength, this.limits.maxStorageBytes);
      await this.#atomicCreate(target, bytes, "artifact"); this.storageBytes += bytes.byteLength; return ref;
    });
  }
  async #verifyArtifactRefs(refs) { for (const ref of refs) this.#validateArtifactRef(ref); return Promise.all(refs.map(async (ref) => { const path = this.#path("artifacts", ref.digest); let bytes; try { const info = await lstat(path); if (info.isSymbolicLink() || !info.isFile()) throw new LedgerError("artifact_unsafe_path", "artifact path is not a regular file", { digest: ref.digest }); bytes = await readFile(path); } catch (error) { if (error instanceof LedgerError) throw error; throw new LedgerError("artifact_missing", "referenced artifact is missing", { digest: ref.digest }); } if (bytes.byteLength !== ref.size || hash(bytes) !== ref.digest) throw new LedgerError("artifact_integrity_failed", "artifact digest or size mismatch", { digest: ref.digest }); return { ...ref }; })); }
  async queryEpisode(episodeId, { limit = this.limits.maxQueryRecords, maxBytes = this.limits.maxQueryBytes } = {}) { return this.#query(this.episodes.get(episodeId)?.records ?? [], limit, maxBytes); }
  async queryEvolutions({ outcome, limit = this.limits.maxQueryRecords, maxBytes = this.limits.maxQueryBytes } = {}) { return this.#query([...this.episodes.values()].flatMap((e) => e.records).filter((r) => r.type === "evolution" && (!outcome || r.evolution.outcome === outcome)), limit, maxBytes); }
  #query(records, limit, maxBytes) { if (!Number.isSafeInteger(limit) || limit < 0) throw new LedgerError("query_invalid", "limit must be a non-negative safe integer"); if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new LedgerError("query_invalid", "maxBytes must be a non-negative safe integer"); if (limit > this.limits.maxQueryRecords) throw new LedgerLimitError("maxQueryRecords", limit, this.limits.maxQueryRecords); if (maxBytes > this.limits.maxQueryBytes) throw new LedgerLimitError("maxQueryBytes", maxBytes, this.limits.maxQueryBytes); const result = []; let bytes = 0; for (const item of records) { const size = enc.encode(stable(item)).byteLength; if (result.length === limit || bytes + size > maxBytes) break; result.push(structuredClone(item)); bytes += size; } return { records: result, truncated: result.length < records.length, bytes }; }
  async rebuildProjection({ name = "episode-index", version = 1, batchSize = this.limits.maxRebuildBatch } = {}) { if (!/^[a-z0-9-]{1,64}$/.test(name) || !Number.isSafeInteger(version) || version < 1) throw new LedgerError("projection_invalid", "invalid projection name or version"); if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new LedgerError("projection_invalid", "batchSize must be a positive safe integer"); if (batchSize > this.limits.maxRebuildBatch) throw new LedgerLimitError("maxRebuildBatch", batchSize, this.limits.maxRebuildBatch); const records = [...this.episodes.values()].flatMap((e) => e.records).sort((a, b) => a.digest.localeCompare(b.digest)); const projection = { format: 1, name, version, records: records.map((r) => ({ eventId: r.record.event.id, episodeId: r.record.episode.id, digest: r.digest, type: r.type, outcome: r.evolution?.outcome ?? null })) }; const body = stable(projection); const bytes = enc.encode(body).byteLength; if (this.storageBytes + bytes > this.limits.maxStorageBytes) throw new LedgerLimitError("maxStorageBytes", this.storageBytes + bytes, this.limits.maxStorageBytes); const digest = hash(body); await this.#assertSafeDirectory(this.#path("projections")); await this.#atomicCreate(this.#path("projections", `${name}-v${version}-${digest}.json`), body, "projection"); this.storageBytes += bytes; return { digest, records: projection.records.length }; }
  async finalSnapshot({ maxBytes = this.limits.maxExportBytes } = {}) { const all = [...this.episodes.values()].flatMap((e) => e.records).sort((a, b) => a.digest.localeCompare(b.digest)); const quarantines = (await readdir(this.#path("quarantine"))).filter((n) => n.endsWith(".json")).sort(); const snapshot = { format: 1, kind: "final_snapshot", records: all, quarantines, partial: quarantines.length > 0, generatedAt: "deterministic" }; const contents = stable(snapshot); const size = enc.encode(contents).byteLength; if (size > maxBytes || size > this.limits.maxExportBytes) throw new LedgerLimitError("maxExportBytes", size, Math.min(maxBytes, this.limits.maxExportBytes)); return { digest: hash(contents), contents, partial: snapshot.partial }; }
  async exportLedger({ maxBytes = this.limits.maxExportBytes } = {}) { const snapshot = await this.finalSnapshot({ maxBytes }); const bytes = enc.encode(snapshot.contents).byteLength; if (this.storageBytes + bytes > this.limits.maxStorageBytes) throw new LedgerLimitError("maxStorageBytes", this.storageBytes + bytes, this.limits.maxStorageBytes); await this.#assertSafeDirectory(this.#path("exports")); const target = this.#path("exports", `${snapshot.digest}.json`); if (!await exists(target)) { await this.#atomicCreate(target, snapshot.contents, "export"); this.storageBytes += bytes; } return snapshot; }
  async backup({ maxBytes = this.limits.maxExportBytes } = {}) { return this.exportLedger({ maxBytes }); }
  async verifyIntegrity() { const findings = []; const loaded = this.episodes.size; for (const [id, episode] of this.episodes) for (const envelope of episode.records) { try { this.#validateEnvelope(envelope); await this.#verifyArtifactRefs(envelope.artifacts ?? []); } catch (error) { findings.push({ episodeId: id, eventId: envelope.record.event.id, ...asError(error) }); } } const quarantines = (await readdir(this.#path("quarantine"))).filter((n) => n.endsWith(".json")); return { ok: findings.length === 0 && quarantines.length === 0, episodes: loaded, findings, quarantines } }
  async migrate({ fromVersion, toVersion = LEDGER_FORMAT_VERSION, batchSize = this.limits.maxMigrationBatch } = {}) { if (batchSize > this.limits.maxMigrationBatch) throw new LedgerLimitError("maxMigrationBatch", batchSize, this.limits.maxMigrationBatch); if (fromVersion !== LEDGER_FORMAT_VERSION || toVersion !== LEDGER_FORMAT_VERSION) throw new LedgerError("migration_unsupported", "no legacy or future ledger format is accepted; source data remains untouched"); return { status: "already_current", version: LEDGER_FORMAT_VERSION }; }
}
