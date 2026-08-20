import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrl = new URL("../.agents/skills/project-delivery/SKILL.md", import.meta.url);

async function skillText() {
  return readFile(skillUrl, "utf8");
}

test("project delivery automatically provisions an exact leased worktree", async () => {
  const skill = await skillText();

  assert.match(skill, /npm run delivery:worktree -- prepare --profile <approved-profile> --work-item <WORK-ITEM>/i);
  assert.match(skill, /fetches the profile-declared base branch, resolves an immutable base commit/i);
  assert.match(skill, /generates a unique branch and worktree with a random suffix/i);
  assert.match(skill, /acquires a worktree-scoped writer lease/i);
  assert.match(skill, /--base <SHA>.*PI_DELIVERY_BASE_SHA/i);
  assert.match(skill, /Never handcraft `git worktree add`, infer a base from a ticket branch, or reuse a similarly named worktree/i);
  assert.match(skill, /perform every read, edit, command, and verification against the returned delivery worktree/i);
});

test("project delivery fails closed on dirty, shared, or changed worktrees", async () => {
  const skill = await skillText();

  assert.match(skill, /delivery worktree must initially be clean/i);
  assert.match(skill, /Pre-existing tracked, staged, or untracked changes are an ownership conflict/i);
  assert.match(skill, /one concurrent writer per worktree, not one writer per repository/i);
  assert.match(skill, /Before every source mutation and before final verification, re-check that identity/i);
  assert.match(skill, /Track the paths changed by this run/i);
  assert.match(skill, /lease ID, and lease token as the run identity/i);
  assert.match(skill, /do not switch back, copy mixed files, or continue/i);
  assert.match(skill, /unexpected post-verification change blocks delivery/i);
});

test("project delivery binds review, reporting, and cleanup to the artifact identity", async () => {
  const skill = await skillText();

  assert.match(skill, /Bind review and verification to an exact commit/i);
  assert.match(skill, /implemented on branch[^\n]+only when the branch contains the reviewed implementation commit/i);
  assert.match(skill, /prepared as uncommitted changes/i);
  assert.match(skill, /Do not imply that the branch ref contains the changes/i);
  assert.match(skill, /Do not commit, publish, merge, or change a tracker status unless the user explicitly authorizes it/i);
  assert.match(skill, /delivery:worktree -- cleanup --worktree <PATH> --lease <TOKEN> --delete-branch/i);
  assert.match(skill, /Cleanup fails closed for dirty worktrees, invalid leases, changed identities, and unmerged commits/i);
});
