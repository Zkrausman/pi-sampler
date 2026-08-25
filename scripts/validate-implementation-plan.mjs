#!/usr/bin/env node
/**
 * Validate one manual implementation-plan handoff without mutating the
 * repository.  The plan and manifest are candidate bytes; the base profile is
 * read only from the exact Git object named by --base.
 */
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_VERSION,
  validateImplementationPlanManifestV2,
} from "../contracts/implementation-plan-manifest-v2.mjs";

export const IMPLEMENTATION_PLAN_VALIDATOR_FORMAT = "pi-sampler.implementation-plan-validator";
export const IMPLEMENTATION_PLAN_VALIDATOR_VERSION = 1;
export const IMPLEMENTATION_PLAN_VALIDATOR_TRUSTED_PROFILE_PATH = "profiles/pi-sampler.json";
export const IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS = Object.freeze({
  success: 0,
  validationFailure: 1,
  invocationFailure: 2,
});

export const IMPLEMENTATION_PLAN_VALIDATOR_LIMITS = Object.freeze({
  maxArgumentBytes: 4096,
  maxTotalArgumentBytes: 16 * 1024,
  maxPathBytes: 256,
  maxPathSegments: 32,
  maxPlanBytes: 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxProfileBytes: 512 * 1024,
  maxJsonDepth: 24,
  maxJsonNodes: 4096,
  maxJsonMembers: 2048,
  maxJsonStringBytes: 16 * 1024,
  maxPlanLines: 16 * 1024,
  maxAcceptanceLines: 128,
  maxDiagnostics: 128,
  maxDiagnosticMessageBytes: 160,
  maxDiagnosticPathBytes: 160,
  maxDiagnosticCodeBytes: 64,
  maxGitOutputBytes: 128 * 1024,
  maxGitBlobBytes: 512 * 1024,
  gitTimeoutMs: 5000,
});

const L = IMPLEMENTATION_PLAN_VALIDATOR_LIMITS;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TICKET_PATTERN = /^[A-Z][A-Z0-9]+-[0-9]+$/;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9._-])?$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ACCEPTANCE_LINE_PATTERN = /^\s*(?:(?:[-*+]\s+)|(?:[0-9]+[.)]\s+))?\[[ xX]\]\s+([A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}):[ \t]+([^\r\n]+)$/;
const POSSIBLE_ACCEPTANCE_LINE_PATTERN = /^\s*(?:(?:[-*+]\s+)|(?:[0-9]+[.)]\s+))?\[[ xX]\]\s+([A-Za-z0-9][A-Za-z0-9._:@/-]{0,127})(?::|\s|$)/;
const RESERVED_WINDOWS_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL", "CLOCK$",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PROHIBITED_AUTHORITY_KEYS = new Set(["authority", "model", "model_id", "provider", "priority", "schedule", "publication", "publish", "tracker", "commit", "push", "pull_request", "merge", "reviewer"]);
const SAFE_ENVIRONMENT_NAMES = Object.freeze(process.platform === "win32"
  ? ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA"]
  : ["HOME", "TMPDIR", "TMP", "TEMP"]);
const GIT_OPTIONS = Object.freeze([
  "--no-pager",
  "--no-replace-objects",
  "--no-optional-locks",
  "-c", "trace2.eventTarget=",
  "-c", "trace2.normalTarget=",
  "-c", "trace2.perfTarget=",
  "-c", "color.ui=false",
  "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
]);
const FIXED_WINDOWS_GIT_CANDIDATES = Object.freeze([
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
  "C:\\Program Files\\Git\\bin\\git.exe",
  "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
  "C:\\Program Files (x86)\\Git\\mingw64\\bin\\git.exe",
  "C:\\Program Files (x86)\\Git\\bin\\git.exe",
]);
let trustedGitExecutableCache;

const DIAGNOSTIC_CATALOG = Object.freeze({
  invocation_invalid: { message: "invocation is invalid or incomplete", severity: "error", class: "invocation", retryable: false },
  internal_failure: { message: "validator could not complete its bounded read-only operation", severity: "error", class: "internal", retryable: true },
  repository_unavailable: { message: "the current directory is not an available Git worktree", severity: "error", class: "git", retryable: true },
  path_invalid: { message: "a supplied or manifest path is not a safe portable relative path", severity: "error", class: "security", retryable: false },
  path_missing: { message: "a required candidate file is missing", severity: "error", class: "input", retryable: false },
  path_not_regular: { message: "a required candidate path is not a regular file", severity: "error", class: "security", retryable: false },
  path_symlink: { message: "a required candidate path contains a symlink or reparse point", severity: "error", class: "security", retryable: false },
  path_outside_root: { message: "a candidate path resolves outside the exact worktree root", severity: "error", class: "security", retryable: false },
  file_oversized: { message: "a candidate file exceeds its fixed byte bound", severity: "error", class: "resource", retryable: false },
  file_invalid_utf8: { message: "a candidate file is not valid UTF-8 text", severity: "error", class: "input", retryable: false },
  file_bom: { message: "a candidate file contains an unsupported UTF-8 BOM", severity: "error", class: "input", retryable: false },
  file_contains_nul: { message: "a candidate file contains a NUL byte", severity: "error", class: "security", retryable: false },
  json_invalid: { message: "candidate JSON is malformed", severity: "error", class: "input", retryable: false },
  json_duplicate_key: { message: "candidate JSON contains a duplicate object key", severity: "error", class: "input", retryable: false },
  json_trailing_data: { message: "candidate JSON contains trailing data", severity: "error", class: "input", retryable: false },
  json_bounds: { message: "candidate JSON exceeds a fixed structural bound", severity: "error", class: "resource", retryable: false },
  json_unsafe_key: { message: "candidate JSON contains an unsafe object key", severity: "error", class: "security", retryable: false },
  json_unsafe_number: { message: "candidate JSON contains an unsafe number", severity: "error", class: "input", retryable: false },
  manifest_schema_invalid: { message: "manifest does not satisfy the implementation-plan-manifest/v2 contract", severity: "error", class: "schema", retryable: false },
  manifest_authority_field: { message: "manifest contains a field that cannot grant lifecycle authority", severity: "error", class: "authority", retryable: false },
  manifest_binding_mismatch: { message: "manifest binding differs from the exact supplied comparison binding", severity: "error", class: "binding", retryable: false },
  plan_digest_mismatch: { message: "manifest plan_sha256 does not match the exact plan bytes", severity: "error", class: "binding", retryable: false },
  manifest_path_mismatch: { message: "manifest plan_path does not match the supplied plan path", severity: "error", class: "binding", retryable: false },
  acceptance_id_duplicate: { message: "acceptance IDs are duplicated", severity: "error", class: "acceptance", retryable: false },
  acceptance_id_missing: { message: "an acceptance ID is present in the manifest but missing from the plan", severity: "error", class: "acceptance", retryable: false },
  acceptance_id_extra: { message: "an acceptance ID is present in the plan but missing from the manifest", severity: "error", class: "acceptance", retryable: false },
  acceptance_id_order: { message: "acceptance IDs are not in the same deterministic order", severity: "error", class: "acceptance", retryable: false },
  acceptance_id_case_drift: { message: "acceptance ID casing differs between plan and manifest", severity: "error", class: "acceptance", retryable: false },
  acceptance_line_malformed: { message: "an acceptance line does not match the bounded line grammar", severity: "error", class: "acceptance", retryable: false },
  acceptance_requirement_mismatch: { message: "an acceptance requirement does not exactly map to its plan line", severity: "error", class: "acceptance", retryable: false },
  ownership_duplicate: { message: "owned files, symbols, or contracts contain a duplicate", severity: "error", class: "scope", retryable: false },
  dependency_invalid: { message: "hard or soft dependency metadata is incoherent", severity: "error", class: "dependency", retryable: false },
  predecessor_output_invalid: { message: "predecessor output metadata is missing or ambiguous", severity: "error", class: "dependency", retryable: false },
  dependency_overlap: { message: "a soft dependency overlaps a hard dependency and must be explicitly resolved", severity: "error", class: "dependency", retryable: false },
  readiness_blocked: { message: "the manifest is not implementation-ready", severity: "error", class: "readiness", retryable: false },
  epic_incoherent: { message: "epic role metadata is incoherent", severity: "error", class: "portfolio", retryable: false },
  staleness_invalid: { message: "staleness triggers are duplicated or incoherent", severity: "error", class: "revalidation", retryable: false },
  revalidation_invalid: { message: "just-in-time revalidation inputs do not bind required current evidence", severity: "error", class: "revalidation", retryable: false },
  base_invalid: { message: "the supplied base is not an exact commit identity", severity: "error", class: "git", retryable: false },
  base_object_format_mismatch: { message: "the supplied base width does not match the repository object format", severity: "error", class: "git", retryable: false },
  base_unavailable: { message: "the exact historical base object is unavailable", severity: "error", class: "git", retryable: true },
  base_not_commit: { message: "the supplied base object is not a commit", severity: "error", class: "git", retryable: false },
  git_object_format_invalid: { message: "the repository object format is unavailable or unsupported", severity: "error", class: "git", retryable: true },
  profile_path_untrusted: { message: "the profile path is not the approved project profile path", severity: "error", class: "authority", retryable: false },
  profile_unavailable: { message: "the approved profile blob is unavailable from the exact base", severity: "error", class: "git", retryable: true },
  profile_wrong_type: { message: "the approved profile object is not a regular Git blob", severity: "error", class: "git", retryable: false },
  profile_invalid: { message: "the exact-base project profile is malformed or incomplete", severity: "error", class: "authority", retryable: false },
  profile_repository_mismatch: { message: "the exact-base profile is not bound to the supplied repository", severity: "error", class: "authority", retryable: false },
  profile_ticket_mismatch: { message: "the supplied ticket does not match the exact-base profile policy", severity: "error", class: "authority", retryable: false },
  profile_policy_missing: { message: "the exact-base profile lacks the required planning policy binding", severity: "error", class: "authority", retryable: false },
  legacy_v1_readable: { message: "historical acceptance-manifest/v1 input was read without rewriting it", severity: "info", class: "compatibility", retryable: false },
  legacy_v1_no_rewrite: { message: "v1 compatibility does not invent or upgrade v2-only semantics", severity: "info", class: "compatibility", retryable: false },
  legacy_v1_semantics_unavailable: { message: "v2 ticket revision, portfolio, dependency, and revalidation semantics are unavailable in v1", severity: "warning", class: "compatibility", retryable: false },
  legacy_v1_not_v2: { message: "historical v1 input cannot satisfy v2 implementation-readiness validation", severity: "error", class: "compatibility", retryable: false },
});

export const IMPLEMENTATION_PLAN_VALIDATOR_DIAGNOSTIC_CODES = Object.freeze(Object.keys(DIAGNOSTIC_CATALOG).sort());

class InvocationError extends Error {
  constructor() {
    super("invocation invalid");
    this.name = "InvocationError";
  }
}

class SafeFileError extends Error {
  constructor(code) {
    super(code);
    this.name = "SafeFileError";
    this.code = code;
  }
}

class StrictJsonError extends Error {
  constructor(code) {
    super(code);
    this.name = "StrictJsonError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

/** Return only the fixed, reviewable executable identities for a platform. */
export function trustedGitCandidatePaths(platform = process.platform) {
  if (platform === "win32") return [...FIXED_WINDOWS_GIT_CANDIDATES];
  if (platform === "darwin") return ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  return ["/usr/bin/git", "/bin/git", "/usr/local/bin/git", "/usr/lib/git-core/git"];
}

function trustedCandidateIsAbsolute(candidate, platform) {
  return platform === "win32" ? /^[A-Za-z]:[\\\\/]/.test(candidate) : isAbsolute(candidate);
}

function resolveTrustedGitExecutableFromCandidates(candidates, platform, fileSystem = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 16) throw new Error("trusted Git executable unavailable");
  const resolvePath = fileSystem.realpathSync || realpathSync;
  const statPath = fileSystem.statSync || statSync;
  const accessPath = fileSystem.accessSync || accessSync;
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !trustedCandidateIsAbsolute(candidate, platform) || byteLength(candidate) > L.maxPathBytes) continue;
    try {
      const resolvedCandidate = resolvePath(candidate);
      const info = statPath(resolvedCandidate);
      if (!info.isFile()) continue;
      if (platform !== "win32") accessPath(resolvedCandidate, fsConstants.X_OK);
      return resolvedCandidate;
    } catch {
      // Continue through the fixed platform-standard identities only.
    }
  }
  throw new Error("trusted Git executable unavailable");
}

/**
 * Resolve one concrete Git executable without PATH or environment-root lookup.
 * The platform selects the fixed source list; the optional filesystem seam is
 * test-only and cannot add candidates or alter production CLI authority.
 */
export function resolveTrustedGitExecutableFromFixedCandidates(platform = process.platform, fileSystem = undefined) {
  return resolveTrustedGitExecutableFromCandidates(trustedGitCandidatePaths(platform), platform, fileSystem);
}

export function resolveTrustedGitExecutable() {
  if (trustedGitExecutableCache) return trustedGitExecutableCache;
  trustedGitExecutableCache = resolveTrustedGitExecutableFromFixedCandidates();
  return trustedGitExecutableCache;
}

function trustedGitPathEnvironment(gitExecutable) {
  const executableDirectory = dirname(gitExecutable);
  if (process.platform === "win32") {
    const gitRoot = resolve(executableDirectory, "..");
    return [
      executableDirectory,
      resolve(gitRoot, "cmd"),
      resolve(gitRoot, "mingw64", "bin"),
      "C:\\Windows\\System32",
      "C:\\Windows",
    ].filter((value, index, values) => values.indexOf(value) === index).join(";");
  }
  return [executableDirectory, "/usr/bin", "/bin"].filter((value, index, values) => values.indexOf(value) === index).join(":");
}

function fixedGitEnvironment(source = process.env, gitExecutable = resolveTrustedGitExecutable()) {
  const environment = {};
  for (const expectedName of SAFE_ENVIRONMENT_NAMES) {
    const entry = Object.entries(source).find(([name]) => name.toLowerCase() === expectedName.toLowerCase());
    if (entry && !/^git_/i.test(entry[0])) environment[entry[0]] = entry[1];
  }
  environment.PATH = trustedGitPathEnvironment(gitExecutable);
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_SYSTEM = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

function runGit(cwd, args, { encoding = "utf8", maxBytes = L.maxGitOutputBytes, allowFailure = false } = {}) {
  let result;
  try {
    const gitExecutable = resolveTrustedGitExecutable();
    result = spawnSync(gitExecutable, [...GIT_OPTIONS, ...args], {
      cwd,
      encoding,
      windowsHide: true,
      env: fixedGitEnvironment(process.env, gitExecutable),
      timeout: L.gitTimeoutMs,
      maxBuffer: maxBytes,
    });
  } catch {
    return { ok: false, unavailable: true, timedOut: false, stdout: encoding === "buffer" ? Buffer.alloc(0) : "", stderr: "" };
  }
  const stdout = encoding === "buffer" ? (Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0)) : String(result.stdout || "");
  const stderr = encoding === "buffer" ? (Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0)) : String(result.stderr || "");
  const timedOut = Boolean(result.error && (result.error.code === "ETIMEDOUT" || result.error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"));
  const unavailable = Boolean(result.error && !timedOut);
  const outputTooLarge = (Buffer.isBuffer(stdout) ? stdout.length : byteLength(stdout)) > maxBytes;
  if (outputTooLarge) return { ok: false, unavailable: false, timedOut: false, outputTooLarge, stdout, stderr };
  return {
    ok: result.status === 0,
    unavailable,
    timedOut,
    outputTooLarge,
    stdout,
    stderr,
    allowFailure,
  };
}

function throwIfUnsafeJsonObjectKey(value) {
  if (PROTOTYPE_KEYS.has(value) || value.includes("\0")) throw new StrictJsonError("json_unsafe_key");
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) throw new StrictJsonError("json_unsafe_key");
  }
}

function decodeUtf8(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new SafeFileError("file_invalid_utf8");
  const input = Buffer.from(bytes);
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) throw new SafeFileError("file_bom");
  if (input.includes(0)) throw new SafeFileError("file_contains_nul");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new SafeFileError("file_invalid_utf8");
  }
  return text;
}

/**
 * Strict bounded JSON parser. It scans the original text before JSON.parse so
 * duplicate keys, decoded prototype keys, trailing data, and resource bounds
 * are rejected without ever executing candidate content.
 */
export function parseStrictBoundedJson(bytes) {
  const text = decodeUtf8(bytes);
  let index = 0;
  let nodes = 0;
  let members = 0;

  const fail = (code) => { throw new StrictJsonError(code); };
  const skipWhitespace = () => {
    while (index < text.length && " \t\r\n".includes(text[index])) index += 1;
  };
  const parseString = () => {
    if (text[index] !== '"') fail("json_invalid");
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index++);
      if (code === 0x22) {
        const raw = text.slice(start, index);
        let decoded;
        try { decoded = JSON.parse(raw); } catch { fail("json_invalid"); }
        if (byteLength(decoded) > L.maxJsonStringBytes) fail("json_bounds");
        return decoded;
      }
      if (code < 0x20) fail("json_invalid");
      if (code === 0x5c) {
        if (index >= text.length) fail("json_invalid");
        const escape = text[index++];
        if (escape === "u") {
          if (index + 4 > text.length || !/^[0-9a-fA-F]{4}$/.test(text.slice(index, index + 4))) fail("json_invalid");
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) {
          fail("json_invalid");
        }
      }
    }
    fail("json_invalid");
  };
  const parseNumberOrLiteral = () => {
    const start = index;
    while (index < text.length && !",]} \t\r\n".includes(text[index])) index += 1;
    const token = text.slice(start, index);
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token)) fail("json_invalid");
    const number = Number(token);
    if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) fail("json_unsafe_number");
    return number;
  };
  const parseValue = (depth) => {
    if (depth > L.maxJsonDepth || ++nodes > L.maxJsonNodes) fail("json_bounds");
    skipWhitespace();
    const character = text[index];
    if (character === '"') return parseString();
    if (character === "{") {
      index += 1;
      const value = {};
      const keys = new Set();
      skipWhitespace();
      if (text[index] === "}") { index += 1; return value; }
      for (;;) {
        skipWhitespace();
        const key = parseString();
        throwIfUnsafeJsonObjectKey(key);
        if (keys.has(key)) fail("json_duplicate_key");
        keys.add(key);
        if (++members > L.maxJsonMembers) fail("json_bounds");
        skipWhitespace();
        if (text[index++] !== ":") fail("json_invalid");
        value[key] = parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "}") { index += 1; return value; }
        if (text[index++] !== ",") fail("json_invalid");
      }
    }
    if (character === "[") {
      index += 1;
      const value = [];
      skipWhitespace();
      if (text[index] === "]") { index += 1; return value; }
      for (;;) {
        value.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === "]") { index += 1; return value; }
        if (text[index++] !== ",") fail("json_invalid");
      }
    }
    if (character === undefined) fail("json_invalid");
    return parseNumberOrLiteral();
  };

  skipWhitespace();
  const value = parseValue(0);
  skipWhitespace();
  if (index !== text.length) throw new StrictJsonError("json_trailing_data");
  return { value, text };
}

function pathInside(root, candidate) {
  const rootValue = resolve(root);
  const candidateValue = resolve(candidate);
  const remainder = relative(rootValue, candidateValue);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder));
}

function windowsReservedSegment(segment) {
  const trimmed = segment.replace(/[ .]+$/g, "");
  const basename = trimmed.split(".", 1)[0].toUpperCase();
  return RESERVED_WINDOWS_NAMES.has(basename);
}

/** Validate portable repository-relative POSIX paths without normalizing them. */
export function isSafeImplementationPlanPath(value) {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > L.maxPathBytes || !SAFE_PATH_PATTERN.test(value)) return false;
  if (isAbsolute(value) || value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes("\\") || value.includes("%") || value.includes(":") || value.includes("\0")) return false;
  const segments = value.split("/");
  if (segments.length > L.maxPathSegments || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false;
  if (segments.some((segment) => /[ .]$/.test(segment) || windowsReservedSegment(segment))) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f || code > 0x7e) return false;
  }
  return true;
}

function safePathOrThrow(value) {
  if (!isSafeImplementationPlanPath(value)) throw new SafeFileError("path_invalid");
  return value;
}

function comparableIdentity(value) {
  return Number.isFinite(value) && value !== 0;
}

function sameFileIdentity(left, right) {
  if (!left || !right || !left.isFile() || !right.isFile()) return false;
  if (comparableIdentity(left.dev) && comparableIdentity(right.dev) && left.dev !== right.dev) return false;
  if (comparableIdentity(left.ino) && comparableIdentity(right.ino) && left.ino !== right.ino) return false;
  return true;
}

function sameEntryIdentity(left, right) {
  if (!left || !right) return false;
  if (left.isFile() !== right.isFile() || left.isDirectory() !== right.isDirectory() || left.isSymbolicLink() !== right.isSymbolicLink()) return false;
  if (comparableIdentity(left.dev) && comparableIdentity(right.dev) && left.dev !== right.dev) return false;
  if (comparableIdentity(left.ino) && comparableIdentity(right.ino) && left.ino !== right.ino) return false;
  return true;
}

function sameCanonicalPath(left, right) {
  const normalize = (value) => resolve(value);
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function safeFileErrorFromFs(error) {
  if (error instanceof SafeFileError) return error;
  if (error?.code === "ELOOP") return new SafeFileError("path_symlink");
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return new SafeFileError("path_missing");
  return new SafeFileError("path_not_regular");
}

async function inspectCandidatePath(root, segments) {
  const snapshots = [];
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    let info;
    let canonical;
    try {
      info = await lstat(current);
      canonical = await realpath(current);
    } catch (error) {
      throw safeFileErrorFromFs(error);
    }
    if (info.isSymbolicLink()) throw new SafeFileError("path_symlink");
    if (!pathInside(root, canonical)) throw new SafeFileError("path_outside_root");
    if (!sameCanonicalPath(current, canonical)) throw new SafeFileError("path_symlink");
    if (index < segments.length - 1 && !info.isDirectory()) throw new SafeFileError("path_not_regular");
    if (index === segments.length - 1 && !info.isFile()) throw new SafeFileError("path_not_regular");
    snapshots.push({ path: current, info, canonical });
  }
  return { absolute: current, snapshots };
}

async function openLinuxHandleRelative(root, segments) {
  const directoryFlags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0);
  const fileFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const directoryHandles = [];
  let parent;
  try {
    parent = await open(root, directoryFlags);
    directoryHandles.push(parent);
    for (let index = 0; index < segments.length - 1; index += 1) {
      const child = await open(`/proc/self/fd/${parent.fd}/${segments[index]}`, directoryFlags);
      const childInfo = await child.stat();
      if (!childInfo.isDirectory()) {
        await child.close().catch(() => {});
        throw new SafeFileError("path_not_regular");
      }
      directoryHandles.push(child);
      parent = child;
    }
    const handle = await open(`/proc/self/fd/${parent.fd}/${segments.at(-1)}`, fileFlags);
    return { handle, directoryHandles };
  } catch (error) {
    for (const directoryHandle of directoryHandles.reverse()) await directoryHandle.close().catch(() => {});
    throw safeFileErrorFromFs(error);
  }
}

async function openCandidateHandle(root, absolute, segments) {
  if (process.platform === "linux") return openLinuxHandleRelative(root, segments);
  try {
    const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    return { handle, directoryHandles: [] };
  } catch (error) {
    throw safeFileErrorFromFs(error);
  }
}

async function revalidateCandidatePath(root, snapshots, opened) {
  for (const [index, snapshot] of snapshots.entries()) {
    let info;
    let canonical;
    try {
      info = await lstat(snapshot.path);
      canonical = await realpath(snapshot.path);
    } catch (error) {
      throw safeFileErrorFromFs(error);
    }
    if (info.isSymbolicLink()) throw new SafeFileError("path_symlink");
    if (!pathInside(root, canonical)) throw new SafeFileError("path_outside_root");
    if (!sameCanonicalPath(snapshot.canonical, canonical) || !sameEntryIdentity(snapshot.info, info)) throw new SafeFileError("path_symlink");
    if (index === snapshots.length - 1 && !sameFileIdentity(opened, info)) throw new SafeFileError("path_symlink");
  }
}

/**
 * Read candidate bytes through a component-checked identity boundary. The
 * optional hook is an internal deterministic race-test seam; the CLI never
 * supplies it. Linux uses an open-directory-handle/proc-fd traversal, while
 * other supported platforms fail closed on every observed parent identity,
 * reparse, and canonical-root change before and after the bounded read.
 */
export async function safeReadCandidateFile(root, safePath, maximum, testHooks = undefined) {
  safePathOrThrow(safePath);
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
    const rootInfo = await lstat(canonicalRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SafeFileError("path_not_regular");
  } catch (error) {
    throw safeFileErrorFromFs(error);
  }
  const segments = safePath.split("/");
  const absolute = resolve(canonicalRoot, ...segments);
  if (!pathInside(canonicalRoot, absolute)) throw new SafeFileError("path_outside_root");
  const inspected = await inspectCandidatePath(canonicalRoot, segments);
  const before = inspected.snapshots.at(-1).info;
  if (before.size > maximum) throw new SafeFileError("file_oversized");
  if (typeof testHooks?.beforeOpen === "function") await testHooks.beforeOpen({ absolute, path: safePath });

  let handle;
  let directoryHandles = [];
  try {
    ({ handle, directoryHandles } = await openCandidateHandle(canonicalRoot, absolute, segments));
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened)) throw new SafeFileError("path_symlink");
    if (opened.size > maximum) throw new SafeFileError("file_oversized");
    let openedCanonical;
    try { openedCanonical = await realpath(absolute); } catch (error) { throw safeFileErrorFromFs(error); }
    if (!pathInside(canonicalRoot, openedCanonical)) throw new SafeFileError("path_outside_root");
    if (!sameCanonicalPath(inspected.snapshots.at(-1).canonical, openedCanonical)) throw new SafeFileError("path_symlink");
    await revalidateCandidatePath(canonicalRoot, inspected.snapshots, opened);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || after.size !== opened.size || bytes.length !== opened.size) throw new SafeFileError("path_symlink");
    await revalidateCandidatePath(canonicalRoot, inspected.snapshots, opened);
    if (bytes.length > maximum) throw new SafeFileError("file_oversized");
    return bytes;
  } catch (error) {
    throw safeFileErrorFromFs(error);
  } finally {
    if (handle) await handle.close().catch(() => {});
    for (const directoryHandle of directoryHandles.reverse()) await directoryHandle.close().catch(() => {});
  }
}

function normalizeCommit(value) {
  return typeof value === "string" && COMMIT_PATTERN.test(value) ? value : null;
}

function normalizeOptions(options, { requireJson = false } = {}) {
  if (!isRecord(options)) throw new InvocationError();
  const required = ["plan", "manifest", "base", "profile", "repository", "ticket", "ticketRevision"];
  if ((requireJson && options.json !== true) || (!requireJson && options.json !== undefined && options.json !== true) || required.some((key) => typeof options[key] !== "string")) throw new InvocationError();
  const keys = Object.keys(options);
  if (keys.some((key) => !required.includes(key) && key !== "json")) throw new InvocationError();
  for (const key of required) {
    if (options[key].length === 0 || byteLength(options[key]) > L.maxArgumentBytes || options[key].includes("\0")) throw new InvocationError();
  }
  if (!isSafeImplementationPlanPath(options.plan) || !isSafeImplementationPlanPath(options.manifest) || !isSafeImplementationPlanPath(options.profile)) throw new InvocationError();
  if (!normalizeCommit(options.base) || !normalizeCommit(options.ticketRevision)) throw new InvocationError();
  if (!REPOSITORY_PATTERN.test(options.repository) || !TICKET_PATTERN.test(options.ticket)) throw new InvocationError();
  if (options.profile !== IMPLEMENTATION_PLAN_VALIDATOR_TRUSTED_PROFILE_PATH) throw new InvocationError();
  return Object.freeze({ ...options });
}

/** Parse only the exact documented CLI spelling; no positional or fallback inputs are accepted. */
export function parseImplementationPlanValidatorArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string")) throw new InvocationError();
  const totalBytes = argv.reduce((total, value) => total + byteLength(value), 0);
  if (totalBytes > L.maxTotalArgumentBytes || argv.length > 16) throw new InvocationError();
  const names = new Map([
    ["--plan", "plan"],
    ["--manifest", "manifest"],
    ["--base", "base"],
    ["--profile", "profile"],
    ["--repository", "repository"],
    ["--ticket", "ticket"],
    ["--ticket-revision", "ticketRevision"],
  ]);
  const result = { json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (result.json) throw new InvocationError();
      result.json = true;
      continue;
    }
    const field = names.get(argument);
    if (!field || seen.has(field) || index + 1 >= argv.length || argv[index + 1] === "--json" || argv[index + 1].startsWith("--")) throw new InvocationError();
    seen.add(field);
    result[field] = argv[index + 1];
    index += 1;
  }
  if (!result.json || seen.size !== names.size) throw new InvocationError();
  return normalizeOptions(result, { requireJson: true });
}

function sanitizePointer(value, fallback = "/manifest") {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > L.maxDiagnosticPathBytes) return fallback;
  const normalized = value.startsWith("/") ? value : `/${value}`;
  if (!/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(normalized)) return fallback;
  return normalized;
}

class DiagnosticCollector {
  #items = new Map();

  add(code, path = "", extra = {}) {
    const catalog = DIAGNOSTIC_CATALOG[code] || DIAGNOSTIC_CATALOG.internal_failure;
    const safeCode = code in DIAGNOSTIC_CATALOG ? code : "internal_failure";
    const item = {
      code: safeCode,
      path: sanitizePointer(path, ""),
      message: catalog.message,
      severity: catalog.severity,
      class: catalog.class,
      retryable: catalog.retryable,
      ...extra,
    };
    item.message = item.message.slice(0, L.maxDiagnosticMessageBytes);
    item.code = item.code.slice(0, L.maxDiagnosticCodeBytes);
    const key = JSON.stringify([item.code, item.path, item.severity, item.class, item.retryable]);
    this.#items.set(key, item);
  }

  get items() {
    const compare = (left, right) => {
      for (const [a, b] of [[left.code, right.code], [left.path, right.path], [left.severity, right.severity], [left.class, right.class]]) {
        if (a < b) return -1;
        if (a > b) return 1;
      }
      return Number(left.retryable) - Number(right.retryable);
    };
    return [...this.#items.values()].sort(compare).slice(0, L.maxDiagnostics);
  }

  get hasErrors() { return this.items.some((item) => item.severity === "error"); }
}

function addSafeFileError(diagnostics, error, path) {
  const code = DIAGNOSTIC_CATALOG[error?.code] ? error.code : "internal_failure";
  diagnostics.add(code, path);
}

function manifestRootAuthorityDiagnostics(manifest, diagnostics) {
  if (!isRecord(manifest)) return;
  for (const key of Object.keys(manifest)) {
    if (PROHIBITED_AUTHORITY_KEYS.has(key.toLowerCase())) diagnostics.add("manifest_authority_field", "/manifest");
  }
}

function comparePathArray(values, path, diagnostics) {
  if (!Array.isArray(values)) return;
  const seen = new Set();
  values.forEach((value, index) => {
    if (!isSafeImplementationPlanPath(value)) diagnostics.add("path_invalid", `${path}/${index}`);
    if (typeof value === "string") {
      if (seen.has(value)) diagnostics.add("ownership_duplicate", path);
      seen.add(value);
    }
  });
}

function compareIdentifierArray(values, path, diagnostics) {
  if (!Array.isArray(values)) return;
  const seen = new Set();
  values.forEach((value, index) => {
    if (typeof value !== "string" || !SAFE_IDENTIFIER_PATTERN.test(value)) diagnostics.add("manifest_schema_invalid", `${path}/${index}`);
    if (typeof value === "string" && seen.has(value)) diagnostics.add("ownership_duplicate", path);
    if (typeof value === "string") seen.add(value);
  });
}

function compareManifestPaths(manifest, planPath, diagnostics) {
  if (typeof manifest.plan_path === "string" && manifest.plan_path !== planPath) diagnostics.add("manifest_path_mismatch", "/manifest/plan_path");
  if (typeof manifest.plan_path === "string" && !isSafeImplementationPlanPath(manifest.plan_path)) diagnostics.add("path_invalid", "/manifest/plan_path");
  const ownership = manifest.ownership;
  if (!isRecord(ownership)) return;
  comparePathArray(ownership.files, "/manifest/ownership/files", diagnostics);
  compareIdentifierArray(ownership.symbols, "/manifest/ownership/symbols", diagnostics);
  compareIdentifierArray(ownership.contracts, "/manifest/ownership/contracts", diagnostics);
}

function acceptanceRowsFromPlan(planText, diagnostics) {
  const lines = planText.split(/\r\n|\n|\r/);
  if (lines.length > L.maxPlanLines) diagnostics.add("json_bounds", "/plan");
  const rows = [];
  for (let index = 0; index < Math.min(lines.length, L.maxPlanLines); index += 1) {
    const line = lines[index];
    const match = ACCEPTANCE_LINE_PATTERN.exec(line);
    if (match) {
      if (rows.length >= L.maxAcceptanceLines) {
        diagnostics.add("json_bounds", "/plan/acceptance");
        break;
      }
      rows.push({ id: match[1], requirement: match[2], line: index + 1 });
    } else if (POSSIBLE_ACCEPTANCE_LINE_PATTERN.test(line)) {
      diagnostics.add("acceptance_line_malformed", `/plan/lines/${index + 1}`);
    }
  }
  return rows;
}

function validateAcceptanceParity(planText, manifest, diagnostics) {
  if (!isRecord(manifest) || !Array.isArray(manifest.rows)) return 0;
  const planRows = acceptanceRowsFromPlan(planText, diagnostics);
  const manifestRows = manifest.rows;
  const manifestIds = manifestRows.map((row) => row?.id);
  const planIds = planRows.map((row) => row.id);
  const seenManifest = new Set();
  const seenPlan = new Set();
  manifestIds.forEach((id, index) => {
    if (typeof id === "string" && seenManifest.has(id)) diagnostics.add("acceptance_id_duplicate", `/manifest/rows/${index}/id`);
    if (typeof id === "string") seenManifest.add(id);
  });
  planIds.forEach((id, index) => {
    if (seenPlan.has(id)) diagnostics.add("acceptance_id_duplicate", `/plan/acceptance/${index}`);
    seenPlan.add(id);
  });
  const planLower = new Map(planIds.map((id) => [id.toLowerCase(), id]));
  const manifestLower = new Map(manifestIds.filter((id) => typeof id === "string").map((id) => [id.toLowerCase(), id]));
  manifestIds.forEach((id, index) => {
    if (typeof id !== "string") return;
    if (!seenPlan.has(id)) {
      if (planLower.has(id.toLowerCase())) diagnostics.add("acceptance_id_case_drift", `/manifest/rows/${index}/id`);
      else diagnostics.add("acceptance_id_missing", `/manifest/rows/${index}/id`);
    }
  });
  planIds.forEach((id, index) => {
    if (!seenManifest.has(id)) {
      if (manifestLower.has(id.toLowerCase())) diagnostics.add("acceptance_id_case_drift", `/plan/acceptance/${index}`);
      else diagnostics.add("acceptance_id_extra", `/plan/acceptance/${index}`);
    }
  });
  if (planIds.length === manifestIds.length && planIds.some((id, index) => id !== manifestIds[index])) {
    const sameSet = planIds.length === new Set(planIds).size
      && manifestIds.length === new Set(manifestIds).size
      && planIds.every((id) => seenManifest.has(id));
    if (sameSet) diagnostics.add("acceptance_id_order", "/manifest/rows");
  }
  const planById = new Map();
  for (const row of planRows) if (!planById.has(row.id)) planById.set(row.id, row);
  manifestRows.forEach((row, index) => {
    if (!isRecord(row) || typeof row.id !== "string") return;
    const planRow = planById.get(row.id);
    if (!planRow) return;
    if (typeof row.requirement === "string" && row.requirement !== planRow.requirement) {
      diagnostics.add("acceptance_requirement_mismatch", `/manifest/rows/${index}/requirement`);
    }
    if (typeof row.title === "string") {
      for (const delimiter of [": ", " — "]) {
        if (planRow.requirement.startsWith(`${row.title}${delimiter}`)
          && planRow.requirement.slice(row.title.length + delimiter.length) !== row.requirement) {
          diagnostics.add("acceptance_requirement_mismatch", `/manifest/rows/${index}/title`);
        }
      }
    }
  });
  return planRows.length;
}

function validateDependencies(manifest, ticket, diagnostics) {
  const rows = new Set(Array.isArray(manifest.rows) ? manifest.rows.map((row) => row?.id).filter((value) => typeof value === "string") : []);
  const hard = Array.isArray(manifest.hard_dependencies) ? manifest.hard_dependencies : [];
  const predecessor = Array.isArray(manifest.predecessor_outputs) ? manifest.predecessor_outputs : [];
  const soft = Array.isArray(manifest.soft_dependencies) ? manifest.soft_dependencies : [];
  const hardTickets = new Set();
  for (const [index, dependency] of hard.entries()) {
    if (!isRecord(dependency)) continue;
    const dependencyPath = `/manifest/hard_dependencies/${index}`;
    if (dependency.ticket_id === ticket || hardTickets.has(dependency.ticket_id)) diagnostics.add("dependency_invalid", `${dependencyPath}/ticket_id`);
    hardTickets.add(dependency.ticket_id);
    const requirementIds = Array.isArray(dependency.requirement_ids) ? dependency.requirement_ids : [];
    const requiredOutputs = Array.isArray(dependency.required_outputs) ? dependency.required_outputs : [];
    if (new Set(requirementIds).size !== requirementIds.length) diagnostics.add("dependency_invalid", `${dependencyPath}/requirement_ids`);
    if (new Set(requiredOutputs).size !== requiredOutputs.length) diagnostics.add("dependency_invalid", `${dependencyPath}/required_outputs`);
    for (const requirementId of requirementIds) {
      if (!rows.has(requirementId)) diagnostics.add("dependency_invalid", `${dependencyPath}/requirement_ids`);
    }
    for (const outputId of requiredOutputs) {
      const matches = predecessor.filter((output) => output?.ticket_id === dependency.ticket_id && output?.output_id === outputId);
      if (matches.length !== 1) diagnostics.add("predecessor_output_invalid", `${dependencyPath}/required_outputs`);
    }
  }
  const outputKeys = new Set();
  for (const [index, output] of predecessor.entries()) {
    if (!isRecord(output)) continue;
    const key = `${output.ticket_id}\u0000${output.output_id}`;
    if (outputKeys.has(key)) diagnostics.add("predecessor_output_invalid", `/manifest/predecessor_outputs/${index}`);
    outputKeys.add(key);
  }
  const softTickets = new Set();
  for (const [index, dependency] of soft.entries()) {
    if (!isRecord(dependency)) continue;
    const dependencyPath = `/manifest/soft_dependencies/${index}`;
    if (dependency.ticket_id === ticket || softTickets.has(dependency.ticket_id)) diagnostics.add("dependency_invalid", `${dependencyPath}/ticket_id`);
    if (hardTickets.has(dependency.ticket_id)) diagnostics.add("dependency_overlap", `${dependencyPath}/ticket_id`);
    softTickets.add(dependency.ticket_id);
    const evidenceKeys = new Set();
    for (const evidence of Array.isArray(dependency.evidence) ? dependency.evidence : []) {
      const key = `${evidence?.kind}\u0000${evidence?.source}\u0000${evidence?.summary}`;
      if (evidenceKeys.has(key)) diagnostics.add("dependency_invalid", `${dependencyPath}/evidence`);
      evidenceKeys.add(key);
    }
  }
}

function validateReadiness(manifest, diagnostics) {
  const portfolio = manifest.portfolio;
  if (!isRecord(portfolio)) return;
  if (portfolio.requirement_readiness !== "ready") diagnostics.add("readiness_blocked", "/manifest/portfolio/requirement_readiness");
  const decisions = Array.isArray(portfolio.unresolved_human_decisions) ? portfolio.unresolved_human_decisions : [];
  decisions.forEach((decision, index) => {
    if (decision?.blocking === true) diagnostics.add("readiness_blocked", `/manifest/portfolio/unresolved_human_decisions/${index}`);
  });
  for (const [key, path] of [
    ["downstream_unblock_set", "/manifest/portfolio/downstream_unblock_set"],
    ["affected_contracts", "/manifest/portfolio/affected_contracts"],
    ["affected_packages", "/manifest/portfolio/affected_packages"],
  ]) {
    const values = Array.isArray(portfolio[key]) ? portfolio[key] : [];
    const seen = new Set();
    values.forEach((value, index) => {
      if (seen.has(value)) diagnostics.add("ownership_duplicate", `${path}/${index}`);
      seen.add(value);
    });
  }
}

function validateEpic(manifest, ticket, diagnostics) {
  const epic = manifest.epic;
  if (!isRecord(epic)) return;
  const optionalPresent = (key) => Object.hasOwn(epic, key);
  if (epic.kind === "standalone") {
    if (["epic_id", "title", "member_count"].some(optionalPresent)) diagnostics.add("epic_incoherent", "/manifest/epic");
    return;
  }
  if (epic.kind === "member") {
    if (typeof epic.epic_id !== "string" || typeof epic.title !== "string" || !Number.isSafeInteger(epic.member_count) || epic.member_count < 1 || epic.epic_id === ticket) {
      diagnostics.add("epic_incoherent", "/manifest/epic");
    }
    return;
  }
  if (epic.kind === "umbrella") {
    if (typeof epic.epic_id !== "string" || typeof epic.title !== "string" || !Number.isSafeInteger(epic.member_count) || epic.member_count < 1 || epic.epic_id === ticket) {
      diagnostics.add("epic_incoherent", "/manifest/epic");
    }
  }
}

function validateStalenessAndRevalidation(manifest, expected, diagnostics) {
  const staleness = manifest.staleness;
  const triggers = Array.isArray(staleness?.triggers) ? staleness.triggers : [];
  const triggerKeys = new Set();
  for (const [index, trigger] of triggers.entries()) {
    if (!isRecord(trigger)) continue;
    const key = `${trigger.kind}\u0000${trigger.input}`;
    if (triggerKeys.has(key)) diagnostics.add("staleness_invalid", `/manifest/staleness/triggers/${index}`);
    triggerKeys.add(key);
    const expectedInputs = {
      plan_changed: new Set(["plan_sha256", "plan_digest"]),
      ticket_changed: new Set(["ticket_revision"]),
      base_revision_changed: new Set(["base_sha", "repository_revision"]),
      predecessor_output_changed: new Set((manifest.predecessor_outputs || []).map((output) => `${output.ticket_id}/${output.output_id}`)),
      contract_changed: new Set((manifest.portfolio?.affected_contracts || []).concat(manifest.ownership?.contracts || [])),
      requirement_changed: new Set((manifest.rows || []).map((row) => row.id)),
      approval_expired: new Set(["approval", "approval_expiry"]),
    }[trigger.kind];
    if (expectedInputs && !expectedInputs.has(trigger.input)) diagnostics.add("staleness_invalid", `/manifest/staleness/triggers/${index}/input`);
  }
  const inputs = Array.isArray(manifest.just_in_time_revalidation?.inputs) ? manifest.just_in_time_revalidation.inputs : [];
  const inputKeys = new Set();
  for (const [index, input] of inputs.entries()) {
    if (!isRecord(input)) continue;
    const key = `${input.kind}\u0000${input.name}`;
    if (inputKeys.has(key)) diagnostics.add("revalidation_invalid", `/manifest/just_in_time_revalidation/inputs/${index}`);
    inputKeys.add(key);
  }
  const required = [
    ["repository_revision", expected.base, "base_sha"],
    ["ticket_revision", expected.ticketRevision, "ticket_revision"],
    ["plan_digest", expected.planDigest, "plan_sha256"],
  ];
  for (const [kind, value, preferredName] of required) {
    const matches = inputs.filter((input) => input?.kind === kind && input.name === preferredName && input.expected === value);
    if (matches.length === 0) diagnostics.add("revalidation_invalid", "/manifest/just_in_time_revalidation/inputs");
    if (matches.length > 1) diagnostics.add("revalidation_invalid", "/manifest/just_in_time_revalidation/inputs");
  }

  const hardDependencies = Array.isArray(manifest.hard_dependencies) ? manifest.hard_dependencies : [];
  const readinessRelevantKeys = new Set();
  for (const dependency of hardDependencies) {
    if (!isRecord(dependency) || !Array.isArray(dependency.required_outputs)) continue;
    for (const outputId of dependency.required_outputs) readinessRelevantKeys.add(`${dependency.ticket_id}/${outputId}`);
  }
  const predecessorOutputs = Array.isArray(manifest.predecessor_outputs) ? manifest.predecessor_outputs : [];
  const predecessorMap = new Map();
  for (const output of predecessorOutputs) {
    if (!isRecord(output)) continue;
    const key = `${output.ticket_id}/${output.output_id}`;
    const existing = predecessorMap.get(key) || [];
    existing.push(output);
    predecessorMap.set(key, existing);
  }
  for (const key of readinessRelevantKeys) {
    const outputs = predecessorMap.get(key) || [];
    const matchingInputs = inputs.filter((input) => input?.kind === "predecessor_output" && input.name === key);
    if (outputs.length !== 1 || matchingInputs.length !== 1) {
      diagnostics.add("revalidation_invalid", "/manifest/just_in_time_revalidation/inputs");
      continue;
    }
    const output = outputs[0];
    const immutableExpectations = [output.expected_digest, output.expected_revision].filter((value) => typeof value === "string");
    if (immutableExpectations.length === 0) {
      diagnostics.add("revalidation_invalid", `/manifest/predecessor_outputs/${predecessorOutputs.indexOf(output)}`);
      continue;
    }
    if (!immutableExpectations.includes(matchingInputs[0].expected)) {
      diagnostics.add("revalidation_invalid", "/manifest/just_in_time_revalidation/inputs");
    }
  }
  inputs.forEach((input, index) => {
    if (input?.kind === "predecessor_output") {
      if (!readinessRelevantKeys.has(input.name)) diagnostics.add("revalidation_invalid", `/manifest/just_in_time_revalidation/inputs/${index}/name`);
    }
  });
  const knownContracts = new Set((manifest.portfolio?.affected_contracts || []).concat(manifest.ownership?.contracts || []));
  inputs.forEach((input, index) => {
    if (input?.kind === "contract_digest" && (!knownContracts.has(input.name) || !DIGEST_PATTERN.test(input.expected))) {
      diagnostics.add("revalidation_invalid", `/manifest/just_in_time_revalidation/inputs/${index}`);
    }
  });
}

function validateV2Semantics(planText, manifest, expected, diagnostics) {
  const structural = validateImplementationPlanManifestV2(manifest);
  if (!structural.ok) {
    for (const error of structural.errors) diagnostics.add("manifest_schema_invalid", sanitizePointer(error.path, "/manifest"));
    manifestRootAuthorityDiagnostics(manifest, diagnostics);
    return { schema: "unknown", acceptanceLines: 0 };
  }
  if (manifest.schema_version !== IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_VERSION) {
    diagnostics.add("manifest_schema_invalid", "/manifest/schema_version");
    return { schema: "unknown", acceptanceLines: 0 };
  }
  const bindingChecks = [
    ["ticket_id", expected.ticket, "/manifest/ticket_id"],
    ["repository", expected.repository, "/manifest/repository"],
    ["base_sha", expected.base, "/manifest/base_sha"],
    ["ticket_revision", expected.ticketRevision, "/manifest/ticket_revision"],
  ];
  for (const [key, value, path] of bindingChecks) if (manifest[key] !== value) diagnostics.add("manifest_binding_mismatch", path);
  if (manifest.plan_path !== expected.planPath) diagnostics.add("manifest_path_mismatch", "/manifest/plan_path");
  if (manifest.plan_sha256 !== expected.planDigest) diagnostics.add("plan_digest_mismatch", "/manifest/plan_sha256");
  manifestRootAuthorityDiagnostics(manifest, diagnostics);
  compareManifestPaths(manifest, expected.planPath, diagnostics);
  const acceptanceLines = validateAcceptanceParity(planText, manifest, diagnostics);
  validateDependencies(manifest, expected.ticket, diagnostics);
  validateReadiness(manifest, diagnostics);
  validateEpic(manifest, expected.ticket, diagnostics);
  validateStalenessAndRevalidation(manifest, expected, diagnostics);
  return { schema: IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_VERSION, acceptanceLines };
}

function validateLegacyV1(manifest, diagnostics) {
  diagnostics.add("legacy_v1_readable", "/manifest/schema_version");
  diagnostics.add("legacy_v1_no_rewrite", "/manifest");
  diagnostics.add("legacy_v1_semantics_unavailable", "/manifest");
  diagnostics.add("legacy_v1_not_v2", "/manifest/schema_version");
  return "acceptance-manifest/v1";
}

async function repositoryRootForValidation(diagnostics) {
  const result = runGit(process.cwd(), ["rev-parse", "--show-toplevel"], { maxBytes: 4096 });
  if (!result.ok || result.unavailable || result.timedOut || result.outputTooLarge) {
    diagnostics.add("repository_unavailable", "/repository");
    return null;
  }
  const reported = result.stdout.trim();
  if (!reported || reported.includes("\n") || reported.includes("\r")) {
    diagnostics.add("repository_unavailable", "/repository");
    return null;
  }
  try {
    const root = await realpath(reported);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("not a real repository directory");
    return root;
  } catch {
    diagnostics.add("repository_unavailable", "/repository");
    return null;
  }
}

async function validateGitAndProfile(root, options, diagnostics) {
  const objectFormatResult = runGit(root, ["rev-parse", "--show-object-format"], { maxBytes: 128 });
  const objectFormat = objectFormatResult.ok ? objectFormatResult.stdout.trim() : "";
  if (!["sha1", "sha256"].includes(objectFormat)) diagnostics.add("git_object_format_invalid", "/base");
  const expectedWidth = objectFormat === "sha256" ? 64 : objectFormat === "sha1" ? 40 : 0;
  if (expectedWidth && options.base.length !== expectedWidth) diagnostics.add("base_object_format_mismatch", "/base");

  const typeResult = runGit(root, ["cat-file", "-t", options.base], { maxBytes: 128, allowFailure: true });
  if (!typeResult.ok) diagnostics.add("base_unavailable", "/base");
  else if (typeResult.stdout.trim() !== "commit") diagnostics.add("base_not_commit", "/base");
  const commitResult = runGit(root, ["cat-file", "-e", `${options.base}^{commit}`], { maxBytes: 128, allowFailure: true });
  if (!commitResult.ok) diagnostics.add("base_unavailable", "/base");

  const profileObject = `${options.base}:${options.profile}`;
  const profileType = runGit(root, ["cat-file", "-t", profileObject], { maxBytes: 128, allowFailure: true });
  if (!profileType.ok) {
    diagnostics.add("profile_unavailable", "/profile");
    return null;
  }
  if (profileType.stdout.trim() !== "blob") {
    diagnostics.add("profile_wrong_type", "/profile");
    return null;
  }
  const profileSize = runGit(root, ["cat-file", "-s", profileObject], { maxBytes: 128, allowFailure: true });
  const size = Number.parseInt(profileSize.stdout.trim(), 10);
  if (!profileSize.ok || !Number.isSafeInteger(size) || size < 0 || size > L.maxProfileBytes) {
    diagnostics.add("file_oversized", "/profile");
    return null;
  }
  const profileBlob = runGit(root, ["cat-file", "blob", profileObject], { encoding: "buffer", maxBytes: L.maxProfileBytes + 1, allowFailure: true });
  if (!profileBlob.ok || !Buffer.isBuffer(profileBlob.stdout) || profileBlob.stdout.length !== size) {
    diagnostics.add("profile_unavailable", "/profile");
    return null;
  }
  let parsed;
  try {
    parsed = parseStrictBoundedJson(profileBlob.stdout).value;
  } catch (error) {
    if (error instanceof StrictJsonError) diagnostics.add(error.code, "/profile");
    else addSafeFileError(diagnostics, error, "/profile");
    return null;
  }
  if (!isRecord(parsed)) {
    diagnostics.add("profile_invalid", "/profile");
    return null;
  }
  const sourceRepository = parsed.repository?.source;
  if (sourceRepository !== options.repository) diagnostics.add("profile_repository_mismatch", "/profile/repository/source");
  const patternText = parsed.workItem?.idPattern;
  let ticketMatches = false;
  if (typeof patternText === "string" && byteLength(patternText) <= 512) {
    try { ticketMatches = new RegExp(patternText).test(options.ticket); } catch { ticketMatches = false; }
  }
  if (!ticketMatches) diagnostics.add("profile_ticket_mismatch", "/profile/workItem/idPattern");
  if (parsed.governance?.paths?.specification !== "docs/techPlans") diagnostics.add("profile_policy_missing", "/profile/governance/paths/specification");
  if (typeof parsed.projectId !== "string" || parsed.projectId !== "pi-sampler") diagnostics.add("profile_invalid", "/profile/projectId");
  return parsed;
}

function makeBindings(options) {
  return {
    plan_path: options.plan,
    manifest_path: options.manifest,
    base_sha: options.base,
    profile_path: options.profile,
    repository: options.repository,
    ticket_id: options.ticket,
    ticket_revision: options.ticketRevision,
  };
}

function makeEnvelope({ ok, bindings, diagnostics, summary }) {
  const entries = diagnostics.items;
  const errorCount = entries.filter((entry) => entry.severity === "error").length;
  const warningCount = entries.filter((entry) => entry.severity === "warning").length;
  return {
    format: IMPLEMENTATION_PLAN_VALIDATOR_FORMAT,
    version: IMPLEMENTATION_PLAN_VALIDATOR_VERSION,
    ok: Boolean(ok && errorCount === 0),
    bindings: bindings || null,
    diagnostics: entries,
    summary: {
      input_schema: summary?.input_schema || "unknown",
      plan_bytes: Number.isSafeInteger(summary?.plan_bytes) ? summary.plan_bytes : 0,
      manifest_bytes: Number.isSafeInteger(summary?.manifest_bytes) ? summary.manifest_bytes : 0,
      acceptance_lines: Number.isSafeInteger(summary?.acceptance_lines) ? summary.acceptance_lines : 0,
      diagnostic_count: entries.length,
      error_count: errorCount,
      warning_count: warningCount,
    },
  };
}

/** Run the complete read-only validation and return the deterministic envelope. */
export async function validateImplementationPlan(options) {
  const normalized = normalizeOptions(options, { requireJson: false });
  const diagnostics = new DiagnosticCollector();
  const bindings = makeBindings(normalized);
  const root = await repositoryRootForValidation(diagnostics);
  let planBytes;
  let manifestBytes;
  if (root) {
    const files = await Promise.allSettled([
      safeReadCandidateFile(root, normalized.plan, L.maxPlanBytes),
      safeReadCandidateFile(root, normalized.manifest, L.maxManifestBytes),
    ]);
    if (files[0].status === "fulfilled") planBytes = files[0].value;
    else addSafeFileError(diagnostics, files[0].reason, "/plan");
    if (files[1].status === "fulfilled") manifestBytes = files[1].value;
    else addSafeFileError(diagnostics, files[1].reason, "/manifest");
    await validateGitAndProfile(root, normalized, diagnostics);
  }

  let planText;
  let manifest;
  let inputSchema = "unknown";
  let acceptanceLines = 0;
  let planDigest = "";
  if (planBytes) {
    try {
      planText = decodeUtf8(planBytes);
      planDigest = createHash("sha256").update(planBytes).digest("hex");
    } catch (error) {
      addSafeFileError(diagnostics, error, "/plan");
    }
  }
  if (manifestBytes) {
    try {
      const parsed = parseStrictBoundedJson(manifestBytes);
      manifest = parsed.value;
    } catch (error) {
      if (error instanceof StrictJsonError) diagnostics.add(error.code, "/manifest");
      else addSafeFileError(diagnostics, error, "/manifest");
    }
  }
  if (planText && isRecord(manifest) && manifest.schema_version === "acceptance-manifest/v1") {
    inputSchema = validateLegacyV1(manifest, diagnostics);
  } else if (planText && manifest !== undefined) {
    const result = validateV2Semantics(planText, manifest, {
      planPath: normalized.plan,
      planDigest,
      base: normalized.base,
      profile: normalized.profile,
      repository: normalized.repository,
      ticket: normalized.ticket,
      ticketRevision: normalized.ticketRevision,
    }, diagnostics);
    inputSchema = result.schema;
    acceptanceLines = result.acceptanceLines;
  }
  return makeEnvelope({
    ok: !diagnostics.hasErrors,
    bindings,
    diagnostics,
    summary: {
      input_schema: inputSchema,
      plan_bytes: planBytes?.length || 0,
      manifest_bytes: manifestBytes?.length || 0,
      acceptance_lines: acceptanceLines,
    },
  });
}

function invocationEnvelope(code = "invocation_invalid") {
  const diagnostics = new DiagnosticCollector();
  diagnostics.add(code, "/");
  return makeEnvelope({ ok: false, bindings: null, diagnostics, summary: {} });
}

async function main(argv = process.argv.slice(2)) {
  const wantsJson = Array.isArray(argv) && argv.includes("--json");
  try {
    const options = parseImplementationPlanValidatorArgs(argv);
    const envelope = await validateImplementationPlan(options);
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exitCode = envelope.ok ? IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.success : IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.validationFailure;
  } catch (error) {
    if (wantsJson) process.stdout.write(`${JSON.stringify(invocationEnvelope(error instanceof InvocationError ? "invocation_invalid" : "internal_failure"))}\n`);
    if (!wantsJson) process.stderr.write("implementation-plan-validator: invocation or internal failure\n");
    process.exitCode = IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.invocationFailure;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
