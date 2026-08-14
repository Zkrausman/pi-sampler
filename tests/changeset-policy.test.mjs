import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateChangesetPolicy } from "../scripts/validate-changesets.mjs";

async function fixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-changeset-policy-"));
  await mkdir(join(repositoryRoot, "extensions", "example", "src"), { recursive: true });
  await mkdir(join(repositoryRoot, ".changeset"), { recursive: true });
  await writeFile(join(repositoryRoot, "package.json"), JSON.stringify({ workspaces: ["extensions/*"] }));
  await writeFile(join(repositoryRoot, "extensions", "example", "package.json"), JSON.stringify({
    name: "@example/pi-extension",
    version: "1.0.0",
    private: false,
    files: ["src", "README.md"],
  }));
  await writeFile(join(repositoryRoot, "extensions", "example", "src", "index.mjs"), "export default {};\n");
  return repositoryRoot;
}

async function withFixture(callback) {
  const repositoryRoot = await fixture();
  try {
    await callback(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

const sourceChange = ["extensions/example/src/index.mjs"];

test("publishable source changes require a pending Changeset or exemption", async () => {
  await withFixture(async (repositoryRoot) => {
    await assert.rejects(
      validateChangesetPolicy({ repositoryRoot, changedPaths: sourceChange }),
      /Missing a pending Changeset or changed exemption for: @example\/pi-extension/,
    );
  });
});

test("a matching pending Changeset satisfies the publishable package requirement", async () => {
  await withFixture(async (repositoryRoot) => {
    await writeFile(join(repositoryRoot, ".changeset", "example-release.md"), "---\n\"@example/pi-extension\": patch\n---\n\nRelease the source update.\n");
    const result = await validateChangesetPolicy({ repositoryRoot, changedPaths: sourceChange });
    assert.deepEqual(result.changedPackages, ["@example/pi-extension"]);
    assert.deepEqual(result.changesets, [".changeset/example-release.md"]);
  });
});

test("a malformed pending Changeset fails closed for a publishable package change", async () => {
  await withFixture(async (repositoryRoot) => {
    await writeFile(join(repositoryRoot, ".changeset", "malformed.md"), "---\n\"@example/pi-extension\": not-a-version\n---\n\nBroken.\n");
    await assert.rejects(
      validateChangesetPolicy({ repositoryRoot, changedPaths: sourceChange }),
      /Invalid pending Changeset .changeset\/malformed\.md/,
    );
  });
});

test("a changed, documented exemption satisfies the publishable package requirement", async () => {
  await withFixture(async (repositoryRoot) => {
    await mkdir(join(repositoryRoot, ".changeset", "exemptions"));
    const exemptionPath = ".changeset/exemptions/example-maintenance.json";
    await writeFile(join(repositoryRoot, exemptionPath), JSON.stringify({
      packages: ["@example/pi-extension"],
      reason: "This documentation-only correction does not require a release.",
    }, null, 2));
    const result = await validateChangesetPolicy({ repositoryRoot, changedPaths: [...sourceChange, exemptionPath] });
    assert.deepEqual(result.exemptions, [{
      packageName: "@example/pi-extension",
      path: exemptionPath,
      reason: "This documentation-only correction does not require a release.",
    }]);
  });
});

test("repository-only maintenance is automatically exempt", async () => {
  await withFixture(async (repositoryRoot) => {
    const result = await validateChangesetPolicy({ repositoryRoot, changedPaths: [".github/workflows/validate.yml"] });
    assert.deepEqual(result, { changedPackages: [], exemptions: [], changesets: [] });
  });
});
