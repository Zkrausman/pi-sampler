import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("withdrawn output optimizer cannot be published", async () => {
  const packagePath = join(root, "extensions", "output-optimizer", "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));

  assert.equal(manifest.private, true);
  assert.equal("publishConfig" in manifest, false);
});
