import { mkdir, open, realpath, rename, lstat, stat, unlink, rmdir, opendir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/;
// Pi subagent artifact directories normally contain a small number of local run files; bound all
// entries to prevent a large unrelated artifact directory from delaying receipt creation.
export const MAX_ARTIFACT_DIRECTORY_ENTRIES = 1_000;
// This separate limit bounds metadata eligible for parsing after the total-entry limit is applied.
export const MAX_ARTIFACT_FILES = 100;
export const MAX_ARTIFACT_BYTES = 65_536;
const SAFE_METADATA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}_meta\.json$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const TICKET_COST_LIFECYCLE_EVENT = "ticket-cost:v1:lifecycle";
export const TICKET_COST_LIFECYCLE_RESULT_EVENT = "ticket-cost:v1:lifecycle-result";
const MAX_SAFE_OBSERVATION = Number.MAX_SAFE_INTEGER;
const nodeFs = { mkdir, open, realpath, rename, lstat, stat, unlink, rmdir, opendir };

class UnsafeTicketCostObservationError extends Error {
  constructor() { super("Unsafe or out-of-range ticket-cost observation; receipt was not written."); }
}

function isObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNonnegativeFinite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SAFE_OBSERVATION; }
function checkedAdd(left, right) {
  if (!isNonnegativeFinite(left) || !isNonnegativeFinite(right) || left + right > MAX_SAFE_OBSERVATION) throw new UnsafeTicketCostObservationError();
  return left + right;
}
function checkedSubtract(left, right) {
  if (!isNonnegativeFinite(left) || !isNonnegativeFinite(right) || left < right) throw new UnsafeTicketCostObservationError();
  return left - right;
}
function stableCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function assertContained(root, candidate) {
  const target = resolve(candidate); const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("../") && !rel.startsWith("..\\") && rel !== "..")) return target;
  throw new Error("Ticket-cost path escaped the project root.");
}
function sameFile(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }
async function lstatOrUndefined(fs, path) { try { return await fs.lstat(path); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; } }
async function unlinkIfPresent(fs, path) { try { await fs.unlink(path); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
async function canonicalProjectRoot(fs, cwd) {
  try { return await fs.realpath(resolve(cwd)); } catch { throw new Error("Unable to resolve the local project root."); }
}
async function containedRealpath(fs, root, path) { return assertContained(root, await fs.realpath(path)); }
async function assertSafeReceiptDirectory(fs, root, directory) {
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Refusing unsafe ticket-cost output directory.");
  const canonicalDirectory = await containedRealpath(fs, root, directory);
  if (canonicalDirectory !== directory) throw new Error("Refusing to write through a symbolic ticket-cost output path.");
  return canonicalDirectory;
}
// Node lacks portable openat/O_NOFOLLOW-style parent-directory binding. These canonical-path and
// post-open fstat identity checks mitigate replacements, but cannot close a race after the final check.
async function verifyOpenedFile(fs, root, path, handle, fileStat) {
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Refusing unsafe ticket-cost file.");
  const canonicalPath = await containedRealpath(fs, root, path);
  const currentStat = await fs.stat(canonicalPath);
  if (!sameFile(fileStat, currentStat)) throw new Error("Ticket-cost file changed while it was being verified.");
  return canonicalPath;
}

function metadataUsageNumber(usage, keys) {
  const values = keys.filter((key) => key in usage).map((key) => usage[key]);
  if (values.length === 0) return undefined;
  if (values.some((value) => !isNonnegativeFinite(value)) || values.some((value) => value !== values[0])) throw new UnsafeTicketCostObservationError();
  return values[0];
}
function safeMetadata(value) {
  if (!isObject(value) || !SAFE_ID.test(value.runId) || !SAFE_ID.test(value.agent) || !isObject(value.usage)) return undefined;
  const rawCost = value.usage.cost;
  const cost = isNonnegativeFinite(rawCost) ? rawCost : isObject(rawCost) && "total" in rawCost ? rawCost.total : undefined;
  if (cost === undefined) return undefined;
  if (!isNonnegativeFinite(cost)) throw new UnsafeTicketCostObservationError();
  const tokens = {};
  for (const [key, aliases] of [["input", ["input", "inputTokens"]], ["output", ["output", "outputTokens"]], ["cacheRead", ["cacheRead"]], ["cacheWrite", ["cacheWrite"]]]) {
    const tokenCount = metadataUsageNumber(value.usage, aliases);
    if (tokenCount !== undefined) tokens[key] = tokenCount;
  }
  const turns = metadataUsageNumber(value.usage, ["turns"]);
  const model = typeof value.model === "string" && SAFE_MODEL.test(value.model) ? value.model : undefined;
  return { runId: value.runId, agent: value.agent, cost, ...(Object.keys(tokens).length ? { tokens } : {}), ...(turns === undefined ? {} : { turns }), ...(model === undefined ? {} : { model }) };
}

function hasUnsafeAssistantUsage(event) {
  const usage = event?.message?.role === "assistant" ? event.message.usage : undefined;
  if (!isObject(usage) || usage.cost === undefined) return false;
  if (!isObject(usage.cost) || !isNonnegativeFinite(usage.cost.total)) return true;
  return ["input", "output", "cacheRead", "cacheWrite"].some((key) => key in usage && !isNonnegativeFinite(usage[key]));
}

export function parseTicketCostArguments(args) {
  const values = typeof args === "string" ? args.trim().split(/\s+/).filter(Boolean) : [];
  if (values.length !== 2 || (values[0] !== "begin" && values[0] !== "close") || !TICKET_KEY_PATTERN.test(values[1])) throw new Error("Usage: /ticket-cost begin <TICKET-KEY> or /ticket-cost close <TICKET-KEY>.");
  return { action: values[0], ticket: values[1] };
}

/** Strict, local-only protocol for a trusted ticket-loop extension on Pi's in-process event bus. */
export function parseTicketCostLifecycleSignal(value) {
  if (!isObject(value) || value.version !== 1 || !SAFE_REQUEST_ID.test(value.requestId) || (value.action !== "begin" && value.action !== "close") || !TICKET_KEY_PATTERN.test(value.ticket)) throw new Error("Invalid ticket-cost lifecycle signal.");
  return { version: 1, requestId: value.requestId, action: value.action, ticket: value.ticket };
}

export function assistantUsage(event) {
  const message = event?.message;
  if (!message || message.role !== "assistant" || !isObject(message.usage) || hasUnsafeAssistantUsage(event)) return undefined;
  const total = message.usage.cost?.total;
  if (!isNonnegativeFinite(total)) return undefined;
  const tokens = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) if (isNonnegativeFinite(message.usage[key])) tokens[key] = message.usage[key];
  return { total, tokens };
}

export function assistantCostTotal(event) { return assistantUsage(event)?.total; }

export function inferReviewRounds(agents) {
  const rounds = new Set();
  for (const agent of agents) { const match = /^review(?:er)?[-_](\d{1,3})$/.exec(agent); if (match) rounds.add(Number(match[1])); }
  return rounds.size || undefined;
}

function rankedCostDrivers(parentDelta, agentCosts) {
  if (!isNonnegativeFinite(parentDelta) || !Array.isArray(agentCosts) || agentCosts.some(({ agent, cost }) => !SAFE_ID.test(agent) || !isNonnegativeFinite(cost))) throw new UnsafeTicketCostObservationError();
  return [{ label: "parent", cost: parentDelta }, ...agentCosts.map(({ agent, cost }) => ({ label: `agent:${agent}`, cost }))]
    .sort((left, right) => right.cost - left.cost || stableCompare(left.label, right.label));
}

export function majorCostDrivers(parentDelta, agentCosts) {
  return rankedCostDrivers(parentDelta, agentCosts).map(({ label, cost }, index) => `${index + 1}. ${label}: $${cost.toFixed(6)}`);
}

export function majorCostDriverSentence(parentDelta, agentCosts) {
  const driver = rankedCostDrivers(parentDelta, agentCosts)[0];
  return `Major cost driver: ${driver.label} at $${driver.cost.toFixed(6)}.`;
}

async function readSafeMetadataFile({ fs, root, artifactDirectory, name, startedAt, endedAt }) {
  const path = assertContained(root, join(artifactDirectory, name));
  let handle;
  try {
    handle = await fs.open(path, "r");
    const fileStat = await handle.stat();
    const canonicalPath = await verifyOpenedFile(fs, root, path, handle, fileStat);
    if (!Number.isFinite(fileStat.size) || fileStat.size <= 0 || fileStat.size > MAX_ARTIFACT_BYTES || fileStat.mtimeMs < startedAt || fileStat.mtimeMs > endedAt) return undefined;
    const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    // Re-check the name after reading: a path replacement must still identify the opened file.
    await verifyOpenedFile(fs, root, canonicalPath, handle, fileStat);
    return safeMetadata(parsed);
  } catch (error) { if (error instanceof UnsafeTicketCostObservationError) throw error; return undefined; }
  finally { await handle?.close(); }
}

export async function scanArtifactMetadata({ cwd, startedAt, endedAt, fs = nodeFs }) {
  const root = await canonicalProjectRoot(fs, cwd);
  const requestedDirectory = assertContained(root, join(root, ".pi", "subagents", "artifacts"));
  let artifactDirectory;
  try {
    const directoryStat = await fs.lstat(requestedDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return [];
    artifactDirectory = await containedRealpath(fs, root, requestedDirectory);
    if (artifactDirectory !== requestedDirectory) return [];
  } catch (error) { if (error?.code === "ENOENT") return []; throw new Error("Unable to scan local subagent artifacts."); }

  const names = [];
  let directoryEntries = 0;
  try {
    const directory = await fs.opendir(artifactDirectory);
    for await (const entry of directory) {
      // Apply the total-entry bound before type and name filters so unrelated artifacts cannot cause unbounded traversal.
      if (directoryEntries === MAX_ARTIFACT_DIRECTORY_ENTRIES) throw new Error("Local subagent artifact directory reached the safe scan limit; receipt was not written.");
      directoryEntries++;
      if (!entry?.isFile?.() || entry?.isSymbolicLink?.() || !SAFE_METADATA_NAME.test(entry.name)) continue;
      // Keep a distinct cap for eligible metadata rather than materializing an unbounded candidate list.
      if (names.length === MAX_ARTIFACT_FILES) throw new Error("Local subagent metadata reached the safe scan limit; receipt was not written.");
      names.push(entry.name);
    }
  } catch (error) {
    if (error?.message === "Local subagent artifact directory reached the safe scan limit; receipt was not written." || error?.message === "Local subagent metadata reached the safe scan limit; receipt was not written.") throw error;
    throw new Error("Unable to scan local subagent artifacts.");
  }

  names.sort(stableCompare);
  const records = [];
  for (const name of names) {
    const metadata = await readSafeMetadataFile({ fs, root, artifactDirectory, name, startedAt, endedAt });
    if (metadata) records.push(metadata);
  }
  return records.sort((left, right) => stableCompare(left.runId, right.runId) || stableCompare(left.agent, right.agent));
}

function addAggregate(aggregates, key, record) {
  const aggregate = aggregates.get(key) ?? { cost: 0, tokens: {}, turns: 0, runs: 0 };
  aggregate.cost = checkedAdd(aggregate.cost, record.cost);
  for (const [token, value] of Object.entries(record.tokens ?? {})) aggregate.tokens[token] = checkedAdd(aggregate.tokens[token] ?? 0, value);
  aggregate.turns = checkedAdd(aggregate.turns, record.turns ?? 0);
  aggregate.runs = checkedAdd(aggregate.runs, 1);
  aggregates.set(key, aggregate);
}
function aggregateEntries(aggregates, label) {
  return [...aggregates.entries()].map(([name, aggregate]) => ({ [label]: name, cost: aggregate.cost, runs: aggregate.runs, ...(Object.keys(aggregate.tokens).length ? { tokens: aggregate.tokens } : {}), ...(aggregate.turns ? { turns: aggregate.turns } : {}) })).sort((left, right) => stableCompare(left[label], right[label]));
}
export function summarizeCosts({ ticket, startedAt, endedAt, parentDelta, parentTokens, records }) {
  if (!isNonnegativeFinite(parentDelta) || !Array.isArray(records)) throw new UnsafeTicketCostObservationError();
  const agentAggregates = new Map(); const modelAggregates = new Map(); const runIds = new Set();
  for (const record of records) {
    if (!record || !SAFE_ID.test(record.runId) || !SAFE_ID.test(record.agent) || !isNonnegativeFinite(record.cost) || (record.tokens !== undefined && (!isObject(record.tokens) || Object.values(record.tokens).some((value) => !isNonnegativeFinite(value)))) || (record.turns !== undefined && !isNonnegativeFinite(record.turns)) || (record.model !== undefined && (typeof record.model !== "string" || !SAFE_MODEL.test(record.model))) || runIds.has(record.runId)) throw new UnsafeTicketCostObservationError();
    runIds.add(record.runId); addAggregate(agentAggregates, record.agent, record); if (record.model !== undefined) addAggregate(modelAggregates, record.model, record);
  }
  const agents = aggregateEntries(agentAggregates, "agent"); const models = aggregateEntries(modelAggregates, "model");
  const subagentTotal = agents.reduce((total, entry) => checkedAdd(total, entry.cost), 0);
  const total = checkedAdd(parentDelta, subagentTotal);
  if (parentTokens && Object.values(parentTokens).some((value) => !isNonnegativeFinite(value))) throw new UnsafeTicketCostObservationError();
  const subagentTokens = {}; let subagentTurns = 0;
  for (const agent of agents) { for (const [key, value] of Object.entries(agent.tokens ?? {})) subagentTokens[key] = checkedAdd(subagentTokens[key] ?? 0, value); subagentTurns = checkedAdd(subagentTurns, agent.turns ?? 0); }
  const receipt = { version: 2, ticket, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), parentDelta, subagentTotal, total, subagentRuns: runIds.size, agents, models, majorCostDriver: majorCostDriverSentence(parentDelta, agents), majorCostDrivers: majorCostDrivers(parentDelta, agents) };
  if (parentTokens && Object.keys(parentTokens).length) receipt.parentTokens = parentTokens;
  if (Object.keys(subagentTokens).length) receipt.subagentTokens = subagentTokens;
  if (subagentTurns) receipt.subagentTurns = subagentTurns;
  const reviewRounds = inferReviewRounds(agents.map(({ agent }) => agent)); if (reviewRounds !== undefined) receipt.reviewRounds = reviewRounds;
  return receipt;
}

export function receiptMarkdown(receipt) {
  assertReceiptSafe(receipt);
  const lines = [`# Ticket cost receipt: ${receipt.ticket}`, "", `- Start: ${receipt.startedAt}`, `- End: ${receipt.endedAt}`, `- Parent delta: $${receipt.parentDelta.toFixed(6)}`, `- Subagent total: $${receipt.subagentTotal.toFixed(6)}`, `- Total: $${receipt.total.toFixed(6)}`];
  if (receipt.parentTokens && Object.keys(receipt.parentTokens).length) lines.push(`- Parent tokens: ${Object.entries(receipt.parentTokens).map(([kind, count]) => `${kind}=${count}`).join(", ")}`);
  if (receipt.subagentTokens && Object.keys(receipt.subagentTokens).length) lines.push(`- Subagent tokens: ${Object.entries(receipt.subagentTokens).map(([kind, count]) => `${kind}=${count}`).join(", ")}`);
  if (receipt.subagentTurns !== undefined) lines.push(`- Subagent turns: ${receipt.subagentTurns}`);
  if (receipt.subagentRuns !== undefined) lines.push(`- Subagent runs: ${receipt.subagentRuns}`);
  if (receipt.reviewRounds !== undefined) lines.push(`- Review rounds: ${receipt.reviewRounds}`);
  const aggregateLine = ({ name, cost, runs, tokens, turns }) => `- ${name}: $${cost.toFixed(6)} (runs=${runs})${tokens && Object.keys(tokens).length ? ` (${Object.entries(tokens).map(([kind, count]) => `${kind}=${count}`).join(", ")})` : ""}${turns !== undefined ? ` (turns=${turns})` : ""}`;
  lines.push("", "## Agent aggregate", "");
  if (receipt.agents.length) lines.push(...receipt.agents.map(({ agent, ...entry }) => aggregateLine({ name: agent, ...entry }))); else lines.push("- No eligible subagent metadata in the window.");
  lines.push("", "## Model aggregate", "");
  if (receipt.models.length) lines.push(...receipt.models.map(({ model, ...entry }) => aggregateLine({ name: model, ...entry }))); else lines.push("- No eligible model metadata in the window.");
  lines.push("", "## Major cost drivers", "", ...receipt.majorCostDrivers.map((driver) => `- ${driver}`), "", "## Linear closeout (paste locally)", "", "```text", `Ticket: ${receipt.ticket}`, `Cost window: ${receipt.startedAt} to ${receipt.endedAt}`, `Parent delta: $${receipt.parentDelta.toFixed(6)}`, `Subagent total: $${receipt.subagentTotal.toFixed(6)}`, `Total: $${receipt.total.toFixed(6)}`, receipt.majorCostDriver, "```");
  return `${lines.join("\n")}\n`;
}

async function writeExclusive(fs, root, outputDirectory, path, content) {
  await assertSafeReceiptDirectory(fs, root, outputDirectory);
  const handle = await fs.open(path, "wx");
  try {
    const fileStat = await handle.stat();
    await verifyOpenedFile(fs, root, path, handle, fileStat);
    await handle.writeFile(content, "utf8");
    await verifyOpenedFile(fs, root, path, handle, fileStat);
  } finally { await handle.close(); }
}

function safeAggregateEntry(entry, key, pattern) {
  return isObject(entry) && typeof entry[key] === "string" && pattern.test(entry[key]) && isNonnegativeFinite(entry.cost) && isNonnegativeFinite(entry.runs) && (entry.tokens === undefined || isObject(entry.tokens) && Object.values(entry.tokens).every(isNonnegativeFinite)) && (entry.turns === undefined || isNonnegativeFinite(entry.turns));
}
function assertReceiptSafe(receipt) {
  if (!isObject(receipt) || !TICKET_KEY_PATTERN.test(receipt.ticket) || !isNonnegativeFinite(receipt.parentDelta) || !isNonnegativeFinite(receipt.subagentTotal) || !isNonnegativeFinite(receipt.total) || !isNonnegativeFinite(receipt.subagentRuns) || !Array.isArray(receipt.agents) || receipt.agents.some((entry) => !safeAggregateEntry(entry, "agent", SAFE_ID)) || !Array.isArray(receipt.models) || receipt.models.some((entry) => !safeAggregateEntry(entry, "model", SAFE_MODEL)) || (receipt.parentTokens && (!isObject(receipt.parentTokens) || Object.values(receipt.parentTokens).some((value) => !isNonnegativeFinite(value)))) || (receipt.subagentTokens && (!isObject(receipt.subagentTokens) || Object.values(receipt.subagentTokens).some((value) => !isNonnegativeFinite(value)))) || (receipt.subagentTurns !== undefined && !isNonnegativeFinite(receipt.subagentTurns))) throw new UnsafeTicketCostObservationError();
}
async function removeStagingReceipt(fs, directory) {
  await Promise.all([unlinkIfPresent(fs, join(directory, "receipt.json")), unlinkIfPresent(fs, join(directory, "receipt.md"))]);
  try { await fs.rmdir(directory); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export async function writeReceipt({ cwd, receipt, fs = nodeFs }) {
  assertReceiptSafe(receipt);
  const root = await canonicalProjectRoot(fs, cwd);
  const piDirectory = assertContained(root, join(root, ".pi"));
  const outputDirectory = assertContained(root, join(piDirectory, "ticket-costs"));
  const existingPi = await lstatOrUndefined(fs, piDirectory); if (existingPi?.isSymbolicLink()) throw new Error("Refusing to write through a symbolic .pi directory.");
  await fs.mkdir(outputDirectory, { recursive: true });
  await assertSafeReceiptDirectory(fs, root, piDirectory);
  await assertSafeReceiptDirectory(fs, root, outputDirectory);
  const stamp = receipt.endedAt.replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? "" : `-${attempt}`; const base = `${receipt.ticket}-${stamp}${suffix}`;
    const finalDirectory = assertContained(root, join(outputDirectory, base)); const stagingDirectory = assertContained(root, join(outputDirectory, `.${base}.staging`)); const lockPath = assertContained(root, join(outputDirectory, `${base}.lock`));
    await assertSafeReceiptDirectory(fs, root, outputDirectory);
    let lock; try { lock = await fs.open(lockPath, "wx"); } catch (error) { if (error?.code === "EEXIST") continue; throw error; }
    try { await verifyOpenedFile(fs, root, lockPath, lock, await lock.stat()); } finally { await lock.close(); }
    if (await lstatOrUndefined(fs, finalDirectory)) { await unlinkIfPresent(fs, lockPath); continue; }
    try {
      await fs.mkdir(stagingDirectory); await assertSafeReceiptDirectory(fs, root, stagingDirectory);
      const jsonPath = assertContained(root, join(stagingDirectory, "receipt.json")); const markdownPath = assertContained(root, join(stagingDirectory, "receipt.md"));
      await writeExclusive(fs, root, stagingDirectory, jsonPath, `${JSON.stringify(receipt, null, 2)}\n`);
      await writeExclusive(fs, root, stagingDirectory, markdownPath, receiptMarkdown(receipt));
      await assertSafeReceiptDirectory(fs, root, stagingDirectory); await assertSafeReceiptDirectory(fs, root, outputDirectory);
      // A completed receipt becomes visible in one directory-rename transaction, after both files exist.
      await fs.rename(stagingDirectory, finalDirectory);
      return { jsonPath: join(finalDirectory, "receipt.json"), markdownPath: join(finalDirectory, "receipt.md") };
    } catch (error) { await removeStagingReceipt(fs, stagingDirectory); throw error; }
    finally { await unlinkIfPresent(fs, lockPath); }
  }
  throw new Error("Unable to reserve a unique ticket-cost receipt name.");
}

export class TicketCostLifecycle {
  constructor({ now = () => Date.now(), fs = nodeFs } = {}) {
    this.now = now; this.fs = fs; this.parentTotal = 0; this.parentTokens = {}; this.window = undefined;
    this.closing = false; this.generation = 0; this.unsafeObservation = false;
  }
  observeMessage(event) {
    if (hasUnsafeAssistantUsage(event)) { this.unsafeObservation = true; return; }
    const usage = assistantUsage(event); if (!usage) return;
    try {
      this.parentTotal = checkedAdd(this.parentTotal, usage.total);
      for (const [key, value] of Object.entries(usage.tokens)) this.parentTokens[key] = checkedAdd(this.parentTokens[key] ?? 0, value);
    } catch (error) { if (error instanceof UnsafeTicketCostObservationError) this.unsafeObservation = true; else throw error; }
  }
  begin(ticket) {
    if (this.closing) throw new Error("A ticket-cost receipt is closing; wait before beginning another window.");
    if (this.window) throw new Error(`A ticket-cost window for ${this.window.ticket} is already active.`);
    if (this.unsafeObservation) throw new UnsafeTicketCostObservationError();
    this.window = { ticket, startedAt: this.now(), baseline: this.parentTotal, tokenBaseline: { ...this.parentTokens } }; this.generation++;
    return this.window;
  }
  reset() { this.generation++; this.window = undefined; this.parentTotal = 0; this.parentTokens = {}; this.unsafeObservation = false; }
  async close(ticket, cwd) {
    if (this.closing) throw new Error("A ticket-cost receipt is already closing.");
    if (!this.window) throw new Error("No active in-memory ticket-cost window. Start again after reload or session switch.");
    if (this.window.ticket !== ticket) throw new Error(`Active ticket-cost window is ${this.window.ticket}; close that ticket or start a new window.`);
    if (this.unsafeObservation) throw new UnsafeTicketCostObservationError();
    // Snapshot the complete accounting window synchronously before the first await. Messages that
    // arrive while local artifact scanning is pending belong to the next accounting interval.
    const endedAt = this.now(); const window = this.window; const generation = this.generation;
    const parentTotal = this.parentTotal; const parentTotals = { ...this.parentTokens }; this.closing = true;
    try {
      const records = await scanArtifactMetadata({ cwd, startedAt: window.startedAt, endedAt, fs: this.fs });
      if (this.unsafeObservation) throw new UnsafeTicketCostObservationError();
      // reset() or a replacement window invalidates this reserved snapshot; never publish it.
      if (this.generation !== generation || this.window !== window) throw new Error("Ticket-cost window changed while receipt was closing; receipt was not written.");
      const parentTokens = {}; for (const [key, value] of Object.entries(parentTotals)) parentTokens[key] = checkedSubtract(value, window.tokenBaseline[key] ?? 0);
      const receipt = summarizeCosts({ ticket, startedAt: window.startedAt, endedAt, parentDelta: checkedSubtract(parentTotal, window.baseline), parentTokens, records }); const paths = await writeReceipt({ cwd, receipt, fs: this.fs });
      // The generation check above reserves this window; only clear that exact window.
      if (this.generation === generation && this.window === window) this.window = undefined;
      return { receipt, ...paths };
    } finally { this.closing = false; }
  }
}

function trusted(ctx) { return typeof ctx?.isProjectTrusted === "function" && ctx.isProjectTrusted() === true; }

/** Local-only ticket-window accounting; no session, model, network, or tracker access. */
export default function ticketCost(pi) {
  const lifecycle = new TicketCostLifecycle();
  let sessionContext;
  const publishLifecycleResult = (signal, result) => pi.events?.emit?.(TICKET_COST_LIFECYCLE_RESULT_EVENT, { version: 1, requestId: signal.requestId, action: signal.action, ticket: signal.ticket, ...result });
  const applyLifecycleSignal = async (rawSignal) => {
    let signal;
    try { signal = parseTicketCostLifecycleSignal(rawSignal); } catch { return; }
    if (!trusted(sessionContext)) {
      publishLifecycleResult(signal, { ok: false, error: "Ticket cost requires a trusted project; no data was read or written." });
      return;
    }
    try {
      if (signal.action === "begin") {
        lifecycle.begin(signal.ticket);
        sessionContext?.ui?.notify?.(`Ticket-cost window started for ${signal.ticket}.`, "info");
        publishLifecycleResult(signal, { ok: true });
        return;
      }
      const result = await lifecycle.close(signal.ticket, sessionContext.cwd);
      sessionContext?.ui?.notify?.(`Ticket-cost receipt for ${signal.ticket}: total $${result.receipt.total.toFixed(6)}. Local closeout block is in ${result.markdownPath}.`, "info");
      publishLifecycleResult(signal, { ok: true, receipt: result.receipt, jsonPath: result.jsonPath, markdownPath: result.markdownPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create ticket-cost receipt.";
      sessionContext?.ui?.notify?.(message, "error");
      publishLifecycleResult(signal, { ok: false, error: message });
    }
  };
  let unsubscribe;
  const subscribe = () => { if (!unsubscribe) unsubscribe = pi.events?.on?.(TICKET_COST_LIFECYCLE_EVENT, (signal) => { void applyLifecycleSignal(signal); }); };
  pi.on("session_start", (_event, ctx) => { sessionContext = trusted(ctx) ? ctx : undefined; lifecycle.reset(); subscribe(); });
  pi.on("session_shutdown", () => { sessionContext = undefined; lifecycle.reset(); if (typeof unsubscribe === "function") unsubscribe(); unsubscribe = undefined; });
  subscribe();
  pi.on("message_end", (event, ctx) => { if (trusted(ctx)) lifecycle.observeMessage(event); });
  pi.registerCommand("ticket-cost", { description: "Begin or close a local, session-scoped ticket cost window", async handler(args, ctx) {
    if (!trusted(ctx)) { ctx?.ui?.notify?.("Ticket cost requires a trusted project; no data was read or written.", "error"); return; }
    try {
      const { action, ticket } = parseTicketCostArguments(args);
      if (action === "begin") { lifecycle.begin(ticket); ctx?.ui?.notify?.(`Ticket-cost window started for ${ticket}.`, "info"); return; }
      const result = await lifecycle.close(ticket, ctx.cwd);
      ctx?.ui?.notify?.(`Ticket-cost receipt for ${ticket}: total $${result.receipt.total.toFixed(6)}. Local closeout block is in ${result.markdownPath}.`, "info");
    } catch (error) { ctx?.ui?.notify?.(error instanceof Error ? error.message : "Unable to create ticket-cost receipt.", "error"); }
  }});
}
