import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrl = new URL("../.agents/skills/project-delivery/SKILL.md", import.meta.url);

async function skillText() {
  return readFile(skillUrl, "utf8");
}

test("project delivery fails closed on dirty or shared worktrees", async () => {
  const skill = await skillText();

  assert.match(skill, /initial worktree must be clean/i);
  assert.match(skill, /Pre-existing tracked, staged, or untracked changes are an ownership conflict: stop/i);
  assert.match(skill, /Start a new run in a clean, dedicated worktree, complete these preconditions, and then apply the patch as that run's first owned mutation/i);
  assert.doesNotMatch(skill, /stop unless the user explicitly assigns/i);
  assert.match(skill, /one concurrent writer per worktree, not one writer per repository/i);
  assert.match(skill, /acquire a worktree-scoped writer lease/i);
  assert.match(skill, /explicit orchestration attestation that no other active writer uses the exact canonical worktree path/i);
  assert.match(skill, /If neither exclusivity mechanism is available, stop/i);
  assert.match(skill, /Do not use `git switch` or `git checkout` to repurpose a shared or active worktree/i);
  assert.match(skill, /stop immediately and report a concurrent-writer conflict/i);
  assert.match(skill, /do not switch back, copy the mixed files, or continue/i);
});

test("project delivery binds mutations and review to an explicit run identity", async () => {
  const skill = await skillText();

  for (const identityPart of ["repository root", "worktree path", "current branch", "base `HEAD`"]) {
    assert.ok(skill.includes(identityPart), `missing run identity field: ${identityPart}`);
  }

  assert.match(skill, /Before every source mutation and before final verification, re-check that identity/i);
  assert.match(skill, /Track the paths changed by this run/i);
  assert.match(skill, /After verification completes and immediately before reporting, re-check repository root, worktree path, branch, expected `HEAD`, status, and the owned-path inventory/i);
  assert.match(skill, /unexpected post-verification change[^\n]+blocks delivery/i);
  assert.match(skill, /Bind review and verification to an exact commit/i);
  assert.match(skill, /otherwise provide an explicit patch or snapshot and label it uncommitted/i);
});

test("project delivery distinguishes committed branches from uncommitted worktrees", async () => {
  const skill = await skillText();

  assert.match(skill, /implemented on branch[^\n]+only when the branch contains the reviewed implementation commit/i);
  assert.match(skill, /prepared as uncommitted changes/i);
  assert.match(skill, /Do not imply that the branch ref contains the changes/i);
  assert.match(skill, /Do not commit, publish, merge, or change a tracker status unless the user explicitly authorizes it/i);
});
