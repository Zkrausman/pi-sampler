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

test("PR and release workflows run every documented validation gate before publishing", async () => {
  const validatePath = join(root, ".github", "workflows", "validate.yml");
  const validate = (await readFile(validatePath, "utf8")).replace(/\r\n/g, "\n");
  for (const command of ["npm test", "npm run build", "npm run validate:pi-extensions", "npm run validate:packages", "go test -race ./..."]) {
    assert.match(validate, new RegExp(`- run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }

  const releasePath = join(root, ".github", "workflows", "release.yml");
  const release = (await readFile(releasePath, "utf8")).replace(/\r\n/g, "\n");
  assert.match(release, /uses: actions\/setup-go@[a-f0-9]{40}\s+# v7/);
  const releaseCommandPositions = ["npm test", "npm run build", "npm run validate:governance", "npm run validate:pi-extensions", "npm run validate:packages", "npm run release"].map((command) => release.indexOf(`- run: ${command}`));
  assert.ok(releaseCommandPositions.every((position) => position >= 0), "release must run every validation gate");
  assert.deepEqual([...releaseCommandPositions].sort((left, right) => left - right), releaseCommandPositions, "release gates must run before publishing");
});

test("PR validation compares verified base and head SHAs for the Changeset policy", async () => {
  const workflowPath = join(root, ".github", "workflows", "validate.yml");
  const workflow = (await readFile(workflowPath, "utf8")).replace(/\r\n/g, "\n");

  assert.match(workflow, /changesets:\n[\s\S]*?if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /CHANGESET_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /CHANGESET_HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n          fetch-depth: 0/);
  assert.match(workflow, /npm run validate:changesets -- --base "\$CHANGESET_BASE_REF" --head "\$CHANGESET_HEAD_REF"/);
});

test("release workflow requires a confirmed main-branch production release", async () => {
  const workflowPath = join(root, ".github", "workflows", "release.yml");
  const workflow = (await readFile(workflowPath, "utf8")).replace(/\r\n/g, "\n");

  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      confirm_release:\n[\s\S]*?required: true\n        type: boolean\n        default: false/);
  assert.match(workflow, /^permissions:\n  contents: read\n  packages: write$/m);
  assert.equal((workflow.match(/^\s*permissions:/gm) ?? []).length, 1);
  assert.match(workflow, /release:\n    environment: production\n    runs-on: ubuntu-latest/);

  const guard = workflow.indexOf('if [[ "$GITHUB_REF" != "refs/heads/main" ]]; then');
  const confirmation = workflow.indexOf('if [[ "$CONFIRM_RELEASE" != "true" ]]; then');
  const checkout = workflow.indexOf("uses: actions/checkout@");

  assert.ok(guard >= 0, "the workflow must reject non-main refs");
  assert.ok(confirmation >= 0, "the workflow must require confirmation");
  assert.ok(checkout >= 0, "the workflow must check out the repository");
  assert.ok(guard < checkout, "the main-ref guard must run before checkout");
  assert.ok(confirmation < checkout, "the confirmation guard must run before checkout");
});
