import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const TICKET_CLOSEOUT_SUMMARY_VERSION = 1;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const TICKET = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const COVERAGE = new Set(["pending", "complete", "interrupted", "missing-receiver", "settle-failed", "abandoned"]);
const GAP_COVERAGE = new Set(["interrupted", "missing-receiver", "settle-failed", "abandoned"]);

export class TicketCloseoutSummaryError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new TicketCloseoutSummaryError(code); };
const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SAFE;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const add = (left, right) => { if (!number(left) || !number(right) || left + right > MAX_SAFE) fail("unsafe_number"); return left + right; };
const addInteger = (left, right) => { if (!integer(left) || !integer(right) || left + right > MAX_SAFE) fail("unsafe_number"); return left + right; };
const keys = (value, allowed, code) => { if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(code); };
const id = (value, code) => { if (typeof value !== "string" || !ID.test(value)) fail(code); return value; };
const timestamp = (value, code) => { if (typeof value !== "string" || !ISO.test(value) || Number.isNaN(Date.parse(value))) fail(code); return value; };
const receipt = (value, code = "invalid_receipt") => {
  keys(value, ["total", "parentDelta", "subagentTotal", "subagentRuns"], code);
  if (!number(value.total) || !number(value.parentDelta) || !number(value.subagentTotal) || !integer(value.subagentRuns) || value.total !== add(value.parentDelta, value.subagentTotal)) fail(code);
  return { total: value.total, parentDelta: value.parentDelta, subagentTotal: value.subagentTotal, subagentRuns: value.subagentRuns };
};
function evidence(value, code) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail(code);
  for (const entry of value) { keys(entry, ["ref", "sha256"], code); id(entry.ref, code); if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) fail(code); }
  return value.length;
}
function normalizedSegment(value) {
  keys(value, ["id", "session", "startRequestId", "settleRequestId", "coverage", "receipt"], "invalid_segment");
  const segmentId = id(value.id, "invalid_segment"); id(value.session, "invalid_segment"); id(value.startRequestId, "invalid_segment");
  if (typeof value.coverage !== "string" || !COVERAGE.has(value.coverage) || value.coverage === "pending") fail("invalid_segment");
  if (value.coverage === "complete") {
    id(value.settleRequestId, "invalid_segment");
    return { id: segmentId, coverage: "complete", receipt: receipt(value.receipt, "invalid_segment") };
  }
  if (!GAP_COVERAGE.has(value.coverage) || value.settleRequestId !== undefined || value.receipt !== undefined) fail("invalid_segment");
  return { id: segmentId, coverage: value.coverage };
}
/** Strictly validates a finalized pi-ticket-lifecycle v1 receipt and returns no evidence values. */
export function parseFinalizedReceipt(value) {
  keys(value, ["version", "ticket", "pickedUpAt", "closedAt", "coverage", "total", "parentDelta", "subagentTotal", "subagentRuns", "segments", "attributionGaps", "evidence"], "invalid_receipt");
  if (value.version !== 1 || typeof value.ticket !== "string" || !TICKET.test(value.ticket)) fail("invalid_receipt");
  const pickedUpAt = timestamp(value.pickedUpAt, "invalid_receipt"); const closedAt = timestamp(value.closedAt, "invalid_receipt");
  if (Date.parse(closedAt) < Date.parse(pickedUpAt) || !["complete", "partial"].includes(value.coverage) || !Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 1000 || !Array.isArray(value.attributionGaps)) fail("invalid_receipt");
  const segments = value.segments.map(normalizedSegment); const segmentIds = new Set(segments.map((segment) => segment.id));
  if (segmentIds.size !== segments.length) fail("invalid_receipt");
  let total = 0; let parentDelta = 0; let subagentTotal = 0; let subagentRuns = 0;
  for (const segment of segments) if (segment.coverage === "complete") { total = add(total, segment.receipt.total); parentDelta = add(parentDelta, segment.receipt.parentDelta); subagentTotal = add(subagentTotal, segment.receipt.subagentTotal); subagentRuns = addInteger(subagentRuns, segment.receipt.subagentRuns); }
  if (![value.total, value.parentDelta, value.subagentTotal].every(number) || !integer(value.subagentRuns) || value.total !== add(value.parentDelta, value.subagentTotal) || value.total !== total || value.parentDelta !== parentDelta || value.subagentTotal !== subagentTotal || value.subagentRuns !== subagentRuns) fail("invalid_receipt");
  const gaps = value.attributionGaps.map((gap) => { keys(gap, ["id", "reason"], "invalid_receipt"); if (typeof gap.id !== "string" || !segmentIds.has(gap.id) || typeof gap.reason !== "string" || !GAP_COVERAGE.has(gap.reason)) fail("invalid_receipt"); return { id: gap.id, reason: gap.reason }; });
  const expectedGaps = segments.filter((segment) => segment.coverage !== "complete").map((segment) => ({ id: segment.id, reason: segment.coverage }));
  if (gaps.length !== expectedGaps.length || gaps.some((gap, index) => gap.id !== expectedGaps[index].id || gap.reason !== expectedGaps[index].reason) || (value.coverage === "complete") !== (gaps.length === 0)) fail("invalid_receipt");
  keys(value.evidence, ["merged", "closed"], "invalid_receipt"); const mergedEvidenceCount = evidence(value.evidence.merged, "invalid_receipt"); const closedEvidenceCount = evidence(value.evidence.closed, "invalid_receipt");
  return { version: 1, ticket: value.ticket, pickedUpAt, closedAt, durationMs: Date.parse(closedAt) - Date.parse(pickedUpAt), coverage: value.coverage, completedSegments: segments.length - gaps.length, totalSegments: segments.length, totals: { total, parentDelta, subagentTotal, subagentRuns }, gaps: gaps.map((gap) => gap.reason), mergedEvidenceCount, closedEvidenceCount };
}
/** A stable, safe descriptor intended for static presentation only. */
export function summarizeFinalizedReceipt(value) { return parseFinalizedReceipt(value); }
function checkedSummary(value) {
  if (!object(value) || Object.keys(value).some((key) => !["version", "ticket", "pickedUpAt", "closedAt", "durationMs", "coverage", "completedSegments", "totalSegments", "totals", "gaps", "mergedEvidenceCount", "closedEvidenceCount"].includes(key)) || value.version !== 1 || typeof value.ticket !== "string" || !TICKET.test(value.ticket) || !integer(value.durationMs) || !["complete", "partial"].includes(value.coverage) || !integer(value.completedSegments) || !integer(value.totalSegments) || value.totalSegments < 1 || !Array.isArray(value.gaps) || !integer(value.mergedEvidenceCount) || !integer(value.closedEvidenceCount)) fail("invalid_summary");
  timestamp(value.pickedUpAt, "invalid_summary"); timestamp(value.closedAt, "invalid_summary"); const totals = receipt(value.totals, "invalid_summary");
  if (value.durationMs !== Date.parse(value.closedAt) - Date.parse(value.pickedUpAt) || value.completedSegments + value.gaps.length !== value.totalSegments || (value.coverage === "complete" ? (value.gaps.length !== 0 || value.completedSegments !== value.totalSegments) : (value.gaps.length === 0 || value.completedSegments >= value.totalSegments)) || value.gaps.some((gap) => typeof gap !== "string" || !GAP_COVERAGE.has(gap))) fail("invalid_summary");
  return { ...value, totals };
}
export function renderCloseoutMarkdown(value) {
  const summary = value?.totals ? checkedSummary(value) : parseFinalizedReceipt(value); const duration = summary.durationMs === 0 ? "0 seconds" : `${summary.durationMs / 1000} seconds`;
  return [`# Ticket closeout: ${summary.ticket}`, "", `- Lifecycle window: ${summary.pickedUpAt} to ${summary.closedAt} (${duration})`, `- Segments: ${summary.completedSegments}/${summary.totalSegments} completed`, `- Aggregate total: ${summary.totals.total} (parent ${summary.totals.parentDelta}; subagent ${summary.totals.subagentTotal}; ${summary.totals.subagentRuns} subagent runs)`, `- Attribution coverage: ${summary.coverage}`, ...(summary.coverage === "partial" ? ["- Partial attribution is a known lower-bound total; incomplete segments are excluded and it must not support comparable cohort claims.", `- Attribution gaps: ${summary.gaps.join(", ")}`] : []), `- Local operator-attestation evidence records: ${summary.mergedEvidenceCount} merged; ${summary.closedEvidenceCount} closed. These are not independently remote-verified proof.`, ""].join("\n");
}
/** Reads one explicitly supplied absolute, non-symlink regular receipt file; no receipt discovery occurs. */
export function parseCloseoutSummary(value) { return checkedSummary(value); }
export function parseCloseoutDescriptor(value) {
  try { return parseFinalizedReceipt(value); } catch (error) { if (!(error instanceof TicketCloseoutSummaryError)) throw error; return checkedSummary(value); }
}
export async function readFinalizedReceipt(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path) || /[\0\r\n]/.test(path)) fail("unsafe_receipt_path");
  let entry; try { entry = await lstat(path); } catch (error) { fail(error?.code === "ENOENT" ? "receipt_missing" : "unsafe_receipt_path"); }
  if (!entry.isFile() || entry.isSymbolicLink()) fail("unsafe_receipt_path");
  let value; try { value = JSON.parse(await readFile(path, "utf8")); } catch { fail("invalid_receipt"); }
  return parseCloseoutDescriptor(value);
}
export async function readCloseoutSummary(path) { return readFinalizedReceipt(path); }
