import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthoritativeReceiptV1Schema } from "../contracts/authoritative-receipt-v1.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "contracts", "authoritative-receipt-v1.schema.json");
const content = `${JSON.stringify(AuthoritativeReceiptV1Schema, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8").catch(() => "") !== content) throw new Error("Authoritative Receipt v1 JSON Schema is stale; run npm run generate:authoritative-receipt-schema");
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content, "utf8");
}
