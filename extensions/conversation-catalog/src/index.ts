import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browserPickerLabel, formatLocalConversationReader, resolveSessionReference } from "./browser.mjs";
import { projectConversation } from "./conversation.mjs";
import { attachEvidenceReferences } from "./evidence.mjs";
import { restrictToolsForHindsightSynthesis } from "./hindsight-tools.mjs";
import { buildHindsightDocument, preflightSynthesisPrompt } from "./synthesis.mjs";
import { compileSensitivePatterns, findSensitiveContent, pseudonymizeSession, redactProjection } from "./redaction.mjs";
import { defaultHindsightReportDirectory, resolveExplicitHindsightOutputPath, writeDefaultHindsightReport, writeHindsightReport } from "./hindsight-output.mjs";

function hindsightArguments(args: string) {
  const values = args.trim().split(/\s+/).filter(Boolean);
  if (values.some((value) => value.startsWith("--"))) throw new Error("Unsupported hindsight option. Usage: /hindsight-document [session-identifier] [output-path]");
  if (values.length > 2) throw new Error("Usage: /hindsight-document [session-identifier] [output-path]");
  if (values.length === 0) return {};
  const [first, second] = values;
  if (first.startsWith("session-")) {
    if (!/^session-[a-z0-9]+$/.test(first)) throw new Error("The selected conversation identifier is invalid.");
    return second ? { reference: first, outputPath: second } : { reference: first };
  }
  if (second) throw new Error("A session identifier must come before an output path.");
  return { outputPath: first };
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

/** Read-only catalog and redaction-reviewed hindsight reports of saved Pi conversations. */
export default function conversationCatalog(pi: ExtensionAPI) {
  let pendingHindsight: { sources: any[]; outputPath?: string; defaultDirectory?: string; reference: string; restoreTools: () => void } | undefined;
  pi.on("agent_settled", () => { const pending = pendingHindsight; if (pending) { pendingHindsight = undefined; pending.restoreTools(); } });
  pi.registerTool({
    name: "hindsight_document_write", label: "Write safe hindsight document",
    description: "Writes structured claims, optional story steps, and Fix/Harden proposals through the safe cited HTML contract.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      claims: Type.Array(Type.Object({ statement: Type.String({ minLength: 1, maxLength: 2000 }), classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { maxItems: 80 }),
      storySteps: Type.Optional(Type.Array(Type.Object({ title: Type.String({ minLength: 1, maxLength: 160 }), body: Type.String({ minLength: 1, maxLength: 2000 }), classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }), { maxItems: 30 })),
      subagentEfficiency: Type.Optional(Type.Object({
        delegationTiming: Type.Array(Type.Object({ statement: Type.String({ minLength: 1, maxLength: 2000 }), findingKind: Type.Union([Type.Literal("strength"), Type.Literal("risk")]), classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { maxItems: 20 }),
        deliveryQuality: Type.Array(Type.Object({ statement: Type.String({ minLength: 1, maxLength: 2000 }), findingKind: Type.Union([Type.Literal("strength"), Type.Literal("risk")]), classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { maxItems: 20 }),
      }, { additionalProperties: false })),
      recommendations: Type.Array(Type.Object({ recommendation: Type.String({ minLength: 1, maxLength: 1000 }), actionType: Type.Union([Type.Literal("fix"), Type.Literal("harden")]), priority: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]), expectedImpact: Type.String({ minLength: 1, maxLength: 500 }), suggestedOwner: Type.String({ minLength: 1, maxLength: 200 }), dependencies: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }), acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 20 }), status: Type.Literal("proposed"), source: Type.Literal("model-suggestion"), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { maxItems: 40 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      if (!pendingHindsight) return { content: [{ type: "text", text: "No hindsight document draft is awaiting generation." }] };
      try {
        const html = buildHindsightDocument(pendingHindsight.sources, params);
        const outputPath = pendingHindsight.outputPath
          ? (await writeHindsightReport(pendingHindsight.outputPath, html), pendingHindsight.outputPath)
          : await writeDefaultHindsightReport({ directory: pendingHindsight.defaultDirectory!, reference: pendingHindsight.reference, html });
        return { content: [{ type: "text", text: `Hindsight document written to ${outputPath}.` }] };
      }
      catch (error) { return { content: [{ type: "text", text: error instanceof Error ? `Unable to write hindsight document: ${error.message}` : "Unable to write hindsight document." }] }; }
    },
  });
  async function selectSession(ctx: any, sessions: any[], title: string) {
    const options = sessions.map(browserPickerLabel);
    const choice = await ctx.ui.select(title, ["Cancel", ...options]);
    if (!choice || choice === "Cancel") throw new Error("Conversation selection canceled.");
    const index = options.indexOf(choice);
    if (index < 0) throw new Error("Select exactly one saved conversation.");
    return sessions[index];
  }

  async function beginHindsight(args: string, ctx: any) {
    if (!ctx.hasUI) throw new Error("Hindsight generation requires Pi's interactive UI.");
    const requested = hindsightArguments(args); const sessions = await SessionManager.listAll();
    if (!sessions.length) throw new Error("No saved conversations are available for hindsight generation.");
    const session = requested.reference
      ? resolveSessionReference(sessions, requested.reference)
      : await selectSession(ctx, sessions, "Select one conversation for hindsight");
    const projection = projectConversation((await SessionManager.open(session.path)).getEntries());
    const findings = findSensitiveContent(projection, await configuredPatterns(ctx.cwd)); const review = await reviewRedactionChoices(ctx, findings); const reference = pseudonymizeSession(session);
    const sources = review.excluded ? [{ reference, excluded: true }] : [{ reference, ...attachEvidenceReferences(reference, redactProjection(projection, findings, review.decisions)) }];
    const outputPath = requested.outputPath ? resolveExplicitHindsightOutputPath(requested.outputPath, ctx.cwd) : undefined;
    const defaultDirectory = outputPath ? undefined : defaultHindsightReportDirectory({ home: homedir() });
    const prompt = preflightSynthesisPrompt(sources, {}, ctx.getContextUsage?.()); const restoreTools = restrictToolsForHindsightSynthesis(pi);
    try { pendingHindsight = { sources, outputPath, defaultDirectory, reference, restoreTools }; pi.sendUserMessage(prompt); } catch (error) { pendingHindsight = undefined; restoreTools(); throw error; }
    const destination = outputPath || defaultDirectory;
    ctx.ui.notify(`Redacted evidence submitted to the active model. It can only generate the hindsight document through the safe report contract at ${destination}.`, "info");
  }

  pi.registerCommand("conversation-catalog", { description: "Browse and read saved Pi conversations locally", async handler(_args, ctx) {
    try {
      if (!ctx.hasUI) throw new Error("Conversation browsing requires Pi's interactive UI.");
      const sessions = await SessionManager.listAll();
      if (!sessions.length) throw new Error("No saved conversations are available.");
      while (true) {
        const session = await selectSession(ctx, sessions, "Browse saved conversations");
        const reference = pseudonymizeSession(session);
        const entries = (await SessionManager.open(session.path)).getEntries();
        await ctx.ui.editor("Saved conversation (local-only; edits are discarded)", formatLocalConversationReader(session, entries));
        const action = await ctx.ui.select("Selected conversation", ["Prepare scoped hindsight command", "Back to saved conversations", "Close browser"]);
        if (action === "Prepare scoped hindsight command") {
          const command = `/hindsight-document ${reference}`;
          ctx.ui.setEditorText(command);
          ctx.ui.notify(`Ready: ${command}`, "info");
          return;
        }
        if (action === "Back to saved conversations") continue;
        return;
      }
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to browse saved conversations.", "error"); }
  }});
  pi.registerCommand("hindsight-document", { description: "Write a cited hindsight document for one selected conversation", async handler(args, ctx) {
    try { await beginHindsight(args, ctx); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to generate hindsight document.", "error"); }
  }});
}

export { hindsightArguments };
