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

test("Node 24 is the declared runtime baseline and CI setup version", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(manifest.engines.node, ">=24");

  let setupNodeSteps = 0;
  for (const file of await readdir(workflows)) {
    if (!file.endsWith(".yml")) continue;
    const source = await readFile(join(workflows, file), "utf8");
    for (const match of source.matchAll(/uses: actions\/setup-node@[a-f0-9]{40}\s+#\s+v\d+\r?\n\s+with:\r?\n\s+node-version:\s*(\d+)/g)) {
      setupNodeSteps += 1;
      assert.equal(match[1], "24", `${file} must use the Node 24 runtime baseline`);
    }
  }
  assert.ok(setupNodeSteps > 0, "expected at least one actions/setup-node step");
});
