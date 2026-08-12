import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import test from "node:test";
import {
  defaultHindsightOutputPath,
  defaultHindsightReportDirectory,
  defaultHindsightReportFilename,
  resolveExplicitHindsightOutputPath,
  writeDefaultHindsightReport,
  writeHindsightReport,
} from "../extensions/conversation-catalog/src/hindsight-output.mjs";

const fixedNow = () => new Date("2025-02-03T04:05:06.789Z");

test("default hindsight directories use platform-native per-user data locations and fallbacks", () => {
  assert.equal(defaultHindsightReportDirectory({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, home: "C:\\Users\\Ada" }), win32.join("C:\\Users\\Ada\\AppData\\Local", "pi", "hindsight-reports"));
  assert.equal(defaultHindsightReportDirectory({ platform: "win32", env: { LOCALAPPDATA: " " }, home: "C:\\Users\\Ada" }), win32.join("C:\\Users\\Ada", ".pi", "hindsight-reports"));
  assert.equal(defaultHindsightReportDirectory({ platform: "darwin", env: {}, home: "/Users/ada" }), "/Users/ada/Library/Application Support/pi/hindsight-reports");
  assert.equal(defaultHindsightReportDirectory({ platform: "linux", env: { XDG_DATA_HOME: "/var/data/ada" }, home: "/home/ada" }), "/var/data/ada/pi/hindsight-reports");
  assert.equal(defaultHindsightReportDirectory({ platform: "freebsd", env: { XDG_DATA_HOME: "" }, home: "/home/ada" }), "/home/ada/.local/share/pi/hindsight-reports");
});

test("default filenames are unique, Windows-safe, and contain only the pseudonymous session reference", () => {
  const filename = defaultHindsightReportFilename("session-ab12", { now: fixedNow, uuid: () => "123e4567-e89b-12d3-a456-426614174000" });
  assert.equal(filename, "pi-hindsight-session-ab12-2025-02-03T04-05-06-789Z-123e4567-e89b-12d3-a456-426614174000.html");
  assert.match(filename, /^[^<>:"/\\|?*]+\.html$/);
  assert.doesNotMatch(filename, /project|raw-session-id|Ada/i);
  assert.notEqual(defaultHindsightReportFilename("session-ab12", { now: fixedNow, uuid: () => "one" }), defaultHindsightReportFilename("session-ab12", { now: fixedNow, uuid: () => "two" }));
  assert.equal(defaultHindsightOutputPath("session-ab12", { platform: "linux", env: {}, home: "/home/ada", now: fixedNow, uuid: () => "id" }), "/home/ada/.local/share/pi/hindsight-reports/pi-hindsight-session-ab12-2025-02-03T04-05-06-789Z-id.html");
});

test("explicit hindsight output paths retain cwd-relative and absolute resolution and html validation", () => {
  const cwd = resolve("project");
  assert.equal(resolveExplicitHindsightOutputPath("reports/one.html", cwd), resolve(cwd, "reports/one.html"));
  assert.equal(resolveExplicitHindsightOutputPath(resolve("outside.html"), cwd), resolve("outside.html"));
  assert.throws(() => resolveExplicitHindsightOutputPath("reports/one.txt", cwd), /must end in .html/);
});

test("safe writer rejects existing explicit targets and removes temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-hindsight-test-"));
  const outputPath = join(directory, "existing.html");
  await writeFile(outputPath, "original", "utf8");
  await assert.rejects(writeHindsightReport(outputPath, "replacement", { uuid: () => "temporary" }), /already exists/);
  assert.equal(await readFile(outputPath, "utf8"), "original");
  assert.deepEqual(await readdir(directory), ["existing.html"]);
});

test("default writer retries an improbable collision without overwriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-hindsight-test-"));
  const ids = ["collision", "fresh", "temporary-one", "temporary-two"];
  const uuid = () => ids.shift();
  const collidingPath = join(directory, defaultHindsightReportFilename("session-one", { now: fixedNow, uuid: () => "collision" }));
  await writeFile(collidingPath, "original", "utf8");
  const outputPath = await writeDefaultHindsightReport({ directory, reference: "session-one", html: "new", now: fixedNow, uuid });
  assert.equal(await readFile(collidingPath, "utf8"), "original");
  assert.equal(await readFile(outputPath, "utf8"), "new");
  assert.equal((await readdir(directory)).filter((name) => name.endsWith(".tmp")).length, 0);
});
