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

const m0Packages = [
  ["conversation-catalog", "@zkrausman/pi-conversation-catalog"],
  ["delivery-controller", "@zkrausman/pi-delivery-controller"],
  ["ticket-closeout-summary", "@zkrausman/pi-ticket-closeout-summary"],
  ["ticket-cost", "@zkrausman/pi-ticket-cost"],
  ["ticket-lifecycle", "@zkrausman/pi-ticket-lifecycle"],
  ["wiki-delivery", "@zkrausman/pi-wiki-delivery"],
];

async function withRetiredInventory(callback) {
  await withFixture(async (repositoryRoot) => {
    await rm(join(repositoryRoot, "extensions", "example"), { recursive: true, force: true });
    await writeFile(join(repositoryRoot, "package.json"), JSON.stringify({ name: "retired" }));
    await mkdir(join(repositoryRoot, "docs"));
    await writeFile(join(repositoryRoot, "docs", "LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md"), "# retirement\n");
    const manifests = new Map(m0Packages.map(([directory, name]) => [directory, JSON.stringify({ name, version: "1.0.0", private: false, files: ["src"] })]));
    const gitRunner = async (args) => {
      if (args[0] === "rev-parse") return { stdout: "a".repeat(40), stderr: "" };
      if (args[0] === "show") {
        const directory = /extensions\/([^/]+)\/package\.json$/.exec(args[1])?.[1];
        return { stdout: manifests.get(directory), stderr: "" };
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    await callback({ repositoryRoot, gitRunner });
  });
}

test("the documented M0 retirement permits only the exact six-package deletion", async () => {
  await withRetiredInventory(async ({ repositoryRoot, gitRunner }) => {
    const changedPaths = [...m0Packages.map(([directory]) => `extensions/${directory}/src/index.mjs`), "docs/LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md"];
    const result = await validateChangesetPolicy({ repositoryRoot, changedPaths, baseRef: "base", gitRunner });
    assert.deepEqual(result, { changedPackages: [], exemptions: [], changesets: [] });
  });
});

test("the M0 record cannot exempt an unrelated package deletion", async () => {
  await withRetiredInventory(async ({ repositoryRoot, gitRunner }) => {
    await assert.rejects(
      validateChangesetPolicy({
        repositoryRoot,
        changedPaths: ["extensions/conversation-catalog/src/index.mjs", "docs/LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md"],
        baseRef: "base",
        gitRunner,
      }),
      /Missing a pending Changeset or changed exemption/,
    );
  });
});
