import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import parseChangeset from "@changesets/parse";
import { publishablePackages } from "./validate-publishable-packages.mjs";

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const changesetDirectory = ".changeset";

function normalizedPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isVersionBump(release) {
  return ["major", "minor", "patch"].includes(release.type);
}

function runGit(args, { cwd }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("git", args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr || stdout}`));
    });
  });
}

async function resolveCommit(reference, { repositoryRoot, gitRunner }) {
  assert.equal(typeof reference, "string", "a base and head Git reference are required");
  assert.ok(reference.length > 0, "a base and head Git reference are required");
  const { stdout } = await gitRunner(["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`], { cwd: repositoryRoot });
  const commit = stdout.trim();
  assert.match(commit, /^[0-9a-f]{40}$/i, `Git reference did not resolve to a commit: ${reference}`);
  return commit;
}

/** Return only tracked paths changed between verified commits. */
export async function changedTrackedPaths({ repositoryRoot = root, baseRef, headRef, gitRunner = runGit } = {}) {
  const baseCommit = await resolveCommit(baseRef, { repositoryRoot, gitRunner });
  const headCommit = await resolveCommit(headRef, { repositoryRoot, gitRunner });
  const { stdout } = await gitRunner([
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=ACMRDT",
    `${baseCommit}...${headCommit}`,
    "--",
  ], { cwd: repositoryRoot });
  return stdout.split("\0").filter(Boolean).map(normalizedPath);
}

function packageDirectoryForPath(path) {
  const match = /^extensions\/([^/]+)\//.exec(normalizedPath(path));
  return match?.[1];
}

function packagePathIsReleaseRelevant(path, packageInfo, repositoryRoot) {
  const packageDirectory = normalizedPath(relative(repositoryRoot, packageInfo.directory));
  const normalized = normalizedPath(path);
  if (!normalized.startsWith(`${packageDirectory}/`)) return false;

  const withinPackage = normalized.slice(packageDirectory.length + 1);
  if (withinPackage === "package.json" || withinPackage.endsWith(".md")) return true;
  if (withinPackage.startsWith("src/") || withinPackage.startsWith("bin/") || withinPackage.startsWith("docs/")) return true;

  for (const entry of packageInfo.manifest.files ?? []) {
    if (typeof entry !== "string") continue;
    const publishedPath = entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (withinPackage === publishedPath || withinPackage.startsWith(`${publishedPath}/`)) return true;
  }
  return false;
}

async function basePublishablePackages(repositoryRoot, changedPaths, baseRef, gitRunner) {
  if (!baseRef) return [];
  const baseCommit = await resolveCommit(baseRef, { repositoryRoot, gitRunner });
  const directories = new Set(changedPaths.map(packageDirectoryForPath).filter(Boolean));
  const packages = [];
  for (const directory of directories) {
    try {
      const { stdout } = await gitRunner(["show", `${baseCommit}:extensions/${directory}/package.json`], { cwd: repositoryRoot });
      const manifest = JSON.parse(stdout);
      if (manifest.private !== true) packages.push({ directory: join(repositoryRoot, "extensions", directory), manifest });
    } catch {
      // The workspace may have been added in the PR, or may not have had a manifest at the base.
    }
  }
  return packages;
}

/** Identify publishable workspaces with tracked source, package, or documentation changes. */
export async function changedPublishablePackages({ repositoryRoot = root, changedPaths, baseRef, gitRunner = runGit } = {}) {
  assert.ok(Array.isArray(changedPaths), "changed paths are required");
  const packages = [
    ...await basePublishablePackages(repositoryRoot, changedPaths, baseRef, gitRunner),
    ...await publishablePackages(repositoryRoot),
  ];
  const byName = new Map(packages.map((packageInfo) => [packageInfo.manifest.name, packageInfo]));
  return [...byName.values()].filter((packageInfo) => changedPaths.some((path) => packagePathIsReleaseRelevant(path, packageInfo, repositoryRoot)));
}

async function pendingChangesets(repositoryRoot) {
  const directory = join(repositoryRoot, changesetDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const changesets = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(directory, entry.name);
    try {
      const parsed = parseChangeset(await readFile(path, "utf8"));
      changesets.push({ path: normalizedPath(relative(repositoryRoot, path)), releases: parsed.releases });
    } catch (error) {
      throw new Error(`Invalid pending Changeset ${normalizedPath(relative(repositoryRoot, path))}: ${error.message}`);
    }
  }
  return changesets;
}

function changedExemptionPaths(changedPaths) {
  return changedPaths.filter((path) => /^\.changeset\/exemptions\/[^/]+\.json$/.test(normalizedPath(path)));
}

async function pendingExemptions(repositoryRoot, changedPaths) {
  const exemptions = new Map();
  for (const path of changedExemptionPaths(changedPaths)) {
    let exemption;
    try {
      exemption = JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
    } catch (error) {
      throw new Error(`Invalid Changeset exemption ${path}: ${error.message}`);
    }
    const keys = Object.keys(exemption).sort();
    assert.deepEqual(keys, ["packages", "reason"], `${path}: Changeset exemptions must contain only packages and reason`);
    assert.ok(Array.isArray(exemption.packages) && exemption.packages.length > 0, `${path}: packages must be a non-empty array`);
    assert.equal(new Set(exemption.packages).size, exemption.packages.length, `${path}: packages must not contain duplicates`);
    assert.ok(exemption.packages.every((name) => typeof name === "string" && name.length > 0), `${path}: packages must contain package names`);
    assert.equal(typeof exemption.reason, "string", `${path}: reason must be a string`);
    assert.ok(exemption.reason.trim().length > 0, `${path}: reason must not be empty`);
    for (const packageName of exemption.packages) exemptions.set(packageName, { path, reason: exemption.reason });
  }
  return exemptions;
}

/**
 * Enforce the PR Changeset policy. Exemptions must be introduced or edited in
 * the same diff, preventing a historical exemption from silently covering a
 * later package change.
 */
export async function validateChangesetPolicy({ repositoryRoot = root, changedPaths, baseRef, gitRunner = runGit } = {}) {
  const changedPackages = await changedPublishablePackages({ repositoryRoot, changedPaths, baseRef, gitRunner });
  if (changedPackages.length === 0) return { changedPackages: [], exemptions: [], changesets: [] };

  const [changesets, exemptions] = await Promise.all([
    pendingChangesets(repositoryRoot),
    pendingExemptions(repositoryRoot, changedPaths),
  ]);
  const releasedPackages = new Set(
    changesets.flatMap((changeset) => changeset.releases.filter(isVersionBump).map((release) => release.name)),
  );
  const missing = changedPackages
    .map((packageInfo) => packageInfo.manifest.name)
    .filter((packageName) => !releasedPackages.has(packageName) && !exemptions.has(packageName));

  assert.deepEqual(
    missing,
    [],
    `Missing a pending Changeset or changed exemption for: ${missing.join(", ")}. `
      + "Add a major, minor, or patch Changeset, or add .changeset/exemptions/<name>.json as documented in CONTRIBUTING.md.",
  );

  return {
    changedPackages: changedPackages.map((packageInfo) => packageInfo.manifest.name),
    exemptions: [...exemptions.entries()].map(([packageName, exemption]) => ({ packageName, ...exemption })),
    changesets: changesets.map((changeset) => changeset.path),
  };
}

function optionValue(option) {
  const index = process.argv.indexOf(option);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseRef = optionValue("--base") ?? process.env.CHANGESET_BASE_REF;
  const headRef = optionValue("--head") ?? process.env.CHANGESET_HEAD_REF ?? "HEAD";
  changedTrackedPaths({ baseRef, headRef })
    .then((changedPaths) => validateChangesetPolicy({ changedPaths, baseRef }))
    .then((result) => {
      console.log(`Changeset policy validated for ${result.changedPackages.length} publishable package(s).`);
    })
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    });
}
