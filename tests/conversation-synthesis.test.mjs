import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildHindsightDocument, buildSynthesisPrompt, MAX_SYNTHESIS_PROMPT_BYTES, preflightSynthesisPrompt } from "../extensions/conversation-catalog/src/synthesis.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (summary = "First redacted event") => [{ reference: "session-one", events: [{ id: "event-one", category: "user", timestamp: "2025-01-01", summary, evidence: { reference: "session-one:event-0001" } }], edges: [] }];
const recommendation = { recommendation: "Improve the handoff", priority: "high", expectedImpact: "Reduce rework", suggestedOwner: "Delivery", dependencies: [], acceptanceCriteria: ["Handoff is reviewed"], status: "proposed", source: "model-suggestion", evidenceReferences: ["session-one:event-0001"] };

test("safe report is reader-first, cited, escaped, CSP-restricted, and has no lifecycle UI", () => {
  const html = buildHindsightDocument(source(), { title: "<unsafe>", claims: [{ statement: "<img src=x>", classification: "direct evidence", evidenceReferences: ["session-one:event-0001"] }], storySteps: [{ title: "Start", body: "The reviewed conversation began.", classification: "direct evidence", evidenceReferences: ["session-one:event-0001"] }], recommendations: [recommendation] });
  for (const heading of ["Summary", "Context", "Top three actions", "Timeline", "Strengths", "Lessons", "Evidence appendix"]) assert.match(html, new RegExp(heading));
  assert.match(html, /href="#citation-1"/); assert.match(html, /default-src 'none'/); assert.match(html, /&lt;unsafe&gt;|&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /Visualizations|narrative map|localStorage|disposition|feedback|outcome|linear|<script/i);
});

test("safe writer rejects old output fields and unsafe citations", () => {
  assert.throws(() => buildHindsightDocument(source(), { claims: [], recommendations: [], narrativeMap: {} }), /unsupported fields/);
  assert.throws(() => buildHindsightDocument(source(), { claims: [{ statement: "x", classification: "direct evidence", evidenceReferences: ["outside"] }], recommendations: [] }), /outside the selected/);
  assert.throws(() => buildHindsightDocument(source(), { claims: [], recommendations: [{ ...recommendation, status: "accepted" }] }), /status/);
});

test("excluded conversation renders only a cited redaction fallback", () => {
  const html = buildHindsightDocument([{ reference: "session-hidden", excluded: true }], { claims: [], recommendations: [] });
  assert.match(html, /session-hidden:excluded/); assert.match(html, /excluded during redaction review/); assert.doesNotMatch(html, /event-one/);
});

test("synthesis prompt is scoped to one redacted conversation and preflight retains safeguards", () => {
  const prompt = buildSynthesisPrompt(source()); assert.match(prompt, /hindsight_document_write/); assert.doesNotMatch(prompt, /narrativeMap|claim-support|prior outcomes|notes/i);
  assert.throws(() => buildHindsightDocument([]), /exactly one/); assert.throws(() => buildHindsightDocument([...source(), ...source()]), /exactly one/);
  assert.throws(() => preflightSynthesisPrompt(source("🧠".repeat(MAX_SYNTHESIS_PROMPT_BYTES)), {}, { tokens: 0, contextWindow: 1_000_000 }), /limited to/);
});

test("only approved commands and one hindsight tool remain public", () => {
  const index = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8");
  for (const command of ["conversation-catalog", "conversation-flow", "conversation-map", "hindsight-document"]) assert.ok(index.includes(`registerCommand("${command}"`));
  assert.equal((index.match(/registerCommand\(/g) || []).length, 4); assert.equal((index.match(/registerTool\(/g) || []).length, 1);
  for (const removed of ["hindsight-notes", "hindsight-feedback", "hindsight-outcome", "hindsight-work", "Linear"]) assert.doesNotMatch(index, new RegExp(removed, "i"));
  assert.match(index, /Unsupported hindsight option/);
});

test("unsupported hindsight flags are rejected before a session is selected", async () => {
  let extension = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8").replace(/^import[^\n]+;\r?\n/gm, "");
  extension += "\nexport { hindsightArguments };";
  const compiled = ts.transpileModule(extension, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { hindsightArguments } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  for (const flag of ["--narrative-map", "--validate-claim-support", "--prior-outcomes old.outcomes.json"]) assert.throws(() => hindsightArguments(flag), /Unsupported hindsight option/);
  assert.deepEqual(hindsightArguments("reports/one.html"), { outputPath: "reports/one.html" });
});
