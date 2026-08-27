#!/usr/bin/env node
/**
 * Trusted-base-aware controller for delivery-acceptance/v2.
 *
 * Slice 1 exposes only inert support to the repository workflow.  Transition
 * and validate are retained as fail-closed, manual contracts: a candidate
 * cannot create the activation or trusted-map authority that they require.
 * Git and planning-validator selection is owned here; the Go evaluator only
 * evaluates a request whose bindings have already been authenticated.
 */
import { accessSync, constants as fsConstants, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { lstat, realpath, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 as winPath } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const TRUSTED_DELIVERY_CONTROLLER_FORMAT = "pi-sampler.delivery-v2-controller";
export const TRUSTED_DELIVERY_CONTROLLER_VERSION = 1;
export const DELIVERY_V2_SUPPORT_REPORT_FORMAT = "pi-sampler.delivery-v2-support-report";
export const DELIVERY_V2_SUPPORT_REPORT_VERSION = 1;
export const DELIVERY_V2_SUPPORT_AUTHORITY = "functional-only";
export const DELIVERY_V2_SUPPORT_CAN_GRANT_AUTHORITY = false;
export const TRUSTED_DELIVERY_PATHS = Object.freeze({
  manifestContract: "contracts/implementation-plan-manifest-v2.mjs",
  manifestValidator: "scripts/validate-implementation-plan.mjs",
  matrixSchema: "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json",
  profile: "profiles/pi-sampler.json",
  profileSchema: "profiles/project-profile.schema.json",
  acceptanceGo: "governance/pkg/deliveryevidence/acceptance_v2.go",
  posixRoot: "governance/pkg/deliveryevidence/external_root_posix.go",
  windowsRoot: "governance/pkg/deliveryevidence/external_root_windows.go",
  validatorMain: "governance/cmd/delivery-evidence-validator/main.go",
  controller: "scripts/trusted-delivery-evidence-controller.mjs",
});
export const TRUSTED_DELIVERY_LIMITS = Object.freeze({
  argumentBytes: 4096,
  pathBytes: 1024,
  matrixBytes: 2 * 1024 * 1024,
  controllerBytes: 4 * 1024 * 1024,
  trustedBlobBytes: 4 * 1024 * 1024,
  validatorBytes: 4 * 1024 * 1024,
  goBytes: 2 * 1024 * 1024,
  stdoutBytes: 8 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  validatorStdoutBytes: 1024 * 1024,
  validatorStderrBytes: 64 * 1024,
  timeoutMs: 120_000,
  gitTimeoutMs: 30_000,
});

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TICKET = /^[A-Z][A-Z0-9]+-[0-9]+$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;
const SAFE_PORTABLE_PATH = /^(?![\s\S]*[^A-Za-z0-9._/+,-])(?!\/)(?![A-Za-z]:)(?!.*\/\/)(?!.*:)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*[. ](?:\/|$))(?!.*(?:^|\/)(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Ll][Oo][Cc][Kk]\$|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.[^/\\]*)?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._+,-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+,-]*)*$/;
const ACTIVATION_FORMAT = "pi-sampler.delivery-acceptance-v2-activation";
const TRUSTED_MAP_FORMAT = "pi-sampler.delivery-acceptance-v2-trusted-map";
const CONTROLLER_ENV_NAMES = Object.freeze(["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]);
const CONTROLLER_NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const CONTROLLER_HOOKS_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const POSIX_GIT_CANDIDATES = Object.freeze(["/usr/bin/git", "/usr/local/bin/git"]);
const WINDOWS_GIT_CANDIDATES = Object.freeze([
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files\\Git\\bin\\git.exe",
]);
const POSIX_GO_CANDIDATES = Object.freeze(["/usr/local/go/bin/go", "/usr/bin/go", "/opt/go1.25/bin/go"]);
const WINDOWS_GO_CANDIDATES = Object.freeze(["C:\\Program Files\\Go\\bin\\go.exe", "C:\\Program Files\\Go1.25\\bin\\go.exe", "C:\\Go\\bin\\go.exe"]);
export const SLICE2_PATH_MODES = Object.freeze({
  "contracts/delivery-acceptance-v2-activation.json": "new",
  "contracts/delivery-acceptance-v2-trusted-map.json": "new",
  "profiles/pi-sampler.json": "modified",
  "governance/docs/delivery-evidence/README.md": "modified",
  "docs/IMPLEMENTATION-PLANNING.md": "modified",
  ".agents/skills/project-delivery/SKILL.md": "modified",
  ".agents/skills/create-implementation-plan/SKILL.md": "modified",
});
export const SLICE2_MAP_PATHS = Object.freeze([
  "contracts/delivery-acceptance-v2-activation.json",
  "profiles/pi-sampler.json",
  "governance/docs/delivery-evidence/README.md",
  "docs/IMPLEMENTATION-PLANNING.md",
  ".agents/skills/project-delivery/SKILL.md",
  ".agents/skills/create-implementation-plan/SKILL.md",
]);
const GIT_OPTIONS = Object.freeze([
  "--no-pager", "--no-replace-objects", "--no-optional-locks",
  "-c", "trace2.eventTarget=", "-c", "trace2.normalTarget=", "-c", "trace2.perfTarget=",
  "-c", "color.ui=false", "-c", `core.hooksPath=${CONTROLLER_HOOKS_DEVICE}`,
]);
const SLICE1_OWNED_PATHS = new Set([
  "governance/pkg/deliveryevidence/acceptance_v2.go",
  "governance/pkg/deliveryevidence/external_root_posix.go",
  "governance/pkg/deliveryevidence/external_root_windows.go",
  "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json",
  "scripts/trusted-delivery-evidence-controller.mjs",
  "tests/delivery-acceptance-v2.test.mjs",
  "tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md",
  "tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json",
  "governance/cmd/delivery-evidence-validator/main.go",
  "governance/pkg/deliveryevidence/validator_test.go",
  "tests/delivery-acceptance.test.mjs",
  "package.json",
]);
const CONTROLLER_FAILURE_ORDER = Object.freeze([
  "usage_invalid", "mode_invalid", "trusted_base_invalid", "trusted_git_failure", "trusted_blob_invalid",
  "transition_activation_already_present", "transition_activation_map_already_present", "activation_absent",
  "activation_map_absent", "activation_invalid", "activation_map_invalid", "trusted_digest_mismatch",
  "candidate_root_invalid", "candidate_head_mismatch", "candidate_not_clean", "candidate_blob_invalid",
  "candidate_inventory_changed", "test_failed",
]);

class DeliveryControllerError extends Error {
  constructor(code) { super(code); this.code = code; this.name = "DeliveryControllerError"; }
}
function fail(code) { throw new DeliveryControllerError(code); }
function byteLength(value) { return Buffer.byteLength(value, "utf8"); }
function assertString(value, code = "usage_invalid", maximum = TRUSTED_DELIVERY_LIMITS.argumentBytes) {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > maximum || value.includes("\0")) fail(code);
  return value;
}
function assertNode24(code = "test_failed") {
  if (Number.parseInt(process.versions.node.split(".")[0], 10) !== 24) fail(code);
}
function assertAbsolutePath(value, code = "candidate_root_invalid") {
  assertString(value, code, TRUSTED_DELIVERY_LIMITS.pathBytes);
  if (!isAbsolute(value) || (process.platform === "win32" && (/^(?:\\\\|\/\/)/.test(value) || value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\")))) fail(code);
  return value;
}
function assertCommit(value, code = "usage_invalid") { assertString(value, code, 64); if (!SHA.test(value)) fail(code); return value; }
function assertDigest(value, code = "usage_invalid") { assertString(value, code, 64); if (!DIGEST.test(value)) fail(code); return value; }
function assertPortablePath(value, code = "usage_invalid", maximum = 256) {
  assertString(value, code, maximum);
  const parts = value.split("/");
  if (byteLength(value) > maximum || !portableArtifactPath(value, maximum) || parts.some((part) => byteLength(part) > 255)) fail(code);
  return value;
}
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function fixedEnvironment(source = process.env, gitExecutable = undefined) {
  const environment = {
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: CONTROLLER_NULL_DEVICE,
    GIT_CONFIG_SYSTEM: CONTROLLER_NULL_DEVICE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOSUMDB: "off",
    GOENV: "off",
    GONOSUMDB: "*",
    GOPRIVATE: "*",
    GONOPROXY: "*",
    GOWORK: "off",
    TZ: "UTC",
  };
  for (const name of CONTROLLER_ENV_NAMES) {
    const entry = Object.entries(source).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entry && !/^git_/i.test(entry[0])) environment[entry[0]] = entry[1];
  }
  const fixedToolDirectories = process.platform === "win32"
    ? [dirname(process.execPath), "C:\\Program Files\\Go\\bin", "C:\\Program Files\\nodejs", "C:\\ProgramData\\mingw64\\mingw64\\bin", "C:\\Program Files\\Git\\mingw64\\bin", "C:\\Windows\\System32", "C:\\Windows"]
    : [dirname(process.execPath), "/usr/local/go/bin", "/usr/bin", "/bin"];
  if (process.platform === "win32" && gitExecutable) fixedToolDirectories.unshift(dirname(gitExecutable));
  environment.PATH = fixedToolDirectories.filter((value, index, values) => values.indexOf(value) === index).join(process.platform === "win32" ? ";" : ":");
  return environment;
}

function fixedPathKey(value, platform = process.platform) {
  const text = String(value).replaceAll("/", String.fromCharCode(92));
  return platform === "win32" ? text.toLowerCase() : text;
}
function fixedPathParent(value, platform = process.platform) {
  return platform === "win32" ? winPath.dirname(value) : dirname(value);
}
function isRedirectedFixedEntry(info) {
  return Boolean(info?.isSymbolicLink?.() || info?.isReparsePoint?.() || info?.reparsePoint === true);
}
function fixedEntryIdentity(info) {
  if (!info) return null;
  const fields = ["dev", "ino", "size", "mtimeNs", "mode", "nlink"];
  return fields.map((field) => `${field}=${info[field] === undefined ? "?" : String(info[field])}`).join(";");
}
function fixedExecutableSnapshot(candidate, platform = process.platform, fileSystem = undefined) {
  const lstat = fileSystem?.lstatSync ?? lstatSync;
  const stat = fileSystem?.statSync ?? statSync;
  const realpath = fileSystem?.realpathSync ?? realpathSync;
  const access = fileSystem?.accessSync ?? accessSync;
  const ancestors = [];
  let current = candidate;
  let finalDevice;
  for (;;) {
    const info = lstat(current);
    if (isRedirectedFixedEntry(info)) return null;
    const final = current === candidate;
    if (final ? !info.isFile() : !info.isDirectory()) return null;
    const canonicalAncestor = realpath(current);
    if (fixedPathKey(canonicalAncestor, platform) !== fixedPathKey(current, platform)) return null;
    if (final) finalDevice = info.dev === undefined ? undefined : String(info.dev);
    else if (finalDevice !== undefined && info.dev !== undefined && String(info.dev) !== finalDevice) return null;
    ancestors.push({ path: current, identity: fixedEntryIdentity(info) });
    const parent = fixedPathParent(current, platform);
    if (parent === current) break;
    current = parent;
  }
  const canonical = realpath(candidate);
  if (fixedPathKey(canonical, platform) !== fixedPathKey(candidate, platform)) return null;
  const finalInfo = stat(candidate);
  if (!finalInfo.isFile() || isRedirectedFixedEntry(finalInfo)) return null;
  if (platform !== "win32") access(candidate, fsConstants.X_OK);
  return { canonical, lexical: candidate, identity: fixedEntryIdentity(finalInfo), ancestors };
}
function fixedExecutableStable(candidate, before, platform = process.platform, fileSystem = undefined) {
  const after = fixedExecutableSnapshot(candidate, platform, fileSystem);
  if (!after || after.identity !== before.identity || fixedPathKey(after.canonical, platform) !== fixedPathKey(before.canonical, platform)) return false;
  if (after.ancestors.length !== before.ancestors.length) return false;
  return after.ancestors.every((entry, index) => entry.identity === before.ancestors[index].identity && fixedPathKey(entry.path, platform) === fixedPathKey(before.ancestors[index].path, platform));
}

export function trustedGoCandidatePaths(platform = process.platform) {
  return platform === "win32" ? [...WINDOWS_GO_CANDIDATES] : [...POSIX_GO_CANDIDATES];
}
export function resolveTrustedGoExecutableFromFixedCandidates(platform = process.platform, fileSystem = undefined) {
  const candidates = trustedGoCandidatePaths(platform);
  for (const candidate of candidates) {
    try {
      const snapshot = fixedExecutableSnapshot(candidate, platform, fileSystem);
      if (snapshot) return snapshot.lexical;
    } catch { /* fixed candidate unavailable or redirected */ }
  }
  fail("test_failed");
}

function executableDigest(path) {
  let bytes;
  try { bytes = requireReadFile(path); } catch { fail("test_failed"); }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 256 * 1024 * 1024) fail("test_failed");
  return { bytes, sha256: sha256Bytes(bytes) };
}

export function inspectTrustedGoExecutable(executable, { expectedSha256 = undefined, versionOutput = undefined, spawn = spawnSync } = {}) {
  assertAbsolutePath(executable, "test_failed");
  let before;
  try { before = fixedExecutableSnapshot(executable, process.platform); } catch { fail("test_failed"); }
  if (!before) fail("test_failed");
  const digest = executableDigest(executable);
  if (expectedSha256 !== undefined && (!DIGEST.test(expectedSha256) || digest.sha256 !== expectedSha256)) fail("test_failed");
  let output = versionOutput;
  if (output === undefined) {
    let result;
    try { result = spawn(executable, ["version"], { shell: false, windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 4096, env: fixedEnvironment(process.env, executable) }); } catch { fail("test_failed"); }
    if (!result || result.status !== 0 || result.error) fail("test_failed");
    output = `${result.stdout ?? ""}`;
  }
  if (typeof output !== "string" || !/^go version go1\.25\.0(?:\s|$)/.test(output.trim())) fail("test_failed");
  const afterDigest = executableDigest(executable);
  if (afterDigest.sha256 !== digest.sha256 || !fixedExecutableStable(executable, before, process.platform)) fail("test_failed");
  return Object.freeze({ path: executable, sha256: digest.sha256, version: output.trim() });
}

export function resolveAuthorityGoToolchain() {
  for (const candidate of trustedGoCandidatePaths()) {
    try {
      const snapshot = fixedExecutableSnapshot(candidate);
      if (!snapshot) continue;
      return inspectTrustedGoExecutable(candidate);
    } catch (error) {
      if (error instanceof DeliveryControllerError && error.code === "test_failed") continue;
    }
  }
  fail("test_failed");
}

/** Locate Git only at fixed platform-standard identities; PATH is never used. */
export function locateFixedGit(platform = process.platform, fileSystem = undefined) {
  const candidates = platform === "win32" ? WINDOWS_GIT_CANDIDATES : POSIX_GIT_CANDIDATES;
  for (const candidate of candidates) {
    try {
      const snapshot = fixedExecutableSnapshot(candidate, platform, fileSystem);
      if (snapshot) return snapshot.lexical;
    } catch { /* fixed candidate unavailable or redirected */ }
  }
  fail("test_failed");
}

let gitExecutableCache;
function inspectFixedGitExecutable(executable) {
  let before;
  try { before = fixedExecutableSnapshot(executable); } catch { fail("test_failed"); }
  if (!before) fail("test_failed");
  const digest = executableDigest(executable);
  const after = executableDigest(executable);
  if (after.sha256 !== digest.sha256 || !fixedExecutableStable(executable, before)) fail("test_failed");
  return Object.freeze({ path: executable, sha256: digest.sha256 });
}
function resolveAuthorityGitExecutable() {
  const candidates = process.platform === "win32" ? WINDOWS_GIT_CANDIDATES : POSIX_GIT_CANDIDATES;
  for (const candidate of candidates) {
    try {
      if (!fixedExecutableSnapshot(candidate)) continue;
      return inspectFixedGitExecutable(candidate).path;
    } catch (error) {
      if (error instanceof DeliveryControllerError && error.code === "test_failed") continue;
    }
  }
  fail("test_failed");
}
function trustedGit() {
  if (gitExecutableCache) {
    inspectFixedGitExecutable(gitExecutableCache.path);
    return gitExecutableCache.path;
  }
  const executable = resolveAuthorityGitExecutable();
  gitExecutableCache = inspectFixedGitExecutable(executable);
  return gitExecutableCache.path;
}
export function inspectTrustedGitExecutable(executable, expectedSha256 = undefined) {
  const inspected = inspectFixedGitExecutable(executable);
  if (expectedSha256 !== undefined && (!DIGEST.test(expectedSha256) || inspected.sha256 !== expectedSha256)) fail("test_failed");
  return inspected;
}
function runGit(cwd, args, { maxStdout = TRUSTED_DELIVERY_LIMITS.stdoutBytes, maxStderr = TRUSTED_DELIVERY_LIMITS.stderrBytes, timeout = TRUSTED_DELIVERY_LIMITS.gitTimeoutMs, allowFailure = false } = {}) {
  let result;
  try {
    const executable = trustedGit();
    result = spawnSync(executable, [...GIT_OPTIONS, ...args], {
      cwd, shell: false, windowsHide: true, encoding: "buffer", timeout,
      maxBuffer: Math.max(maxStdout, maxStderr), env: fixedEnvironment(process.env, executable),
    });
    inspectFixedGitExecutable(executable);
  } catch (error) { if (error instanceof DeliveryControllerError) throw error; fail("test_failed"); }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  if (stdout.length > maxStdout || stderr.length > maxStderr || result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") fail("trusted_git_failure");
  const output = { ok: result.status === 0, status: result.status, stdout, stderr, error: result.error };
  if (!output.ok && !allowFailure) fail("trusted_git_failure");
  return output;
}
function gitText(cwd, args, options = {}) {
  const output = runGit(cwd, args, options);
  const text = output.stdout.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(output.stdout)) fail("trusted_git_failure");
  return text;
}
function gitTrim(cwd, args, options = {}) { return gitText(cwd, args, options).trim(); }

function sha256Bytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}
export { sha256Bytes };

/** Serialize a bounded value without whitespace while preserving prescribed insertion order. */
export function validateUtf8ByteConstraint(value, schemaNode) {
  const maximum = schemaNode?.["x-maxUtf8Bytes"];
  if (maximum === undefined) return true;
  if (typeof value !== "string" || !Number.isInteger(maximum) || maximum < 1 || /[\u0000-\u001f\u007f]/u.test(value) || /[\ud800-\udfff]/u.test(value)) return false;
  return byteLength(value) <= maximum;
}
export function validateAcceptanceV2Utf8Fields(matrix, schema) {
  if (!isRecord(matrix) || !isRecord(schema?.$defs) || !Array.isArray(matrix.rows)) return false;
  const defaultString = schema.$defs.defaultString;
  const shortString = schema.$defs.defaultString256;
  for (const row of matrix.rows) {
    if (!isRecord(row) || !validateUtf8ByteConstraint(row.requirement, defaultString)) return false;
    const evidence = row.specification ?? row.evidence;
    if (isRecord(evidence)) {
      if (!isRecord(evidence.verifier) || !Array.isArray(evidence.verifier.argv) || evidence.verifier.argv.some((arg) => !validateUtf8ByteConstraint(arg, shortString))) return false;
    }
    if (isRecord(row.blocker) && !validateUtf8ByteConstraint(row.blocker.reason, defaultString)) return false;
  }
  return true;
}

export function canonicalJSONString(value) {
  const visit = (entry) => {
    if (entry === null) return "null";
    if (typeof entry === "string") return JSON.stringify(entry);
    if (typeof entry === "boolean") return entry ? "true" : "false";
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry)) throw new TypeError("canonical JSON requires safe integers");
      return JSON.stringify(entry);
    }
    if (Array.isArray(entry)) return `[${entry.map(visit).join(",")}]`;
    if (isRecord(entry)) {
      return `{${Object.keys(entry).map((key) => `${JSON.stringify(key)}:${visit(entry[key])}`).join(",")}}`;
    }
    throw new TypeError("canonical JSON contains an unsupported value");
  };
  return visit(value);
}

function canonicalJSONLine(value) { return Buffer.from(`${canonicalJSONString(value)}\n`, "utf8"); }
function canonicalActivation(value) {
  return { format: value.format, version: value.version, state: value.state };
}
export function canonicalActivationJSON(value) { return canonicalJSONLine(canonicalActivation(value)); }
// The map deliberately does not carry a commit-id activation_head: the map is
// itself part of S2, so embedding S2 would create the same fixed-point
// dependency as embedding the map digest. The outer receipt's candidate_head
// authenticates S1 -> S2; post-activation validation derives activation_head
// from the authenticated trusted base and keeps the delivery head H separate.
function canonicalTransitionMap(value) {
  return {
    format: value.format,
    version: value.version,
    activation_sha256: value.activation_sha256,
    predecessor_base: value.predecessor_base,
    trusted_paths: (value.trusted_paths ?? []).map((entry) => ({ path: isRecord(entry) ? entry.path : null, sha256: isRecord(entry) ? entry.sha256 : null })),
    candidate_paths: (value.candidate_paths ?? []).map((entry) => ({ path: isRecord(entry) ? entry.path : null, sha256: isRecord(entry) ? entry.sha256 : null })),
  };
}
export function canonicalTrustedMapJSON(value) { return canonicalJSONLine(canonicalTransitionMap(value)); }

function parseCanonicalJSON(bytes, code, canonicalizer) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
  let value;
  try { value = JSON.parse(text); } catch { fail(code); }
  if (!isRecord(value) || canonicalJSONString(canonicalizer(value)) + "\n" !== text) fail(code);
  return value;
}
function schemaVersion(bytes, member) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 4 * 1024 * 1024) return null;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return null;
  const occurrences = text.match(new RegExp(`"${member}"\\s*:`, "g")) ?? [];
  if (occurrences.length !== 1) return null;
  try {
    const value = JSON.parse(text);
    return isRecord(value) && typeof value[member] === "string" ? value[member] : null;
  } catch { return null; }
}
export function classifyAcceptanceVersionPair(matrixBytes, manifestBytes) {
  const matrixVersion = schemaVersion(matrixBytes, "schema_version");
  const manifestVersion = schemaVersion(manifestBytes, "schema_version");
  if (matrixVersion === "acceptance-matrix/v1" && manifestVersion === "acceptance-manifest/v1") return "v1/v1";
  if (matrixVersion === "acceptance-matrix/v2" && manifestVersion === "implementation-plan-manifest/v2") return "v2/v2";
  const matrixKnown = matrixVersion === "acceptance-matrix/v1" || matrixVersion === "acceptance-matrix/v2";
  const manifestKnown = manifestVersion === "acceptance-manifest/v1" || manifestVersion === "implementation-plan-manifest/v2";
  if (matrixKnown && manifestKnown && matrixVersion !== manifestVersion) return "version_pair_mixed";
  return "version_pair_unsupported";
}

function parseArgsValue(argv, names, { flagNames = [] } = {}) {
  if (!Array.isArray(argv) || argv.length > 64) fail("usage_invalid");
  const options = { json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (options.json) fail("usage_invalid");
      options.json = true;
      continue;
    }
    if (flagNames.includes(argument)) {
      if (seen.has(argument)) fail("usage_invalid");
      seen.add(argument); options[argument.slice(2).replaceAll("-", "_")] = true; continue;
    }
    const key = names.get(argument);
    if (!key || seen.has(key) || index + 1 >= argv.length || argv[index + 1].startsWith("--")) fail("usage_invalid");
    const value = argv[++index];
    assertString(value, "usage_invalid");
    seen.add(key); options[key] = value;
  }
  return options;
}

/** Parse the controller's exact option vocabulary; no environment selectors or aliases are accepted. */
export function parseTrustedDeliveryArgs(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.reduce((total, value) => total + byteLength(String(value)), 0) > 16 * 1024) fail("usage_invalid");
  const names = new Map([
    ["--mode", "mode"], ["--trusted-base", "trustedBase"], ["--trusted-worktree", "trustedWorktree"], ["--candidate-root", "candidateRoot"],
    ["--candidate-activation", "candidateActivation"], ["--candidate-activation-map", "candidateActivationMap"], ["--plan", "plan"], ["--manifest", "manifest"],
    ["--matrix", "matrix"], ["--evidence-root", "evidenceRoot"], ["--expected-repository", "expectedRepository"], ["--expected-ticket", "expectedTicket"],
    ["--expected-ticket-revision", "expectedTicketRevision"], ["--expected-head", "expectedHead"], ["--expected-pr", "expectedPR"],
    ["--evaluation-scope", "evaluationScope"],
  ]);
  const options = parseArgsValue(argv, names);
  if (!options.mode || !["support", "transition", "validate"].includes(options.mode)) fail("mode_invalid");
  if (options.expectedPR !== undefined && !/^[1-9][0-9]{0,9}$/.test(options.expectedPR)) fail("usage_invalid");
  if (options.evaluationScope !== undefined && !["plan-publication", "implementation-delivery"].includes(options.evaluationScope)) fail("usage_invalid");
  for (const key of ["trustedBase", "expectedHead", "expectedTicketRevision"]) if (options[key] !== undefined) assertCommit(options[key]);
  for (const key of ["candidateRoot", "trustedWorktree", "matrix", "evidenceRoot"]) if (options[key] !== undefined) assertAbsolutePath(options[key]);
  if (!options.json) fail("usage_invalid");
  const modeAllowed = {
    support: new Set(["mode", "trustedBase", "candidateRoot", "expectedHead", "json"]),
    transition: new Set(["mode", "trustedBase", "trustedWorktree", "candidateRoot", "candidateActivation", "candidateActivationMap", "expectedRepository", "expectedTicket", "expectedTicketRevision", "expectedHead", "expectedPR", "json"]),
    validate: new Set(["mode", "trustedBase", "trustedWorktree", "candidateRoot", "plan", "manifest", "matrix", "evidenceRoot", "expectedRepository", "expectedTicket", "expectedTicketRevision", "expectedHead", "expectedPR", "evaluationScope", "json"]),
  }[options.mode];
  for (const key of Object.keys(options)) if (!modeAllowed.has(key)) fail("usage_invalid");
  for (const key of ["plan", "manifest", "candidateActivation", "candidateActivationMap"]) if (options[key] !== undefined) assertPortablePath(options[key]);
  if (options.expectedRepository !== undefined) { assertString(options.expectedRepository); if (!REPOSITORY.test(options.expectedRepository)) fail("usage_invalid"); }
  if (options.expectedTicket !== undefined) { assertString(options.expectedTicket); if (!TICKET.test(options.expectedTicket)) fail("usage_invalid"); }
  return Object.freeze(options);
}

function canonicalPathKey(value) { return process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value; }
function canonicalExistingDirectory(path, code = "candidate_root_invalid") {
  assertAbsolutePath(path, code);
  const requested = resolve(path);
  for (let current = requested; ; current = resolve(current, "..")) {
    let ancestor;
    try { ancestor = lstatSync(current); } catch { fail(code); }
    if (isRedirectedFixedEntry(ancestor)) fail(code);
    const parent = resolve(current, "..");
    if (parent === current) break;
  }
  let info, canonical;
  try { info = lstatSync(requested); canonical = realpathSync(requested); } catch { fail(code); }
  const same = canonicalPathKey(canonical) === canonicalPathKey(requested);
  if (!info.isDirectory() || isRedirectedFixedEntry(info) || !same) fail(code);
  return canonical;
}
function pathInside(root, candidate) {
  const remainder = relative(resolve(root), resolve(candidate));
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}
function directoryIdentityDescriptor(path, code = "candidate_root_invalid") {
  const canonical = canonicalExistingDirectory(path, code);
  let info;
  try { info = lstatSync(canonical); } catch { fail(code); }
  if (!info.isDirectory() || isRedirectedFixedEntry(info) || info.dev === undefined || info.ino === undefined || String(info.dev) === "0" || String(info.ino) === "0") fail(code);
  return { path: canonical, descriptor: { path: canonicalPathKey(canonical), device: String(info.dev), file: String(info.ino), type: "directory" }, info };
}
function managedWorkspaceAncestors(path) {
  const candidates = [];
  for (let current = path; ; current = dirname(current)) {
    const name = basename(current);
    if ((process.platform === "win32" ? name.toLowerCase() : name) === "ai-workspaces") candidates.push(current);
    const parent = dirname(current);
    if (parent === current) break;
  }
  return candidates;
}
function resolveManagedRoots(anchor, profile) {
  if (!isRecord(profile?.delivery) || !isRecord(profile.delivery.review)) fail("trusted_blob_invalid");
  const values = [profile.delivery.worktreeRoot, profile.delivery.review.workspaceRoot, profile.delivery.review.quarantineRoot];
  if (values.some((value) => typeof value !== "string" || value.length === 0 || isAbsolute(value) || value.includes("\0"))) fail("trusted_blob_invalid");
  const roots = values.map((value) => canonicalExistingDirectory(resolve(anchor.path, value), "candidate_root_invalid"));
  if (new Set(roots.map((value) => canonicalPathKey(value))).size !== roots.length) fail("candidate_root_invalid");
  const identities = roots.map((value) => directoryIdentityDescriptor(value, "candidate_root_invalid"));
  return { worktreeRoot: roots[0], reviewRoot: roots[1], quarantineRoot: roots[2], identities };
}
function assertTrustedProfile(profile, expectedRepository) {
  const projectId = profile?.projectId;
  const repository = profile?.repository?.source;
  if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectId) || typeof repository !== "string" || !REPOSITORY.test(repository) || repository !== expectedRepository || repository.split("/")[1] !== projectId) fail("trusted_blob_invalid");
  return projectId;
}
function authenticatedSourceRepository(trustedRepo, base, expectedRepository, profileRecord, profile) {
  const workspaceCandidates = managedWorkspaceAncestors(trustedRepo);
  if (workspaceCandidates.length !== 1) fail("trusted_base_invalid");
  const workspaceRoot = workspaceCandidates[0];
  const projectId = assertTrustedProfile(profile, expectedRepository);
  const sourcePath = canonicalExistingDirectory(resolve(dirname(workspaceRoot), projectId), "trusted_base_invalid");
  const sourceTop = gitTrim(sourcePath, ["rev-parse", "--show-toplevel"], { maxStdout: TRUSTED_DELIVERY_LIMITS.pathBytes, allowFailure: true });
  let canonicalTop;
  try { canonicalTop = realpathSync(resolve(sourcePath, sourceTop)); } catch { canonicalTop = ""; }
  if (!sourceTop || canonicalPathKey(canonicalTop) !== canonicalPathKey(sourcePath)) fail("trusted_base_invalid");
  exactCommit(sourcePath, base, "trusted_base_invalid");
  assertNoGitSubstitution(sourcePath, "trusted_git_failure");
  const sourceProfile = readTrustedBlobRecord(sourcePath, base, TRUSTED_DELIVERY_PATHS.profile, 2 * 1024 * 1024);
  if (!sourceProfile.content.equals(profileRecord.content)) fail("trusted_blob_invalid");
  return directoryIdentityDescriptor(sourcePath, "trusted_base_invalid");
}
function assertManagedWorktreeTopology(roots, sourceRepo, trustedRepo, candidateRepo) {
  if (!pathInside(roots.worktreeRoot, roots.reviewRoot) || !pathInside(roots.worktreeRoot, roots.quarantineRoot) || pathInside(roots.reviewRoot, roots.quarantineRoot) || pathInside(roots.quarantineRoot, roots.reviewRoot)) fail("candidate_root_invalid");
  if (pathInside(sourceRepo, roots.worktreeRoot) || pathInside(roots.worktreeRoot, sourceRepo)) fail("candidate_root_invalid");
  if (!pathInside(roots.reviewRoot, trustedRepo) || pathInside(roots.quarantineRoot, trustedRepo) || canonicalPathKey(trustedRepo) === canonicalPathKey(roots.reviewRoot)) fail("candidate_root_invalid");
  if (!pathInside(roots.worktreeRoot, candidateRepo) || pathInside(roots.reviewRoot, candidateRepo) || pathInside(roots.quarantineRoot, candidateRepo) || canonicalPathKey(candidateRepo) === canonicalPathKey(roots.worktreeRoot)) fail("candidate_root_invalid");
  if (pathInside(trustedRepo, candidateRepo) || pathInside(candidateRepo, trustedRepo)) fail("candidate_root_invalid");
}
function assertAuthenticatedSourceStable(source) {
  const current = directoryIdentityDescriptor(source.path, "candidate_root_invalid");
  if (current.descriptor.path !== source.descriptor.path || current.descriptor.device !== source.descriptor.device || current.descriptor.file !== source.descriptor.file) fail("candidate_root_invalid");
  const top = gitTrim(current.path, ["rev-parse", "--show-toplevel"], { maxStdout: TRUSTED_DELIVERY_LIMITS.pathBytes, allowFailure: true });
  let canonicalTop;
  try { canonicalTop = realpathSync(resolve(current.path, top)); } catch { canonicalTop = ""; }
  if (!top || canonicalPathKey(canonicalTop) !== canonicalPathKey(current.path)) fail("candidate_root_invalid");
}
function assertManagedRootsStable(roots) {
  const names = ["worktreeRoot", "reviewRoot", "quarantineRoot"];
  if (!Array.isArray(roots?.identities) || roots.identities.length !== names.length) fail("candidate_root_invalid");
  for (const [index, name] of names.entries()) {
    const current = directoryIdentityDescriptor(roots[name], "candidate_root_invalid");
    const expected = roots.identities[index];
    if (current.descriptor.path !== expected.descriptor.path || current.descriptor.device !== expected.descriptor.device || current.descriptor.file !== expected.descriptor.file) fail("candidate_root_invalid");
  }
}
export function deriveAuthenticatedSourceRoot(trustedRepo, base, expectedRepository, candidateRepo = undefined) {
  const trustedPath = canonicalExistingDirectory(trustedRepo, "trusted_base_invalid");
  const { profile, record: profileRecord } = profileAtTrustedBase(trustedPath, base);
  const source = authenticatedSourceRepository(trustedPath, base, expectedRepository, profileRecord, profile);
  const roots = resolveManagedRoots(source, profile);
  if (candidateRepo !== undefined) assertManagedWorktreeTopology(roots, source.path, trustedPath, canonicalExistingDirectory(candidateRepo, "candidate_root_invalid"));
  else if (!pathInside(roots.reviewRoot, trustedPath)) fail("candidate_root_invalid");
  return Object.freeze({ source, profile, profileRecord, roots });
}
function portableArtifactPath(path, maximum = 256) {
  if (typeof path !== "string" || !SAFE_PORTABLE_PATH.test(path) || byteLength(path) > maximum || !path.split("/").every((part) => Buffer.byteLength(part, "utf8") <= 255)) return false;
  return true;
}

function parseTreeEntry(raw, expectedPath) {
  const entries = raw.split("\0").filter(Boolean);
  if (entries.length !== 1) fail("trusted_blob_invalid");
  const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/.exec(entries[0]);
  if (!match || match[4] !== expectedPath) fail("trusted_blob_invalid");
  return { mode: match[1], type: match[2], objectId: match[3], path: match[4] };
}
function assertTrustedRepositoryPath(value, code = "trusted_blob_invalid") {
  assertString(value, code, 256);
  if (!trustedRepositoryPath(value)) fail(code);
  return value;
}
function readTrustedBlobRecord(repo, commit, path, maximum = TRUSTED_DELIVERY_LIMITS.trustedBlobBytes, { allowAbsent = false } = {}) {
  assertAbsolutePath(repo, "trusted_git_failure"); assertCommit(commit, "trusted_base_invalid"); assertTrustedRepositoryPath(path);
  const treeResult = runGit(repo, ["ls-tree", "-z", commit, "--", path], { maxStdout: 64 * 1024, allowFailure: true });
  if (!treeResult.ok) fail("trusted_blob_invalid");
  if (treeResult.stdout.length === 0) { if (allowAbsent) return null; fail("trusted_blob_invalid"); }
  const entry = parseTreeEntry(treeResult.stdout.toString("utf8"), path);
  if (entry.mode !== "100644" || entry.type !== "blob") fail("trusted_blob_invalid");
  const type = gitTrim(repo, ["cat-file", "-t", entry.objectId], { maxStdout: 128, allowFailure: true });
  const sizeText = gitTrim(repo, ["cat-file", "-s", entry.objectId], { maxStdout: 128, allowFailure: true });
  if (type !== "blob" || !/^\d+$/.test(sizeText)) fail("trusted_blob_invalid");
  const size = Number(sizeText); if (!Number.isSafeInteger(size) || size < 0 || size > maximum) fail(size > maximum ? "trusted_blob_invalid" : "trusted_blob_invalid");
  const blobResult = runGit(repo, ["cat-file", "blob", entry.objectId], { maxStdout: maximum + 1, allowFailure: true });
  if (!blobResult.ok || blobResult.stdout.length !== size || blobResult.stdout.length > maximum) fail("trusted_blob_invalid");
  const algorithm = entry.objectId.length === 40 ? "sha1" : "sha256";
  const objectDigest = createHash(algorithm).update(`blob ${size}\0`, "utf8").update(blobResult.stdout).digest("hex");
  if (objectDigest !== entry.objectId) fail("trusted_blob_invalid");
  return { ...entry, size, content: blobResult.stdout, sha256: sha256Bytes(blobResult.stdout) };
}

/** Read one exact 100644 blob from an exact trusted commit. */
export function readTrustedBlob(...args) {
  const input = isRecord(args[0]) ? args[0] : { repo: args[0], commit: args[1], path: args[2], maximum: args[3] };
  const record = readTrustedBlobRecord(input.repo ?? input.trustedWorktree ?? input.trustedRepo, input.commit ?? input.base ?? input.sha, input.path ?? input.relativePath, input.maximum ?? input.maxBytes ?? TRUSTED_DELIVERY_LIMITS.trustedBlobBytes);
  return { ...record, bytes: record.content };
}

function exactCommit(repo, value, code = "trusted_base_invalid") {
  assertCommit(value, code);
  const resolved = gitTrim(repo, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`], { maxStdout: 128, allowFailure: true });
  const type = gitTrim(repo, ["cat-file", "-t", value], { maxStdout: 128, allowFailure: true });
  if (resolved !== value || type !== "commit") fail(code);
  return value;
}
function assertSupportStatusOwned(repo) {
  const status = runGit(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { maxStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes, allowFailure: true });
  if (!status.ok) fail("candidate_not_clean");
  for (const record of status.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const path = tab >= 0 ? record.slice(tab + 1) : record.startsWith("? ") ? record.slice(2) : record.trim().split(/\s+/).at(-1);
    if (!SLICE1_OWNED_PATHS.has(path)) fail("candidate_not_clean");
  }
}
function assertGitClean(repo, code = "candidate_not_clean") {
  const status = runGit(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { maxStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes, allowFailure: true });
  if (!status.ok) fail(code);
  if (status.stdout.length !== 0) fail(code);
}
function assertNoGitSubstitution(repo, code = "candidate_root_invalid") {
  const shallow = gitTrim(repo, ["rev-parse", "--is-shallow-repository"], { maxStdout: 128, allowFailure: true });
  if (shallow !== "false") fail(code);
  for (const path of ["shallow", "info/grafts", "objects/info/alternates"]) {
    const value = gitTrim(repo, ["rev-parse", "--git-path", path], { maxStdout: 4096, allowFailure: true });
    if (!value) fail(code);
    try {
      const special = lstatSync(resolve(repo, value));
      if (special.isSymbolicLink() || special) fail(code);
    } catch (error) {
      if (error instanceof DeliveryControllerError) throw error;
      if (!(["ENOENT", "ENOTDIR"].includes(error?.code))) fail(code);
    }
  }
  const replacements = gitTrim(repo, ["for-each-ref", "refs/replace", "--format=%(refname)"], { maxStdout: 4096, allowFailure: true });
  if (replacements) fail(code);
}
function verifyWorktree(repoPath, expectedHead, { trusted = false, allowDirty = false } = {}) {
  const repo = canonicalExistingDirectory(repoPath, trusted ? "trusted_base_invalid" : "candidate_root_invalid");
  const top = gitTrim(repo, ["rev-parse", "--show-toplevel"], { maxStdout: TRUSTED_DELIVERY_LIMITS.pathBytes, allowFailure: true });
  let actualTop;
  try { actualTop = top ? realpathSync(resolve(repo, top)) : ""; } catch { actualTop = ""; }
  if (!top || canonicalPathKey(actualTop) !== canonicalPathKey(repo)) fail(trusted ? "trusted_git_failure" : "candidate_root_invalid");
  const format = gitTrim(repo, ["rev-parse", "--show-object-format"], { maxStdout: 128, allowFailure: true });
  if (format !== "sha1" && format !== "sha256") fail(trusted ? "trusted_git_failure" : "candidate_root_invalid");
  const head = gitTrim(repo, ["rev-parse", "--verify", "HEAD^{commit}"], { maxStdout: 128, allowFailure: true });
  if (expectedHead && head !== expectedHead) fail(trusted ? "trusted_base_invalid" : "candidate_head_mismatch");
  exactCommit(repo, expectedHead ?? head, trusted ? "trusted_base_invalid" : "candidate_head_mismatch");
  assertNoGitSubstitution(repo, trusted ? "trusted_git_failure" : "candidate_root_invalid");
  if (!allowDirty) assertGitClean(repo, trusted ? "trusted_git_failure" : "candidate_not_clean");
  if (trusted && gitTrim(repo, ["remote"], { maxStdout: 4096, allowFailure: true }) !== "") fail("trusted_git_failure");
  if (trusted && gitTrim(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], { maxStdout: 1024, allowFailure: true }) !== "") fail("trusted_git_failure");
  return { repo, head, format };
}

function repositoryInventory(repo, head = undefined) {
  const exactHead = head ?? gitTrim(repo, ["rev-parse", "HEAD"], { maxStdout: 128 });
  const branch = gitTrim(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], { maxStdout: 1024, allowFailure: true });
  const tree = runGit(repo, ["ls-tree", "-r", "-l", "--full-tree", exactHead], { maxStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes, allowFailure: true });
  const index = runGit(repo, ["ls-files", "-s", "-z"], { maxStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes, allowFailure: true });
  const status = runGit(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { maxStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes, allowFailure: true });
  const diff = runGit(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "HEAD", "--"], { maxStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes, allowFailure: true });
  const untracked = runGit(repo, ["ls-files", "--others", "--exclude-standard", "-z"], { maxStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes, allowFailure: true });
  const common = gitTrim(repo, ["rev-parse", "--git-common-dir"], { maxStdout: TRUSTED_DELIVERY_LIMITS.pathBytes, allowFailure: true });
  const objects = gitTrim(repo, ["rev-parse", "--git-path", "objects"], { maxStdout: TRUSTED_DELIVERY_LIMITS.pathBytes, allowFailure: true });
  if (!tree.ok || !index.ok || !status.ok || !diff.ok || !untracked.ok || !common || !objects) fail("candidate_inventory_changed");
  const untrackedPaths = untracked.stdout.toString("utf8").split("\0").filter(Boolean).sort();
  const untrackedRecords = untrackedPaths.map((path) => {
    if (!portableArtifactPath(path)) fail("candidate_inventory_changed");
    const absolute = join(repo, ...path.split("/"));
    let info, canonical;
    try { info = lstatSync(absolute); canonical = realpathSync(absolute); } catch { fail("candidate_inventory_changed"); }
    const same = process.platform === "win32" ? canonical.toLowerCase() === resolve(absolute).toLowerCase() : canonical === resolve(absolute);
    if (!info.isFile() || info.isSymbolicLink() || !same) fail("candidate_inventory_changed");
    const bytes = readFileSyncSafe(absolute, TRUSTED_DELIVERY_LIMITS.validatorBytes);
    let after;
    try { after = lstatSync(absolute); } catch { fail("candidate_inventory_changed"); }
    if (!after.isFile() || after.isSymbolicLink() || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ino !== info.ino || after.dev !== info.dev) fail("candidate_inventory_changed");
    return { path, bytes: bytes.length, sha256: sha256Bytes(bytes) };
  });
  return {
    head: exactHead, branch,
    treeSha256: sha256Bytes(tree.stdout), indexSha256: sha256Bytes(index.stdout), statusSha256: sha256Bytes(status.stdout),
    worktreeDiffSha256: sha256Bytes(diff.stdout), untracked: untrackedRecords,
    commonSha256: sha256Bytes(Buffer.from(common, "utf8")), objectsSha256: sha256Bytes(Buffer.from(objects, "utf8")),
  };
}
function sameInventory(left, right) { return canonicalJSONString(left) === canonicalJSONString(right); }

async function safeReadCandidateFile(root, path, maximum) {
  assertPortablePath(path, "candidate_blob_invalid", 256);
  const canonicalRoot = await realpath(root).catch(() => { fail("candidate_root_invalid"); });
  const absolute = resolve(canonicalRoot, ...path.split("/"));
  if (!pathInside(canonicalRoot, absolute)) fail("candidate_blob_invalid");
  const parts = path.split("/"); let current = canonicalRoot;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch(() => { fail("candidate_blob_invalid"); });
    const real = await realpath(current).catch(() => { fail("candidate_blob_invalid"); });
    if (info.isSymbolicLink() || !pathInside(canonicalRoot, real) || real !== resolve(current)) fail("candidate_blob_invalid");
  }
  const before = await lstat(absolute); if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) fail("candidate_blob_invalid");
  const bytes = await readFile(absolute); if (bytes.length !== before.size || bytes.length > maximum) fail("candidate_blob_invalid");
  const after = await lstat(absolute); if (!after.isFile() || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ino !== before.ino || after.dev !== before.dev) fail("candidate_inventory_changed");
  return bytes;
}

function candidateBlob(repo, head, path, maximum) {
  const record = readTrustedBlobRecord(repo, head, path, maximum);
  if (!record) fail("candidate_blob_invalid");
  return record;
}

function safeSpawn(executable, args, cwd, { maxStdout, maxStderr, timeout = TRUSTED_DELIVERY_LIMITS.timeoutMs, env, input } = {}) {
  let result;
  try {
    result = spawnSync(executable, args, { cwd, shell: false, windowsHide: true, encoding: "buffer", timeout, maxBuffer: Math.max(maxStdout, maxStderr), env: env ?? fixedEnvironment(), input });
  } catch { return { ok: false, status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: true }; }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  return { ok: result.status === 0 && !result.error, status: result.status, stdout, stderr, error: result.error, oversized: stdout.length > maxStdout || stderr.length > maxStderr };
}

/** Execute the exact-base planning validator with trusted absolute code and candidate cwd. */
export function runTrustedPlanValidator(input, maybeOptions = {}) {
  assertNode24("test_failed");
  const options = isRecord(input) ? input : { trustedWorktree: input, candidateRoot: maybeOptions.candidateRoot, plan: maybeOptions.plan, manifest: maybeOptions.manifest, base: maybeOptions.base, repository: maybeOptions.repository, ticket: maybeOptions.ticket, ticketRevision: maybeOptions.ticketRevision };
  const trustedWorktree = canonicalExistingDirectory(options.trustedWorktree, "trusted_base_invalid");
  const candidateRoot = canonicalExistingDirectory(options.candidateRoot, "candidate_root_invalid");
  const trustedPath = join(trustedWorktree, "scripts", "validate-implementation-plan.mjs");
  const trustedRecord = readTrustedBlobRecord(trustedWorktree, options.base, TRUSTED_DELIVERY_PATHS.manifestValidator, TRUSTED_DELIVERY_LIMITS.validatorBytes);
  const localBytes = readTrustedWorkingFile(trustedPath, TRUSTED_DELIVERY_LIMITS.validatorBytes);
  if (!localBytes.equals(trustedRecord.content)) fail("trusted_blob_invalid");
  const args = [trustedPath, "--plan", options.plan, "--manifest", options.manifest, "--base", options.base, "--profile", "profiles/pi-sampler.json", "--repository", options.repository, "--ticket", options.ticket, "--ticket-revision", options.ticketRevision, "--json"];
  const result = safeSpawn(process.execPath, args, candidateRoot, { maxStdout: TRUSTED_DELIVERY_LIMITS.validatorStdoutBytes, maxStderr: TRUSTED_DELIVERY_LIMITS.validatorStderrBytes, timeout: TRUSTED_DELIVERY_LIMITS.timeoutMs, env: fixedEnvironment() });
  if (result.oversized || !result.ok) fail("manifest_validator_failed");
  const text = result.stdout.toString("utf8"); if (!Buffer.from(text, "utf8").equals(result.stdout) || !text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail("manifest_validator_failed");
  let output; try { output = JSON.parse(text.slice(0, -1)); } catch { fail("manifest_validator_failed"); }
  if (!isRecord(output) || canonicalJSONLine(output).toString("utf8") !== text) fail("manifest_validator_failed");
  const outputKeys = ["format", "version", "ok", "bindings", "diagnostics", "summary"];
  if (Object.keys(output).some((key, index) => key !== outputKeys[index]) || output.format !== "pi-sampler.implementation-plan-validator" || output.version !== 1 || output.ok !== true || !Array.isArray(output.diagnostics) || !isRecord(output.summary)) fail("manifest_validator_failed");
  if (output.summary?.input_schema === "acceptance-manifest/v1") fail("manifest_version_unsupported");
  if (output.summary?.input_schema !== "implementation-plan-manifest/v2" || output.summary?.diagnostic_count !== 0 || output.summary?.error_count !== 0) fail("manifest_validator_failed");
  if (output.bindings?.base_sha !== options.base || output.bindings?.repository !== options.repository || output.bindings?.ticket_id !== options.ticket || output.bindings?.ticket_revision !== options.ticketRevision || output.bindings?.plan_path !== options.plan || output.bindings?.manifest_path !== options.manifest) fail("manifest_validator_failed");
  return output;
}
function readFileSyncSafe(path, maximum) {
  let bytes; try { bytes = requireReadFile(path); } catch { fail("trusted_blob_invalid"); }
  if (bytes.length > maximum) fail("trusted_blob_invalid"); return bytes;
}
function readTrustedWorkingFile(path, maximum) {
  let before, canonical;
  try { before = lstatSync(path); canonical = realpathSync(path); } catch { fail("trusted_blob_invalid"); }
  if (!before.isFile() || before.isSymbolicLink() || canonicalPathKey(canonical) !== canonicalPathKey(path)) fail("trusted_blob_invalid");
  const bytes = readFileSyncSafe(path, maximum);
  let after;
  try { after = lstatSync(path); } catch { fail("trusted_blob_invalid"); }
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ino !== before.ino || after.dev !== before.dev) fail("trusted_blob_invalid");
  return bytes;
}
function requireReadFile(path) {
  // Keeping this synchronous helper isolated avoids a mutable async read in a
  // trusted-code comparison immediately before process spawn.
  const fs = process.getBuiltinModule?.("node:fs");
  if (!fs) throw new Error("fs unavailable");
  return fs.readFileSync(path);
}

function profileAtTrustedBase(trustedWorktree, base) {
  const record = readTrustedBlobRecord(trustedWorktree, base, TRUSTED_DELIVERY_PATHS.profile, 2 * 1024 * 1024);
  let profile; try { profile = JSON.parse(record.content.toString("utf8")); } catch { fail("trusted_blob_invalid"); }
  if (!isRecord(profile) || profile.repository?.source === undefined || !REPOSITORY.test(profile.repository.source)) fail("trusted_blob_invalid");
  return { profile, record };
}
function parseStrictObject(bytes, code) {
  const text = bytes.toString("utf8"); if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
  try { return JSON.parse(text); } catch { fail(code); }
}

/** Build the exact normalized-facts object and its domain-separated digest. */
export function buildNormalizedFacts(matrix) {
  if (!isRecord(matrix)) fail("usage_invalid");
  const facts = {
    format: "pi-sampler.delivery-normalized-facts",
    version: 1,
    repository: matrix.repository,
    ticketId: matrix.ticket_id,
    ticketRevision: matrix.ticket_revision,
    profilePath: matrix.profile_path,
    profileSha256: matrix.profile_sha256,
    baseSha: matrix.base_sha,
    headSha: matrix.head_sha,
    pullRequestNumber: matrix.pull_request_number,
    planPath: matrix.plan_path,
    planSha256: matrix.plan_sha256,
    manifestPath: matrix.manifest_path,
    manifestSha256: matrix.manifest_sha256,
    manifestSchemaVersion: matrix.manifest_schema_version,
    manifestContractSha256: matrix.manifest_contract_sha256,
    manifestValidatorSha256: matrix.manifest_validator_sha256,
    matrixContractSha256: matrix.matrix_contract_sha256,
    policySha256: matrix.policy_sha256,
    evaluationScope: matrix.evaluation_scope,
    rows: (Array.isArray(matrix.rows) ? matrix.rows : []).map((row) => ({ id: row.id, acceptanceClass: row.acceptance_class, requirement: row.requirement })),
  };
  const bytes = Buffer.from(`${canonicalJSONString(facts)}\n`, "utf8");
  const digest = sha256Bytes(Buffer.concat([Buffer.from("pi-sampler.delivery-normalized-facts/v1\0", "utf8"), bytes]));
  return { facts, bytes, factsSha256: digest };
}

function readExternalInput(path, maximum, disjoint = []) {
  const absolute = canonicalExistingFile(path, "candidate_root_invalid", maximum);
  for (const other of disjoint) {
    if (!other) continue;
    const otherAbs = resolve(other);
    if (pathInside(otherAbs, absolute) || pathInside(absolute, otherAbs)) fail("candidate_root_invalid");
  }
  let before;
  try { before = lstatSync(absolute); } catch { fail("candidate_root_invalid"); }
  const bytes = readFileSyncSafe(absolute, maximum);
  let after;
  try { after = lstatSync(absolute); } catch { fail("candidate_inventory_changed"); }
  if (!before.isFile() || before.isSymbolicLink() || after.isSymbolicLink() || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ino !== before.ino || after.dev !== before.dev) fail("candidate_inventory_changed");
  return bytes;
}
function canonicalExistingFile(path, code, maximum) {
  assertAbsolutePath(path, code);
  let info, canonical;
  try { info = lstatSync(path); canonical = realpathSync(path); } catch { fail(code); }
  const same = canonicalPathKey(canonical) === canonicalPathKey(resolve(path));
  if (!info.isFile() || info.isSymbolicLink() || !same || info.size > maximum) fail(code);
  return canonical;
}
function authenticatedGitDirectories(repo, failureCode) {
  const common = gitTrim(repo, ["rev-parse", "--git-common-dir"], { maxStdout: TRUSTED_DELIVERY_LIMITS.pathBytes, allowFailure: true });
  const objects = gitTrim(repo, ["rev-parse", "--git-path", "objects"], { maxStdout: TRUSTED_DELIVERY_LIMITS.pathBytes, allowFailure: true });
  if (!common || !objects) fail(failureCode);
  return [canonicalExistingDirectory(resolve(repo, common), failureCode), canonicalExistingDirectory(resolve(repo, objects), failureCode)];
}
function authenticatedExclusions(trustedRepo, candidateRepo, source, roots) {
  if (!source || !isRecord(source) || !roots) fail("trusted_blob_invalid");
  const values = [
    source.path, trustedRepo, candidateRepo, ...authenticatedGitDirectories(source.path, "trusted_git_failure"), ...authenticatedGitDirectories(trustedRepo, "trusted_git_failure"), ...authenticatedGitDirectories(candidateRepo, "candidate_root_invalid"),
    roots.worktreeRoot, roots.reviewRoot, roots.quarantineRoot, tmpdir(),
  ];
  const exclusions = [];
  const seen = new Set();
  for (const value of values) {
    const canonical = canonicalExistingDirectory(value, "candidate_root_invalid");
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (!seen.has(key)) { seen.add(key); exclusions.push(canonical); }
  }
  return { exclusions, roots };
}
function assertRequiredAuthenticatedExclusions(exclusions, source, trustedRepo, candidateRepo, roots) {
  if (!Array.isArray(exclusions) || !source || !roots) fail("candidate_root_invalid");
  const actual = new Set(exclusions.map((value) => canonicalPathKey(value)));
  const required = [source.path, trustedRepo, candidateRepo, roots.worktreeRoot, roots.reviewRoot, roots.quarantineRoot];
  if (required.some((value) => typeof value !== "string" || !actual.has(canonicalPathKey(value)))) fail("candidate_root_invalid");
}

function evaluatorEnvelopeValid(value, expectedStatus) {
  const keys = ["format", "version", "status", "code", "evaluation_scope", "facts_sha256", "matrix_sha256", "rows", "diagnostics"];
  if (!isRecord(value) || Object.keys(value).some((key, index) => key !== keys[index]) || value.format !== "pi-sampler.delivery-acceptance-result" || value.version !== 1 || value.status !== expectedStatus || typeof value.code !== "string" || !Array.isArray(value.rows) || !Array.isArray(value.diagnostics)) return false;
  if (!DIGEST.test(value.facts_sha256) || !DIGEST.test(value.matrix_sha256) || !["plan-publication", "implementation-delivery"].includes(value.evaluation_scope)) return false;
  if (value.diagnostics.some((entry) => !isRecord(entry) || typeof entry.code !== "string" || typeof entry.path !== "string")) return false;
  if (value.rows.some((entry) => !isRecord(entry) || typeof entry.id !== "string" || !["valid", "blocked", "invalid"].includes(entry.status) || typeof entry.code !== "string")) return false;
  if (expectedStatus === "valid" && (![
    "specified", "observed",
  ].includes(value.code) || value.diagnostics.length !== 0 || value.rows.some((entry) => entry.status !== "valid"))) return false;
  if (expectedStatus === "blocked" && (!["rows_blocked", "unsupported_class_policy"].includes(value.code) || value.diagnostics.length === 0 || !value.rows.some((entry) => entry.status === "blocked"))) return false;
  if (expectedStatus === "invalid" && (["specified", "observed", "rows_blocked", "unsupported_class_policy", "valid"].includes(value.code) || value.diagnostics.length === 0 || value.rows.some((entry) => entry.status !== "invalid"))) return false;
  return true;
}
export function parseEvaluatorEnvelope(result) {
  if (!result || result.oversized || result.error || ![0, 1, 3].includes(result.status)) fail("test_failed");
  const output = result.stdout.toString("utf8");
  if (!Buffer.from(output, "utf8").equals(result.stdout) || !output.endsWith("\n") || output.slice(0, -1).includes("\n")) fail("test_failed");
  let parsed;
  try { parsed = JSON.parse(output.slice(0, -1)); } catch { fail("test_failed"); }
  if (canonicalJSONLine(parsed).toString("utf8") !== output) fail("test_failed");
  const expectedStatus = result.status === 0 ? "valid" : result.status === 1 ? "invalid" : "blocked";
  if (!evaluatorEnvelopeValid(parsed, expectedStatus)) fail("test_failed");
  return parsed;
}
function invokeGoEvaluator(trustedWorktree, request, toolchain, exclusions = []) {
  const input = Buffer.from(`${canonicalJSONString(request)}\n`, "utf8");
  if (input.length > 12 * 1024 * 1024) fail("test_failed");
  if (!toolchain || !isAbsolute(toolchain.path) || !DIGEST.test(toolchain.sha256)) fail("test_failed");
  if (sha256Bytes(executableDigest(toolchain.path).bytes) !== toolchain.sha256) fail("test_failed");
  const environment = fixedEnvironment(process.env, toolchain.path);
  environment.PI_SAMPLER_DELIVERY_V2_EXCLUSIONS = canonicalJSONString(exclusions);
  let buildRoot;
  try { buildRoot = mkdtempSync(join(tmpdir(), "pi-sampler-delivery-v2-")); } catch { fail("test_failed"); }
  const output = join(buildRoot, process.platform === "win32" ? "delivery-evidence-validator.exe" : "delivery-evidence-validator");
  try {
    const build = safeSpawn(toolchain.path, ["build", "-o", output, "./cmd/delivery-evidence-validator"], join(trustedWorktree, "governance"), { maxStdout: 64 * 1024, maxStderr: 64 * 1024, timeout: 900_000, env: environment });
    if (!build.ok || build.oversized || build.error) fail("test_failed");
    const result = safeSpawn(output, ["-mode", "acceptance-v2"], join(trustedWorktree, "governance"), { maxStdout: 1024 * 1024, maxStderr: 64 * 1024, timeout: 900_000, env: environment, input });
    const parsed = parseEvaluatorEnvelope(result);
    if (sha256Bytes(executableDigest(toolchain.path).bytes) !== toolchain.sha256) fail("test_failed");
    return parsed;
  } finally {
    try { rmSync(buildRoot, { recursive: true, force: true }); } catch { /* residue is never evidence */ }
  }
}

function runSupportCommand(candidateRoot, argv, { transitionChild = false } = {}) {
  const executable = process.execPath;
  const args = argv[0] === "npm"
    ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...argv.slice(1)]
    : argv.slice(1);
  const environment = fixedEnvironment();
  if (transitionChild) environment.AIDEV191_TRANSITION_CHILD = "1";
  const result = safeSpawn(executable, args, candidateRoot, { maxStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes, maxStderr: TRUSTED_DELIVERY_LIMITS.stderrBytes, timeout: 900_000, env: environment });
  return { argv, status: result.status ?? -1, ok: result.ok && !result.oversized, stdoutSha256: sha256Bytes(result.stdout), stderrSha256: sha256Bytes(result.stderr) };
}
function supportReport(base, head, paths, commandResults, before, after) {
  const testReport = { format: "pi-sampler.delivery-v2-support-tests", version: 1, commands: commandResults };
  return {
    format: DELIVERY_V2_SUPPORT_REPORT_FORMAT,
    version: DELIVERY_V2_SUPPORT_REPORT_VERSION,
    status: DELIVERY_V2_SUPPORT_AUTHORITY,
    authority: DELIVERY_V2_SUPPORT_CAN_GRANT_AUTHORITY,
    base_sha: base,
    head_sha: head,
    paths,
    test_report_sha256: sha256Bytes(Buffer.from(`${canonicalJSONString(testReport)}\n`, "utf8")),
    repository_inventory_sha256: sha256Bytes(Buffer.from(`${canonicalJSONString({ before, after })}\n`, "utf8")),
  };
}

async function runSupport(options) {
  assertNode24();
  const candidateRoot = canonicalExistingDirectory(options.candidateRoot ?? process.cwd(), "candidate_root_invalid");
  const expectedHead = options.expectedHead ?? gitTrim(candidateRoot, ["rev-parse", "HEAD"], { maxStdout: 128, allowFailure: true });
  const candidate = verifyWorktree(candidateRoot, expectedHead, { trusted: false, allowDirty: true });
  assertSupportStatusOwned(candidate.repo);
  const base = options.trustedBase ?? expectedHead;
  assertCommit(base, "trusted_base_invalid");
  exactCommit(candidate.repo, base, "trusted_base_invalid");
  const ancestry = runGit(candidate.repo, ["merge-base", "--is-ancestor", base, candidate.head], { maxStdout: 128, allowFailure: true });
  if (!ancestry.ok) fail("trusted_base_invalid");
  const before = repositoryInventory(candidate.repo, candidate.head);
  const commands = [
    ["node", "--test", "tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs"],
    ["node", "scripts/run-governance-tests.mjs"],
    ["npm", "test"],
  ];
  const commandResults = commands.map((argv) => runSupportCommand(candidate.repo, argv));
  if (commandResults.some((result) => !result.ok)) fail("test_failed");
  const after = repositoryInventory(candidate.repo, candidate.head);
  if (!sameInventory(before, after)) fail("candidate_inventory_changed");
  const paths = ["tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs", "scripts/run-governance-tests.mjs", "package.json"];
  return supportReport(base, candidate.head, paths, commandResults, before, after);
}

function requireOption(options, keys) { for (const key of keys) if (options[key] === undefined) fail("usage_invalid"); if (options.expectedPR !== undefined && Number(options.expectedPR) > 1_000_000_000) fail("usage_invalid"); }
function activationValue(value) {
  if (!isRecord(value) || value.format !== ACTIVATION_FORMAT || value.version !== 1 || value.state !== "active" || Object.keys(value).some((key) => !["format", "version", "state"].includes(key))) fail("activation_invalid");
  return value;
}
function trustedRepositoryPath(value) {
  if (typeof value !== "string" || byteLength(value) === 0 || byteLength(value) > 256 || value.includes("\0") || value.includes("\\") || value.includes("//") || value.includes("%") || value.includes(":") || [...value].some((character) => character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f)) return false;
  const parts = value.split("/");
  return parts.length <= 32 && parts.every((part) => part && part !== "." && part !== ".." && !part.endsWith(".") && !part.endsWith(" ") && byteLength(part) <= 255);
}
function trustedMapCandidateEntries(value) { return Array.isArray(value.candidate_paths) ? value.candidate_paths : []; }
function exactPathDigestEntries(value, property) {
  const entries = value[property];
  if (!Array.isArray(entries) || entries.length === 0) fail("activation_map_invalid");
  if (entries.some((entry) => !isRecord(entry) || typeof entry.path !== "string" || !trustedRepositoryPath(entry.path) || typeof entry.sha256 !== "string" || !DIGEST.test(entry.sha256))) fail("activation_map_invalid");
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) fail("activation_map_invalid");
  return entries;
}
function trustedMapValue(value, expected = undefined) {
  if (!isRecord(value) || value.format !== TRUSTED_MAP_FORMAT || value.version !== 1) fail("activation_map_invalid");
  const requiredKeys = ["format", "version", "activation_sha256", "predecessor_base", "trusted_paths", "candidate_paths"];
  if (Object.keys(value).length !== requiredKeys.length || Object.keys(value).some((key, index) => key !== requiredKeys[index])) fail("activation_map_invalid");
  if (!DIGEST.test(value.activation_sha256) || !SHA.test(value.predecessor_base)) fail("activation_map_invalid");
  const trustedPaths = exactPathDigestEntries(value, "trusted_paths");
  const candidatePaths = exactPathDigestEntries(value, "candidate_paths");
  if (candidatePaths.some((entry) => entry.path === "contracts/delivery-acceptance-v2-trusted-map.json")) fail("activation_map_invalid");
  if (expected) {
    if (value.activation_sha256 !== sha256Bytes(expected.activationBytes)) fail("trusted_digest_mismatch");
    if (expected.predecessorBase !== undefined && value.predecessor_base !== expected.predecessorBase) fail("activation_map_invalid");
    if (expected.candidatePaths && (candidatePaths.length !== expected.candidatePaths.length || candidatePaths.some((entry, index) => entry.path !== expected.candidatePaths[index].path || entry.sha256 !== expected.candidatePaths[index].sha256))) fail("activation_map_invalid");
    if (expected.trustedPaths && (trustedPaths.length !== expected.trustedPaths.length || trustedPaths.some((entry, index) => entry.path !== expected.trustedPaths[index].path || entry.sha256 !== expected.trustedPaths[index].sha256))) fail("trusted_digest_mismatch");
  }
  return value;
}
export function validateTrustedMap(value, expected = undefined) { return trustedMapValue(value, expected); }

function verifyTrustedPredecessors(trustedWorktree, base) {
  const paths = [TRUSTED_DELIVERY_PATHS.manifestContract, "contracts/implementation-plan-manifest-v2.schema.json", TRUSTED_DELIVERY_PATHS.manifestValidator, TRUSTED_DELIVERY_PATHS.matrixSchema, TRUSTED_DELIVERY_PATHS.profile, TRUSTED_DELIVERY_PATHS.profileSchema, TRUSTED_DELIVERY_PATHS.acceptanceGo, TRUSTED_DELIVERY_PATHS.posixRoot, TRUSTED_DELIVERY_PATHS.windowsRoot, TRUSTED_DELIVERY_PATHS.validatorMain, TRUSTED_DELIVERY_PATHS.controller];
  const records = [];
  for (const path of paths) {
    const maximum = path.endsWith(".go") ? TRUSTED_DELIVERY_LIMITS.goBytes : path.endsWith("validator.mjs") || path.endsWith("controller.mjs") ? TRUSTED_DELIVERY_LIMITS.validatorBytes : TRUSTED_DELIVERY_LIMITS.trustedBlobBytes;
    records.push(readTrustedBlobRecord(trustedWorktree, base, path, maximum));
  }
  return records;
}

export function enumerateCommittedSlice2Diff(repo, base, head) {
  const result = runGit(repo, ["diff", "--raw", "-z", "--full-index", "--abbrev=64", "--find-renames", "--find-copies", "--no-ext-diff", "--no-textconv", base, head, "--"], { maxStdout: TRUSTED_DELIVERY_LIMITS.stdoutBytes, allowFailure: true });
  if (!result.ok) fail("candidate_blob_invalid");
  const bytes = result.stdout;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("candidate_blob_invalid");
  const tokens = text.split("\0");
  const records = [];
  for (let index = 0; index < tokens.length - 1;) {
    const header = tokens[index++];
    if (header === "") continue;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z][0-9]*)$/.exec(header);
    if (!match) fail("candidate_blob_invalid");
    const status = match[5][0];
    const oldPath = tokens[index++];
    if (typeof oldPath !== "string" || oldPath === "") fail("candidate_blob_invalid");
    const newPath = status === "R" || status === "C" ? tokens[index++] : oldPath;
    if (typeof newPath !== "string" || newPath === "" || status === "R" || status === "C") fail("candidate_blob_invalid");
    if (!((status === "A" && match[1] === "000000" && match[2] === "100644") || (status === "M" && match[1] === "100644" && match[2] === "100644"))) fail("candidate_blob_invalid");
    records.push({ status, oldMode: match[1], mode: match[2], type: match[2] === "100644" ? "blob" : "unknown", path: newPath });
  }
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (records.length !== Object.keys(SLICE2_PATH_MODES).length || new Set(records.map((entry) => entry.path)).size !== records.length) fail("candidate_blob_invalid");
  for (const record of records) if (SLICE2_PATH_MODES[record.path] !== (record.status === "A" ? "new" : record.status === "M" ? "modified" : "never")) fail("candidate_blob_invalid");
  return records;
}
const committedSlice2Diff = enumerateCommittedSlice2Diff;
function assertExactWireKeys(value, expected, code = "test_failed") {
  if (!isRecord(value) || Object.keys(value).length !== expected.length || Object.keys(value).some((key, index) => key !== expected[index])) fail(code);
}
function expectedSlice2DigestEntries(candidate, diffRecords, map) {
  const expectedPaths = SLICE2_MAP_PATHS;
  const candidateEntries = trustedMapCandidateEntries(map);
  if (candidateEntries.length !== expectedPaths.length || candidateEntries.some((entry, index) => entry.path !== expectedPaths[index])) fail("activation_map_invalid");
  for (const entry of candidateEntries) {
    if (!DIGEST.test(entry.sha256)) fail("activation_map_invalid");
    const record = candidateBlob(candidate.repo, candidate.head, entry.path, TRUSTED_DELIVERY_LIMITS.trustedBlobBytes);
    if (record.sha256 !== entry.sha256) fail("activation_map_invalid");
  }
  if (diffRecords.some((record) => !Object.prototype.hasOwnProperty.call(SLICE2_PATH_MODES, record.path))) fail("candidate_blob_invalid");
  return candidateEntries;
}

async function runTransition(options, dependencies = {}) {
  assertNode24("test_failed");
  requireOption(options, ["trustedBase", "trustedWorktree", "candidateRoot", "candidateActivation", "candidateActivationMap", "expectedHead", "expectedRepository", "expectedTicket", "expectedTicketRevision", "expectedPR"]);
  if (options.candidateActivation !== "contracts/delivery-acceptance-v2-activation.json" || options.candidateActivationMap !== "contracts/delivery-acceptance-v2-trusted-map.json") fail("usage_invalid");
  const trusted = verifyWorktree(options.trustedWorktree, options.trustedBase, { trusted: true });
  const activation = readTrustedBlobRecord(trusted.repo, options.trustedBase, options.candidateActivation, TRUSTED_DELIVERY_LIMITS.trustedBlobBytes, { allowAbsent: true });
  if (activation) fail("transition_activation_already_present");
  const map = readTrustedBlobRecord(trusted.repo, options.trustedBase, options.candidateActivationMap, TRUSTED_DELIVERY_LIMITS.trustedBlobBytes, { allowAbsent: true });
  if (map) fail("transition_activation_map_already_present");
  const predecessorRecords = verifyTrustedPredecessors(trusted.repo, options.trustedBase);
  const candidate = verifyWorktree(options.candidateRoot, options.expectedHead, { trusted: false });
  if (pathInside(trusted.repo, candidate.repo) || pathInside(candidate.repo, trusted.repo)) fail("candidate_root_invalid");
  const authenticated = deriveAuthenticatedSourceRoot(trusted.repo, options.trustedBase, options.expectedRepository, candidate.repo);
  const { source, roots: managedRoots } = authenticated;
  assertManagedRootsStable(managedRoots);
  assertAuthenticatedSourceStable(source);
  const ancestry = runGit(candidate.repo, ["merge-base", "--is-ancestor", options.trustedBase, candidate.head], { maxStdout: 128, allowFailure: true });
  if (!ancestry.ok) fail("candidate_head_mismatch");
  const diffRecords = committedSlice2Diff(candidate.repo, options.trustedBase, candidate.head);
  const activationBytes = await safeReadCandidateFile(candidate.repo, options.candidateActivation, TRUSTED_DELIVERY_LIMITS.trustedBlobBytes);
  const mapBytes = await safeReadCandidateFile(candidate.repo, options.candidateActivationMap, TRUSTED_DELIVERY_LIMITS.trustedBlobBytes);
  const activationValueObject = parseCanonicalJSON(activationBytes, "activation_invalid", canonicalActivation);
  activationValue(activationValueObject);
  const transitionMap = trustedMapValue(parseCanonicalJSON(mapBytes, "activation_map_invalid", canonicalTransitionMap), { activationBytes, predecessorBase: options.trustedBase, trustedPaths: predecessorRecords.map((record) => ({ path: record.path, sha256: record.sha256 })) });
  expectedSlice2DigestEntries(candidate, diffRecords, transitionMap);
  const activationPathRecord = candidateBlob(candidate.repo, candidate.head, options.candidateActivation, TRUSTED_DELIVERY_LIMITS.trustedBlobBytes);
  const mapPathRecord = candidateBlob(candidate.repo, candidate.head, options.candidateActivationMap, TRUSTED_DELIVERY_LIMITS.trustedBlobBytes);
  if (!activationPathRecord.content.equals(activationBytes) || !mapPathRecord.content.equals(mapBytes)) fail("candidate_blob_invalid");
  const before = repositoryInventory(candidate.repo, candidate.head);
  const runFocusedTests = dependencies.runSupportCommand ?? ((candidateRoot, argv) => runSupportCommand(candidateRoot, argv, { transitionChild: true }));
  const testResults = [runFocusedTests(candidate.repo, ["node", "--test", "tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs"])];
  if (testResults.some((result) => !result.ok)) fail("test_failed");
  assertGitClean(candidate.repo, "candidate_not_clean");
  const after = repositoryInventory(candidate.repo, candidate.head);
  if (!sameInventory(before, after)) fail("candidate_inventory_changed");
  assertAuthenticatedSourceStable(source);
  assertManagedRootsStable(managedRoots);
  const testReport = { format: "pi-sampler.delivery-v2-transition-tests", version: 1, suite: ["tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs"], recursive: false, commands: testResults };
  assertExactWireKeys(testReport, ["format", "version", "suite", "recursive", "commands"], "test_failed");
  if (testReport.suite.length !== 2 || testReport.suite[0] !== "tests/delivery-acceptance.test.mjs" || testReport.suite[1] !== "tests/delivery-acceptance-v2.test.mjs" || testReport.recursive !== false || testResults.length !== 1 || testResults[0].argv.join("\u0000") !== ["node", "--test", "tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs"].join("\u0000")) fail("test_failed");
  const receipt = {
    format: "pi-sampler.delivery-v2-transition-receipt", version: 1, status: "valid", code: "transition_ready", authority: false,
    trusted_base: options.trustedBase, candidate_head: candidate.head, repository: options.expectedRepository, ticket_id: options.expectedTicket, ticket_revision: options.expectedTicketRevision, pull_request_number: Number(options.expectedPR),
    trusted_paths: predecessorRecords.map((record) => ({ path: record.path, sha256: record.sha256 })),
    activation_path: options.candidateActivation, activation_sha256: sha256Bytes(activationBytes), activation_map_path: options.candidateActivationMap,
    activation_map_sha256: sha256Bytes(mapBytes), candidate_paths: diffRecords.map((record) => record.path), test_report_sha256: sha256Bytes(canonicalJSONLine(testReport)),
    inventory_before_sha256: sha256Bytes(canonicalJSONLine(before)), inventory_after_sha256: sha256Bytes(canonicalJSONLine(after)), state: "will-activate-after-merge",
  };
  assertExactWireKeys(receipt, ["format", "version", "status", "code", "authority", "trusted_base", "candidate_head", "repository", "ticket_id", "ticket_revision", "pull_request_number", "trusted_paths", "activation_path", "activation_sha256", "activation_map_path", "activation_map_sha256", "candidate_paths", "test_report_sha256", "inventory_before_sha256", "inventory_after_sha256", "state"], "test_failed");
  return receipt;
}

async function runValidate(options, dependencies = {}) {
  assertNode24("test_failed");
  requireOption(options, ["trustedBase", "trustedWorktree", "candidateRoot", "plan", "manifest", "matrix", "evidenceRoot", "expectedHead", "expectedRepository", "expectedTicket", "expectedTicketRevision", "expectedPR", "evaluationScope"]);
  const trusted = verifyWorktree(options.trustedWorktree, options.trustedBase, { trusted: true });
  const activationRecord = readTrustedBlobRecord(trusted.repo, options.trustedBase, "contracts/delivery-acceptance-v2-activation.json", TRUSTED_DELIVERY_LIMITS.trustedBlobBytes, { allowAbsent: true });
  if (!activationRecord) fail("activation_absent");
  const mapRecord = readTrustedBlobRecord(trusted.repo, options.trustedBase, "contracts/delivery-acceptance-v2-trusted-map.json", TRUSTED_DELIVERY_LIMITS.trustedBlobBytes, { allowAbsent: true });
  if (!mapRecord) fail("activation_map_absent");
  const activation = parseCanonicalJSON(activationRecord.content, "activation_invalid", canonicalActivation);
  activationValue(activation);
  const rawMap = parseCanonicalJSON(mapRecord.content, "activation_map_invalid", canonicalTransitionMap);
  const trustedMap = trustedMapValue(rawMap, { activationBytes: activationRecord.content });
  if (gitTrim(trusted.repo, ["rev-parse", "--verify", "--end-of-options", `${options.trustedBase}^1`], { maxStdout: 128, allowFailure: true }) !== trustedMap.predecessor_base) fail("activation_map_invalid");
  const predecessorRecords = verifyTrustedPredecessors(trusted.repo, trustedMap.predecessor_base);
  if (trustedMap.trusted_paths.length !== predecessorRecords.length || trustedMap.trusted_paths.some((entry, index) => entry.path !== predecessorRecords[index].path || entry.sha256 !== predecessorRecords[index].sha256)) fail("trusted_digest_mismatch");
  const activatedDiff = committedSlice2Diff(trusted.repo, trustedMap.predecessor_base, options.trustedBase);
  expectedSlice2DigestEntries(trusted, activatedDiff, trustedMap);
  const candidate = verifyWorktree(options.candidateRoot, options.expectedHead, { trusted: false });
  if (candidate.head === options.trustedBase) fail("candidate_head_mismatch");
  if (pathInside(trusted.repo, candidate.repo) || pathInside(candidate.repo, trusted.repo)) fail("candidate_root_invalid");
  const authenticated = deriveAuthenticatedSourceRoot(trusted.repo, options.trustedBase, options.expectedRepository, candidate.repo);
  const { source, profile, profileRecord, roots: managedRoots } = authenticated;
  assertManagedRootsStable(managedRoots);
  assertAuthenticatedSourceStable(source);
  const ancestry = runGit(candidate.repo, ["merge-base", "--is-ancestor", options.trustedBase, candidate.head], { maxStdout: 128, allowFailure: true });
  if (!ancestry.ok) fail("candidate_head_mismatch");
  const exclusionState = (dependencies.authenticatedExclusions ?? authenticatedExclusions)(trusted.repo, candidate.repo, source, managedRoots);
  const exclusions = exclusionState.exclusions;
  assertRequiredAuthenticatedExclusions(exclusions, source, trusted.repo, candidate.repo, managedRoots);
  const candidateBefore = repositoryInventory(candidate.repo, candidate.head);
  const planBytes = await safeReadCandidateFile(candidate.repo, options.plan, 4 * 1024 * 1024);
  const manifestBytes = await safeReadCandidateFile(candidate.repo, options.manifest, TRUSTED_DELIVERY_LIMITS.matrixBytes);
  const planRecord = candidateBlob(candidate.repo, candidate.head, options.plan, 4 * 1024 * 1024);
  const manifestRecord = candidateBlob(candidate.repo, candidate.head, options.manifest, TRUSTED_DELIVERY_LIMITS.matrixBytes);
  if (!planRecord.content.equals(planBytes) || !manifestRecord.content.equals(manifestBytes)) fail("candidate_inventory_changed");
  const matrixBytes = readExternalInput(options.matrix, TRUSTED_DELIVERY_LIMITS.matrixBytes, exclusions);
  const evidenceRoot = canonicalExistingDirectory(options.evidenceRoot, "candidate_root_invalid");
  if (exclusions.some((excluded) => pathInside(excluded, evidenceRoot) || pathInside(evidenceRoot, excluded))) fail("candidate_root_invalid");
  const matrix = parseStrictObject(matrixBytes, "candidate_blob_invalid");
  if (!isRecord(matrix) || matrix.evaluation_scope !== options.evaluationScope) fail("candidate_blob_invalid");
  const validatorOutput = (dependencies.runTrustedPlanValidator ?? runTrustedPlanValidator)({ trustedWorktree: trusted.repo, candidateRoot: candidate.repo, plan: options.plan, manifest: options.manifest, base: options.trustedBase, repository: options.expectedRepository, ticket: options.expectedTicket, ticketRevision: options.expectedTicketRevision });
  if (!isRecord(validatorOutput) || validatorOutput.ok !== true || !isRecord(validatorOutput.summary) || validatorOutput.summary.input_schema !== "implementation-plan-manifest/v2" || validatorOutput.summary.diagnostic_count !== 0 || validatorOutput.summary.error_count !== 0) fail("manifest_validator_failed");
  const trustedContractRecords = [
    [TRUSTED_DELIVERY_PATHS.manifestContract, 4 * 1024 * 1024],
    [TRUSTED_DELIVERY_PATHS.manifestValidator, TRUSTED_DELIVERY_LIMITS.validatorBytes],
    [TRUSTED_DELIVERY_PATHS.matrixSchema, TRUSTED_DELIVERY_LIMITS.trustedBlobBytes],
  ].map(([path, maximum]) => readTrustedBlobRecord(trusted.repo, options.trustedBase, path, maximum));
  const matrixSchema = parseStrictObject(trustedContractRecords[2].content, "trusted_blob_invalid");
  if (!validateAcceptanceV2Utf8Fields(matrix, matrixSchema)) fail("candidate_blob_invalid");
  const expectedBindings = {
    repository: options.expectedRepository, ticket_id: options.expectedTicket, ticket_revision: options.expectedTicketRevision,
    base_sha: options.trustedBase, head_sha: candidate.head, pull_request_number: Number(options.expectedPR),
    profile_path: TRUSTED_DELIVERY_PATHS.profile, profile_sha256: profileRecord.sha256, policy_path: TRUSTED_DELIVERY_PATHS.profile, policy_sha256: profileRecord.sha256,
    plan_path: options.plan, plan_sha256: sha256Bytes(planBytes), manifest_path: options.manifest, manifest_sha256: sha256Bytes(manifestBytes),
    manifest_schema_version: "implementation-plan-manifest/v2", manifest_contract_sha256: trustedContractRecords[0].sha256,
    manifest_validator_sha256: trustedContractRecords[1].sha256, matrix_contract_sha256: trustedContractRecords[2].sha256,
  };
  for (const [key, value] of Object.entries(expectedBindings)) if (matrix[key] !== value) fail("candidate_blob_invalid");
  if (validatorOutput.bindings?.plan_path !== options.plan || validatorOutput.bindings?.manifest_path !== options.manifest || validatorOutput.bindings?.base_sha !== options.trustedBase || validatorOutput.bindings?.ticket_revision !== options.expectedTicketRevision || validatorOutput.bindings?.repository !== options.expectedRepository || validatorOutput.bindings?.ticket_id !== options.expectedTicket) fail("manifest_validator_failed");
  const factsResult = buildNormalizedFacts({ ...matrix, head_sha: candidate.head, base_sha: options.trustedBase, profile_sha256: profileRecord.sha256, policy_sha256: profileRecord.sha256, manifest_contract_sha256: trustedContractRecords[0].sha256, manifest_validator_sha256: trustedContractRecords[1].sha256, matrix_contract_sha256: trustedContractRecords[2].sha256 });
  const request = {
    format: "pi-sampler.delivery-acceptance-v2-request", version: 1, normalized_facts: factsResult.facts, facts_sha256: factsResult.factsSha256,
    matrix_base64: matrixBytes.toString("base64"), evidence_root: evidenceRoot, policy: profile.acceptance,
    controller_time: new Date().toISOString(),
  };
  assertExactWireKeys(request, ["format", "version", "normalized_facts", "facts_sha256", "matrix_base64", "evidence_root", "policy", "controller_time"], "test_failed");
  const toolchain = (dependencies.resolveAuthorityGoToolchain ?? resolveAuthorityGoToolchain)();
  let result;
  if (dependencies.invokeGoEvaluator) {
    const injected = dependencies.invokeGoEvaluator(request, { trustedRepo: trusted.repo, candidateRepo: candidate.repo, toolchain, exclusions });
    const exitStatus = injected?.status === "valid" ? 0 : injected?.status === "invalid" ? 1 : injected?.status === "blocked" ? 3 : -1;
    result = parseEvaluatorEnvelope({ status: exitStatus, stdout: canonicalJSONLine(injected) });
  } else {
    result = invokeGoEvaluator(trusted.repo, request, toolchain, exclusions);
  }
  const candidateAfter = repositoryInventory(candidate.repo, candidate.head);
  if (!sameInventory(candidateBefore, candidateAfter)) fail("candidate_inventory_changed");
  assertAuthenticatedSourceStable(source);
  assertManagedRootsStable(managedRoots);
  return result;
}

async function controllerMain(options) {
  if (options.mode === "support") return runSupport(options);
  if (options.mode === "transition") return runTransition(options);
  if (options.mode === "validate") return runValidate(options);
  fail("mode_invalid");
}

function controllerEnvelope(code, status = "blocked") {
  return { format: TRUSTED_DELIVERY_CONTROLLER_FORMAT, version: TRUSTED_DELIVERY_CONTROLLER_VERSION, status, code, authority: false };
}

/** CLI entrypoint. It emits only bounded JSON or a catalog code; no absolute path or child output is disclosed. */
export async function runTransitionForTest(options, dependencies = {}) {
  return runTransition(Object.freeze({ ...options }), dependencies);
}

export async function runValidateForTest(options, dependencies = {}) {
  return runValidate(Object.freeze({ ...options }), dependencies);
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseTrustedDeliveryArgs(argv);
    const result = await controllerMain(options);
    if (options.json) process.stdout.write(`${canonicalJSONString(result)}\n`);
    else process.stdout.write(`${result.status ?? "valid"}: ${result.code ?? DELIVERY_V2_SUPPORT_AUTHORITY}\n`);
    if (result.status === "invalid") return 1;
    if (result.status === "blocked") return 3;
    return 0;
  } catch (error) {
    const code = error instanceof DeliveryControllerError && CONTROLLER_FAILURE_ORDER.includes(error.code) ? error.code : "usage_invalid";
    const json = options?.json || argv.includes("--json");
    if (json) process.stdout.write(`${canonicalJSONString(controllerEnvelope(code))}\n`);
    else process.stderr.write(`trusted-delivery-evidence-controller: ${code}\n`);
    return code === "usage_invalid" || code === "mode_invalid" ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exitCode = await main();
