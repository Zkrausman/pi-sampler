import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ImplementationPlanManifestV2Schema } from "../contracts/implementation-plan-manifest-v2.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "contracts", "implementation-plan-manifest-v2.schema.json");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check") || args.filter((arg) => arg === "--check").length > 1) {
  throw new Error("usage: node scripts/export-implementation-plan-manifest-v2-schema.mjs [--check]");
}
const content = `${JSON.stringify(ImplementationPlanManifestV2Schema, null, 2)}\n`;

if (args.includes("--check")) {
  const existing = await readFile(output, "utf8").catch(() => "");
  if (existing !== content) throw new Error("Implementation Plan Manifest v2 JSON Schema is stale; run the exporter without --check");
} else {
  await writeFile(output, content, "utf8");
}
