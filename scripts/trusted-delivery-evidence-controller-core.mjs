import { accessSync, constants as fsConstants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, win32 as winPath } from "node:path";
import process from "node:process";

const WINDOWS_GIT = Object.freeze([
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files\\Git\\bin\\git.exe",
]);
const POSIX_GIT = Object.freeze(["/usr/bin/git", "/usr/local/bin/git"]);
const DEFAULT_LIMITS = Object.freeze({
  gitStdout: 8 * 1024 * 1024,
  gitStderr: 64 * 1024,
  commandStdout: 8 * 1024 * 1024,
  commandStderr: 64 * 1024,
  gitTimeout: 30_000,
  commandTimeout: 900_000,
});
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class DeliveryControllerCoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "DeliveryControllerCoreError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new DeliveryControllerCoreError(code, message);
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), "utf8");
}

export function sha256Bytes(value) {
  return createHash("sha256").update(asBuffer(value)).digest("hex");
}

function jsonString(value) {
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) result += "\\\"";
    else if (code === 0x5c) result += "\\\\";
    else if (code === 0x08) result += "\\b";
    else if (code === 0x09) result += "\\t";
    else if (code === 0x0a) result += "\\n";
    else if (code === 0x0c) result += "\\f";
    else if (code === 0x0d) result += "\\r";
    else if (code < 0x20 || code === 0x7f) result += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (code >= 0xd800 && code <= 0xdfff) {
      if (code >= 0xdc00 || index + 1 >= value.length) result += `\\u${code.toString(16).padStart(4, "0")}`;
      else {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          result += value[index] + value[index + 1];
          index += 1;
        } else result += `\\u${code.toString(16).padStart(4, "0")}`;
      }
    } else result += value[index];
  }
  return `${result}"`;
}

/** Canonical JSON used by the line-oriented controller protocol. */
export function canonicalJSONString(value) {
  const visit = (entry) => {
    if (entry === null) return "null";
    if (typeof entry === "string") return jsonString(entry);
    if (typeof entry === "boolean") return entry ? "true" : "false";
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry)) throw new TypeError("canonical JSON requires safe integers");
      return Object.is(entry, -0) ? "0" : String(entry);
    }
    if (Array.isArray(entry)) return `[${entry.map(visit).join(",")}]`;
    if (entry && typeof entry === "object") {
      return `{${Object.keys(entry).map((key) => `${jsonString(key)}:${visit(entry[key])}`).join(",")}}`;
    }
    throw new TypeError("canonical JSON contains an unsupported value");
  };
  return visit(value);
}

export function canonicalJSONLine(value) {
  return Buffer.from(`${canonicalJSONString(value)}\n`, "utf8");
}

function pathKey(value, platform = process.platform) {
  const normalized = String(value).replaceAll("/", "\\");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function redirected(info) {
  return Boolean(info?.isSymbolicLink?.() || info?.isReparsePoint?.() || info?.reparsePoint === true);
}

function identity(info) {
  return {
    dev: info?.dev === undefined ? "" : String(info.dev),
    ino: info?.ino === undefined ? "" : String(info.ino),
    size: info?.size === undefined ? "" : String(info.size),
    mtime: info?.mtimeNs === undefined ? String(info?.mtimeMs ?? "") : String(info.mtimeNs),
    mode: info?.mode === undefined ? "" : String(info.mode),
    nlink: info?.nlink === undefined ? "" : String(info.nlink),
  };
}

function sameIdentity(left, right) {
  return left && right && Object.keys(left).every((key) => left[key] === right[key]);
}

function fixedFileSnapshot(candidate, platform = process.platform, fileSystem = undefined) {
  const fs = fileSystem ?? {};
  const lstat = fs.lstatSync ?? lstatSync;
  const realpath = fs.realpathSync ?? realpathSync;
  const access = fs.accessSync ?? accessSync;
  let info;
  try { info = lstat(candidate); } catch { return null; }
  if (!info?.isFile?.() || redirected(info)) return null;
  let canonical;
  try { canonical = realpath(candidate); } catch { return null; }
  if (pathKey(canonical, platform) !== pathKey(candidate, platform)) return null;
  if (platform !== "win32") {
    try { access(candidate, fsConstants.X_OK); } catch { return null; }
  }
  return { canonical, identity: identity(info) };
}

export function locateFixedGit(platform = process.platform, fileSystem = undefined) {
  const candidates = platform === "win32" ? WINDOWS_GIT : POSIX_GIT;
  for (const candidate of candidates) {
    if (fixedFileSnapshot(candidate, platform, fileSystem)) return candidate;
  }
  fail("test_failed", "no fixed Git executable is available");
}

function fixedEnvironment(git = undefined, source = process.env) {
  const env = {
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  for (const name of ["SystemRoot", "WINDIR"]) {
    const match = Object.entries(source ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match) env[match[0]] = match[1];
  }
  const directories = process.platform === "win32"
    ? [git ? dirname(git) : null, dirname(process.execPath), "C:\\Windows\\System32", "C:\\Windows"]
    : [git ? dirname(git) : null, dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"];
  env.PATH = directories.filter(Boolean).filter((entry, index, all) => all.indexOf(entry) === index).join(process.platform === "win32" ? ";" : ":");
  return env;
}

export function runFixedGit({ cwd, args, git = undefined, limits = DEFAULT_LIMITS, allowFailure = true } = {}) {
  const executable = git ?? locateFixedGit();
  let result;
  try {
    result = spawnSync(executable, [
      "--no-pager", "--no-replace-objects", "--no-optional-locks",
      "-c", "trace2.eventTarget=", "-c", "trace2.normalTarget=", "-c", "trace2.perfTarget=",
      "-c", "color.ui=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      ...args,
    ], {
      cwd,
      shell: false,
      windowsHide: true,
      encoding: "buffer",
      timeout: limits.gitTimeout ?? DEFAULT_LIMITS.gitTimeout,
      maxBuffer: Math.max(limits.gitStdout ?? DEFAULT_LIMITS.gitStdout, limits.gitStderr ?? DEFAULT_LIMITS.gitStderr),
      env: fixedEnvironment(executable),
    });
  } catch (error) {
    if (!allowFailure) fail("trusted_git_failure", error.message);
    return { ok: false, status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error };
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  const oversized = stdout.length > (limits.gitStdout ?? DEFAULT_LIMITS.gitStdout) || stderr.length > (limits.gitStderr ?? DEFAULT_LIMITS.gitStderr) || result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  if (oversized) {
    if (!allowFailure) fail("trusted_git_failure");
    return { ok: false, status: result.status, stdout, stderr, error: result.error, oversized };
  }
  const answer = { ok: result.status === 0 && !result.error, status: result.status, stdout, stderr, error: result.error, oversized: false };
  if (!answer.ok && !allowFailure) fail("trusted_git_failure");
  return answer;
}

export function gitText(options) {
  const result = runFixedGit(options);
  if (!result.ok) return "";
  const text = result.stdout.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(result.stdout)) fail("trusted_git_failure");
  return text;
}

export function canonicalDirectory(directory, code = "candidate_root_invalid") {
  if (typeof directory !== "string" || directory.length === 0 || directory.includes("\0") || !isAbsolute(directory)) fail(code);
  let info;
  try { info = lstatSync(directory); } catch { fail(code); }
  if (!info.isDirectory() || redirected(info)) fail(code);
  let canonical;
  try { canonical = realpathSync(directory); } catch { fail(code); }
  if (pathKey(canonical) !== pathKey(resolve(directory))) fail(code);
  return canonical;
}

export function isPathInside(parent, child) {
  const remainder = relative(resolve(parent), resolve(child));
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(remainder));
}

function portableRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") && !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === "..") && value.split("/").every((part) => Buffer.byteLength(part, "utf8") <= 255);
}

function workingPath(root, path, code) {
  if (!portableRelativePath(path)) fail(code);
  const absolute = resolve(root, ...path.split("/"));
  if (!isPathInside(root, absolute)) fail(code);
  return absolute;
}

export function readStableWorkingFile(root, path, maximum, code = "candidate_blob_invalid") {
  const canonicalRoot = canonicalDirectory(root, "candidate_root_invalid");
  const absolute = workingPath(canonicalRoot, path, code);
  let before;
  try { before = lstatSync(absolute); } catch { fail(code); }
  let canonical;
  try { canonical = realpathSync(absolute); } catch { fail(code); }
  if (!before.isFile() || redirected(before) || pathKey(canonical) !== pathKey(absolute) || before.size > maximum) fail(code);
  if (process.platform !== "win32" && (before.mode & 0o777) !== 0o644) fail(code);
  let bytes;
  try { bytes = readFileSync(absolute); } catch { fail(code); }
  if (bytes.length !== before.size || bytes.length > maximum) fail(code);
  let after;
  try { after = lstatSync(absolute); } catch { fail("candidate_inventory_changed"); }
  if (!after.isFile() || redirected(after) || !sameIdentity(identity(before), identity(after))) fail("candidate_inventory_changed");
  return {
    path,
    mode: "100644",
    type: "blob",
    size: bytes.length,
    bytes,
    sha256: sha256Bytes(bytes),
  };
}

function parseTreeEntry(bytes, path) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("trusted_blob_invalid");
  const entries = text.split("\0").filter(Boolean);
  if (entries.length !== 1) fail("trusted_blob_invalid");
  const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)$/.exec(entries[0]);
  if (!match || match[4] !== path) fail("trusted_blob_invalid");
  return { mode: match[1], type: match[2], objectId: match[3], path: match[4] };
}

export function readBlobAtCommit({ repo, commit, path, maximum = 4 * 1024 * 1024, git = undefined, allowAbsent = false } = {}) {
  if (!SHA.test(String(commit)) || !portableRelativePath(path)) fail("trusted_blob_invalid");
  const tree = runFixedGit({ cwd: repo, git, args: ["ls-tree", "-z", "--full-tree", commit, "--", path], limits: { gitStdout: 64 * 1024, gitStderr: 64 * 1024 }, allowFailure: true });
  if (!tree.ok) fail("trusted_blob_invalid");
  if (tree.stdout.length === 0) {
    if (allowAbsent) return null;
    fail("trusted_blob_invalid");
  }
  const entry = parseTreeEntry(tree.stdout, path);
  if (entry.mode !== "100644" || entry.type !== "blob") fail("trusted_blob_invalid");
  const type = gitText({ cwd: repo, git, args: ["cat-file", "-t", entry.objectId], limits: { gitStdout: 128, gitStderr: 64 * 1024 }, allowFailure: true }).trim();
  const sizeText = gitText({ cwd: repo, git, args: ["cat-file", "-s", entry.objectId], limits: { gitStdout: 128, gitStderr: 64 * 1024 }, allowFailure: true }).trim();
  if (type !== "blob" || !/^\d+$/.test(sizeText)) fail("trusted_blob_invalid");
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) fail("trusted_blob_invalid");
  const blob = runFixedGit({ cwd: repo, git, args: ["cat-file", "blob", entry.objectId], limits: { gitStdout: maximum + 1, gitStderr: 64 * 1024 }, allowFailure: true });
  if (!blob.ok || blob.stdout.length !== size || blob.stdout.length > maximum) fail("trusted_blob_invalid");
  const algorithm = entry.objectId.length === 64 ? "sha256" : "sha1";
  const objectDigest = createHash(algorithm).update(`blob ${size}\0`, "utf8").update(blob.stdout).digest("hex");
  if (objectDigest !== entry.objectId) fail("trusted_blob_invalid");
  return { ...entry, size, bytes: blob.stdout, content: blob.stdout, sha256: sha256Bytes(blob.stdout) };
}

function parseStatusRecord(token) {
  if (token.startsWith("? ")) return { kind: "untracked", path: token.slice(2), xy: "??" };
  if (token.startsWith("1 ")) {
    const fields = token.split(" ");
    if (fields.length < 9) fail("candidate_not_clean");
    return { kind: "ordinary", xy: fields[1], path: fields.slice(8).join(" ") };
  }
  if (token.startsWith("2 ")) return { kind: "rename", path: token.slice(2) };
  if (token.startsWith("u ")) return { kind: "unmerged", path: token.slice(2) };
  if (token.startsWith("! ")) return { kind: "ignored", path: token.slice(2) };
  fail("candidate_not_clean");
}

export function readPorcelainStatus({ repo, git = undefined, maximum = 8 * 1024 * 1024 } = {}) {
  const result = runFixedGit({ cwd: repo, git, args: ["status", "--porcelain=v2", "-z", "--untracked-files=all"], limits: { gitStdout: maximum, gitStderr: 64 * 1024 }, allowFailure: true });
  if (!result.ok || result.oversized) fail("candidate_not_clean");
  const text = result.stdout.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(result.stdout)) fail("candidate_not_clean");
  const tokens = text.split("\0").filter(Boolean);
  const records = tokens.map(parseStatusRecord);
  if (new Set(records.map((entry) => entry.path)).size !== records.length) fail("candidate_not_clean");
  return { bytes: result.stdout, sha256: sha256Bytes(result.stdout), records };
}

function gitDirectoryIdentity(repo, value) {
  const lexical = resolve(repo, value);
  let info;
  let canonical;
  try { info = lstatSync(lexical); canonical = realpathSync(lexical); } catch { fail("candidate_root_invalid"); }
  if (!info.isDirectory() || redirected(info) || pathKey(canonical) !== pathKey(lexical)) fail("candidate_root_invalid");
  return { path: pathKey(canonical), identity: { dev: String(info.dev ?? ""), ino: String(info.ino ?? "") } };
}

function captureGitIdentity({ repo, git = undefined, expectedHead } = {}) {
  const text = (args, limit = 4096) => gitText({ cwd: repo, git, args, limits: { gitStdout: limit, gitStderr: 64 * 1024 }, allowFailure: true }).trim();
  const top = text(["rev-parse", "--show-toplevel"], 4096);
  if (!top || pathKey(realpathSync(repo)) !== pathKey(realpathSync(resolve(repo, top)))) fail("candidate_root_invalid");
  const objectFormat = text(["rev-parse", "--show-object-format"], 128);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") fail("candidate_root_invalid");
  const head = text(["rev-parse", "--verify", "HEAD^{commit}"], 128);
  if (!SHA.test(head) || (expectedHead !== undefined && head !== expectedHead)) fail("candidate_head_mismatch");
  if (text(["rev-parse", "--is-shallow-repository"], 128) !== "false") fail("candidate_root_invalid");
  const common = text(["rev-parse", "--git-common-dir"], 4096);
  const objects = text(["rev-parse", "--git-path", "objects"], 4096);
  if (!common || !objects) fail("candidate_root_invalid");
  const commonIdentity = gitDirectoryIdentity(repo, common);
  const objectsIdentity = gitDirectoryIdentity(repo, objects);
  const branch = text(["symbolic-ref", "--quiet", "--short", "HEAD"], 1024);
  return { objectFormat, head, common, objects, commonIdentity, objectsIdentity, branch };
}

function expectedStatusMap(definitions) {
  const map = new Map();
  for (const definition of definitions) {
    if (!definition || !portableRelativePath(definition.path) || map.has(definition.path)) fail("candidate_not_clean");
    map.set(definition.path, definition.status);
  }
  return map;
}

function assertExpectedStatus(status, definitions) {
  const expected = expectedStatusMap(definitions);
  if (status.records.length !== expected.size) fail("candidate_not_clean");
  for (const record of status.records) {
    const kind = expected.get(record.path);
    if (!kind) fail("candidate_not_clean");
    if (kind === "added" && record.kind !== "untracked") fail("candidate_not_clean");
    if (kind === "modified" && (record.kind !== "ordinary" || record.xy !== ".M")) fail("candidate_not_clean");
    expected.delete(record.path);
  }
  if (expected.size !== 0) fail("candidate_not_clean");
}

function pathInventoryEntry(record, definition, baseRecord) {
  return {
    path: definition.path,
    partition: definition.partition,
    status: definition.status,
    mode: record.mode,
    type: record.type,
    bytes: record.size,
    sha256: record.sha256,
    base_object_id: baseRecord?.objectId ?? null,
    base_sha256: baseRecord?.sha256 ?? null,
  };
}

/** Freeze a fixed path inventory without selecting any paths from candidate data. */
function supportMaximum(path, maximum) {
  return path.endsWith(".go") || path === "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json"
    ? Math.min(maximum, 2 * 1024 * 1024)
    : maximum;
}

export function freezeSupportInventory({ repo, git = undefined, base, head, predecessorPaths, currentPaths, maximum = 4 * 1024 * 1024 } = {}) {
  const identityBefore = captureGitIdentity({ repo, git, expectedHead: head });
  const statusBefore = readPorcelainStatus({ repo, git });
  assertExpectedStatus(statusBefore, currentPaths);
  const predecessorDefinitions = predecessorPaths.map((path) => ({ path, partition: "predecessor", status: "clean" }));
  const currentDefinitions = currentPaths.map((entry) => ({ ...entry, partition: "current" }));
  const all = [...predecessorDefinitions, ...currentDefinitions];
  if (new Set(all.map((entry) => entry.path)).size !== all.length) fail("candidate_not_clean");

  const baseRecords = new Map();
  for (const definition of all) {
    const record = readBlobAtCommit({ repo, git, commit: base, path: definition.path, maximum: supportMaximum(definition.path, maximum), allowAbsent: definition.partition === "current" && definition.status === "added" });
    if (definition.partition === "predecessor" && !record) fail("trusted_blob_invalid");
    if (definition.status === "added" && record) fail("candidate_blob_invalid");
    if (definition.status === "modified" && !record) fail("candidate_blob_invalid");
    baseRecords.set(definition.path, record);
  }

  const pathEntries = [];
  for (const definition of all) {
    const working = readStableWorkingFile(repo, definition.path, supportMaximum(definition.path, maximum));
    const baseRecord = baseRecords.get(definition.path);
    if (definition.partition === "predecessor" && (!baseRecord || !working.bytes.equals(baseRecord.bytes))) fail("candidate_blob_invalid");
    pathEntries.push(pathInventoryEntry(working, definition, baseRecord));
  }

  const identityAfter = captureGitIdentity({ repo, git, expectedHead: head });
  const statusAfter = readPorcelainStatus({ repo, git });
  assertExpectedStatus(statusAfter, currentPaths);
  if (canonicalJSONString(identityBefore) !== canonicalJSONString(identityAfter) || !statusBefore.bytes.equals(statusAfter.bytes)) fail("candidate_inventory_changed");

  const inventory = {
    format: "pi-sampler.delivery-v2-support-inventory",
    version: 1,
    base_sha: base,
    head_sha: head,
    git: {
      object_format: identityBefore.objectFormat,
      common_sha256: sha256Bytes(canonicalJSONLine(identityBefore.commonIdentity)),
      objects_sha256: sha256Bytes(canonicalJSONLine(identityBefore.objectsIdentity)),
      branch: identityBefore.branch,
    },
    status: {
      format: "git-porcelain-v2",
      index: "clean",
      sha256: statusBefore.sha256,
      records: statusBefore.records.map(({ kind, xy, path }) => ({ kind, xy, path })),
    },
    partition: {
      predecessor: predecessorPaths.slice(),
      current: currentPaths.map(({ path, status }) => ({ path, status })),
    },
    paths: pathEntries,
  };
  if (inventory.paths.length !== 15 || inventory.partition.predecessor.length !== 10 || inventory.partition.current.length !== 5) fail("candidate_blob_invalid");
  return Object.freeze(inventory);
}

export function sameInventory(left, right) {
  return canonicalJSONString(left) === canonicalJSONString(right);
}

export function runBoundedCommand({ executable, args, reportArgv, cwd, env, timeout = DEFAULT_LIMITS.commandTimeout, maxStdout = DEFAULT_LIMITS.commandStdout, maxStderr = DEFAULT_LIMITS.commandStderr } = {}) {
  if (typeof executable !== "string" || !isAbsolute(executable) || !Array.isArray(args) || !cwd) fail("test_failed");
  let result;
  try {
    result = spawnSync(executable, args, { cwd, shell: false, windowsHide: true, encoding: "buffer", timeout, maxBuffer: Math.max(maxStdout, maxStderr), env });
  } catch (error) {
    return { argv: reportArgv ?? args.slice(), status: null, ok: false, stdoutSha256: sha256Bytes(Buffer.alloc(0)), stderrSha256: sha256Bytes(Buffer.alloc(0)), error: error.code ?? "spawn_failed" };
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  const oversized = stdout.length > maxStdout || stderr.length > maxStderr || result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  return {
    argv: reportArgv ?? args.slice(),
    status: result.status,
    ok: result.status === 0 && !result.error && !oversized,
    stdoutSha256: sha256Bytes(stdout),
    stderrSha256: sha256Bytes(stderr),
  };
}

/** Execute already-selected commands; command selection remains in the entry module. */
export function runSupportCommands({ cwd, commands, env, limits = DEFAULT_LIMITS } = {}) {
  if (!Array.isArray(commands) || commands.length !== 3) fail("test_failed");
  const results = [];
  for (const command of commands) {
    const result = runBoundedCommand({
      ...command,
      cwd,
      env,
      timeout: limits.commandTimeout ?? DEFAULT_LIMITS.commandTimeout,
      maxStdout: limits.commandStdout ?? DEFAULT_LIMITS.commandStdout,
      maxStderr: limits.commandStderr ?? DEFAULT_LIMITS.commandStderr,
    });
    results.push(result);
    if (!result.ok || result.status !== 0) break;
  }
  return results;
}

export const SUPPORT_CORE_LIMITS = DEFAULT_LIMITS;
