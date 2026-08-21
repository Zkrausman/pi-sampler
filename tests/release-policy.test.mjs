import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validatePackageLifecycle, validatePackedArtifact } from "../scripts/validate-publishable-packages.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("package validation rejects every un-inventoried native artifact form", () => {
  for (const path of ["src/addon.node", "native.dll", "lib/libexample.dylib", "lib/libexample.so", "lib/libexample.so.1", "lib/libexample.so.1.2", "lib/libexample.so.1.2.3"]) {
    assert.throws(
      () => validatePackedArtifact(
        { name: "@example/native", version: "1.0.0", files: ["src"] },
        { name: "@example/native", version: "1.0.0", files: [{ path: "package.json" }, { path }] },
      ),
      /native artifacts require an explicit compliance-inventory policy/,
      path,
    );
  }
});

test("package validation rejects pack-affecting lifecycle scripts but permits non-pack scripts", () => {
  for (const name of ["prepublish", "prepare", "prepublishOnly", "prepack"]) {
    assert.throws(
      () => validatePackageLifecycle({ name: "@example/lifecycle", scripts: { [name]: "node build.mjs" } }),
      /pack-affecting lifecycle scripts are not permitted/,
      name,
    );
  }
  assert.doesNotThrow(() => validatePackageLifecycle({ name: "@example/lifecycle", scripts: { test: "node --test", postpack: "node cleanup.mjs" } }));
});

test("PR validation preserves repository, Changeset, and DCO gates", async () => {
  const workflow = (await readFile(join(root, ".github", "workflows", "validate.yml"), "utf8")).replace(/\r\n/g, "\n");
  for (const command of ["npm test", "npm run build", "npm run validate:compliance", "npm run validate:pi-extensions", "npm run validate:packages", "go test -race ./..."]) {
    assert.match(workflow, new RegExp(`- run: ${escapeRegExp(command)}`));
  }
  assert.match(workflow, /changesets:\n[\s\S]*?if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /CHANGESET_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /CHANGESET_HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n          fetch-depth: 0/);
  const testJob = workflow.split("  changesets:\n", 1)[0];
  assert.match(testJob, /actions\/checkout@[^\n]+\n        with:\n          fetch-depth: 0/);
  assert.match(testJob, /AIDEV_165_REGRESSION_BASE: aee0f2e6244aedc85fd1fc8620af317aeeb8f284/);
  assert.match(testJob, /run: git cat-file -e "\$\{AIDEV_165_REGRESSION_BASE\}\^\{commit\}"/);
  assert.match(workflow, /npm run validate:changesets -- --base "\$CHANGESET_BASE_REF" --head "\$CHANGESET_HEAD_REF"/);
  assert.match(workflow, /dco:\n    if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /DCO_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /DCO_HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /npm run validate:dco -- --base "\$DCO_BASE_REF" --head "\$DCO_HEAD_REF"/);
});

test("release readiness preserves validation and skips package operations only at zero inventory", async () => {
  const [workflow, manifest] = await Promise.all([
    readFile(join(root, ".github", "workflows", "release.yml"), "utf8"),
    readFile(join(root, "package.json"), "utf8").then(JSON.parse),
  ]);
  assert.match(workflow, /permissions:\n  contents: read/m);
  assert.doesNotMatch(workflow, /changeset publish|npm run release|upload-artifact|sbom\.cdx\.json/);
  for (const script of ["changeset", "version-packages", "release", "generate:compliance"]) assert.equal(manifest.scripts[script], undefined, `${script} must not offer a manual package-release path`);
  assert.match(workflow, /id: package-inventory/);
  assert.match(workflow, /steps\.package-inventory\.outputs\.count != '0'/);
  assert.match(workflow, /steps\.package-inventory\.outputs\.count == '0'/);
  for (const command of ["npm test", "npm run build", "npm run validate:governance", "npm run validate:compliance", "npm run validate:pi-extensions", "npm run validate:packages"]) {
    assert.match(workflow, new RegExp(`run: ${escapeRegExp(command)}`));
  }
});
