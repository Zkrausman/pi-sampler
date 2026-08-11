import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildClaimSupportValidationPrompt, buildHindsightDocument, buildSynthesisPrompt } from "../extensions/conversation-catalog/src/synthesis.mjs";
import { createHindsightRecommendationDispositionMetadata } from "../extensions/conversation-catalog/src/evidence.mjs";
import { restrictToolsForHindsightSynthesis } from "../extensions/conversation-catalog/src/hindsight-tools.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function loadConversationCatalogExtension() {
  let extension = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8");
  extension = extension.replace(/^import[^\n]+;\r?\n/gm, "");
  const stubs = `
const randomUUID = () => "test-uuid";
const mkdir = async () => {};
const readFile = async () => { const error = new Error("not found"); error.code = "ENOENT"; throw error; };
const rm = async (path) => { globalThis.__hindsightFiles?.delete(path); };
const writeFile = async (path, content) => {
  (globalThis.__hindsightWrites ||= []).push({ path, content });
  if (globalThis.__hindsightWriteFailure?.(path)) throw new Error("simulated write failure");
  (globalThis.__hindsightFiles ||= new Map()).set(path, content);
};
const rename = async (from, to) => {
  (globalThis.__hindsightRenames ||= []).push({ from, to });
  const content = globalThis.__hindsightFiles?.get(from);
  if (content === undefined) throw new Error("temporary file missing");
  globalThis.__hindsightFiles.set(to, content);
  globalThis.__hindsightFiles.delete(from);
};
const dirname = () => ".";
const extname = (path) => path.slice(path.lastIndexOf("."));
const resolve = (cwd, path) => cwd + "/" + path;
const SessionManager = {
  listAll: async () => [
    { id: "one", name: "First", cwd: "/test", path: "/one", modified: "", messageCount: 1 },
    { id: "two", name: "Second", cwd: "/test", path: "/two", modified: "", messageCount: 1 },
  ],
  open: async (path) => ({ getEntries: () => globalThis.__hindsightEntries?.[path] || [] }),
};
const Type = { Object: (value) => value, Optional: (value) => value, String: () => ({}), Integer: () => ({}), Array: () => ({}), Union: () => ({}), Literal: () => ({}) };
const generateCatalogHtml = () => "";
const groupSessions = (value) => value;
const generateConversationFlowHtml = () => "";
const projectConversation = (entries) => entries || ({ events: [], edges: [] });
const attachEvidenceReferences = (_reference, value) => value;
const createEvidenceManifest = () => ({ schemaVersion: 1, citations: [] });
const createHindsightRecommendationDispositionMetadata = (document) => ({ schemaVersion: 1, recommendations: document.recommendations });
const generateRelationshipMapHtml = () => "";
const projectRelationshipMap = (value) => value;
const buildClaimSupportValidationPrompt = () => "Validate cited claim support";
const buildHindsightDocument = (...args) => { globalThis.__hindsightDocumentArgs = args; return "<html></html>"; };
const buildSynthesisPrompt = (...args) => { globalThis.__hindsightPromptArgs = args; return "Synthesize"; };
const restrictToolsForHindsightSynthesis = (pi) => {
  const previousTools = pi.getActiveTools();
  let restored = false;
  pi.setActiveTools(["hindsight_document_write"]);
  return () => {
    if (restored) return;
    restored = true;
    pi.setActiveTools(previousTools);
  };
};
const compileSensitivePatterns = () => [];
const createRedactionMetadata = () => ({});
const findSensitiveContent = (projection) => (projection?.events || []).flatMap((event) => {
  const email = "user@example.test";
  const slack = "xoxb-1234567890-AbCdEfGhIjKl";
  const value = event?.summary || "";
  const matched = value.includes(email) ? { pattern: "email address", preview: email, requiredRedaction: false } : value.includes(slack) ? { pattern: "Slack token", preview: slack, requiredRedaction: true } : undefined;
  return matched ? [{ id: "finding-1", eventId: event.id, ...matched, start: value.indexOf(matched.preview), end: value.indexOf(matched.preview) + matched.preview.length, field: "summary" }] : [];
});
const generateExcludedConversationHtml = () => "";
const pseudonymizeSession = (session) => session.id;
const redactProjection = (value, findings, decisions) => ({ ...value, events: (value?.events || []).map((event) => ({ ...event, summary: findings?.length && decisions?.[findings[0].id] === "redact" ? event.summary.replace(findings[0].preview, "[REDACTED: " + findings[0].pattern + "]") : event.summary })) });
class HindsightWorkError extends Error { constructor(code) { super(code); this.code = code; } }
const HINDSIGHT_WORK_CONFIG_PATH = ".pi/hindsight-linear.json";
const acceptedHindsightRecommendations = (value) => value.recommendations || [];
const buildLinearIssueCreatePayload = () => ({ teamId: "team", title: "Title", description: "Payload", priority: 2 });
const digestHindsightWorkPayload = () => "0".repeat(64);
const isValidExistingIssueId = () => true;
const parseHindsightWorkDispositions = () => ({ reportId: "hindsight-1234abcd", recommendations: [] });
const readHindsightWorkLinks = async () => ({ links: {} });
const requireFinalHindsightWorkConfirmation = () => {};
const validateHindsightLinearConfig = () => ({ ok: false, code: "invalid_config" });
const validateHindsightWorkContext = ({ hasUI, trusted }) => { if (!hasUI) throw new HindsightWorkError("ui_required"); if (!trusted) throw new HindsightWorkError("untrusted_project"); };
const workLinkKey = () => "key";
const workLinksPathForDispositionPath = (path) => path.replace(".dispositions.json", ".work-links.json");
const writeHindsightWorkLink = async () => { globalThis.__hindsightWriteCalls = (globalThis.__hindsightWriteCalls || 0) + 1; };
class HindsightFeedbackError extends Error { constructor(code) { super(code); this.code = code; } }
const createHindsightFeedbackMetadata = () => ({ schemaVersion: 1, reportId: "hindsight-1234abcd", targets: [], feedback: [] });
const feedbackPathForDispositionPath = (path) => path.replace(".dispositions.json", ".feedback.json");
const feedbackReportPathForDispositionPath = (path) => path.replace(".dispositions.json", ".feedback.html");
const readHindsightFeedback = async () => undefined;
const writeHindsightFeedbackSeed = async (path, seed) => { globalThis.__hindsightFiles.set(path, JSON.stringify(seed)); };
const refreshHindsightFeedbackViews = async () => {};
const recordHindsightFeedback = async () => {};
class HindsightNotesError extends Error { constructor(code) { super(code); this.code = code; } }
class HindsightOutcomeError extends Error { constructor(code) { super(code); this.code = code; } }
const hindsightNotesPath = (_cwd, reference) => "/test/.pi/hindsight-notes/" + reference + ".json";
const hindsightNotesSessionReference = (id) => "session-" + id.padEnd(32, "0").slice(0, 32);
const readHindsightNotes = async (_root, reference) => globalThis.__hindsightNotesByReference?.[reference];
const addHindsightNote = async (...args) => { globalThis.__hindsightNoteAdd = args; };
const editHindsightNote = async (...args) => { globalThis.__hindsightNoteEdit = args; };
const deleteHindsightNote = async (...args) => { globalThis.__hindsightNoteDelete = args; };
const outcomeHistoryPathForDispositionPath = (path) => path.replace(".dispositions.json", ".outcomes.json");
class HindsightLinearAdapter {
  async createIssue() { globalThis.__hindsightCreateCalls = (globalThis.__hindsightCreateCalls || 0) + 1; return { id: "issue_1", url: "https://linear.app/acme/issue/ABC-1", status: "Todo" }; }
  async resolveIssue() { globalThis.__hindsightResolveCalls = (globalThis.__hindsightResolveCalls || 0) + 1; return { id: "issue_1", url: "https://linear.app/acme/issue/ABC-1", status: "Todo" }; }
}
const createRequestPreview = () => "{}";
const linkLookupRequestPreview = () => "{}";
`;
  const compiled = ts.transpileModule(`${stubs}\n${extension}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "conversation-catalog.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const source = (id, summary) => ({
  events: [{ id: `${id}-event-1`, category: "user", timestamp: "2025-01-01", summary, evidence: { reference: `${id}:event-0001` } }],
});

test("an excluded selected conversation retains a pseudonymous navigable fallback without content", () => {
  const html = buildHindsightDocument([{ reference: "session-excluded", excluded: true, events: [{ summary: "Hidden", evidence: { reference: "hidden:event-1" } }] }]);
  assert.match(html, /href="#citation-1">session-excluded:excluded<\/a>/);
  assert.match(html, /id="citation-1"/);
  assert.match(html, /Source context was excluded during redaction review/);
  assert.doesNotMatch(html, /Hidden|hidden:event-1/);
});

test("opt-in validation writes an excluded fallback without assessing unavailable fallback claims", () => {
  const html = buildHindsightDocument(
    [{ reference: "session-excluded", excluded: true, events: [{ summary: "Hidden", evidence: { reference: "hidden:event-1" } }] }],
    { claims: [], recommendations: [] },
    { source: "model-validation", userDisposition: "not-user-confirmed", assessments: [] },
  );
  assert.match(html, /href="#citation-1">session-excluded:excluded<\/a>/);
  assert.match(html, /No material generated claims were available for claim-support validation/);
  assert.doesNotMatch(html, /Claim 1:|Hidden|hidden:event-1/);
});

test("model claims and structured recommendations are escaped, cited, and rendered in an accessible table", () => {
  const html = buildHindsightDocument([source("one", "First")], {
    title: "<unsafe title>",
    claims: [{ statement: "<img src=x onerror=alert(1)>", classification: "inference", evidenceReferences: ["one:event-0001"] }],
    recommendations: [{
      recommendation: "<script>prioritize()</script>",
      priority: "high",
      expectedImpact: "<strong>Less rework</strong>",
      suggestedOwner: "<img src=x onerror=alert(2)>",
      dependencies: ["<dependency>"],
      acceptanceCriteria: ["<criterion> is measurable"],
      status: "proposed",
      source: "model-suggestion",
      evidenceReferences: ["one:event-0001"],
    }],
  });
  assert.match(html, /&lt;unsafe title&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;prioritize\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.doesNotMatch(html, /<script>prioritize\(\)<\/script>/);
  assert.match(html, /<table>/);
  assert.match(html, /<caption>Structured recommendations proposed by the model; none are user-confirmed.<\/caption>/);
  assert.match(html, /scope="col">Measurable acceptance criteria/);
  assert.match(html, /proposed · model-suggestion/);
  assert.match(html, /Model suggestion; not user-confirmed/);
  assert.match(html, /User-confirmed recommendation dispositions/);
  assert.match(html, /value="accepted" required> Accept/);
  assert.match(html, /value="deferred"> Defer/);
  assert.match(html, /value="rejected"> Reject/);
  assert.match(html, /Rationale<\/label><textarea[^>]+required maxlength="1000"/);
  assert.match(html, /Export disposition metadata JSON/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /href="#citation-1"/);
});

test("disposition metadata keeps original model recommendations and pseudonymous citations separate from user decisions", () => {
  const metadata = createHindsightRecommendationDispositionMetadata({ recommendations: [{
    recommendation: "Improve handoff", priority: "medium", expectedImpact: "Reduce delays", suggestedOwner: "Delivery team",
    dependencies: [], acceptanceCriteria: ["A handoff completes within one business day"], status: "proposed", source: "model-suggestion",
    evidenceReferences: ["one:event-0001"],
  }] });
  assert.equal(metadata.kind, "pi-hindsight-recommendation-dispositions");
  assert.equal(metadata.schemaVersion, 2);
  assert.match(metadata.reportId, /^hindsight-[a-f0-9]{8}$/);
  assert.deepEqual(metadata.recommendations[0], {
    recommendationNumber: 1,
    modelSuggestion: {
      status: "proposed", source: "model-suggestion", recommendation: "Improve handoff", priority: "medium",
      expectedImpact: "Reduce delays", suggestedOwner: "Delivery team", dependencies: [],
      acceptanceCriteria: ["A handoff completes within one business day"], evidenceReferences: ["one:event-0001"],
    },
    userDisposition: { status: "not-recorded", source: "not-user-confirmed", rationale: "" },
  });
  const original = {
    recommendation: "Improve handoff", priority: "medium", expectedImpact: "Reduce delays", suggestedOwner: "Delivery team",
    dependencies: [], acceptanceCriteria: ["A handoff completes within one business day"], status: "proposed", source: "model-suggestion",
    evidenceReferences: ["one:event-0001"],
  };
  for (const [field, changed] of [
    ["priority", { ...original, priority: "high" }],
    ["expected impact", { ...original, expectedImpact: "Eliminate delays" }],
    ["owner", { ...original, suggestedOwner: "Operations team" }],
    ["dependencies", { ...original, dependencies: ["Staffing plan"] }],
    ["acceptance criteria", { ...original, acceptanceCriteria: ["A handoff completes within four hours"] }],
  ]) {
    assert.notEqual(createHindsightRecommendationDispositionMetadata({ recommendations: [changed] }).reportId, metadata.reportId, `changed ${field} requires a fresh disposition identity`);
  }
  assert.throws(() => createHindsightRecommendationDispositionMetadata({ recommendations: [{
    ...original, status: "accepted", source: "user-confirmed",
  }] }), /safe structured recommendation contract/);
});

test("safe hindsight recommendations reject missing, malformed, unconfirmed, or uncited model data", () => {
  const sources = [source("one", "First")];
  const claim = { statement: "Supported", classification: "inference", evidenceReferences: ["one:event-0001"] };
  const recommendation = {
    recommendation: "Improve handoff", priority: "medium", expectedImpact: "Reduce delays", suggestedOwner: "Delivery team",
    dependencies: [], acceptanceCriteria: ["A handoff completes within one business day"], status: "proposed", source: "model-suggestion",
    evidenceReferences: ["one:event-0001"],
  };
  assert.throws(() => buildHindsightDocument(sources, { claims: [claim] }), /recommendations must be an array/);
  assert.throws(() => buildHindsightDocument(sources, {
    claims: [claim], recommendations: [{ ...recommendation, status: "user-confirmed", source: "user-confirmed" }],
  }), /status "proposed" and source "model-suggestion"/);
  assert.throws(() => buildHindsightDocument(sources, {
    claims: [claim], recommendations: [{ ...recommendation, acceptanceCriteria: [] }],
  }), /acceptanceCriteria must contain between 1 and 20 items/);
  assert.throws(() => buildHindsightDocument(sources, {
    claims: [claim], recommendations: [{ ...recommendation, evidenceReferences: ["not-selected"] }],
  }), /outside the selected redacted source bundle/);
  const fallback = buildHindsightDocument(sources, { claims: [], recommendations: [] });
  assert.match(fallback, /No structured recommendations were supplied/);
});

test("opt-in claim-support validation requires a complete, evidence-scoped model assessment", () => {
  const sources = [{
    events: [
      { id: "one-event-1", category: "user", timestamp: "2025-01-01", summary: "Customer reported a timeout.", evidence: { reference: "one:event-0001" } },
      { id: "one-event-2", category: "assistant", timestamp: "2025-01-02", summary: "An engineer restarted the service.", evidence: { reference: "one:event-0002" } },
    ],
  }];
  const model = {
    claims: [{ statement: "The customer reported a timeout.", classification: "direct evidence", evidenceReferences: ["one:event-0001"] }],
    recommendations: [],
  };
  const validation = {
    source: "model-validation",
    userDisposition: "not-user-confirmed",
    assessments: [{ claimNumber: 1, support: "supported", rationale: "The cited excerpt explicitly reports the timeout.", evidenceReferences: ["one:event-0001"] }],
  };
  const html = buildHindsightDocument(sources, model, validation);
  assert.match(html, /Claim-support validation/);
  assert.match(html, /Model-generated validation only; it is not a user-confirmed disposition/);
  assert.match(html, /Claim 1:<\/strong> <span class="provenance">supported/);
  assert.match(html, /Rationale:<\/span> The cited excerpt explicitly reports the timeout/);
  assert.match(html, /Evidence evaluated:<\/span> <span class="citations"><a href="#citation-1">one:event-0001/);
  assert.throws(() => buildHindsightDocument(sources, model, {
    ...validation,
    source: "user-confirmed",
  }), /model-generated and not user-confirmed/);
  assert.throws(() => buildHindsightDocument(sources, model, {
    ...validation,
    assessments: [],
  }), /assess every material claim exactly once/);
  assert.throws(() => buildHindsightDocument(sources, model, {
    ...validation,
    assessments: [{ ...validation.assessments[0], support: "<img src=x>" }],
  }), /support must be supported/);
  assert.throws(() => buildHindsightDocument(sources, model, {
    ...validation,
    assessments: [{ ...validation.assessments[0], rationale: "" }],
  }), /rationale must not be blank/);
});

test("claim-support validation cannot cite another included excerpt or omit a claim citation", () => {
  const sources = [{
    events: [
      { id: "one-event-1", summary: "First redacted excerpt", evidence: { reference: "one:event-0001" } },
      { id: "one-event-2", summary: "Second redacted excerpt", evidence: { reference: "one:event-0002" } },
    ],
  }];
  const model = {
    claims: [{ statement: "A claim", classification: "inference", evidenceReferences: ["one:event-0001"] }],
    recommendations: [],
  };
  const validation = {
    source: "model-validation", userDisposition: "not-user-confirmed",
    assessments: [{ claimNumber: 1, support: "unverifiable", rationale: "The cited excerpt cannot establish the claim.", evidenceReferences: ["one:event-0002"] }],
  };
  assert.throws(() => buildHindsightDocument(sources, model, validation), /outside the selected redacted source bundle/);
  assert.match(buildClaimSupportValidationPrompt(sources, model), /Customer|First redacted excerpt/);
  const prompt = buildClaimSupportValidationPrompt(sources, model);
  assert.match(prompt, /one:event-0001/);
  assert.match(prompt, /bounded rationale explaining why the cited excerpts support/);
  assert.doesNotMatch(prompt, /Second redacted excerpt|one:event-0002/);
});

test("synthesis prompt includes redacted flow and relationship-map context", () => {
  const linked = {
    events: [
      { id: "one-event-1", category: "user", timestamp: "2025-01-01", summary: "First", evidence: { reference: "one:event-0001" } },
      { id: "one-event-2", category: "assistant", timestamp: "2025-01-02", summary: "Second", evidence: { reference: "one:event-0002" } },
    ],
    edges: [{ from: "one-event-1", to: "one-event-2", label: "parent entry" }],
  };
  const prompt = buildSynthesisPrompt([linked]);
  assert.match(prompt, /Do NOT write HTML/);
  assert.match(prompt, /hindsight_document_write/);
  assert.match(prompt, /one:event-0001/);
  assert.match(prompt, /"flowContext":"user · 2025-01-01 · First"/);
  assert.match(prompt, /"mapContext":"parent entry → one:event-0002"/);
});

test("hindsight document accepts exactly one conversation and rejects zero or multiple sources", () => {
  assert.doesNotThrow(() => buildHindsightDocument([source("one", "First")]));
  assert.throws(() => buildHindsightDocument([]), /exactly one/);
  assert.throws(() => buildHindsightDocument([source("one", "First"), source("two", "Second")]), /exactly one/);
});

test("hindsight synthesis disables direct file-write tools and restores the session tool set", () => {
  const normalTools = ["read", "write", "edit", "bash", "hindsight_document_write"];
  const setActiveToolsCalls = [];
  const pi = {
    getActiveTools: () => normalTools,
    setActiveTools: (tools) => setActiveToolsCalls.push(tools),
  };

  const restoreTools = restrictToolsForHindsightSynthesis(pi);
  assert.deepEqual(setActiveToolsCalls, [["hindsight_document_write"]]);

  restoreTools();
  restoreTools();
  assert.deepEqual(setActiveToolsCalls, [["hindsight_document_write"], normalTools]);
});

test("hindsight-notes registers a current-session-only add workflow", async () => {
  const { default: conversationCatalog } = await loadConversationCatalogExtension();
  const commands = [];
  conversationCatalog({
    on: () => {}, registerTool: () => {}, registerCommand: (name, command) => commands.push({ name, ...command }),
    getActiveTools: () => [], setActiveTools: () => {}, sendUserMessage: () => {},
  });
  const notes = commands.find((command) => command.name === "hindsight-notes");
  const notifications = [];
  globalThis.__hindsightNoteAdd = undefined;
  await notes.handler("", {
    cwd: "/test", hasUI: true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "one", getSessionName: () => "First" },
    ui: {
      select: async () => "Add note", input: async () => "Current session note.", confirm: async () => true,
      notify: (message, level) => notifications.push({ message, level }),
    },
  });
  assert.deepEqual(globalThis.__hindsightNoteAdd, ["/test", "session-one00000000000000000000000000000", "Current session note.", { actualSessionId: "one" }]);
  assert.match(notifications[0].message, /saved/);
});

test("single-session hindsight selection sends only selected reviewed/redacted notes and excludes absent notes", async () => {
  const { default: conversationCatalog } = await loadConversationCatalogExtension();
  const commands = []; const tools = []; const handlers = new Map();
  const pi = {
    on: (event, handler) => handlers.set(event, handler), registerTool: (tool) => tools.push(tool),
    registerCommand: (name, command) => commands.push({ name, ...command }), getActiveTools: () => [], setActiveTools: () => {}, sendUserMessage: () => {},
  };
  globalThis.__hindsightEntries = { "/one": { events: [{ id: "event-one", summary: "Selected source", evidence: { reference: "one:event-0001" } }], edges: [] }, "/two": { events: [{ id: "event-two", summary: "Other source", evidence: { reference: "two:event-0001" } }], edges: [] } };
  const selectedRef = "session-one00000000000000000000000000000";
  const otherRef = "session-two00000000000000000000000000000";
  const selectedNote = { noteId: "note-0123456789abcdef0123456789abcdef", text: "Contact user@example.test after the handoff.", provenance: { source: "user-authored", confirmation: "user-confirmed", createdAt: "2026-09-01T12:00:00.000Z" } };
  const otherNote = { ...selectedNote, noteId: "note-fedcba9876543210fedcba9876543210", text: "OTHER-SESSION-NOTE" };
  globalThis.__hindsightNotesByReference = { [selectedRef]: { notes: [selectedNote] }, [otherRef]: { notes: [otherNote] } };
  conversationCatalog(pi);
  const hindsight = commands.find((command) => command.name === "hindsight-document");
  const chooseRedaction = async (title, options) => {
    if (title === "Select one conversation for hindsight") return options[1];
    if (title.includes("sensitive content detected")) return "Review findings";
    if (title.startsWith("Note finding")) return "Redact (recommended)";
    throw new Error(`unexpected picker: ${title}`);
  };
  await hindsight.handler("", { cwd: "/test", hasUI: true, isProjectTrusted: () => true, ui: { select: chooseRedaction, confirm: async () => true, notify: () => {} } });
  const reviewed = globalThis.__hindsightPromptArgs[1].hindsightNotes;
  assert.deepEqual(reviewed.map((entry) => entry.text), ["Contact [REDACTED: email address] after the handoff."]);
  assert.doesNotMatch(JSON.stringify(globalThis.__hindsightPromptArgs), /OTHER-SESSION-NOTE|user@example\.test/);
  await tools.find((tool) => tool.name === "hindsight_document_write").execute("draft", { claims: [], recommendations: [] });
  assert.deepEqual(globalThis.__hindsightDocumentArgs[4].map((entry) => entry.text), ["Contact [REDACTED: email address] after the handoff."]);
  handlers.get("agent_settled")();

  // Excluding the selected note (and a deleted/empty store) gives the model and
  // renderer no note payload at all, even though another session has one.
  globalThis.__hindsightNotesByReference[selectedRef] = { notes: [selectedNote] };
  const exclude = async (title, options) => title === "Select one conversation for hindsight" ? options[1]
    : title.includes("sensitive content detected") ? "Exclude this note" : (() => { throw new Error(`unexpected picker: ${title}`); })();
  await hindsight.handler("", { cwd: "/test", hasUI: true, isProjectTrusted: () => true, ui: { select: exclude, confirm: async () => true, notify: () => {} } });
  assert.deepEqual(globalThis.__hindsightPromptArgs[1].hindsightNotes, []);
  await tools.find((tool) => tool.name === "hindsight_document_write").execute("excluded", { claims: [], recommendations: [] });
  assert.deepEqual(globalThis.__hindsightDocumentArgs[4], []);
  handlers.get("agent_settled")();
  globalThis.__hindsightNotesByReference = undefined;
  globalThis.__hindsightEntries = undefined;
});

test("required Slack note redaction blocks Retain and never reaches prompt or context HTML", async () => {
  const { default: conversationCatalog } = await loadConversationCatalogExtension();
  const commands = []; const tools = []; const handlers = new Map(); const sent = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler), registerTool: (tool) => tools.push(tool),
    registerCommand: (name, command) => commands.push({ name, ...command }), getActiveTools: () => [], setActiveTools: () => {}, sendUserMessage: (message) => sent.push(message),
  };
  const selectedRef = "session-one00000000000000000000000000000";
  const slackToken = "xoxb-1234567890-AbCdEfGhIjKl";
  const slackNote = { noteId: "note-0123456789abcdef0123456789abcdef", text: `Do not retain ${slackToken}.`, provenance: { source: "user-authored", confirmation: "user-confirmed", createdAt: "2026-09-01T12:00:00.000Z" } };
  globalThis.__hindsightEntries = { "/one": { events: [{ id: "event-one", summary: "Selected source", evidence: { reference: "one:event-0001" } }], edges: [] } };
  globalThis.__hindsightNotesByReference = { [selectedRef]: { notes: [slackNote] } };
  conversationCatalog(pi);
  const hindsight = commands.find((command) => command.name === "hindsight-document");
  const notifications = [];
  const chooseRequiredRedaction = async (title, options) => title === "Select one conversation for hindsight" ? options[1]
    : title.includes("sensitive content detected") ? "Review findings"
      : title.startsWith("Note finding") ? "Redact (required)" : (() => { throw new Error(`unexpected picker: ${title}`); })();
  await hindsight.handler("", { cwd: "/test", hasUI: true, isProjectTrusted: () => true, ui: { select: chooseRequiredRedaction, confirm: async () => true, notify: (message, level) => notifications.push({ message, level }) } });
  assert.doesNotMatch(JSON.stringify(globalThis.__hindsightPromptArgs), new RegExp(slackToken));
  await tools.find((tool) => tool.name === "hindsight_document_write").execute("draft", { claims: [], recommendations: [] });
  assert.doesNotMatch(JSON.stringify(globalThis.__hindsightDocumentArgs), new RegExp(slackToken));
  handlers.get("agent_settled")();

  globalThis.__hindsightPromptArgs = undefined;
  globalThis.__hindsightDocumentArgs = undefined;
  const attemptRetain = async (title, options) => title === "Select one conversation for hindsight" ? options[1]
    : title.includes("sensitive content detected") ? "Review findings"
      : title.startsWith("Note finding") ? "Retain" : (() => { throw new Error(`unexpected picker: ${title}`); })();
  await hindsight.handler("", { cwd: "/test", hasUI: true, isProjectTrusted: () => true, ui: { select: attemptRetain, confirm: async () => true, notify: (message, level) => notifications.push({ message, level }) } });
  assert.equal(globalThis.__hindsightPromptArgs, undefined);
  assert.equal(globalThis.__hindsightDocumentArgs, undefined);
  assert.equal(sent.length, 1);
  assert.match(notifications.at(-1).message, /required sensitive finding/i);
  globalThis.__hindsightNotesByReference = undefined;
  globalThis.__hindsightEntries = undefined;
});

test("hindsight work command rejects noninteractive, untrusted, and missing-config requests before any work selection", async () => {
  const { default: conversationCatalog } = await loadConversationCatalogExtension();
  const commands = [];
  conversationCatalog({
    on: () => {}, registerTool: () => {}, registerCommand: (name, command) => commands.push({ name, ...command }),
    getActiveTools: () => [], setActiveTools: () => {}, sendUserMessage: () => {},
  });
  const hindsightWork = commands.find((command) => command.name === "hindsight-work");
  const notifications = [];
  const context = (hasUI, trusted) => ({
    cwd: "/test", hasUI, isProjectTrusted: () => trusted,
    ui: { notify: (message, level) => notifications.push({ message, level }), select: async () => { throw new Error("selection must not run"); } },
  });
  await hindsightWork.handler("report.dispositions.json", context(false, true));
  await hindsightWork.handler("report.dispositions.json", context(true, false));
  await hindsightWork.handler("report.dispositions.json", context(true, true));
  assert.deepEqual(notifications, [
    { message: "Hindsight work requires Pi's interactive UI.", level: "error" },
    { message: "Hindsight work requires a trusted project.", level: "error" },
    { message: "Hindsight work is unavailable: .pi/hindsight-linear.json was not found.", level: "error" },
  ]);
});

test("safe hindsight write preserves a prior disposition seed on failure and remains restricted until settlement", async () => {
  const { default: conversationCatalog } = await loadConversationCatalogExtension();
  const normalTools = ["read", "write", "edit", "bash", "hindsight_document_write"];
  let activeTools = normalTools;
  const toolChanges = [];
  const tools = [];
  const commands = [];
  const handlers = new Map();
  const selectionTitles = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerTool: (tool) => tools.push(tool),
    registerCommand: (name, command) => commands.push({ name, ...command }),
    getActiveTools: () => activeTools,
    setActiveTools: (nextTools) => {
      activeTools = nextTools;
      toolChanges.push(nextTools);
    },
    sendUserMessage: () => {},
  };
  globalThis.__hindsightWrites = [];
  globalThis.__hindsightRenames = [];
  globalThis.__hindsightFiles = new Map();
  globalThis.__hindsightWriteFailure = undefined;
  conversationCatalog(pi);
  const hindsight = commands.find((command) => command.name === "hindsight-document");

  await hindsight.handler("", {
    cwd: "/test",
    hasUI: true,
    ui: {
      select: async (title, options) => {
        selectionTitles.push(title);
        if (title !== "Select one conversation for hindsight") throw new Error(`Unexpected selection: ${title}`);
        assert.deepEqual(options.slice(0, 1), ["Cancel"]);
        assert.equal(options.length, 3);
        assert.match(options[1], /^1\. /);
        assert.match(options[2], /^2\. /);
        return options[1];
      },
      confirm: async () => true,
      notify: () => {},
    },
  });
  assert.deepEqual(selectionTitles, ["Select one conversation for hindsight"]);
  assert.deepEqual(activeTools, ["hindsight_document_write"]);

  const writer = tools.find((tool) => tool.name === "hindsight_document_write");
  const result = await writer.execute("call", { claims: [], recommendations: [] });
  assert.match(result.content[0].text, /Hindsight document written/);
  assert.match(result.content[0].text, /disposition seed written locally/);
  const dispositionPath = "/test/pi-hindsight-document.dispositions.json";
  assert.ok(globalThis.__hindsightFiles.has(dispositionPath));
  assert.ok(globalThis.__hindsightRenames.some((operation) => operation.to === dispositionPath));

  // A report write failure must leave a prior seed intact and remove only the
  // staged replacement file.
  globalThis.__hindsightFiles.set(dispositionPath, "prior seed");
  globalThis.__hindsightWriteFailure = (path) => path === "/test/pi-hindsight-document.html";
  const failedResult = await writer.execute("failed-call", { claims: [], recommendations: [] });
  assert.match(failedResult.content[0].text, /Unable to write hindsight document: simulated write failure/);
  assert.equal(globalThis.__hindsightFiles.get(dispositionPath), "prior seed");
  assert.equal([...globalThis.__hindsightFiles.keys()].filter((path) => path.endsWith(".tmp")).length, 0);
  globalThis.__hindsightWriteFailure = undefined;
  assert.deepEqual(activeTools, ["hindsight_document_write"]);

  handlers.get("agent_settled")();
  assert.deepEqual(activeTools, normalTools);
  assert.deepEqual(toolChanges, [["hindsight_document_write"], normalTools]);
});

test("opt-in claim-support pass switches from the safe writer to the safe validator", async () => {
  const { default: conversationCatalog } = await loadConversationCatalogExtension();
  const normalTools = ["read", "write", "edit", "bash", "hindsight_document_write", "hindsight_claim_support_validate"];
  let activeTools = normalTools;
  const tools = [];
  const commands = [];
  const handlers = new Map();
  const toolChanges = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerTool: (tool) => tools.push(tool),
    registerCommand: (name, command) => commands.push({ name, ...command }),
    getActiveTools: () => activeTools,
    setActiveTools: (nextTools) => { activeTools = nextTools; toolChanges.push(nextTools); },
    sendUserMessage: () => {},
  };
  globalThis.__hindsightWrites = [];
  globalThis.__hindsightRenames = [];
  globalThis.__hindsightFiles = new Map();
  globalThis.__hindsightWriteFailure = undefined;
  conversationCatalog(pi);
  const hindsight = commands.find((command) => command.name === "hindsight-document");
  await hindsight.handler("--validate-claim-support reviewed/report.html", {
    cwd: "/test", hasUI: true,
    ui: { select: async (_title, options) => options[1], confirm: async () => true, notify: () => {} },
  });
  const writer = tools.find((tool) => tool.name === "hindsight_document_write");
  const validator = tools.find((tool) => tool.name === "hindsight_claim_support_validate");
  assert.deepEqual(activeTools, ["hindsight_document_write"]);
  const draftResult = await writer.execute("draft", { claims: [], recommendations: [] });
  assert.match(draftResult.content[0].text, /Validate cited claim support/);
  assert.deepEqual(activeTools, ["hindsight_claim_support_validate"]);
  const validationResult = await validator.execute("validation", {
    source: "model-validation", userDisposition: "not-user-confirmed", assessments: [],
  });
  assert.match(validationResult.content[0].text, /with claim-support validation written/);
  assert.ok(globalThis.__hindsightFiles.has("/test/reviewed/report.dispositions.json"));
  handlers.get("agent_settled")();
  assert.deepEqual(activeTools, normalTools);
  assert.deepEqual(toolChanges, [["hindsight_document_write"], ["hindsight_claim_support_validate"], normalTools]);
});
