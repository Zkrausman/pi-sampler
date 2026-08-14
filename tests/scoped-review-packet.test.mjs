import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const generator = join(root, "scripts", "generate-review-packet.mjs");
const { generateReviewPacket, safeChangedPath } = await import(pathToFileURL(generator).href);

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

function invokeWithEnvironment(cwd, environment, ...args) {
  return execFileSync(process.execPath, [generator, ...args], { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function committedRange(cwd, files) {
  for (const [filePath, content] of Object.entries(files.base)) await writeFile(join(cwd, filePath), content);
  git(cwd, "add", "--", ...Object.keys(files.base));
  git(cwd, "commit", "--quiet", "-m", "range base");
  const base = git(cwd, "rev-parse", "HEAD");
  for (const filePath of Object.keys(files.base)) if (!(filePath in files.head)) git(cwd, "rm", "--quiet", filePath);
  for (const [filePath, content] of Object.entries(files.head)) await writeFile(join(cwd, filePath), content);
  const toAdd = Object.keys(files.head).filter((filePath) => files.head[filePath] !== files.base[filePath]);
  if (toAdd.length) git(cwd, "add", "--", ...toAdd);
  git(cwd, "commit", "--quiet", "-m", "range head");
  return { base, head: git(cwd, "rev-parse", "HEAD") };
}

function immutable(packet, filePath) {
  return packet.immutableMaterial.find((entry) => entry.path === filePath);
}

test("review packet accepts safe dot-prefixed tracked path segments and rejects unsafe paths", async () => {
  const fixture = await repository();
  try {
    await mkdir(join(fixture.cwd, ".changeset"));
    await writeFile(join(fixture.cwd, ".changeset", "review-maintenance.md"), "safe tracked metadata\n");
    git(fixture.cwd, "add", ".changeset/review-maintenance.md");
    git(fixture.cwd, "commit", "--quiet", "-m", "add dot-prefixed tracked path");
    const packet = JSON.parse(invoke(fixture.cwd, "--base", fixture.head, "--head", git(fixture.cwd, "rev-parse", "HEAD")));
    assert.deepEqual(packet.changedFiles, [{ path: ".changeset/review-maintenance.md", status: "A" }]);
    for (const unsafe of ["/absolute.txt", "", "one//two", "one/./two", "one/../two", ".git/config", "one/.git/two", "one\\two", "one/\0two", "one space/two"]) {
      assert.throws(() => safeChangedPath(unsafe), /changed path is unsafe or unsupported/);
    }
    for (const safe of [".changeset/review.md", ".editorconfig", "docs/.well-known/example.txt"]) assert.doesNotThrow(() => safeChangedPath(safe));
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet is deterministic, bounded, stdout-only, and embeds immutable material for byte-truncated hunks", async () => {
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
    const material = immutable(packet, "tracked.txt");
    assert.equal(material.status, "M");
    assert.equal(material.base.content, "before\n");
    assert.match(material.head.content, /x{9000}/);
    assert.match(material.base.objectId, /^[0-9a-f]{40}$/);
    assert.match(material.head.objectId, /^[0-9a-f]{40}$/);
    await assert.rejects(lstat(join(fixture.cwd, ".review", "packet.json")), { code: "ENOENT" });
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet applies no-replace-objects to every Git invocation and disables external diff/textconv", async () => {
  const fixture = await repository();
  try {
    const commands = [];
    const previous = process.cwd();
    process.chdir(fixture.cwd);
    try { await generateReviewPacket({ base: fixture.base, head: fixture.head }, { onGitCommand: (args) => commands.push(args) }); } finally { process.chdir(previous); }
    assert.ok(commands.length > 0);
    assert.ok(commands.every((args) => args.includes("--no-replace-objects")));
    assert.ok(commands.every((args) => args.includes("--no-pager") && args.includes("trace2.eventTarget=") && args.includes("trace2.normalTarget=") && args.includes("trace2.perfTarget=") && args.includes("core.hooksPath=/dev/null")));
    const diffCommands = commands.filter((args) => args.includes("diff"));
    assert.equal(diffCommands.length, 4);
    assert.ok(diffCommands.every((args) => args.includes("--no-ext-diff") && args.includes("--no-textconv")));
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet rejects replacement refs and reads the original committed tree", async () => {
  const fixture = await repository();
  try {
    git(fixture.cwd, "checkout", "--quiet", fixture.base);
    await writeFile(join(fixture.cwd, "tracked.txt"), "replacement content must not appear\n");
    git(fixture.cwd, "add", "tracked.txt");
    git(fixture.cwd, "commit", "--quiet", "-m", "replacement head");
    const replacementHead = git(fixture.cwd, "rev-parse", "HEAD");
    git(fixture.cwd, "replace", fixture.head, replacementHead);

    const packet = JSON.parse(invoke(fixture.cwd, "--base", fixture.base, "--head", fixture.head));
    assert.equal(packet.head, fixture.head);
    assert.match(packet.patches.find((patch) => patch.path === "tracked.txt").hunks.join("\n"), /changed 0/);
    assert.doesNotMatch(JSON.stringify(packet), /replacement content must not appear/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet ignores inherited Git repository-selection variables", async () => {
  const target = await repository();
  const decoy = await repository();
  try {
    await writeFile(join(decoy.cwd, "decoy-only.txt"), "different repository content\n");
    git(decoy.cwd, "add", "decoy-only.txt");
    git(decoy.cwd, "commit", "--quiet", "-m", "decoy content");
    const packet = JSON.parse(invokeWithEnvironment(target.cwd, {
      ...process.env,
      GIT_DIR: join(decoy.cwd, ".git"),
      GIT_WORK_TREE: decoy.cwd,
      gIt_OpTiOnAl_LoCkS: "0",
    }, "--base", target.base, "--head", target.head));
    assert.equal(packet.base, target.base);
    assert.equal(packet.head, target.head);
    assert.deepEqual(packet.changedFiles, [{ path: "added.txt", status: "A" }, { path: "tracked.txt", status: "M" }]);
  } finally {
    await rm(target.cwd, { recursive: true, force: true });
    await rm(decoy.cwd, { recursive: true, force: true });
  }
});

test("review packet ignores inherited Git trace destinations, including a symlink", async (t) => {
  const fixture = await repository();
  const outside = await mkdtemp(join(tmpdir(), "pi-scoped-review-trace-"));
  const marker = join(outside, "marker.log");
  const traceLink = join(fixture.cwd, "trace-target");
  try {
    await writeFile(marker, "must not change\n");
    try { await symlink(marker, traceLink, "file"); } catch (error) { t.skip(`symlinks unavailable: ${error.code}`); return; }
    const packet = JSON.parse(invokeWithEnvironment(fixture.cwd, {
      ...process.env,
      GIT_TRACE: traceLink,
      GIT_TRACE2: traceLink,
      GIT_TRACE2_EVENT: traceLink,
      GIT_TRACE2_NORMAL: traceLink,
      GIT_TRACE2_PERF: traceLink,
    }, "--base", fixture.base, "--head", fixture.head));
    assert.equal(packet.base, fixture.base);
    assert.equal(packet.head, fixture.head);
    assert.equal(await readFile(marker, "utf8"), "must not change\n");
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("review packet supplies committed base/head immutable blobs for truncated added, modified, and deleted paths", async () => {
  const fixture = await repository();
  try {
    const large = (label) => `${label}\n${"x".repeat(9_000)}\n`;
    const range = await committedRange(fixture.cwd, { base: { "range-deleted.txt": large("deleted base"), "range-modified.txt": large("modified base") }, head: { "range-added.txt": large("added head"), "range-modified.txt": large("modified head") } });
    const packet = JSON.parse(invoke(fixture.cwd, "--base", range.base, "--head", range.head));
    assert.deepEqual(packet.omittedHunks, ["range-added.txt", "range-deleted.txt", "range-modified.txt"]);
    assert.deepEqual(packet.immutableMaterial.map(({ path }) => path), packet.omittedHunks);
    const added = immutable(packet, "range-added.txt");
    assert.equal(added.status, "A"); assert.equal(added.base, null); assert.match(added.head.content, /added head/);
    const deleted = immutable(packet, "range-deleted.txt");
    assert.equal(deleted.status, "D"); assert.match(deleted.base.content, /deleted base/); assert.equal(deleted.head, null);
    const modified = immutable(packet, "range-modified.txt");
    assert.equal(modified.status, "M"); assert.match(modified.base.content, /modified base/); assert.match(modified.head.content, /modified head/);
    for (const material of packet.immutableMaterial) for (const endpoint of [material.base, material.head]) if (endpoint) {
      assert.equal(git(fixture.cwd, "cat-file", "blob", endpoint.objectId), endpoint.content.trimEnd());
    }
    await writeFile(join(fixture.cwd, "range-added.txt"), "mutable checkout tampering\n");
    await writeFile(join(fixture.cwd, "range-modified.txt"), "mutable checkout tampering\n");
    await writeFile(join(fixture.cwd, "range-deleted.txt"), "mutable checkout tampering\n");
    assert.doesNotMatch(JSON.stringify(packet.immutableMaterial), /mutable checkout tampering/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet fails closed when immutable material exceeds fixed packet bounds", async () => {
  const fixture = await repository();
  try {
    const range = await committedRange(fixture.cwd, { base: { "large.txt": "base\n" }, head: { "large.txt": `${"x".repeat(24 * 1024 + 1)}\n` } });
    assert.throws(() => invoke(fixture.cwd, "--base", range.base, "--head", range.head), /large\.txt cannot embed immutable material: head committed blob exceeds 24576 bytes; produce a smaller range/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet embeds immutable endpoints for hunk-count omission", async () => {
  const fixture = await repository();
  try {
    const lines = Array.from({ length: 48 }, (_, index) => `line ${index}`).join("\n");
    await writeFile(join(fixture.cwd, "many-hunks.txt"), `${lines}\n`); git(fixture.cwd, "add", "many-hunks.txt"); git(fixture.cwd, "commit", "--quiet", "-m", "many hunks base");
    const base = git(fixture.cwd, "rev-parse", "HEAD");
    const changed = Array.from({ length: 48 }, (_, index) => index % 8 ? `line ${index}` : `changed ${index}`).join("\n");
    await writeFile(join(fixture.cwd, "many-hunks.txt"), `${changed}\n`); git(fixture.cwd, "add", "many-hunks.txt"); git(fixture.cwd, "commit", "--quiet", "-m", "many hunks head");
    const packet = JSON.parse(invoke(fixture.cwd, "--base", base, "--head", git(fixture.cwd, "rev-parse", "HEAD")));
    assert.deepEqual(packet.omittedHunks, ["many-hunks.txt"]);
    assert.deepEqual(packet.byteTruncatedHunks, []);
    const material = immutable(packet, "many-hunks.txt");
    assert.equal(material.status, "M"); assert.match(material.base.content, /line 0/); assert.match(material.head.content, /changed 0/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet rejects oversized committed changes", async () => {
  const fixture = await repository();
  try {
    await writeFile(join(fixture.cwd, "oversized.txt"), "x".repeat(128 * 1024 + 1)); git(fixture.cwd, "add", "oversized.txt"); git(fixture.cwd, "commit", "--quiet", "-m", "oversized");
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.base, "--head", git(fixture.cwd, "rev-parse", "HEAD")), /review-packet: oversized\.txt exceeds 131072 bytes/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet rejects the removed filesystem-output contract", async () => {
  const fixture = await repository();
  try {
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.base, "--head", fixture.head, "--output", ".review/packet.json"), /review-packet: expected supported option/);
    const previous = process.cwd(); process.chdir(fixture.cwd);
    try { await assert.rejects(generateReviewPacket({ base: fixture.base, head: fixture.head, output: ".review/packet.json" }), /filesystem output is unsupported/); } finally { process.chdir(previous); }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
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
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet rejects binary committed changes", async () => {
  const fixture = await repository();
  try {
    await writeFile(join(fixture.cwd, "binary.bin"), Buffer.from([0, 1, 2])); git(fixture.cwd, "add", "binary.bin"); git(fixture.cwd, "commit", "--quiet", "-m", "binary");
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.base, "--head", git(fixture.cwd, "rev-parse", "HEAD")), /review-packet: binary\.bin is binary/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet enforces file and validation-payload bounds", async () => {
  const fixture = await repository();
  try {
    for (let index = 0; index < 201; index += 1) await writeFile(join(fixture.cwd, `cap-${index}.txt`), "x\n");
    git(fixture.cwd, "add", "."); git(fixture.cwd, "commit", "--quiet", "-m", "file cap");
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.head, "--head", git(fixture.cwd, "rev-parse", "HEAD")), /changed-file list exceeds bounds/);
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.base, "--head", fixture.head, "--validation", "x".repeat(4097)), /validation is missing, unsafe, or exceeds its bound/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("scoped reviewer template enforces immutable packet-only incomplete review", async () => {
  const template = await readFile(join(root, ".pi", "agents", "scoped-reviewer.md"), "utf8");
  assert.match(template, /^name: scoped-reviewer$/m); assert.match(template, /^tools: read$/m); assert.match(template, /^thinking: medium$/m); assert.match(template, /^defaultContext: fresh$/m);
  assert.match(template, /immutableMaterial/i); assert.match(template, /not.*working tree|never.*working tree/i); assert.match(template, /Do not read\s+working-tree source, direct imports/i);
  assert.match(template, /untracked files,\s+history outside the packet range, environment data, credentials, sessions/i);
  assert.match(template, /Report only \*\*blocker\*\* or \*\*high\*\* findings/i); assert.match(template, /High-reasoning escalation/i);
});
