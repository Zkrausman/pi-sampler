import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expected = new Map([
  ["acceptance-manifest-v1.schema.json", "acceptance-manifest/v1"],
  ["acceptance-matrix-v1.schema.json", "acceptance-matrix/v1"],
  ["benchmark-evidence-v1.schema.json", "benchmark-evidence/v1"],
  ["waiver-v1.schema.json", "delivery-waiver/v1"],
]);

function visitSchema(value, path = "$") {
  if (!value || typeof value !== "object") return;
  if (value.type === "object" && value.additionalProperties !== false) throw new Error(`${path} must reject additional properties`);
  for (const [key, child] of Object.entries(value)) visitSchema(child, `${path}.${key}`);
}

for (const [name, version] of expected) {
  const path = join(root, "governance", "docs", "delivery-evidence", name);
  const schema = JSON.parse(await readFile(path, "utf8"));
  if (schema.properties?.schema_version?.const !== version) throw new Error(`${name} has the wrong schema version`);
  visitSchema(schema);
}
console.log(`validated ${expected.size} delivery-evidence schemas`);
