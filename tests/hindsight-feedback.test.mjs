import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  HindsightFeedbackError,
  acquireCrossProcessFeedbackLock,
  aggregateHindsightFeedback,
  appendHindsightFeedback,
  createHindsightFeedbackMetadata,
  feedbackPathForDispositionPath,
  feedbackReportPathForDispositionPath,
  parseHindsightFeedback,
  readHindsightFeedback,
  recordHindsightFeedback,
  renderHindsightFeedbackDocumentHtml,
  writeHindsightFeedbackSeed,
} from "../extensions/conversation-catalog/src/hindsight-feedback.mjs";
import { appendHindsightOutcomeUpdate, createHindsightOutcomeOrigin } from "../extensions/conversation-catalog/src/hindsight-outcomes.mjs";
import { createHindsightRecommendationDispositionMetadata } from "../extensions/conversation-catalog/src/evidence.mjs";

const document = {
  reportId: "hindsight-1234abcd",
  claims: [{ statement: "Retries were discussed.", classification: "direct evidence", evidenceReferences: ["session-ab12:event-0001"] }],
  recommendations: [{ recommendation: "Add bounded retries.", evidenceReferences: ["session-ab12:event-0002"] }],
};
const feedback = (classification = "helpful", correctedFraming = "") => ({
  classification,
  correctedFraming,
  provenance: { source: "user-feedback", confirmation: "user-confirmed", recordedAt: "2026-08-15T12:00:00.000Z" },
});

function runFixture(name, args) {
  const fixture = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, ...args], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`writer ${code}: ${stderr}`)));
  });
}

function writer(path, targetId, index) {
  return runFixture("hindsight-feedback-process-writer.mjs", [path, targetId, String(index)]);
}

test("feedback targets are stable pseudonymous identities across unrelated report changes", () => {
  const initial = createHindsightFeedbackMetadata(document);
  const changed = createHindsightFeedbackMetadata({ ...document, claims: [
    { statement: "An unrelated claim changed.", classification: "inference", evidenceReferences: ["session-ab12:event-0003"] },
    document.claims[0],
  ] });
  assert.equal(initial.targets[0].targetId, changed.targets.find((target) => target.type === "claim" && target.evidenceReferences[0] === "session-ab12:event-0001").targetId);
  assert.match(initial.targets[0].targetId, /^claim-[a-f0-9]{16}$/);
  assert.equal(initial.targets[0].modelProvenance, "model-generated");
  assert.doesNotMatch(JSON.stringify(initial), /Retries were discussed|raw session/i);
});

test("report identities include claim scope, and regenerated seeds cannot retain stale targets", async () => {
  const report = (statement, recommendations = []) => ({
    claims: [{ statement, classification: "direct evidence", evidenceReferences: ["session-ab12:event-0001"] }],
    recommendations,
  });
  const first = createHindsightRecommendationDispositionMetadata(report("First claim"));
  const second = createHindsightRecommendationDispositionMetadata(report("Second claim"));
  assert.notEqual(first.reportId, second.reportId, "changed claims must change report identity even without recommendations");
  const withRecommendation = createHindsightRecommendationDispositionMetadata(report("First claim", [{ recommendation: "Add bounded retries.", priority: "high", expectedImpact: "Fewer failures", suggestedOwner: "Platform", dependencies: [], acceptanceCriteria: ["Retry count is capped"], status: "proposed", source: "model-suggestion", evidenceReferences: ["session-ab12:event-0001"] }]));
  assert.notEqual(first.reportId, withRecommendation.reportId);

  const directory = await mkdtemp(join(tmpdir(), "hindsight-feedback-regeneration-"));
  const path = join(directory, "report.feedback.json");
  const original = createHindsightFeedbackMetadata({ ...document, claims: [...document.claims, { statement: "Removed claim.", classification: "inference", evidenceReferences: ["session-ab12:event-0003"] }] });
  const current = createHindsightFeedbackMetadata(document);
  try {
    await writeHindsightFeedbackSeed(path, original);
    await appendHindsightFeedback(path, original.targets.find((target) => target.evidenceReferences[0] === "session-ab12:event-0003").targetId, feedback());
    await writeHindsightFeedbackSeed(path, current);
    const stored = await readHindsightFeedback(path);
    assert.deepEqual(stored.targets.map((target) => target.targetId), current.targets.map((target) => target.targetId));
    assert.equal(stored.feedback.length, 0, "removed target feedback must not remain selectable");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("strict feedback parsing rejects unsafe text, raw IDs, old schemas, and target substitution", () => {
  const seed = createHindsightFeedbackMetadata(document);
  const targetId = seed.targets[0].targetId;
  const record = { ...seed, feedback: [{ feedbackNumber: 1, targetId, ...feedback("incorrect", "Use a measured retry budget instead.") }] };
  assert.deepEqual(parseHindsightFeedback(record), record);
  for (const correctedFraming of ["raw session id: secret", "Authorization: Bearer no", "AKIAIOSFODNN7EXAMPLE", "session 019fedfb-fe61-7431-b0b6-07033b14d64c", "password = horse-battery", "secret: value", "token=abc", "credential : local-value"]) {
    assert.throws(() => parseHindsightFeedback({ ...record, feedback: [{ ...record.feedback[0], correctedFraming }] }), /unsafe_feedback_text/);
  }
  assert.throws(() => parseHindsightFeedback({ ...record, schemaVersion: 0 }), /malformed_feedback/);
  assert.throws(() => aggregateHindsightFeedback(record, { dispositions: { schemaVersion: 1 } }), /aggregate_metadata_malformed/);
  assert.throws(() => aggregateHindsightFeedback(record, { outcomes: { schemaVersion: 1 } }), /aggregate_metadata_malformed/);
  assert.throws(() => parseHindsightFeedback({ ...record, feedback: [{ ...record.feedback[0], targetId: "claim-0000000000000000" }] }), /malformed_feedback/);
  assert.throws(() => parseHindsightFeedback({ ...record, targets: [{ ...seed.targets[0], evidenceReferences: ["RAW-SESSION-ID"] }] }), /malformed_feedback/);
});

test("atomic feedback writes retain concurrent process entries and clean locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-feedback-process-"));
  const path = join(directory, "report.feedback.json");
  const seed = createHindsightFeedbackMetadata(document);
  try {
    await writeHindsightFeedbackSeed(path, seed);
    await Promise.all(Array.from({ length: 8 }, (_value, index) => writer(path, seed.targets[0].targetId, index + 1)));
    const stored = await readHindsightFeedback(path);
    assert.equal(stored.feedback.length, 8);
    assert.deepEqual(stored.feedback.map((entry) => entry.feedbackNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".lock")), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("feedback lock reclaims only abandoned stale directories and leaves active owners intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-feedback-stale-lock-"));
  const path = join(directory, "report.feedback.json");
  const lockPath = `${path}.lock`;
  const old = "2020-01-01T00:00:00.000Z";
  try {
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ schemaVersion: 1, token: "00000000-0000-4000-8000-000000000000", pid: 999999999, createdAt: old }), "utf8");
    const reclaimed = await acquireCrossProcessFeedbackLock(path, { staleMs: 1, timeoutMs: 100, processAlive: () => false });
    assert.equal(reclaimed.lockPath, lockPath);
    await rm(lockPath, { recursive: true, force: true });

    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ schemaVersion: 1, token: "00000000-0000-4000-8000-000000000000", pid: process.pid, createdAt: old }), "utf8");
    await assert.rejects(() => acquireCrossProcessFeedbackLock(path, { staleMs: 1, timeoutMs: 0, processAlive: () => true }), /feedback_lock_timeout/);
    assert.ok((await readdir(lockPath)).includes("owner.json"), "an active owner directory must remain untouched");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("feedback and outcome processes coordinate report refreshes without losing either panel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-report-refresh-process-"));
  const feedbackPath = join(directory, "report.feedback.json");
  const dispositionPath = join(directory, "report.dispositions.json");
  const outcomePath = join(directory, "report.outcomes.json");
  const reportPath = join(directory, "report.html");
  const feedbackReportPath = join(directory, "report.feedback.html");
  const outcomeReportPath = join(directory, "report.outcomes.html");
  const seed = createHindsightFeedbackMetadata(document);
  try {
    await writeHindsightFeedbackSeed(feedbackPath, seed);
    await writeFile(dispositionPath, JSON.stringify({ schemaVersion: 2, kind: "pi-hindsight-recommendation-dispositions", reportId: seed.reportId, provenance: {}, recommendations: [] }), "utf8");
    await writeFile(reportPath, "<!-- pi-hindsight-outcomes:start -->outcome-old<!-- pi-hindsight-outcomes:end --><!-- pi-hindsight-feedback:start -->feedback-old<!-- pi-hindsight-feedback:end -->", "utf8");
    await Promise.all([
      runFixture("hindsight-feedback-report-writer.mjs", [feedbackPath, seed.targets[0].targetId, dispositionPath, outcomePath, reportPath, feedbackReportPath]),
      runFixture("hindsight-outcome-report-writer.mjs", [outcomePath, reportPath, outcomeReportPath]),
    ]);
    const report = await readFile(reportPath, "utf8");
    assert.match(report, /Concurrent outcome process persisted this result/);
    assert.match(report, /Local feedback and calibration signals/);
    assert.doesNotMatch(report, /outcome-old|feedback-old/);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".lock")), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("feedback is durable before a safe-view refresh failure and its renderer escapes user input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-feedback-refresh-"));
  const feedbackPath = join(directory, "report.feedback.json");
  const dispositionPath = join(directory, "report.dispositions.json");
  const reportPath = join(directory, "report.html");
  const feedbackReportPath = join(directory, "report.feedback.html");
  const seed = createHindsightFeedbackMetadata(document);
  try {
    await writeHindsightFeedbackSeed(feedbackPath, seed);
    await writeFile(dispositionPath, JSON.stringify({ schemaVersion: 2, kind: "pi-hindsight-recommendation-dispositions", reportId: seed.reportId, provenance: {}, recommendations: [] }), "utf8");
    await writeFile(reportPath, "no marker", "utf8");
    await assert.rejects(() => recordHindsightFeedback(feedbackPath, seed.targets[0].targetId, feedback("incomplete", "<img src=x onerror=alert(1)>"), { reportPath, feedbackReportPath, dispositionPath, outcomePath: join(directory, "report.outcomes.json") }), (error) => error instanceof HindsightFeedbackError && error.code === "feedback_report_marker_missing");
    const stored = await readHindsightFeedback(feedbackPath);
    assert.equal(stored.feedback.length, 1);
    const html = renderHindsightFeedbackDocumentHtml(stored, { dispositions: JSON.parse(await readFile(dispositionPath, "utf8")) });
    assert.match(html, /default-src 'none'/);
    assert.match(html, /user-provided, local operational signals/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("feedback refreshes only the generated report calibration marker and an escaped companion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-feedback-report-"));
  const feedbackPath = join(directory, "report.feedback.json");
  const dispositionPath = join(directory, "report.dispositions.json");
  const reportPath = join(directory, "report.html");
  const feedbackReportPath = join(directory, "report.feedback.html");
  const seed = createHindsightFeedbackMetadata(document);
  try {
    await writeHindsightFeedbackSeed(feedbackPath, seed);
    await writeFile(dispositionPath, JSON.stringify({ schemaVersion: 2, kind: "pi-hindsight-recommendation-dispositions", reportId: seed.reportId, provenance: {}, recommendations: [] }), "utf8");
    await writeFile(reportPath, "before<!-- pi-hindsight-feedback:start -->old<!-- pi-hindsight-feedback:end -->after", "utf8");
    await recordHindsightFeedback(feedbackPath, seed.targets[0].targetId, feedback("overstated", "<b>Bound the claim</b>"), { reportPath, feedbackReportPath, dispositionPath, outcomePath: join(directory, "report.outcomes.json") });
    const report = await readFile(reportPath, "utf8");
    assert.match(report, /before.*Local feedback and calibration signals.*after/);
    assert.doesNotMatch(report, /old/);
    const companion = await readFile(feedbackReportPath, "utf8");
    assert.match(companion, /&lt;b&gt;Bound the claim&lt;\/b&gt;/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("local aggregate distinguishes feedback, user dispositions, and recorded outcome status rates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-feedback-aggregate-"));
  const path = join(directory, "report.outcomes.json");
  const seed = createHindsightFeedbackMetadata(document);
  const targetId = seed.targets[1].targetId;
  const record = { ...seed, feedback: [
    { feedbackNumber: 1, targetId, ...feedback("helpful") },
    { feedbackNumber: 2, targetId, ...feedback("incorrect", "Use the observed incident rate.") },
  ] };
  const recommendation = { recommendationNumber: 1, recommendation: "Add bounded retries.", priority: "high", expectedImpact: "Fewer failures", suggestedOwner: "Platform", dependencies: [], acceptanceCriteria: ["Retry count is capped"], evidenceReferences: ["session-ab12:event-0002"], userDisposition: { status: "accepted", source: "user-confirmed" } };
  try {
    const origin = createHindsightOutcomeOrigin(seed.reportId, recommendation);
    await appendHindsightOutcomeUpdate(path, origin, { status: "completed", observedResult: "Observed success", measurementEvidence: "Measured locally", unexpectedEffects: "None observed", followUpDecision: "monitor", provenance: { source: "user-observed", confirmation: "user-confirmed", confirmedAt: "2026-08-16T12:00:00.000Z" } });
    const aggregate = aggregateHindsightFeedback(record, {
      dispositions: { schemaVersion: 2, kind: "pi-hindsight-recommendation-dispositions", reportId: seed.reportId, provenance: {}, recommendations: [{ recommendationNumber: 1, userDisposition: { status: "accepted", source: "user-confirmed", rationale: "Approved", confirmedAt: "2026-08-16T11:00:00.000Z" } }] },
      outcomes: JSON.parse(await readFile(path, "utf8")),
    });
    assert.deepEqual(aggregate.classifications, { helpful: 1, incorrect: 1, overstated: 0, incomplete: 0, "not-actionable": 0 });
    assert.equal(aggregate.corrected, 1);
    assert.deepEqual(aggregate.classificationRates.helpful, { count: 1, denominator: 2, value: 0.5 });
    assert.deepEqual(aggregate.correctionRate, { count: 1, denominator: 2, value: 0.5 });
    assert.equal(aggregate.disposition.accepted, 1);
    assert.deepEqual(aggregate.disposition.acceptanceRate, { count: 1, denominator: 1, value: 1 });
    assert.equal(aggregate.outcome.statusCounts.completed, 1);
    assert.deepEqual(aggregate.outcome.statusRates.completed, { count: 1, denominator: 1, value: 1 });
    assert.deepEqual(aggregate.outcome.currentAcceptedOutcomeCoverage, { count: 1, denominator: 1, value: 1 });
    const ratesHtml = renderHindsightFeedbackDocumentHtml(record, { dispositions: { schemaVersion: 2, kind: "pi-hindsight-recommendation-dispositions", reportId: seed.reportId, provenance: {}, recommendations: [{ recommendationNumber: 1, userDisposition: { status: "accepted", source: "user-confirmed", rationale: "Approved", confirmedAt: "2026-08-16T11:00:00.000Z" } }] }, outcomes: JSON.parse(await readFile(path, "utf8")) });
    assert.match(ratesHtml, /helpful:<\/strong> 1\/2 \(50%\)/);
    assert.match(ratesHtml, /corrected framing rate:<\/strong> 1\/2 \(50%\)/);
    assert.match(ratesHtml, /acceptance rate:<\/strong> 1\/1 \(100%\)/);
    assert.match(ratesHtml, /completed 1\/1 \(100%\)/);
    assert.match(ratesHtml, /Current accepted recommendation origins with a recorded outcome:<\/strong> 1\/1 \(100%\)/);

    for (const status of ["deferred", "rejected"]) {
      const changedDisposition = { schemaVersion: 2, kind: "pi-hindsight-recommendation-dispositions", reportId: seed.reportId, provenance: {}, recommendations: [{ recommendationNumber: 1, userDisposition: { status, source: "user-confirmed", rationale: "Changed after the outcome was recorded", confirmedAt: "2026-08-17T11:00:00.000Z" } }] };
      const changed = aggregateHindsightFeedback(record, { dispositions: changedDisposition, outcomes: JSON.parse(await readFile(path, "utf8")) });
      assert.deepEqual(changed.outcome.currentAcceptedOutcomeCoverage, { count: 0, denominator: 0, value: 0 }, `accepted→${status} must exclude legacy outcome history`);
      assert.equal(changed.outcome.statusCounts.completed, 1, "status history remains an all-recorded-updates aggregate");
    }
    const noAcceptedLegacy = aggregateHindsightFeedback(record, { dispositions: { schemaVersion: 2, kind: "pi-hindsight-recommendation-dispositions", reportId: seed.reportId, provenance: {}, recommendations: [{ recommendationNumber: 1, userDisposition: { status: "not-recorded", source: "not-user-confirmed", rationale: "" } }] }, outcomes: JSON.parse(await readFile(path, "utf8")) });
    assert.deepEqual(noAcceptedLegacy.outcome.currentAcceptedOutcomeCoverage, { count: 0, denominator: 0, value: 0 });
    assert.match(renderHindsightFeedbackDocumentHtml(record, { dispositions: { schemaVersion: 2, kind: "pi-hindsight-recommendation-dispositions", reportId: seed.reportId, provenance: {}, recommendations: [{ recommendationNumber: 1, userDisposition: { status: "not-recorded", source: "not-user-confirmed", rationale: "" } }] }, outcomes: JSON.parse(await readFile(path, "utf8")) }), /Current accepted recommendation origins with a recorded outcome:<\/strong> 0\/0 \(0%\)/);

    const zero = aggregateHindsightFeedback({ ...seed, feedback: [] }, { dispositions: { schemaVersion: 2, kind: "pi-hindsight-recommendation-dispositions", reportId: seed.reportId, provenance: {}, recommendations: [] } });
    assert.deepEqual(zero.classificationRates.helpful, { count: 0, denominator: 0, value: 0 });
    assert.deepEqual(zero.correctionRate, { count: 0, denominator: 0, value: 0 });
    assert.deepEqual(zero.disposition.acceptanceRate, { count: 0, denominator: 0, value: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("feedback paths only accept report disposition companions", () => {
  assert.equal(feedbackPathForDispositionPath("nested/report.dispositions.json"), "nested/report.feedback.json");
  assert.equal(feedbackReportPathForDispositionPath("nested/report.dispositions.json"), "nested/report.feedback.html");
  assert.throws(() => feedbackPathForDispositionPath("report.json"), /invalid_feedback_path/);
});
