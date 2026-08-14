import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const child = spawn("go", ["test", "-race", "./..."], {
  cwd: resolve(root, "governance"),
  shell: false,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Unable to run governance tests: ${error.message}`);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
