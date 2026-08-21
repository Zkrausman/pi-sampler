import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
      review: {
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
      },
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
    "--purpose", "implement",
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
      "--purpose", "implement",
    ], { cwd: first.worktreePath }).stdout);

    assert.equal(first.format, "pi-sampler.delivery-worktree");
    assert.equal(first.workItem, "AIDEV-777");
    assert.equal(first.purpose, "implement");
    assert.match(first.worktreePath.replaceAll("\\", "/"), /\/worktrees\/implement\/AIDEV-777-[a-f0-9]{6}$/);
    assert.match(first.branch, /^automation\/aidev-777-implement-[a-f0-9]{6}$/);
    assert.match(first.baseSha, /^[a-f0-9]{40}$/);
    assert.equal(first.planPath, "docs/techPlans/AIDEV-777-implementation-plan.md");
    assert.match(first.leaseId, /^[a-f0-9]{24}$/);
    assert.match(first.leaseToken, /^[a-f0-9]{48}$/);
    assert.notEqual(first.worktreePath, second.worktreePath);
    assert.notEqual(first.branch, second.branch);
    assert.match(fromLinkedWorktree.worktreePath.replaceAll("\\", "/"), /\/worktrees\/implement\/AIDEV-777-[a-f0-9]{6}$/);
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
    assert.equal(cleanedFirst.purpose, "implement");
    assert.equal(cleanedSecond.branchDeleted, true);
    assert.equal(git(f.control, "branch", "--list", first.branch), "");
    assert.equal(git(f.control, "branch", "--list", second.branch), "");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("plan and implementation purposes use distinct workspace namespaces", async () => {
  const f = await fixture();
  try {
    const planned = prepare(f.control, ["--purpose", "plan", "--slug", "architecture"]);
    const implemented = prepare(f.control, ["--slug", "feature"]);

    assert.equal(planned.purpose, "plan");
    assert.match(planned.worktreePath.replaceAll("\\", "/"), /\/worktrees\/plan\/AIDEV-777-[a-f0-9]{6}$/);
    assert.match(planned.branch, /^automation\/aidev-777-plan-architecture-[a-f0-9]{6}$/);
    assert.equal(implemented.purpose, "implement");
    assert.match(implemented.worktreePath.replaceAll("\\", "/"), /\/worktrees\/implement\/AIDEV-777-[a-f0-9]{6}$/);
    assert.match(implemented.branch, /^automation\/aidev-777-implement-feature-[a-f0-9]{6}$/);
    assert.equal(planned.baseSha, implemented.baseSha);

    cleanup(f.control, planned, ["--delete-branch"]);
    cleanup(f.control, implemented, ["--delete-branch"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("implementation purpose requires a merged plan while planning permits its absence", async () => {
  const f = await fixture();
  try {
    git(f.control, "rm", "docs/techPlans/AIDEV-777-implementation-plan.md");
    git(f.control, "commit", "-m", "remove implementation plan");
    git(f.control, "push", "origin", "main");

    const missingPurpose = invoke([
      "prepare",
      "--repo", f.control,
      "--profile", "profiles/test.json",
      "--work-item", "AIDEV-777",
    ], { cwd: f.control, allowFailure: true });
    assert.notEqual(missingPurpose.status, 0);
    assert.match(missingPurpose.stderr, /delivery-worktree:purpose_invalid:/);

    const implementation = invoke([
      "prepare",
      "--repo", f.control,
      "--profile", "profiles/test.json",
      "--work-item", "AIDEV-777",
      "--purpose", "implement",
    ], { cwd: f.control, allowFailure: true });
    assert.notEqual(implementation.status, 0);
    assert.match(implementation.stderr, /delivery-worktree:plan_missing:/);

    const planned = prepare(f.control, ["--purpose", "plan"]);
    assert.equal(planned.purpose, "plan");
    assert.equal(planned.planPath, null);
    cleanup(f.control, planned, ["--delete-branch"]);
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
      "--purpose", "implement",
      "--slug", "linked-control",
    ], { cwd: linked }).stdout);

    assert.equal(prepared.baseSha, linkedHead);
    assert.equal(prepared.repositoryRoot, await realpath(f.control));
    assert.match(prepared.worktreePath.replaceAll("\\", "/"), /\/worktrees\/implement\/AIDEV-777-[a-f0-9]{6}$/);
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
      purpose: "implement",
      fetch: false,
      suffixSource: (_length, attempt) => attempt === 0 ? "aaaaaa" : "bbbbbb",
      beforeAdd: async ({ attempt, repoRoot, branch, worktreePath, baseSha }) => {
        if (attempt !== 0) return;
        git(repoRoot, "worktree", "add", "-b", branch, worktreePath, baseSha);
        collision = { branch, worktreePath };
      },
    });

    assert.equal(prepared.branch, "automation/aidev-777-implement-bbbbbb");
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
    const target = join(f.root, "worktrees", "implement", "AIDEV-777-cccccc");
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
        purpose: "implement",
        fetch: false,
        suffixSource: () => "cccccc",
      }),
      (error) => error.code === "lease_conflict",
    );
    assert.equal(await lstat(target).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error)), false);
    assert.equal(git(f.control, "branch", "--list", "automation/aidev-777-implement-cccccc"), "");
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
      "--purpose", "implement",
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

test("cleanup remains compatible with leases created before purpose metadata", async () => {
  const f = await fixture();
  try {
    const prepared = prepare(f.control);
    const commonDir = git(f.control, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const leasePath = join(commonDir, "pi-delivery-leases", `${prepared.leaseId}.json`);
    const legacyLease = JSON.parse(await readFile(leasePath, "utf8"));
    delete legacyLease.purpose;
    await writeFile(leasePath, `${JSON.stringify(legacyLease)}\n`);

    const cleaned = JSON.parse(cleanup(f.control, prepared, ["--delete-branch"]).stdout);
    assert.equal(cleaned.purpose, null);
    assert.equal(cleaned.branchDeleted, true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("delivery purpose root rejects a pre-existing directory symlink", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "worktrees");
    const outside = join(f.root, "outside-purpose");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "implement"), process.platform === "win32" ? "junction" : "dir");

    const result = invoke([
      "prepare",
      "--repo", f.control,
      "--profile", "profiles/test.json",
      "--work-item", "AIDEV-777",
      "--purpose", "implement",
    ], { cwd: f.control, allowFailure: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /delivery-worktree:worktree_root_invalid:/);
    assert.equal(git(f.control, "for-each-ref", "--format=%(refname:short)", "refs/heads/automation"), "");
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
      "--purpose", "implement",
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
