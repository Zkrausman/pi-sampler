import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validatePackageLifecycle, validatePackedArtifact } from "../scripts/validate-publishable-packages.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("package validation rejects un-inventoried native artifacts", () => {
  assert.throws(
    () => validatePackedArtifact(
      { name: "@example/native", version: "1.0.0", files: ["src"] },
      { name: "@example/native", version: "1.0.0", files: [{ path: "package.json" }, { path: "native.dll" }] },
    ),
    /native artifacts require an explicit compliance-inventory policy/,
  );
});

test("package validation rejects pack-affecting lifecycle scripts", () => {
  for (const name of ["prepublish", "prepare", "prepublishOnly", "prepack"]) {
    assert.throws(() => validatePackageLifecycle({ name: "@example/lifecycle", scripts: { [name]: "node build.mjs" } }));
  }
});

test("PR validation retains every repository gate", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "validate.yml"), "utf8");
  for (const command of ["npm test", "npm run build", "npm run validate:compliance", "npm run validate:pi-extensions", "npm run validate:packages", "go test -race ./..."]) {
    assert.match(workflow, new RegExp(`- run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.match(workflow, /npm run validate:changesets -- --base "\$CHANGESET_BASE_REF" --head "\$CHANGESET_HEAD_REF"/);
  assert.match(workflow, /npm run validate:dco -- --base "\$DCO_BASE_REF" --head "\$DCO_HEAD_REF"/);
});

test("release readiness skips package operations for a zero-package inventory", async () => {
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
  for (const command of ["npm test", "npm run build", "npm run validate:governance"]) assert.match(workflow, new RegExp(`- run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});
