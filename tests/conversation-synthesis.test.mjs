import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildHindsightDocument, buildSynthesisPrompt, MAX_SYNTHESIS_PROMPT_BYTES, preflightSynthesisPrompt } from "../extensions/conversation-catalog/src/synthesis.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (summary = "First redacted event") => [{ reference: "session-one", events: [{ id: "event-one", category: "user", timestamp: "2025-01-01", summary, evidence: { reference: "session-one:event-0001" } }], edges: [] }];
const proposal = (actionType = "harden") => ({ recommendation: `${actionType} the handoff`, actionType, priority: "high", expectedImpact: "Reduce rework", suggestedOwner: "Delivery", dependencies: [], acceptanceCriteria: ["Handoff is reviewed"], status: "proposed", source: "model-suggestion", evidenceReferences: ["session-one:event-0001"] });
const fullOutput = () => ({ title: "A focused headline", claims: [{ statement: "Evidence-supported strength", classification: "direct evidence", evidenceReferences: ["session-one:event-0001"] }, { statement: "An inferred lesson", classification: "inference", evidenceReferences: ["session-one:event-0001"] }], storySteps: [{ title: "Start", body: "The reviewed conversation began.", classification: "direct evidence", evidenceReferences: ["session-one:event-0001"] }], recommendations: [proposal("harden"), proposal("fix")] });
const subagentSource = () => [{ reference: "session-one", events: [
  { id: "event-call", category: "tool-call", timestamp: "2025-01-01", summary: "subagent", metadata: [{ label: "Tool", value: "subagent" }], subagentActivity: "delegation-call", evidence: { reference: "session-one:event-0001" } },
  { id: "event-result", category: "tool-result", timestamp: "2025-01-01", summary: "Reviewed output", metadata: [{ label: "Tool", value: "subagent" }], subagentActivity: "delegation-result", evidence: { reference: "session-one:event-0002" } },
  { id: "event-other", category: "assistant", timestamp: "2025-01-01", summary: "Follow-up accepted", evidence: { reference: "session-one:event-0003" } },
], edges: [] }];
const subagentOutput = () => ({ claims: [], recommendations: [
  { ...proposal("harden"), evidenceReferences: ["session-one:event-0001"] },
  { ...proposal("fix"), evidenceReferences: ["session-one:event-0002"] },
], subagentEfficiency: {
  delegationTiming: [{ statement: "Delegation was explicitly initiated.", findingKind: "strength", classification: "direct evidence", evidenceReferences: ["session-one:event-0001"] }],
  deliveryQuality: [{ statement: "The result and follow-up support reviewing delivery quality.", findingKind: "risk", classification: "inference", evidenceReferences: ["session-one:event-0002"] }],
} });

test("safe report makes cited evidence and matching Fix/Harden proposals inspectable in finding cards", () => {
  const html = buildHindsightDocument(source(), fullOutput());
  for (const heading of ["Summary", "Context", "Do these first", "A compact delivery story", "Keep these strengths", "Lessons and risks", "Evidence appendix"]) assert.match(html, new RegExp(heading));
  for (const marker of ["HARDEN", "FIX", "Matching harden proposals", "Matching fix proposals", "Evidence-supported strength", "An inferred lesson", "First redacted event", 'href="#citation-1"', "Expected impact:", "Suggested owner:", "Done when:"]) assert.ok(html.includes(marker), marker);
  assert.match(html, /default-src 'none'/); assert.match(html, /model suggestions and require human review/); assert.doesNotMatch(html, /Visualizations|narrative map|localStorage|disposition|feedback|outcome|linear|<script/i);
});

test("safe writer validates action types, citations, and matching cited findings", () => {
  assert.throws(() => buildHindsightDocument(source(), { claims: [], recommendations: [{ ...proposal(), actionType: "ship" }] }), /actionType/);
  assert.throws(() => buildHindsightDocument(source(), { claims: [{ statement: "x", classification: "direct evidence", evidenceReferences: ["session-one:event-0001"] }], recommendations: [proposal("fix")] }), /matching harden/);
  assert.throws(() => buildHindsightDocument(source(), { claims: [{ statement: "x", classification: "inference", evidenceReferences: ["session-one:event-0001"] }], recommendations: [proposal("fix"), { ...proposal("harden"), evidenceReferences: ["outside"] }] }), /outside the selected/);
  assert.throws(() => buildHindsightDocument(source(), { claims: [], recommendations: [], narrativeMap: {} }), /unsupported fields/);
  assert.throws(() => buildHindsightDocument(source(), { claims: [], recommendations: [{ ...proposal(), status: "accepted" }] }), /status/);
});

test("subagent efficiency accepts only marked call/result citations with matching actions and renders its compact assessment", () => {
  const html = buildHindsightDocument(subagentSource(), subagentOutput());
  for (const marker of ["Subagent efficiency", "Timing", "Delivery", "Delegation was explicitly initiated.", "Reviewed output", "Matching harden proposals", "Matching fix proposals", "does not prove delivery quality"]) assert.ok(html.includes(marker), marker);
  assert.match(buildSynthesisPrompt(subagentSource()), /marks exact saved-session subagent delegation calls\/results/);
  assert.throws(() => buildHindsightDocument(subagentSource(), { ...subagentOutput(), subagentEfficiency: { ...subagentOutput().subagentEfficiency, delegationTiming: [{ ...subagentOutput().subagentEfficiency.delegationTiming[0], evidenceReferences: ["session-one:event-0003"] }] } }), /outside the selected redacted source bundle/);
  assert.throws(() => buildHindsightDocument(subagentSource(), { ...subagentOutput(), recommendations: [proposal("fix")], subagentEfficiency: { ...subagentOutput().subagentEfficiency, delegationTiming: [] } }), /matching fix proposal/);
  assert.throws(() => buildHindsightDocument(source(), { claims: [], recommendations: [], subagentEfficiency: { delegationTiming: [], deliveryQuality: [] } }), /must be omitted/);
  assert.doesNotThrow(() => buildHindsightDocument(subagentSource(), { claims: [], recommendations: [], subagentEfficiency: { delegationTiming: [], deliveryQuality: [] } }));
});

test("no delegated activity has a deterministic concise state and prompt forbids invented assessment", () => {
  const html = buildHindsightDocument(source(), { claims: [], recommendations: [] });
  assert.match(html, /No inspectable subagent activity in this selected conversation\./);
  assert.match(buildSynthesisPrompt(source()), /Omit subagentEfficiency entirely/);
});

test("omitted model output and excluded redaction fallback remain safe", () => {
  const defaultHtml = buildHindsightDocument(source()); assert.match(defaultHtml, /Selected conversation contains 1 inspectable events/);
  const html = buildHindsightDocument([{ reference: "session-hidden", excluded: true }], { claims: [], recommendations: [] });
  assert.match(html, /session-hidden:excluded/); assert.match(html, /excluded during redaction review/); assert.doesNotMatch(html, /event-one/);
});

test("synthesis prompt requires matching Fix/Harden proposals and retains preflight safeguards", () => {
  const prompt = buildSynthesisPrompt(source()); assert.match(prompt, /actionType \("fix" or "harden"\)/); assert.match(prompt, /Harden proposal/); assert.match(prompt, /Fix proposal/); assert.doesNotMatch(prompt, /narrativeMap|prior outcomes|notes/i);
  assert.throws(() => buildHindsightDocument([]), /exactly one/); assert.throws(() => buildHindsightDocument([...source(), ...source()]), /exactly one/);
  assert.throws(() => preflightSynthesisPrompt(source("🧠".repeat(MAX_SYNTHESIS_PROMPT_BYTES)), {}, { tokens: 0, contextWindow: 1_000_000 }), /limited to/);
});

test("only two public commands remain and flow/map modules are deleted", () => {
  const index = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8");
  assert.equal((index.match(/registerCommand\(/g) || []).length, 2); assert.equal((index.match(/registerTool\(/g) || []).length, 1);
  for (const command of ["conversation-catalog", "hindsight-document"]) assert.ok(index.includes(`registerCommand("${command}"`));
  for (const removed of ["conversation-flow", "conversation-map", "flow.mjs", "map.mjs", "createRedactionMetadata", "generateExcludedConversationHtml", "writeRelationshipMapExport"]) assert.doesNotMatch(index, new RegExp(removed, "i"));
  assert.equal(existsSync(join(root, "extensions/conversation-catalog/src/flow.mjs")), false); assert.equal(existsSync(join(root, "extensions/conversation-catalog/src/map.mjs")), false);
});

test("unsupported hindsight flags are rejected before a session is selected", async () => {
  const extension = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8").replace(/^import[^\n]+;\r?\n/gm, "");
  const compiled = ts.transpileModule(extension, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { hindsightArguments } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  for (const flag of ["--narrative-map", "--validate-claim-support", "--prior-outcomes old.outcomes.json"]) assert.throws(() => hindsightArguments(flag), /Unsupported hindsight option/);
  assert.deepEqual(hindsightArguments("reports/one.html"), { outputPath: "reports/one.html" });
});
