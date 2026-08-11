import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateCatalogHtml, groupSessions } from "./catalog.mjs";
import { generateConversationFlowHtml, projectConversation } from "./flow.mjs";

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
    description: "Write a standalone HTML flow view for one saved Pi session",
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
          `pi-conversation-flow-${safeFilename(selected.id)}.html`,
          "conversation flow",
        );
        const manager = await SessionManager.open(selected.path);
        const html = generateConversationFlowHtml(selected, projectConversation(manager.getEntries()));
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, html, "utf8");
        ctx.ui.notify(`Conversation flow written to ${outputPath}. It contains selected transcript content; open this local .html file directly in your browser.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error && error.message.includes("output path") ? error.message : "Unable to write the conversation flow.", "error");
      }
    },
  });
}
