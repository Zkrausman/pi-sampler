#!/usr/bin/env node
/** Create a deterministic, commit-only, bounded Git review packet. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const LIMITS = Object.freeze({
  argument: 4096, ref: 256, files: 200, path: 240, blob: 128 * 1024,
  stat: 32 * 1024, diff: 384 * 1024, hunks: 4, hunk: 8 * 1024,
  immutableEndpoint: 24 * 1024, immutablePath: 52 * 1024,
  immutableTotal: 128 * 1024, packet: 1024 * 1024,
});
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/@+,-]*$/;

function fail(message) { throw new Error(message); }
function byteLength(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function bounded(value, label, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) fail(`${label} is missing, unsafe, or exceeds its bound`);
  return value;
}
function argumentsFrom(argv) {
  if (argv.length > 6 || argv.length % 2) fail("expected supported option/value pairs");
  const names = new Map([["--base", "base"], ["--head", "head"], ["--validation", "validation"]]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key) fail("expected supported option/value pairs");
    if (options[key] !== undefined) fail("expected each supported option at most once");
    options[key] = bounded(argv[index + 1], argv[index], LIMITS.argument);
  }
  options.base = bounded(options.base, "--base", LIMITS.ref);
  options.head = bounded(options.head, "--head", LIMITS.ref);
  if (options.validation !== undefined) bounded(options.validation, "--validation", LIMITS.argument);
  return options;
}
// These commands only read committed objects. Keep their process boundary explicit:
// do not inherit Git's environment-controlled repository, tracing, or config inputs.
const SAFE_ENVIRONMENT_NAMES = Object.freeze(process.platform === "win32"
  ? ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA"]
  : ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]);
const GIT_GLOBAL_OPTIONS = Object.freeze([
  "--no-pager", "--no-replace-objects",
  // Command-line config has precedence over repository, global, and system config.
  "-c", "trace2.eventTarget=", "-c", "trace2.normalTarget=", "-c", "trace2.perfTarget=",
  "-c", "color.ui=false", "-c", "core.hooksPath=/dev/null",
]);
function fixedGitEnvironment(source = process.env) {
  const environment = {};
  for (const expectedName of SAFE_ENVIRONMENT_NAMES) {
    const entry = Object.entries(source).find(([name]) => name.toLowerCase() === expectedName.toLowerCase());
    // The allowlist is also deliberately non-GIT_, even when Windows supplies mixed case names.
    if (entry && !/^git_/i.test(entry[0])) environment[entry[0]] = entry[1];
  }
  return environment;
}
function gitArguments(args) { return [...GIT_GLOBAL_OPTIONS, ...args]; }
async function runGit(args, options = {}, onGitCommand) {
  const command = gitArguments(args);
  onGitCommand?.([...command]);
  try {
    return (await run("git", command, {
      cwd: process.cwd(), env: fixedGitEnvironment(), windowsHide: true,
      encoding: "utf8", maxBuffer: LIMITS.diff, ...options,
    })).stdout;
  } catch (error) {
    fail(`git ${args[0]} failed: ${String(error.stderr || error.message).trim() || "command failed"}`);
  }
}
function safeChangedPath(filePath) {
  if (!filePath || filePath.length > LIMITS.path || !SAFE_PATH.test(filePath) || filePath.includes("//") || filePath.split("/").includes("..") || filePath.split("/").includes(".git")) fail(`changed path is unsafe or unsupported: ${JSON.stringify(filePath)}`);
}
function changedFiles(raw) {
  const parts = raw.split("\0");
  parts.pop();
  if (parts.length % 2) fail("Git returned an ambiguous changed-file list");
  const files = [];
  for (let index = 0; index < parts.length; index += 2) {
    const [status, filePath] = [parts[index], parts[index + 1]];
    if (!/^[ACDMRT]$/.test(status)) fail(`unsupported change status: ${JSON.stringify(status)}`);
    safeChangedPath(filePath);
    files.push({ path: filePath, status });
  }
  if (files.length > LIMITS.files || new Set(files.map(({ path: filePath }) => filePath)).size !== files.length) fail("changed-file list exceeds bounds or contains duplicates");
  return files;
}
function textBlob(content, label) {
  if (content.includes(0)) fail(`${label} is binary`);
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) fail(`${label} is not valid UTF-8 text`);
  return text;
}
async function blobAt(gitCommand, commit, filePath, endpoint) {
  const entry = (await gitCommand(["ls-tree", commit, "--", filePath], { maxBuffer: 4096 })).trim();
  if (!entry) return null; // A file may be created or deleted at one endpoint.
  const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
  if (!match || match[3] !== filePath) fail(`${filePath} is not a regular tracked text file`);
  const objectId = match[2];
  await gitCommand(["cat-file", "-e", `${objectId}^{blob}`], { maxBuffer: 128 });
  const size = Number.parseInt(await gitCommand(["cat-file", "-s", objectId], { maxBuffer: 64 }), 10);
  if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.blob) fail(`${filePath} exceeds ${LIMITS.blob} bytes`);
  const content = await gitCommand(["cat-file", "blob", objectId], { encoding: "buffer", maxBuffer: LIMITS.blob + 1 });
  const text = textBlob(content, filePath);
  const calculatedObjectId = createHash(objectId.length === 40 ? "sha1" : "sha256").update(`blob ${content.length}\0`).update(content).digest("hex");
  if (calculatedObjectId !== objectId) fail(`${filePath} ${endpoint} blob content does not match its committed object ID`);
  return { objectId, byteLength: size, content: text };
}
function truncate(value, maximum) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maximum) return { value, truncated: false };
  let end = maximum;
  while (end && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { value: `${buffer.subarray(0, end).toString("utf8")}\n[... hunk truncated by review-packet bound ...]`, truncated: true };
}
function patchHunks(diff, filePath) {
  const hunks = [];
  let current;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@ ")) {
      if (current) hunks.push(current.join("\n"));
      current = [line];
    } else if (current) current.push(line);
  }
  if (current) hunks.push(current.join("\n"));
  if (!hunks.length) fail(`${filePath} has no textual patch hunks`);
  const boundedHunks = hunks.slice(0, LIMITS.hunks).map((hunk) => truncate(hunk, LIMITS.hunk));
  const byteTruncated = boundedHunks.some((hunk) => hunk.truncated);
  return { path: filePath, hunks: boundedHunks.map((hunk) => hunk.value), omittedHunks: hunks.length > LIMITS.hunks || byteTruncated, byteTruncated };
}
function immutableEndpoint(blob, filePath, endpoint) {
  if (!blob) return null;
  if (Buffer.byteLength(blob.content, "utf8") > LIMITS.immutableEndpoint) fail(`${filePath} cannot embed immutable material: ${endpoint} committed blob exceeds ${LIMITS.immutableEndpoint} bytes; produce a smaller range`);
  return blob;
}
function immutableMaterial(file, baseBlob, headBlob) {
  const material = { path: file.path, status: file.status, base: immutableEndpoint(baseBlob, file.path, "base"), head: immutableEndpoint(headBlob, file.path, "head") };
  const expected = { A: [null, true], D: [true, null], M: [true, true] }[file.status];
  if (!expected || Boolean(material.base) !== Boolean(expected[0]) || Boolean(material.head) !== Boolean(expected[1])) fail(`${file.path} has inconsistent committed endpoints`);
  if (byteLength(material) > LIMITS.immutablePath) fail(`${file.path} immutable material exceeds fixed packet bounds; produce a smaller range`);
  return material;
}
export async function generateReviewPacket(options, { onGitCommand } = {}) {
  // Enforce CLI-equivalent bounds for programmatic callers too.
  if (Object.hasOwn(options ?? {}, "output")) fail("filesystem output is unsupported; capture the returned packet or stdout");
  const gitCommand = (args, commandOptions) => runGit(args, commandOptions, onGitCommand);
  options = argumentsFrom(["--base", options?.base, "--head", options?.head, ...(options?.validation === undefined ? [] : ["--validation", options.validation])]);
  const base = (await gitCommand(["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`], { maxBuffer: 128 })).trim();
  const head = (await gitCommand(["rev-parse", "--verify", "--end-of-options", `${options.head}^{commit}`], { maxBuffer: 128 })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(base) || !/^[0-9a-f]{40,64}$/.test(head)) fail("base and head must resolve to commits");
  await gitCommand(["merge-base", "--is-ancestor", base, head], { maxBuffer: 128 });
  // Every diff form disables configured external diff and textconv execution.
  const files = changedFiles(await gitCommand(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--no-renames", base, head], { maxBuffer: 64 * 1024 }));
  const blobs = new Map();
  for (const { path: filePath } of files) blobs.set(filePath, { base: await blobAt(gitCommand, base, filePath, "base"), head: await blobAt(gitCommand, head, filePath, "head") });
  const diffStat = await gitCommand(["diff", "--no-ext-diff", "--no-textconv", "--stat", "--no-renames", base, head], { maxBuffer: LIMITS.stat });
  const patches = [];
  for (const { path: filePath } of files) patches.push(patchHunks(await gitCommand(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", base, head, "--", filePath]), filePath));
  const omittedHunks = patches.filter((patch) => patch.omittedHunks).map((patch) => patch.path);
  const byteTruncatedHunks = patches.filter((patch) => patch.byteTruncated).map((patch) => patch.path);
  const immutableMaterialByPath = omittedHunks.map((filePath) => {
    const file = files.find(({ path }) => path === filePath);
    const endpoints = blobs.get(filePath);
    return immutableMaterial(file, endpoints.base, endpoints.head);
  });
  if (immutableMaterialByPath.reduce((total, material) => total + byteLength(material), 0) > LIMITS.immutableTotal) fail("immutable material exceeds fixed packet bounds; produce a smaller range");
  const packet = { format: "pi-sampler.scoped-review-packet.v1", base, head, changedFiles: files, diffStat: diffStat.trimEnd(), patches, incomplete: omittedHunks.length > 0, omittedHunks, byteTruncatedHunks, immutableMaterial: immutableMaterialByPath, ...(options.validation === undefined ? {} : { validationEvidence: options.validation }) };
  if (byteLength(packet) > LIMITS.packet) fail("packet exceeds fixed packet bounds; produce a smaller range");
  return packet;
}
async function main() { try { process.stdout.write(`${JSON.stringify(await generateReviewPacket(argumentsFrom(process.argv.slice(2))), null, 2)}\n`); } catch (error) { process.stderr.write(`review-packet: ${error.message}\n`); process.exitCode = 1; } }
if (process.argv[1]?.endsWith("generate-review-packet.mjs")) await main();
