import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("project-local Pi package sources are not pinned to package versions", async () => {
  const settings = JSON.parse(await readFile(join(root, ".pi", "settings.json"), "utf8"));
  for (const source of settings.packages ?? []) {
    if (!source.startsWith("npm:")) continue;
    assert.doesNotMatch(source, /@[0-9]/, `package source must remain unpinned: ${source}`);
  }
});
