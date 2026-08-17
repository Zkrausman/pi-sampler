import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TicketEpisodeV1Schema } from "../contracts/ticket-episode-v1.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "contracts", "ticket-episode-v1.schema.json");
const content = `${JSON.stringify(TicketEpisodeV1Schema, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const existing = (await readFile(output, "utf8").catch(() => "")).replace(/\r\n/g, "\n");
  if (existing !== content) {
    throw new Error("Ticket Episode v1 JSON Schema is stale; run npm run generate:ticket-episode-schema");
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content, "utf8");
}
