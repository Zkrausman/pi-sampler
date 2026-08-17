import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publishablePackageDirectories, validatePackageCompliance } from "../scripts/generate-package-compliance.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("M0 has no publishable packages or generated package compliance artifacts", async () => {
  assert.deepEqual(await publishablePackageDirectories(root), []);
  assert.deepEqual(await validatePackageCompliance({ repositoryRoot: root }), []);
});
