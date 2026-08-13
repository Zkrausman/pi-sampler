#!/usr/bin/env node
/** Create a deterministic, commit-only, bounded Git review packet. */
import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const LIMITS = Object.freeze({ argument: 4096, ref: 256, files: 200, path: 240, blob: 128 * 1024, stat: 32 * 1024, diff: 384 * 1024, hunks: 4, hunk: 8 * 1024 });
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/@+,-]*$/;

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
async function git(args, options = {}) {
  try {
    return (await run("git", args, { cwd: process.cwd(), windowsHide: true, encoding: "utf8", maxBuffer: LIMITS.diff, ...options })).stdout;
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
}
async function validateBlob(commit, filePath) {
  const entry = (await git(["ls-tree", commit, "--", filePath], { maxBuffer: 4096 })).trim();
  if (!entry) return; // A file may be created or deleted at one endpoint.
  if (!/^(100644|100755) blob [0-9a-f]{40,64}\t/.test(entry)) fail(`${filePath} is not a regular tracked text file`);
  const object = `${commit}:${filePath}`;
  const size = Number.parseInt(await git(["cat-file", "-s", object], { maxBuffer: 64 }), 10);
  if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.blob) fail(`${filePath} exceeds ${LIMITS.blob} bytes`);
  textBlob(await git(["cat-file", "blob", object], { encoding: "buffer", maxBuffer: LIMITS.blob + 1 }), filePath);
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
export async function generateReviewPacket(options) {
  // Enforce CLI-equivalent bounds for programmatic callers too.
  if (Object.hasOwn(options ?? {}, "output")) fail("filesystem output is unsupported; capture the returned packet or stdout");
  options = argumentsFrom(["--base", options?.base, "--head", options?.head, ...(options?.validation === undefined ? [] : ["--validation", options.validation])]);
  const base = (await git(["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`], { maxBuffer: 128 })).trim();
  const head = (await git(["rev-parse", "--verify", "--end-of-options", `${options.head}^{commit}`], { maxBuffer: 128 })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(base) || !/^[0-9a-f]{40,64}$/.test(head)) fail("base and head must resolve to commits");
  await git(["merge-base", "--is-ancestor", base, head], { maxBuffer: 128 });
  const files = changedFiles(await git(["diff", "--name-status", "-z", "--no-renames", base, head], { maxBuffer: 64 * 1024 }));
  for (const { path: filePath } of files) { await validateBlob(base, filePath); await validateBlob(head, filePath); }
  const diffStat = await git(["diff", "--stat", "--no-renames", base, head], { maxBuffer: LIMITS.stat });
  const patches = [];
  for (const { path: filePath } of files) patches.push(patchHunks(await git(["diff", "--no-ext-diff", "--no-renames", "--unified=3", base, head, "--", filePath]), filePath));
  const omittedHunks = patches.filter((patch) => patch.omittedHunks).map((patch) => patch.path);
  const byteTruncatedHunks = patches.filter((patch) => patch.byteTruncated).map((patch) => patch.path);
  return { format: "pi-sampler.scoped-review-packet.v1", base, head, changedFiles: files, diffStat: diffStat.trimEnd(), patches, incomplete: omittedHunks.length > 0, omittedHunks, byteTruncatedHunks, ...(options.validation === undefined ? {} : { validationEvidence: options.validation }) };
}
async function main() { try { process.stdout.write(`${JSON.stringify(await generateReviewPacket(argumentsFrom(process.argv.slice(2))), null, 2)}\n`); } catch (error) { process.stderr.write(`review-packet: ${error.message}\n`); process.exitCode = 1; } }
if (process.argv[1]?.endsWith("generate-review-packet.mjs")) await main();
