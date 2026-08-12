import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { generateCatalogHtml, groupSessions } from "./catalog.mjs";
import { attachEvidenceReferences, createEvidenceManifest } from "./evidence.mjs";
import { generateConversationFlowHtml, projectConversation } from "./flow.mjs";
import { generateRelationshipMapHtml, projectRelationshipMap, writeRelationshipMapExport } from "./map.mjs";
import { buildHindsightDocument, preflightSynthesisPrompt } from "./synthesis.mjs";
import { restrictToolsForHindsightSynthesis } from "./hindsight-tools.mjs";
import { compileSensitivePatterns, createRedactionMetadata, findSensitiveContent, generateExcludedConversationHtml, pseudonymizeSession, redactProjection } from "./redaction.mjs";

const DEFAULT_FILENAME = "pi-conversation-catalog.html";

function resolveOutputPath(args: string, cwd: string, defaultFilename = DEFAULT_FILENAME, label = "catalog") {
  const requestedPath = args.trim() || defaultFilename;
  if (requestedPath.includes("\0")) throw new Error("The output path is invalid.");
  const outputPath = resolve(cwd, requestedPath);
  if (extname(outputPath).toLowerCase() !== ".html") throw new Error(`The ${label} output path must end in .html.`);
  return outputPath;
}

function flowArguments(args: string) {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return match ? { sessionId: match[1], outputPath: match[2] || "" } : undefined;
}

function hindsightArguments(args: string) {
  const outputPath = args.trim();
  if (/(?:^|\s)--\S+/.test(outputPath)) throw new Error("Unsupported hindsight option. Usage: /hindsight-document [output-path]");
  return { outputPath };
}

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "session";
}
function metadataPath(outputPath: string) { return outputPath.replace(/\.html$/i, ".redaction.json"); }

async function writeHindsightReport(outputPath: string, html: string) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, html, "utf8");
  try { await rename(temporaryPath, outputPath); }
  catch (error) { await rm(temporaryPath, { force: true }).catch(() => undefined); throw error; }
}

function pickerDescription(value: unknown) {
  const words = typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean) : [];
  return words.length > 10 ? `${words.slice(0, 10).join(" ")}…` : words.join(" ");
}
function pickerLabel(session: any) {
  const description = pickerDescription(session.name || session.firstMessage) || "Untitled session";
  return `${session.cwd || "Unknown location"} — ${description} (${typeof session.id === "string" ? session.id.slice(0, 8) : "unknown"})`;
}
async function configuredPatterns(cwd: string) {
  try {
    const parsed = JSON.parse(await readFile(resolve(cwd, ".pi", "conversation-redaction-patterns.json"), "utf8"));
    return compileSensitivePatterns(parsed?.patterns);
  } catch (error: any) {
    if (error?.code === "ENOENT") return compileSensitivePatterns();
    throw new Error("Unable to read .pi/conversation-redaction-patterns.json.");
  }
}
async function reviewRedactionChoices(ctx: any, findings: any[]) {
  if (!ctx.hasUI) throw new Error("Conversation export requires an interactive Pi UI so redaction choices can be reviewed.");
  if (findings.length === 0) {
    if (!await ctx.ui.confirm("No sensitive content detected", "Export this conversation without redactions?")) throw new Error("Conversation export canceled.");
    return { excluded: false, decisions: {} };
  }
  const begin = await ctx.ui.select("Conversation redaction preview", ["Review findings", "Exclude this conversation"]);
  if (!begin) throw new Error("Conversation export canceled.");
  if (begin === "Exclude this conversation") return { excluded: true, decisions: {} };
  const decisions: Record<string, string> = {};
  for (const [index, finding] of findings.entries()) {
    const choice = await ctx.ui.select(`Finding ${index + 1}/${findings.length}: ${finding.pattern} — ${finding.preview}`, finding.requiredRedaction ? ["Redact (required)", "Exclude this conversation"] : ["Redact (recommended)", "Retain", "Exclude this conversation"]);
    if (!choice) throw new Error("Conversation export canceled.");
    if (choice === "Exclude this conversation") return { excluded: true, decisions };
    if (finding.requiredRedaction && choice !== "Redact (required)") throw new Error("Required sensitive finding must be redacted or the conversation excluded.");
    decisions[finding.id] = choice === "Retain" ? "retain" : "redact";
  }
  return { excluded: false, decisions };
}

/** Read-only catalog and redaction-reviewed views of saved Pi conversations. */
export default function conversationCatalog(pi: ExtensionAPI) {
  let pendingHindsight: { sources: any[]; outputPath: string; restoreTools: () => void } | undefined;
  pi.on("agent_settled", () => { const pending = pendingHindsight; if (pending) { pendingHindsight = undefined; pending.restoreTools(); } });

  pi.registerTool({
    name: "hindsight_document_write", label: "Write safe hindsight document",
    description: "Writes structured claims, optional story steps, and recommendations through the safe cited HTML contract.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      claims: Type.Array(Type.Object({ statement: Type.String({ minLength: 1, maxLength: 2000 }), classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { maxItems: 80 }),
      storySteps: Type.Optional(Type.Array(Type.Object({ title: Type.String({ minLength: 1, maxLength: 160 }), body: Type.String({ minLength: 1, maxLength: 2000 }), classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }), { maxItems: 30 })),
      recommendations: Type.Array(Type.Object({ recommendation: Type.String({ minLength: 1, maxLength: 1000 }), priority: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]), expectedImpact: Type.String({ minLength: 1, maxLength: 500 }), suggestedOwner: Type.String({ minLength: 1, maxLength: 200 }), dependencies: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }), acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 20 }), status: Type.Literal("proposed"), source: Type.Literal("model-suggestion"), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { maxItems: 40 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      if (!pendingHindsight) return { content: [{ type: "text", text: "No hindsight document draft is awaiting generation." }] };
      try {
        await writeHindsightReport(pendingHindsight.outputPath, buildHindsightDocument(pendingHindsight.sources, params));
        return { content: [{ type: "text", text: `Hindsight document written to ${pendingHindsight.outputPath}.` }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? `Unable to write hindsight document: ${error.message}` : "Unable to write hindsight document." }] }; }
    },
  });

  pi.registerCommand("conversation-catalog", { description: "Write a standalone HTML catalog of saved Pi sessions", async handler(args, ctx) {
    try {
      const outputPath = resolveOutputPath(args, ctx.cwd);
      const metadata = (await SessionManager.listAll()).map((session) => ({ id: session.id, name: session.name, firstMessage: session.firstMessage, cwd: session.cwd, modified: session.modified, messageCount: session.messageCount }));
      await mkdir(dirname(outputPath), { recursive: true }); await writeFile(outputPath, generateCatalogHtml(groupSessions(metadata)), "utf8");
      ctx.ui.notify(`Conversation catalog written to ${outputPath}. Open this .html file directly in your browser.`, "info");
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to write the conversation catalog.", "error"); }
  }});

  pi.registerCommand("conversation-flow", { description: "Review redactions, then write a standalone HTML flow view for one saved Pi session", async handler(args, ctx) {
    const requested = flowArguments(args); if (!requested) { ctx.ui.notify("Usage: /conversation-flow <session-id> [output-path]", "error"); return; }
    try {
      const sessions = await SessionManager.listAll(); const exact = sessions.filter((session) => session.id === requested.sessionId); const candidates = exact.length ? exact : sessions.filter((session) => session.id.startsWith(requested.sessionId));
      if (candidates.length !== 1) throw new Error(candidates.length ? `Session ID prefix “${requested.sessionId}” is ambiguous; provide a longer ID.` : `No saved session matches “${requested.sessionId}”.`);
      const selected = candidates[0]; const outputPath = resolveOutputPath(requested.outputPath, ctx.cwd, `pi-conversation-flow-${safeFilename(pseudonymizeSession(selected))}.html`, "conversation flow");
      const projection = projectConversation((await SessionManager.open(selected.path)).getEntries()); const findings = findSensitiveContent(projection, await configuredPatterns(ctx.cwd)); const review = await reviewRedactionChoices(ctx, findings); const exportSession = { id: pseudonymizeSession(selected), name: "Selected conversation" };
      const cited = review.excluded ? undefined : attachEvidenceReferences(exportSession.id, redactProjection(projection, findings, review.decisions));
      const metadata = { ...createRedactionMetadata(exportSession.id, findings, review.decisions, review.excluded), evidence: cited ? createEvidenceManifest(cited) : { schemaVersion: 1, citations: [] } }; const decisionPath = metadataPath(outputPath);
      await mkdir(dirname(outputPath), { recursive: true }); await writeFile(decisionPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      try { await writeFile(outputPath, review.excluded ? generateExcludedConversationHtml(exportSession) : generateConversationFlowHtml(exportSession, cited), "utf8"); } catch (error) { await rm(decisionPath, { force: true }).catch(() => undefined); throw error; }
      ctx.ui.notify(review.excluded ? `Conversation excluded. Decision metadata written to ${decisionPath}.` : `Conversation flow written to ${outputPath}. Redaction decisions are recorded in ${decisionPath}.`, "info");
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to write the conversation flow.", "error"); }
  }});

  pi.registerCommand("conversation-map", { description: "Review redactions, then write an interactive relationship map for one saved session", async handler(args, ctx) {
    const requested = flowArguments(args); if (!requested) { ctx.ui.notify("Usage: /conversation-map <session-id> [output-path]", "error"); return; }
    try {
      const candidates = (await SessionManager.listAll()).filter((session) => session.id === requested.sessionId || session.id.startsWith(requested.sessionId)); if (candidates.length !== 1) throw new Error(candidates.length ? "Session ID prefix is ambiguous." : "No saved session matches that ID.");
      const selected = candidates[0]; const outputPath = resolveOutputPath(requested.outputPath, ctx.cwd, `pi-conversation-map-${safeFilename(pseudonymizeSession(selected))}.html`, "conversation map"); const projection = projectConversation((await SessionManager.open(selected.path)).getEntries()); const findings = findSensitiveContent(projection, await configuredPatterns(ctx.cwd)); const review = await reviewRedactionChoices(ctx, findings);
      if (review.excluded) throw new Error("Conversation excluded; no map was created."); const reference = pseudonymizeSession(selected); const cited = attachEvidenceReferences(reference, redactProjection(projection, findings, review.decisions)); const graph = projectRelationshipMap(cited);
      const paths = await writeRelationshipMapExport(outputPath, generateRelationshipMapHtml({ id: reference }, graph), { ...createRedactionMetadata(reference, findings, review.decisions, false), evidence: createEvidenceManifest(cited), map: { schemaVersion: 1, eventCount: graph.nodes.length, edgeCount: graph.edges.length } });
      ctx.ui.notify(`Conversation map written to ${paths.outputPath}. Redaction and evidence decisions are recorded in ${paths.metadataPath}.`, "info");
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to write conversation map.", "error"); }
  }});

  pi.registerCommand("hindsight-document", { description: "Interactively select one conversation and write a cited hindsight document", async handler(args, ctx) {
    try {
      if (!ctx.hasUI) throw new Error("Hindsight generation requires Pi's interactive UI."); const requested = hindsightArguments(args); const sessions = await SessionManager.listAll(); if (!sessions.length) throw new Error("No saved conversations are available for hindsight generation.");
      const options = sessions.map((session, index) => `${index + 1}. ${pickerLabel(session)}`); const choice = await ctx.ui.select("Select one conversation for hindsight", ["Cancel", ...options]); if (!choice || choice === "Cancel") throw new Error("Hindsight generation canceled."); const index = options.indexOf(choice); if (index < 0) throw new Error("Select exactly one conversation for hindsight generation."); const session = sessions[index];
      const projection = projectConversation((await SessionManager.open(session.path)).getEntries()); const findings = findSensitiveContent(projection, await configuredPatterns(ctx.cwd)); const review = await reviewRedactionChoices(ctx, findings); const reference = pseudonymizeSession(session); const sources = review.excluded ? [{ reference, excluded: true }] : [{ reference, ...attachEvidenceReferences(reference, redactProjection(projection, findings, review.decisions)) }];
      const outputPath = resolveOutputPath(requested.outputPath, ctx.cwd, "pi-hindsight-document.html", "hindsight document"); const prompt = preflightSynthesisPrompt(sources, {}, ctx.getContextUsage?.()); const restoreTools = restrictToolsForHindsightSynthesis(pi); try { pendingHindsight = { sources, outputPath, restoreTools }; pi.sendUserMessage(prompt); } catch (error) { pendingHindsight = undefined; restoreTools(); throw error; }
      ctx.ui.notify(`Redacted evidence submitted to the active model. It can only generate the hindsight document through the safe report contract at ${outputPath}.`, "info");
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to generate hindsight document.", "error"); }
  }});
}
