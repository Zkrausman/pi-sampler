import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publishablePackages } from "../scripts/validate-publishable-packages.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const canonicalSetupLink = "[the canonical GitHub Packages scoped-registry and authentication procedure](../../docs/RELEASING.md#consumer-setup)";

test("release documentation inventories supported packages and centralizes GitHub Packages setup", async () => {
  const [releasing, packages] = await Promise.all([
    readFile(join(root, "docs", "RELEASING.md"), "utf8"),
    publishablePackages(root),
  ]);

  assert.match(releasing, /source repository is public/);
  assert.match(releasing, /Source visibility and GitHub\s+Packages access are separate/);
  assert.match(releasing, /@zkrausman:registry=https:\/\/npm\.pkg\.github\.com/);
  assert.match(releasing, /\/\/npm\.pkg\.github\.com\/:_authToken=\$\{GITHUB_PACKAGES_TOKEN\}/);
  assert.match(releasing, /source\s+access alone is insufficient/);

  assert.equal(packages.length, 6, "the supported package inventory should contain every publishable workspace");
  for (const { directory, manifest } of packages) {
    assert.deepEqual(manifest.publishConfig, {
      registry: "https://npm.pkg.github.com",
      access: "restricted",
    }, `${manifest.name} must remain a restricted GitHub Packages distribution`);
    for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.md", "sbom.cdx.json"]) {
      assert.ok(manifest.files.includes(file), `${manifest.name} must ship ${file}`);
    }

    const inventoryRows = releasing
      .split(/\r?\n/)
      .filter((line) => line.includes(`\`${manifest.name}\``));
    assert.equal(inventoryRows.length, 1, `${manifest.name} must have one release-documentation inventory row`);
    const cells = inventoryRows[0].split("|").map((cell) => cell.trim());
    assert.equal(cells[2], `\`${manifest.name}\``);
    assert.equal(cells[3], `\`${manifest.version}\``);
    assert.equal(cells[4], "Supported -- GitHub Packages (restricted)");

    const readme = await readFile(join(directory, "README.md"), "utf8");
    assert.equal(readme.split(canonicalSetupLink).length - 1, 1, `${manifest.name} README must link to the one canonical setup procedure`);
    assert.doesNotMatch(readme, /npm login|npm config set @zkrausman/i, `${manifest.name} README must not duplicate authentication setup`);
  }
});

test("public documentation states source, privacy, security, and platform boundaries", async () => {
  const documents = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "docs", "PRIVACY.md"), "utf8"),
    readFile(join(root, "docs", "PLATFORM-AND-TRADEMARKS.md"), "utf8"),
    readFile(join(root, "SECURITY.md"), "utf8"),
    readFile(join(root, "CONTRIBUTING.md"), "utf8"),
    readFile(join(root, "docs", "RELEASING.md"), "utf8"),
  ]);
  const [readme, privacy, platform, security, contributing, releasing] = documents;
  assert.match(readme, /not affiliated with or endorsed by/);
  assert.match(readme, /public, while the six supported extension packages are[\s\S]*restricted access/);
  assert.match(privacy, /does not provide a\s+hosted service, account system, analytics endpoint, or telemetry configuration/);
  assert.match(platform, /not affiliated with, sponsored\s+by, or endorsed by/);
  assert.match(security, /private vulnerability reporting/);
  assert.match(contributing, /Developer Certificate of Origin \(DCO\)\s*1\.1/);
  assert.match(releasing, /CycloneDX 1\.5/);
  assert.match(releasing, /immutable/);
});

test("release documentation retains the withdrawn output optimizer status", async () => {
  const [releasing, optimizerManifest] = await Promise.all([
    readFile(join(root, "docs", "RELEASING.md"), "utf8"),
    readFile(join(root, "extensions", "output-optimizer", "package.json"), "utf8").then(JSON.parse),
  ]);

  assert.equal(optimizerManifest.private, true);
  assert.equal("publishConfig" in optimizerManifest, false);
  assert.match(releasing, /@zkrausman\/pi-output-optimizer/);
  assert.match(releasing, /Withdrawn from GitHub Packages -- do not publish/);
  assert.match(releasing, /pith install --pi/);
});
