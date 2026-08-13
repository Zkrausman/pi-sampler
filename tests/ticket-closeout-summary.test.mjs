import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseCloseoutSummary, parseFinalizedReceipt, readCloseoutSummary, renderCloseoutMarkdown, TicketCloseoutSummaryError } from "../extensions/ticket-closeout-summary/src/index.mjs";

const execFileAsync = promisify(execFile);
const evidence = (ref) => [{ ref, sha256: "a".repeat(64) }];
const completed = (id, total = 3, parentDelta = 1, subagentTotal = 2, subagentRuns = 1) => ({ id, session: `session-${id}`, startRequestId: `start-${id}`, settleRequestId: `settle-${id}`, coverage: "complete", receipt: { total, parentDelta, subagentTotal, subagentRuns } });
const receipt = ({ partial = false } = {}) => ({ version: 1, ticket: "AIDEV-76", pickedUpAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-01-01T00:01:00.000Z", coverage: partial ? "partial" : "complete", total: 3, parentDelta: 1, subagentTotal: 2, subagentRuns: 1, segments: [completed("one"), ...(partial ? [{ id: "two", session: "session-two", startRequestId: "start-two", coverage: "interrupted" }] : [])], attributionGaps: partial ? [{ id: "two", reason: "interrupted" }] : [], evidence: { merged: evidence("merged-ref"), closed: evidence("closed-ref") } });
async function temporary(t) { const path = await mkdtemp(join(tmpdir(), "pi-closeout-summary-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test("complete and partial finalized receipts produce sanitized deterministic descriptors and Markdown", () => {
  const complete = parseFinalizedReceipt(receipt()); const partial = parseFinalizedReceipt(receipt({ partial: true }));
  assert.deepEqual(complete, { version: 1, ticket: "AIDEV-76", pickedUpAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-01-01T00:01:00.000Z", durationMs: 60000, coverage: "complete", completedSegments: 1, totalSegments: 1, totals: { total: 3, parentDelta: 1, subagentTotal: 2, subagentRuns: 1 }, gaps: [], mergedEvidenceCount: 1, closedEvidenceCount: 1 });
  assert.equal(partial.coverage, "partial"); assert.equal(partial.completedSegments, 1); assert.deepEqual(partial.gaps, ["interrupted"]);
  const markdown = renderCloseoutMarkdown(partial); assert.equal(markdown, renderCloseoutMarkdown(partial)); assert.match(markdown, /known lower-bound/i); assert.doesNotMatch(markdown, /merged-ref|closed-ref|a{64}/);
  assert.doesNotMatch(JSON.stringify(partial), /merged-ref|closed-ref|a{64}/);
});

test("parser fails closed on malformed, widened, partial invariant, and non-comparable receipt data", () => {
  for (const invalid of [{ ...receipt(), extra: true }, { ...receipt(), version: 2 }, { ...receipt(), total: 4 }, { ...receipt({ partial: true }), coverage: "complete" }, { ...receipt({ partial: true }), attributionGaps: [] }, { ...receipt(), evidence: { merged: evidence("merge"), closed: [] } }, { ...receipt(), segments: [{ ...completed("one"), session: "raw session value!" }] }]) assert.throws(() => parseFinalizedReceipt(invalid), TicketCloseoutSummaryError);
});

test("lifecycle-compatible decimal costs parse and render", () => {
  const decimalReceipt = { ...receipt(), total: 1.25, parentDelta: 0.5, subagentTotal: 0.75, segments: [completed("one", 1.25, 0.5, 0.75)] };
  const summary = parseFinalizedReceipt(decimalReceipt);
  assert.deepEqual(summary.totals, { total: 1.25, parentDelta: 0.5, subagentTotal: 0.75, subagentRuns: 1 });
  assert.match(renderCloseoutMarkdown(summary), /Aggregate total: 1.25 \(parent 0.5; subagent 0.75; 1 subagent runs\)/);
});

test("sanitized summary descriptors require internally consistent coverage", async (t) => {
  const directory = await temporary(t); const descriptor = { version: 1, ticket: "AIDEV-76", pickedUpAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-01-01T00:01:00.000Z", durationMs: 60000, coverage: "partial", completedSegments: 1, totalSegments: 2, totals: { total: 1.25, parentDelta: 0.5, subagentTotal: 0.75, subagentRuns: 1 }, gaps: ["interrupted"], mergedEvidenceCount: 1, closedEvidenceCount: 1 };
  assert.deepEqual(parseCloseoutSummary(descriptor), descriptor);
  const path = join(directory, "descriptor.json"); await writeFile(path, JSON.stringify(descriptor)); assert.deepEqual(await readCloseoutSummary(path), descriptor);
  for (const invalid of [{ ...descriptor, completedSegments: 0 }, { ...descriptor, coverage: "complete" }, { ...descriptor, coverage: "partial", completedSegments: 2, totalSegments: 2, gaps: [] }, { ...descriptor, gaps: ["unknown"] }]) assert.throws(() => parseCloseoutSummary(invalid), TicketCloseoutSummaryError);
});

test("reader rejects relative, symlink, nonregular, malformed inputs and CLI accepts only its documented arguments", async (t) => {
  const directory = await temporary(t); const path = join(directory, "receipt.json"); await writeFile(path, JSON.stringify(receipt()));
  assert.equal((await readCloseoutSummary(path)).ticket, "AIDEV-76"); await assert.rejects(readCloseoutSummary("receipt.json"), /unsafe_receipt_path/);
  const linked = join(directory, "linked.json"); await symlink(path, linked, "file"); await assert.rejects(readCloseoutSummary(linked), /unsafe_receipt_path/);
  const bad = join(directory, "bad.json"); await writeFile(bad, "{"); await assert.rejects(readCloseoutSummary(bad), /invalid_receipt/);
  const cli = fileURLToPath(new URL("../extensions/ticket-closeout-summary/bin/pi-ticket-closeout-summary.mjs", import.meta.url)); const result = await execFileAsync(process.execPath, [cli, "--receipt", path, "--format", "markdown"]); assert.match(result.stdout, /Ticket closeout: AIDEV-76/); assert.doesNotMatch(result.stdout, /merged-ref|a{64}/);
  await assert.rejects(execFileAsync(process.execPath, [cli, "--format", "json", "--receipt", path, "--format", "markdown"]), /Usage:/);
});
