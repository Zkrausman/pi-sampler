import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrls = [
  new URL("../.agents/skills/create-implementation-plan/SKILL.md", import.meta.url),
  new URL("../.agents/skills/create-implementation-plan-team/SKILL.md", import.meta.url),
];

for (const skillUrl of skillUrls) {
  test(`${skillUrl.pathname.split("/").at(-2)} provisions a purpose-scoped planning worktree`, async () => {
    const skill = await readFile(skillUrl, "utf8");

    assert.match(skill, /npm run delivery:worktree -- prepare --purpose plan --profile <approved-profile> --work-item \[TICKET-ID\] --slug implementation-plan/i);
    assert.match(skill, /configured worktree root's `plan\/` subfolder/i);
    assert.match(skill, /returned worktree/i);
    assert.match(skill, /branch, base SHA, lease ID, and lease token/i);
    assert.match(skill, /never handcraft `git worktree add`/i);
    assert.doesNotMatch(skill, /squire prep/i);
    assert.doesNotMatch(skill, /cd \.\.\/ai-workspaces\/\[TICKET-ID\]/i);
  });
}
