#!/usr/bin/env node
/** Create deterministic, commit-only, bounded Git review packets. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";
import { OVERSIZED_PACKAGE_LOCKFILE_BYTES, validateOversizedPackageLockfile } from "./package-lock-admission.mjs";

const run = promisify(execFile);
const LIMITS = Object.freeze({
  argument: 4096,
  ref: 256,
  files: 200,
  path: 240,
  blob: 128 * 1024,
  generatedLockfileBlob: OVERSIZED_PACKAGE_LOCKFILE_BYTES,
  stat: 32 * 1024,
  diff: 384 * 1024,
  hunks: 64,
  hunk: 64 * 1024,
  patch: 128 * 1024,
  patches: 768 * 1024,
  packet: 1024 * 1024,
  physicalLine: 4 * 1024,
  transportSegment: 4 * 1024,
  segments: 64,
  gitTimeout: 30_000,
});
export const REVIEW_PACKET_LIMITS = LIMITS;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9.][A-Za-z0-9._@+,-]*$/;
const SHA = /^[0-9a-f]{40,64}$/;
const V2_FORMAT = "pi-sampler.scoped-review-packet.v2";
const V3_FORMAT = "pi-sampler.scoped-review-packet.v3";
export const REVIEW_PACKET_V2_FORMAT = V2_FORMAT;
export const REVIEW_PACKET_V3_FORMAT = V3_FORMAT;

function fail(message) { throw new Error(message); }
function bounded(value, label, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) fail(`${label} is missing, unsafe, or exceeds its bound`);
  return value;
}
function argumentsFrom(argv, defaultVersion = 3) {
  if (argv.length > 8 || argv.length % 2) fail("expected supported option/value pairs");
  const names = new Map([["--base", "base"], ["--head", "head"], ["--validation", "validation"], ["--version", "version"]]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key) fail("expected supported option/value pairs");
    if (options[key] !== undefined) fail("expected each supported option at most once");
    options[key] = bounded(argv[index + 1], argv[index], key === "version" ? 2 : LIMITS.argument);
  }
  options.base = bounded(options.base, "--base", LIMITS.ref);
  options.head = bounded(options.head, "--head", LIMITS.ref);
  if (options.validation !== undefined) bounded(options.validation, "--validation", LIMITS.argument);
  options.version = options.version ?? String(defaultVersion);
  if (options.version !== "2" && options.version !== "3") fail("--version must be 2 or 3");
  return options;
}
function optionsFor(options, version) {
  return argumentsFrom([
    "--base", options?.base,
    "--head", options?.head,
    ...(options?.validation === undefined ? [] : ["--validation", options.validation]),
    "--version", String(options?.version ?? version),
  ], version);
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
    // The allowlist is deliberately non-GIT_, even when Windows supplies mixed case names.
    if (entry && !/^git_/i.test(entry[0])) environment[entry[0]] = entry[1];
  }
  return environment;
}
function gitArguments(args) { return [...GIT_GLOBAL_OPTIONS, ...args]; }
async function runGit(args, options = {}, onGitCommand, cwd = process.cwd()) {
  const command = gitArguments(args);
  onGitCommand?.([...command]);
  try {
    return (await run("git", command, {
      cwd,
      env: fixedGitEnvironment(),
      windowsHide: true,
      encoding: "utf8",
      timeout: LIMITS.gitTimeout,
      killSignal: "SIGTERM",
      maxBuffer: LIMITS.diff,
      ...options,
    })).stdout;
  } catch (error) {
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      fail(`git ${args[0]} output exceeds the fixed ${(options.maxBuffer ?? LIMITS.diff)}-byte review-packet bound; produce a smaller range`);
    }
    if (error.code === "ETIMEDOUT" || error.killed) fail(`git ${args[0]} exceeded the fixed ${LIMITS.gitTimeout}ms review-packet timeout`);
    fail(`git ${args[0]} failed: ${String(error.stderr || error.message).trim() || "command failed"}`);
  }
}

export function safeChangedPath(filePath) {
  const segments = typeof filePath === "string" ? filePath.split("/") : [];
  if (!filePath || filePath.length > LIMITS.path || filePath.includes("\0") || filePath.includes("\\") || filePath.startsWith("/") || filePath.includes("//")
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
function changedFilesV3(raw) {
  const files = changedFiles(raw);
  if (files.some(({ status }) => !/^[ADM]$/.test(status))) fail("v3 packets reject renames, copies, and unsupported Git change statuses");
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
  const mode = match[1];
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
  return { objectId, mode, byteLength: size, content: text };
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

function packetOptions(options, version) {
  if (Object.hasOwn(options ?? {}, "output")) fail("filesystem output is unsupported; capture the returned packet or stdout");
  return optionsFor(options, version);
}
function resolvePacketOptions(options, version) {
  const parsed = packetOptions(options, version);
  if (parsed.version !== String(version)) fail(`packet generator version ${version} cannot use --version ${parsed.version}`);
  return parsed;
}

/** Generate the frozen v2 packet used by historical attestation markers. */
export async function generateReviewPacketV2(options, { onGitCommand, cwd = process.cwd() } = {}) {
  options = resolvePacketOptions(options, 2);
  const gitCommand = (args, commandOptions) => runGit(args, commandOptions, onGitCommand, cwd);
  const base = (await gitCommand(["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`], { maxBuffer: 128 })).trim();
  const head = (await gitCommand(["rev-parse", "--verify", "--end-of-options", `${options.head}^{commit}`], { maxBuffer: 128 })).trim();
  if (!SHA.test(base) || !SHA.test(head)) fail("base and head must resolve to commits");
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
  const packet = { format: V2_FORMAT, base, head, changedFiles: files, diffStat: diffStat.trimEnd(), patches, incomplete: false, omittedHunks: [], byteTruncatedHunks: [], immutableMaterial: [], ...(options.validation === undefined ? {} : { validationEvidence: options.validation }) };
  if (Buffer.byteLength(serializeReviewPacketV2(packet), "utf8") > LIMITS.packet) fail("serialized packet exceeds the fixed 1048576-byte review-packet bound; produce a smaller range");
  return packet;
}

function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }
function splitHunk(hunk, filePath) {
  const newline = hunk.indexOf("\n");
  if (newline < 0) fail(`${filePath} has a malformed textual patch hunk`);
  const header = hunk.slice(0, newline);
  if (!/^@@ -[0-9]+(?:,[0-9]+)? \+[0-9]+(?:,[0-9]+)? @@(?: .*)?$/.test(header)) fail(`${filePath} has a malformed textual patch hunk header`);
  const body = hunk.slice(newline + 1);
  const logicalLines = [];
  let start = 0;
  while (start < body.length) {
    const end = body.indexOf("\n", start);
    if (end < 0) {
      logicalLines.push(body.slice(start));
      break;
    }
    logicalLines.push(body.slice(start, end + 1));
    start = end + 1;
  }
  if (!logicalLines.length) fail(`${filePath} has an empty textual patch hunk`);
  return { header, logicalLines };
}
function encodedSegmentLineLength(segment) {
  // A logical-line segment is rendered at this indentation by the canonical
  // pretty JSON serializer. Include a comma so both array positions are safe.
  return Buffer.byteLength(`${" ".repeat(16)}${JSON.stringify(segment)},`, "utf8");
}
export function splitTransportSegments(value, filePath = "logical line") {
  const characters = [...value];
  const widths = characters.map((character) => Buffer.byteLength(character, "utf8"));
  const segments = [];
  let start = 0;
  while (start < characters.length) {
    let end = start;
    let rawBytes = 0;
    while (end < characters.length && rawBytes + widths[end] <= LIMITS.transportSegment) {
      rawBytes += widths[end];
      end += 1;
    }
    let low = start + 1;
    let high = end;
    let best = start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = characters.slice(start, middle).join("");
      if (encodedSegmentLineLength(candidate) <= LIMITS.physicalLine) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (best === start) fail(`${filePath} contains a logical line that cannot fit the encoded physical-line bound`);
    segments.push(characters.slice(start, best).join(""));
    start = best;
  }
  if (!segments.length) segments.push("");
  if (segments.length > LIMITS.segments) fail(`${filePath} logical line exceeds the fixed ${LIMITS.segments}-segment bound`);
  return segments;
}
function encodeLogicalLine(value, filePath) {
  const bytes = Buffer.from(value, "utf8");
  if (value.includes("\0") || bytes.toString("utf8") !== value) fail(`${filePath} contains unsupported logical-line bytes`);
  const byteLength = bytes.length;
  const segments = splitTransportSegments(value, filePath);
  return { segments, byteLength, sha256: sha256Hex(Buffer.from(value, "utf8")) };
}
export function reconstructV3Hunk(hunk) {
  return `${hunk.header}\n${hunk.logicalLines.map((line) => line.segments.join("" )).join("")}`;
}
function encodeV3Hunk(hunk, filePath) {
  const split = splitHunk(hunk, filePath);
  const encoded = { header: split.header, logicalLines: split.logicalLines.map((line) => encodeLogicalLine(line, filePath)) };
  if (reconstructV3Hunk(encoded) !== hunk) fail(`${filePath} hunk reconstruction does not match the complete Git hunk`);
  return encoded;
}
function orderedV3Packet(packet) {
  const ordered = {
    format: packet.format,
    base: packet.base,
    head: packet.head,
    changedFiles: packet.changedFiles.map((file) => ({ path: file.path, status: file.status })),
    diffStat: packet.diffStat,
    patches: packet.patches.map((patch) => ({
      path: patch.path,
      hunks: patch.hunks.map((hunk) => ({
        header: hunk.header,
        logicalLines: hunk.logicalLines.map((line) => ({
          segments: [...line.segments],
          byteLength: line.byteLength,
          sha256: line.sha256,
        })),
      })),
    })),
    incomplete: packet.incomplete,
    omittedHunks: [...packet.omittedHunks],
    byteTruncatedHunks: [...packet.byteTruncatedHunks],
    immutableMaterial: [...packet.immutableMaterial],
  };
  if (Object.hasOwn(packet, "validationEvidence")) ordered.validationEvidence = packet.validationEvidence;
  return ordered;
}
function serializedPhysicalLineCheck(serialized) {
  if (!serialized.endsWith("\n")) fail("v3 packet serialization must end with one newline");
  const lines = serialized.slice(0, -1).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const length = Buffer.byteLength(lines[index], "utf8");
    if (length > LIMITS.physicalLine) fail(`v3 packet physical line ${index + 1} exceeds the fixed ${LIMITS.physicalLine}-byte bound`);
  }
}
/** Canonical v3 bytes. The explicit object construction freezes key ordering. */
export function serializeReviewPacketV3(packet) {
  const serialized = `${JSON.stringify(orderedV3Packet(packet), null, 2)}\n`;
  serializedPhysicalLineCheck(serialized);
  return serialized;
}
export function reviewPacketSha256V3(packet) {
  return createHash("sha256").update(serializeReviewPacketV3(packet), "utf8").digest("hex");
}

async function rejectRenamesAndCopies(gitCommand, base, head) {
  const raw = await gitCommand(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames=50%", "--find-copies=50%", "--find-copies-harder", base, head], { maxBuffer: 64 * 1024 });
  const parts = raw.split("\0");
  if (parts.at(-1) === "") parts.pop();
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    if (/^[RC]/.test(status)) fail("v3 packets reject Git renames and copies");
    if (!/^[ACDM]$/.test(status) || index >= parts.length) fail("v3 packets reject unsupported Git change statuses");
    safeChangedPath(parts[index++]);
  }
}
async function generateReviewPacketV3(options, { onGitCommand, cwd = process.cwd() } = {}) {
  options = resolvePacketOptions(options, 3);
  const gitCommand = (args, commandOptions) => runGit(args, commandOptions, onGitCommand, cwd);
  const base = (await gitCommand(["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`], { maxBuffer: 128 })).trim();
  const head = (await gitCommand(["rev-parse", "--verify", "--end-of-options", `${options.head}^{commit}`], { maxBuffer: 128 })).trim();
  if (!SHA.test(base) || !SHA.test(head)) fail("base and head must resolve to commits");
  await gitCommand(["merge-base", "--is-ancestor", base, head], { maxBuffer: 128 });
  await rejectRenamesAndCopies(gitCommand, base, head);
  const files = changedFilesV3(await gitCommand(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--no-renames", base, head], { maxBuffer: 64 * 1024 }));
  for (const { path: filePath } of files) {
    const baseBlob = await blobAt(gitCommand, base, filePath, "base");
    const headBlob = await blobAt(gitCommand, head, filePath, "head");
    if (baseBlob && headBlob && baseBlob.mode !== headBlob.mode) fail(`${filePath} changes file mode, which v3 packets do not admit`);
  }
  const diffStat = await gitCommand(["diff", "--no-ext-diff", "--no-textconv", "--stat", "--no-renames", base, head], { maxBuffer: LIMITS.stat });
  const patches = [];
  let totalPatchBytes = 0;
  for (const { path: filePath } of files) {
    const diff = await gitCommand(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", base, head, "--", filePath]);
    const { patch, totalBytes } = patchHunks(diff, filePath);
    totalPatchBytes += totalBytes;
    if (totalPatchBytes > LIMITS.patches) fail(`patch hunks exceed the fixed ${LIMITS.patches}-byte total review-packet bound; produce a smaller range`);
    patches.push({ path: filePath, hunks: patch.hunks.map((hunk) => encodeV3Hunk(hunk, filePath)) });
  }
  const packet = {
    format: V3_FORMAT,
    base,
    head,
    changedFiles: files,
    diffStat: diffStat.trimEnd(),
    patches,
    incomplete: false,
    omittedHunks: [],
    byteTruncatedHunks: [],
    immutableMaterial: [],
    ...(options.validation === undefined ? {} : { validationEvidence: options.validation }),
  };
  const serialized = serializeReviewPacketV3(packet);
  if (Buffer.byteLength(serialized, "utf8") > LIMITS.packet) fail("serialized packet exceeds the fixed 1048576-byte review-packet bound; produce a smaller range");
  return packet;
}
export { generateReviewPacketV3 };

/** New callers receive v3; historical callers can select v2 explicitly. */
export async function generateReviewPacket(options, context = {}) {
  return String(options?.version ?? "3") === "2"
    ? generateReviewPacketV2(options, context)
    : generateReviewPacketV3(options, context);
}

/** The legacy names remain frozen for v2 packet-consistency validation. */
export function serializeReviewPacketV2(packet) {
  return `${JSON.stringify(packet, null, 2)}\n`;
}
export function reviewPacketSha256V2(packet) {
  return createHash("sha256").update(serializeReviewPacketV2(packet), "utf8").digest("hex");
}
export const serializeReviewPacket = serializeReviewPacketV2;
export const reviewPacketSha256 = reviewPacketSha256V2;

async function main() {
  try {
    const packet = await generateReviewPacket(argumentsFrom(process.argv.slice(2)));
    process.stdout.write((packet.format === V3_FORMAT ? serializeReviewPacketV3 : serializeReviewPacketV2)(packet));
  } catch (error) {
    process.stderr.write(`review-packet: ${error.message}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1]?.endsWith("generate-review-packet.mjs")) await main();
