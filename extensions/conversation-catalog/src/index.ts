import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateCatalogHtml, groupSessions } from "./catalog.mjs";
import { generateConversationFlowHtml, projectConversation } from "./flow.mjs";
import { attachEvidenceReferences, createEvidenceManifest } from "./evidence.mjs";
import { buildHindsightDocument } from "./synthesis.mjs";
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
          const options = sessions.map((session) => `${selected.some((item) => item.id === session.id) ? "✓ " : ""}${session.cwd || "Unknown location"} — ${session.name || session.firstMessage || session.id}`).concat(["Generate document", "Remove selected conversation", "Cancel"]);
          const choice = await ctx.ui.select(`Hindsight selection (${selected.length} selected)`, options);
          if (!choice || choice === "Cancel") throw new Error("Hindsight generation canceled.");
          if (choice === "Generate document") break;
          if (choice === "Remove selected conversation") {
            const remove = await ctx.ui.select("Remove conversation", selected.map((session) => session.name || session.id));
            const index = selected.findIndex((session) => (session.name || session.id) === remove);
            if (index >= 0) selected.splice(index, 1);
            continue;
          }
          const session = sessions[options.indexOf(choice)];
          if (session && !selected.some((item) => item.id === session.id)) selected.push(session);
        }
        if (selected.length < 2) throw new Error("Select at least two conversations before generation.");
        const patterns = await configuredPatterns(ctx.cwd);
        const sources = [];
        for (const session of selected) {
          const projection = projectConversation((await SessionManager.open(session.path)).getEntries());
          const review = await reviewRedactionChoices(ctx, findSensitiveContent(projection, patterns));
          if (review.excluded) continue;
          const reference = pseudonymizeSession(session);
          sources.push({ events: attachEvidenceReferences(reference, redactProjection(projection, findSensitiveContent(projection, patterns), review.decisions)).events });
        }
        const outputPath = resolveOutputPath(args, ctx.cwd, "pi-hindsight-document.html", "hindsight document");
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, buildHindsightDocument(sources), "utf8");
        ctx.ui.notify(`Hindsight document written to ${outputPath}.`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to generate hindsight document.", "error"); }
    },
  });
}
