import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildHindsightDocument, buildSynthesisPrompt } from "../extensions/conversation-catalog/src/synthesis.mjs";
import {
  HindsightOutcomeError,
  appendHindsightOutcomeUpdate,
  createHindsightOutcomeOrigin,
  emptyHindsightOutcomeHistory,
  hindsightOutcomeOriginKey,
  hindsightReportPathForDispositionPath,
  outcomeHistoryPathForDispositionPath,
  outcomeHistoryReportPathForDispositionPath,
  parseHindsightOutcomeHistory,
  readHindsightOutcomeHistory,
  recordHindsightOutcomeUpdate,
  refreshHindsightReportOutcomeHistory,
  renderHindsightOutcomeHistoryDocumentHtml,
  renderHindsightOutcomeHistoryHtml,
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
const acceptedTwo = {
  ...accepted,
  recommendationNumber: 2,
  recommendation: "Record retry observations",
  expectedImpact: "Retain independent outcome histories",
  evidenceReferences: ["session-ab12:event-0002"],
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

function historyFor(store, origin) {
  return store.histories[hindsightOutcomeOriginKey(origin)];
}

function generatedReportStub() {
  return "<!doctype html><main><!-- pi-hindsight-outcomes:start -->empty<!-- pi-hindsight-outcomes:end --></main>";
}

function runWriter(args) {
  const fixture = fileURLToPath(new URL("./fixtures/hindsight-outcome-process-writer.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, ...args], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`worker ${code}: ${stderr}`)));
  });
}

test("one report outcome store retains append-only histories for every accepted recommendation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-outcomes-"));
  const path = join(directory, "report.outcomes.json");
  const firstOrigin = createHindsightOutcomeOrigin("hindsight-1234abcd", accepted);
  const secondOrigin = createHindsightOutcomeOrigin("hindsight-1234abcd", acceptedTwo);
  try {
    const first = await appendHindsightOutcomeUpdate(path, firstOrigin, update({ workLink: link }));
    const second = await appendHindsightOutcomeUpdate(path, secondOrigin, update({ status: "in-progress", followUpDecision: "continue", provenance: { source: "user-observed", confirmation: "user-confirmed", confirmedAt: "2026-08-13T12:00:00.000Z" } }));
    const third = await appendHindsightOutcomeUpdate(path, firstOrigin, update({ status: "paused", followUpDecision: "adjust", provenance: { source: "user-observed", confirmation: "user-confirmed", confirmedAt: "2026-08-14T12:00:00.000Z" } }));
    assert.equal(first.schemaVersion, 2);
    assert.equal(Object.keys(second.histories).length, 2);
    assert.equal(historyFor(third, firstOrigin).updates.length, 2);
    assert.equal(historyFor(third, secondOrigin).updates.length, 1);
    assert.deepEqual(historyFor(third, firstOrigin).updates[0].workLink, link);
    assert.deepEqual(await readHindsightOutcomeHistory(path), third);
    assert.match(await readFile(path, "utf8"), /"schemaVersion": 2/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema rejects inference, bad indexes, raw citations, AWS credentials, UUID sessions, and unexpected fields", () => {
  const firstOrigin = createHindsightOutcomeOrigin("hindsight-1234abcd", accepted);
  const secondOrigin = createHindsightOutcomeOrigin("hindsight-1234abcd", acceptedTwo);
  const record = {
    ...emptyHindsightOutcomeHistory(firstOrigin),
    histories: {
      [hindsightOutcomeOriginKey(firstOrigin)]: { origin: firstOrigin, updates: [{ updateNumber: 1, ...update({ workLink: link }) }] },
      [hindsightOutcomeOriginKey(secondOrigin)]: { origin: secondOrigin, updates: [] },
    },
  };
  assert.deepEqual(parseHindsightOutcomeHistory(record), record);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, schemaVersion: 1 }), /malformed_outcome/);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, histories: { wrong: record.histories[hindsightOutcomeOriginKey(firstOrigin)] } }), /malformed_outcome/);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, histories: { ...record.histories, duplicate: { origin: { ...secondOrigin, modelSuggestionDigest: "b".repeat(64) }, updates: [] } } }), /malformed_outcome/);
  assert.throws(() => parseHindsightOutcomeHistory({ ...record, histories: { [hindsightOutcomeOriginKey(firstOrigin)]: { origin: { ...firstOrigin, evidenceReferences: ["RAW-SESSION-ID"] }, updates: [] } } }), /malformed_outcome/);
  const unsafe = (field, text) => assert.throws(() => parseHindsightOutcomeHistory({ ...emptyHindsightOutcomeHistory(firstOrigin), histories: { [hindsightOutcomeOriginKey(firstOrigin)]: { origin: firstOrigin, updates: [{ updateNumber: 1, ...update({ [field]: text }) }] } } }), /unsafe_outcome_text/);
  unsafe("observedResult", "raw session id: secret");
  unsafe("measurementEvidence", "Bearer credential-not-for-output");
  unsafe("observedResult", "AWS key AKIAIOSFODNN7EXAMPLE was observed");
  unsafe("measurementEvidence", "aws_secret_access_key=very-secret-value");
  unsafe("unexpectedEffects", "raw session 019fedfb-fe61-7431-b0b6-07033b14d64c was copied");
  const invalidWorkLink = { ...emptyHindsightOutcomeHistory(firstOrigin), histories: {
    [hindsightOutcomeOriginKey(firstOrigin)]: { origin: firstOrigin, updates: [{ updateNumber: 1, ...update({ workLink: { ...link, issueUrl: "http://linear.app/private" } }) }] },
  } };
  assert.throws(() => parseHindsightOutcomeHistory(invalidWorkLink), /malformed_outcome/);
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

test("cross-process record transactions retain every update and refresh the latest histories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-outcome-process-"));
  const outcomesPath = join(directory, "report.outcomes.json");
  const reportPath = join(directory, "report.html");
  const outcomeReportPath = join(directory, "report.outcomes.html");
  try {
    await writeFile(reportPath, generatedReportStub(), "utf8");
    await Promise.all(Array.from({ length: 8 }, (_unused, index) => runWriter([outcomesPath, reportPath, outcomeReportPath, String(index + 1)])));
    const store = await readHindsightOutcomeHistory(outcomesPath);
    const origin = createHindsightOutcomeOrigin("hindsight-1234abcd", {
      recommendationNumber: 1, recommendation: "Process-safe retry policy", priority: "high", expectedImpact: "Avoid lost updates", suggestedOwner: "Platform", dependencies: [], acceptanceCriteria: ["Every concurrent update is retained"], evidenceReferences: ["session-proc:event-0001"], userDisposition: { status: "accepted", source: "user-confirmed" },
    });
    assert.equal(historyFor(store, origin).updates.length, 8);
    assert.deepEqual(historyFor(store, origin).updates.map((item) => item.updateNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.match(await readFile(reportPath, "utf8"), /Process [1-8] observed the local update/);
    assert.match(await readFile(outcomeReportPath, "utf8"), /Process [1-8] observed the local update/);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".lock")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prior outcomes render only after explicit supply and are absent from all model prompts and citations", () => {
  const origin = createHindsightOutcomeOrigin("hindsight-1234abcd", accepted);
  const history = { ...emptyHindsightOutcomeHistory(origin), histories: { [hindsightOutcomeOriginKey(origin)]: { origin, updates: [{ updateNumber: 1, ...update({ observedResult: "PRIOR-OUTCOME-SECRET-TEXT" }) }] } } };
  const sources = [{ events: [{ id: "event-1", summary: "New redacted source", evidence: { reference: "session-next:event-0001" } }] }];
  const model = { claims: [{ statement: "New source only", classification: "direct evidence", evidenceReferences: ["session-next:event-0001"] }], recommendations: [] };
  const without = buildHindsightDocument(sources, model);
  const withPrior = buildHindsightDocument(sources, model, undefined, history);
  const prompt = buildSynthesisPrompt(sources, { priorOutcomes: history });
  assert.doesNotMatch(without, /PRIOR-OUTCOME-SECRET-TEXT|Prior user-observed outcome context/);
  assert.match(withPrior, /Prior user-observed outcome context/);
  assert.match(withPrior, /PRIOR-OUTCOME-SECRET-TEXT/);
  assert.match(withPrior, /not source evidence/);
  assert.doesNotMatch(withPrior, /href="#citation-[^"]+">session-ab12:event-0001/);
  assert.doesNotMatch(prompt, /PRIOR-OUTCOME-SECRET-TEXT|prior-outcome|session-ab12:event-0001/i);
  assert.match(prompt, /session-next:event-0001/);
});

test("only the generated report outcome placeholder is atomically refreshed for the indexed store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-outcome-report-"));
  const path = join(directory, "report.html");
  const origin = createHindsightOutcomeOrigin("hindsight-1234abcd", accepted);
  const history = { ...emptyHindsightOutcomeHistory(origin), histories: { [hindsightOutcomeOriginKey(origin)]: { origin, updates: [{ updateNumber: 1, ...update({ observedResult: "<img src=x>" }) }] } } };
  try {
    await writeFile(path, generatedReportStub(), "utf8");
    await refreshHindsightReportOutcomeHistory(path, history);
    const refreshed = await readFile(path, "utf8");
    assert.match(refreshed, /&lt;img src=x&gt;/);
    assert.doesNotMatch(refreshed, /<!-- pi-hindsight-outcomes:start -->empty/);
    await writeFile(path, "no marker", "utf8");
    await assert.rejects(() => refreshHindsightReportOutcomeHistory(path, history), (error) => error instanceof HindsightOutcomeError && error.code === "outcome_report_marker_missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe history renderer escapes user text and preserves user-observed provenance", () => {
  const origin = createHindsightOutcomeOrigin("hindsight-1234abcd", accepted);
  const history = { ...emptyHindsightOutcomeHistory(origin), histories: { [hindsightOutcomeOriginKey(origin)]: { origin, updates: [{ updateNumber: 1, ...update({ observedResult: "<script>session-log-secret</script>", workLink: link }) }] } } };
  const context = renderHindsightOutcomeHistoryHtml(history, { heading: "Prior user-observed outcome context", priorContext: true });
  const document = renderHindsightOutcomeHistoryDocumentHtml(history);
  assert.match(context, /Deliberately supplied prior-outcome context/);
  assert.match(context, /&lt;script&gt;session-log-secret&lt;\/script&gt;/);
  assert.doesNotMatch(context, /<script>session-log-secret<\/script>/);
  assert.match(document, /default-src 'none'/);
  assert.match(document, /user-observed.*user-confirmed/);
  assert.match(document, /session-ab12:event-0001/);
});

test("record transaction associates output histories without weakening local-only validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-outcome-record-"));
  const outcomesPath = join(directory, "report.outcomes.json");
  const reportPath = join(directory, "report.html");
  const outcomeReportPath = join(directory, "report.outcomes.html");
  const origin = createHindsightOutcomeOrigin("hindsight-1234abcd", accepted);
  try {
    await writeFile(reportPath, generatedReportStub(), "utf8");
    const store = await recordHindsightOutcomeUpdate(outcomesPath, origin, update({ workLink: link }), { reportPath, outcomeReportPath });
    assert.equal(historyFor(store, origin).updates.length, 1);
    assert.match(await readFile(outcomeReportPath, "utf8"), /issue_1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
