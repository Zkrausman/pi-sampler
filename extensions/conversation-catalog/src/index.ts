import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { generateCatalogHtml, groupSessions } from "./catalog.mjs";
import { generateConversationFlowHtml, projectConversation } from "./flow.mjs";
import { attachEvidenceReferences, createEvidenceManifest } from "./evidence.mjs";
import { generateRelationshipMapHtml, projectRelationshipMap } from "./map.mjs";
import { buildHindsightDocument, buildSynthesisPrompt } from "./synthesis.mjs";
import { restrictToolsForHindsightSynthesis } from "./hindsight-tools.mjs";
import { compileSensitivePatterns, createRedactionMetadata, findSensitiveContent, generateExcludedConversationHtml, pseudonymizeSession, redactProjection } from "./redaction.mjs";

const DEFAULT_FILENAME = "pi-conversation-catalog.html";

function resolveOutputPath(args: string, cwd: string, defaultFilename = DEFAULT_FILENAME, label = "catalog"): string {
  const requestedPath = args.trim() || defaultFilename;
  if (requestedPath.includes("\0")) throw new Error("The output path is invalid.");

  const outputPath = resolve(cwd, requestedPath);
  if (extname(outputPath).toLowerCase() !== ".html") {
    throw new Error(`The ${label} output path must end in .html.`);
  }
  return outputPath;
}

function flowArguments(args: string) {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return match ? { sessionId: match[1], outputPath: match[2] || "" } : undefined;
}

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "session";
}

function metadataPath(outputPath: string) {
  return outputPath.replace(/\.html$/i, ".redaction.json");
}

function pickerDescription(value: unknown) {
  const words = typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean) : [];
  return words.length > 10 ? `${words.slice(0, 10).join(" ")}…` : words.join(" ");
}

function pickerLabel(session: any) {
  const description = pickerDescription(session.name || session.firstMessage) || "Untitled session";
  const id = typeof session.id === "string" ? session.id.slice(0, 8) : "unknown";
  return `${session.cwd || "Unknown location"} — ${description} (${id})`;
}

async function configuredPatterns(cwd: string) {
  try {
    const configPath = resolve(cwd, ".pi", "conversation-redaction-patterns.json");
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    return compileSensitivePatterns(parsed?.patterns);
  } catch (error: any) {
    if (error?.code === "ENOENT") return compileSensitivePatterns();
    throw new Error("Unable to read .pi/conversation-redaction-patterns.json.");
  }
}

async function reviewRedactionChoices(ctx: any, findings: any[]) {
  if (!ctx.hasUI) throw new Error("Conversation export requires an interactive Pi UI so redaction choices can be reviewed.");
  if (findings.length === 0) {
    const approved = await ctx.ui.confirm("No sensitive content detected", "Export this conversation flow without redactions?");
    if (!approved) throw new Error("Conversation export canceled.");
    return { excluded: false, decisions: {} };
  }

  const begin = await ctx.ui.select("Conversation redaction preview", ["Review findings", "Exclude this conversation"]);
  if (!begin) throw new Error("Conversation export canceled.");
  if (begin === "Exclude this conversation") return { excluded: true, decisions: {} };

  const decisions: Record<string, string> = {};
  for (const [index, finding] of findings.entries()) {
    const choice = await ctx.ui.select(
      `Finding ${index + 1}/${findings.length}: ${finding.pattern} — ${finding.preview}`,
      ["Redact (recommended)", "Retain", "Exclude this conversation"],
    );
    if (!choice) throw new Error("Conversation export canceled.");
    if (choice === "Exclude this conversation") return { excluded: true, decisions };
    decisions[finding.id] = choice === "Retain" ? "retain" : "redact";
  }
  return { excluded: false, decisions };
}

/** A read-only catalog of Pi session metadata and an opt-in historical flow viewer. */
export default function conversationCatalog(pi: ExtensionAPI) {
  let pendingHindsight: { sources: any[]; outputPath: string; restoreTools: () => void } | undefined;

  // Keep every direct write-capable session tool disabled until the model run
  // settles, including any follow-up turn after the safe tool returns.
  pi.on("agent_settled", () => {
    const pending = pendingHindsight;
    if (!pending) return;
    pendingHindsight = undefined;
    pending.restoreTools();
  });

  pi.registerTool({
    name: "hindsight_document_write",
    label: "Write safe hindsight document",
    description: "Writes the requested hindsight report through its safe HTML citation contract. Use this instead of writing hindsight HTML directly.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ maxLength: 160 })),
      claims: Type.Array(Type.Object({
        statement: Type.String({ maxLength: 2000 }),
        classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]),
        evidenceReferences: Type.Array(Type.String({ maxLength: 100 }), { minItems: 1, maxItems: 20 }),
      }), { maxItems: 80 }),
    }),
    async execute(_toolCallId, params) {
      if (!pendingHindsight) {
        return { content: [{ type: "text", text: "No hindsight document is awaiting generation." }] };
      }
      try {
        const html = buildHindsightDocument(pendingHindsight.sources, params);
        await mkdir(dirname(pendingHindsight.outputPath), { recursive: true });
        await writeFile(pendingHindsight.outputPath, html, "utf8");
        const outputPath = pendingHindsight.outputPath;
        pendingHindsight = undefined;
        return { content: [{ type: "text", text: `Hindsight document written to ${outputPath}.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? `Unable to write hindsight document: ${error.message}` : "Unable to write hindsight document." }] };
      }
    },
  });

  pi.registerCommand("conversation-catalog", {
    description: "Write a standalone HTML catalog of saved Pi sessions",
    async handler(args, ctx) {
      let outputPath: string;
      try {
        outputPath = resolveOutputPath(args, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "The output path is invalid.", "error");
        return;
      }

      try {
        // Deliberately retain only the catalog allowlist; transcript text never reaches the renderer or output.
        const metadata = (await SessionManager.listAll()).map((session) => ({
          id: session.id,
          name: session.name,
          firstMessage: session.firstMessage,
          cwd: session.cwd,
          modified: session.modified,
          messageCount: session.messageCount,
        }));
        const html = generateCatalogHtml(groupSessions(metadata));

        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, html, "utf8");
        ctx.ui.notify(`Conversation catalog written to ${outputPath}. Open this .html file directly in your browser.`, "info");
      } catch {
        ctx.ui.notify("Unable to write the conversation catalog.", "error");
      }
    },
  });

  pi.registerCommand("conversation-flow", {
    description: "Review redactions, then write a standalone HTML flow view for one saved Pi session",
    async handler(args, ctx) {
      const requested = flowArguments(args);
      if (!requested) {
        ctx.ui.notify("Usage: /conversation-flow <session-id> [output-path]", "error");
        return;
      }

      try {
        // listAll selects a historical file; Pi itself parses it through open(), never this extension.
        const sessions = await SessionManager.listAll();
        const exact = sessions.filter((session) => session.id === requested.sessionId);
        const candidates = exact.length > 0 ? exact : sessions.filter((session) => session.id.startsWith(requested.sessionId));
        if (candidates.length === 0) {
          ctx.ui.notify(`No saved session matches “${requested.sessionId}”.`, "error");
          return;
        }
        if (candidates.length > 1) {
          ctx.ui.notify(`Session ID prefix “${requested.sessionId}” is ambiguous; provide a longer ID.`, "error");
          return;
        }

        const selected = candidates[0];
        const outputPath = resolveOutputPath(
          requested.outputPath,
          ctx.cwd,
          `pi-conversation-flow-${safeFilename(pseudonymizeSession(selected))}.html`,
          "conversation flow",
        );
        const manager = await SessionManager.open(selected.path);
        const projection = projectConversation(manager.getEntries());
        const findings = findSensitiveContent(projection, await configuredPatterns(ctx.cwd));
        const review = await reviewRedactionChoices(ctx, findings);
        const exportSession = { id: pseudonymizeSession(selected), name: "Selected conversation" };
        const citedProjection = review.excluded
          ? undefined
          : attachEvidenceReferences(exportSession.id, redactProjection(projection, findings, review.decisions));
        const metadata = {
          ...createRedactionMetadata(exportSession.id, findings, review.decisions, review.excluded),
          evidence: citedProjection ? createEvidenceManifest(citedProjection) : { schemaVersion: 1, citations: [] },
        };
        const html = review.excluded
          ? generateExcludedConversationHtml(exportSession)
          : generateConversationFlowHtml(exportSession, citedProjection);
        const decisionPath = metadataPath(outputPath);
        await mkdir(dirname(outputPath), { recursive: true });
        // A metadata write must succeed before content is created; remove it if the
        // content write fails so callers never receive an orphaned decision record.
        await writeFile(decisionPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        try {
          await writeFile(outputPath, html, "utf8");
        } catch (error) {
          await rm(decisionPath, { force: true }).catch(() => undefined);
          throw error;
        }
        ctx.ui.notify(
          review.excluded
            ? `Conversation excluded. Decision metadata written to ${metadataPath(outputPath)}.`
            : `Conversation flow written to ${outputPath}. Redaction decisions are recorded in ${metadataPath(outputPath)}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Unable to write the conversation flow.", "error");
      }
    },
  });

  pi.registerCommand("hindsight-document", {
    description: "Interactively select conversations and write a cited hindsight document",
    async handler(args, ctx) {
      try {
        if (!ctx.hasUI) throw new Error("Hindsight generation requires Pi's interactive UI.");
        const sessions = await SessionManager.listAll();
        const selected: any[] = [];
        while (true) {
          const sessionOptions = sessions.map((session) => `${selected.some((item) => item.id === session.id) ? "✓ " : ""}${pickerLabel(session)}`);
          // Keep actions visible in a small terminal even when many sessions exist.
          const options = ["Generate document", "Remove selected conversation", "Cancel", ...sessionOptions];
          const choice = await ctx.ui.select(`Hindsight selection (${selected.length} selected)`, options);
          if (!choice || choice === "Cancel") throw new Error("Hindsight generation canceled.");
          if (choice === "Generate document") break;
          if (choice === "Remove selected conversation") {
            const remove = await ctx.ui.select("Remove conversation", selected.map((session) => session.name || session.id));
            const index = selected.findIndex((session) => (session.name || session.id) === remove);
            if (index >= 0) selected.splice(index, 1);
            continue;
          }
          const session = sessions[sessionOptions.indexOf(choice)];
          if (session && !selected.some((item) => item.id === session.id)) selected.push(session);
        }
        if (selected.length < 2) throw new Error("Select at least two conversations before generation.");
        const patterns = await configuredPatterns(ctx.cwd);
        const sources = [];
        for (const session of selected) {
          const projection = projectConversation((await SessionManager.open(session.path)).getEntries());
          const findings = findSensitiveContent(projection, patterns);
          const review = await reviewRedactionChoices(ctx, findings);
          const reference = pseudonymizeSession(session);
          if (review.excluded) {
            // Keep a local pseudonym so the generated report can link to an explicit
            // redaction-review fallback without retaining any conversation content.
            sources.push({ reference, excluded: true });
            continue;
          }
          const cited = attachEvidenceReferences(reference, redactProjection(projection, findings, review.decisions));
          sources.push({ reference, events: cited.events, edges: cited.edges });
        }
        const outputPath = resolveOutputPath(args, ctx.cwd, "pi-hindsight-document.html", "hindsight document");
        const restoreTools = restrictToolsForHindsightSynthesis(pi);
        try {
          pendingHindsight = { sources, outputPath, restoreTools };
          pi.sendUserMessage(buildSynthesisPrompt(sources));
        } catch (error) {
          pendingHindsight = undefined;
          restoreTools();
          throw error;
        }
        ctx.ui.notify(`Redacted evidence submitted to the active model. It can only generate the hindsight document through the safe report contract at ${outputPath}.`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to generate hindsight document.", "error"); }
    },
  });

  pi.registerCommand("conversation-map", {
    description: "Review redactions, then write an interactive relationship map for one saved session",
    async handler(args, ctx) {
      const requested = flowArguments(args);
      if (!requested) { ctx.ui.notify("Usage: /conversation-map <session-id> [output-path]", "error"); return; }
      try {
        const sessions = await SessionManager.listAll();
        const candidates = sessions.filter((s) => s.id === requested.sessionId || s.id.startsWith(requested.sessionId));
        if (candidates.length !== 1) throw new Error(candidates.length ? "Session ID prefix is ambiguous." : "No saved session matches that ID.");
        const selected = candidates[0];
        const outputPath = resolveOutputPath(requested.outputPath, ctx.cwd, `pi-conversation-map-${safeFilename(pseudonymizeSession(selected))}.html`, "conversation map");
        const projection = projectConversation((await SessionManager.open(selected.path)).getEntries());
        const findings = findSensitiveContent(projection, await configuredPatterns(ctx.cwd));
        const review = await reviewRedactionChoices(ctx, findings);
        if (review.excluded) throw new Error("Conversation excluded; no map was created.");
        const cited = attachEvidenceReferences(pseudonymizeSession(selected), redactProjection(projection, findings, review.decisions));
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, generateRelationshipMapHtml({ id: pseudonymizeSession(selected) }, projectRelationshipMap(cited)), "utf8");
        ctx.ui.notify(`Conversation map written to ${outputPath}.`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to write conversation map.", "error"); }
    },
  });
}
