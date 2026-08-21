import { spawnSync } from "node:child_process";
import process from "node:process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const pathFlags = new Set([
  "--manifest", "-manifest", "--acceptance-manifest", "-acceptance-manifest",
  "--acceptance-matrix", "-acceptance-matrix", "--benchmark-evidence", "-benchmark-evidence",
  "--waiver", "-waiver", "--trusted-config", "-trusted-config", "--replay-state", "-replay-state",
  "--repo-root", "-repo-root",
]);
const args = process.argv.slice(2);
const normalizedArgs = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  normalizedArgs.push(argument);
  if (pathFlags.has(argument) && index + 1 < args.length) {
    const value = args[++index];
    normalizedArgs.push(isAbsolute(value) ? value : resolve(root, value));
  }
}
if (!["--repo-root", "-repo-root"].some((flag) => args.includes(flag))) normalizedArgs.push("--repo-root", root);
const result = spawnSync("go", ["run", "./cmd/delivery-evidence-validator", ...normalizedArgs], {
  cwd: resolve(root, "governance"),
  encoding: "utf8",
  windowsHide: true,
  stdio: "inherit",
});
if (result.error) {
  console.error(`Unable to run delivery-evidence-validator: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
