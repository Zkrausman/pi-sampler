import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupDeliveryWorktree, prepareDeliveryWorktree } from "../scripts/delivery-worktree.mjs";

const script = fileURLToPath(new URL("../scripts/delivery-worktree.mjs", import.meta.url));

function run(command, args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function git(cwd, ...args) {
  return run("git", args, { cwd }).stdout.trim();
}

function invoke(args, { cwd, allowFailure = false } = {}) {
  return run(process.execPath, [script, ...args], { cwd, allowFailure });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "delivery-worktree-test-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const control = join(root, "control");
  await mkdir(seed);
  git(root, "init", "--bare", remote);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Delivery Test");
  git(seed, "config", "user.email", "delivery@example.test");
  await writeFile(join(seed, "README.md"), "fixture\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-m", "initial fixture");
  const missingProfileSha = git(seed, "rev-parse", "HEAD");

  await mkdir(join(seed, "profiles"));
  await mkdir(join(seed, "docs", "techPlans"), { recursive: true });
  const profile = {
    projectId: "delivery-test",
    workItem: { idPattern: "^AIDEV-[0-9]+$" },
    repository: { source: "example/delivery-test" },
    delivery: {
      remote: "origin",
      baseBranch: "main",
      worktreeRoot: "../worktrees",
      branchPrefix: "automation",
      suffixLength: 6,
    },
    verification: { commands: [{ command: "npm", args: ["test"] }] },
    governance: {
      requiredChecks: ["test"],
      paths: { evidence: "docs/evidence", specification: "docs/techPlans" },
    },
  };
  await writeFile(join(seed, "profiles", "test.json"), `${JSON.stringify(profile, null, 2)}\n`);
  await writeFile(join(seed, "docs", "techPlans", "AIDEV-777-implementation-plan.md"), "# Test plan\n");
  await writeFile(join(seed, ".gitignore"), "node_modules/\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "add delivery profile and plan");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "clone", remote, control);
  git(control, "config", "user.name", "Delivery Test");
  git(control, "config", "user.email", "delivery@example.test");
  return { root, remote, seed, control, missingProfileSha };
}

function prepare(control, extra = []) {
  const result = invoke([
    "prepare",
    "--repo", control,
    "--profile", "profiles/test.json",
    "--work-item", "AIDEV-777",
    ...extra,
  ], { cwd: control });
  return JSON.parse(result.stdout);
}

function cleanup(control, prepared, extra = [], { allowFailure = false } = {}) {
  return invoke([
    "cleanup",
    "--repo", control,
    "--worktree", prepared.worktreePath,
    "--lease", prepared.leaseToken,
    ...extra,
  ], { cwd: control, allowFailure });
}

test("delivery worktree provisioning is unique, exact, leased, and safely cleaned", async () => {
  const f = await fixture();
  try {
    const first = prepare(f.control);
    const second = prepare(f.control);
    const fromLinkedWorktree = JSON.parse(invoke([
      "prepare",
      "--repo", first.worktreePath,
      "--profile", "profiles/test.json",
      "--work-item", "AIDEV-777",
    ], { cwd: first.worktreePath }).stdout);

    assert.equal(first.format, "pi-sampler.delivery-worktree");
    assert.equal(first.workItem, "AIDEV-777");
    assert.match(first.worktreePath.replaceAll("\\", "/"), /\/worktrees\/AIDEV-777-[a-f0-9]{6}$/);
    assert.match(first.branch, /^automation\/aidev-777-delivery-[a-f0-9]{6}$/);
    assert.match(first.baseSha, /^[a-f0-9]{40}$/);
    assert.equal(first.planPath, "docs/techPlans/AIDEV-777-implementation-plan.md");
    assert.match(first.leaseId, /^[a-f0-9]{24}$/);
    assert.match(first.leaseToken, /^[a-f0-9]{48}$/);
    assert.notEqual(first.worktreePath, second.worktreePath);
    assert.notEqual(first.branch, second.branch);
    assert.match(fromLinkedWorktree.worktreePath.replaceAll("\\", "/"), /\/worktrees\/AIDEV-777-[a-f0-9]{6}$/);
    assert.notEqual(fromLinkedWorktree.worktreePath, first.worktreePath);
    assert.equal(git(first.worktreePath, "rev-parse", "HEAD"), first.baseSha);
    const ignoredPath = join(first.worktreePath, "node_modules", ...Array.from({ length: 10 }, (_, index) => `ignored-directory-${index}`));
    await mkdir(ignoredPath, { recursive: true });
    await writeFile(join(ignoredPath, "ignored.txt"), "ignored dependency artifact\n");
    assert.equal(git(first.worktreePath, "status", "--porcelain=v1"), "");

    const cleanedFromLinked = JSON.parse(cleanup(first.worktreePath, fromLinkedWorktree, ["--delete-branch"]).stdout);
    const cleanedFirst = JSON.parse(cleanup(f.control, first, ["--delete-branch"]).stdout);
    const cleanedSecond = JSON.parse(cleanup(f.control, second, ["--delete-branch"]).stdout);
    assert.equal(cleanedFromLinked.branchDeleted, true);
    assert.equal(cleanedFirst.branchDeleted, true);
    assert.equal(cleanedSecond.branchDeleted, true);
    assert.equal(git(f.control, "branch", "--list", first.branch), "");
    assert.equal(git(f.control, "branch", "--list", second.branch), "");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("linked checkout provisioning ignores a stale and dirty primary checkout", async () => {
  const f = await fixture();
  try {
    const profilePath = join(f.control, "profiles", "test.json");
    const currentProfile = JSON.parse(await readFile(profilePath, "utf8"));
    const staleProfile = structuredClone(currentProfile);
    delete staleProfile.delivery;
    await writeFile(profilePath, `${JSON.stringify(staleProfile, null, 2)}\n`);
    git(f.control, "add", "profiles/test.json");
    git(f.control, "commit", "-m", "remove delivery configuration");
    const stalePrimarySha = git(f.control, "rev-parse", "HEAD");

    await writeFile(profilePath, `${JSON.stringify(currentProfile, null, 2)}\n`);
    git(f.control, "add", "profiles/test.json");
    git(f.control, "commit", "-m", "restore delivery configuration");
    const linkedHead = git(f.control, "rev-parse", "HEAD");
    git(f.control, "push", "origin", "main");
    const linked = join(f.root, "linked-control");
    git(f.control, "worktree", "add", "-b", "linked-control", linked, linkedHead);

    git(f.control, "reset", "--hard", stalePrimarySha);
    await writeFile(join(f.control, "primary-only-untracked.txt"), "dirty primary checkout\n");
    const prepared = JSON.parse(invoke([
      "prepare",
      "--profile", "profiles/test.json",
      "--work-item", "AIDEV-777",
      "--slug", "linked-control",
    ], { cwd: linked }).stdout);

    assert.equal(prepared.baseSha, linkedHead);
    assert.equal(prepared.repositoryRoot, await realpath(f.control));
    assert.match(prepared.worktreePath.replaceAll("\\", "/"), /\/worktrees\/AIDEV-777-[a-f0-9]{6}$/);
    assert.equal(git(prepared.worktreePath, "rev-parse", "HEAD"), linkedHead);
    assert.equal(git(f.control, "status", "--porcelain=v1"), "?? primary-only-untracked.txt");
    cleanup(linked, prepared, ["--delete-branch"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a raced suffix collision is retried without deleting the winning worktree", async () => {
  const f = await fixture();
  let collision;
  try {
    const prepared = await prepareDeliveryWorktree({
      repo: f.control,
      profile: "profiles/test.json",
      workItem: "AIDEV-777",
      fetch: false,
      suffixSource: (_length, attempt) => attempt === 0 ? "aaaaaa" : "bbbbbb",
      beforeAdd: async ({ attempt, repoRoot, branch, worktreePath, baseSha }) => {
        if (attempt !== 0) return;
        git(repoRoot, "worktree", "add", "-b", branch, worktreePath, baseSha);
        collision = { branch, worktreePath };
      },
    });

    assert.equal(prepared.branch, "automation/aidev-777-delivery-bbbbbb");
    assert.equal(await lstat(collision.worktreePath).then((entry) => entry.isDirectory()), true);
    assert.equal(git(collision.worktreePath, "branch", "--show-current"), collision.branch);
    await cleanupDeliveryWorktree({ repo: f.control, worktree: prepared.worktreePath, lease: prepared.leaseToken, deleteBranch: true, fetch: false });
    git(f.control, "worktree", "remove", collision.worktreePath);
    git(f.control, "branch", "-D", collision.branch);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("lease reservation failure rolls back only the invocation-owned worktree", async () => {
  const f = await fixture();
  try {
    const target = join(f.root, "worktrees", "AIDEV-777-cccccc");
    const canonicalKeyPath = process.platform === "win32" ? target.toLowerCase() : target;
    const key = createHash("sha256").update(canonicalKeyPath).digest("hex").slice(0, 24);
    const commonDir = git(f.control, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const leaseDir = join(commonDir, "pi-delivery-leases");
    const leasePath = join(leaseDir, `${key}.json`);
    await mkdir(leaseDir, { recursive: true });
    await writeFile(leasePath, "pre-existing reservation\n");

    await assert.rejects(
      prepareDeliveryWorktree({
        repo: f.control,
        profile: "profiles/test.json",
        workItem: "AIDEV-777",
        fetch: false,
        suffixSource: () => "cccccc",
      }),
      (error) => error.code === "lease_conflict",
    );
    assert.equal(await lstat(target).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error)), false);
    assert.equal(git(f.control, "branch", "--list", "automation/aidev-777-delivery-cccccc"), "");
    assert.equal(await readFile(leasePath, "utf8"), "pre-existing reservation\n");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("delivery worktree provisioning rejects a base without the approved profile", async () => {
  const f = await fixture();
  try {
    const result = invoke([
      "prepare",
      "--repo", f.control,
      "--profile", "profiles/test.json",
      "--work-item", "AIDEV-777",
      "--base", f.missingProfileSha,
      "--no-fetch",
    ], { cwd: f.control, allowFailure: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /delivery-worktree:base_profile_missing:/);
    assert.equal(git(f.control, "for-each-ref", "--format=%(refname:short)", "refs/heads/automation"), "");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("cleanup atomically retains a branch changed after merge validation", async () => {
  const f = await fixture();
  try {
    const prepared = prepare(f.control);
    const tree = git(f.control, "rev-parse", `${prepared.baseSha}^{tree}`);
    const racedCommit = git(f.control, "commit-tree", tree, "-p", prepared.baseSha, "-m", "concurrent branch update");
    await assert.rejects(
      cleanupDeliveryWorktree({
        repo: f.control,
        worktree: prepared.worktreePath,
        lease: prepared.leaseToken,
        deleteBranch: true,
        fetch: false,
        beforeBranchDelete: async ({ repoRoot, branch, expectedHead }) => {
          git(repoRoot, "update-ref", `refs/heads/${branch}`, racedCommit, expectedHead);
        },
      }),
      (error) => error.code === "branch_changed",
    );
    assert.equal(git(f.control, "rev-parse", `refs/heads/${prepared.branch}`), racedCommit);
    assert.equal(await lstat(prepared.worktreePath).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error)), false);
    git(f.control, "branch", "-D", prepared.branch);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("delivery profile rejects an absolute worktree root", async () => {
  const f = await fixture();
  try {
    const profilePath = join(f.control, "profiles", "test.json");
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    profile.delivery.worktreeRoot = join(f.root, "absolute-worktrees");
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    git(f.control, "add", "profiles/test.json");
    git(f.control, "commit", "-m", "set unsafe absolute worktree root");
    git(f.control, "push", "origin", "main");
    const result = invoke([
      "prepare",
      "--repo", f.control,
      "--profile", "profiles/test.json",
      "--work-item", "AIDEV-777",
    ], { cwd: f.control, allowFailure: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /delivery-worktree:profile_invalid:/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("cleanup preserves locked or dirty worktrees and rejects unmerged branch deletion", async () => {
  const f = await fixture();
  try {
    const locked = prepare(f.control);
    git(f.control, "worktree", "lock", "--reason", "active delivery", locked.worktreePath);
    const lockedResult = cleanup(f.control, locked, ["--delete-branch", "--no-fetch"], { allowFailure: true });
    assert.notEqual(lockedResult.status, 0);
    assert.match(lockedResult.stderr, /delivery-worktree:cleanup_failed:/);
    assert.equal(await lstat(locked.worktreePath).then((entry) => entry.isDirectory()), true);
    git(f.control, "worktree", "unlock", locked.worktreePath);
    cleanup(f.control, locked, ["--delete-branch", "--no-fetch"]);

    const dirty = prepare(f.control);
    await writeFile(join(dirty.worktreePath, "untracked.txt"), "owned but uncommitted\n");
    const dirtyResult = cleanup(f.control, dirty, ["--delete-branch", "--no-fetch"], { allowFailure: true });
    assert.notEqual(dirtyResult.status, 0);
    assert.match(dirtyResult.stderr, /delivery-worktree:worktree_dirty:/);
    await rm(join(dirty.worktreePath, "untracked.txt"));
    cleanup(f.control, dirty, ["--delete-branch", "--no-fetch"]);

    const committed = prepare(f.control);
    await writeFile(join(committed.worktreePath, "change.txt"), "unmerged\n");
    git(committed.worktreePath, "add", "change.txt");
    git(committed.worktreePath, "commit", "-m", "unmerged delivery");
    const unmergedResult = cleanup(f.control, committed, ["--delete-branch", "--no-fetch"], { allowFailure: true });
    assert.notEqual(unmergedResult.status, 0);
    assert.match(unmergedResult.stderr, /delivery-worktree:branch_unmerged:/);
    cleanup(f.control, committed, ["--no-fetch"]);
    git(f.control, "branch", "-D", committed.branch);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
