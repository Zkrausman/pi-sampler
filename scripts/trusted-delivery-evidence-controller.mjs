/**
 * Functional-only support for the inert delivery-evidence/v2 runtime.
 *
 * This entry module owns mode and fixed path selection.  Support authenticates
 * the current Slice 1B checkout and its uncommitted five-path Slice 1C before
 * importing the candidate core or spawning any test process.  It never writes
 * repository, tracker, activation, or review state.
 */
import { accessSync, constants as fsConstants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, fileURLToPath } from "node:url";

export const TRUSTED_DELIVERY_CONTROLLER_FORMAT = "pi-sampler.delivery-v2-controller";
export const TRUSTED_DELIVERY_CONTROLLER_VERSION = 1;
export const DELIVERY_V2_SUPPORT_AUTHORITY = "functional-only";
export const DELIVERY_V2_SUPPORT_CAN_GRANT_AUTHORITY = false;
export const DELIVERY_V2_SUPPORT_REPORT_FORMAT = "pi-sampler.delivery-v2-support-report";
export const DELIVERY_V2_SUPPORT_REPORT_VERSION = 1;

export const PLAN_AMENDMENT_4_SHA = "047551593a6277c4b18d3be699be9e7e85d78a1e";
export const SLICE1A_SHA = "57d8bc6a98bdffa4b316da9f67d49df86554f0e8";
export const SLICE1B_SHA = "cd1eb4581eac403c2e0f3eaec6b0607c6853af6a";

export const TRUSTED_DELIVERY_PATHS = Object.freeze({
  manifestContract: "contracts/implementation-plan-manifest-v2.mjs",
  manifestValidator: "scripts/validate-implementation-plan.mjs",
  matrixSchema: "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json",
  profile: "profiles/pi-sampler.json",
  profileSchema: "profiles/project-profile.schema.json",
  acceptanceGo: "governance/pkg/deliveryevidence/acceptance_v2.go",
  acceptanceWire: "governance/pkg/deliveryevidence/acceptance_v2_wire.go",
  posixRoot: "governance/pkg/deliveryevidence/external_root_posix.go",
  windowsRoot: "governance/pkg/deliveryevidence/external_root_windows.go",
  validatorMain: "governance/cmd/delivery-evidence-validator/main.go",
  controller: "scripts/trusted-delivery-evidence-controller.mjs",
  controllerCore: "scripts/trusted-delivery-evidence-controller-core.mjs",
});

export const SUPPORT_PREDECESSOR_PATHS = Object.freeze([
  "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json",
  "governance/pkg/deliveryevidence/acceptance_v2.go",
  "governance/pkg/deliveryevidence/acceptance_v2_wire.go",
  "governance/pkg/deliveryevidence/external_root_posix.go",
  "governance/pkg/deliveryevidence/external_root_windows.go",
  "governance/cmd/delivery-evidence-validator/main.go",
  "scripts/validate-delivery-schemas.mjs",
  "governance/pkg/deliveryevidence/validator_test.go",
  "tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json",
  "tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md",
]);

export const SUPPORT_CURRENT_PATHS = Object.freeze([
  Object.freeze({ path: "scripts/trusted-delivery-evidence-controller.mjs", status: "added" }),
  Object.freeze({ path: "scripts/trusted-delivery-evidence-controller-core.mjs", status: "added" }),
  Object.freeze({ path: "tests/delivery-acceptance-v2.test.mjs", status: "added" }),
  Object.freeze({ path: "tests/delivery-acceptance.test.mjs", status: "modified" }),
  Object.freeze({ path: "package.json", status: "modified" }),
]);

export const SUPPORT_OPERATIONAL_PATHS = Object.freeze([
  "scripts/trusted-delivery-evidence-controller.mjs",
  "scripts/trusted-delivery-evidence-controller-core.mjs",
  "tests/delivery-acceptance.test.mjs",
  "tests/delivery-acceptance-v2.test.mjs",
  "scripts/run-governance-tests.mjs",
  "package.json",
]);

export const TRUSTED_DELIVERY_LIMITS = Object.freeze({
  argumentBytes: 4096,
  pathBytes: 1024,
  matrixBytes: 2 * 1024 * 1024,
  controllerBytes: 4 * 1024 * 1024,
  trustedBlobBytes: 4 * 1024 * 1024,
  stdoutBytes: 8 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  commandTimeoutMs: 900_000,
  gitTimeoutMs: 30_000,
});

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TICKET = /^[A-Z][A-Z0-9]+-[0-9]+$/;
const SAFE_PATH = /^(?![\s\S]*[^A-Za-z0-9._/+,-])(?!\/)(?![A-Za-z]:)(?!.*\/\/)(?!.*:)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*[. ](?:\/|$))(?!.*(?:^|\/)(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Ll][Oo][Cc][Kk]\$|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.[^/\\]*)?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._+,-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+,-]*)*$/;
const WINDOWS_GIT = Object.freeze(["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe"]);
const POSIX_GIT = Object.freeze(["/usr/bin/git", "/usr/local/bin/git"]);
const CONTROLLER_ERROR_ORDER = new Set([
  "usage_invalid", "mode_invalid", "trusted_base_invalid", "trusted_git_failure", "trusted_blob_invalid",
  "candidate_root_invalid", "candidate_head_mismatch", "candidate_not_clean", "candidate_blob_invalid",
  "candidate_inventory_changed", "test_failed", "activation_absent",
]);

class DeliveryControllerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "DeliveryControllerError";
    this.code = code;
  }
}
function fail(code, message = code) { throw new DeliveryControllerError(code, message); }
function bytes(value) { return Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), "utf8"); }
function byteLength(value) { return Buffer.byteLength(value, "utf8"); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
function assertString(value, code = "usage_invalid", maximum = TRUSTED_DELIVERY_LIMITS.argumentBytes) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || byteLength(value) > maximum) fail(code);
  return value;
}
function assertCommit(value, code = "usage_invalid") {
  assertString(value, code, 64);
  if (!SHA.test(value)) fail(code);
  return value;
}
function assertDigest(value, code = "usage_invalid") {
  assertString(value, code, 64);
  if (!DIGEST.test(value)) fail(code);
  return value;
}
function assertNode24() {
  if (Number.parseInt(process.versions.node.split(".")[0], 10) !== 24) fail("test_failed");
}
function pathKey(value) { return String(value).replaceAll("/", "\\").toLowerCase(); }
function inside(parent, child) {
  const rest = relative(resolve(parent), resolve(child));
  return rest === "" || (rest !== ".." && !rest.startsWith("..\\") && !isAbsolute(rest));
}
function redirected(info) { return Boolean(info?.isSymbolicLink?.() || info?.isReparsePoint?.() || info?.reparsePoint === true); }
function infoIdentity(info) {
  return ["dev", "ino", "size", "mtimeNs", "mtimeMs", "mode", "nlink"].map((key) => `${key}=${info?.[key] === undefined ? "" : String(info[key])}`).join(";");
}
function canonicalDirectory(directory, code = "candidate_root_invalid") {
  assertString(directory, code, TRUSTED_DELIVERY_LIMITS.pathBytes);
  if (!isAbsolute(directory)) fail(code);
  let info, canonical;
  try { info = lstatSync(directory); canonical = realpathSync(directory); } catch { fail(code); }
  if (!info.isDirectory() || redirected(info) || pathKey(canonical) !== pathKey(resolve(directory))) fail(code);
  return canonical;
}
function portablePath(value, maximum = 256) {
  return typeof value === "string" && byteLength(value) <= maximum && SAFE_PATH.test(value) && value.split("/").every((part) => byteLength(part) <= 255);
}
function fixedExecutable(candidate, platform = process.platform, fileSystem = undefined) {
  const fs = fileSystem ?? {};
  const lstat = fs.lstatSync ?? lstatSync;
  const realpath = fs.realpathSync ?? realpathSync;
  const access = fs.accessSync ?? accessSync;
  let info, canonical;
  try { info = lstat(candidate); canonical = realpath(candidate); } catch { return false; }
  if (!info?.isFile?.() || redirected(info) || pathKey(canonical) !== pathKey(candidate)) return false;
  if (platform !== "win32") {
    try { access(candidate, fsConstants.X_OK); } catch { return false; }
  }
  return true;
}

/** Locate Git at a fixed platform path; PATH and caller selectors are ignored. */
export function locateFixedGit(platform = process.platform, fileSystem = undefined) {
  const candidates = platform === "win32" ? WINDOWS_GIT : POSIX_GIT;
  for (const candidate of candidates) if (fixedExecutable(candidate, platform, fileSystem)) return candidate;
  fail("test_failed");
}

function commandEnvironment(git = undefined) {
  const env = {
    LC_ALL: "C", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  for (const name of ["SystemRoot", "WINDIR"]) {
    const pair = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (pair) env[pair[0]] = pair[1];
  }
  const dirs = process.platform === "win32"
    ? [git ? dirname(git) : null, dirname(process.execPath), "C:\\Windows\\System32", "C:\\Windows"]
    : [git ? dirname(git) : null, dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"];
  env.PATH = dirs.filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(process.platform === "win32" ? ";" : ":");
  return env;
}

function runGit(repo, args, { maxStdout = TRUSTED_DELIVERY_LIMITS.stdoutBytes, maxStderr = TRUSTED_DELIVERY_LIMITS.stderrBytes, allowFailure = true } = {}) {
  let git;
  try { git = locateFixedGit(); } catch { if (!allowFailure) fail("trusted_git_failure"); return { ok: false, status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
  let result;
  try {
    result = spawnSync(git, [
      "--no-pager", "--no-replace-objects", "--no-optional-locks",
      "-c", "trace2.eventTarget=", "-c", "trace2.normalTarget=", "-c", "trace2.perfTarget=",
      "-c", "color.ui=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      ...args,
    ], { cwd: repo, shell: false, windowsHide: true, encoding: "buffer", timeout: TRUSTED_DELIVERY_LIMITS.gitTimeoutMs, maxBuffer: Math.max(maxStdout, maxStderr), env: commandEnvironment(git) });
  } catch (error) {
    if (!allowFailure) fail("trusted_git_failure", error.message);
    return { ok: false, status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error };
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  const oversized = stdout.length > maxStdout || stderr.length > maxStderr || result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  if (oversized && !allowFailure) fail("trusted_git_failure");
  const answer = { ok: result.status === 0 && !result.error && !oversized, status: result.status, stdout, stderr, error: result.error, oversized };
  if (!answer.ok && !allowFailure) fail("trusted_git_failure");
  return answer;
}
function gitText(repo, args, options = {}) {
  const result = runGit(repo, args, options);
  if (!result.ok) return "";
  const value = result.stdout.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(result.stdout)) fail("trusted_git_failure");
  return value;
}
function exactCommit(repo, commit, code) {
  assertCommit(commit, code);
  const resolved = gitText(repo, ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`], { maxStdout: 128 });
  const type = gitText(repo, ["cat-file", "-t", commit], { maxStdout: 128 });
  if (resolved.trim() !== commit || type.trim() !== "commit") fail(code);
}
function workingPath(root, path, code = "candidate_blob_invalid") {
  if (!portablePath(path)) fail(code);
  const absolute = resolve(root, ...path.split("/"));
  if (!inside(root, absolute)) fail(code);
  return absolute;
}
function readStableWorking(root, path, maximum, code = "candidate_blob_invalid") {
  const absolute = workingPath(root, path, code);
  let before, canonical;
  try { before = lstatSync(absolute); canonical = realpathSync(absolute); } catch { fail(code); }
  if (!before.isFile() || redirected(before) || pathKey(canonical) !== pathKey(absolute) || before.size > maximum) fail(code);
  if (process.platform !== "win32" && (before.mode & 0o777) !== 0o644) fail(code);
  let content;
  try { content = readFileSync(absolute); } catch { fail(code); }
  if (content.length !== before.size || content.length > maximum) fail(code);
  let after;
  try { after = lstatSync(absolute); } catch { fail("candidate_inventory_changed"); }
  if (!after.isFile() || redirected(after) || infoIdentity(before) !== infoIdentity(after)) fail("candidate_inventory_changed");
  return { path, mode: "100644", type: "blob", size: content.length, bytes: content, sha256: sha256Bytes(content) };
}
function parseTreeEntry(output, expectedPath) {
  const text = output.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(output)) fail("trusted_blob_invalid");
  const entries = text.split("\0").filter(Boolean);
  if (entries.length !== 1) fail("trusted_blob_invalid");
  const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)$/.exec(entries[0]);
  if (!match || match[4] !== expectedPath) fail("trusted_blob_invalid");
  return { mode: match[1], type: match[2], objectId: match[3], path: match[4] };
}
function readTrustedBlobRecord(repo, commit, path, maximum = TRUSTED_DELIVERY_LIMITS.trustedBlobBytes, allowAbsent = false) {
  assertCommit(commit, "trusted_base_invalid");
  if (!portablePath(path)) fail("trusted_blob_invalid");
  const tree = runGit(repo, ["ls-tree", "-z", "--full-tree", commit, "--", path], { maxStdout: 64 * 1024 });
  if (!tree.ok) fail("trusted_blob_invalid");
  if (tree.stdout.length === 0) {
    if (allowAbsent) return null;
    fail("trusted_blob_invalid");
  }
  const entry = parseTreeEntry(tree.stdout, path);
  if (entry.mode !== "100644" || entry.type !== "blob") fail("trusted_blob_invalid");
  const type = gitText(repo, ["cat-file", "-t", entry.objectId], { maxStdout: 128 }).trim();
  const sizeText = gitText(repo, ["cat-file", "-s", entry.objectId], { maxStdout: 128 }).trim();
  if (type !== "blob" || !/^\d+$/.test(sizeText)) fail("trusted_blob_invalid");
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) fail("trusted_blob_invalid");
  const content = runGit(repo, ["cat-file", "blob", entry.objectId], { maxStdout: maximum + 1 });
  if (!content.ok || content.stdout.length !== size || content.stdout.length > maximum) fail("trusted_blob_invalid");
  const objectHash = createHash(entry.objectId.length === 64 ? "sha256" : "sha1").update(`blob ${size}\0`, "utf8").update(content.stdout).digest("hex");
  if (objectHash !== entry.objectId) fail("trusted_blob_invalid");
  return { ...entry, size, content: content.stdout, bytes: content.stdout, sha256: sha256Bytes(content.stdout) };
}

/** Read one exact regular 100644 blob from an authenticated commit. */
export function readTrustedBlob(...args) {
  const input = isRecord(args[0]) ? args[0] : { repo: args[0], commit: args[1], path: args[2], maximum: args[3] };
  const record = readTrustedBlobRecord(input.repo ?? input.trustedWorktree, input.commit ?? input.base, input.path ?? input.relativePath, input.maximum ?? TRUSTED_DELIVERY_LIMITS.trustedBlobBytes, input.allowAbsent === true);
  return record && { ...record };
}

function parseStatusToken(token) {
  if (token.startsWith("? ")) return { kind: "untracked", xy: "??", path: token.slice(2) };
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
function readStatus(repo) {
  const result = runGit(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { maxStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes });
  if (!result.ok) fail("candidate_not_clean");
  const text = result.stdout.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(result.stdout)) fail("candidate_not_clean");
  const records = text.split("\0").filter(Boolean).map(parseStatusToken);
  if (new Set(records.map((record) => record.path)).size !== records.length) fail("candidate_not_clean");
  return { bytes: result.stdout, sha256: sha256Bytes(result.stdout), records };
}
function assertStatus(status, definitions) {
  const expected = new Map(definitions.map((definition) => [definition.path, definition.status]));
  if (expected.size !== definitions.length || status.records.length !== definitions.length) fail("candidate_not_clean");
  for (const record of status.records) {
    const wanted = expected.get(record.path);
    if (!wanted) fail("candidate_not_clean");
    if (wanted === "added" && record.kind !== "untracked") fail("candidate_not_clean");
    if (wanted === "modified" && (record.kind !== "ordinary" || record.xy !== ".M")) fail("candidate_not_clean");
    expected.delete(record.path);
  }
  if (expected.size) fail("candidate_not_clean");
}
function gitDirectoryIdentity(repo, value) {
  const lexical = resolve(repo, value);
  let info;
  let canonical;
  try { info = lstatSync(lexical); canonical = realpathSync(lexical); } catch { fail("candidate_root_invalid"); }
  if (!info.isDirectory() || redirected(info) || pathKey(canonical) !== pathKey(lexical)) fail("candidate_root_invalid");
  return { path: pathKey(canonical), identity: { dev: String(info.dev ?? ""), ino: String(info.ino ?? "") } };
}
function gitIdentity(repo, expectedHead) {
  const text = (args, maxStdout = 4096) => gitText(repo, args, { maxStdout }).trim();
  const top = text(["rev-parse", "--show-toplevel"]);
  let canonicalTop;
  try { canonicalTop = realpathSync(resolve(repo, top)); } catch { fail("candidate_root_invalid"); }
  if (!top || pathKey(canonicalTop) !== pathKey(resolve(repo))) fail("candidate_root_invalid");
  const objectFormat = text(["rev-parse", "--show-object-format"], 128);
  const head = text(["rev-parse", "--verify", "HEAD^{commit}"], 128);
  if (!["sha1", "sha256"].includes(objectFormat) || !SHA.test(head)) fail("candidate_root_invalid");
  if (expectedHead !== undefined && head !== expectedHead) fail("candidate_head_mismatch");
  exactCommit(repo, head, "candidate_head_mismatch");
  if (text(["rev-parse", "--is-shallow-repository"], 128) !== "false") fail("candidate_root_invalid");
  const common = text(["rev-parse", "--git-common-dir"]);
  const objects = text(["rev-parse", "--git-path", "objects"]);
  if (!common || !objects) fail("candidate_root_invalid");
  const commonIdentity = gitDirectoryIdentity(repo, common);
  const objectsIdentity = gitDirectoryIdentity(repo, objects);
  for (const name of ["shallow", "info/grafts", "objects/info/alternates"]) {
    const special = text(["rev-parse", "--git-path", name]);
    if (!special) fail("candidate_root_invalid");
    try { if (lstatSync(resolve(repo, special))) fail("candidate_root_invalid"); } catch (error) { if (error instanceof DeliveryControllerError) throw error; if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) fail("candidate_root_invalid"); }
  }
  if (text(["for-each-ref", "refs/replace", "--format=%(refname)"], 4096)) fail("candidate_root_invalid");
  const branch = text(["symbolic-ref", "--quiet", "--short", "HEAD"], 1024);
  return { objectFormat, head, common, objects, commonIdentity, objectsIdentity, branch };
}
function assertAncestry(repo, head) {
  for (const ancestor of [PLAN_AMENDMENT_4_SHA, SLICE1A_SHA]) {
    exactCommit(repo, ancestor, "trusted_base_invalid");
    const result = runGit(repo, ["merge-base", "--is-ancestor", ancestor, head], { maxStdout: 128 });
    if (!result.ok) fail("trusted_base_invalid");
  }
}
function maxFor(path) { return path.endsWith(".go") || path === TRUSTED_DELIVERY_PATHS.matrixSchema ? 2 * 1024 * 1024 : TRUSTED_DELIVERY_LIMITS.controllerBytes; }
function inventoryEntry(working, definition, base) {
  return { path: definition.path, partition: definition.partition, status: definition.status, mode: working.mode, type: working.type, bytes: working.size, sha256: working.sha256, base_object_id: base?.objectId ?? null, base_sha256: base?.sha256 ?? null };
}
function sameInventory(left, right) { return canonicalJSONString(left) === canonicalJSONString(right); }

function expectedSupportStatus(path, status) {
  return { path, kind: status === "added" ? "untracked" : "ordinary", xy: status === "added" ? "??" : ".M" };
}

/** Validate the fixed support inventory shape before any candidate code runs. */
export function validateSupportInventory(inventory, base = SLICE1B_SHA, head = SLICE1B_SHA) {
  if (!isRecord(inventory) || inventory.format !== "pi-sampler.delivery-v2-support-inventory" || inventory.version !== 1) fail("candidate_blob_invalid");
  if (inventory.base_sha !== base || inventory.head_sha !== head) fail("candidate_inventory_changed");
  if (!isRecord(inventory.git) || !["sha1", "sha256"].includes(inventory.git.object_format) || !DIGEST.test(inventory.git.common_sha256) || !DIGEST.test(inventory.git.objects_sha256) || typeof inventory.git.branch !== "string") fail("candidate_blob_invalid");
  if (!isRecord(inventory.status) || inventory.status.format !== "git-porcelain-v2" || inventory.status.index !== "clean" || !DIGEST.test(inventory.status.sha256) || !Array.isArray(inventory.status.records)) fail("candidate_not_clean");
  if (!isRecord(inventory.partition) || canonicalJSONString(inventory.partition.predecessor) !== canonicalJSONString(SUPPORT_PREDECESSOR_PATHS) || canonicalJSONString(inventory.partition.current) !== canonicalJSONString(SUPPORT_CURRENT_PATHS)) fail("candidate_blob_invalid");
  const definitions = [
    ...SUPPORT_PREDECESSOR_PATHS.map((path) => ({ path, partition: "predecessor", status: "clean" })),
    ...SUPPORT_CURRENT_PATHS.map((entry) => ({ ...entry, partition: "current" })),
  ];
  if (!Array.isArray(inventory.paths) || inventory.paths.length !== definitions.length) fail("candidate_blob_invalid");
  for (let index = 0; index < definitions.length; index += 1) {
    const expected = definitions[index];
    const actual = inventory.paths[index];
    if (!isRecord(actual) || actual.path !== expected.path || actual.partition !== expected.partition) fail("candidate_blob_invalid");
    if (actual.status !== expected.status) fail(expected.partition === "predecessor" ? "candidate_not_clean" : "candidate_blob_invalid");
    if (actual.mode !== "100644" || actual.type !== "blob" || !Number.isSafeInteger(actual.bytes) || actual.bytes < 0 || !DIGEST.test(actual.sha256)) fail("candidate_blob_invalid");
    if (expected.partition === "predecessor") {
      if (!SHA.test(String(actual.base_object_id)) || !DIGEST.test(actual.base_sha256) || actual.sha256 !== actual.base_sha256) fail("candidate_blob_invalid");
    } else if (expected.status === "added") {
      if (actual.base_object_id !== null || actual.base_sha256 !== null) fail("candidate_blob_invalid");
    } else if (!SHA.test(String(actual.base_object_id)) || !DIGEST.test(actual.base_sha256)) fail("candidate_blob_invalid");
  }
  const expectedStatus = new Map(SUPPORT_CURRENT_PATHS.map(({ path, status }) => [path, expectedSupportStatus(path, status)]));
  if (inventory.status.records.length !== expectedStatus.size) fail("candidate_not_clean");
  const seen = new Set();
  for (const actual of inventory.status.records) {
    if (!isRecord(actual) || seen.has(actual.path)) fail("candidate_not_clean");
    const expected = expectedStatus.get(actual.path);
    if (!expected || actual.kind !== expected.kind || actual.xy !== expected.xy) fail("candidate_not_clean");
    seen.add(actual.path);
  }
  if (seen.size !== expectedStatus.size) fail("candidate_not_clean");
  return inventory;
}
function freezeSupportInventory(repo, base, head) {
  const identityBefore = gitIdentity(repo, head);
  const statusBefore = readStatus(repo);
  assertStatus(statusBefore, SUPPORT_CURRENT_PATHS);
  const definitions = [
    ...SUPPORT_PREDECESSOR_PATHS.map((path) => ({ path, partition: "predecessor", status: "clean" })),
    ...SUPPORT_CURRENT_PATHS.map((entry) => ({ ...entry, partition: "current" })),
  ];
  const baseRecords = new Map();
  for (const definition of definitions) {
    const baseRecord = readTrustedBlobRecord(repo, base, definition.path, maxFor(definition.path), definition.partition === "current" && definition.status === "added");
    if (definition.partition === "predecessor" && !baseRecord) fail("trusted_blob_invalid");
    if (definition.status === "added" && baseRecord) fail("candidate_blob_invalid");
    if (definition.status === "modified" && !baseRecord) fail("candidate_blob_invalid");
    baseRecords.set(definition.path, baseRecord);
  }
  const paths = definitions.map((definition) => inventoryEntry(readStableWorking(repo, definition.path, maxFor(definition.path)), definition, baseRecords.get(definition.path)));
  for (let index = 0; index < SUPPORT_PREDECESSOR_PATHS.length; index += 1) {
    const entry = paths[index];
    const baseRecord = baseRecords.get(entry.path);
    if (!baseRecord || entry.sha256 !== baseRecord.sha256 || entry.mode !== "100644" || entry.type !== "blob") fail("candidate_blob_invalid");
  }
  const identityAfter = gitIdentity(repo, head);
  const statusAfter = readStatus(repo);
  assertStatus(statusAfter, SUPPORT_CURRENT_PATHS);
  if (canonicalJSONString(identityBefore) !== canonicalJSONString(identityAfter) || !statusBefore.bytes.equals(statusAfter.bytes)) fail("candidate_inventory_changed");
  const inventory = {
    format: "pi-sampler.delivery-v2-support-inventory", version: 1, base_sha: base, head_sha: head,
    git: { object_format: identityBefore.objectFormat, common_sha256: sha256Bytes(canonicalJSONLine(identityBefore.commonIdentity)), objects_sha256: sha256Bytes(canonicalJSONLine(identityBefore.objectsIdentity)), branch: identityBefore.branch },
    status: { format: "git-porcelain-v2", index: "clean", sha256: statusBefore.sha256, records: statusBefore.records.map(({ kind, xy, path }) => ({ kind, xy, path })) },
    partition: { predecessor: SUPPORT_PREDECESSOR_PATHS.slice(), current: SUPPORT_CURRENT_PATHS.map(({ path, status }) => ({ path, status })) },
    paths,
  };
  if (paths.length !== 15 || inventory.partition.predecessor.length !== 10 || inventory.partition.current.length !== 5) fail("candidate_blob_invalid");
  validateSupportInventory(inventory, base, head);
  return deepFreeze(inventory);
}

function npmCommand() {
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  try { if (lstatSync(cli).isFile()) return { executable: process.execPath, args: [cli, "test"], reportArgv: ["npm", "test"] }; } catch { /* use the fixed sibling fallback below */ }
  const executable = process.platform === "win32" ? "C:\\Program Files\\nodejs\\npm.cmd" : "/usr/bin/npm";
  return { executable, args: ["test"], reportArgv: ["npm", "test"] };
}
function supportCommands() {
  return [
    { executable: process.execPath, args: ["--test", "tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs"], reportArgv: ["node", "--test", "tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs"] },
    { executable: process.execPath, args: ["scripts/run-governance-tests.mjs"], reportArgv: ["node", "scripts/run-governance-tests.mjs"] },
    npmCommand(),
  ];
}
function testReport(commands) { return { format: "pi-sampler.delivery-v2-support-tests", version: 1, commands }; }
function supportReport(base, head, commands, before, after) {
  return {
    format: DELIVERY_V2_SUPPORT_REPORT_FORMAT, version: DELIVERY_V2_SUPPORT_REPORT_VERSION, status: DELIVERY_V2_SUPPORT_AUTHORITY,
    authority: DELIVERY_V2_SUPPORT_CAN_GRANT_AUTHORITY, base_sha: base, head_sha: head, paths: SUPPORT_OPERATIONAL_PATHS.slice(),
    test_report_sha256: sha256Bytes(canonicalJSONLine(testReport(commands))),
    repository_inventory_sha256: sha256Bytes(canonicalJSONLine({ before, after })),
  };
}
export function buildSupportReport(base, head, commands, before = {}, after = before) { return supportReport(base, head, commands, before, after); }

async function runSupport(options, dependencies = {}) {
  assertNode24();
  const resolveRoot = dependencies.canonicalDirectory ?? canonicalDirectory;
  const identify = dependencies.gitIdentity ?? gitIdentity;
  const verifyCommit = dependencies.verifyCommit ?? exactCommit;
  const verifyAncestry = dependencies.assertAncestry ?? assertAncestry;
  const freeze = dependencies.freezeInventory ?? (({ repo, base, head }) => freezeSupportInventory(repo, base, head));
  const importCore = dependencies.importCore ?? ((url) => import(url));
  const candidateRoot = resolveRoot(options.candidateRoot ?? process.cwd());
  const identity = identify(candidateRoot, options.expectedHead);
  const base = options.trustedBase ?? identity.head;
  assertCommit(base, "trusted_base_invalid");
  if (base !== identity.head || identity.head !== SLICE1B_SHA) fail("trusted_base_invalid");
  verifyCommit(candidateRoot, base, "trusted_base_invalid");
  verifyAncestry(candidateRoot, identity.head);
  const before = deepFreeze(validateSupportInventory(freeze({ repo: candidateRoot, base, head: identity.head }), base, identity.head));
  const frozenCheck = freeze({ repo: candidateRoot, base, head: identity.head });
  validateSupportInventory(frozenCheck, base, identity.head);
  if (!sameInventory(before, frozenCheck)) fail("candidate_inventory_changed");

  const coreUrl = pathToFileURL(join(candidateRoot, "scripts", "trusted-delivery-evidence-controller-core.mjs")).href;
  let core;
  try { core = await importCore(coreUrl); } catch { fail("candidate_blob_invalid"); }
  if (typeof core.runSupportCommands !== "function" || typeof core.freezeSupportInventory !== "function") fail("candidate_blob_invalid");
  let commands;
  if (dependencies.runCommands) commands = await dependencies.runCommands({ candidateRoot, commands: supportCommands(), before });
  else commands = core.runSupportCommands({ cwd: candidateRoot, commands: supportCommands(), env: commandEnvironment(), limits: { commandTimeout: TRUSTED_DELIVERY_LIMITS.commandTimeoutMs, commandStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes, commandStderr: TRUSTED_DELIVERY_LIMITS.stderrBytes } });
  if (!Array.isArray(commands) || commands.length !== 3 || commands.some((command) => !command.ok || command.status !== 0)) fail("test_failed");
  const after = core.freezeSupportInventory({ repo: candidateRoot, base, head: identity.head, predecessorPaths: SUPPORT_PREDECESSOR_PATHS, currentPaths: SUPPORT_CURRENT_PATHS, maximum: TRUSTED_DELIVERY_LIMITS.controllerBytes });
  validateSupportInventory(after, base, identity.head);
  if (!sameInventory(before, after)) fail("candidate_inventory_changed");
  return supportReport(base, identity.head, commands, before, after);
}

export async function runSupportForTest(options = {}, dependencies = {}) {
  return runSupport(Object.freeze({ ...options }), dependencies);
}

/** Build the canonical facts object consumed by the Go v2 evaluator. */
export function buildNormalizedFacts(matrix) {
  if (!isRecord(matrix)) fail("usage_invalid");
  const facts = {
    format: "pi-sampler.delivery-normalized-facts", version: 1, repository: matrix.repository, ticketId: matrix.ticket_id,
    ticketRevision: matrix.ticket_revision, profilePath: matrix.profile_path, profileSha256: matrix.profile_sha256,
    baseSha: matrix.base_sha, headSha: matrix.head_sha, pullRequestNumber: matrix.pull_request_number, planPath: matrix.plan_path,
    planSha256: matrix.plan_sha256, manifestPath: matrix.manifest_path, manifestSha256: matrix.manifest_sha256,
    manifestSchemaVersion: matrix.manifest_schema_version, manifestContractSha256: matrix.manifest_contract_sha256,
    manifestValidatorSha256: matrix.manifest_validator_sha256, matrixContractSha256: matrix.matrix_contract_sha256,
    policySha256: matrix.policy_sha256, evaluationScope: matrix.evaluation_scope,
    rows: (Array.isArray(matrix.rows) ? matrix.rows : []).map((row) => ({ id: row.id, acceptanceClass: row.acceptance_class, requirement: row.requirement })),
  };
  const encoded = canonicalJSONLine(facts);
  return { facts, bytes: encoded, factsSha256: sha256Bytes(Buffer.concat([Buffer.from("pi-sampler.delivery-normalized-facts/v1\0", "utf8"), encoded])) };
}

export function canonicalJSONString(value) {
  const stringValue = (value) => {
    let output = '"';
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0x22) output += "\\\"";
      else if (code === 0x5c) output += "\\\\";
      else if (code === 8) output += "\\b";
      else if (code === 9) output += "\\t";
      else if (code === 10) output += "\\n";
      else if (code === 12) output += "\\f";
      else if (code === 13) output += "\\r";
      else if (code < 0x20 || code === 0x7f) output += `\\u${code.toString(16).padStart(4, "0")}`;
      else if (code >= 0xd800 && code <= 0xdfff) {
        if (code >= 0xdc00 || index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) output += `\\u${code.toString(16).padStart(4, "0")}`;
        else { output += value[index] + value[index + 1]; index += 1; }
      } else output += value[index];
    }
    return `${output}"`;
  };
  const visit = (entry) => {
    if (entry === null) return "null";
    if (typeof entry === "string") return stringValue(entry);
    if (typeof entry === "boolean") return entry ? "true" : "false";
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry)) throw new TypeError("canonical JSON requires safe integers");
      return Object.is(entry, -0) ? "0" : String(entry);
    }
    if (Array.isArray(entry)) return `[${entry.map(visit).join(",")}]`;
    if (isRecord(entry)) return `{${Object.keys(entry).map((key) => `${stringValue(key)}:${visit(entry[key])}`).join(",")}}`;
    throw new TypeError("canonical JSON contains an unsupported value");
  };
  return visit(value);
}
export function canonicalJSONLine(value) { return Buffer.from(`${canonicalJSONString(value)}\n`, "utf8"); }
export function sha256Bytes(value) { return createHash("sha256").update(bytes(value)).digest("hex"); }

export function validateUtf8ByteConstraint(value, schemaNode) {
  const maximum = schemaNode?.["x-maxUtf8Bytes"];
  return maximum === undefined || (typeof value === "string" && Number.isInteger(maximum) && !/[\u0000-\u001f\u007f]/u.test(value) && !/[\ud800-\udfff]/u.test(value) && byteLength(value) <= maximum);
}
export function validateAcceptanceV2Utf8Fields(matrix, schema) {
  if (!isRecord(matrix) || !isRecord(schema?.$defs) || !Array.isArray(matrix.rows)) return false;
  for (const row of matrix.rows) {
    if (!isRecord(row) || !validateUtf8ByteConstraint(row.requirement, schema.$defs.defaultString)) return false;
    const evidence = row.specification ?? row.evidence;
    if (isRecord(evidence) && (!isRecord(evidence.verifier) || !Array.isArray(evidence.verifier.argv) || evidence.verifier.argv.some((arg) => !validateUtf8ByteConstraint(arg, schema.$defs.defaultString256)))) return false;
    if (isRecord(row.blocker) && !validateUtf8ByteConstraint(row.blocker.reason, schema.$defs.defaultString)) return false;
  }
  return true;
}
export function classifyAcceptanceVersionPair(matrixBytes, manifestBytes) {
  const version = (value) => {
    try {
      const text = Buffer.from(value).toString("utf8");
      if (!Buffer.from(text, "utf8").equals(Buffer.from(value)) || (text.match(/"schema_version"\s*:/g) ?? []).length !== 1) return null;
      const parsed = JSON.parse(text);
      return isRecord(parsed) && typeof parsed.schema_version === "string" ? parsed.schema_version : null;
    } catch { return null; }
  };
  const matrix = version(matrixBytes); const manifest = version(manifestBytes);
  if (matrix === "acceptance-matrix/v1" && manifest === "acceptance-manifest/v1") return "v1/v1";
  if (matrix === "acceptance-matrix/v2" && manifest === "implementation-plan-manifest/v2") return "v2/v2";
  if (["acceptance-matrix/v1", "acceptance-matrix/v2"].includes(matrix) && ["acceptance-manifest/v1", "implementation-plan-manifest/v2"].includes(manifest) && matrix !== manifest) return "version_pair_mixed";
  return "version_pair_unsupported";
}

function parseOptionArgs(argv, names) {
  if (!Array.isArray(argv) || argv.length > 64 || argv.reduce((total, value) => total + byteLength(String(value)), 0) > 16 * 1024) fail("usage_invalid");
  const result = { json: false }; const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { if (result.json) fail("usage_invalid"); result.json = true; continue; }
    const key = names.get(argument);
    if (!key || seen.has(key) || index + 1 >= argv.length || String(argv[index + 1]).startsWith("--")) fail("usage_invalid");
    const value = argv[++index]; assertString(value); seen.add(key); result[key] = value;
  }
  return result;
}

/** Parse the controller's fixed option vocabulary; no environment selectors are accepted. */
export function parseTrustedDeliveryArgs(argv = process.argv.slice(2)) {
  const names = new Map([
    ["--mode", "mode"], ["--trusted-base", "trustedBase"], ["--trusted-worktree", "trustedWorktree"], ["--candidate-root", "candidateRoot"],
    ["--candidate-activation", "candidateActivation"], ["--candidate-activation-map", "candidateActivationMap"], ["--plan", "plan"], ["--manifest", "manifest"],
    ["--matrix", "matrix"], ["--evidence-root", "evidenceRoot"], ["--expected-repository", "expectedRepository"], ["--expected-ticket", "expectedTicket"],
    ["--expected-ticket-revision", "expectedTicketRevision"], ["--expected-head", "expectedHead"], ["--expected-pr", "expectedPR"], ["--evaluation-scope", "evaluationScope"],
  ]);
  const options = parseOptionArgs(argv, names);
  if (!options.mode || !["support", "transition", "validate"].includes(options.mode)) fail("mode_invalid");
  if (!options.json) fail("usage_invalid");
  for (const key of ["trustedBase", "expectedHead", "expectedTicketRevision"]) if (options[key] !== undefined) assertCommit(options[key]);
  for (const key of ["candidateRoot", "trustedWorktree", "matrix", "evidenceRoot"]) if (options[key] !== undefined) { assertString(options[key], "usage_invalid", TRUSTED_DELIVERY_LIMITS.pathBytes); if (!isAbsolute(options[key])) fail("usage_invalid"); }
  if (options.expectedPR !== undefined && !/^[1-9][0-9]{0,9}$/.test(options.expectedPR)) fail("usage_invalid");
  if (options.expectedRepository !== undefined && !REPOSITORY.test(options.expectedRepository)) fail("usage_invalid");
  if (options.expectedTicket !== undefined && !TICKET.test(options.expectedTicket)) fail("usage_invalid");
  if (options.evaluationScope !== undefined && !["plan-publication", "implementation-delivery"].includes(options.evaluationScope)) fail("usage_invalid");
  const allowed = options.mode === "support"
    ? new Set(["mode", "trustedBase", "candidateRoot", "expectedHead", "json"])
    : options.mode === "transition"
      ? new Set(["mode", "trustedBase", "trustedWorktree", "candidateRoot", "candidateActivation", "candidateActivationMap", "expectedRepository", "expectedTicket", "expectedTicketRevision", "expectedHead", "expectedPR", "json"])
      : new Set(["mode", "trustedBase", "trustedWorktree", "candidateRoot", "plan", "manifest", "matrix", "evidenceRoot", "expectedRepository", "expectedTicket", "expectedTicketRevision", "expectedHead", "expectedPR", "evaluationScope", "json"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) fail("usage_invalid");
  for (const key of ["plan", "manifest", "candidateActivation", "candidateActivationMap"]) if (options[key] !== undefined && !portablePath(options[key])) fail("usage_invalid");
  return Object.freeze(options);
}

function runChild(executable, args, cwd, maxStdout = TRUSTED_DELIVERY_LIMITS.stdoutBytes, maxStderr = TRUSTED_DELIVERY_LIMITS.stderrBytes) {
  let result;
  try { result = spawnSync(executable, args, { cwd, shell: false, windowsHide: true, encoding: "buffer", timeout: TRUSTED_DELIVERY_LIMITS.commandTimeoutMs, maxBuffer: Math.max(maxStdout, maxStderr), env: commandEnvironment() }); }
  catch (error) { return { ok: false, status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error }; }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  return { ok: result.status === 0 && !result.error && stdout.length <= maxStdout && stderr.length <= maxStderr, status: result.status, stdout, stderr, error: result.error };
}

/** Invoke only the trusted-base planning validator; support mode does not call it. */
export function runTrustedPlanValidator(input, maybeOptions = {}) {
  assertNode24();
  const options = isRecord(input) ? input : { trustedWorktree: input, ...maybeOptions };
  const trustedWorktree = canonicalDirectory(options.trustedWorktree, "trusted_base_invalid");
  const candidateRoot = canonicalDirectory(options.candidateRoot, "candidate_root_invalid");
  const validatorPath = join(trustedWorktree, TRUSTED_DELIVERY_PATHS.manifestValidator);
  const record = readTrustedBlobRecord(trustedWorktree, options.base, TRUSTED_DELIVERY_PATHS.manifestValidator, TRUSTED_DELIVERY_LIMITS.controllerBytes);
  const local = readStableWorking(trustedWorktree, TRUSTED_DELIVERY_PATHS.manifestValidator, TRUSTED_DELIVERY_LIMITS.controllerBytes, "trusted_blob_invalid");
  if (!local.bytes.equals(record.bytes)) fail("trusted_blob_invalid");
  const args = [validatorPath, "--plan", options.plan, "--manifest", options.manifest, "--base", options.base, "--profile", "profiles/pi-sampler.json", "--repository", options.repository, "--ticket", options.ticket, "--ticket-revision", options.ticketRevision, "--json"];
  const result = runChild(process.execPath, args, candidateRoot, 1024 * 1024, TRUSTED_DELIVERY_LIMITS.stderrBytes);
  if (!result.ok || !result.stdout.length) fail("manifest_validator_failed");
  const text = result.stdout.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(result.stdout) || !text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail("manifest_validator_failed");
  let value; try { value = JSON.parse(text.slice(0, -1)); } catch { fail("manifest_validator_failed"); }
  if (!isRecord(value) || canonicalJSONLine(value).toString("utf8") !== text || value.ok !== true) fail("manifest_validator_failed");
  return value;
}

export function parseEvaluatorEnvelope(result) {
  if (!result || result.error || ![0, 1, 3].includes(result.status)) fail("test_failed");
  const text = Buffer.from(result.stdout ?? "").toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail("test_failed");
  let value; try { value = JSON.parse(text.slice(0, -1)); } catch { fail("test_failed"); }
  const expected = result.status === 0 ? "valid" : result.status === 1 ? "invalid" : "blocked";
  if (!isRecord(value) || value.format !== "pi-sampler.delivery-acceptance-result" || value.version !== 1 || value.status !== expected || !Array.isArray(value.rows) || !Array.isArray(value.diagnostics)) fail("test_failed");
  if (!DIGEST.test(value.facts_sha256) || !DIGEST.test(value.matrix_sha256) || canonicalJSONLine(value).toString("utf8") !== text) fail("test_failed");
  return value;
}

export async function runTransitionForTest() { fail("activation_absent"); }
export async function runValidateForTest() { fail("activation_absent"); }

function controllerEnvelope(code) { return { format: TRUSTED_DELIVERY_CONTROLLER_FORMAT, version: TRUSTED_DELIVERY_CONTROLLER_VERSION, status: "blocked", code, authority: false }; }

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseTrustedDeliveryArgs(argv);
    if (options.mode !== "support") fail("activation_absent");
    const result = await runSupport(options);
    process.stdout.write(`${canonicalJSONString(result)}\n`);
    return 0;
  } catch (error) {
    const code = error && typeof error.code === "string" && CONTROLLER_ERROR_ORDER.has(error.code) ? error.code : "usage_invalid";
    if (argv.includes("--json") || options?.json) process.stdout.write(`${canonicalJSONString(controllerEnvelope(code))}\n`);
    else process.stderr.write(`trusted-delivery-evidence-controller: ${code}\n`);
    return code === "usage_invalid" || code === "mode_invalid" ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exitCode = await main();
