import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildHindsightDocument, buildSynthesisPrompt, MAX_SYNTHESIS_PROMPT_BYTES, measureSynthesisPrompt, preflightSynthesisPrompt } from "../extensions/conversation-catalog/src/synthesis.mjs";

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

test("renderer-owned report context and glossary are fixed across report variants and do not enter synthesis", () => {
  const sensitiveSentinels = ["RAW-SESSION-SENTINEL", "RAW-EVENT-SENTINEL", "RAW-CALL-SENTINEL", "C:/private/RAW-PATH-SENTINEL", "NOTE-SENTINEL", "AIDEV-99"];
  const normalSource = [{ reference: "session-one", rawSessionId: sensitiveSentinels[0], path: sensitiveSentinels[3], events: [{ id: sensitiveSentinels[1], callId: sensitiveSentinels[2], category: "user", timestamp: "2025-01-01", summary: "Inspectable redacted evidence", evidence: { reference: "session-one:event-0001" } }], edges: [] }];
  const note = { noteId: "note-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", eventReference: "event-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", eventLabel: "Reviewed event", text: sensitiveSentinels[4], provenance: { source: "user-authored", confirmation: "user-confirmed", createdAt: "2025-01-01T00:00:00.000Z" } };
  const closeout = { version: 1, ticket: sensitiveSentinels[5], pickedUpAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-01-01T00:01:00.000Z", durationMs: 60000, coverage: "complete", completedSegments: 1, totalSegments: 1, totals: { total: 3, parentDelta: 1, subagentTotal: 2, subagentRuns: 1 }, gaps: [], mergedEvidenceCount: 1, closedEvidenceCount: 1 };
  const staticSection = (html) => html.match(/<section id="report-context" class="section">.*?<\/section>/)?.[0];
  const normal = staticSection(buildHindsightDocument(normalSource, fullOutput()));
  const excluded = staticSection(buildHindsightDocument([{ reference: "session-hidden", excluded: true, rawSessionId: sensitiveSentinels[0], events: [{ summary: "EXCLUDED-SOURCE-SENTINEL" }] }], { claims: [], recommendations: [] }));
  const notes = staticSection(buildHindsightDocument(normalSource, fullOutput(), [note]));
  const closeoutReport = staticSection(buildHindsightDocument(normalSource, fullOutput(), undefined, closeout));
  assert.ok(normal);
  assert.equal(normal, excluded); assert.equal(normal, notes); assert.equal(normal, closeoutReport);
  for (const marker of ["Report Context", "How to read this report", "Glossary: report labels and boundaries", "Redacted evidence context", "Citation", "Direct evidence", "Inference", "Fix", "Harden", "Proposed", "Excluded source", "User-authored context", "Linked ticket closeout"]) assert.match(normal, new RegExp(marker));
  assert.doesNotMatch(normal, /href="#citation-|session-one:event|EXCLUDED-SOURCE-SENTINEL/);
  for (const sentinel of sensitiveSentinels) assert.doesNotMatch(normal, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const prompt = buildSynthesisPrompt(normalSource, { hindsightNotes: [note] });
  assert.doesNotMatch(prompt, /How to read this report|Glossary: report labels and boundaries|A bounded excerpt from the selected conversation after the required review and redaction process/);
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

test("note-dominated oversized prompts report measured components and preserve note non-evidence rules", () => {
  const hindsightNotes = Array.from({ length: 100 }, (_, index) => ({ noteId: `note-${index.toString(16).padStart(32, "a")}`, eventReference: `event-${index.toString(16).padStart(32, "b")}`, eventLabel: "Reviewed event", text: "n".repeat(2000), provenance: { source: "user-authored", confirmation: "user-confirmed", createdAt: "2025-01-01T00:00:00.000Z" } }));
  const measure = measureSynthesisPrompt(source(), { hindsightNotes }); assert.ok(measure.noteContextBytes > measure.evidenceBytes); assert.equal(measure.totalBytes, measure.evidenceBytes + measure.noteContextBytes + measure.instructionsAndOverheadBytes);
  assert.match(buildSynthesisPrompt(source(), { hindsightNotes }), /never evidence\/citations/);
  assert.throws(() => preflightSynthesisPrompt(source(), { hindsightNotes }, { tokens: 0, contextWindow: 1_000_000 }), /note context:.*instructions\/overhead:.*Review, redact, or remove hindsight notes/i);
});

test("only approved public commands remain and flow/map modules are deleted", () => {
  const index = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8");
  assert.equal((index.match(/registerCommand\(/g) || []).length, 3); assert.equal((index.match(/registerTool\(/g) || []).length, 3);
  for (const command of ["conversation-catalog", "hindsight-document", "hindsight-notes"]) assert.ok(index.includes(`registerCommand("${command}"`));
  for (const removed of ["conversation-flow", "conversation-map", "createRedactionMetadata", "generateExcludedConversationHtml", "writeRelationshipMapExport"]) assert.doesNotMatch(index, new RegExp(removed, "i"));
  assert.equal(existsSync(join(root, "extensions/conversation-catalog/src/flow.mjs")), false); assert.equal(existsSync(join(root, "extensions/conversation-catalog/src/map.mjs")), false);
});

test("linked ticket closeout is separately rendered but excluded from the synthesis prompt and citations", () => {
  const closeout = { version: 1, ticket: "AIDEV-76", pickedUpAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-01-01T00:01:00.000Z", durationMs: 60000, coverage: "partial", completedSegments: 1, totalSegments: 2, totals: { total: 3, parentDelta: 1, subagentTotal: 2, subagentRuns: 1 }, gaps: ["interrupted"], mergedEvidenceCount: 1, closedEvidenceCount: 1 };
  const html = buildHindsightDocument(source(), fullOutput(), undefined, closeout); assert.match(html, /Linked ticket closeout/); assert.match(html, /Known lower-bound total/); assert.match(html, /not submitted to the model/); assert.doesNotMatch(buildSynthesisPrompt(source()), /AIDEV-76|ticket closeout/i); assert.throws(() => buildHindsightDocument(source(), fullOutput(), undefined, { ...closeout, evidence: "widened" }), /descriptor is malformed/);
  assert.match(buildHindsightDocument(source(), fullOutput(), undefined, { ...closeout, totals: { total: 1.25, parentDelta: 0.5, subagentTotal: 0.75, subagentRuns: 1 } }), /1.25/);
  for (const invalid of [{ ...closeout, completedSegments: 0 }, { ...closeout, coverage: "complete" }, { ...closeout, completedSegments: 2, gaps: ["interrupted"] }, { ...closeout, gaps: ["unknown"] }]) assert.throws(() => buildHindsightDocument(source(), fullOutput(), undefined, invalid), /descriptor is malformed/);
  assert.equal(buildHindsightDocument(source(), fullOutput()), buildHindsightDocument(source(), fullOutput(), undefined, undefined));
});

test("unsupported hindsight flags are rejected before a session is selected", async () => {
  const extension = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8").replace(/^import[^\n]+;\r?\n/gm, "");
  const compiled = ts.transpileModule(extension, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { hindsightArguments } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  for (const flag of ["--narrative-map", "--validate-claim-support", "--prior-outcomes old.outcomes.json"]) assert.throws(() => hindsightArguments(flag), /Unsupported hindsight option/);
  assert.deepEqual(hindsightArguments("session-ab12 --ticket-closeout E:/receipt.json"), { reference: "session-ab12", closeoutPath: "E:/receipt.json" });
  assert.throws(() => hindsightArguments("--ticket-closeout"), /Usage:/);
  assert.deepEqual(hindsightArguments("reports/one.html"), { outputPath: "reports/one.html" });
  assert.deepEqual(hindsightArguments("session-ab12 reports/one.html"), { reference: "session-ab12", outputPath: "reports/one.html" });
  assert.throws(() => hindsightArguments("session-invalid!"), /identifier is invalid/);
});

test("canonical chunk plans are deterministic, UTF-8 bounded, ordered, and exclude notes/citations", async () => {
  const { planCanonicalSynthesisChunks } = await import("../extensions/conversation-catalog/src/chunk-plan.mjs");
  const sources = [{ reference: "session-one", events: [
    { category: "user", timestamp: "2025-01-01", title: "One", summary: "é".repeat(20), metadata: [], evidence: { reference: "session-one:event-0001" } },
    { category: "assistant", timestamp: "2025-01-02", title: "Two", summary: "second", metadata: [], evidence: { reference: "session-one:event-0002" } },
  ] }];
  const plan = planCanonicalSynthesisChunks(sources, { maxBytes: 400 });
  assert.deepEqual(plan, planCanonicalSynthesisChunks(sources, { maxBytes: 400 }));
  assert.deepEqual(plan.chunks.flatMap((chunk) => chunk.references), ["session-one:event-0001", "session-one:event-0002"]);
  for (const chunk of plan.chunks) { assert.ok(chunk.bytes <= 400); assert.match(chunk.fingerprint, /^[a-f0-9]{64}$/); assert.doesNotMatch(JSON.stringify(chunk), /note|citation/i); }
  assert.throws(() => planCanonicalSynthesisChunks([{ reference: "session-one", events: [{ summary: "x".repeat(1000), evidence: { reference: "session-one:event-oversized" } }] }], { maxBytes: 256 }), /Redact that event further/);
});

test("bounded chunk workflow cuts evidence, bounds every submission, and validates retained citations", async () => {
  const { MAX_CHUNK_CAPTURE_BYTES, MAX_REDUCTION_BYTES, MAX_SYNTHESIS_PROMPT_BYTES: limit, buildChunkedFinalPrompt, buildReductionGroups, buildReductionPrompt, planChunkedHindsightPrompts, validateChunkDigest } = await import("../extensions/conversation-catalog/src/chunk-workflow.mjs");
  const sources = [{ reference: "session-one", events: Array.from({ length: 5 }, (_, index) => ({ category: "assistant", timestamp: "2025-01-01", title: `Event ${index}`, summary: "é".repeat(6000), evidence: { reference: `session-one:event-${index}` } })) }];
  const plan = planChunkedHindsightPrompts(sources); assert.ok(plan.prompts.length > 1); for (const prompt of plan.prompts) assert.ok(Buffer.byteLength(prompt, "utf8") <= limit);
  const allowed = new Set(["session-one:event-0"]); assert.deepEqual(validateChunkDigest({ summary: "kept", evidenceReferences: ["session-one:event-0"] }, allowed, MAX_CHUNK_CAPTURE_BYTES), { summary: "kept", evidenceReferences: ["session-one:event-0"] }); assert.throws(() => validateChunkDigest({ summary: "kept", evidenceReferences: ["outside"] }, allowed, MAX_CHUNK_CAPTURE_BYTES), /outside/);
  const captures = Array.from({ length: 20 }, (_, index) => ({ summary: "summary ".repeat(200), evidenceReferences: [`session-one:event-${index % 5}`] })); const groups = buildReductionGroups(captures); assert.ok(groups.length < captures.length); for (const [index, group] of groups.entries()) assert.ok(Buffer.byteLength(buildReductionPrompt(group, index + 1, groups.length), "utf8") <= limit);
  assert.ok(Buffer.byteLength(buildChunkedFinalPrompt([{ summary: "small", evidenceReferences: ["session-one:event-0"] }]), "utf8") <= limit); assert.equal(MAX_REDUCTION_BYTES, 1200);
});

test("oversized single-prompt hindsight remains preflight-rejected only outside the chunk workflow", () => {
  assert.throws(() => preflightSynthesisPrompt(source("x".repeat(MAX_SYNTHESIS_PROMPT_BYTES)), {}, { tokens: 0, contextWindow: 1_000_000 }), /direct single-prompt preflight does not perform chunk synthesis/i);
});
