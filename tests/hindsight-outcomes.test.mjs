import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHindsightDocument, buildSynthesisPrompt } from "../extensions/conversation-catalog/src/synthesis.mjs";
import {
  HindsightOutcomeError,
  appendHindsightOutcomeUpdate,
  createHindsightOutcomeOrigin,
  emptyHindsightOutcomeHistory,
  hindsightReportPathForDispositionPath,
  outcomeHistoryPathForDispositionPath,
  outcomeHistoryReportPathForDispositionPath,
  parseHindsightOutcomeHistory,
  readHindsightOutcomeHistory,
  refreshHindsightReportOutcomeHistory,
  renderHindsightOutcomeHistoryDocumentHtml,
  renderHindsightOutcomeHistoryHtml,
  withHindsightOutcomeLock,
} from "../extensions/conversation-catalog/src/hindsight-outcomes.mjs";

const accepted = {
  recommendationNumber: 1,
  recommendation: "Add a bounded retry policy",
  priority: "high",
  expectedImpact: "Reduce transient failures",
  suggestedOwner: "Platform team",
  dependencies: ["Error budget agreed"],
  acceptanceCriteria: ["Retries are capped at three attempts"],
  evidenceReferences: ["session-ab12:event-0001"],
  userDisposition: { status: "accepted", source: "user-confirmed" },
};

const link = {
  issueId: "issue_1", issueUrl: "https://linear.app/acme/issue/ABC-1", status: "Todo",
  timestamp: "2026-08-11T12:03:00.000Z", payloadDigest: "a".repeat(64), action: "linked",
};

function update(overrides = {}) {
  return {
    status: "completed",
    observedResult: "The user observed fewer transient failures.",
    measurementEvidence: "The user compared the weekly failure count before and after the change.",
    unexpectedEffects: "None observed.",
    followUpDecision: "monitor",
    provenance: { source: "user-observed", confirmation: "user-confirmed", confirmedAt: "2026-08-12T12:00:00.000Z" },
    ...overrides,
  };
}

test("outcomes append atomically with immutable accepted origin and an existing work association", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-outcomes-"));
  const path = join(directory, "report.outcomes.json");
  const origin = createHindsightOutcomeOrigin("hindsight-1234abcd", accepted);
  try {
    const first = await appendHindsightOutcomeUpdate(path, origin, update({ workLink: link }));
    const second = await appendHindsightOutcomeUpdate(path, origin, update({ status: "in-progress", followUpDecision: "continue", provenance: { source: "user-observed", confirmation: "user-confirmed", confirmedAt: "2026-08-13T12:00:00.000Z" } }));
    assert.equal(first.updates[0].updateNumber, 1);
    assert.equal(second.updates.length, 2);
    assert.deepEqual(second.updates[0].workLink, link);
    assert.equal(second.updates[1].workLink, undefined);
    assert.deepEqual(await readHindsightOutcomeHistory(path), second);
    assert.match(await readFile(path, "utf8"), /"pi-hindsight-recommendation-outcomes"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema rejects inference, tampered origin, raw citation, untrusted link fields, and unexpected fields", () => {
  const origin = createHindsightOutcomeOrigin("hindsight-1234abcd", accepted);
  const record = { ...emptyHindsightOutcomeHistory(origin), updates: [{ updateNumber: 1, ...update({ workLink: link }) }] };
  assert.deepEqual(parseHindsightOutcomeHistory(record), record);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, schemaVersion: 2 }), /malformed_outcome/);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, origin: { ...origin, evidenceReferences: ["RAW-SESSION-ID"] } }), /malformed_outcome/);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, updates: [{ ...record.updates[0], provenance: { ...record.updates[0].provenance, source: "model-inference" } }] }), /malformed_outcome/);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, updates: [{ ...record.updates[0], observedResult: "raw session id: secret" }] }), /unsafe_outcome_text/);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, updates: [{ ...record.updates[0], measurementEvidence: "Bearer credential-not-for-output" }] }), /unsafe_outcome_text/);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, updates: [{ ...record.updates[0], workLink: { ...link, issueUrl: "http://linear.app/private" } }] }), /malformed_outcome/);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, unexpected: true }), /malformed_outcome/);
  assert.throws(() => createHindsightOutcomeOrigin("hindsight-1234abcd", { ...accepted, userDisposition: { status: "deferred", source: "user-confirmed" } }), /accepted_recommendation_required/);
});

test("paths are bounded to disposition companions and atomic failure leaves no temporary outcome record", async () => {
  assert.equal(outcomeHistoryPathForDispositionPath("nested/report.dispositions.json"), "nested/report.outcomes.json");
  assert.equal(outcomeHistoryReportPathForDispositionPath("nested/report.dispositions.json"), "nested/report.outcomes.html");
  assert.equal(hindsightReportPathForDispositionPath("nested/report.dispositions.json"), "nested/report.html");
  for (const path of ["report.json", "report.dispositions.json.bak", "\0.dispositions.json"]) {
    assert.throws(() => outcomeHistoryPathForDispositionPath(path), /invalid_disposition_path/);
  }
  const directory = await mkdtemp(join(tmpdir(), "hindsight-outcome-failure-"));
  const blockedPath = join(directory, "blocked.outcomes.json");
  const origin = createHindsightOutcomeOrigin("hindsight-1234abcd", accepted);
  try {
    await mkdir(blockedPath);
    await assert.rejects(() => appendHindsightOutcomeUpdate(blockedPath, origin, update()), /malformed_outcome/);
    assert.deepEqual((await readdir(directory)).sort(), ["blocked.outcomes.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("origin changes cannot append to another immutable recommendation history and locks retain concurrent updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-outcome-origin-"));
  const path = join(directory, "report.outcomes.json");
  const origin = createHindsightOutcomeOrigin("hindsight-1234abcd", accepted);
  const changedOrigin = createHindsightOutcomeOrigin("hindsight-1234abcd", { ...accepted, expectedImpact: "Eliminate transient failures" });
  try {
    await appendHindsightOutcomeUpdate(path, origin, update());
    await assert.rejects(() => appendHindsightOutcomeUpdate(path, changedOrigin, update()), (error) => error instanceof HindsightOutcomeError && error.code === "outcome_origin_mismatch");
    await Promise.all([
      withHindsightOutcomeLock(path, () => appendHindsightOutcomeUpdate(path, origin, update({ status: "in-progress", followUpDecision: "continue", provenance: { source: "user-observed", confirmation: "user-confirmed", confirmedAt: "2026-08-13T12:00:00.000Z" } }))),
      withHindsightOutcomeLock(path, () => appendHindsightOutcomeUpdate(path, origin, update({ status: "paused", followUpDecision: "adjust", provenance: { source: "user-observed", confirmation: "user-confirmed", confirmedAt: "2026-08-14T12:00:00.000Z" } }))),
    ]);
    assert.equal((await readHindsightOutcomeHistory(path)).updates.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prior outcomes reach a later report only when deliberately supplied and remain outside its evidence index", () => {
  const history = {
    ...emptyHindsightOutcomeHistory(createHindsightOutcomeOrigin("hindsight-1234abcd", accepted)),
    updates: [{ updateNumber: 1, ...update({ observedResult: "Prior user observation" }) }],
  };
  const sources = [{ events: [{ id: "event-1", summary: "New redacted source", evidence: { reference: "session-next:event-0001" } }] }];
  const model = {
    claims: [{ statement: "New source only", classification: "direct evidence", evidenceReferences: ["session-next:event-0001"] }],
    recommendations: [],
  };
  const without = buildHindsightDocument(sources, model);
  const withPrior = buildHindsightDocument(sources, model, undefined, history);
  assert.doesNotMatch(without, /Prior user observation|Prior user-observed outcome context/);
  assert.match(without, /pi-hindsight-outcomes:start/);
  assert.match(withPrior, /Prior user-observed outcome context/);
  assert.match(withPrior, /Prior user observation/);
  assert.match(withPrior, /not source evidence/);
  assert.match(buildSynthesisPrompt(sources), /No prior-outcome context was deliberately supplied/);
  const prompt = buildSynthesisPrompt(sources, { priorOutcomes: history });
  assert.match(prompt, /PRIOR-OUTCOME CONTEXT \(not evidence; do not cite\)/);
  assert.match(prompt, /Prior user observation/);
});

test("only the generated report outcome placeholder is atomically refreshed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-outcome-report-"));
  const path = join(directory, "report.html");
  const history = { ...emptyHindsightOutcomeHistory(createHindsightOutcomeOrigin("hindsight-1234abcd", accepted)), updates: [{ updateNumber: 1, ...update({ observedResult: "<img src=x>" }) }] };
  try {
    await writeFile(path, "before<!-- pi-hindsight-outcomes:start -->old<!-- pi-hindsight-outcomes:end -->after", "utf8");
    await refreshHindsightReportOutcomeHistory(path, history);
    const refreshed = await readFile(path, "utf8");
    assert.match(refreshed, /&lt;img src=x&gt;/);
    assert.doesNotMatch(refreshed, /<!-- pi-hindsight-outcomes:start -->old/);
    await writeFile(path, "no marker", "utf8");
    await assert.rejects(() => refreshHindsightReportOutcomeHistory(path, history), (error) => error instanceof HindsightOutcomeError && error.code === "outcome_report_marker_missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe history renderer escapes user text and labels deliberately supplied history as non-evidentiary context", () => {
  const history = {
    ...emptyHindsightOutcomeHistory(createHindsightOutcomeOrigin("hindsight-1234abcd", accepted)),
    updates: [{ updateNumber: 1, ...update({ observedResult: "<script>session-log-secret</script>", workLink: link }) }],
  };
  const context = renderHindsightOutcomeHistoryHtml(history, { heading: "Prior user-observed outcome context", priorContext: true });
  const document = renderHindsightOutcomeHistoryDocumentHtml(history);
  assert.match(context, /Deliberately supplied prior-outcome context/);
  assert.match(context, /not source evidence/);
  assert.match(context, /&lt;script&gt;session-log-secret&lt;\/script&gt;/);
  assert.doesNotMatch(context, /<script>session-log-secret<\/script>/);
  assert.match(document, /default-src 'none'/);
  assert.match(document, /user-observed.*user-confirmed/);
  assert.match(document, /session-ab12:event-0001/);
});
