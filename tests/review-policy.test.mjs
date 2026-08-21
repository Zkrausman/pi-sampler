import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  loadTrustedReviewPolicy,
  validateRootSyntax,
  validateTrustedReviewProfile,
} from "../scripts/review-policy.mjs";

const execFile = promisify(execFileCallback);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const historicalBase = "aee0f2e6244aedc85fd1fc8620af317aeeb8f284";

async function git(cwd, args, reject = true) {
  try {
    const result = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 });
    return { ...result, status: 0 };
  } catch (error) {
    if (reject) throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", status: error.code ?? 1 };
  }
}

async function commit(cwd, message) {
  await git(cwd, ["add", "."]);
  await git(cwd, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

async function fixture({ legacy = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "aidev-165-"));
  await mkdir(join(cwd, "profiles"));
  await mkdir(join(cwd, "scripts"));
  const profile = JSON.parse(await readFile(join(root, "profiles", "pi-sampler.json"), "utf8"));
  if (legacy) delete profile.delivery.review;
  await writeFile(join(cwd, "profiles", "pi-sampler.json"), `${JSON.stringify(profile, null, 2)}\n`);
  await writeFile(join(cwd, "profiles", "project-profile.schema.json"), await readFile(join(root, "profiles", "project-profile.schema.json")));
  await writeFile(join(cwd, "scripts", "review-policy.mjs"), await readFile(join(root, "scripts", "review-policy.mjs")));
  await git(cwd, ["init", "--quiet"]);
  const baseSha = await commit(cwd, "fixture base");
  return {
    cwd,
    baseSha,
    async descendant(message = "fixture descendant") {
      return commit(cwd, message);
    },
    async close() {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function cli(cwd, args) {
  return git(cwd, ["--version"], false).then(async () => {
    try {
      const result = await execFile(process.execPath, [join(root, "scripts", "review-policy.mjs"), "verify", "--repo", cwd, ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 });
      return { status: 0, output: JSON.parse(result.stdout) };
    } catch (error) {
      return { status: error.code ?? 1, output: JSON.parse(error.stdout) };
    }
  });
}

test("the exact pre-AIDEV-157 base is an explicit blocking bootstrap result", async () => {
  const available = await git(root, ["cat-file", "-e", `${historicalBase}^{commit}`], false);
  assert.equal(available.status, 0, `required historical fixture ${historicalBase} is unavailable`);
  const candidateSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  for (const mode of ["bootstrap-check", "review-preflight"]) {
    const output = await loadTrustedReviewPolicy({ repo: root, mode, baseSha: historicalBase, candidateSha });
    assert.equal(output.status, "blocked");
    assert.equal(output.code, "bootstrap_required");
    assert.equal(Object.hasOwn(output, "policy"), false);
    assert.equal(Object.hasOwn(output, "policyDigest"), false);
    assert.equal(Object.hasOwn(output, "bindingDigest"), false);
  }
  const command = await cli(root, ["--mode", "review-preflight", "--base", historicalBase, "--candidate", candidateSha]);
  assert.notEqual(command.status, 0);
  assert.equal(command.output.code, "bootstrap_required");
});

test("a candidate cannot bootstrap a legacy base or supply its policy", async () => {
  const repository = await fixture({ legacy: true });
  try {
    const legacy = JSON.parse(await readFile(join(repository.cwd, "profiles", "pi-sampler.json"), "utf8"));
    legacy.delivery.review = JSON.parse(await readFile(join(root, "profiles", "pi-sampler.json"), "utf8")).delivery.review;
    await writeFile(join(repository.cwd, "profiles", "pi-sampler.json"), `${JSON.stringify(legacy, null, 2)}\n`);
    const candidateSha = await repository.descendant("candidate adds untrusted policy");
    for (const mode of ["bootstrap-check", "review-preflight"]) {
      const output = await loadTrustedReviewPolicy({ repo: repository.cwd, mode, baseSha: repository.baseSha, candidateSha });
      assert.equal(output.code, "bootstrap_required");
      assert.equal(output.status, "blocked");
      assert.equal(Object.hasOwn(output, "policy"), false);
    }
  } finally {
    await repository.close();
  }
});

test("trusted policy equivalence and candidate-bound digests are deterministic", async () => {
  const repository = await fixture();
  try {
    const first = await loadTrustedReviewPolicy({ repo: repository.cwd, mode: "review-preflight", baseSha: repository.baseSha, candidateSha: repository.baseSha });
    assert.equal(first.code, "ready");
    assert.equal(first.status, "ready");
    const second = await loadTrustedReviewPolicy({ repo: repository.cwd, mode: "review-preflight", baseSha: repository.baseSha, candidateSha: repository.baseSha });
    assert.deepEqual(second, first);
    await writeFile(join(repository.cwd, "unrelated.txt"), "candidate change\n");
    const candidateSha = await repository.descendant();
    const third = await loadTrustedReviewPolicy({ repo: repository.cwd, mode: "review-preflight", baseSha: repository.baseSha, candidateSha });
    assert.equal(third.code, "ready");
    assert.equal(third.policyDigest, first.policyDigest);
    assert.notEqual(third.bindingDigest, first.bindingDigest);
    assert.equal(third.policy.workspaceRoot, "../ai-workspaces/review");
    const command = await cli(repository.cwd, ["--mode", "review-preflight", "--base", repository.baseSha, "--candidate", candidateSha]);
    assert.equal(command.status, 0);
    assert.deepEqual(command.output, third);
  } finally {
    await repository.close();
  }
});

test("the executable is bound to the trusted base and cannot be replaced by a candidate copy", async () => {
  const repository = await fixture();
  try {
    await rm(join(repository.cwd, "scripts", "review-policy.mjs"));
    const missingLoaderSha = await repository.descendant("candidate removes loader");
    const missing = await loadTrustedReviewPolicy({ repo: repository.cwd, mode: "review-preflight", baseSha: missingLoaderSha, candidateSha: missingLoaderSha });
    assert.equal(missing.code, "base_invalid");
  } finally {
    await repository.close();
  }

  const replaced = await fixture();
  try {
    await writeFile(join(replaced.cwd, "scripts", "review-policy.mjs"), `${await readFile(join(replaced.cwd, "scripts", "review-policy.mjs"), "utf8")}\n`);
    const replacedSha = await replaced.descendant("candidate replaces loader");
    const output = await loadTrustedReviewPolicy({ repo: replaced.cwd, mode: "review-preflight", baseSha: replacedSha, candidateSha: replacedSha });
    assert.equal(output.code, "base_invalid");
  } finally {
    await replaced.close();
  }
});

test("candidate policy drift is blocked without adopting candidate roots or limits", async () => {
  const repository = await fixture();
  try {
    const profilePath = join(repository.cwd, "profiles", "pi-sampler.json");
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    profile.delivery.review.workspaceRoot = "../ai-workspaces/attacker";
    profile.delivery.review.limits.maxWorkspaces = 1;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    const candidateSha = await repository.descendant("candidate policy drift");
    const output = await loadTrustedReviewPolicy({ repo: repository.cwd, mode: "review-preflight", baseSha: repository.baseSha, candidateSha });
    assert.equal(output.status, "blocked");
    assert.equal(output.code, "profile_drift");
    assert.equal(Object.hasOwn(output, "policy"), false);
    assert.equal(Object.hasOwn(output, "workspaceRoot"), false);
  } finally {
    await repository.close();
  }
});

test("candidate SHA, mode, ancestry, and fixed-path inputs fail closed", async () => {
  const repository = await fixture();
  try {
    const cases = [
      [{ mode: "review-preflight", baseSha: repository.baseSha }, "candidate_required"],
      [{ mode: "review-preflight", baseSha: repository.baseSha, candidateSha: "main" }, "candidate_invalid"],
      [{ mode: "other", baseSha: repository.baseSha, candidateSha: repository.baseSha }, "mode_invalid"],
    ];
    for (const [options, code] of cases) assert.equal((await loadTrustedReviewPolicy({ repo: repository.cwd, ...options })).code, code);
    const badCli = await cli(repository.cwd, ["--mode", "review-preflight", "--base", repository.baseSha, "--profile", "profiles/attacker.json"]);
    assert.notEqual(badCli.status, 0);
    assert.equal(badCli.output.code, "mode_invalid");
  } finally {
    await repository.close();
  }
});

test("trusted schema and bounded semantic validation reject unsafe review values", async () => {
  const profile = JSON.parse(await readFile(join(root, "profiles", "pi-sampler.json"), "utf8"));
  const schema = JSON.parse(await readFile(join(root, "profiles", "project-profile.schema.json"), "utf8"));
  assert.equal(validateTrustedReviewProfile(profile, schema).ok, true);
  const unknown = structuredClone(profile);
  unknown.delivery.review.limits.extra = true;
  assert.equal(validateTrustedReviewProfile(unknown, schema).ok, false);
  const missing = structuredClone(profile);
  delete missing.delivery.review.limits.maxUntrackedBytes;
  assert.equal(validateTrustedReviewProfile(missing, schema).ok, false);
  const unsafe = structuredClone(profile);
  unsafe.delivery.review.limits.maxWorkspaces = 0;
  assert.equal(validateTrustedReviewProfile(unsafe, schema).ok, false);
  const publishing = structuredClone(profile);
  publishing.delivery.review.remotePolicy = "origin";
  assert.equal(validateTrustedReviewProfile(publishing, schema).ok, false);
});

test("approved root syntax rejects traversal, aliases, devices, and platform paths", () => {
  assert.equal(validateRootSyntax("../ai-workspaces/review"), true);
  assert.equal(validateRootSyntax("../ai-workspaces/review-quarantine"), true);
  for (const value of [
    "../../ai-workspaces/review",
    "../ai-workspaces/../review",
    "../ai-workspaces//review",
    ".././ai-workspaces/review",
    "/tmp/review",
    "C:/review",
    "\\\\server\\share\\review",
    "../ai-workspaces/CON",
    "../ai-workspaces/review.",
    "../ai-workspaces/review:stream",
    "../ai-workspaces/review*",
  ]) assert.equal(validateRootSyntax(value), false, value);
});

test("bounded malformed profile content fails closed and the loader DAG stays one-way", async () => {
  const duplicate = await fixture();
  try {
    await writeFile(join(duplicate.cwd, "profiles", "pi-sampler.json"), '{"projectId":"pi-sampler","projectId":"pi-sampler"}\n');
    const sha = await duplicate.descendant("duplicate profile keys");
    assert.equal((await loadTrustedReviewPolicy({ repo: duplicate.cwd, mode: "review-preflight", baseSha: sha, candidateSha: sha })).code, "base_invalid");
  } finally {
    await duplicate.close();
  }
  const source = await readFile(join(root, "scripts", "review-policy.mjs"), "utf8");
  assert.equal(/review-workspace\.mjs/.test(source), false);
  assert.match(source, /from ["']typebox\/compile["']/);
});

test("canonical JSON sorts object keys and has no whitespace", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: "v" }, list: [true, null] }), '{"a":{"x":"v","y":2},"list":[true,null],"z":1}');
});
