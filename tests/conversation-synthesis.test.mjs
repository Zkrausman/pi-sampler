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
const subagentSource = ({ followUp = true } = {}) => [{ reference: "session-one", events: [
  { id: "event-call", category: "tool-call", timestamp: "2025-01-01", summary: "subagent", metadata: [{ label: "Tool", value: "subagent" }], subagentActivity: "delegation-call", delegationPair: "delegation-1", evidence: { reference: "session-one:event-0001" } },
  { id: "event-result", category: "tool-result", timestamp: "2025-01-01", summary: "Reviewed output", metadata: [{ label: "Tool", value: "subagent" }], subagentActivity: "delegation-result", delegationPair: "delegation-1", evidence: { reference: "session-one:event-0002" } },
  ...(followUp ? [{ id: "event-other", category: "assistant", timestamp: "2025-01-01", summary: "Follow-up accepted", subagentActivity: "delegation-follow-up", delegationPair: "delegation-1", evidence: { reference: "session-one:event-0003" } }] : []),
], edges: [] }];
const subagentOutput = () => ({ claims: [], recommendations: [
  { ...proposal("harden"), evidenceReferences: ["session-one:event-0001"] },
  { ...proposal("fix"), evidenceReferences: ["session-one:event-0002", "session-one:event-0003"] },
], subagentEfficiency: {
  delegationTiming: [{ statement: "Delegation was explicitly initiated.", findingKind: "strength", classification: "direct evidence", evidenceReferences: ["session-one:event-0001"] }],
  deliveryQuality: [{ statement: "The result and chronological follow-up support reviewing delivery quality.", findingKind: "risk", classification: "inference", evidenceReferences: ["session-one:event-0002", "session-one:event-0003"] }],
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

test("subagent efficiency validates matched delegation, follow-up delivery evidence, and shared Fix/Harden citations", () => {
  const html = buildHindsightDocument(subagentSource(), subagentOutput());
  for (const marker of ["Subagent efficiency", "Timing", "Delivery", "Delegation was explicitly initiated.", "Reviewed output", "Follow-up accepted", "Matching harden proposals", "Matching fix proposals", "follow-up are cited"]) assert.ok(html.includes(marker), marker);
  assert.match(buildSynthesisPrompt(subagentSource()), /exact same-ID results/);
  assert.throws(() => buildHindsightDocument(subagentSource(), { ...subagentOutput(), subagentEfficiency: { ...subagentOutput().subagentEfficiency, delegationTiming: [{ ...subagentOutput().subagentEfficiency.delegationTiming[0], evidenceReferences: ["session-one:event-0003"] }] } }), /call or result/);
  assert.throws(() => buildHindsightDocument(subagentSource(), { ...subagentOutput(), subagentEfficiency: { ...subagentOutput().subagentEfficiency, deliveryQuality: [{ ...subagentOutput().subagentEfficiency.deliveryQuality[0], classification: "direct evidence" }] } }), /requires inference/);
  assert.throws(() => buildHindsightDocument(subagentSource(), { ...subagentOutput(), subagentEfficiency: { ...subagentOutput().subagentEfficiency, deliveryQuality: [{ ...subagentOutput().subagentEfficiency.deliveryQuality[0], evidenceReferences: ["session-one:event-0001", "session-one:event-0003"] }] } }), /result and its own chronological follow-up/);
  assert.throws(() => buildHindsightDocument(subagentSource({ followUp: false }), { claims: [], recommendations: [{ ...proposal("fix"), evidenceReferences: ["session-one:event-0002"] }], subagentEfficiency: { delegationTiming: [], deliveryQuality: [{ statement: "A result alone cannot assess quality.", findingKind: "risk", classification: "inference", evidenceReferences: ["session-one:event-0002"] }] } }), /result and its own chronological follow-up/);
  assert.throws(() => buildHindsightDocument(subagentSource(), { ...subagentOutput(), recommendations: [proposal("fix")], subagentEfficiency: { ...subagentOutput().subagentEfficiency, delegationTiming: [] } }), /matching fix proposal/);
  assert.throws(() => buildHindsightDocument(source(), { claims: [], recommendations: [], subagentEfficiency: { delegationTiming: [], deliveryQuality: [] } }), /must be omitted/);
  assert.doesNotThrow(() => buildHindsightDocument(subagentSource({ followUp: false }), { claims: [], recommendations: [], subagentEfficiency: { delegationTiming: [], deliveryQuality: [] } }));
});

test("lone calls are no activity while a matched result without follow-up permits timing only", () => {
  const loneCall = [{ reference: "session-one", events: [{ id: "event-call", subagentActivity: "delegation-call", delegationPair: "delegation-1", evidence: { reference: "session-one:event-0001" } }], edges: [] }];
  assert.match(buildHindsightDocument(loneCall, { claims: [], recommendations: [] }), /No inspectable subagent activity/);
  assert.throws(() => buildHindsightDocument(loneCall, { claims: [], recommendations: [], subagentEfficiency: { delegationTiming: [], deliveryQuality: [] } }), /must be omitted/);
  const timingOnly = { claims: [], recommendations: [{ ...proposal("harden"), evidenceReferences: ["session-one:event-0002"] }], subagentEfficiency: { delegationTiming: [{ statement: "A matched result is available for timing review.", findingKind: "strength", classification: "direct evidence", evidenceReferences: ["session-one:event-0002"] }], deliveryQuality: [] } };
  assert.doesNotThrow(() => buildHindsightDocument(subagentSource({ followUp: false }), timingOnly));
});

test("delivery quality rejects cross-pair citations while accepting one qualified pair", () => {
  const paired = [{ reference: "session-one", events: [
    { id: "call-one", subagentActivity: "delegation-call", delegationPair: "delegation-1", evidence: { reference: "session-one:event-0001" } },
    { id: "result-one", subagentActivity: "delegation-result", delegationPair: "delegation-1", evidence: { reference: "session-one:event-0002" } },
    { id: "follow-one", subagentActivity: "delegation-follow-up", delegationPair: "delegation-1", evidence: { reference: "session-one:event-0003" } },
    { id: "call-two", subagentActivity: "delegation-call", delegationPair: "delegation-2", evidence: { reference: "session-one:event-0004" } },
    { id: "result-two", subagentActivity: "delegation-result", delegationPair: "delegation-2", evidence: { reference: "session-one:event-0005" } },
    { id: "follow-two", subagentActivity: "delegation-follow-up", delegationPair: "delegation-2", evidence: { reference: "session-one:event-0006" } },
  ], edges: [] }];
  const output = (refs) => ({ claims: [], recommendations: [{ ...proposal("fix"), evidenceReferences: refs }], subagentEfficiency: { delegationTiming: [], deliveryQuality: [{ statement: "Review delivery evidence.", findingKind: "risk", classification: "inference", evidenceReferences: refs }] } });
  assert.throws(() => buildHindsightDocument(paired, output(["session-one:event-0002", "session-one:event-0006"])), /its own chronological follow-up/);
  assert.doesNotThrow(() => buildHindsightDocument(paired, output(["session-one:event-0005", "session-one:event-0006"])));
  const prompt = buildSynthesisPrompt(paired); assert.match(prompt, /Qualified delivery pairs \(evidence-reference arrays only\)/); assert.doesNotMatch(prompt, /delegation-[12]/);
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
  const prompt = buildSynthesisPrompt(source()); assert.match(prompt, /actionType \("fix" or "harden"\)/); assert.match(prompt, /Harden proposal/); assert.match(prompt, /Fix proposal/); assert.doesNotMatch(prompt, /narrativeMap|prior outcomes/i); assert.match(prompt, /No user-authored hindsight notes were included after review/);
  assert.throws(() => buildHindsightDocument([]), /exactly one/); assert.throws(() => buildHindsightDocument([...source(), ...source()]), /exactly one/);
  assert.throws(() => preflightSynthesisPrompt(source("🧠".repeat(MAX_SYNTHESIS_PROMPT_BYTES)), {}, { tokens: 0, contextWindow: 1_000_000 }), /limited to/);
});

test("only approved public commands remain and flow/map modules are deleted", () => {
  const index = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8");
  assert.equal((index.match(/registerCommand\(/g) || []).length, 3); assert.equal((index.match(/registerTool\(/g) || []).length, 1);
  for (const command of ["conversation-catalog", "hindsight-document", "hindsight-notes"]) assert.ok(index.includes(`registerCommand("${command}"`));
  for (const removed of ["conversation-flow", "conversation-map", "flow.mjs", "map.mjs", "createRedactionMetadata", "generateExcludedConversationHtml", "writeRelationshipMapExport"]) assert.doesNotMatch(index, new RegExp(removed, "i"));
  assert.equal(existsSync(join(root, "extensions/conversation-catalog/src/flow.mjs")), false); assert.equal(existsSync(join(root, "extensions/conversation-catalog/src/map.mjs")), false);
});

test("unsupported hindsight flags are rejected before a session is selected", async () => {
  const extension = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8").replace(/^import[^\n]+;\r?\n/gm, "");
  const compiled = ts.transpileModule(extension, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { hindsightArguments } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  for (const flag of ["--narrative-map", "--validate-claim-support", "--prior-outcomes old.outcomes.json"]) assert.throws(() => hindsightArguments(flag), /Unsupported hindsight option/);
  assert.deepEqual(hindsightArguments("reports/one.html"), { outputPath: "reports/one.html" });
  assert.deepEqual(hindsightArguments("session-ab12 reports/one.html"), { reference: "session-ab12", outputPath: "reports/one.html" });
  assert.throws(() => hindsightArguments("session-invalid!"), /identifier is invalid/);
});
