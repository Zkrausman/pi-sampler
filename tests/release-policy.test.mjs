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

test("release workflow requires a confirmed main-branch production release", async () => {
  const workflowPath = join(root, ".github", "workflows", "release.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      confirm_release:\n[\s\S]*?required: true\n        type: boolean\n        default: false/);
  assert.match(workflow, /^permissions:\n  contents: read\n  packages: write$/m);
  assert.equal((workflow.match(/^\s*permissions:/gm) ?? []).length, 1);
  assert.match(workflow, /release:\n    environment: production\n    runs-on: ubuntu-latest/);

  const guard = workflow.indexOf('if [[ "$GITHUB_REF" != "refs/heads/main" ]]; then');
  const confirmation = workflow.indexOf('if [[ "$CONFIRM_RELEASE" != "true" ]]; then');
  const checkout = workflow.indexOf("uses: actions/checkout@v7");

  assert.ok(guard >= 0, "the workflow must reject non-main refs");
  assert.ok(confirmation >= 0, "the workflow must require confirmation");
  assert.ok(checkout >= 0, "the workflow must check out the repository");
  assert.ok(guard < checkout, "the main-ref guard must run before checkout");
  assert.ok(confirmation < checkout, "the confirmation guard must run before checkout");
});
