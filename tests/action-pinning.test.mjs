import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const workflows = join(process.cwd(), ".github", "workflows");

test("GitHub Actions use immutable commit SHAs with version comments", async () => {
  for (const file of await readdir(workflows)) {
    if (!file.endsWith(".yml")) continue;
    const source = await readFile(join(workflows, file), "utf8");
    for (const line of source.split(/\r?\n/)) {
      if (!line.includes("uses:")) continue;
      assert.match(line, /uses:\s+[\w-]+\/[\w-]+@[a-f0-9]{40}\s+#\s+v\d+/, `${file}: ${line}`);
    }
  }
});
