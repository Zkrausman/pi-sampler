#!/usr/bin/env node
/**
 * Load the review policy only from an immutable, trusted Git base.
 *
 * This module deliberately has no profile-path or loader-path option. The
 * caller supplies a repository and exact commit IDs; all policy and schema
 * bytes are read from the fixed paths below in that repository's object
 * database. A ready result is therefore an integrity binding, not proof of
 * maintainer authority.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Compile } from "typebox/compile";

export const FORMAT = "pi-sampler.delivery-review-policy";
export const VERSION = 1;
export const PROFILE_PATH = "profiles/pi-sampler.json";
export const SCHEMA_PATH = "profiles/project-profile.schema.json";
export const LOADER_PATH = "scripts/review-policy.mjs";

const MODES = new Set(["bootstrap-check", "review-preflight"]);
const FULL_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_GIT_STDOUT = 131_073;
const MAX_GIT_STDERR = 16_384;
const GIT_TIMEOUT_MS = 10_000;
const TERMINATION_GRACE_MS = 250;
const MAX_BLOB_BYTES = 131_072;
const MAX_JSON_DEPTH = 16;
const MAX_OBJECT_KEYS = 128;
const MAX_ARRAY_ITEMS = 128;
const MAX_STRING_BYTES = 4_096;
const MAX_JSON_NODES = 1_024;
const MAX_INPUT_BYTES = 4_096;
const MAX_PATH_BYTES = 240;
const MAX_REPO_PATH_BYTES = 4_096;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const SAFE_ENVIRONMENT_NAMES = Object.freeze(process.platform === "win32"
  ? ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA"]
  : ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]);
const GIT_GLOBAL_OPTIONS = Object.freeze([
  "--no-pager",
  "--no-replace-objects",
  "--no-optional-locks",
  "-c", "trace2.eventTarget=",
  "-c", "trace2.normalTarget=",
  "-c", "trace2.perfTarget=",
  "-c", "color.ui=false",
  "-c", `core.hooksPath=${NULL_DEVICE}`,
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "-c", "diff.trustExitCode=false",
]);
const DEVICE_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const RESERVED_PATH_CHARACTERS = /[<>:"|?*]/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SHA256 = "sha256";
const APPROVED_PROJECT_ID = "pi-sampler";
const APPROVED_REPOSITORY_SOURCE = "Zkrausman/pi-sampler";
const MODULE_PATH = fileURLToPath(import.meta.url);

class ReviewPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReviewPolicyError";
    this.code = code;
  }
}

class GitOutputOversizedError extends ReviewPolicyError {
  constructor() {
    super("git_output_oversized");
    this.name = "GitOutputOversizedError";
  }
}

class GitCommandError extends ReviewPolicyError {
  constructor() {
    super("git_failed");
    this.name = "GitCommandError";
  }
}

class BoundedJsonError extends ReviewPolicyError {
  constructor(code = "policy_invalid") {
    super(code);
    this.name = "BoundedJsonError";
  }
}

function exactSha(value) {
  return typeof value === "string" && FULL_SHA.test(value);
}

function boundedString(value, maximum) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0");
}

function safeResultMode(value) {
  return boundedString(value, 64) ? value : "invalid";
}

function result({ mode, code, status = "blocked", baseSha, candidateSha, policy, policyDigest, bindingDigest }) {
  const envelope = {
    format: FORMAT,
    version: VERSION,
    mode: safeResultMode(mode),
    status,
    code,
    ...(exactSha(baseSha) ? { baseSha } : {}),
    profilePath: PROFILE_PATH,
    ...(exactSha(candidateSha) ? { candidateSha } : {}),
  };
  if (status === "ready") {
    envelope.policy = policy;
    envelope.policyDigest = policyDigest;
    envelope.bindingDigest = bindingDigest;
  }
  return envelope;
}

function blocked(options, code) {
  return result({
    mode: options.mode,
    code,
    baseSha: options.baseSha,
    candidateSha: options.candidateSha,
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defineOwn(object, key, value) {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

/** Turn parser null-prototype records into safe ordinary records. */
function materialize(value) {
  if (Array.isArray(value)) return value.map(materialize);
  if (!isRecord(value)) return value;
  const output = {};
  for (const key of Object.keys(value)) defineOwn(output, key, materialize(value[key]));
  return output;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new BoundedJsonError("policy_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new BoundedJsonError("policy_invalid");
}

export { canonicalJson };

function sha256(value) {
  return createHash(SHA256).update(value, "utf8").digest("hex");
}

function createBinding({ mode, baseSha, candidateSha, policyDigest }) {
  return {
    format: FORMAT,
    version: VERSION,
    mode,
    baseSha,
    candidateSha: candidateSha ?? null,
    profilePath: PROFILE_PATH,
    policyDigest,
  };
}

function fixedGitEnvironment(source = process.env) {
  const environment = {};
  for (const expectedName of SAFE_ENVIRONMENT_NAMES) {
    const entry = Object.entries(source).find(([name]) => name.toLowerCase() === expectedName.toLowerCase());
    if (entry && !/^git_/i.test(entry[0])) environment[entry[0]] = entry[1];
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = NULL_DEVICE;
  environment.GIT_CONFIG_SYSTEM = NULL_DEVICE;
  return environment;
}

function gitArguments(args) {
  const command = args[0];
  const diffSafety = command === "diff" || command === "show" ? ["--no-ext-diff", "--no-textconv"] : [];
  return [...GIT_GLOBAL_OPTIONS, ...diffSafety, ...args];
}

function collectOutput(stream, maximum, state) {
  stream.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (state.oversized) return;
    if (state.bytes + buffer.length > maximum) {
      state.oversized = true;
      state.kill?.();
      return;
    }
    state.bytes += buffer.length;
    state.parts.push(buffer);
  });
}

/** Run a read-only Git command with fixed config/environment and streaming caps. */
function runGit(repo, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn("git", gitArguments(args), {
        cwd: repo,
        env: fixedGitEnvironment(),
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      rejectPromise(new GitCommandError());
      return;
    }
    let settled = false;
    let terminationError;
    let terminationTimer;
    let timeoutTimer;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(terminationTimer);
      clearTimeout(timeoutTimer);
      callback(value);
    };
    const terminate = (error) => {
      if (terminationError || settled) return;
      terminationError = error;
      try {
        child.kill();
      } catch {
        // The bounded rejection below still prevents a hung Git child from
        // keeping the policy decision pending.
      }
      terminationTimer = setTimeout(() => settle(rejectPromise, terminationError), TERMINATION_GRACE_MS);
    };
    const stdout = { parts: [], bytes: 0, oversized: false, kill: () => terminate(new GitOutputOversizedError()) };
    const stderr = { parts: [], bytes: 0, oversized: false, kill: () => terminate(new GitOutputOversizedError()) };
    collectOutput(child.stdout, MAX_GIT_STDOUT, stdout);
    collectOutput(child.stderr, MAX_GIT_STDERR, stderr);
    timeoutTimer = setTimeout(() => terminate(new ReviewPolicyError("internal_blocked")), GIT_TIMEOUT_MS);
    child.once("error", () => settle(rejectPromise, terminationError ?? new GitCommandError()));
    child.once("close", (status) => {
      if (terminationError) {
        settle(rejectPromise, terminationError);
        return;
      }
      if (stdout.oversized || stderr.oversized) {
        settle(rejectPromise, new GitOutputOversizedError());
        return;
      }
      if (status !== 0) {
        settle(rejectPromise, new GitCommandError());
        return;
      }
      settle(resolvePromise, {
        stdout: Buffer.concat(stdout.parts),
        stderr: Buffer.concat(stderr.parts),
      });
    });
  });
}

function textFromGit(output, maximum = MAX_GIT_STDOUT) {
  if (!Buffer.isBuffer(output) || output.length > maximum) throw new GitOutputOversizedError();
  const text = output.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(output)) throw new ReviewPolicyError("base_invalid");
  return text;
}

function trimGit(output) {
  return textFromGit(output).trim();
}

function parseSafeInteger(text) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new ReviewPolicyError("base_invalid");
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new ReviewPolicyError("base_invalid");
  return value;
}

async function gitPath(repo, path) {
  const output = await runGit(repo, ["rev-parse", "--git-path", path]);
  return trimGit(output.stdout);
}

function pathKey(value) {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathInside(parent, candidate) {
  const parentKey = pathKey(parent);
  const candidateKey = pathKey(candidate);
  const child = relative(parentKey, candidateKey);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function existingInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    throw new ReviewPolicyError("internal_blocked");
  }
}

async function rejectReparseAncestors(path) {
  let current = resolve(path);
  for (;;) {
    const info = await existingInfo(current);
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory()) throw new ReviewPolicyError("policy_invalid");
      // Node reports Windows junctions as symbolic links on supported Node
      // versions. Keep the explicit check isolated so future reparse metadata
      // can be added without changing the policy decision.
      if (typeof info.isReparsePoint === "function" && info.isReparsePoint()) throw new ReviewPolicyError("policy_invalid");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function assertAbsent(path) {
  const info = await existingInfo(path);
  if (info) throw new ReviewPolicyError("base_invalid");
}

async function inspectRepository(repoOption) {
  if (repoOption !== undefined && !boundedString(repoOption, MAX_REPO_PATH_BYTES)) throw new ReviewPolicyError("base_invalid");
  const requested = resolve(repoOption ?? process.cwd());
  const requestedInfo = await existingInfo(requested);
  if (!requestedInfo?.isDirectory() || requestedInfo.isSymbolicLink()) throw new ReviewPolicyError("base_invalid");
  const repo = await realpath(requested).catch(() => { throw new ReviewPolicyError("base_invalid"); });
  const top = trimGit((await runGit(repo, ["rev-parse", "--show-toplevel"])).stdout);
  if (!top || top.includes("\n") || top.includes("\r")) throw new ReviewPolicyError("base_invalid");
  const canonicalTop = await realpath(resolve(repo, top)).catch(() => { throw new ReviewPolicyError("base_invalid"); });
  if (pathKey(canonicalTop) !== pathKey(repo)) throw new ReviewPolicyError("base_invalid");

  const gitDirText = trimGit((await runGit(repo, ["rev-parse", "--absolute-git-dir"])).stdout);
  const commonDirText = trimGit((await runGit(repo, ["rev-parse", "--git-common-dir"])).stdout);
  const objectsText = trimGit((await runGit(repo, ["rev-parse", "--git-path", "objects"])).stdout);
  if (!gitDirText || !commonDirText || !objectsText) throw new ReviewPolicyError("base_invalid");
  const gitDir = await realpath(resolve(repo, gitDirText)).catch(() => { throw new ReviewPolicyError("base_invalid"); });
  const commonDir = await realpath(resolve(repo, commonDirText)).catch(() => { throw new ReviewPolicyError("base_invalid"); });
  const objectsPath = resolve(repo, objectsText);
  await rejectReparseAncestors(objectsPath);
  const objects = await realpath(objectsPath).catch(() => { throw new ReviewPolicyError("base_invalid"); });
  const gitDirInfo = await existingInfo(gitDir);
  const commonDirInfo = await existingInfo(commonDir);
  const objectsInfo = await existingInfo(objects);
  if (!gitDirInfo?.isDirectory() || gitDirInfo.isSymbolicLink()
    || !commonDirInfo?.isDirectory() || commonDirInfo.isSymbolicLink()
    || !objectsInfo?.isDirectory() || objectsInfo.isSymbolicLink()) throw new ReviewPolicyError("base_invalid");
  if (!pathInside(commonDir, objects) && !pathInside(gitDir, objects)) throw new ReviewPolicyError("base_invalid");
  await rejectReparseAncestors(objects);

  const shallow = trimGit((await runGit(repo, ["rev-parse", "--is-shallow-repository"])).stdout);
  if (shallow !== "false") throw new ReviewPolicyError("base_invalid");
  const [shallowPath, graftsPath, alternatesPath, replacePath] = await Promise.all([
    gitPath(repo, "shallow"),
    gitPath(repo, "info/grafts"),
    gitPath(repo, "objects/info/alternates"),
    gitPath(repo, "refs/replace"),
  ]);
  for (const special of [shallowPath, graftsPath, alternatesPath, replacePath]) {
    const resolved = resolve(repo, special);
    if (!pathInside(commonDir, resolved) && !pathInside(gitDir, resolved)) throw new ReviewPolicyError("base_invalid");
    await assertAbsent(resolved);
  }
  const replacements = trimGit((await runGit(repo, ["for-each-ref", "refs/replace", "--format=%(refname)"])).stdout);
  if (replacements) throw new ReviewPolicyError("base_invalid");
  return { repo, gitDir, commonDir, objects };
}

function isJsonWhitespace(character) {
  return character === " " || character === "\n" || character === "\r" || character === "\t";
}

function skipJsonWhitespace(source, state) {
  while (isJsonWhitespace(source[state.index])) state.index += 1;
}

function parserString(source, state) {
  const start = state.index;
  state.index += 1;
  while (state.index < source.length) {
    const character = source[state.index];
    if (character === "\\") {
      state.index += 1;
      if (state.index >= source.length) throw new BoundedJsonError();
      if (source[state.index] === "u") state.index += 5;
      else state.index += 1;
      continue;
    }
    if (character === '"') {
      state.index += 1;
      const token = source.slice(start, state.index);
      let value;
      try {
        value = JSON.parse(token);
      } catch {
        throw new BoundedJsonError();
      }
      if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) throw new BoundedJsonError();
      return value;
    }
    if (source.charCodeAt(state.index) < 0x20) throw new BoundedJsonError();
    state.index += 1;
  }
  throw new BoundedJsonError();
}

function parserValue(source, state, depth) {
  if (depth > MAX_JSON_DEPTH) throw new BoundedJsonError();
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) throw new BoundedJsonError();
  skipJsonWhitespace(source, state);
  const character = source[state.index];
  if (character === '"') return parserString(source, state);
  if (character === "{") {
    state.index += 1;
    const object = Object.create(null);
    const keys = new Set();
    let count = 0;
    skipJsonWhitespace(source, state);
    if (source[state.index] === "}") {
      state.index += 1;
      return object;
    }
    while (true) {
      if (source[state.index] !== '"') throw new BoundedJsonError();
      const key = parserString(source, state);
      if (keys.has(key)) throw new BoundedJsonError();
      keys.add(key);
      count += 1;
      if (count > MAX_OBJECT_KEYS) throw new BoundedJsonError();
      skipJsonWhitespace(source, state);
      if (source[state.index] !== ":") throw new BoundedJsonError();
      state.index += 1;
      defineOwn(object, key, parserValue(source, state, depth + 1));
      skipJsonWhitespace(source, state);
      if (source[state.index] === ",") {
        state.index += 1;
        skipJsonWhitespace(source, state);
        if (source[state.index] === "}") throw new BoundedJsonError();
        continue;
      }
      if (source[state.index] === "}") {
        state.index += 1;
        return object;
      }
      throw new BoundedJsonError();
    }
  }
  if (character === "[") {
    state.index += 1;
    const array = [];
    skipJsonWhitespace(source, state);
    if (source[state.index] === "]") {
      state.index += 1;
      return array;
    }
    while (true) {
      if (array.length >= MAX_ARRAY_ITEMS) throw new BoundedJsonError();
      array.push(parserValue(source, state, depth + 1));
      skipJsonWhitespace(source, state);
      if (source[state.index] === ",") {
        state.index += 1;
        skipJsonWhitespace(source, state);
        if (source[state.index] === "]") throw new BoundedJsonError();
        continue;
      }
      if (source[state.index] === "]") {
        state.index += 1;
        return array;
      }
      throw new BoundedJsonError();
    }
  }
  if (source.startsWith("true", state.index)) {
    state.index += 4;
    return true;
  }
  if (source.startsWith("false", state.index)) {
    state.index += 5;
    return false;
  }
  if (source.startsWith("null", state.index)) {
    state.index += 4;
    return null;
  }
  const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(state.index));
  if (number) {
    state.index += number[0].length;
    const value = Number(number[0]);
    if (!Number.isSafeInteger(value)) throw new BoundedJsonError();
    return Object.is(value, -0) ? 0 : value;
  }
  throw new BoundedJsonError();
}

function parseBoundedJson(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BLOB_BYTES) throw new BoundedJsonError();
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) throw new BoundedJsonError();
  const state = { index: 0, nodes: 0 };
  const value = parserValue(source, state, 0);
  skipJsonWhitespace(source, state);
  if (state.index !== source.length) throw new BoundedJsonError();
  return materialize(value);
}

async function readBlob(repoInfo, commit, path, code) {
  let tree;
  try {
    tree = textFromGit((await runGit(repoInfo.repo, ["ls-tree", "-z", commit, "--", path])).stdout);
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    throw new ReviewPolicyError(code);
  }
  if (!tree) throw new ReviewPolicyError(code);
  const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(tree);
  if (!match || match[3] !== path) throw new ReviewPolicyError(code);
  const objectId = match[2];
  let typeText;
  let sizeText;
  try {
    typeText = trimGit((await runGit(repoInfo.repo, ["cat-file", "-t", objectId])).stdout);
    sizeText = trimGit((await runGit(repoInfo.repo, ["cat-file", "-s", objectId])).stdout);
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    throw new ReviewPolicyError(code);
  }
  if (typeText !== "blob") throw new ReviewPolicyError(code);
  let size;
  try {
    size = parseSafeInteger(sizeText);
  } catch {
    throw new ReviewPolicyError(code);
  }
  if (size > MAX_BLOB_BYTES) throw new ReviewPolicyError(code);
  let content;
  try {
    content = (await runGit(repoInfo.repo, ["cat-file", "blob", objectId])).stdout;
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    throw new ReviewPolicyError(code);
  }
  if (content.length !== size || content.length > MAX_BLOB_BYTES) throw new ReviewPolicyError(code);
  const algorithm = objectId.length === 40 ? "sha1" : SHA256;
  const calculated = createHash(algorithm).update(`blob ${content.length}\0`, "utf8").update(content).digest("hex");
  if (calculated !== objectId) throw new ReviewPolicyError(code);
  return content;
}

async function readJsonAt(repoInfo, commit, path, code) {
  return parseBoundedJson(await readBlob(repoInfo, commit, path, code));
}

async function verifyTrustedLoader(repoInfo, baseSha) {
  // The module may be launched through a controller shim, so bind its bytes
  // rather than trusting its mutable filesystem location. The fixed loader
  // blob is still read from the exact trusted base below.
  const actualPath = await realpath(MODULE_PATH).catch(() => { throw new ReviewPolicyError("base_invalid"); });
  const info = await existingInfo(actualPath);
  if (!info || !info.isFile() || info.isSymbolicLink()) throw new ReviewPolicyError("base_invalid");
  let localBytes;
  try {
    localBytes = await readFile(actualPath);
  } catch {
    throw new ReviewPolicyError("base_invalid");
  }
  const trustedBytes = await readBlob(repoInfo, baseSha, LOADER_PATH, "base_invalid");
  if (!localBytes.equals(trustedBytes)) throw new ReviewPolicyError("base_invalid");
}

async function resolveCommit(repoInfo, sha, code) {
  if (!exactSha(sha)) throw new ReviewPolicyError(code);
  let resolved;
  let type;
  try {
    resolved = trimGit((await runGit(repoInfo.repo, ["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`])).stdout);
    type = trimGit((await runGit(repoInfo.repo, ["cat-file", "-t", sha])).stdout);
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    throw new ReviewPolicyError(code);
  }
  if (resolved !== sha || type !== "commit") throw new ReviewPolicyError(code);
  return sha;
}

async function assertAncestry(repoInfo, baseSha, candidateSha) {
  try {
    await runGit(repoInfo.repo, ["merge-base", "--is-ancestor", baseSha, candidateSha]);
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    throw new ReviewPolicyError("candidate_invalid");
  }
}

function errorForSchema(error, code) {
  if (error instanceof GitOutputOversizedError) throw error;
  return new ReviewPolicyError(code);
}

function semanticError(path) {
  return { code: "policy_invalid", message: "review policy is not ready", path };
}

function validInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validRootSegment(segment, allowParent = false) {
  if (!segment || CONTROL_CHARACTER.test(segment) || RESERVED_PATH_CHARACTERS.test(segment) || /[\\/]/.test(segment)) return false;
  if (allowParent && segment === "..") return true;
  if (segment === "." || segment === "..") return false;
  if (/[. ]$/.test(segment) || DEVICE_SEGMENT.test(segment)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment);
}

/** Validate the non-filesystem portion of the approved parent-root syntax. */
function validateRootSyntax(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || value.length === 0) return false;
  if (CONTROL_CHARACTER.test(value) || value.includes("\\") || value.includes("//") || value.startsWith("/") || isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  if (segments.length !== 3 || segments[0] !== ".." || segments[1] !== "ai-workspaces") return false;
  if (!validRootSegment(segments[0], true) || !validRootSegment(segments[1]) || !validRootSegment(segments[2])) return false;
  return true;
}

function validatePolicyShape(policy) {
  const errors = [];
  if (!isRecord(policy)) return [semanticError("/delivery/review")];
  const expectedPolicyKeys = new Set(["workspaceRoot", "quarantineRoot", "remotePolicy", "quarantineRetentionSeconds", "limits"]);
  if (Object.keys(policy).some((key) => !expectedPolicyKeys.has(key))) errors.push(semanticError("/delivery/review"));
  for (const key of expectedPolicyKeys) if (!Object.hasOwn(policy, key)) errors.push(semanticError(`/delivery/review/${key}`));
  if (!validateRootSyntax(policy.workspaceRoot)) errors.push(semanticError("/delivery/review/workspaceRoot"));
  if (!validateRootSyntax(policy.quarantineRoot)) errors.push(semanticError("/delivery/review/quarantineRoot"));
  if (policy.remotePolicy !== "none") errors.push(semanticError("/delivery/review/remotePolicy"));
  if (!validInteger(policy.quarantineRetentionSeconds, 0, 31_536_000)) errors.push(semanticError("/delivery/review/quarantineRetentionSeconds"));
  if (!isRecord(policy.limits)) {
    errors.push(semanticError("/delivery/review/limits"));
  } else {
    const expectedLimitKeys = new Set(["maxWorkspaces", "maxWorkspaceBytes", "maxQuarantineBytes", "maxUntrackedEntries", "maxUntrackedBytes"]);
    if (Object.keys(policy.limits).some((key) => !expectedLimitKeys.has(key))) errors.push(semanticError("/delivery/review/limits"));
    for (const key of expectedLimitKeys) if (!Object.hasOwn(policy.limits, key)) errors.push(semanticError(`/delivery/review/limits/${key}`));
    if (!validInteger(policy.limits.maxWorkspaces, 1, 256)) errors.push(semanticError("/delivery/review/limits/maxWorkspaces"));
    if (!validInteger(policy.limits.maxWorkspaceBytes, 1_048_576, 8_589_934_592)) errors.push(semanticError("/delivery/review/limits/maxWorkspaceBytes"));
    if (!validInteger(policy.limits.maxQuarantineBytes, 1_048_576, 8_589_934_592)) errors.push(semanticError("/delivery/review/limits/maxQuarantineBytes"));
    if (!validInteger(policy.limits.maxUntrackedEntries, 1, 100_000)) errors.push(semanticError("/delivery/review/limits/maxUntrackedEntries"));
    if (!validInteger(policy.limits.maxUntrackedBytes, 0, 2_147_483_648)) errors.push(semanticError("/delivery/review/limits/maxUntrackedBytes"));
  }
  if (policy.workspaceRoot === policy.quarantineRoot) errors.push(semanticError("/delivery/review"));
  return errors;
}

/**
 * Compile and validate a trusted profile with the exact schema bytes supplied
 * by the trusted base. Callers may pass either a compiled TypeBox validator or
 * the parsed schema object; no candidate schema is accepted by the loader.
 */
export function validateTrustedReviewProfile(profile, schemaOrValidator) {
  const errors = [];
  let validator = schemaOrValidator;
  try {
    if (validator && typeof validator.Check !== "function") validator = Compile(validator);
    if (!validator || typeof validator.Check !== "function" || typeof validator.Errors !== "function") {
      return { ok: false, errors: [semanticError("/")] };
    }
    if (!validator.Check(profile)) {
      for (const error of validator.Errors(profile)) errors.push({ code: "schema_invalid", message: "trusted profile does not match its trusted schema", path: error.path || "/" });
    }
  } catch {
    return { ok: false, errors: [semanticError("/")] };
  }
  if (errors.length) return { ok: false, errors };
  if (profile.projectId !== APPROVED_PROJECT_ID || profile.repository?.source !== APPROVED_REPOSITORY_SOURCE) {
    return { ok: false, errors: [semanticError("/repository")] };
  }
  const delivery = profile?.delivery;
  if (!isRecord(profile) || !isRecord(delivery) || !Object.hasOwn(delivery, "review")) return { ok: false, errors: [semanticError("/delivery/review")] };
  const semantic = validatePolicyShape(delivery.review);
  return { ok: semantic.length === 0, errors: semantic };
}

export { validateRootSyntax };

async function validatePolicyRoots(repo, policy) {
  if (!validateRootSyntax(policy.workspaceRoot) || !validateRootSyntax(policy.quarantineRoot)) throw new ReviewPolicyError("policy_invalid");
  const workspace = resolve(repo, policy.workspaceRoot);
  const quarantine = resolve(repo, policy.quarantineRoot);
  if (pathInside(repo, workspace) || pathInside(repo, quarantine) || pathInside(workspace, repo) || pathInside(quarantine, repo)
    || pathInside(workspace, quarantine) || pathInside(quarantine, workspace)) throw new ReviewPolicyError("policy_invalid");
  await rejectReparseAncestors(workspace);
  await rejectReparseAncestors(quarantine);
  return { workspace, quarantine };
}

function classifyBaseProfile(profile) {
  if (!isRecord(profile) || !isRecord(profile.delivery)) throw new ReviewPolicyError("base_invalid");
  if (!Object.hasOwn(profile.delivery, "review")) throw new ReviewPolicyError("bootstrap_required");
  if (!isRecord(profile.delivery.review)) throw new ReviewPolicyError("policy_invalid");
  return profile;
}

function policyDigest(policy) {
  return sha256(canonicalJson(policy));
}

function readyResult({ mode, baseSha, candidateSha, policy }) {
  const digest = policyDigest(policy);
  const bindingDigest = sha256(canonicalJson(createBinding({ mode, baseSha, candidateSha, policyDigest: digest })));
  return result({
    mode,
    status: "ready",
    code: "ready",
    baseSha,
    candidateSha,
    policy,
    policyDigest: digest,
    bindingDigest,
  });
}

async function loadImplementation(options) {
  const mode = options.mode;
  if (!MODES.has(mode)) return blocked(options, "mode_invalid");
  if (!exactSha(options.baseSha)) return blocked(options, "base_invalid");
  let repoInfo;
  try {
    repoInfo = await inspectRepository(options.repo);
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    if (error instanceof ReviewPolicyError && error.code === "internal_blocked") throw error;
    throw new ReviewPolicyError("base_invalid");
  }

  let baseSha;
  try {
    baseSha = await resolveCommit(repoInfo, options.baseSha, "base_invalid");
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    throw new ReviewPolicyError("base_invalid");
  }
  let profile;
  try {
    profile = await readJsonAt(repoInfo, baseSha, PROFILE_PATH, "base_invalid");
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    throw errorForSchema(error, "base_invalid");
  }
  classifyBaseProfile(profile);
  await verifyTrustedLoader(repoInfo, baseSha);

  // This is intentionally before candidate validation or candidate object
  // access. A legacy base cannot be upgraded by candidate-controlled policy.
  if (mode === "bootstrap-check") {
    if (options.candidateSha !== undefined) {
      if (!exactSha(options.candidateSha)) throw new ReviewPolicyError("candidate_invalid");
      try {
        await resolveCommit(repoInfo, options.candidateSha, "candidate_invalid");
        await assertAncestry(repoInfo, baseSha, options.candidateSha);
      } catch (error) {
        if (error instanceof GitOutputOversizedError) throw error;
        throw new ReviewPolicyError("candidate_invalid");
      }
    }
    return result({
      mode,
      status: "bootstrap_only",
      code: "policy_present",
      baseSha,
      candidateSha: exactSha(options.candidateSha) ? options.candidateSha : undefined,
    });
  }

  let schema;
  try {
    schema = await readJsonAt(repoInfo, baseSha, SCHEMA_PATH, "base_invalid");
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    throw new ReviewPolicyError("base_invalid");
  }
  let validation;
  try {
    validation = validateTrustedReviewProfile(profile, schema);
  } catch {
    throw new ReviewPolicyError("policy_invalid");
  }
  if (!validation.ok) throw new ReviewPolicyError("policy_invalid");
  await validatePolicyRoots(repoInfo.repo, profile.delivery.review);

  if (options.candidateSha === undefined) throw new ReviewPolicyError("candidate_required");
  if (!exactSha(options.candidateSha)) throw new ReviewPolicyError("candidate_invalid");
  const candidateSha = options.candidateSha;
  try {
    await resolveCommit(repoInfo, candidateSha, "candidate_invalid");
    await assertAncestry(repoInfo, baseSha, candidateSha);
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    throw new ReviewPolicyError("candidate_invalid");
  }
  let candidateProfile;
  try {
    candidateProfile = await readJsonAt(repoInfo, candidateSha, PROFILE_PATH, "candidate_invalid");
  } catch (error) {
    if (error instanceof GitOutputOversizedError) throw error;
    throw new ReviewPolicyError("candidate_invalid");
  }
  let candidateValidation;
  try {
    candidateValidation = validateTrustedReviewProfile(candidateProfile, schema);
  } catch {
    throw new ReviewPolicyError("candidate_invalid");
  }
  if (!candidateValidation.ok) throw new ReviewPolicyError("candidate_invalid");
  if (canonicalJson(candidateProfile.delivery.review) !== canonicalJson(profile.delivery.review)) throw new ReviewPolicyError("profile_drift");
  return readyResult({ mode, baseSha, candidateSha, policy: profile.delivery.review });
}

export async function loadTrustedReviewPolicy(options = {}) {
  const normalized = {
    repo: options?.repo,
    mode: options?.mode,
    baseSha: options?.baseSha,
    candidateSha: options?.candidateSha,
  };
  try {
    return await loadImplementation(normalized);
  } catch (error) {
    const code = error instanceof ReviewPolicyError && [
      "bootstrap_required", "base_invalid", "policy_invalid", "candidate_required", "candidate_invalid",
      "profile_drift", "mode_invalid", "git_output_oversized", "internal_blocked",
    ].includes(error.code)
      ? error.code
      : "internal_blocked";
    return blocked(normalized, code);
  }
}

function parseCli(argv) {
  if (argv[0] !== "verify") throw new ReviewPolicyError("mode_invalid");
  const values = {};
  const names = new Map([
    ["--repo", "repo"],
    ["--mode", "mode"],
    ["--base", "baseSha"],
    ["--base-sha", "baseSha"],
    ["--candidate", "candidateSha"],
    ["--candidate-sha", "candidateSha"],
  ]);
  if ((argv.length - 1) % 2 !== 0) throw new ReviewPolicyError("mode_invalid");
  for (let index = 1; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || Object.hasOwn(values, key)) throw new ReviewPolicyError("mode_invalid");
    const maximum = key === "repo" ? MAX_REPO_PATH_BYTES : key === "mode" ? 64 : MAX_INPUT_BYTES;
    if (!boundedString(argv[index + 1], maximum)) throw new ReviewPolicyError(key === "baseSha" ? "base_invalid" : key === "candidateSha" ? "candidate_invalid" : "mode_invalid");
    values[key] = argv[index + 1];
  }
  if (!Object.hasOwn(values, "mode")) throw new ReviewPolicyError("mode_invalid");
  if (!Object.hasOwn(values, "baseSha")) throw new ReviewPolicyError("base_invalid");
  return values;
}

async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    options = { mode: "invalid", baseSha: undefined, candidateSha: undefined };
    const code = error instanceof ReviewPolicyError ? error.code : "internal_blocked";
    const output = blocked(options, ["base_invalid", "candidate_invalid", "mode_invalid"].includes(code) ? code : "internal_blocked");
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 1;
    return;
  }
  const output = await loadTrustedReviewPolicy(options);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.code !== "ready") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
