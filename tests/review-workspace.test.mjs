import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  cleanReviewWorkspace,
  inspectReviewWorkspace,
  prepareReviewWorkspace,
  quarantineReviewWorkspace,
} from "../scripts/review-workspace.mjs";

function run(command, args, { cwd, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

function git(cwd, ...args) {
  return run("git", args, { cwd }).stdout.trim();
}

const review = {
  workspaceRoot: "../review-workspaces/review",
  quarantineRoot: "../review-workspaces/quarantine",
  remotePolicy: "none",
  quarantineRetentionSeconds: 0,
  limits: {
    maxWorkspaces: 16,
    maxWorkspaceBytes: 2 * 1024 * 1024 * 1024,
    maxQuarantineBytes: 2 * 1024 * 1024 * 1024,
    maxUntrackedEntries: 512,
    maxUntrackedBytes: 512 * 1024 * 1024,
  },
};

async function fixture({ reviewOverrides = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "review-workspace-test-"));
  const fixtureReview = { ...review, ...reviewOverrides, limits: { ...review.limits, ...(reviewOverrides.limits || {}) } };
  const seed = join(root, "seed");
  const control = join(root, "control");
  await mkdir(seed);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Fixture Owner");
  git(seed, "config", "user.email", "owner@example.test");
  await mkdir(join(seed, "profiles"));
  const profile = {
    projectId: "review-fixture",
    workItem: { idPattern: "^AIDEV-[0-9]+$" },
    repository: { source: "example/review-fixture" },
    delivery: {
      remote: "origin",
      baseBranch: "main",
      worktreeRoot: "../delivery-worktrees",
      branchPrefix: "fixture",
      suffixLength: 6,
      review: fixtureReview,
    },
    verification: { commands: [{ command: "node", args: ["--version"] }] },
    governance: { requiredChecks: ["test"], paths: { evidence: "docs/evidence", specification: "docs/techPlans" } },
  };
  await writeFile(join(seed, "profiles", "test.json"), `${JSON.stringify(profile, null, 2)}\n`);
  await writeFile(join(seed, ".gitignore"), "node_modules/\ndist/\ncoverage/\n");
  await writeFile(join(seed, "tracked.txt"), "candidate\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "review fixture");
  const head = git(seed, "rev-parse", "HEAD");
  run("git", ["clone", seed, control], { cwd: root });
  git(control, "config", "user.name", "Fixture Owner");
  git(control, "config", "user.email", "owner@example.test");
  return { root, seed, control, head };
}

async function dispose(fixtureValue) {
  await rm(fixtureValue.root, { recursive: true, force: true });
}

function commonGitConfigPath(control) {
  return join(control, ".git", "config");
}

async function prepare(fixtureValue, suffix = "aaaaaa", extra = {}) {
  return prepareReviewWorkspace({
    repo: fixtureValue.control,
    profile: "profiles/test.json",
    base: fixtureValue.head,
    workItem: "AIDEV-157",
    head: fixtureValue.head,
    suffixSource: () => suffix,
    ...extra,
  });
}

test("preparation creates an exact isolated detached clone without reviewer identity or publication", async () => {
  const f = await fixture();
  try {
    const sourceConfig = await readFile(commonGitConfigPath(f.control));
    const prepared = await prepare(f);
    assert.equal(prepared.head, f.head);
    assert.equal(prepared.candidateSha, f.head);
    assert.equal(git(prepared.workspacePath, "rev-parse", "HEAD"), f.head);
    assert.equal(run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: prepared.workspacePath, allowFailure: true }).stdout.trim(), "");
    assert.equal(git(prepared.workspacePath, "remote"), "");
    assert.equal(git(prepared.workspacePath, "for-each-ref", "--format=%(refname)", "refs/heads"), "");
    assert.equal(run("git", ["config", "--local", "--get", "user.name"], { cwd: prepared.workspacePath, allowFailure: true }).status !== 0, true);
    assert.equal(run("git", ["config", "--local", "--get", "user.email"], { cwd: prepared.workspacePath, allowFailure: true }).status !== 0, true);
    assert.equal(git(prepared.workspacePath, "config", "--local", "--get", "user.useConfigOnly"), "true");
    assert.equal(git(prepared.workspacePath, "config", "--local", "--get", "core.hooksPath"), ".git/review-disabled-hooks");
    assert.equal(await lstat(join(prepared.workspacePath, ".git", "objects", "info", "alternates")).then(() => true, () => false), false);
    assert.notEqual(await stat(join(f.control, ".git")).then((info) => `${info.dev}:${info.ino}`), await stat(join(prepared.workspacePath, ".git")).then((info) => `${info.dev}:${info.ino}`));
    assert.deepEqual(await readFile(commonGitConfigPath(f.control)), sourceConfig);
    const inspection = await inspectReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    assert.equal(inspection.safeForQuarantine, true);
    assert.deepEqual(inspection.findings, []);
  } finally {
    await dispose(f);
  }
});

test("candidate head binding works when source checkout HEAD differs", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.control, "source-only.txt"), "source head is newer\n");
    git(f.control, "add", "source-only.txt");
    git(f.control, "commit", "-m", "advance source checkout");
    const sourceHead = git(f.control, "rev-parse", "HEAD");
    assert.notEqual(sourceHead, f.head);
    const prepared = await prepare(f, "cccccc");
    assert.equal(prepared.head, f.head);
    assert.equal(prepared.sourceCheckoutHead, sourceHead);
    assert.equal(git(prepared.workspacePath, "rev-parse", "HEAD"), f.head);
    const quarantined = await quarantineReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    await cleanReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, quarantinePath: quarantined.quarantinePath, lease: prepared.leaseToken, confirm: true });
  } finally {
    await dispose(f);
  }
});

test("clean content is quarantined before separate authorized deletion", async () => {
  const f = await fixture();
  try {
    const prepared = await prepare(f);
    const quarantined = await quarantineReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    assert.equal(await lstat(prepared.workspacePath).then(() => true, () => false), false);
    assert.equal(await lstat(quarantined.quarantinePath).then((info) => info.isDirectory()), true);
    await assert.rejects(
      cleanReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, quarantinePath: quarantined.quarantinePath, lease: prepared.leaseToken }),
      (error) => error.code === "authorization_required",
    );
    assert.equal(await lstat(quarantined.quarantinePath).then(() => true, () => false), true);
    const cleaned = await cleanReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, quarantinePath: quarantined.quarantinePath, lease: prepared.leaseToken, confirm: true });
    assert.equal(cleaned.deleted, true);
    assert.equal(await lstat(quarantined.quarantinePath).then(() => true, () => false), false);
  } finally {
    await dispose(f);
  }
});

test("dirty, unexpected, locked, and changed workspaces are preserved", async () => {
  const f = await fixture();
  try {
    const prepared = await prepare(f);
    await writeFile(join(prepared.workspacePath, "review-secret.txt"), "must preserve\n");
    const dirty = await inspectReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    assert.equal(dirty.safeForQuarantine, false);
    assert.ok(dirty.findings.some(({ code }) => code === "unexpected_disposable_content"));
    await assert.rejects(
      quarantineReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken }),
      (error) => error.code === "workspace_not_safe",
    );
    assert.equal(await lstat(prepared.workspacePath).then(() => true, () => false), true);
    await rm(join(prepared.workspacePath, "review-secret.txt"));
    await writeFile(join(prepared.workspacePath, "node_modules", "dependency.txt"), "disposable\n").catch(async (error) => {
      if (error.code !== "ENOENT") throw error;
      await mkdir(join(prepared.workspacePath, "node_modules"), { recursive: true });
      await writeFile(join(prepared.workspacePath, "node_modules", "dependency.txt"), "disposable\n");
    });
    const disposable = await inspectReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    assert.equal(disposable.safeForQuarantine, true);
    await rm(join(prepared.workspacePath, "node_modules"), { recursive: true, force: true });
    await writeFile(join(prepared.workspacePath, "tracked.txt"), "changed\n");
    const tracked = await inspectReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    assert.equal(tracked.safeForQuarantine, false);
    assert.ok(tracked.findings.some(({ code }) => code === "tracked_content_changed"));
    git(prepared.workspacePath, "restore", "tracked.txt");
    await writeFile(join(prepared.workspacePath, ".git", "index.lock"), "held\n");
    const locked = await inspectReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    assert.equal(locked.safeForQuarantine, false);
    assert.ok(locked.findings.some(({ code }) => code === "git_lock_present"));
  } finally {
    await dispose(f);
  }
});

test("lease and path races fail closed without removing the winner", async () => {
  const f = await fixture();
  try {
    const prepared = await prepare(f);
    await writeFile(`${prepared.leasePath}.operation.lock`, "held\n");
    await assert.rejects(
      quarantineReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken }),
      (error) => error.code === "operation_locked",
    );
    await rm(`${prepared.leasePath}.operation.lock`);
    const other = await prepare(f, "bbbbbb");
    const source = join(f.root, "outside");
    await mkdir(source);
    const alias = join(f.root, "alias");
    await symlink(other.workspacePath, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      inspectReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: alias, lease: other.leaseToken }),
      (error) => error.code === "unsafe_path",
    );
    assert.equal(await lstat(other.workspacePath).then((info) => info.isDirectory()), true);
  } finally {
    await dispose(f);
  }
});

test("candidate-controlled review roots cannot replace the immutable approved profile", async () => {
  const f = await fixture();
  try {
    const profilePath = join(f.control, "profiles", "test.json");
    const candidateProfile = JSON.parse(await readFile(profilePath, "utf8"));
    candidateProfile.delivery.review.workspaceRoot = "../candidate-controlled-review-root";
    await writeFile(profilePath, `${JSON.stringify(candidateProfile, null, 2)}\n`);
    git(f.control, "add", profilePath);
    git(f.control, "commit", "-m", "candidate profile root attack");
    const candidateHead = git(f.control, "rev-parse", "HEAD");
    await assert.rejects(
      prepareReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, head: candidateHead, workItem: "AIDEV-157", suffixSource: () => "dddddd" }),
      (error) => error.code === "profile_drift",
    );
    assert.equal(await lstat(join(f.root, "candidate-controlled-review-root")).then(() => true, () => false), false);
  } finally {
    await dispose(f);
  }
});

test("review preparation from a linked checkout leaves common Git configuration unchanged", async () => {
  const f = await fixture();
  const linked = join(f.root, "linked-review-invoker");
  try {
    git(f.control, "worktree", "add", "--detach", linked, f.head);
    const before = await readFile(commonGitConfigPath(f.control));
    const prepared = await prepare(f, "eeeeee", { repo: linked });
    assert.equal(prepared.head, f.head);
    assert.deepEqual(await readFile(commonGitConfigPath(f.control)), before);
    assert.equal(git(f.control, "config", "--local", "--get", "user.name"), "Fixture Owner");
  } finally {
    run("git", ["worktree", "remove", "--force", linked], { cwd: f.control, allowFailure: true });
    await dispose(f);
  }
});

test("global Git identity cannot become effective inside a review workspace", async () => {
  const f = await fixture();
  const globalConfig = join(f.root, "temporary-global.gitconfig");
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    await writeFile(globalConfig, "[user]\n\tname = Inherited Global\n\temail = global@example.test\n");
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    const prepared = await prepare(f, "ffffff");
    const inspection = await inspectReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    assert.equal(inspection.safeForQuarantine, true);
    assert.equal(inspection.findings.some(({ code }) => code === "effective_reviewer_identity_present"), false);
    assert.equal(run("git", ["config", "--local", "--get-regexp", "^user\\."], { cwd: prepared.workspacePath, allowFailure: true }).stdout.trim(), "user.useconfigonly true");
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    await dispose(f);
  }
});

test("concurrent preparation reserves maxWorkspaces atomically", async () => {
  const f = await fixture({ reviewOverrides: { limits: { maxWorkspaces: 1 } } });
  try {
    let arrivals = 0;
    let releaseBarrier;
    const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
    const beforeReserve = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    };
    const results = await Promise.allSettled([
      prepare(f, "111111", { beforeReserve }),
      prepare(f, "222222", { beforeReserve }),
    ]);
    assert.equal(arrivals, 2);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "resource_limit");
  } finally {
    await dispose(f);
  }
});

test("nested ignored filesystem entries count toward the bounded disposable-entry limit", async () => {
  const f = await fixture({ reviewOverrides: { limits: { maxUntrackedEntries: 1 } } });
  try {
    const prepared = await prepare(f);
    await mkdir(join(prepared.workspacePath, "node_modules"), { recursive: true });
    await writeFile(join(prepared.workspacePath, "node_modules", "one.txt"), "one\n");
    await writeFile(join(prepared.workspacePath, "node_modules", "two.txt"), "two\n");
    const inspection = await inspectReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    assert.equal(inspection.safeForQuarantine, false);
    assert.ok(inspection.findings.some(({ code }) => code === "untracked_limit_exceeded"));
    assert.ok(inspection.status.untrackedEntries > 1);
  } finally {
    await dispose(f);
  }
});

test("quarantine and deletion recover every post-rename lease boundary", async () => {
  const f = await fixture();
  try {
    const prepared = await prepare(f);
    let quarantinePath;
    await assert.rejects(
      quarantineReviewWorkspace({
        repo: f.control,
        profile: "profiles/test.json",
        base: f.head,
        workspacePath: prepared.workspacePath,
        lease: prepared.leaseToken,
        afterRename: ({ quarantinePath: target }) => { quarantinePath = target; throw new Error("interrupt after quarantine rename"); },
      }),
    );
    assert.equal(await lstat(prepared.workspacePath).then(() => true, () => false), false);
    assert.equal(await lstat(quarantinePath).then((info) => info.isDirectory()), true);
    const recoveredQuarantine = await quarantineReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    assert.equal(recoveredQuarantine.quarantinePath, quarantinePath);

    let deletionPath;
    await assert.rejects(
      cleanReviewWorkspace({
        repo: f.control,
        profile: "profiles/test.json",
        base: f.head,
        quarantinePath,
        lease: prepared.leaseToken,
        confirm: true,
        afterRename: ({ deletionPath: target }) => { deletionPath = target; throw new Error("interrupt after deletion rename"); },
      }),
    );
    assert.equal(await lstat(quarantinePath).then(() => true, () => false), false);
    assert.equal(await lstat(deletionPath).then((info) => info.isDirectory()), true);
    const recoveredDelete = await cleanReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, quarantinePath, lease: prepared.leaseToken, confirm: true });
    assert.equal(recoveredDelete.deleted, true);
    assert.equal(await lstat(deletionPath).then(() => true, () => false), false);
  } finally {
    await dispose(f);
  }
});

test("interrupted lease updates and removal reconcile without deleting uncertain content", async () => {
  const f = await fixture();
  try {
    const prepared = await prepare(f, "121212");
    let quarantinePath;
    await assert.rejects(
      quarantineReviewWorkspace({
        repo: f.control,
        profile: "profiles/test.json",
        base: f.head,
        workspacePath: prepared.workspacePath,
        lease: prepared.leaseToken,
        beforeLeaseUpdate: ({ quarantinePath: target }) => { quarantinePath = target; throw new Error("interrupt before quarantine lease update"); },
      }),
    );
    const recovered = await quarantineReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: prepared.workspacePath, lease: prepared.leaseToken });
    assert.equal(recovered.quarantinePath, quarantinePath);
    await assert.rejects(
      cleanReviewWorkspace({
        repo: f.control,
        profile: "profiles/test.json",
        base: f.head,
        quarantinePath,
        lease: prepared.leaseToken,
        confirm: true,
        beforeLeaseUpdate: () => { throw new Error("interrupt before deletion lease update"); },
      }),
    );
    assert.equal(await lstat(quarantinePath).then(() => true, () => false), false);
    const cleaned = await cleanReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, quarantinePath, lease: prepared.leaseToken, confirm: true });
    assert.equal(cleaned.deleted, true);

    const second = await prepare(f, "343434");
    const secondQuarantine = await quarantineReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: second.workspacePath, lease: second.leaseToken });
    await assert.rejects(
      cleanReviewWorkspace({
        repo: f.control,
        profile: "profiles/test.json",
        base: f.head,
        quarantinePath: secondQuarantine.quarantinePath,
        lease: second.leaseToken,
        confirm: true,
        afterRemove: () => { throw new Error("interrupt after removal"); },
      }),
    );
    const recoveredRemoval = await cleanReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, quarantinePath: secondQuarantine.quarantinePath, lease: second.leaseToken, confirm: true });
    assert.equal(recoveredRemoval.deleted, true);

    const third = await prepare(f, "565656");
    const thirdQuarantine = await quarantineReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, workspacePath: third.workspacePath, lease: third.leaseToken });
    let removalPath;
    await assert.rejects(
      cleanReviewWorkspace({
        repo: f.control,
        profile: "profiles/test.json",
        base: f.head,
        quarantinePath: thirdQuarantine.quarantinePath,
        lease: third.leaseToken,
        confirm: true,
        afterRemovalRename: ({ removalPath: target }) => { removalPath = target; throw new Error("interrupt after removal ownership rename"); },
      }),
    );
    assert.equal(await lstat(thirdQuarantine.quarantinePath).then(() => true, () => false), false);
    assert.equal(await lstat(removalPath).then((info) => info.isDirectory()), true);
    const recoveredOwnership = await cleanReviewWorkspace({ repo: f.control, profile: "profiles/test.json", base: f.head, quarantinePath: thirdQuarantine.quarantinePath, lease: third.leaseToken, confirm: true });
    assert.equal(recoveredOwnership.deleted, true);
  } finally {
    await dispose(f);
  }
});
