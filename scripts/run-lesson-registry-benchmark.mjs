import { spawnSync } from "node:child_process";
import process from "node:process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`unable to resolve trusted benchmark Git binding: ${args.join(" ")}`);
  return result.stdout.trim();
}

function optionValue(args, ...names) {
  for (let index = 0; index < args.length; index += 1) {
    if (names.includes(args[index])) return args[index + 1];
  }
  return undefined;
}

function requireSha(value, label) {
  if (!sha.test(value ?? "")) throw new Error(`${label} must be a lowercase immutable Git SHA`);
  return value;
}

try {
  const args = process.argv.slice(2);
  const base = requireSha(
    optionValue(args, "--base", "-base") ?? process.env.AIDEV_BENCHMARK_BASE_SHA ?? git("merge-base", "HEAD", "origin/main"),
    "benchmark base",
  );
  const head = requireSha(
    optionValue(args, "--head", "-head") ?? process.env.AIDEV_BENCHMARK_HEAD_SHA ?? git("rev-parse", "HEAD"),
    "benchmark head",
  );
  const script = resolve(root, "scripts/benchmark-lesson-registry-rebuild.mjs");
  const child = spawnSync(process.execPath, [script, ...args, "--base", base, "--head", head], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: "inherit",
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} catch (error) {
  console.error(`benchmark wrapper: ${error instanceof Error ? error.message : "failed"}`);
  process.exitCode = 1;
}
