#!/usr/bin/env node
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { startViewer } = await import(pathToFileURL(join(root, "src", "viewer.mjs")).href);

function openBrowser(url) {
  const command = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = execFile(command[0], command[1], { windowsHide: true }, () => undefined);
  child.unref();
}

const viewer = await startViewer();
let stopped = false;
function stop() { if (!stopped) { stopped = true; viewer.close(); } }
process.once("SIGINT", () => { stop(); process.exitCode = 0; });
process.once("SIGTERM", () => { stop(); process.exitCode = 0; });
viewer.server.once("close", () => { stopped = true; });
openBrowser(viewer.url);
