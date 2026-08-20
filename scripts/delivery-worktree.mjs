import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FORMAT_VERSION = 1;
const DEFAULT_PROFILE = "profiles/pi-sampler.json";
const MAX_ATTEMPTS = 32;

export class DeliveryWorktreeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeliveryWorktreeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeliveryWorktreeError(code, message);
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) fail("git_unavailable", `git could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const summary = (result.stderr || result.stdout || "git command failed").trim().split(/\r?\n/, 1)[0];
    fail("git_failed", summary);
  }
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function fetchBase(repoRoot, remote, branch) {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    last = git(repoRoot, ["fetch", "--quiet", "--no-tags", remote, branch], { allowFailure: true });
    if (last.ok) return;
    if (attempt < 3) pause(100 * (attempt + 1));
  }
  const summary = (last.stderr || last.stdout || "git fetch failed").split(/\r?\n/, 1)[0];
  fail("git_fetch_failed", summary);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!new Set(["prepare", "cleanup"]).has(command)) fail("usage", "expected prepare or cleanup");
  const options = { fetch: true, deleteBranch: false };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--no-fetch") {
      options.fetch = false;
      continue;
    }
    if (key === "--delete-branch") {
      options.deleteBranch = true;
      continue;
    }
    const name = {
      "--repo": "repo",
      "--profile": "profile",
      "--work-item": "workItem",
      "--base": "base",
      "--slug": "slug",
      "--worktree": "worktree",
      "--lease": "lease",
    }[key];
    if (!name || index + 1 >= argv.length) fail("usage", `invalid or incomplete argument: ${key}`);
    options[name] = argv[index + 1];
    index += 1;
  }
  return { command, options };
}

function normalizeGitPath(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\0")) fail("profile_invalid", `${field} is invalid`);
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) fail("profile_invalid", `${field} must be repository-relative`);
  return normalized;
}

function validateDelivery(delivery) {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) fail("profile_invalid", "delivery configuration is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(delivery.remote)) fail("profile_invalid", "delivery.remote is invalid");
  if (typeof delivery.baseBranch !== "string" || delivery.baseBranch.startsWith("-") || delivery.baseBranch.length > 200) fail("profile_invalid", "delivery.baseBranch is invalid");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(delivery.branchPrefix)) fail("profile_invalid", "delivery.branchPrefix is invalid");
  if (!Number.isSafeInteger(delivery.suffixLength) || delivery.suffixLength < 4 || delivery.suffixLength > 12) fail("profile_invalid", "delivery.suffixLength must be between 4 and 12");
  if (typeof delivery.worktreeRoot !== "string" || delivery.worktreeRoot.length === 0 || delivery.worktreeRoot.length > 240 || delivery.worktreeRoot.includes("\0") || isAbsolute(delivery.worktreeRoot)) fail("profile_invalid", "delivery.worktreeRoot must be a bounded repository-relative path");
  return delivery;
}

function validateProfile(profile, workItem) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) fail("profile_invalid", "project profile is invalid");
  if (typeof profile.projectId !== "string" || !profile.workItem || typeof profile.workItem.idPattern !== "string") fail("profile_invalid", "project profile identity is invalid");
  let pattern;
  try {
    pattern = new RegExp(profile.workItem.idPattern);
  } catch {
    fail("profile_invalid", "work item pattern is invalid");
  }
  if (!pattern.test(workItem)) fail("work_item_invalid", `${workItem} does not match the project profile`);
  validateDelivery(profile.delivery);
  if (!profile.governance?.paths || typeof profile.governance.paths.specification !== "string") fail("profile_invalid", "governance specification path is required");
  return profile;
}

function slugify(value = "delivery") {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  if (!slug) fail("slug_invalid", "delivery slug is empty");
  return slug;
}

function randomSuffix(length) {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function pathKey(path) {
  const canonical = process.platform === "win32" ? path.toLowerCase() : path;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

function pathInside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function canonicalRepository(repoOption) {
  const start = resolve(repoOption || process.cwd());
  const currentRoot = resolve(git(start, ["rev-parse", "--show-toplevel"]).stdout);
  const firstWorktree = git(currentRoot, ["worktree", "list", "--porcelain"]).stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("worktree "));
  if (!firstWorktree) fail("repository_invalid", "repository has no primary worktree");
  return realpath(resolve(firstWorktree.slice("worktree ".length)));
}

async function profileLocation(repoRoot, profileOption) {
  const candidate = resolve(repoRoot, profileOption || DEFAULT_PROFILE);
  const canonicalRepo = await realpath(repoRoot);
  const canonicalProfile = await realpath(candidate).catch(() => fail("profile_missing", `project profile not found: ${profileOption || DEFAULT_PROFILE}`));
  if (!pathInside(canonicalRepo, canonicalProfile)) fail("profile_invalid", "project profile must be inside the repository");
  const info = await lstat(canonicalProfile);
  if (!info.isFile() || info.isSymbolicLink()) fail("profile_invalid", "project profile must be a regular file");
  return {
    absolute: canonicalProfile,
    relative: relative(canonicalRepo, canonicalProfile).replaceAll("\\", "/"),
  };
}

function parseProfile(text) {
  try {
    return JSON.parse(text);
  } catch {
    fail("profile_invalid", "project profile is not valid JSON");
  }
}

function refExists(repoRoot, ref) {
  return git(repoRoot, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true }).ok;
}

function treePathExists(repoRoot, baseSha, path) {
  return git(repoRoot, ["cat-file", "-e", `${baseSha}:${path}`], { allowFailure: true }).ok;
}

function resolveBase(repoRoot, delivery, explicitBase, shouldFetch) {
  git(repoRoot, ["check-ref-format", `refs/heads/${delivery.baseBranch}`]);
  if (shouldFetch) fetchBase(repoRoot, delivery.remote, delivery.baseBranch);
  if (explicitBase !== undefined && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(explicitBase)) fail("base_invalid", "--base must be an immutable 40- or 64-character lowercase commit ID");
  const source = explicitBase || `refs/remotes/${delivery.remote}/${delivery.baseBranch}`;
  const baseSha = git(repoRoot, ["rev-parse", "--verify", `${source}^{commit}`]).stdout;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseSha)) fail("base_invalid", "resolved base is not an immutable commit ID");
  return { baseSha, baseRef: `${delivery.remote}/${delivery.baseBranch}` };
}

async function worktreeRoot(repoRoot, configuredRoot) {
  const candidate = resolve(repoRoot, configuredRoot);
  await mkdir(candidate, { recursive: true });
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("worktree_root_invalid", "delivery worktree root must be a real directory");
  const canonical = await realpath(candidate);
  if (pathInside(repoRoot, canonical)) fail("worktree_root_invalid", "delivery worktree root must be outside the repository");
  return canonical;
}

async function commonGitDirectory(repoRoot) {
  const value = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
  return realpath(resolve(repoRoot, value));
}

async function reserveLease(repoRoot, payload) {
  const commonDir = await commonGitDirectory(repoRoot);
  const leaseDir = join(commonDir, "pi-delivery-leases");
  await mkdir(leaseDir, { recursive: true });
  const leasePath = join(leaseDir, `${pathKey(payload.worktreePath)}.json`);
  const token = randomBytes(24).toString("hex");
  const lease = { format: "pi-sampler.delivery-worktree-lease", version: FORMAT_VERSION, token, createdAt: new Date().toISOString(), ...payload };
  await writeFile(leasePath, `${JSON.stringify(lease)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error) => {
    if (error.code === "EEXIST") fail("lease_conflict", "the generated worktree already has a writer lease");
    throw error;
  });
  return { leasePath, lease };
}

function registeredWorktrees(repoRoot) {
  return git(repoRoot, ["worktree", "list", "--porcelain"]).stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
}

function samePath(left, right) {
  const a = process.platform === "win32" ? resolve(left).toLowerCase() : resolve(left);
  const b = process.platform === "win32" ? resolve(right).toLowerCase() : resolve(right);
  return a === b;
}

function worktreeIsRegistered(repoRoot, worktreePath) {
  return registeredWorktrees(repoRoot).some((candidate) => samePath(candidate, worktreePath));
}

async function rollbackPrepared(repoRoot, worktreePath, branch, leasePath, baseSha) {
  const actualPath = await realpath(worktreePath).catch(() => undefined);
  if (!actualPath || !worktreeIsRegistered(repoRoot, actualPath)) fail("rollback_ownership_lost", `rollback retained recovery state at ${worktreePath}`);
  const actualBranch = git(actualPath, ["branch", "--show-current"], { allowFailure: true });
  const actualHead = git(actualPath, ["rev-parse", "HEAD"], { allowFailure: true });
  if (!actualBranch.ok || !actualHead.ok || actualBranch.stdout !== branch || actualHead.stdout !== baseSha) fail("rollback_ownership_lost", `rollback retained recovery state at ${worktreePath}`);

  const removed = git(repoRoot, ["worktree", "remove", "--force", actualPath], { allowFailure: true });
  if (!removed.ok || worktreeIsRegistered(repoRoot, actualPath)) fail("rollback_failed", `rollback retained recovery state at ${worktreePath}`);
  const branchRef = git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`], { allowFailure: true });
  if (branchRef.ok) {
    if (branchRef.stdout !== baseSha) fail("rollback_ownership_lost", `rollback retained branch ${branch}`);
    const deleted = git(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`, baseSha], { allowFailure: true });
    if (!deleted.ok) fail("rollback_ownership_lost", `rollback retained concurrently changed branch ${branch}`);
  }
  if (leasePath) await rm(leasePath, { force: true });
}

export async function prepareDeliveryWorktree(options) {
  if (typeof options.workItem !== "string" || options.workItem.length > 64 || !/^[A-Za-z0-9-]+$/.test(options.workItem)) fail("work_item_invalid", "--work-item is required and must be a bounded identifier");
  const workItem = options.workItem.toUpperCase();
  const repoRoot = await canonicalRepository(options.repo);
  const profilePath = await profileLocation(repoRoot, options.profile);
  const checkoutHead = git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout;
  if (!treePathExists(repoRoot, checkoutHead, profilePath.relative)) fail("checkout_profile_missing", `checkout HEAD does not contain ${profilePath.relative}`);
  const checkoutProfile = validateProfile(parseProfile(git(repoRoot, ["show", `${checkoutHead}:${profilePath.relative}`]).stdout), workItem);
  const initialDelivery = checkoutProfile.delivery;
  const { baseSha, baseRef } = resolveBase(repoRoot, initialDelivery, options.base || process.env.PI_DELIVERY_BASE_SHA, options.fetch !== false);
  if (!treePathExists(repoRoot, baseSha, profilePath.relative)) fail("base_profile_missing", `base ${baseSha} does not contain ${profilePath.relative}`);
  const baseProfile = validateProfile(parseProfile(git(repoRoot, ["show", `${baseSha}:${profilePath.relative}`]).stdout), workItem);
  if (JSON.stringify(baseProfile.delivery) !== JSON.stringify(initialDelivery)) fail("profile_drift", "delivery configuration differs between the checkout and selected base");

  const delivery = baseProfile.delivery;
  const root = await worktreeRoot(repoRoot, delivery.worktreeRoot);
  const slug = slugify(options.slug);
  const specificationRoot = normalizeGitPath(baseProfile.governance.paths.specification, "governance.paths.specification");
  const planPath = `${specificationRoot}/${workItem}-implementation-plan.md`;
  const hasPlan = treePathExists(repoRoot, baseSha, planPath);
  const branchStem = `${delivery.branchPrefix}/${workItem.toLowerCase()}-${slug}`;

  let branch;
  let target;
  let created = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const suffix = options.suffixSource ? options.suffixSource(delivery.suffixLength, attempt) : randomSuffix(delivery.suffixLength);
    if (typeof suffix !== "string" || !new RegExp(`^[a-f0-9]{${delivery.suffixLength}}$`).test(suffix)) fail("suffix_invalid", "generated delivery suffix is invalid");
    const candidateBranch = `${branchStem}-${suffix}`;
    const candidateTarget = join(root, `${workItem}-${suffix}`);
    const branchValid = git(repoRoot, ["check-ref-format", "--branch", candidateBranch], { allowFailure: true }).ok;
    const pathAvailable = await lstat(candidateTarget).then(() => false, (error) => error.code === "ENOENT" ? true : Promise.reject(error));
    if (!branchValid || !pathAvailable || refExists(repoRoot, `refs/heads/${candidateBranch}`)) continue;
    if (options.beforeAdd) await options.beforeAdd({ attempt, repoRoot, branch: candidateBranch, worktreePath: candidateTarget, baseSha });
    const added = git(repoRoot, ["worktree", "add", "-b", candidateBranch, candidateTarget, baseSha], { allowFailure: true });
    if (!added.ok) {
      const racedPath = await lstat(candidateTarget).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error));
      if (racedPath || refExists(repoRoot, `refs/heads/${candidateBranch}`)) continue;
      const summary = (added.stderr || added.stdout || "git worktree add failed").split(/\r?\n/, 1)[0];
      fail("git_worktree_add_failed", summary);
    }
    branch = candidateBranch;
    target = candidateTarget;
    created = true;
    break;
  }
  if (!created || !branch || !target) fail("name_exhausted", "could not allocate a unique delivery worktree name");

  let leasePath;
  try {
    const canonicalTarget = await realpath(target);
    const reservation = await reserveLease(repoRoot, {
      projectId: baseProfile.projectId,
      workItem,
      repositoryRoot: repoRoot,
      worktreePath: canonicalTarget,
      branch,
      baseRef,
      baseSha,
    });
    leasePath = reservation.leasePath;
    const status = git(canonicalTarget, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
    const actualHead = git(canonicalTarget, ["rev-parse", "HEAD"]).stdout;
    const actualBranch = git(canonicalTarget, ["branch", "--show-current"]).stdout;
    if (status || actualHead !== baseSha || actualBranch !== branch) fail("postcondition_failed", "prepared worktree identity is not clean and exact");
    return {
      format: "pi-sampler.delivery-worktree",
      version: FORMAT_VERSION,
      projectId: baseProfile.projectId,
      workItem,
      repositoryRoot: repoRoot,
      worktreePath: canonicalTarget,
      branch,
      baseRef,
      baseSha,
      profilePath: profilePath.relative,
      planPath: hasPlan ? planPath : null,
      leaseId: pathKey(canonicalTarget),
      leaseToken: reservation.lease.token,
    };
  } catch (error) {
    try {
      await rollbackPrepared(repoRoot, target, branch, leasePath, baseSha);
    } catch (rollbackError) {
      throw new DeliveryWorktreeError(rollbackError.code || "rollback_failed", `${error.message}; ${rollbackError.message}`);
    }
    throw error;
  }
}

function equalToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function cleanupDeliveryWorktree(options) {
  if (typeof options.worktree !== "string" || typeof options.lease !== "string") fail("usage", "cleanup requires --worktree and --lease");
  const repoRoot = await canonicalRepository(options.repo);
  const requested = resolve(options.worktree);
  const canonicalTarget = await realpath(requested).catch(() => fail("worktree_missing", "delivery worktree does not exist"));
  const commonDir = await commonGitDirectory(repoRoot);
  const leasePath = join(commonDir, "pi-delivery-leases", `${pathKey(canonicalTarget)}.json`);
  const lease = parseProfile(await readFile(leasePath, "utf8").catch(() => fail("lease_missing", "delivery worktree lease does not exist")));
  if (lease.format !== "pi-sampler.delivery-worktree-lease" || lease.version !== FORMAT_VERSION || !equalToken(lease.token, options.lease)) fail("lease_invalid", "delivery worktree lease is invalid");
  if (resolve(lease.repositoryRoot) !== resolve(repoRoot) || resolve(lease.worktreePath) !== resolve(canonicalTarget)) fail("lease_invalid", "delivery worktree lease identity does not match");

  const status = git(canonicalTarget, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
  if (status) fail("worktree_dirty", "refusing to remove a dirty delivery worktree");
  const branch = git(canonicalTarget, ["branch", "--show-current"]).stdout;
  const head = git(canonicalTarget, ["rev-parse", "HEAD"]).stdout;
  if (branch !== lease.branch) fail("identity_changed", "delivery worktree branch changed unexpectedly");

  if (options.deleteBranch) {
    if (options.fetch !== false) fetchBase(repoRoot, lease.baseRef.split("/", 1)[0], lease.baseRef.slice(lease.baseRef.indexOf("/") + 1));
    const currentBase = git(repoRoot, ["rev-parse", "--verify", `${lease.baseRef}^{commit}`]).stdout;
    const merged = head === lease.baseSha || git(repoRoot, ["merge-base", "--is-ancestor", head, currentBase], { allowFailure: true }).ok;
    if (!merged) fail("branch_unmerged", "refusing to delete an unmerged delivery branch");
  }

  const removed = git(repoRoot, ["worktree", "remove", "--force", canonicalTarget], { allowFailure: true });
  const stillRegistered = worktreeIsRegistered(repoRoot, canonicalTarget);
  if (!removed.ok && stillRegistered) fail("cleanup_failed", "Git refused to remove the delivery worktree; its lease and files were retained");
  if (stillRegistered) fail("cleanup_failed", "delivery worktree remains registered after cleanup");
  if (!removed.ok) {
    // Git accepted the administrative removal but Windows could not unlink an
    // ignored long-path artifact. Only the now-unregistered orphan is removed.
    await rm(canonicalTarget, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  if (options.deleteBranch) {
    if (options.beforeBranchDelete) await options.beforeBranchDelete({ repoRoot, branch, expectedHead: head });
    const deleted = git(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`, head], { allowFailure: true });
    if (!deleted.ok) {
      await rm(leasePath, { force: true });
      fail("branch_changed", `delivery worktree was removed but concurrently changed branch ${branch} was retained`);
    }
  }
  await rm(leasePath, { force: true });
  return {
    format: "pi-sampler.delivery-worktree-cleanup",
    version: FORMAT_VERSION,
    worktreePath: canonicalTarget,
    branch,
    head,
    branchDeleted: options.deleteBranch,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const result = command === "prepare" ? await prepareDeliveryWorktree(options) : await cleanupDeliveryWorktree(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const code = error instanceof DeliveryWorktreeError ? error.code : "unexpected";
    process.stderr.write(`delivery-worktree:${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
