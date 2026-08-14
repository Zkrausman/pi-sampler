import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))));

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function workspaceDirectories(repositoryRoot) {
  const manifest = await readJson(join(repositoryRoot, "package.json"));
  const workspacePatterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  assert.deepEqual(workspacePatterns, ["extensions/*"], "package workspaces must remain extensions/* for package validation");

  const extensionsDirectory = join(repositoryRoot, "extensions");
  const entries = await readdir(extensionsDirectory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(extensionsDirectory, entry.name));
}

export async function publishablePackages(repositoryRoot = root) {
  const directories = await workspaceDirectories(repositoryRoot);
  const packages = [];
  for (const directory of directories) {
    const manifestPath = join(directory, "package.json");
    try {
      const manifest = await readJson(manifestPath);
      if (manifest.private !== true) packages.push({ directory, manifest });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return packages;
}

function expectedPackPaths(manifest) {
  const expected = new Set(["package.json"]);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, `${manifest.name}: publishable packages must declare package files`);
  for (const file of manifest.files) {
    assert.equal(typeof file, "string", `${manifest.name}: package files entries must be strings`);
    assert.ok(file && !file.startsWith("/") && !file.split("/").includes(".."), `${manifest.name}: package files entry is unsafe: ${file}`);
    expected.add(file.replaceAll("\\", "/").replace(/\/$/, ""));
  }
  for (const entry of Object.values(manifest.bin ?? {})) expected.add(entry);
  if (typeof manifest.exports === "string") expected.add(manifest.exports);
  for (const entry of manifest.pi?.extensions ?? []) expected.add(entry);
  return [...expected].map((entry) => entry.replace(/^\.\//, ""));
}

export function validatePackedArtifact(manifest, packResult) {
  assert.equal(packResult.name, manifest.name, `${manifest.name}: npm pack returned an unexpected package name`);
  assert.equal(packResult.version, manifest.version, `${manifest.name}: npm pack returned an unexpected version`);
  assert.ok(Array.isArray(packResult.files), `${manifest.name}: npm pack did not report artifact files`);

  const artifactPaths = new Set(packResult.files.map((file) => file.path));
  for (const expected of expectedPackPaths(manifest)) {
    const present = artifactPaths.has(expected) || [...artifactPaths].some((path) => path.startsWith(`${expected}/`));
    assert.ok(present, `${manifest.name}: packed artifact is missing expected content ${expected}`);
  }
}

export function run(command, args, options) {
  return new Promise((resolveRun, reject) => {
    // npm is a .cmd shim on Windows. The command and arguments are fixed by
    // this validator, so invoke cmd directly rather than enabling shell mode.
    const windows = process.platform === "win32";
    const executable = windows ? (process.env.ComSpec ?? "cmd.exe") : command;
    const executableArgs = windows ? ["/d", "/s", "/c", [command, ...args].join(" ")] : args;
    const child = spawn(executable, executableArgs, { ...options, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed in ${options.cwd} (exit ${code}):\n${stderr || stdout}`));
    });
  });
}

export async function validatePublishablePackages({ repositoryRoot = root, commandRunner = run } = {}) {
  const packages = await publishablePackages(repositoryRoot);
  assert.ok(packages.length > 0, "no publishable workspace packages found");

  for (const packageInfo of packages) {
    const { stdout } = await commandRunner("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageInfo.directory });
    let results;
    try {
      results = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`${packageInfo.manifest.name}: npm pack did not return JSON: ${error.message}`);
    }
    assert.equal(results.length, 1, `${packageInfo.manifest.name}: npm pack must return exactly one artifact`);
    validatePackedArtifact(packageInfo.manifest, results[0]);
    console.log(`validated package artifact: ${packageInfo.manifest.name}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  validatePublishablePackages().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
