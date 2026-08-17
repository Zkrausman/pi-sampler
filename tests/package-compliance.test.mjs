import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createComplianceArtifacts, publishablePackageDirectories, validatePackageCompliance } from "../scripts/generate-package-compliance.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const exampleManifest = {
  name: "@example/compliance-fixture",
  version: "1.2.3",
  license: "Apache-2.0",
  dependencies: { "external-library": "^4.5.6" },
  peerDependencies: { "@example/workspace-library": "^7.0.0" },
};
const exampleWorkspacePackages = new Map([
  ["@example/workspace-library", { name: "@example/workspace-library", version: "7.1.0", license: "MIT" }],
]);

test("M0 has no publishable packages or generated package compliance artifacts", async () => {
  assert.deepEqual(await publishablePackageDirectories(root), []);
  assert.deepEqual(await validatePackageCompliance({ repositoryRoot: root }), []);
});

test("generic compliance generation keeps notices and CycloneDX SBOMs deterministic", () => {
  const first = createComplianceArtifacts(exampleManifest, exampleWorkspacePackages);
  const second = createComplianceArtifacts(exampleManifest, exampleWorkspacePackages);
  assert.deepEqual(second, first);

  const sbom = JSON.parse(first.sbom);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.5");
  assert.equal(sbom.metadata.component.name, exampleManifest.name);
  assert.equal(sbom.metadata.component.version, exampleManifest.version);
  assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(sbom.components.map((component) => component.name), ["external-library", "@example/workspace-library"]);
  assert.deepEqual(sbom.components[0].properties, [
    { name: "pi-sampler:dependency-kind", value: "dependencies" },
    { name: "pi-sampler:declared-version", value: "^4.5.6" },
    { name: "pi-sampler:workspace", value: "false" },
  ]);
  assert.deepEqual(sbom.components[1].properties, [
    { name: "pi-sampler:dependency-kind", value: "peerDependencies" },
    { name: "pi-sampler:declared-version", value: "^7.0.0" },
    { name: "pi-sampler:workspace", value: "true" },
  ]);
  assert.match(first.notice, /No third-party package is bundled in this npm artifact/);
  assert.match(first.notice, /declared runtime and peer dependencies below are recorded for traceability/);
  assert.match(first.notice, /external-library.*declared range \^4\.5\.6/);
  assert.match(first.notice, /@example\/workspace-library.*workspace version 7\.1\.0/);
});
