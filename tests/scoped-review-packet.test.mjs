import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const generator = join(root, "scripts", "generate-review-packet.mjs");
const {
  generateReviewPacketV2,
  generateReviewPacketV3,
  reconstructV3Hunk,
  safeChangedPath,
  serializeReviewPacketV2,
  serializeReviewPacketV3,
} = await import(pathToFileURL(generator).href);
const packetValidator = join(root, "scripts", "validate-review-packet.mjs");
const {
  assertValidReviewPacketSchema,
  scopedReviewPacketV3Schema,
  validateReviewPacket,
  validateReviewPacketAgainstGit,
  validateReviewPacketStructure,
} = await import(pathToFileURL(packetValidator).href);

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
  await writeFile(join(cwd, "tracked.txt"), `${Array.from({ length: 20 }, (_, index) => `changed ${index}`).join("\n")}\n${"x".repeat(7_000)}\n`);
  await writeFile(join(cwd, "added.txt"), "committed addition\n");
  git(cwd, "add", "tracked.txt", "added.txt");
  git(cwd, "commit", "--quiet", "-m", "head");
  const head = git(cwd, "rev-parse", "HEAD");
  await writeFile(join(cwd, "untracked-secret.txt"), "must never appear\n");
  return { cwd, base, head };
}

function invoke(cwd, ...args) {
  return execFileSync(process.execPath, [generator, "--version", "2", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function invokeV3(cwd, ...args) {
  return execFileSync(process.execPath, [generator, "--version", "3", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function invokeWithEnvironment(cwd, environment, ...args) {
  return execFileSync(process.execPath, [generator, ...args], { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function validateCli(cwd, packet, ...args) {
  return spawnSync(process.execPath, [packetValidator, ...args], { cwd, input: packet, encoding: "utf8" });
}
function refreshLineDigest(line) {
  const value = line.segments.join("");
  line.byteLength = Buffer.byteLength(value, "utf8");
  line.sha256 = createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
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

async function commitFile(cwd, filePath, content, message) {
  await writeFile(join(cwd, filePath), content);
  git(cwd, "add", "--", filePath);
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function generatedLockfile({ nodeEngine = ">=22", padding = 0, rootDependencies } = {}) {
  const packages = {
    "": {
      name: "pi-sampler", version: "0.1.0", engines: { node: nodeEngine },
      ...(rootDependencies === undefined ? {} : { dependencies: rootDependencies }),
    },
  };
  for (let index = 0; index < padding; index += 1) packages[`node_modules/package-${index}`] = {
    version: "1.0.0",
    resolved: `https://registry.npmjs.org/package-${index}/-/package-${index}-1.0.0.tgz`,
    integrity: `sha512-${createHash("sha512").update(`package-${index}`).digest("base64")}`,
  };
  return `${JSON.stringify({ name: "pi-sampler", version: "0.1.0", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
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

test("review packet is deterministic, bounded, stdout-only, and contains complete Git hunks", async () => {
  const fixture = await repository();
  try {
    const args = ["--base", fixture.base, "--head", fixture.head, "--validation", "targeted test: passed"];
    const first = invoke(fixture.cwd, ...args);
    const second = invoke(fixture.cwd, ...args);
    assert.equal(second, first);
    const packet = JSON.parse(first);
    assert.equal(packet.format, "pi-sampler.scoped-review-packet.v2");
    assert.equal(packet.base, fixture.base);
    assert.equal(packet.head, fixture.head);
    assert.deepEqual(packet.changedFiles, [{ path: "added.txt", status: "A" }, { path: "tracked.txt", status: "M" }]);
    assert.match(packet.diffStat, /added\.txt/);
    assert.doesNotMatch(first, /untracked-secret|must never appear/);
    assert.ok(packet.patches.every((patch) => packet.changedFiles.some((file) => file.path === patch.path)));
    assert.ok(packet.patches.every((patch) => patch.hunks.length <= 64 && patch.hunks.every((hunk) => Buffer.byteLength(hunk) <= 64 * 1024)));
    assert.equal(Buffer.byteLength(first, "utf8"), Buffer.byteLength(serializeReviewPacketV2(packet), "utf8"));
    assert.equal(packet.incomplete, false);
    assert.deepEqual(packet.omittedHunks, []);
    assert.deepEqual(packet.byteTruncatedHunks, []);
    assert.deepEqual(packet.immutableMaterial, []);
    assert.doesNotMatch(JSON.stringify(packet), /hunk truncated by review-packet bound/);
    await assert.rejects(lstat(join(fixture.cwd, ".review", "packet.json")), { code: "ENOENT" });
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet applies no-replace-objects to every Git invocation and disables external diff/textconv", async () => {
  const fixture = await repository();
  try {
    const commands = [];
    const previous = process.cwd();
    process.chdir(fixture.cwd);
    try { await generateReviewPacketV2({ base: fixture.base, head: fixture.head }, { onGitCommand: (args) => commands.push(args) }); } finally { process.chdir(previous); }
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

test("review packet fully represents 406-line workspace and viewer-sized hunks within the raised byte bound", async () => {
  const fixture = await repository();
  try {
    const workspaceSource = Array.from({ length: 406 }, (_, index) => `export const workspaceLine${index} = "${"w".repeat(45)}";`).join("\n") + "\n";
    const viewerSource = Array.from({ length: 406 }, (_, index) => `const viewerEntry${index} = "${"v".repeat(95)}";`).join("\n") + "\n";
    const range = await committedRange(fixture.cwd, {
      base: { "baseline.txt": "base\n" },
      head: { "baseline.txt": "base\n", "workspace-source.mjs": workspaceSource, "viewer.mjs": viewerSource },
    });
    const packet = JSON.parse(invoke(fixture.cwd, "--base", range.base, "--head", range.head));
    const workspaceHunk = packet.patches.find(({ path }) => path === "workspace-source.mjs").hunks[0];
    const viewerHunk = packet.patches.find(({ path }) => path === "viewer.mjs").hunks[0];
    assert.equal(workspaceSource.trimEnd().split("\n").length, 406);
    for (const hunk of [workspaceHunk, viewerHunk]) assert.ok(Buffer.byteLength(hunk, "utf8") > 8 * 1024 && Buffer.byteLength(hunk, "utf8") <= 64 * 1024);
    assert.match(workspaceHunk, /\+export const workspaceLine0/); assert.match(workspaceHunk, /\+export const workspaceLine405/);
    assert.match(viewerHunk, /\+const viewerEntry0/); assert.match(viewerHunk, /\+const viewerEntry405/);
    assert.equal(packet.incomplete, false); assert.deepEqual(packet.omittedHunks, []); assert.deepEqual(packet.byteTruncatedHunks, []); assert.deepEqual(packet.immutableMaterial, []);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet fails closed by UTF-8 bytes, not JavaScript character count, above the raised hunk bound", async () => {
  const fixture = await repository();
  try {
    const multibyteLine = `${"🧪".repeat(16 * 1024)}\n`;
    assert.ok(multibyteLine.length < 64 * 1024); assert.ok(Buffer.byteLength(multibyteLine, "utf8") > 64 * 1024);
    const range = await committedRange(fixture.cwd, { base: { "large-hunk.txt": "before\n" }, head: { "large-hunk.txt": multibyteLine } });
    assert.throws(() => invoke(fixture.cwd, "--base", range.base, "--head", range.head), /large-hunk\.txt patch hunk 1 exceeds the fixed 65536-byte review-packet bound/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet fully covers many small hunks in a large source blob without disclosing endpoints", async () => {
  const fixture = await repository();
  try {
    const source = Array.from({ length: 400 }, (_, index) => `export const line${index} = "${"x".repeat(170)}";`).join("\n") + "\n";
    const base = await commitFile(fixture.cwd, "large-source.mjs", source, "large source base");
    const changed = source.split("\n");
    const changedIndexes = Array.from({ length: 50 }, (_, index) => index * 8 + 7);
    for (const index of changedIndexes) changed[index] = changed[index].replace('"x', '"y');
    const headSource = changed.join("\n");
    await commitFile(fixture.cwd, "large-source.mjs", headSource, "large source head");
    const packet = JSON.parse(invoke(fixture.cwd, "--base", base, "--head", git(fixture.cwd, "rev-parse", "HEAD")));
    const patch = packet.patches.find(({ path }) => path === "large-source.mjs");
    assert.ok(Buffer.byteLength(source) > 24 * 1024);
    assert.equal(patch.hunks.length, changedIndexes.length);
    for (const index of changedIndexes) {
      assert.ok(patch.hunks.some((hunk) => hunk.includes(`-export const line${index} = "x`)));
      assert.ok(patch.hunks.some((hunk) => hunk.includes(`+export const line${index} = "y`)));
    }
    assert.equal(packet.incomplete, false);
    assert.deepEqual(packet.omittedHunks, []);
    assert.deepEqual(packet.byteTruncatedHunks, []);
    assert.deepEqual(packet.immutableMaterial, []);
    assert.doesNotMatch(JSON.stringify(packet), /"content":/);
    assert.equal(JSON.stringify(packet).includes(source), false);
    assert.equal(JSON.stringify(packet).includes(headSource), false);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet fails closed when hunk count exceeds complete coverage bound", async () => {
  const fixture = await repository();
  try {
    const lineCount = 520;
    const lines = Array.from({ length: lineCount }, (_, index) => `line ${index}`).join("\n");
    const base = await commitFile(fixture.cwd, "excess-hunks.txt", `${lines}\n`, "excess hunks base");
    const changed = Array.from({ length: lineCount }, (_, index) => index % 8 === 7 ? `changed ${index}` : `line ${index}`).join("\n");
    await commitFile(fixture.cwd, "excess-hunks.txt", `${changed}\n`, "excess hunks head");
    assert.throws(() => invoke(fixture.cwd, "--base", base, "--head", git(fixture.cwd, "rev-parse", "HEAD")), /excess-hunks\.txt has 65 patch hunks, exceeding the fixed 64-hunk review-packet bound/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet fails closed when complete hunk coverage exceeds a path total", async () => {
  const fixture = await repository();
  try {
    const lineCount = 512;
    const baseLines = Array.from({ length: lineCount }, (_, index) => index % 8 === 7 ? "x".repeat(1_800) : "context");
    const base = await commitFile(fixture.cwd, "excess-patch-total.txt", `${baseLines.join("\n")}\n`, "patch total base");
    const headLines = baseLines.map((line, index) => index % 8 === 7 ? "y".repeat(1_800) : line);
    await commitFile(fixture.cwd, "excess-patch-total.txt", `${headLines.join("\n")}\n`, "patch total head");
    assert.throws(() => invoke(fixture.cwd, "--base", base, "--head", git(fixture.cwd, "rev-parse", "HEAD")), /excess-patch-total\.txt patch hunks exceed the fixed 131072-byte review-packet bound/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet fails closed when complete hunk coverage exceeds the aggregate resource bound", async () => {
  const fixture = await repository();
  try {
    const head = { "baseline.txt": "base\n" };
    for (let index = 0; index < 13; index += 1) head[`aggregate-${index}.txt`] = `${"x".repeat(60 * 1024)}\n`;
    const range = await committedRange(fixture.cwd, { base: { "baseline.txt": "base\n" }, head });
    assert.throws(() => invoke(fixture.cwd, "--base", range.base, "--head", range.head), /patch hunks exceed the fixed 786432-byte total review-packet bound/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet rejects a Git diff read that exceeds its separate resource bound", async () => {
  const fixture = await repository();
  try {
    let padding = 500;
    let lockfile = generatedLockfile({ padding });
    while (Buffer.byteLength(lockfile, "utf8") <= 384 * 1024) lockfile = generatedLockfile({ padding: padding += 50 });
    assert.ok(Buffer.byteLength(lockfile, "utf8") <= 512 * 1024);
    const range = await committedRange(fixture.cwd, { base: { "baseline.txt": "base\n" }, head: { "baseline.txt": "base\n", "package-lock.json": lockfile } });
    assert.throws(() => invoke(fixture.cwd, "--base", range.base, "--head", range.head), /git diff output exceeds the fixed 393216-byte review-packet bound/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet rejects oversized committed changes", async () => {
  const fixture = await repository();
  try {
    await writeFile(join(fixture.cwd, "oversized.txt"), "x".repeat(128 * 1024 + 1)); git(fixture.cwd, "add", "oversized.txt"); git(fixture.cwd, "commit", "--quiet", "-m", "oversized");
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.base, "--head", git(fixture.cwd, "rev-parse", "HEAD")), /review-packet: oversized\.txt exceeds 131072 bytes/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet strictly admits oversized canonical package locks but still requires complete hunks", async () => {
  const fixture = await repository();
  try {
    const lockfile = generatedLockfile({ padding: 500, rootDependencies: { "range-a": "18 || 20 || >=22", "range-b": "1.2.0 - 3" } });
    assert.ok(Buffer.byteLength(lockfile) > 128 * 1024);
    assert.ok(Buffer.byteLength(lockfile) < 512 * 1024);
    const range = await committedRange(fixture.cwd, { base: { "baseline.txt": "base\n" }, head: { "baseline.txt": "base\n", "package-lock.json": lockfile } });
    assert.throws(() => invoke(fixture.cwd, "--base", range.base, "--head", range.head), /package-lock\.json patch hunk 1 exceeds the fixed 65536-byte review-packet bound/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet rejects malformed, hidden, and oversized package-lock admission inputs", async () => {
  const cases = [
    ["noncanonical", () => `${generatedLockfile({ padding: 500 }).trimEnd()} `, /canonical npm-generated/],
    ["invalid dependency range", () => generatedLockfile({ padding: 500, rootDependencies: { "range-a": `${"1.2.3 ".repeat(35)}!` } }), /unsupported dependencies spec/],
    ["hidden dependency value", () => {
      const lockfile = JSON.parse(generatedLockfile({ padding: 500 }));
      lockfile.packages["node_modules/package-0"].dependencies = { package: { hidden: "x".repeat(64 * 1024) } };
      return `${JSON.stringify(lockfile, null, 2)}\n`;
    }, /unsupported dependencies/],
    ["over 512 KiB", () => generatedLockfile({ padding: 2_000 }), /exceeds 524288 bytes/],
  ];
  for (const [label, content, error] of cases) {
    const fixture = await repository();
    try {
      const lockfile = content();
      const range = await committedRange(fixture.cwd, { base: { "baseline.txt": "base\n" }, head: { "baseline.txt": "base\n", "package-lock.json": lockfile } });
      assert.throws(() => invoke(fixture.cwd, "--base", range.base, "--head", range.head), error, label);
    } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
  }
});

test("review packet rejects the removed filesystem-output contract", async () => {
  const fixture = await repository();
  try {
    assert.throws(() => invoke(fixture.cwd, "--base", fixture.base, "--head", fixture.head, "--output", ".review/packet.json"), /review-packet: expected supported option/);
    const previous = process.cwd(); process.chdir(fixture.cwd);
    try { await assert.rejects(generateReviewPacketV3({ base: fixture.base, head: fixture.head, output: ".review/packet.json" }), /filesystem output is unsupported/); } finally { process.chdir(previous); }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("review packet never follows a parent-directory symlink because it performs no filesystem publication", async (t) => {
  const fixture = await repository();
  try {
    const outside = await mkdtemp(join(tmpdir(), "pi-scoped-review-outside-"));
    await writeFile(join(outside, "marker.json"), "must not change");
    try { await symlink(outside, join(fixture.cwd, ".review"), "dir"); } catch (error) { await rm(outside, { recursive: true, force: true }); t.skip(`symlinks unavailable: ${error.code}`); return; }
    const packet = JSON.parse(invoke(fixture.cwd, "--base", fixture.base, "--head", fixture.head));
    assert.equal(packet.format, "pi-sampler.scoped-review-packet.v2");
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

test("v3 packet is the default and keeps a representative multiline hunk line-readable", async () => {
  const fixture = await repository();
  try {
    const source = Array.from({ length: 500 }, (_, index) => `export const readable${index} = "${"x".repeat(95)}";`).join("\n") + "\n";
    const range = await committedRange(fixture.cwd, {
      base: { "baseline.txt": "base\n" },
      head: { "baseline.txt": "base\n", "line-readable.mjs": source },
    });
    const output = execFileSync(process.execPath, [generator, "--base", range.base, "--head", range.head], { cwd: fixture.cwd, encoding: "utf8" });
    const packet = JSON.parse(output);
    assert.equal(packet.format, "pi-sampler.scoped-review-packet.v3");
    const result = validateReviewPacketStructure(output);
    assert.equal(result.ok, true, result.errors?.join("; "));
    const hunk = packet.patches.find(({ path }) => path === "line-readable.mjs").hunks[0];
    assert.ok(Buffer.byteLength(reconstructV3Hunk(hunk), "utf8") > 55 * 1024);
    assert.ok(hunk.logicalLines.every((line) => line.segments.length <= 64));
    assert.ok(Math.max(...output.trimEnd().split("\n").map((line) => Buffer.byteLength(line, "utf8"))) <= 4 * 1024);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

function gitRaw(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function rawHunks(diff) {
  const starts = [];
  const header = /^@@ /gm;
  let match;
  while ((match = header.exec(diff)) !== null) starts.push(match.index);
  assert.ok(starts.length, "raw Git diff must contain a hunk");
  return starts.map((start, index) => diff.slice(start, starts[index + 1] ?? diff.length));
}

test("v3 preserves exact Git hunk bytes and non-final LF terminators", async () => {
  const fixture = await repository();
  try {
    const baseLines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const headLines = [...baseLines];
    headLines[1] = "line 1 changed";
    headLines[25] = "line 25 changed";
    const range = await committedRange(fixture.cwd, {
      base: { "multi-hunk.txt": `${baseLines.join("\n")}\n` },
      head: { "multi-hunk.txt": `${headLines.join("\n")}\n` },
    });
    const raw = gitRaw(fixture.cwd, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", range.base, range.head, "--", "multi-hunk.txt");
    const packet = await generateReviewPacketV3({ base: range.base, head: range.head }, { cwd: fixture.cwd });
    const patch = packet.patches.find(({ path }) => path === "multi-hunk.txt");
    assert.equal(patch.hunks.length, 2);
    assert.deepEqual(patch.hunks.map(reconstructV3Hunk), rawHunks(raw));
    assert.ok(patch.hunks.slice(0, -1).every((hunk) => reconstructV3Hunk(hunk).endsWith("\n")));
    assert.ok(patch.hunks.some((hunk) => hunk.logicalLines.some((line) => line.segments.join("").startsWith(" "))));
    assert.ok(patch.hunks.some((hunk) => hunk.logicalLines.some((line) => line.segments.join("").startsWith("-"))));
    assert.ok(patch.hunks.some((hunk) => hunk.logicalLines.some((line) => line.segments.join("").startsWith("+"))));
    const result = await validateReviewPacketAgainstGit(packet, { base: range.base, head: range.head, cwd: fixture.cwd });
    assert.equal(result.ok, true, result.errors?.join("; "));
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("v3 rejects self-consistent missing, duplicated, embedded, or reordered terminators", async () => {
  const fixture = await repository();
  try {
    const baseLines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const headLines = [...baseLines];
    headLines[1] = "line 1 changed";
    headLines[25] = "line 25 changed";
    const range = await committedRange(fixture.cwd, {
      base: { "multi-hunk.txt": `${baseLines.join("\n")}\n` },
      head: { "multi-hunk.txt": `${headLines.join("\n")}\n` },
    });
    const packet = await generateReviewPacketV3({ base: range.base, head: range.head }, { cwd: fixture.cwd });
    const firstHunk = packet.patches[0].hunks[0];
    const mutate = (change) => {
      const candidate = structuredClone(packet);
      change(candidate.patches[0].hunks[0].logicalLines);
      for (const line of candidate.patches[0].hunks[0].logicalLines) refreshLineDigest(line);
      return validateReviewPacketStructure(candidate);
    };
    assert.equal(mutate((lines) => {
      const line = lines.at(-1);
      line.segments = [line.segments.join("").slice(0, -1)];
    }).ok, false, "a non-final hunk may not lose its final LF");
    assert.equal(mutate((lines) => {
      const line = lines.find((candidate) => candidate.segments.join("").endsWith("\n"));
      const value = line.segments.join("");
      line.segments = [`${value}\n`];
    }).ok, false, "a logical line may not contain a duplicated LF");
    assert.equal(mutate((lines) => {
      const line = lines.find((candidate) => candidate.segments.join("").endsWith("\n"));
      const value = line.segments.join("");
      line.segments = [`${value.slice(0, -1)}\nembedded`];
    }).ok, false, "a logical line may not contain an embedded LF");
    assert.equal(mutate((lines) => {
      const first = lines[0].segments.join("");
      const second = lines[1].segments.join("");
      lines[0].segments = [first.slice(0, -1)];
      lines[1].segments = [`\n${second}`];
    }).ok, false, "line terminators may not be reordered");
    assert.equal(firstHunk.logicalLines.at(-1).segments.join("").endsWith("\n"), true);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("v3 preserves explicit no-newline-at-EOF markers", async () => {
  const fixture = await repository();
  try {
    const range = await committedRange(fixture.cwd, {
      base: { "no-newline.txt": "old" },
      head: { "no-newline.txt": "new" },
    });
    const raw = gitRaw(fixture.cwd, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", range.base, range.head, "--", "no-newline.txt");
    const packet = await generateReviewPacketV3({ base: range.base, head: range.head }, { cwd: fixture.cwd });
    const hunk = packet.patches.find(({ path }) => path === "no-newline.txt").hunks[0];
    assert.deepEqual([reconstructV3Hunk(hunk)], rawHunks(raw));
    assert.equal(hunk.logicalLines.filter((line) => line.segments.join("") === "\\ No newline at end of file\n").length, 2);
    const valid = await validateReviewPacketAgainstGit(packet, { base: range.base, head: range.head, cwd: fixture.cwd });
    assert.equal(valid.ok, true, valid.errors?.join("; "));
    const malformed = structuredClone(packet);
    const marker = malformed.patches[0].hunks[0].logicalLines.find((line) => line.segments.join("").startsWith("\\ No newline"));
    marker.segments = [marker.segments.join("").slice(0, -1)];
    refreshLineDigest(marker);
    assert.equal(validateReviewPacketStructure(malformed).ok, false, "a marker without its Git output terminator must fail");
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("v2 serialization and digest remain frozen", () => {
  const packet = {
    format: "pi-sampler.scoped-review-packet.v2",
    base: "a".repeat(40),
    head: "b".repeat(40),
    changedFiles: [{ path: "tracked.txt", status: "M" }],
    diffStat: " tracked.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
    patches: [{ path: "tracked.txt", hunks: ["@@ -1 +1 @@\n-old\n+new\n"] }],
    incomplete: false,
    omittedHunks: [],
    byteTruncatedHunks: [],
    immutableMaterial: [],
  };
  assert.equal(serializeReviewPacketV2(packet), `${JSON.stringify(packet, null, 2)}\n`);
  assert.equal(createHash("sha256").update(serializeReviewPacketV2(packet), "utf8").digest("hex"), "31bdc04ba25a5610c7622541446ca171459546f5fb51fed35b9976c451f73ae6");
});

function packetLine(value) {
  const line = { segments: [value], byteLength: 0, sha256: "" };
  refreshLineDigest(line);
  return line;
}
function canonicalPacketBytes(packet) {
  for (const patch of packet.patches) for (const hunk of patch.hunks) for (const line of hunk.logicalLines) refreshLineDigest(line);
  return serializeReviewPacketV3(packet);
}

test("v3 accepts old-only, new-only, both-side, and context EOF markers", async () => {
  const lf = String.fromCharCode(10);
  const marker = `${String.fromCharCode(92)} No newline at end of file${lf}`;
  const cases = [
    ["old-only", "old", `old${lf}`, ["-"]],
    ["new-only", `old${lf}`, "new", ["+"]],
    ["both-side", "old", "new", ["-", "+"]],
    ["context", `before${lf}context`, `after${lf}context`, [" "]],
  ];
  for (const [name, baseContent, headContent, expectedPrefixes] of cases) {
    const fixture = await repository();
    try {
      const range = await committedRange(fixture.cwd, { base: { "marker-shapes.txt": baseContent }, head: { "marker-shapes.txt": headContent } });
      const packet = await generateReviewPacketV3({ base: range.base, head: range.head }, { cwd: fixture.cwd });
      const hunk = packet.patches.find(({ path }) => path === "marker-shapes.txt").hunks[0];
      const lines = hunk.logicalLines.map((line) => line.segments.join(""));
      const markerPrefixes = lines.flatMap((line, index) => line === marker ? [lines[index - 1][0]] : []);
      assert.deepEqual(markerPrefixes, expectedPrefixes, name);
      assert.equal(validateReviewPacketStructure(serializeReviewPacketV3(packet)).ok, true, name);
      const bound = await validateReviewPacketAgainstGit(packet, { base: range.base, head: range.head, cwd: fixture.cwd });
      assert.equal(bound.ok, true, `${name}: ${bound.errors?.join("; ")}`);
    } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
  }
});

test("v3 rejects canonical duplicated, moved, and reordered EOF markers", async () => {
  const lf = String.fromCharCode(10);
  const marker = `${String.fromCharCode(92)} No newline at end of file${lf}`;
  const contextFixture = await repository();
  const reorderedFixture = await repository();
  try {
    const contextRange = await committedRange(contextFixture.cwd, {
      base: { "marker-shapes.txt": `before${lf}context` },
      head: { "marker-shapes.txt": `after${lf}context` },
    });
    const contextPacket = await generateReviewPacketV3({ base: contextRange.base, head: contextRange.head }, { cwd: contextFixture.cwd });
    const contextHunk = contextPacket.patches[0].hunks[0];
    const plusIndex = contextHunk.logicalLines.findIndex((line) => line.segments.join("").startsWith("+"));
    const originalMarkerIndex = contextHunk.logicalLines.findIndex((line) => line.segments.join("") === marker);
    assert.ok(plusIndex >= 0); assert.ok(originalMarkerIndex > plusIndex);

    const insertedDuplicate = structuredClone(contextPacket);
    insertedDuplicate.patches[0].hunks[0].logicalLines.splice(plusIndex + 1, 0, packetLine(marker));
    const movedAfterContent = structuredClone(contextPacket);
    const [movedMarker] = movedAfterContent.patches[0].hunks[0].logicalLines.splice(originalMarkerIndex, 1);
    const movedPlusIndex = movedAfterContent.patches[0].hunks[0].logicalLines.findIndex((line) => line.segments.join("").startsWith("+"));
    movedAfterContent.patches[0].hunks[0].logicalLines.splice(movedPlusIndex + 1, 0, movedMarker);

    for (const [name, candidate] of [["inserted duplicate separated by context", insertedDuplicate], ["marker moved after content", movedAfterContent]]) {
      const canonical = canonicalPacketBytes(candidate);
      assert.equal(validateReviewPacketStructure(canonical).ok, false, name);
      const bound = await validateReviewPacketAgainstGit(canonical, { base: contextRange.base, head: contextRange.head, cwd: contextFixture.cwd });
      assert.equal(bound.ok, false, `${name} must fail exact Git binding`);
    }

    const rawDisagreement = structuredClone(contextPacket);
    const rawLine = rawDisagreement.patches[0].hunks[0].logicalLines.find((line) => line.segments.join("").startsWith("+"));
    const rawValue = rawLine.segments.join("");
    rawLine.segments = [`${rawValue.slice(0, -1)}X${String.fromCharCode(10)}`];
    const rawBound = await validateReviewPacketAgainstGit(canonicalPacketBytes(rawDisagreement), { base: contextRange.base, head: contextRange.head, cwd: contextFixture.cwd });
    assert.equal(rawBound.ok, false, "a structurally valid packet with wrong raw bytes must fail exact binding");
    assert.match(rawBound.errors?.[0] ?? "", /trusted raw Git-derived v3 packet/);

    const reorderedRange = await committedRange(reorderedFixture.cwd, {
      base: { "marker-shapes.txt": `old1${lf}old2` },
      head: { "marker-shapes.txt": "new1" },
    });
    const reorderedPacket = await generateReviewPacketV3({ base: reorderedRange.base, head: reorderedRange.head }, { cwd: reorderedFixture.cwd });
    const reorderedHunk = reorderedPacket.patches[0].hunks[0];
    const oldLines = reorderedHunk.logicalLines.filter((line) => line.segments.join("").startsWith("-"));
    const newLine = reorderedHunk.logicalLines.find((line) => line.segments.join("").startsWith("+"));
    const markerLines = reorderedHunk.logicalLines.filter((line) => line.segments.join("") === marker);
    assert.equal(oldLines.length, 2); assert.ok(newLine); assert.equal(markerLines.length, 2);
    reorderedHunk.logicalLines = [oldLines[0], newLine, markerLines[1], oldLines[1], markerLines[0]];
    const reorderedCanonical = canonicalPacketBytes(reorderedPacket);
    assert.equal(validateReviewPacketStructure(reorderedCanonical).ok, false, "reordered old/new markers");
    const reorderedBound = await validateReviewPacketAgainstGit(reorderedCanonical, { base: reorderedRange.base, head: reorderedRange.head, cwd: reorderedFixture.cwd });
    assert.equal(reorderedBound.ok, false, "reordered old/new markers must fail exact Git binding");
    const { assertRawGitHunkBinding } = await import(pathToFileURL(packetValidator).href);
    await assert.rejects(() => assertRawGitHunkBinding(reorderedPacket, { base: reorderedRange.base, head: reorderedRange.head, cwd: reorderedFixture.cwd }), /trusted raw Git-derived v3 packet/);
  } finally {
    await Promise.all([rm(contextFixture.cwd, { recursive: true, force: true }), rm(reorderedFixture.cwd, { recursive: true, force: true })]);
  }
});

test("review packet rejects intermediate-length commit IDs", async () => {
  const fixture = await repository();
  try {
    for (const length of [41, 63]) {
      assert.throws(() => invokeV3(fixture.cwd, "--base", "a".repeat(length), "--head", fixture.head));
      assert.throws(() => invokeV3(fixture.cwd, "--base", fixture.base, "--head", "b".repeat(length)));
    }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("v3 validation requires trusted Git binding or digest and rejects forged ranges", async () => {
  const fixture = await repository();
  try {
    const output = invokeV3(fixture.cwd, "--base", fixture.base, "--head", fixture.head);
    const gitBound = validateCli(fixture.cwd, output, "--base", fixture.base, "--head", fixture.head);
    assert.equal(gitBound.status, 0, gitBound.stderr);
    const digest = createHash("sha256").update(output, "utf8").digest("hex");
    const digestBound = validateCli(fixture.cwd, output, "--digest", digest);
    assert.equal(digestBound.status, 0, digestBound.stderr);
    assert.equal(validateReviewPacket(JSON.parse(output)).ok, false, "unbound structural validation must not be acceptance");

    const nonexistent = validateCli(fixture.cwd, output, "--base", "0".repeat(40), "--head", fixture.head);
    assert.notEqual(nonexistent.status, 0, "nonexistent expected commits must fail");
    const reversed = validateCli(fixture.cwd, output, "--base", fixture.head, "--head", fixture.base);
    assert.notEqual(reversed.status, 0, "non-ancestor expected refs must fail");

    const forged = JSON.parse(output);
    const line = forged.patches.flatMap(({ hunks }) => hunks).flatMap(({ logicalLines }) => logicalLines).find((candidate) => candidate.segments.join("").startsWith("+"));
    assert.ok(line, "fixture must contain an addition");
    const characters = [...line.segments.join("")];
    const characterIndex = characters.findIndex((character, index) => index > 0 && /[A-Za-z]/.test(character));
    characters[characterIndex] = characters[characterIndex] === "x" ? "y" : "x";
    line.segments = [characters.join("")];
    refreshLineDigest(line);
    const forgedResult = validateCli(fixture.cwd, serializeReviewPacketV3(forged), "--base", fixture.base, "--head", fixture.head);
    assert.notEqual(forgedResult.status, 0, "recounted Git hunks must fail trusted validation");
    assert.match(forgedResult.stderr, /Git-derived v3 packet/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("v3 logical-line reconstruction is exact and hostile edits fail closed", async () => {
  const fixture = await repository();
  try {
    const source = `${"🧪".repeat(11_000)}\n`;
    const range = await committedRange(fixture.cwd, { base: { "before.txt": "before\n" }, head: { "before.txt": "before\n", "utf8.txt": source } });
    const previous = process.cwd();
    let packet;
    try { process.chdir(fixture.cwd); packet = await generateReviewPacketV3({ base: range.base, head: range.head }); } finally { process.chdir(previous); }
    const original = validateReviewPacketStructure(packet);
    assert.equal(original.ok, true, original.errors?.join("; "));
    const hunk = packet.patches.find(({ path }) => path === "utf8.txt").hunks[0];
    assert.equal(reconstructV3Hunk(hunk).includes("🧪"), true);
    assert.ok(hunk.logicalLines.some((line) => line.segments.length > 1), "multibyte line should use bounded transport segments");

    const tamper = (change) => {
      const candidate = structuredClone(packet);
      change(candidate.patches[0].hunks[0].logicalLines[0]);
      return validateReviewPacketStructure(candidate);
    };
    assert.equal(tamper((line) => { line.segments[0] = `-${line.segments[0].slice(1)}`; }).ok, false, "segment content tampering must fail");
    assert.equal(tamper((line) => { line.byteLength += 1; }).ok, false, "byte length tampering must fail");
    assert.equal(tamper((line) => { line.sha256 = "0".repeat(64); }).ok, false, "digest tampering must fail");
    const serialized = serializeReviewPacketV3(packet);
    assert.equal(validateReviewPacketStructure(serialized.replace('"format": "pi-sampler.scoped-review-packet.v3",', '"format": "pi-sampler.scoped-review-packet.v3",\n  "format": "pi-sampler.scoped-review-packet.v3",')).ok, false, "duplicate keys must fail");
    assert.equal(validateReviewPacketStructure(`${serialized} `).ok, false, "noncanonical trailing bytes must fail");
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("v3 segment boundaries are canonical even when alternate metadata is recomputed", async () => {
  const fixture = await repository();
  try {
    const source = `${"🧪".repeat(11_000)}\n`;
    const range = await committedRange(fixture.cwd, { base: { "before.txt": "before\n" }, head: { "before.txt": "before\n", "utf8.txt": source } });
    const packet = await generateReviewPacketV3({ base: range.base, head: range.head }, { cwd: fixture.cwd });
    const locate = (candidate) => candidate.patches.flatMap(({ hunks }) => hunks).flatMap(({ logicalLines }) => logicalLines).find((line) => line.segments.length > 2);
    assert.ok(locate(packet), "fixture must contain a multi-segment logical line");
    for (const kind of ["split", "merge", "reorder"]) {
      const candidate = structuredClone(packet);
      const line = locate(candidate);
      if (kind === "split") {
        const characters = [...line.segments[0]];
        const cut = Math.max(1, Math.floor(characters.length / 2));
        line.segments.splice(0, 1, characters.slice(0, cut).join(""), characters.slice(cut).join(""));
      } else if (kind === "merge") {
        line.segments.splice(0, 2, `${line.segments[0]}${line.segments[1]}`);
      } else {
        [line.segments[0], line.segments[1]] = [line.segments[1], line.segments[0]];
      }
      refreshLineDigest(line);
      if (kind !== "reorder") assert.equal(validateReviewPacketStructure(candidate).ok, false, `${kind} segmentation must fail canonical validation`);
      assert.equal((await validateReviewPacketAgainstGit(candidate, { base: range.base, head: range.head, cwd: fixture.cwd })).ok, false, `${kind} segmentation must fail trusted validation`);
    }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("v3 rejects rename admission and segment bombs", async () => {
  const fixture = await repository();
  try {
    await writeFile(join(fixture.cwd, "rename-source.txt"), "rename me\n");
    git(fixture.cwd, "add", "rename-source.txt"); git(fixture.cwd, "commit", "--quiet", "-m", "rename base");
    const base = git(fixture.cwd, "rev-parse", "HEAD");
    git(fixture.cwd, "mv", "rename-source.txt", "rename-target.txt"); git(fixture.cwd, "commit", "--quiet", "-m", "rename head");
    const head = git(fixture.cwd, "rev-parse", "HEAD");
    assert.throws(() => invokeV3(fixture.cwd, "--base", base, "--head", head), /renames|copies/);

    await writeFile(join(fixture.cwd, "unchanged-copy-source.txt"), "unchanged copy source\n");
    git(fixture.cwd, "add", "unchanged-copy-source.txt"); git(fixture.cwd, "commit", "--quiet", "-m", "copy source");
    const copyBase = git(fixture.cwd, "rev-parse", "HEAD");
    await writeFile(join(fixture.cwd, "unchanged-copy-target.txt"), "unchanged copy source\n");
    git(fixture.cwd, "add", "unchanged-copy-target.txt"); git(fixture.cwd, "commit", "--quiet", "-m", "copy target");
    const copyHead = git(fixture.cwd, "rev-parse", "HEAD");
    assert.throws(() => invokeV3(fixture.cwd, "--base", copyBase, "--head", copyHead), /renames|copies/, "unchanged-source copies must be rejected");

    const candidate = {
      format: "pi-sampler.scoped-review-packet.v3", base: "0".repeat(40), head: "1".repeat(40),
      changedFiles: [{ path: "safe.txt", status: "A" }], diffStat: "", patches: [{ path: "safe.txt", hunks: [{ header: "@@ -0,0 +1,1 @@", logicalLines: [{ segments: Array.from({ length: 65 }, () => "+x"), byteLength: 130, sha256: "0".repeat(64) }] }] }],
      incomplete: false, omittedHunks: [], byteTruncatedHunks: [], immutableMaterial: [],
    };
    assert.equal(validateReviewPacketStructure(candidate).ok, false);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("v3 schema validation checks the complete contract", async () => {
  const schema = scopedReviewPacketV3Schema();
  assert.doesNotThrow(() => assertValidReviewPacketSchema(schema));
  for (const fixture of [
    {},
    { $id: schema.$id, type: "object", additionalProperties: false },
    (() => { const value = structuredClone(schema); delete value.$defs.logicalLine; return value; })(),
    (() => { const value = structuredClone(schema); value.properties.changedFiles.maxItems = 1; return value; })(),
    (() => { const value = structuredClone(schema); value.$defs.changedFile.properties.status.enum = ["A", "C", "D", "M"]; return value; })(),
  ]) assert.throws(() => assertValidReviewPacketSchema(fixture), /full canonical contract/);
  const command = spawnSync(process.execPath, [packetValidator, "--schema"], { cwd: root, encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
});

test("scoped reviewer template requires complete packet-generated hunk evidence", async () => {
  const template = await readFile(join(root, ".pi", "agents", "scoped-reviewer.md"), "utf8");
  assert.match(template, /^name: scoped-reviewer$/m); assert.match(template, /^tools: read$/m); assert.match(template, /^thinking: medium$/m); assert.match(template, /^defaultContext: fresh$/m);
  assert.match(template, /64 complete hunks per path and 64 KiB\s+per hunk/i); assert.match(template, /per-path, aggregate, Git-diff, and serialized\s+packet limits/i);
  assert.match(template, /incomplete.*false/i); assert.match(template, /immutableMaterial.*empty/i); assert.match(template, /Do not read\s+working-tree source, direct imports/i);
  for (const boundary of [/untracked/i, /history outside the packet range/i, /environment data/i, /credentials/i, /sessions/i]) assert.match(template, boundary);
  assert.match(template, /segmented[\s\S]*chunks are not valid evidence/i);
  assert.match(template, /Report only \*\*blocker\*\* or \*\*high\*\* findings/i); assert.match(template, /High-reasoning escalation/i);
});
