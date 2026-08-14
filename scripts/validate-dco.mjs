import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const signoff = /^Signed-off-by:\s+[^<>\r\n]+\s+<[^<>\s\r\n]+>\s*$/im;

function runGit(args, { cwd }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("git", args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr || stdout}`));
    });
  });
}

async function resolveCommit(reference, { repositoryRoot, gitRunner }) {
  assert.equal(typeof reference, "string", "a base and head Git reference are required");
  assert.ok(reference.length > 0, "a base and head Git reference are required");
  const { stdout } = await gitRunner(["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`], { cwd: repositoryRoot });
  const commit = stdout.trim();
  assert.match(commit, /^[0-9a-f]{40}$/i, `Git reference did not resolve to a commit: ${reference}`);
  return commit;
}

/** Validate that every commit introduced by a pull request carries a DCO sign-off trailer. */
export async function validateDco({ repositoryRoot = root, baseRef, headRef = "HEAD", gitRunner = runGit } = {}) {
  const [baseCommit, headCommit] = await Promise.all([
    resolveCommit(baseRef, { repositoryRoot, gitRunner }),
    resolveCommit(headRef, { repositoryRoot, gitRunner }),
  ]);
  const { stdout } = await gitRunner(["rev-list", "--reverse", `${baseCommit}..${headCommit}`], { cwd: repositoryRoot });
  const commits = stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(commits.length > 0, "the pull request must introduce at least one commit");

  const missing = [];
  for (const commit of commits) {
    const message = (await gitRunner(["show", "-s", "--format=%B", commit], { cwd: repositoryRoot })).stdout;
    if (!signoff.test(message)) missing.push(commit);
  }
  assert.deepEqual(missing, [], `DCO sign-off missing from commit(s): ${missing.join(", ")}. Amend with git commit --amend --signoff.`);
  return commits;
}

function optionValue(option) {
  const index = process.argv.indexOf(option);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseRef = optionValue("--base") ?? process.env.DCO_BASE_REF;
  const headRef = optionValue("--head") ?? process.env.DCO_HEAD_REF ?? "HEAD";
  validateDco({ baseRef, headRef })
    .then((commits) => console.log(`DCO validated for ${commits.length} commit(s).`))
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    });
}
