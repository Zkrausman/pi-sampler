import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrls = [
  new URL("../.agents/skills/create-implementation-plan/SKILL.md", import.meta.url),
  new URL("../.agents/skills/create-implementation-plan-team/SKILL.md", import.meta.url),
];

const planningAgents = [
  { path: "codebase-researcher.md", thinking: "low" },
  { path: "lead-architect.md", thinking: "high" },
  { path: "adversarial-red-teamer.md", thinking: "high" },
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

test("active implementation planning guidance selects post-activation v3 and bootstrap-only v2", async () => {
  const skill = await readFile(skillUrls[0], "utf8");
  const plan = await readFile(new URL("../docs/techPlans/AIDEV-159-implementation-plan.md", import.meta.url), "utf8");
  assert.match(skill, /Post-activation.*v3 packet.*acceptance matrix.*verification evidence/s);
  assert.match(skill, /validateFinalReviewAttestation/);
  assert.match(skill, /Bootstrap.*v2.*packet-consistency marker/s);
  assert.match(skill, /revoked receipt invalidates an older marker/s);
  assert.match(skill, /pre-push hook invokes.*artifacts\/final-review\/receipt\.json/s);
  assert.doesNotMatch(skill, /pi-sampler-adversarial-review-attestation:v2 .*version.*2/);
  assert.match(plan, /^## Review Evidence Flow$/m);
  assert.match(plan, /missing, malformed, stale, or unbound v2 evidence fails/);
  assert.match(plan, /revalidates the rendered marker against that receipt/);
});

test("planning agents inherit a registered model and retain role-specific thinking", async () => {
  for (const agent of planningAgents) {
    const url = new URL(`../.agents/agents/${agent.path}`, import.meta.url);
    const definition = await readFile(url, "utf8");

    assert.doesNotMatch(definition, /^model:/m, `${agent.path} must not pin a runtime-specific model alias`);
    assert.match(definition, new RegExp(`^thinking: ${agent.thinking}$`, "m"));
  }

  const teamSkill = await readFile(skillUrls[1], "utf8");
  assert.doesNotMatch(teamSkill, /Model: [`']?(?:pro|flash)|`invoke_subagent`|inherits from the active Pi model registry/i);
  assert.match(teamSkill, /configured defaults or overrides, otherwise inheriting the parent session model/i);
});
