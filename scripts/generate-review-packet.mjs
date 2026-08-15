#!/usr/bin/env node
/** Create a deterministic, commit-only, bounded Git review packet. */
import { execFile } from "node:child_process";
import { validateOversizedPackageLockfile } from "./package-lock-admission.mjs";
import { createHash } from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const LIMITS = Object.freeze({
  argument: 4096, ref: 256, files: 200, path: 240, blob: 128 * 1024,
  generatedLockfileBlob: 512 * 1024,
  stat: 32 * 1024, diff: 384 * 1024, hunks: 64, hunk: 64 * 1024,
  patch: 128 * 1024, patches: 768 * 1024, packet: 1024 * 1024,
});
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9.][A-Za-z0-9._@+,-]*$/;

function fail(message) { throw new Error(message); }
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
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      fail(`git ${args[0]} output exceeds the fixed ${options.maxBuffer ?? LIMITS.diff}-byte review-packet bound; produce a smaller range`);
    }
    fail(`git ${args[0]} failed: ${String(error.stderr || error.message).trim() || "command failed"}`);
  }
}
export function safeChangedPath(filePath) {
  const segments = typeof filePath === "string" ? filePath.split("/") : [];
  if (!filePath || filePath.length > LIMITS.path || filePath.includes("\\0") || filePath.includes("\\") || filePath.startsWith("/") || filePath.includes("//")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git" || !SAFE_PATH_SEGMENT.test(segment))) {
    fail(`changed path is unsafe or unsupported: ${JSON.stringify(filePath)}`);
  }
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
const GENERATED_LOCKFILE_PATH = "package-lock.json";
async function blobAt(gitCommand, commit, filePath, endpoint) {
  const entry = (await gitCommand(["ls-tree", commit, "--", filePath], { maxBuffer: 4096 })).trim();
  if (!entry) return null; // A file may be created or deleted at one endpoint.
  const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
  if (!match || match[3] !== filePath) fail(`${filePath} is not a regular tracked text file`);
  const objectId = match[2];
  await gitCommand(["cat-file", "-e", `${objectId}^{blob}`], { maxBuffer: 128 });
  const size = Number.parseInt(await gitCommand(["cat-file", "-s", objectId], { maxBuffer: 64 }), 10);
  const oversizedGeneratedLockfile = filePath === GENERATED_LOCKFILE_PATH && size > LIMITS.blob;
  const maximum = oversizedGeneratedLockfile ? LIMITS.generatedLockfileBlob : LIMITS.blob;
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) fail(`${filePath} exceeds ${maximum} bytes`);
  const content = await gitCommand(["cat-file", "blob", objectId], { encoding: "buffer", maxBuffer: maximum + 1 });
  const text = textBlob(content, filePath);
  const calculatedObjectId = createHash(objectId.length === 40 ? "sha1" : "sha256").update(`blob ${content.length}\0`).update(content).digest("hex");
  if (calculatedObjectId !== objectId) fail(`${filePath} ${endpoint} blob content does not match its committed object ID`);
  if (oversizedGeneratedLockfile) validateOversizedPackageLockfile(text);
  return { objectId, byteLength: size, content: text };
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
  if (hunks.length > LIMITS.hunks) fail(`${filePath} has ${hunks.length} patch hunks, exceeding the fixed ${LIMITS.hunks}-hunk review-packet bound; produce a smaller range`);
  const hunkBytes = hunks.map((hunk) => Buffer.byteLength(hunk, "utf8"));
  const oversized = hunkBytes.findIndex((size) => size > LIMITS.hunk);
  if (oversized !== -1) fail(`${filePath} patch hunk ${oversized + 1} exceeds the fixed ${LIMITS.hunk}-byte review-packet bound; produce a smaller range`);
  const totalBytes = hunkBytes.reduce((total, size) => total + size, 0);
  if (totalBytes > LIMITS.patch) fail(`${filePath} patch hunks exceed the fixed ${LIMITS.patch}-byte review-packet bound; produce a smaller range`);
  return { patch: { path: filePath, hunks }, totalBytes };
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
  // Validate changed endpoints before emitting textual evidence. Their content
  // never becomes packet material; only complete Git-generated hunks do.
  for (const { path: filePath } of files) {
    await blobAt(gitCommand, base, filePath, "base");
    await blobAt(gitCommand, head, filePath, "head");
  }
  const diffStat = await gitCommand(["diff", "--no-ext-diff", "--no-textconv", "--stat", "--no-renames", base, head], { maxBuffer: LIMITS.stat });
  const patches = [];
  let totalPatchBytes = 0;
  for (const { path: filePath } of files) {
    const diff = await gitCommand(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", base, head, "--", filePath]);
    const { patch, totalBytes } = patchHunks(diff, filePath);
    totalPatchBytes += totalBytes;
    if (totalPatchBytes > LIMITS.patches) fail(`patch hunks exceed the fixed ${LIMITS.patches}-byte total review-packet bound; produce a smaller range`);
    patches.push(patch);
  }
  // A complete Git-generated patch is the only review evidence. Truncation or
  // omission fails before packet construction; never substitute blob endpoints
  // or packet-authenticated source chunks, which Git object IDs do not bind.
  const packet = { format: "pi-sampler.scoped-review-packet.v2", base, head, changedFiles: files, diffStat: diffStat.trimEnd(), patches, incomplete: false, omittedHunks: [], byteTruncatedHunks: [], immutableMaterial: [], ...(options.validation === undefined ? {} : { validationEvidence: options.validation }) };
  if (Buffer.byteLength(serializeReviewPacket(packet), "utf8") > LIMITS.packet) fail("serialized packet exceeds the fixed 1048576-byte review-packet bound; produce a smaller range");
  return packet;
}
/** The canonical bytes used for local packet exchange and attestation digests. */
export function serializeReviewPacket(packet) {
  return `${JSON.stringify(packet, null, 2)}\n`;
}
export function reviewPacketSha256(packet) {
  return createHash("sha256").update(serializeReviewPacket(packet), "utf8").digest("hex");
}
async function main() {
  try {
    const packet = await generateReviewPacket(argumentsFrom(process.argv.slice(2)));
    process.stdout.write(serializeReviewPacket(packet));
  } catch (error) {
    process.stderr.write(`review-packet: ${error.message}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1]?.endsWith("generate-review-packet.mjs")) await main();
