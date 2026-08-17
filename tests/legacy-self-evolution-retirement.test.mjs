import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validatePackageCompliance } from "../scripts/generate-package-compliance.mjs";
import { validatePiExtensions } from "../scripts/validate-pi-extensions.mjs";
import { validatePublishablePackages } from "../scripts/validate-publishable-packages.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const retiredDirectories = [
  "extensions/conversation-catalog",
  "extensions/delivery-controller",
  "extensions/ticket-closeout-summary",
  "extensions/ticket-cost",
  "extensions/ticket-lifecycle",
  "extensions/wiki-delivery",
];
const retiredReference = /conversation-catalog|delivery-controller|ticket-closeout-summary|ticket-cost|ticket-lifecycle|wiki-delivery/i;

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

test("M0 retirement removes every legacy package from active discovery and preserves Excalidraw", async () => {
  for (const directory of retiredDirectories) assert.equal(await exists(join(root, directory)), false, `${directory} must not exist`);

  const [manifest, settings, readme, releaseGuide, retirement, compliance, piEntries, packages] = await Promise.all([
    readFile(join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(join(root, ".pi", "settings.json"), "utf8"),
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "docs", "RELEASING.md"), "utf8"),
    readFile(join(root, "docs", "LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md"), "utf8"),
    validatePackageCompliance({ repositoryRoot: root }),
    validatePiExtensions(root),
    validatePublishablePackages({ repositoryRoot: root }),
  ]);

  assert.equal(manifest.workspaces, undefined, "M0 must not declare a package workspace");
  for (const script of ["changeset", "version-packages", "release", "generate:compliance"]) assert.equal(manifest.scripts[script], undefined, `${script} must not retain a package-release path`);
  assert.doesNotMatch(settings, retiredReference, "Pi settings must not register retired entry points");
  assert.deepEqual(compliance, []);
  assert.deepEqual(piEntries, []);
  assert.deepEqual(packages, []);
  assert.doesNotMatch(readme, retiredReference, "README must not present retired packages as supported");
  assert.doesNotMatch(releaseGuide, retiredReference, "release documentation must not present retired packages as supported");
  for (const directory of retiredDirectories) assert.match(retirement, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.equal(await exists(join(root, "src", "extensions", "pi-excalidraw", "index.ts")), true, "Pi Excalidraw must remain present");
  assert.equal(typeof manifest.scripts.build, "string", "the independent application build must remain available");
});
