import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createComplianceArtifacts, publishablePackageDirectories, validatePackageCompliance } from "../scripts/generate-package-compliance.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const normalizeLineEndings = (value) => value.replace(/\r\n/g, "\n");

test("every publishable package has current versioned notice and deterministic CycloneDX SBOM", async () => {
  const packages = await validatePackageCompliance({ repositoryRoot: root });
  assert.equal(packages.length, 6);

  const workspacePackages = new Map(packages.map(({ manifest }) => [manifest.name, manifest]));
  for (const { directory, manifest } of packages) {
    const { notice, sbom } = createComplianceArtifacts(manifest, workspacePackages);
    assert.equal(normalizeLineEndings(await readFile(join(directory, "THIRD-PARTY-NOTICES.md"), "utf8")), notice);
    assert.equal(normalizeLineEndings(await readFile(join(directory, "sbom.cdx.json"), "utf8")), sbom);
    const parsed = JSON.parse(sbom);
    assert.equal(parsed.bomFormat, "CycloneDX");
    assert.equal(parsed.specVersion, "1.5");
    assert.equal(parsed.metadata.component.name, manifest.name);
    assert.equal(parsed.metadata.component.version, manifest.version);
    assert.match(parsed.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test("only the six non-private workspaces receive release compliance artifacts", async () => {
  const packages = await publishablePackageDirectories(root);
  assert.deepEqual(packages.map(({ manifest }) => manifest.name), [
    "@zkrausman/pi-conversation-catalog",
    "@zkrausman/pi-delivery-controller",
    "@zkrausman/pi-ticket-closeout-summary",
    "@zkrausman/pi-ticket-cost",
    "@zkrausman/pi-ticket-lifecycle",
    "@zkrausman/pi-wiki-delivery",
  ]);
});
