#!/usr/bin/env node
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { commonGitDirectory, pathInside, pathKey } from "./delivery-worktree.mjs";
import {
  DISPOSABLE_TOP_LEVEL, FORMAT_VERSION, HEX_COMMIT, LEASE_FORMAT, MAX_ATTEMPTS, MAX_SCAN_DEPTH,
  MAX_STATUS_BYTES, ReviewWorkspaceError, WORKSPACE_FORMAT,
  acquireCapacityLock, acquireFileLock, acquireOperationLock, abortLease, bounded, bytesEqual,
  capacityLockFileFor, collapseStatusRecords, disposablePath, digest, ensureDirectoryNoSymlinks,
  fail, fileDigest, git, gitDirectory, leaseDirectory, leaseFileFor, listLeaseFiles,
  listTree, loadContext, lockFileFor, lockFiles, locateLease, locateLeaseByToken,
  measureDirectory, objectAlternates, objectIsolation, parseStatus, pathBytes, randomHex,
  readLease, readRegularFile, regularLstat, replaceLease, samePath, safeName, stableJson,
  tokenEqual, unexpectedGitTopLevelEntries, writeNewLease,
} from "./review-workspace-support.mjs";
export { ReviewWorkspaceError };

async function inspectWorkspacePath(workspacePath, lease, review, { expectedPath = workspacePath } = {}) {
  const findings = [];
  const add = (code, message, details = {}) => findings.push({ ...details, code, message });
  const pathInfo = await lstat(workspacePath).catch((error) => {
    add("workspace_missing", error.message);
    return undefined;
  });
  if (!pathInfo) return { safeForQuarantine: false, findings };
  if (pathInfo.isSymbolicLink() || !pathInfo.isDirectory()) add("workspace_path_unsafe", "workspace is not a real directory");
  const canonical = await realpath(workspacePath).catch(() => undefined);
  if (!canonical || !samePath(canonical, expectedPath) || !samePath(canonical, workspacePath)) add("workspace_path_changed", "workspace path is not the leased directory");
  if (!samePath(lease.currentPath, canonical || workspacePath)) add("lease_path_mismatch", "workspace path does not match the current lease");
  if (findings.some(({ code }) => code === "workspace_path_unsafe" || code === "workspace_path_changed")) return { safeForQuarantine: false, findings };

  let gitDir;
  try {
    gitDir = await gitDirectory(workspacePath);
  } catch (error) {
    add(error.code || "workspace_invalid", error.message);
    return { safeForQuarantine: false, findings };
  }
  const expectedGitDir = join(workspacePath, ".git");
  if (!samePath(gitDir, expectedGitDir)) add("git_directory_changed", "workspace Git directory is not local to the clone");
  const configPath = join(gitDir, "config");
  const configInfo = await lstat(configPath).catch(() => undefined);
  if (!configInfo || configInfo.isSymbolicLink() || !configInfo.isFile()) add("git_config_unsafe", "workspace Git config is not a regular file");
  const configDigest = configInfo && !configInfo.isSymbolicLink() && configInfo.isFile() ? await fileDigest(configPath) : undefined;
  if (lease.configDigest && configDigest !== lease.configDigest) add("git_config_changed", "workspace Git config changed after provisioning");

  const headResult = git(workspacePath, ["rev-parse", "--verify", "HEAD^{commit}"], { allowFailure: true, maxBuffer: 256 });
  if (!headResult.ok || headResult.stdout.trim() !== lease.head) add("head_changed", "workspace is not detached at the leased exact candidate head", { actual: headResult.stdout.trim() });
  const symbolic = git(workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true, maxBuffer: 256 });
  if (symbolic.ok && symbolic.stdout.trim()) add("symbolic_head", "workspace HEAD is attached to a branch", { branch: symbolic.stdout.trim() });
  const branches = git(workspacePath, ["for-each-ref", "--format=%(refname)", "refs/heads"], { allowFailure: true, maxBuffer: 4096 });
  if (!branches.ok || branches.stdout.trim()) add("candidate_branch_present", "review clone contains a local candidate branch", { refs: branches.stdout.trim() });
  const remotes = git(workspacePath, ["remote"], { allowFailure: true, maxBuffer: 4096 });
  if (!remotes.ok || remotes.stdout.trim()) add("publication_remote_present", "review clone has a remote or remote lookup failed", { remotes: remotes.stdout.trim() });
  const trackingRefs = git(workspacePath, ["for-each-ref", "--format=%(refname)", "refs/remotes"], { allowFailure: true, maxBuffer: 4096 });
  if (!trackingRefs.ok || trackingRefs.stdout.trim()) add("remote_tracking_ref_present", "review clone has a remote-tracking candidate ref", { refs: trackingRefs.stdout.trim() });
  const pushUrls = git(workspacePath, ["config", "--local", "--get-regexp", "^(remote\\..*\\.(pushurl|url)|remote\\.pushDefault)$"], { allowFailure: true, maxBuffer: 4096 });
  if (pushUrls.ok && pushUrls.stdout.trim()) add("push_configuration_present", "review clone has a publication URL", { values: pushUrls.stdout.trim() });
  const identities = git(workspacePath, ["config", "--local", "--get-regexp", "^user\\.(name|email)$"], { allowFailure: true, maxBuffer: 4096 });
  if (identities.ok && identities.stdout.trim()) add("reviewer_identity_present", "review clone has a local Git author identity");
  const useConfigOnly = git(workspacePath, ["config", "--local", "--get", "user.useConfigOnly"], { allowFailure: true, maxBuffer: 256 });
  if (!useConfigOnly.ok || useConfigOnly.stdout.trim() !== "true") add("identity_policy_missing", "review clone does not require explicit command-local identity");
  for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const effectiveIdentity = git(workspacePath, ["var", variable], { allowFailure: true, maxBuffer: 4096 });
    if (effectiveIdentity.ok) add("effective_reviewer_identity_present", "review clone can resolve a Git author identity without command-local configuration", { variable });
  }
  const hooksPath = git(workspacePath, ["config", "--local", "--get", "core.hooksPath"], { allowFailure: true, maxBuffer: 4096 });
  const disabledHooks = join(workspacePath, ".git", "review-disabled-hooks");
  if (!hooksPath.ok || hooksPath.stdout.trim() !== ".git/review-disabled-hooks") add("hooks_policy_missing", "review clone does not use its disabled hook directory");
  const hooksInfo = await lstat(disabledHooks).catch(() => undefined);
  if (!hooksInfo || hooksInfo.isSymbolicLink() || !hooksInfo.isDirectory()) add("hooks_path_unsafe", "disabled hook directory is missing or unsafe");
  else {
    const hookEntries = await readdir(disabledHooks, { withFileTypes: true }).catch(() => []);
    if (hookEntries.length) add("active_hook_present", "disabled hook directory is not empty");
  }
  if (lease.sourceGitDir) {
    const isolationFindings = await objectIsolation(lease.sourceGitDir, gitDir);
    for (const item of isolationFindings) add(item.code, item.code, item);
  } else {
    add("source_git_directory_missing", "review lease does not bind the source Git directory");
  }
  const alternates = await objectAlternates(gitDir);
  for (const item of alternates) add(item.code, item.code, item);

  const statusResult = git(workspacePath, ["status", "--porcelain=v1", "--no-renames", "--untracked-files=all", "--ignored=matching", "-z"], { allowFailure: true, maxBuffer: MAX_STATUS_BYTES });
  const status = statusResult.ok ? parseStatus(statusResult.stdout) : { error: statusResult.stderr || "Git status failed" };
  const records = status.records || [];
  if (status.error) add("status_unavailable", status.error);
  const trackedChanges = records.filter(({ code }) => code !== "??" && code !== "!!");
  const untracked = records.filter(({ code }) => code === "??");
  const ignored = records.filter(({ code }) => code === "!!");
  for (const record of trackedChanges) add("tracked_content_changed", "tracked candidate content changed", record);
  const disposableRecords = collapseStatusRecords([...untracked, ...ignored]);
  const unexpected = disposableRecords.filter(({ path: filePath }) => !disposablePath(filePath));
  for (const record of unexpected) add("unexpected_disposable_content", "untracked or ignored content is outside the exact disposable allowlist", record);
  let untrackedBytes = 0;
  let untrackedEntries = 0;
  for (const record of disposableRecords) {
    const measured = await pathBytes(workspacePath, record.path, {
      maxEntries: review.limits.maxUntrackedEntries + 1,
      maxBytes: review.limits.maxUntrackedBytes + 1,
    });
    if (measured.unsafe) add("disposable_path_unsafe", "disposable content contains unsafe filesystem entries", record);
    untrackedBytes += measured.bytes;
    untrackedEntries += measured.entries;
  }
  if (untrackedEntries > review.limits.maxUntrackedEntries) add("untracked_limit_exceeded", "workspace disposable content exceeds the configured filesystem-entry limit", { entries: untrackedEntries });
  if (untrackedBytes > review.limits.maxUntrackedBytes) add("untracked_bytes_limit_exceeded", "workspace disposable content exceeds the configured byte limit", { bytes: untrackedBytes });

  const tree = await listTree(workspacePath, { skipGit: true });
  for (const item of tree.findings) add(item.code, item.code, item);
  for (const alias of tree.caseAliases) add("case_alias", "filesystem contains case aliases", alias);
  const gitTree = await listTree(gitDir, { skipGit: false });
  for (const item of gitTree.findings) add("git_storage_unsafe", item.code, item);
  for (const item of await unexpectedGitTopLevelEntries(gitDir)) add(item.code, item.code, item);
  const locks = await lockFiles(gitDir);
  for (const item of locks.findings) add("git_storage_unsafe", item.code, item);
  for (const lock of locks.locks) add("git_lock_present", "Git lock is present", { path: lock });
  const gitLinks = git(workspacePath, ["ls-files", "--stage"], { allowFailure: true, maxBuffer: MAX_STATUS_BYTES });
  if (gitLinks.ok && gitLinks.stdout.split(/\r?\n/).some((line) => line.startsWith("160000 "))) add("nested_repository", "candidate contains a tracked gitlink");

  const totalBytes = tree.bytes + gitTree.bytes;
  if (totalBytes > review.limits.maxWorkspaceBytes) add("workspace_bytes_limit_exceeded", "review workspace exceeds the configured byte limit", { bytes: totalBytes });
  return {
    format: "pi-sampler.review-workspace-inspection",
    version: FORMAT_VERSION,
    workspacePath: canonical,
    head: headResult.stdout.trim(),
    detached: !symbolic.ok || !symbolic.stdout.trim(),
    configDigest,
    status: { trackedChanges, untracked, ignored, untrackedBytes, untrackedEntries, totalBytes, entries: tree.entries + gitTree.entries },
    safeForQuarantine: findings.length === 0,
    findings,
  };
}

function directChild(root, target) {
  const child = relative(root, target).split(sep).filter(Boolean);
  return pathInside(root, target) && child.length === 1;
}

function validateTransitionBoundary(context, transition) {
  if (transition.kind === "quarantine") {
    if (!directChild(context.workspaceRoot, transition.fromPath) || !directChild(context.quarantineRoot, transition.toPath)) fail("lease_invalid", "quarantine rename transition escapes its approved direct-child roots");
  } else if (transition.kind === "delete") {
    if (!directChild(context.quarantineRoot, transition.fromPath) || !directChild(context.quarantineRoot, transition.toPath)) fail("lease_invalid", "deletion rename transition escapes its approved direct-child quarantine root");
  }
}

async function existingTransitionPath(target, label) {
  const info = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    fail("rename_uncertain", `${label} could not be checked: ${error.message}`);
  });
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isDirectory()) fail("rename_uncertain", `${label} is not a real directory`);
  const canonical = await realpath(target).catch((error) => fail("rename_uncertain", `${label} could not be resolved: ${error.message}`));
  if (!samePath(canonical, target)) fail("rename_uncertain", `${label} was replaced by an alias or reparse point`);
  return info;
}

async function verifyLeaseContext(context, lease, leasePath = undefined, leaseRoot = undefined) {
  if (leasePath && leaseRoot && !samePath(leasePath, leaseFileFor(leaseRoot, lease.workspacePath))) fail("lease_invalid", "review lease file is not bound to its workspace identity");
  if (lease.projectId !== context.profile.projectId) fail("lease_invalid", "review lease project identity does not match the approved profile");
  if (lease.profileDigest !== context.profileDigest) fail("profile_drift", "review lease is bound to a different approved profile");
  const repositoryRoot = await realpath(context.repositoryRoot);
  if (!samePath(lease.repositoryRoot, repositoryRoot)) fail("lease_invalid", "review lease repository identity does not match");
  const sourceGitDir = await commonGitDirectory(repositoryRoot);
  if (typeof lease.sourceGitDir !== "string" || !samePath(lease.sourceGitDir, sourceGitDir)) fail("lease_invalid", "review lease source Git directory identity does not match");
  if (!directChild(context.workspaceRoot, lease.workspacePath)) fail("lease_invalid", "review workspace path escapes the approved direct-child workspace root");
  if (lease.quarantinePath !== null && lease.quarantinePath !== undefined && !directChild(context.quarantineRoot, lease.quarantinePath)) fail("lease_invalid", "review quarantine path escapes the approved direct-child quarantine root");
  if (lease.previousPath !== undefined && !directChild(context.quarantineRoot, lease.previousPath)) fail("lease_invalid", "review previous quarantine path escapes the approved direct-child quarantine root");
  if (lease.removalPath !== undefined && !directChild(context.quarantineRoot, lease.removalPath)) fail("lease_invalid", "review removal path escapes the approved direct-child quarantine root");
  const currentRoot = ["quarantining", "preparing", "active", "aborted"].includes(lease.state) ? context.workspaceRoot : context.quarantineRoot;
  if (!directChild(currentRoot, lease.currentPath)) fail("lease_invalid", "review lease current path escapes its approved root");
  if (lease.transition) validateTransitionBoundary(context, lease.transition);
}

async function activeWorkspaceCount(leaseRoot) {
  const leases = await listLeaseFiles(leaseRoot);
  return leases.filter(({ lease }) => lease.state === "preparing" || lease.state === "active" || lease.state === "quarantining").length;
}

async function reconcileRenameTransition(context, record) {
  const { leasePath, lease, bytes } = record;
  if (!lease.transition) return record;
  validateTransitionBoundary(context, lease.transition);
  const fromInfo = await existingTransitionPath(lease.transition.fromPath, "rename source");
  const toInfo = await existingTransitionPath(lease.transition.toPath, "rename destination");
  if (fromInfo && toInfo) fail("rename_uncertain", "both sides of the interrupted rename exist; preserving both paths");
  if (lease.transition.kind === "delete" && lease.removalPath !== undefined) {
    const removalInfo = await existingTransitionPath(lease.removalPath, "removal workspace");
    if (removalInfo && (fromInfo || toInfo)) fail("rename_uncertain", "removal and deletion transition paths both exist; preserving all paths");
    if (removalInfo) {
      const { transition: _transition, ...withoutTransition } = lease;
      const moved = {
        ...withoutTransition,
        state: "deleting",
        currentPath: lease.removalPath,
        quarantinePath: lease.removalPath,
        deletionPath: lease.removalPath,
        recoveredAt: new Date().toISOString(),
      };
      const nextBytes = await replaceLease(leasePath, bytes, moved);
      return { leasePath, lease: moved, bytes: nextBytes, canonicalPath: moved.currentPath };
    }
  }
  if (!fromInfo && !toInfo) fail("rename_uncertain", "neither side of the interrupted rename exists; preserving the lease record");

  const { transition: _transition, ...withoutTransition } = lease;
  if (lease.transition.kind === "quarantine") {
    if (fromInfo) {
      const restored = {
        ...withoutTransition,
        state: "active",
        currentPath: lease.transition.fromPath,
        quarantinePath: null,
        recoveredAt: new Date().toISOString(),
      };
      const nextBytes = await replaceLease(leasePath, bytes, restored);
      return { leasePath, lease: restored, bytes: nextBytes, canonicalPath: restored.currentPath };
    }
    const movedLease = { ...lease, currentPath: lease.transition.toPath, quarantinePath: lease.transition.toPath };
    const inspection = await inspectWorkspacePath(lease.transition.toPath, movedLease, context.review, { expectedPath: lease.transition.toPath });
    const quarantined = {
      ...withoutTransition,
      state: "quarantined",
      currentPath: lease.transition.toPath,
      quarantinePath: lease.transition.toPath,
      quarantinedAt: lease.quarantinedAt || new Date().toISOString(),
      quarantineInspection: { safeForQuarantine: inspection.safeForQuarantine, findings: inspection.findings },
      recoveredAt: new Date().toISOString(),
    };
    const nextBytes = await replaceLease(leasePath, bytes, quarantined);
    return { leasePath, lease: quarantined, bytes: nextBytes, canonicalPath: quarantined.currentPath };
  }

  if (fromInfo) {
    const restored = {
      ...withoutTransition,
      state: "quarantined",
      currentPath: lease.transition.fromPath,
      quarantinePath: lease.transition.fromPath,
      recoveredAt: new Date().toISOString(),
    };
    delete restored.deletionPath;
    const nextBytes = await replaceLease(leasePath, bytes, restored);
    return { leasePath, lease: restored, bytes: nextBytes, canonicalPath: restored.currentPath };
  }
  const resumed = {
    ...lease,
    state: "deleting",
    currentPath: lease.transition.toPath,
    quarantinePath: lease.transition.toPath,
    previousPath: lease.transition.fromPath,
    deletionPath: lease.transition.toPath,
    recoveredAt: new Date().toISOString(),
  };
  const nextBytes = await replaceLease(leasePath, bytes, resumed);
  return { leasePath, lease: resumed, bytes: nextBytes, canonicalPath: resumed.currentPath };
}

async function reserveWorkspace(context, target, options) {
  const leaseRoot = await leaseDirectory(context.repositoryRoot);
  const leasePath = leaseFileFor(leaseRoot, target);
  const lease = {
    format: LEASE_FORMAT,
    version: FORMAT_VERSION,
    token: randomHex(48),
    nonce: randomHex(32),
    projectId: context.profile.projectId,
    repositoryRoot: context.repositoryRoot,
    repositorySource: context.profile.repository.source,
    profilePath: context.profilePath.relative,
    profileDigest: context.profileDigest,
    workspacePath: target,
    currentPath: target,
    quarantinePath: null,
    state: "preparing",
    head: context.head,
    owner: options.owner || "opaque-review-run",
    runClass: options.runClass || "review",
    createdAt: new Date().toISOString(),
    remotePolicy: "none",
    sourceGitDir: await commonGitDirectory(context.repositoryRoot),
  };
  bounded(lease.owner, "owner", 128);
  bounded(lease.runClass, "runClass", 64);
  const bytes = await writeNewLease(leasePath, lease);
  return { leaseRoot, leasePath, lease, bytes };
}

async function rollbackPreparation({ leasePath, leaseBytes, target }) {
  const info = await lstat(target).catch(() => undefined);
  if (info) fail("rollback_retained", `preparation failed; uncertain review workspace retained at ${target}`);
  await abortLease(leasePath, leaseBytes, target);
}

function workspaceName(options, head, suffix) {
  const base = options.workItem ? String(options.workItem).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : `review-${head.slice(0, 12)}`;
  const slug = options.slug ? String(options.slug).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) : "";
  const stem = `${base}${slug ? `-${slug}` : ""}`.slice(0, 76).replace(/-+$/g, "");
  return safeName(`${stem}-${suffix}`, "review workspace name");
}

export async function prepareReviewWorkspace(options = {}) {
  const context = await loadContext(options, { requireHead: true });
  if (context.review.remotePolicy !== "none") fail("profile_invalid", "review remote policy must deny publication");
  const leaseRoot = await leaseDirectory(context.repositoryRoot);
  let lastCollision;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const suffix = options.suffixSource ? options.suffixSource(6, attempt) : randomHex(6);
    if (typeof suffix !== "string" || !/^[a-f0-9]{6}$/.test(suffix)) fail("suffix_invalid", "review suffix must be six lowercase hexadecimal characters");
    const target = join(context.workspaceRoot, workspaceName(options, context.head, suffix));
    const leasePath = leaseFileFor(leaseRoot, target);
    if (options.beforeReserve) await options.beforeReserve({ attempt, target, repositoryRoot: context.repositoryRoot, head: context.head });
    let reservation;
    const releaseCapacity = await acquireCapacityLock(leaseRoot);
    try {
      if (await activeWorkspaceCount(leaseRoot) >= context.review.limits.maxWorkspaces) fail("resource_limit", "configured active review workspace limit is exhausted");
      if (await lstat(target).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))) {
        lastCollision = "workspace path exists";
        continue;
      }
      if (await lstat(leasePath).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))) {
        lastCollision = "workspace lease exists";
        continue;
      }
      reservation = await reserveWorkspace(context, target, options);
    } catch (error) {
      if (error.code === "lease_conflict" || error.code === "EEXIST") {
        lastCollision = error.message;
        continue;
      }
      throw error;
    } finally {
      await releaseCapacity();
    }
    try {
      git(context.repositoryRoot, ["clone", "--no-hardlinks", "--no-local", "--no-checkout", "--", context.repositoryRoot, target], { maxBuffer: MAX_STATUS_BYTES });
      const targetInfo = await lstat(target);
      if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory() || !samePath(await realpath(target), target)) fail("workspace_path_changed", "clone target was replaced during preparation");
      const sourceLocalRefs = git(target, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], { allowFailure: true, maxBuffer: 4096 }).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      git(target, ["checkout", "--detach", "--force", context.head], { maxBuffer: MAX_STATUS_BYTES });
      const remoteList = git(target, ["remote"], { allowFailure: true, maxBuffer: 4096 }).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const remote of remoteList) git(target, ["remote", "remove", remote], { allowFailure: true, maxBuffer: 4096 });
      for (const record of sourceLocalRefs) {
        const match = /^(refs\/heads\/[A-Za-z0-9._/-]+) ([a-f0-9]{40}(?:[a-f0-9]{24})?)$/.exec(record);
        if (!match) fail("workspace_invalid", "clone returned an unsafe local branch ref");
        const deleted = git(target, ["update-ref", "-d", match[1], match[2]], { allowFailure: true, maxBuffer: 4096 });
        if (!deleted.ok) fail("workspace_invalid", "clone local branch changed before it could be removed");
      }
      const targetGitDir = await gitDirectory(target);
      const hooksPath = join(targetGitDir, "review-disabled-hooks");
      await ensureDirectoryNoSymlinks(hooksPath, "review disabled hook directory");
      git(target, ["config", "--local", "core.hooksPath", ".git/review-disabled-hooks"], { maxBuffer: 4096 });
      git(target, ["config", "--local", "user.useConfigOnly", "true"], { maxBuffer: 4096 });
      for (const key of ["user.name", "user.email", "remote.pushDefault", "remote.origin.pushurl"]) git(target, ["config", "--local", "--unset-all", key], { allowFailure: true, maxBuffer: 4096 });
      const sourceGitDir = await commonGitDirectory(context.repositoryRoot);
      const isolationFindings = await objectIsolation(sourceGitDir, targetGitDir);
      if (isolationFindings.length) fail("object_storage_not_isolated", "review clone does not have independent object storage", { findings: isolationFindings });
      const inspection = await inspectWorkspacePath(target, { ...reservation.lease, configDigest: await fileDigest(join(targetGitDir, "config")), sourceGitDir }, context.review);
      if (!inspection.safeForQuarantine) fail("postcondition_failed", "prepared review workspace failed its isolation or cleanliness checks", { findings: inspection.findings });
      const activeLease = {
        ...reservation.lease,
        state: "active",
        currentPath: target,
        sourceGitDir,
        gitDirRelative: ".git",
        configDigest: inspection.configDigest,
        objectIsolation: "independent",
        activatedAt: new Date().toISOString(),
      };
      const activeBytes = await replaceLease(reservation.leasePath, reservation.bytes, activeLease);
      return {
        format: WORKSPACE_FORMAT,
        version: FORMAT_VERSION,
        projectId: context.profile.projectId,
        purpose: "review",
        repositoryRoot: context.repositoryRoot,
        repositorySource: context.profile.repository.source,
        profilePath: context.profilePath.relative,
        profileDigest: context.profileDigest,
        workspaceRoot: context.workspaceRoot,
        quarantineRoot: context.quarantineRoot,
        workspacePath: target,
        worktreePath: target,
        head: context.head,
        candidateSha: context.head,
        sourceCheckoutHead: context.checkoutHead,
        baseSha: context.baseSha,
        detached: true,
        remotePolicy: "none",
        leaseId: pathKey(target),
        leaseToken: activeLease.token,
        leasePath: reservation.leasePath,
        configDigest: activeLease.configDigest,
        createdAt: activeLease.createdAt,
        activatedAt: activeLease.activatedAt,
        leaseBytesDigest: digest(activeBytes),
      };
    } catch (error) {
      try {
        await rollbackPreparation({ leasePath: reservation.leasePath, leaseBytes: reservation.bytes, target });
      } catch (rollbackError) {
        if (rollbackError instanceof ReviewWorkspaceError) throw rollbackError;
        fail("rollback_retained", `${error.message}; preparation rollback failed: ${rollbackError.message}`);
      }
      throw error;
    }
  }
  fail("name_exhausted", lastCollision || "could not allocate a unique review workspace name");
}

async function operationContext(options, requestedPath, token) {
  const context = await loadContext(options, { requireTrustedBase: true });
  const leaseRoot = await leaseDirectory(context.repositoryRoot);
  const found = await locateLeaseByToken({ leaseRoot, requestedPath, token });
  await verifyLeaseContext(context, found.lease, found.leasePath, leaseRoot);
  return { context, leaseRoot, ...found };
}

export async function inspectReviewWorkspace(options = {}) {
  const requestedPath = options.workspacePath || options.worktreePath || options.worktree || options.workspace || options.quarantinePath;
  const leaseToken = options.lease ?? options.leaseToken;
  if (typeof requestedPath !== "string") fail("argument_invalid", "inspect requires --workspace");
  if (typeof leaseToken !== "string") fail("lease_invalid", "inspect requires --lease");
  const { context, leasePath, lease, bytes, canonicalPath } = await operationContext(options, requestedPath, leaseToken);
  const inspection = await inspectWorkspacePath(canonicalPath, lease, context.review);
  return { ...inspection, leaseId: pathKey(lease.workspacePath), leaseState: lease.state, leasePath, workspacePath: canonicalPath, head: lease.head };
}

export async function quarantineReviewWorkspace(options = {}) {
  const requestedPath = options.workspacePath || options.worktreePath || options.worktree || options.workspace;
  const leaseToken = options.lease ?? options.leaseToken;
  if (typeof requestedPath !== "string") fail("argument_invalid", "quarantine requires --workspace");
  if (typeof leaseToken !== "string") fail("lease_invalid", "quarantine requires --lease");
  const { context, leaseRoot, leasePath, lease: originalLease, bytes: originalBytes } = await operationContext(options, requestedPath, leaseToken);
  const releaseLock = await acquireOperationLock(leasePath);
  try {
    let fresh = { ...(await readLease(leasePath)), leasePath };
    if (!tokenEqual(fresh.lease.token, leaseToken) || !bytesEqual(fresh.bytes, originalBytes)) fail("lease_changed", "review lease changed before quarantine");
    await verifyLeaseContext(context, fresh.lease, leasePath, leaseRoot);
    if (fresh.lease.state === "quarantining") fresh = await reconcileRenameTransition(context, fresh);
    if (fresh.lease.state === "quarantined") {
      const findings = fresh.lease.quarantineInspection?.findings || [];
      return {
        format: "pi-sampler.review-workspace-quarantine",
        version: FORMAT_VERSION,
        leaseId: pathKey(fresh.lease.workspacePath),
        leasePath,
        workspacePath: fresh.lease.workspacePath,
        quarantinePath: fresh.lease.quarantinePath,
        head: fresh.lease.head,
        retainedUntil: new Date(Date.parse(fresh.lease.quarantinedAt) + context.review.quarantineRetentionSeconds * 1000).toISOString(),
        safeForDelete: fresh.lease.quarantineInspection?.safeForQuarantine === true,
        findings,
        recovered: true,
      };
    }
    if (fresh.lease.state !== "active") fail("lease_invalid", "only an active review workspace can be quarantined");
    const workspacePath = fresh.lease.currentPath;
    const inspection = await inspectWorkspacePath(workspacePath, fresh.lease, context.review);
    if (!inspection.safeForQuarantine) fail("workspace_not_safe", "review workspace is dirty, changed, locked, or has uncertain provenance", { findings: inspection.findings });
    const quarantineBytes = await measureDirectory(context.quarantineRoot);
    if (quarantineBytes.unsafe || quarantineBytes.bytes > context.review.limits.maxQuarantineBytes) fail("resource_limit", "configured quarantine byte limit is exhausted or uncertain");
    const quarantineName = safeName(`${pathKey(fresh.lease.workspacePath)}-${fresh.lease.nonce.slice(0, 12)}`, "quarantine workspace name");
    const target = join(context.quarantineRoot, quarantineName);
    if (!directChild(context.quarantineRoot, target)) fail("quarantine_conflict", "quarantine target is outside the approved direct-child root");
    if (await lstat(target).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))) fail("quarantine_conflict", "quarantine target already exists");
    if (options.beforeRename) await options.beforeRename({ workspacePath, quarantinePath: target, leasePath, lease: fresh.lease });
    const beforeInfo = await lstat(workspacePath);
    if (beforeInfo.isSymbolicLink() || !beforeInfo.isDirectory() || !samePath(await realpath(workspacePath), workspacePath)) fail("workspace_path_changed", "workspace changed before quarantine rename");
    const transitionLease = {
      ...fresh.lease,
      state: "quarantining",
      currentPath: workspacePath,
      quarantinePath: target,
      transition: {
        kind: "quarantine",
        fromPath: workspacePath,
        toPath: target,
        startedAt: new Date().toISOString(),
      },
    };
    validateTransitionBoundary(context, transitionLease.transition);
    const transitionBytes = await replaceLease(leasePath, fresh.bytes, transitionLease);
    if (options.afterTransition) await options.afterTransition({ workspacePath, quarantinePath: target, leasePath, lease: transitionLease });
    const transitionInfo = await existingTransitionPath(workspacePath, "review workspace before quarantine rename");
    if (!transitionInfo) fail("workspace_path_changed", "review workspace disappeared before quarantine rename");
    await rename(workspacePath, target);
    if (options.afterRename) await options.afterRename({ workspacePath, quarantinePath: target, leasePath, lease: transitionLease });
    await existingTransitionPath(target, "quarantine target after rename");
    if (options.beforeLeaseUpdate) await options.beforeLeaseUpdate({ workspacePath, quarantinePath: target, leasePath, lease: transitionLease });
    const finalized = await reconcileRenameTransition(context, { leasePath, lease: transitionLease, bytes: transitionBytes });
    if (finalized.lease.state !== "quarantined") fail("rename_uncertain", "quarantine rename did not reach a recoverable quarantined state");
    const findings = finalized.lease.quarantineInspection?.findings || [];
    return {
      format: "pi-sampler.review-workspace-quarantine",
      version: FORMAT_VERSION,
      leaseId: pathKey(finalized.lease.workspacePath),
      leasePath,
      workspacePath,
      quarantinePath: finalized.lease.quarantinePath,
      head: finalized.lease.head,
      retainedUntil: new Date(Date.parse(finalized.lease.quarantinedAt) + context.review.quarantineRetentionSeconds * 1000).toISOString(),
      safeForDelete: finalized.lease.quarantineInspection?.safeForQuarantine === true,
      findings,
    };
  } finally {
    await releaseLock();
  }
}

async function authorizedFlag(options) {
  return options.confirm === true || options.authorize === true || options.authorized === true || options.authorizeDeletion === true || options.delete === true;
}

export async function cleanReviewWorkspace(options = {}) {
  if (!(await authorizedFlag(options))) fail("authorization_required", "clean requires a separate explicit deletion authorization (--confirm)");
  const leaseToken = options.lease ?? options.leaseToken;
  if (typeof leaseToken !== "string") fail("lease_invalid", "clean requires --lease");
  const requestedPath = options.quarantinePath || options.workspacePath || options.worktreePath || options.workspace;
  if (typeof requestedPath !== "string") fail("argument_invalid", "clean requires --quarantine");
  const context = await loadContext(options, { requireTrustedBase: true });
  const leaseRoot = await leaseDirectory(context.repositoryRoot);
  const found = await locateLeaseByToken({ leaseRoot, token: leaseToken, requestedPath });
  await verifyLeaseContext(context, found.lease, found.leasePath, leaseRoot);
  if (!["quarantined", "deleting"].includes(found.lease.state) || !found.lease.quarantinePath) fail("lease_invalid", "only a quarantined review workspace can be deleted");
  const quarantinedAt = Date.parse(found.lease.quarantinedAt || "");
  if (!Number.isFinite(quarantinedAt)) fail("lease_invalid", "quarantine timestamp is invalid");
  const eligibleAt = quarantinedAt + context.review.quarantineRetentionSeconds * 1000;
  if (Date.now() < eligibleAt) fail("retention_pending", `review workspace is retained until ${new Date(eligibleAt).toISOString()}`);
  const releaseLock = await acquireOperationLock(found.leasePath);
  try {
    let fresh = { ...(await readLease(found.leasePath)), leasePath: found.leasePath };
    if (!tokenEqual(fresh.lease.token, leaseToken) || !bytesEqual(fresh.bytes, found.bytes)) fail("lease_changed", "review lease changed before deletion");
    await verifyLeaseContext(context, fresh.lease, found.leasePath, leaseRoot);
    if (fresh.lease.state === "deleting" && fresh.lease.transition) fresh = await reconcileRenameTransition(context, fresh);
    if (fresh.lease.state === "deleted") return { format: "pi-sampler.review-workspace-cleanup", version: FORMAT_VERSION, leaseId: pathKey(fresh.lease.workspacePath), leasePath: found.leasePath, quarantinePath: fresh.lease.quarantinePath, head: fresh.lease.head, deleted: true, leaseState: "deleted", recovered: true };
    if (!["quarantined", "deleting"].includes(fresh.lease.state)) fail("lease_invalid", "only a quarantined review workspace can be deleted");

    if (fresh.lease.state === "deleting" && !fresh.lease.transition) {
      const existing = await existingTransitionPath(fresh.lease.currentPath, "deletion workspace");
      if (!existing) {
        const deletedLease = { ...fresh.lease, state: "deleted", deletedAt: new Date().toISOString(), recoveredAt: new Date().toISOString() };
        const deletedBytes = await replaceLease(found.leasePath, fresh.bytes, deletedLease);
        return { format: "pi-sampler.review-workspace-cleanup", version: FORMAT_VERSION, leaseId: pathKey(deletedLease.workspacePath), leasePath: found.leasePath, quarantinePath: deletedLease.quarantinePath, head: deletedLease.head, deleted: true, leaseState: "deleted", recovered: true, leaseBytesDigest: digest(deletedBytes) };
      }
    }

    let deletionPath;
    if (fresh.lease.state === "quarantined") {
      const quarantinePath = fresh.lease.currentPath;
      if (!directChild(context.quarantineRoot, quarantinePath)) fail("lease_invalid", "quarantine path is outside the configured direct-child quarantine boundary");
      const inspection = await inspectWorkspacePath(quarantinePath, fresh.lease, context.review);
      if (!inspection.safeForQuarantine) fail("workspace_not_safe", "quarantined workspace changed or contains uncertain content; preserving it", { findings: inspection.findings });
      const deletionName = safeName(`${relative(context.quarantineRoot, quarantinePath)}-deleting-${randomHex(12)}`, "deletion quarantine name");
      deletionPath = join(context.quarantineRoot, deletionName);
      if (!directChild(context.quarantineRoot, deletionPath)) fail("lease_invalid", "deletion path is outside the configured direct-child quarantine boundary");
      if (await lstat(deletionPath).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))) fail("cleanup_failed", "deletion target already exists");
      if (options.beforeDelete) await options.beforeDelete({ quarantinePath, deletionPath, leasePath: found.leasePath, lease: fresh.lease });
      const beforeInfo = await lstat(quarantinePath);
      if (beforeInfo.isSymbolicLink() || !beforeInfo.isDirectory() || !samePath(await realpath(quarantinePath), quarantinePath)) fail("workspace_path_changed", "quarantine workspace changed before deletion");
      const deletingLease = {
        ...fresh.lease,
        state: "deleting",
        currentPath: quarantinePath,
        quarantinePath,
        deletionPath,
        deletionStartedAt: new Date().toISOString(),
        transition: {
          kind: "delete",
          fromPath: quarantinePath,
          toPath: deletionPath,
          startedAt: new Date().toISOString(),
        },
      };
      validateTransitionBoundary(context, deletingLease.transition);
      const transitionBytes = await replaceLease(found.leasePath, fresh.bytes, deletingLease);
      if (options.afterTransition) await options.afterTransition({ quarantinePath, deletionPath, leasePath: found.leasePath, lease: deletingLease });
      await existingTransitionPath(quarantinePath, "quarantine workspace before deletion rename");
      await rename(quarantinePath, deletionPath);
      if (options.afterRename) await options.afterRename({ quarantinePath, deletionPath, leasePath: found.leasePath, lease: deletingLease });
      await existingTransitionPath(deletionPath, "deletion target after rename");
      if (options.beforeLeaseUpdate) await options.beforeLeaseUpdate({ quarantinePath, deletionPath, leasePath: found.leasePath, lease: deletingLease });
      fresh = await reconcileRenameTransition(context, { leasePath: found.leasePath, lease: deletingLease, bytes: transitionBytes });
    }

    if (fresh.lease.state !== "deleting") fail("rename_uncertain", "deletion did not reach a recoverable deleting state");
    deletionPath = fresh.lease.currentPath;
    let removalPath = fresh.lease.removalPath;
    if (removalPath !== undefined && !directChild(context.quarantineRoot, removalPath)) fail("lease_invalid", "removal path is outside the configured direct-child quarantine boundary");
    if (removalPath === undefined) {
      const removalName = safeName(`${relative(context.quarantineRoot, deletionPath)}-removing-${randomHex(12)}`, "removal workspace name");
      removalPath = join(context.quarantineRoot, removalName);
      if (!directChild(context.quarantineRoot, removalPath)) fail("lease_invalid", "removal path is outside the configured direct-child quarantine boundary");
    }
    const removalAlreadyMoved = samePath(removalPath, deletionPath);
    if (!removalAlreadyMoved) {
      if (await lstat(removalPath).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))) fail("cleanup_failed", "removal target already exists");
      const ownershipLease = { ...fresh.lease, removalPath, removalStartedAt: fresh.lease.removalStartedAt || new Date().toISOString() };
      const ownershipBytes = await replaceLease(found.leasePath, fresh.bytes, ownershipLease);
      fresh = { ...fresh, lease: ownershipLease, bytes: ownershipBytes };
      await existingTransitionPath(deletionPath, "deletion workspace before ownership rename");
      await rename(deletionPath, removalPath);
      if (options.afterRemovalRename) await options.afterRemovalRename({ deletionPath, removalPath, leasePath: found.leasePath, lease: ownershipLease });
      const { transition: _transition, ...withoutTransition } = fresh.lease;
      const movedLease = { ...withoutTransition, currentPath: removalPath, quarantinePath: removalPath, deletionPath: removalPath, recoveredAt: new Date().toISOString() };
      const movedBytes = await replaceLease(found.leasePath, fresh.bytes, movedLease);
      fresh = { ...fresh, lease: movedLease, bytes: movedBytes };
    }
    deletionPath = fresh.lease.currentPath;
    const movedInspection = await inspectWorkspacePath(deletionPath, fresh.lease, context.review, { expectedPath: deletionPath });
    if (!movedInspection.safeForQuarantine) fail("workspace_not_safe", "quarantined workspace changed during deletion; preserving it", { findings: movedInspection.findings, path: deletionPath });
    if (options.beforeRemove) await options.beforeRemove({ deletionPath, removalPath, leasePath: found.leasePath, lease: fresh.lease });
    const finalInspection = await inspectWorkspacePath(deletionPath, fresh.lease, context.review, { expectedPath: deletionPath });
    if (!finalInspection.safeForQuarantine) fail("workspace_not_safe", "quarantined workspace changed before removal; preserving it", { findings: finalInspection.findings, path: deletionPath });
    const leaseBeforeRemove = await readFile(found.leasePath).catch((error) => fail("lease_missing", `review lease disappeared before deletion: ${error.message}`));
    if (!bytesEqual(leaseBeforeRemove, fresh.bytes)) fail("lease_changed", "review lease changed before deletion");
    const removalLease = { ...fresh.lease, removalStartedAt: new Date().toISOString() };
    const removalBytes = await replaceLease(found.leasePath, fresh.bytes, removalLease);
    fresh = { ...fresh, lease: removalLease, bytes: removalBytes };
    await rm(deletionPath, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
    if (await lstat(deletionPath).catch(() => undefined)) fail("cleanup_failed", "Git review workspace deletion did not remove the quarantined directory");
    if (options.afterRemove) await options.afterRemove({ deletionPath, leasePath: found.leasePath, lease: fresh.lease });
    const { transition: _transition, ...withoutTransition } = fresh.lease;
    const deletedLease = { ...withoutTransition, state: "deleted", deletedAt: new Date().toISOString() };
    await replaceLease(found.leasePath, fresh.bytes, deletedLease);
    return {
      format: "pi-sampler.review-workspace-cleanup",
      version: FORMAT_VERSION,
      leaseId: pathKey(deletedLease.workspacePath),
      leasePath: found.leasePath,
      quarantinePath: deletedLease.quarantinePath,
      head: deletedLease.head,
      deleted: true,
      leaseState: "deleted",
    };
  } finally {
    await releaseLock();
  }
}

export async function inventoryReviewWorkspaces(options = {}) {
  const context = await loadContext(options, { requireTrustedBase: true });
  const leaseRoot = await leaseDirectory(context.repositoryRoot);
  const entries = await listLeaseFiles(leaseRoot);
  const inventory = [];
  for (const entry of entries) {
    if (entry.lease.projectId !== context.profile.projectId || !samePath(entry.lease.repositoryRoot, context.repositoryRoot)) {
      inventory.push({ leasePath: entry.leasePath, state: "uncertain", findings: [{ code: "identity_mismatch" }] });
      continue;
    }
    try {
      await verifyLeaseContext(context, entry.lease, entry.leasePath, leaseRoot);
    } catch (error) {
      inventory.push({ leasePath: entry.leasePath, leaseId: pathKey(entry.lease.workspacePath), state: "uncertain", findings: [{ code: error.code || "identity_mismatch", message: error.message }] });
      continue;
    }
    const target = entry.lease.currentPath;
    const inspection = await inspectWorkspacePath(target, entry.lease, context.review);
    inventory.push({ leasePath: entry.leasePath, leaseId: pathKey(entry.lease.workspacePath), state: entry.lease.state, workspacePath: entry.lease.workspacePath, currentPath: target, head: entry.lease.head, safeForQuarantine: inspection.safeForQuarantine, findings: inspection.findings });
  }
  return { format: "pi-sampler.review-workspace-inventory", version: FORMAT_VERSION, repositoryRoot: context.repositoryRoot, workspaceRoot: context.workspaceRoot, quarantineRoot: context.quarantineRoot, entries: inventory };
}

function parseArgs(argv) {
  const command = argv[0];
  if (!new Set(["prepare", "inspect", "inventory", "quarantine", "clean", "cleanup"]).has(command)) fail("usage", "expected prepare, inspect, inventory, quarantine, or clean");
  const options = { confirm: false, authorize: false, authorized: false, delete: false };
  const names = new Map([
    ["--repo", "repo"], ["--profile", "profile"], ["--base", "base"], ["--base-sha", "baseSha"], ["--head", "head"], ["--head-sha", "headSha"], ["--candidate", "head"], ["--candidate-head", "candidateHead"], ["--candidate-sha", "candidateSha"],
    ["--work-item", "workItem"], ["--slug", "slug"], ["--workspace", "workspacePath"], ["--worktree", "workspacePath"], ["--worktree-path", "worktreePath"],
    ["--quarantine", "quarantinePath"], ["--owner", "owner"], ["--run-class", "runClass"], ["--lease", "lease"], ["--lease-token", "leaseToken"],
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--confirm" || key === "--authorize" || key === "--authorized" || key === "--authorize-deletion" || key === "--delete") {
      options[key === "--authorize-deletion" ? "authorizeDeletion" : key.slice(2)] = true;
      continue;
    }
    const name = names.get(key);
    if (!name || index + 1 >= argv.length) fail("usage", `invalid or incomplete argument: ${key}`);
    if (options[name] !== undefined) fail("usage", `duplicate argument: ${key}`);
    options[name] = argv[index + 1];
    index += 1;
  }
  return { command, options };
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const result = command === "prepare"
      ? await prepareReviewWorkspace(options)
      : command === "inspect"
        ? await inspectReviewWorkspace(options)
        : command === "inventory"
          ? await inventoryReviewWorkspaces(options)
          : command === "quarantine"
            ? await quarantineReviewWorkspace(options)
            : await cleanReviewWorkspace(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof ReviewWorkspaceError ? error.code : "unexpected";
    process.stderr.write(`review-workspace:${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();

export const prepareReview = prepareReviewWorkspace;
export const inspectReview = inspectReviewWorkspace;
export const quarantineReview = quarantineReviewWorkspace;
export const cleanupReviewWorkspace = cleanReviewWorkspace;
