import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateCatalogHtml, groupSessions } from "./catalog.mjs";

const DEFAULT_FILENAME = "pi-conversation-catalog.html";

function resolveOutputPath(args: string, cwd: string): string {
  const requestedPath = args.trim() || DEFAULT_FILENAME;
  if (requestedPath.includes("\0")) throw new Error("The output path is invalid.");

  const outputPath = resolve(cwd, requestedPath);
  if (extname(outputPath).toLowerCase() !== ".html") {
    throw new Error("The catalog output path must end in .html.");
  }
  return outputPath;
}

/**
 * A read-only catalog of Pi session metadata. Pi's listAll() may parse session logs
 * internally; this extension neither persists nor renders transcript content.
 */
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
}
