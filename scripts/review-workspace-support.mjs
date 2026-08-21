/** Shared bounded Git, profile, and lease primitives for managed review workspaces. */
/**
 * Managed, disposable review workspaces.
 *
 * Review workspaces are ordinary isolated clones, not linked worktrees.  The
 * clone has its own Git config and object database, is detached at one exact
 * commit, has no remote, and never receives a reviewer Git identity.  Cleanup
 * is deliberately a two-step quarantine/authorized-delete operation.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  commonGitDirectory,
  parseProfile,
  pathInside,
  pathKey,
  profileLocation,
  repositoryContext,
  validateProfile,
} from "./delivery-worktree.mjs";

const FORMAT_VERSION = 1;
const LEASE_FORMAT = "pi-sampler.review-workspace-lease";
const WORKSPACE_FORMAT = "pi-sampler.review-workspace";
const DEFAULT_PROFILE = "profiles/pi-sampler.json";
const MAX_ATTEMPTS = 32;
const MAX_LEASE_BYTES = 128 * 1024;
const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_DEPTH = 64;
const HEX_COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const DISPOSABLE_TOP_LEVEL = new Set([
  ".cache",
  ".npm",
  ".pnpm-store",
  "coverage",
  "dist",
  "node_modules",
  "temp",
  "tmp",
]);
const SAFE_ENVIRONMENT_NAMES = Object.freeze(process.platform === "win32"
  ? ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA"]
  : ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]);
const GIT_OPTIONS = Object.freeze([
  "--no-pager",
  "--no-replace-objects",
  "--no-optional-locks",
  "-c", "trace2.eventTarget=",
  "-c", "trace2.normalTarget=",
  "-c", "trace2.perfTarget=",
  "-c", "color.ui=false",
  // Commands performed by this module must never execute a repository hook.
  "-c", "core.hooksPath=/dev/null",
  // Even a temporary global/system config must not provide a reviewer author.
  "-c", "user.useConfigOnly=true",
]);

export class ReviewWorkspaceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ReviewWorkspaceError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new ReviewWorkspaceError(code, message, details);
}

function fixedGitEnvironment(source = process.env) {
  const environment = {};
  for (const expectedName of SAFE_ENVIRONMENT_NAMES) {
    const entry = Object.entries(source).find(([name]) => name.toLowerCase() === expectedName.toLowerCase());
    if (entry && !/^git_/i.test(entry[0])) environment[entry[0]] = entry[1];
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  // Do not inherit either system or global Git configuration.  In particular,
  // a caller-provided HOME/GIT_CONFIG_GLOBAL must not supply an author.
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  return environment;
}

function git(cwd, args, { allowFailure = false, maxBuffer = MAX_STATUS_BYTES } = {}) {
  const result = spawnSync("git", [...GIT_OPTIONS, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: fixedGitEnvironment(),
    maxBuffer,
  });
  if (result.error) fail("git_unavailable", `git could not start: ${result.error.message}`);
  const stdout = (result.stdout || "").toString();
  const stderr = (result.stderr || "").toString();
  if (result.status !== 0 && !allowFailure) {
    const summary = (stderr || stdout || "git command failed").trim().split(/\r?\n/, 1)[0];
    fail("git_failed", summary || "git command failed");
  }
  return { ok: result.status === 0, stdout, stderr };
}

function bounded(value, label, maximum = 240) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) fail("argument_invalid", `${label} is missing, unsafe, or exceeds its bound`);
  return value;
}

function safeRelativeConfigPath(value, label) {
  bounded(value, label, 240);
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.replaceAll("\\", "/").split("/").some((part) => part === "" || part === "." || part === "..")) {
    // A configured path is allowed to contain parent traversal so long as its
    // resolved root is outside the repository; empty/dot segments remain
    // rejected to keep path identity deterministic.
    const normalized = value.replaceAll("\\", "/");
    if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || normalized.split("/").some((part) => part === "" || part === ".")) fail("profile_invalid", `${label} must be a bounded relative path`);
  }
  return value;
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function safeName(value, label) {
  bounded(value, label, 96);
  if (!SAFE_NAME.test(value) || value === "." || value === "..") fail("name_invalid", `${label} is not a safe single path component`);
  return value;
}

function randomHex(length) {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function tokenEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function bytesEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && left.equals(right);
}

async function regularLstat(target, label) {
  const info = await lstat(target).catch((error) => fail("path_missing", `${label} does not exist: ${error.message}`));
  if (info.isSymbolicLink()) fail("unsafe_path", `${label} is a symbolic link or reparse point`);
  if (!info.isFile() && !info.isDirectory()) fail("unsafe_path", `${label} is not a regular file or directory`);
  return info;
}

async function ensureDirectoryNoSymlinks(target, label) {
  const absolute = resolve(target);
  const parsed = parse(absolute);
  const suffix = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const component of suffix) {
    current = join(current, component);
    await mkdir(current).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current).catch((error) => fail("path_missing", `${label} could not be validated: ${error.message}`));
    if (info.isSymbolicLink() || !info.isDirectory()) fail("unsafe_path", `${label} contains a symbolic link, junction, or non-directory component`);
  }
  const canonical = await realpath(absolute).catch((error) => fail("path_missing", `${label} could not be resolved: ${error.message}`));
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("unsafe_path", `${label} is not a real directory`);
  return canonical;
}

async function configuredRoot(repoRoot, configured, label) {
  safeRelativeConfigPath(configured, label);
  const candidate = resolve(repoRoot, configured);
  const canonical = await ensureDirectoryNoSymlinks(candidate, label);
  if (pathInside(repoRoot, canonical)) fail("profile_invalid", `${label} must be outside the repository`);
  return canonical;
}

function reviewConfiguration(profile) {
  const review = profile?.delivery?.review;
  if (!review) fail("review_config_missing", "the approved project profile does not configure delivery.review");
  const limits = review.limits;
  return {
    workspaceRoot: review.workspaceRoot,
    quarantineRoot: review.quarantineRoot,
    remotePolicy: review.remotePolicy,
    quarantineRetentionSeconds: review.quarantineRetentionSeconds,
    limits: {
      maxWorkspaces: limits.maxWorkspaces,
      maxWorkspaceBytes: limits.maxWorkspaceBytes,
      maxQuarantineBytes: limits.maxQuarantineBytes,
      maxUntrackedEntries: limits.maxUntrackedEntries,
      maxUntrackedBytes: limits.maxUntrackedBytes,
    },
  };
}

async function loadContext(options = {}, { requireHead = false, requireTrustedBase = false } = {}) {
  const { checkoutRoot, repositoryRoot } = await repositoryContext(options.repo);
  const profilePath = await profileLocation(checkoutRoot, options.profile || DEFAULT_PROFILE);
  const checkoutHead = git(checkoutRoot, ["rev-parse", "--verify", "HEAD^{commit}"], { maxBuffer: 256 }).stdout.trim();
  let baseSha = null;
  let profileText;
  if (requireHead || requireTrustedBase) {
    const requestedBase = options.base ?? options.baseSha;
    if (typeof requestedBase !== "string" || !HEX_COMMIT.test(requestedBase)) fail("base_required", "review operations require an exact immutable --base commit");
    baseSha = git(repositoryRoot, ["rev-parse", "--verify", "--end-of-options", `${requestedBase}^{commit}`], { maxBuffer: 256 }).stdout.trim();
    if (baseSha !== requestedBase || !HEX_COMMIT.test(baseSha)) fail("base_invalid", "--base does not identify the exact review base commit");
    profileText = git(repositoryRoot, ["show", `${baseSha}:${profilePath.relative}`], { maxBuffer: MAX_LEASE_BYTES }).stdout;
  } else {
    profileText = git(checkoutRoot, ["show", `${checkoutHead}:${profilePath.relative}`], { maxBuffer: MAX_LEASE_BYTES }).stdout;
  }
  const profileDigest = digest(profileText);
  const profile = validateProfile(parseProfile(profileText), options.workItem);
  const review = reviewConfiguration(profile);
  const workspaceRoot = await configuredRoot(repositoryRoot, review.workspaceRoot, "delivery.review.workspaceRoot");
  const quarantineRoot = await configuredRoot(repositoryRoot, review.quarantineRoot, "delivery.review.quarantineRoot");
  if (samePath(workspaceRoot, quarantineRoot) || pathInside(workspaceRoot, quarantineRoot) || pathInside(quarantineRoot, workspaceRoot)) {
    fail("profile_invalid", "review workspace and quarantine roots must be disjoint");
  }
  let head;
  if (requireHead) {
    const requestedHead = options.head ?? options.headSha ?? options.candidateSha ?? options.candidateHead ?? options.candidate;
    if (typeof requestedHead !== "string" || !HEX_COMMIT.test(requestedHead)) fail("head_invalid", "--head must be an immutable 40- or 64-character lowercase commit ID");
    head = git(repositoryRoot, ["rev-parse", "--verify", "--end-of-options", `${requestedHead}^{commit}`], { maxBuffer: 256 }).stdout.trim();
    if (head !== requestedHead || !HEX_COMMIT.test(head)) fail("head_invalid", "--head does not identify the exact candidate commit");
    if (git(repositoryRoot, ["cat-file", "-t", head], { maxBuffer: 64 }).stdout.trim() !== "commit") fail("head_invalid", "--head is not a commit");
    if (!git(repositoryRoot, ["merge-base", "--is-ancestor", baseSha, head], { allowFailure: true, maxBuffer: 64 }).ok) fail("base_invalid", "--base is not an ancestor of the exact candidate head");

    const candidateProfileText = git(repositoryRoot, ["show", `${head}:${profilePath.relative}`], { maxBuffer: MAX_LEASE_BYTES }).stdout;
    const candidateProfile = parseProfile(candidateProfileText);
    validateProfile(candidateProfile, options.workItem);
    if (digest(candidateProfileText) !== profileDigest || stableJson(candidateProfile) !== stableJson(profile)) fail("profile_drift", "candidate profile bytes differ from the immutable approved base profile");
  }
  return { checkoutRoot, repositoryRoot, checkoutHead, profilePath, profile, profileDigest, review, workspaceRoot, quarantineRoot, head, baseSha };
}

async function leaseDirectory(repositoryRoot) {
  const common = await commonGitDirectory(repositoryRoot);
  const commonInfo = await regularLstat(common, "Git common directory");
  if (!commonInfo.isDirectory() || !pathInside(repositoryRoot, common)) fail("repository_invalid", "Git common directory is not inside the repository boundary");
  return ensureDirectoryNoSymlinks(join(common, "pi-review-leases"), "review lease directory");
}

function leaseFileFor(leaseRoot, workspacePath) {
  return join(leaseRoot, `${pathKey(workspacePath)}.json`);
}

function lockFileFor(leasePath) {
  return `${leasePath}.operation.lock`;
}

function capacityLockFileFor(leaseRoot) {
  return join(leaseRoot, ".capacity.lock");
}

async function readRegularFile(target, label, maximum = MAX_LEASE_BYTES) {
  const info = await regularLstat(target, label);
  if (!info.isFile() || info.size > maximum) fail("lease_invalid", `${label} is too large`);
  return readFile(target);
}

function parseLeaseBytes(bytes, label = "review lease") {
  let lease;
  try {
    lease = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("lease_invalid", `${label} is not valid JSON`);
  }
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) fail("lease_invalid", `${label} is not an object`);
  if (lease.format !== LEASE_FORMAT || lease.version !== FORMAT_VERSION) fail("lease_invalid", `${label} format is unsupported`);
  if (typeof lease.token !== "string" || !/^[a-f0-9]{48}$/.test(lease.token)) fail("lease_invalid", `${label} token is invalid`);
  if (typeof lease.projectId !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(lease.projectId)) fail("lease_invalid", `${label} project identity is invalid`);
  if (typeof lease.repositoryRoot !== "string" || !isAbsolute(lease.repositoryRoot)) fail("lease_invalid", `${label} repository identity is invalid`);
  if (typeof lease.workspacePath !== "string" || !isAbsolute(lease.workspacePath)) fail("lease_invalid", `${label} workspace identity is invalid`);
  if (typeof lease.currentPath !== "string" || !isAbsolute(lease.currentPath)) fail("lease_invalid", `${label} current path is invalid`);
  if (lease.previousPath !== undefined && (typeof lease.previousPath !== "string" || !isAbsolute(lease.previousPath))) fail("lease_invalid", `${label} previous path is invalid`);
  if (!HEX_COMMIT.test(lease.head)) fail("lease_invalid", `${label} head is invalid`);
  if (typeof lease.profileDigest !== "string" || !/^[a-f0-9]{64}$/.test(lease.profileDigest)) fail("lease_invalid", `${label} approved profile digest is invalid`);
  if (!["preparing", "active", "quarantining", "quarantined", "deleting", "deleted", "aborted"].includes(lease.state)) fail("lease_invalid", `${label} state is invalid`);
  if (typeof lease.createdAt !== "string" || !Number.isFinite(Date.parse(lease.createdAt))) fail("lease_invalid", `${label} creation time is invalid`);
  if (["quarantining", "quarantined", "deleting", "deleted"].includes(lease.state) && (typeof lease.quarantinePath !== "string" || !isAbsolute(lease.quarantinePath))) fail("lease_invalid", `${label} quarantine path is invalid`);
  if (lease.transition !== undefined) {
    if (!lease.transition || typeof lease.transition !== "object" || Array.isArray(lease.transition)) fail("lease_invalid", `${label} rename transition is invalid`);
    if (!["quarantine", "delete"].includes(lease.transition.kind)) fail("lease_invalid", `${label} rename transition kind is invalid`);
    if (typeof lease.transition.fromPath !== "string" || !isAbsolute(lease.transition.fromPath) || typeof lease.transition.toPath !== "string" || !isAbsolute(lease.transition.toPath) || samePath(lease.transition.fromPath, lease.transition.toPath)) fail("lease_invalid", `${label} rename transition paths are invalid`);
    if (!["quarantining", "deleting"].includes(lease.state)) fail("lease_invalid", `${label} rename transition state is invalid`);
    if (lease.state === "quarantining" && lease.transition.kind !== "quarantine") fail("lease_invalid", `${label} quarantine transition is invalid`);
    if (lease.state === "deleting" && lease.transition.kind !== "delete") fail("lease_invalid", `${label} deletion transition is invalid`);
  }
  return lease;
}

async function readLease(leasePath) {
  const bytes = await readRegularFile(leasePath, "review lease");
  return { bytes, lease: parseLeaseBytes(bytes) };
}

async function writeNewLease(leasePath, lease) {
  const bytes = jsonBytes(lease);
  await writeFile(leasePath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error) => {
    if (error.code === "EEXIST") fail("lease_conflict", "the generated review workspace already has a lease");
    throw error;
  });
  return bytes;
}

async function replaceLease(leasePath, expectedBytes, lease) {
  const current = await readFile(leasePath).catch((error) => fail("lease_missing", `review lease disappeared: ${error.message}`));
  if (!bytesEqual(current, expectedBytes)) fail("lease_changed", "review lease changed concurrently; preserving the workspace");
  const nextBytes = jsonBytes(lease);
  const temporary = `${leasePath}.tmp-${randomHex(12)}`;
  await writeFile(temporary, nextBytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, leasePath);
  } catch (error) {
    // Windows does not consistently replace an existing file with rename.
    // The operation lock plus a second compare protects the fallback.
    if (!(["EEXIST", "EPERM", "ENOTEMPTY"].includes(error.code))) throw error;
    const checked = await readFile(leasePath).catch(() => undefined);
    if (!bytesEqual(checked, expectedBytes)) fail("lease_changed", "review lease changed during compare-and-swap");
    await rm(leasePath, { force: true });
    await rename(temporary, leasePath);
  }
  return nextBytes;
}

async function abortLease(leasePath, expectedBytes, target) {
  const current = await readLease(leasePath);
  if (!bytesEqual(current.bytes, expectedBytes)) fail("lease_changed", "review lease changed during preparation rollback; preserving the resource");
  await replaceLease(leasePath, current.bytes, {
    ...current.lease,
    state: "aborted",
    currentPath: target,
    abortedAt: new Date().toISOString(),
  });
}


async function acquireFileLock(lockPath, message = "another review workspace operation holds the cleanup lock") {
  const lockBytes = Buffer.from(`${randomHex(48)}\n`, "utf8");
  await writeFile(lockPath, lockBytes, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error) => {
    if (error.code === "EEXIST") fail("operation_locked", message);
    throw error;
  });
  return async () => {
    const current = await readFile(lockPath).catch(() => undefined);
    if (bytesEqual(current, lockBytes)) await rm(lockPath, { force: true });
  };
}

async function acquireOperationLock(leasePath) {
  return acquireFileLock(lockFileFor(leasePath));
}

async function acquireCapacityLock(leaseRoot) {
  const lockPath = capacityLockFileFor(leaseRoot);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      return await acquireFileLock(lockPath, "another review workspace reservation holds the capacity lock");
    } catch (error) {
      if (!(error instanceof ReviewWorkspaceError) || error.code !== "operation_locked") throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
  fail("operation_locked", "review workspace capacity lock did not clear; preserving all reservations");
}

async function listLeaseFiles(leaseRoot) {
  const entries = await readdir(leaseRoot, { withFileTypes: true });
  const leases = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/^[a-f0-9]{24}\.json$/.test(entry.name)) continue;
    const leasePath = join(leaseRoot, entry.name);
    const info = await lstat(leasePath);
    if (info.isSymbolicLink()) fail("lease_invalid", `review lease ${entry.name} is a symbolic link`);
    const record = await readLease(leasePath);
    leases.push({ leasePath, ...record });
  }
  return leases;
}

async function locateLease({ leaseRoot, requestedPath, token }) {
  const canonical = await realpath(requestedPath).catch((error) => fail("workspace_missing", `review workspace does not exist: ${error.message}`));
  const pathInfo = await lstat(requestedPath).catch((error) => fail("workspace_missing", `review workspace does not exist: ${error.message}`));
  if (pathInfo.isSymbolicLink()) fail("unsafe_path", "review workspace path is a symbolic link or reparse point");
  if (!pathInfo.isDirectory()) fail("unsafe_path", "review workspace path is not a directory");
  const candidates = await listLeaseFiles(leaseRoot);
  const found = candidates.find(({ lease }) => samePath(lease.currentPath, canonical) || (lease.state === "active" && samePath(lease.workspacePath, canonical)));
  if (!found) fail("lease_missing", "no review lease owns the requested workspace");
  if (!tokenEqual(found.lease.token, token)) fail("lease_invalid", "review workspace lease token is invalid");
  return { ...found, canonicalPath: canonical };
}

function leasePaths(lease) {
  return [
    lease.workspacePath,
    lease.currentPath,
    lease.quarantinePath,
    lease.transition?.fromPath,
    lease.transition?.toPath,
    lease.previousPath,
  ].filter((value) => typeof value === "string");
}

async function locateLeaseByToken({ leaseRoot, token, requestedPath }) {
  if (typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) fail("lease_invalid", "review workspace lease token is invalid");
  const candidates = await listLeaseFiles(leaseRoot);
  const found = candidates.find(({ lease }) => tokenEqual(lease.token, token));
  if (!found) fail("lease_missing", "review workspace lease does not exist");
  if (requestedPath !== undefined) {
    const requested = resolve(requestedPath);
    const info = await lstat(requested).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      fail("workspace_missing", `review workspace does not exist: ${error.message}`);
    });
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory()) fail("unsafe_path", "requested review workspace is not a real directory");
      const canonical = await realpath(requested).catch((error) => fail("workspace_missing", `review workspace does not exist: ${error.message}`));
      if (!samePath(canonical, requested)) fail("unsafe_path", "requested review workspace resolves through an alias or reparse point");
      if (!leasePaths(found.lease).some((candidate) => samePath(candidate, canonical))) fail("lease_invalid", "review lease path does not match the requested workspace or recovery boundary");
      return { ...found, canonicalPath: canonical };
    }
    if (!leasePaths(found.lease).some((candidate) => samePath(candidate, requested)) || !(found.lease.transition || found.lease.state === "deleting")) fail("workspace_missing", "requested review workspace does not exist at a recoverable lease boundary");
    return { ...found, canonicalPath: requested };
  }
  return { ...found, canonicalPath: found.lease.currentPath };
}

async function gitDirectory(workspacePath) {
  const dotGit = join(workspacePath, ".git");
  const dotGitInfo = await lstat(dotGit).catch((error) => fail("workspace_invalid", `review workspace has no usable .git directory: ${error.message}`));
  if (dotGitInfo.isSymbolicLink() || !dotGitInfo.isDirectory()) fail("workspace_invalid", "review workspace .git must be a real directory");
  const canonical = await realpath(dotGit);
  if (!samePath(canonical, dotGit)) fail("workspace_invalid", "review workspace .git path changed unexpectedly");
  return canonical;
}

async function fileDigest(target) {
  return digest(await readFile(target).catch((error) => fail("workspace_invalid", `cannot read ${target}: ${error.message}`)));
}

async function listTree(target, { skipGit = false, maxDepth = MAX_SCAN_DEPTH, maxEntries = Number.POSITIVE_INFINITY, maxBytes = Number.POSITIVE_INFINITY } = {}) {
  const findings = [];
  const caseAliases = [];
  let bytes = 0;
  let entries = 0;
  let entryLimitReported = false;
  let byteLimitReported = false;
  const visit = async (current, relativePath, depth) => {
    if (entries >= maxEntries) {
      if (!entryLimitReported) findings.push({ code: "scan_entry_limit_exceeded", path: relativePath });
      entryLimitReported = true;
      return;
    }
    if (bytes > maxBytes) {
      if (!byteLimitReported) findings.push({ code: "scan_byte_limit_exceeded", path: relativePath });
      byteLimitReported = true;
      return;
    }
    if (depth > maxDepth) {
      findings.push({ code: "path_depth_exceeded", path: relativePath });
      return;
    }
    const info = await lstat(current).catch((error) => {
      findings.push({ code: "path_unreadable", path: relativePath, message: error.message });
      return;
    });
    if (info.isSymbolicLink()) {
      findings.push({ code: "symlink_or_reparse_point", path: relativePath });
      return;
    }
    entries += 1;
    if (entries > maxEntries) {
      if (!entryLimitReported) findings.push({ code: "scan_entry_limit_exceeded", path: relativePath });
      entryLimitReported = true;
      return;
    }
    if (info.isFile()) {
      bytes += info.size;
      if (bytes > maxBytes) {
        if (!byteLimitReported) findings.push({ code: "scan_byte_limit_exceeded", path: relativePath });
        byteLimitReported = true;
      }
      if (info.nlink > 1) findings.push({ code: "hard_link_present", path: relativePath });
      return;
    }
    if (!info.isDirectory()) {
      findings.push({ code: "special_file", path: relativePath });
      return;
    }
    if (skipGit && relativePath === ".git") return;
    if (relativePath !== ".git" && relativePath.split("/").includes(".git")) {
      findings.push({ code: "nested_repository", path: relativePath });
      return;
    }
    const children = await readdir(current, { withFileTypes: true }).catch((error) => {
      findings.push({ code: "directory_unreadable", path: relativePath, message: error.message });
      return;
    });
    const names = new Map();
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const key = child.name.toLowerCase();
      if (names.has(key)) caseAliases.push({ path: relativePath || ".", names: [names.get(key), child.name] });
      names.set(key, child.name);
      const childRelative = relativePath ? `${relativePath}/${child.name}` : child.name;
      await visit(join(current, child.name), childRelative, depth + 1);
    }
  };
  await visit(target, "", 0);
  return { findings, caseAliases, bytes, entries };
}

async function measureDirectory(target) {
  let bytes = 0;
  let unsafe = false;
  const visit = async (current, depth) => {
    if (depth > MAX_SCAN_DEPTH) {
      unsafe = true;
      return;
    }
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      unsafe = true;
      return;
    }
    if (info.isFile()) {
      bytes += info.size;
      return;
    }
    const children = await readdir(current, { withFileTypes: true }).catch(() => {
      unsafe = true;
      return [];
    });
    for (const child of children) await visit(join(current, child.name), depth + 1);
  };
  await visit(target, 0);
  return { bytes, unsafe };
}

async function lockFiles(gitDir) {
  const result = await listTree(gitDir, { skipGit: false });
  const locks = [];
  const visit = async (current, relativePath, depth) => {
    if (depth > MAX_SCAN_DEPTH) return;
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile() && current.toLowerCase().endsWith(".lock")) locks.push(relativePath);
    if (!info.isDirectory()) return;
    const children = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const child of children) await visit(join(current, child.name), relativePath ? `${relativePath}/${child.name}` : child.name, depth + 1);
  };
  await visit(gitDir, "", 0);
  return { locks, findings: result.findings };
}

function parseStatus(raw) {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const records = [];
  for (const field of fields) {
    if (field.length < 4 || field[2] !== " ") return { error: "Git returned an ambiguous status record" };
    const code = field.slice(0, 2);
    const path = field.slice(3).replaceAll("\\", "/");
    if (!path || path.startsWith("/") || path.split("/").includes("..")) return { error: "Git returned an unsafe status path" };
    records.push({ code, path });
  }
  return { records };
}

function disposablePath(filePath) {
  const first = filePath.replace(/\/+$/, "").split("/")[0];
  return DISPOSABLE_TOP_LEVEL.has(first) && first !== ".git";
}

function collapseStatusRecords(records) {
  const unique = new Map();
  for (const record of records) {
    const path = record.path.replace(/\/+$/, "");
    if (!path) continue;
    unique.set(path, { ...record, path });
  }
  const sorted = [...unique.values()].sort((left, right) => {
    const leftParts = left.path.split("/");
    const rightParts = right.path.split("/");
    return leftParts.length - rightParts.length || left.path.localeCompare(right.path);
  });
  const selected = [];
  for (const record of sorted) {
    if (selected.some(({ path }) => record.path === path || record.path.startsWith(`${path}/`))) continue;
    selected.push(record);
  }
  return selected;
}

async function pathBytes(root, filePath, limits = {}) {
  const candidate = resolve(root, ...filePath.split("/"));
  if (!pathInside(root, candidate)) return { bytes: 0, entries: 0, unsafe: true };
  const scan = await listTree(candidate, {
    skipGit: false,
    maxEntries: limits.maxEntries ?? Number.POSITIVE_INFINITY,
    maxBytes: limits.maxBytes ?? Number.POSITIVE_INFINITY,
  });
  return { bytes: scan.bytes, entries: scan.entries, unsafe: scan.findings.length > 0 };
}

async function unexpectedGitTopLevelEntries(gitDir) {
  const allowed = new Set(["HEAD", "branches", "config", "description", "hooks", "index", "info", "logs", "objects", "packed-refs", "refs", "review-disabled-hooks"]);
  const entries = await readdir(gitDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => !allowed.has(entry.name)).map((entry) => ({ code: "git_storage_unexpected", path: entry.name }));
}

async function objectAlternates(gitDir) {
  const objects = join(gitDir, "objects");
  const findings = [];
  for (const relativePath of ["info/alternates", "info/http-alternates"]) {
    const target = join(objects, relativePath);
    const info = await lstat(target).catch(() => undefined);
    if (info) findings.push({ code: "object_alternate_present", path: relativePath });
  }
  const objectsInfo = await lstat(objects).catch(() => undefined);
  if (!objectsInfo || objectsInfo.isSymbolicLink() || !objectsInfo.isDirectory()) findings.push({ code: "object_store_invalid" });
  return findings;
}

async function looseObjectPaths(objectsRoot, maximum = 64) {
  const result = [];
  const firstLevel = await readdir(objectsRoot, { withFileTypes: true }).catch(() => []);
  for (const first of firstLevel.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[0-9a-f]{2}$/.test(first.name) || !first.isDirectory() || first.isSymbolicLink()) continue;
    const children = await readdir(join(objectsRoot, first.name), { withFileTypes: true }).catch(() => []);
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.isFile() && /^[0-9a-f]{38,62}$/.test(child.name)) {
        result.push(join(first.name, child.name));
        if (result.length >= maximum) return result;
      }
    }
  }
  return result;
}

async function representativeObjectPaths(objectsRoot, maximum = 128) {
  const result = await looseObjectPaths(objectsRoot, maximum);
  if (result.length >= maximum) return result;
  const packRoot = join(objectsRoot, "pack");
  const packEntries = await readdir(packRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of packEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    result.push(join("pack", entry.name));
    if (result.length >= maximum) break;
  }
  return result;
}

async function objectIsolation(sourceGitDir, cloneGitDir) {
  const findings = [];
  if (samePath(sourceGitDir, cloneGitDir) || pathInside(sourceGitDir, cloneGitDir) || pathInside(cloneGitDir, sourceGitDir)) findings.push({ code: "shared_git_directory" });
  findings.push(...await objectAlternates(cloneGitDir));
  const sourceObjects = join(sourceGitDir, "objects");
  const cloneObjects = join(cloneGitDir, "objects");
  const paths = new Set([
    ...await representativeObjectPaths(sourceObjects),
    ...await representativeObjectPaths(cloneObjects),
  ]);
  for (const objectPath of paths) {
    const sourcePath = join(sourceObjects, objectPath);
    const clonePath = join(cloneObjects, objectPath);
    const [sourceInfo, cloneInfo] = await Promise.all([
      stat(sourcePath).catch(() => undefined),
      stat(clonePath).catch(() => undefined),
    ]);
    if (sourceInfo && cloneInfo && sourceInfo.dev !== 0 && sourceInfo.dev === cloneInfo.dev && sourceInfo.ino !== 0 && sourceInfo.ino === cloneInfo.ino) {
      findings.push({ code: "shared_object_hardlink", path: objectPath });
    }
  }
  return findings;
}


export {
  FORMAT_VERSION, LEASE_FORMAT, WORKSPACE_FORMAT, DEFAULT_PROFILE, MAX_ATTEMPTS,
  MAX_LEASE_BYTES, MAX_STATUS_BYTES, MAX_SCAN_DEPTH, HEX_COMMIT, DISPOSABLE_TOP_LEVEL,
  fail, git, bounded, samePath, safeName, randomHex, digest, stableJson, jsonBytes,
  tokenEqual, bytesEqual, regularLstat, ensureDirectoryNoSymlinks, configuredRoot,
  reviewConfiguration, loadContext, leaseDirectory, leaseFileFor, lockFileFor,
  capacityLockFileFor, readRegularFile, parseLeaseBytes, readLease, writeNewLease, replaceLease,
  abortLease, acquireFileLock, acquireOperationLock, acquireCapacityLock, listLeaseFiles,
  locateLease, leasePaths, locateLeaseByToken, gitDirectory, fileDigest, listTree,
  measureDirectory, lockFiles, parseStatus, disposablePath, collapseStatusRecords, pathBytes,
  unexpectedGitTopLevelEntries, objectAlternates, looseObjectPaths, representativeObjectPaths,
  objectIsolation,
};
