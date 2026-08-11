import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildClaimSupportValidationPrompt, buildHindsightDocument, buildSynthesisPrompt } from "../extensions/conversation-catalog/src/synthesis.mjs";
import { restrictToolsForHindsightSynthesis } from "../extensions/conversation-catalog/src/hindsight-tools.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function loadConversationCatalogExtension() {
  let extension = readFileSync(join(root, "extensions/conversation-catalog/src/index.ts"), "utf8");
  extension = extension.replace(/^import[^\n]+;\r?\n/gm, "");
  const stubs = `
const mkdir = async () => {};
const readFile = async () => { const error = new Error("not found"); error.code = "ENOENT"; throw error; };
const rm = async () => {};
const writeFile = async () => {};
const dirname = () => ".";
const extname = (path) => path.slice(path.lastIndexOf("."));
const resolve = (cwd, path) => cwd + "/" + path;
const SessionManager = {
  listAll: async () => [
    { id: "one", name: "First", cwd: "/test", path: "/one", modified: "", messageCount: 1 },
    { id: "two", name: "Second", cwd: "/test", path: "/two", modified: "", messageCount: 1 },
  ],
  open: async () => ({ getEntries: () => [] }),
};
const Type = { Object: (value) => value, Optional: (value) => value, String: () => ({}), Integer: () => ({}), Array: () => ({}), Union: () => ({}), Literal: () => ({}) };
const generateCatalogHtml = () => "";
const groupSessions = (value) => value;
const generateConversationFlowHtml = () => "";
const projectConversation = () => ({ events: [], edges: [] });
const attachEvidenceReferences = (_reference, value) => value;
const createEvidenceManifest = () => ({ schemaVersion: 1, citations: [] });
const generateRelationshipMapHtml = () => "";
const projectRelationshipMap = (value) => value;
const buildClaimSupportValidationPrompt = () => "Validate cited claim support";
const buildHindsightDocument = () => "<html></html>";
const buildSynthesisPrompt = () => "Synthesize";
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
const findSensitiveContent = () => [];
const generateExcludedConversationHtml = () => "";
const pseudonymizeSession = (session) => session.id;
const redactProjection = (value) => value;
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
  assert.match(html, /<table>/);
  assert.match(html, /<caption>Structured recommendations proposed by the model; none are user-confirmed.<\/caption>/);
  assert.match(html, /scope="col">Measurable acceptance criteria/);
  assert.match(html, /proposed · model-suggestion/);
  assert.match(html, /Not user-confirmed/);
  assert.match(html, /href="#citation-1"/);
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
    assessments: [{ claimNumber: 1, support: "supported", evidenceReferences: ["one:event-0001"] }],
  };
  const html = buildHindsightDocument(sources, model, validation);
  assert.match(html, /Claim-support validation/);
  assert.match(html, /Model-generated validation only; it is not a user-confirmed disposition/);
  assert.match(html, /Claim 1:<\/strong> <span class="provenance">supported/);
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
    assessments: [{ claimNumber: 1, support: "unverifiable", evidenceReferences: ["one:event-0002"] }],
  };
  assert.throws(() => buildHindsightDocument(sources, model, validation), /outside the selected redacted source bundle/);
  assert.match(buildClaimSupportValidationPrompt(sources, model), /Customer|First redacted excerpt/);
  const prompt = buildClaimSupportValidationPrompt(sources, model);
  assert.match(prompt, /one:event-0001/);
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

test("successful safe hindsight write remains restricted until agent settlement restores normal tools", async () => {
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
  handlers.get("agent_settled")();
  assert.deepEqual(activeTools, normalTools);
  assert.deepEqual(toolChanges, [["hindsight_document_write"], ["hindsight_claim_support_validate"], normalTools]);
});
