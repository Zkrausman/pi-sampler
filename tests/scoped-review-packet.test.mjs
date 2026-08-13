import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const generator = join(root, "scripts", "generate-review-packet.mjs");
const { generateReviewPacket } = await import(pathToFileURL(generator).href);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-scoped-review-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "user.name", "Scoped Review Test");
  await writeFile(join(cwd, "tracked.txt"), "before\n");
  git(cwd, "add", "tracked.txt");
  git(cwd, "commit", "--quiet", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  await writeFile(join(cwd, "tracked.txt"), `${Array.from({ length: 20 }, (_, index) => `changed ${index}`).join("\n")}\n${"x".repeat(9_000)}\n`);
  await writeFile(join(cwd, "added.txt"), "committed addition\n");
  git(cwd, "add", "tracked.txt", "added.txt");
  git(cwd, "commit", "--quiet", "-m", "head");
  const head = git(cwd, "rev-parse", "HEAD");
  await writeFile(join(cwd, "untracked-secret.txt"), "must never appear\n");
  return { cwd, base, head };
}

function invoke(cwd, ...args) {
  return execFileSync(process.execPath, [generator, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("review packet is deterministic, bounded, stdout-only, and excludes untracked files", async () => {
  const fixture = await repository();
  try {
    const args = ["--base", fixture.base, "--head", fixture.head, "--validation", "targeted test: passed"];
    const first = invoke(fixture.cwd, ...args);
    const second = invoke(fixture.cwd, ...args);
    assert.equal(second, first);
    const packet = JSON.parse(first);
    assert.equal(packet.format, "pi-sampler.scoped-review-packet.v1");
    assert.equal(packet.base, fixture.base);
    assert.equal(packet.head, fixture.head);
    assert.deepEqual(packet.changedFiles, [{ path: "added.txt", status: "A" }, { path: "tracked.txt", status: "M" }]);
    assert.match(packet.diffStat, /added\.txt/);
    assert.doesNotMatch(first, /untracked-secret|must never appear/);
    assert.ok(packet.patches.every((patch) => packet.changedFiles.some((file) => file.path === patch.path)));
    assert.ok(packet.patches.every((patch) => patch.hunks.length <= 4 && patch.hunks.every((hunk) => Buffer.byteLength(hunk) <= 8_192 + 64)));
    assert.match(packet.patches.find((patch) => patch.path === "tracked.txt").hunks[0], /hunk truncated by review-packet bound/);
    assert.equal(packet.incomplete, true);
    assert.deepEqual(packet.omittedHunks, ["tracked.txt"]);
    assert.deepEqual(packet.byteTruncatedHunks, ["tracked.txt"]);
    await assert.rejects(lstat(join(fixture.cwd, ".review", "packet.json")), { code: "ENOENT" });
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("review packet rejects the removed filesystem-output contract", async () => {
  const fixture = await repository();
  try {
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.base, "--head", fixture.head, "--output", ".review/packet.json"), /review-packet: expected supported option/);
    const previous = process.cwd();
    process.chdir(fixture.cwd);
    try {
      await assert.rejects(generateReviewPacket({ base: fixture.base, head: fixture.head, output: ".review/packet.json" }), /filesystem output is unsupported/);
    } finally { process.chdir(previous); }
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("review packet never follows a parent-directory symlink because it performs no filesystem publication", async (t) => {
  const fixture = await repository();
  try {
    const outside = await mkdtemp(join(tmpdir(), "pi-scoped-review-outside-"));
    await writeFile(join(outside, "marker.json"), "must not change");
    try { await symlink(outside, join(fixture.cwd, ".review"), "dir"); } catch (error) { await rm(outside, { recursive: true, force: true }); t.skip(`symlinks unavailable: ${error.code}`); return; }
    const packet = JSON.parse(invoke(fixture.cwd, "--base", fixture.base, "--head", fixture.head));
    assert.equal(packet.format, "pi-sampler.scoped-review-packet.v1");
    assert.equal(await readFile(join(outside, "marker.json"), "utf8"), "must not change");
    await assert.rejects(lstat(join(outside, "packet.json")), { code: "ENOENT" });
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("review packet rejects binary committed changes", async () => {
  const fixture = await repository();
  try {
    await writeFile(join(fixture.cwd, "binary.bin"), Buffer.from([0, 1, 2]));
    git(fixture.cwd, "add", "binary.bin");
    git(fixture.cwd, "commit", "--quiet", "-m", "binary");
    const binaryHead = git(fixture.cwd, "rev-parse", "HEAD");
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.base, "--head", binaryHead), /review-packet: binary\.bin is binary/);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("review packet rejects oversized committed changes", async () => {
  const fixture = await repository();
  try {
    await writeFile(join(fixture.cwd, "oversized.txt"), "x".repeat(128 * 1024 + 1));
    git(fixture.cwd, "add", "oversized.txt");
    git(fixture.cwd, "commit", "--quiet", "-m", "oversized");
    const oversizedHead = git(fixture.cwd, "rev-parse", "HEAD");
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.base, "--head", oversizedHead), /review-packet: oversized\.txt exceeds 131072 bytes/);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("review packet advertises omitted hunks and requires bounded follow-up inspection", async () => {
  const fixture = await repository();
  try {
    const lines = Array.from({ length: 48 }, (_, index) => `line ${index}`).join("\n");
    await writeFile(join(fixture.cwd, "tracked.txt"), `${lines}\n`);
    git(fixture.cwd, "add", "tracked.txt");
    git(fixture.cwd, "commit", "--quiet", "-m", "many hunks base");
    const base = git(fixture.cwd, "rev-parse", "HEAD");
    const changed = Array.from({ length: 48 }, (_, index) => index % 8 ? `line ${index}` : `changed ${index}`).join("\n");
    await writeFile(join(fixture.cwd, "tracked.txt"), `${changed}\n`);
    git(fixture.cwd, "add", "tracked.txt");
    git(fixture.cwd, "commit", "--quiet", "-m", "many hunks head");
    const head = git(fixture.cwd, "rev-parse", "HEAD");
    const packet = JSON.parse(invoke(fixture.cwd, "--base", base, "--head", head));
    assert.equal(packet.incomplete, true);
    assert.deepEqual(packet.omittedHunks, ["tracked.txt"]);
    assert.equal(packet.patches.find((patch) => patch.path === "tracked.txt").omittedHunks, true);
    assert.deepEqual(packet.byteTruncatedHunks, []);
    const template = await readFile(join(root, ".pi", "agents", "scoped-reviewer.md"), "utf8");
    assert.match(template, /inspect every file named in `omittedHunks`/i);
    assert.match(template, /byte-truncated/i);
    assert.match(template, /scoped\s+review cannot be completed/i);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet enforces file and validation-payload bounds", async () => {
  const fixture = await repository();
  try {
    for (let index = 0; index < 201; index += 1) await writeFile(join(fixture.cwd, `cap-${index}.txt`), "x\n");
    git(fixture.cwd, "add", ".");
    git(fixture.cwd, "commit", "--quiet", "-m", "file cap");
    const capHead = git(fixture.cwd, "rev-parse", "HEAD");
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.head, "--head", capHead), /changed-file list exceeds bounds/);
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.base, "--head", fixture.head, "--validation", "x".repeat(4097)), /validation is missing, unsafe, or exceeds its bound/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("scoped reviewer template enforces the packet boundary and escalation contract", async () => {
  const template = await readFile(join(root, ".pi", "agents", "scoped-reviewer.md"), "utf8");
  assert.match(template, /^name: scoped-reviewer$/m);
  assert.match(template, /^tools: read$/m);
  assert.match(template, /^thinking: medium$/m);
  assert.match(template, /^defaultContext: fresh$/m);
  assert.match(template, /packet-listed changed files/i);
  assert.match(template, /untracked files, history outside the packet range,\s+environment data, credentials, sessions, or governance/i);
  assert.match(template, /direct import/i);
  assert.match(template, /Report only \*\*blocker\*\* or \*\*high\*\* findings/i);
  assert.match(template, /Standard reviewer/i);
  assert.match(template, /High-reasoning escalation/i);
  assert.match(template, /retains the same\s+packet and inspection boundary/i);
});
