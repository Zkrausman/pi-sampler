import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const policyUrl = new URL("docs/HERDR-DELEGATION.md", root);
const deliverySkillUrl = new URL(".agents/skills/project-delivery/SKILL.md", root);
const reviewSkillUrl = new URL(".agents/skills/project-code-review/SKILL.md", root);

async function text(url) {
  return readFile(url, "utf8");
}

function normalized(value) {
  return value.replace(/\s+/g, " ");
}

async function policyAndSkills() {
  const [policy, delivery, review] = await Promise.all([
    text(policyUrl),
    text(deliverySkillUrl),
    text(reviewSkillUrl),
  ]);
  return {
    policy: normalized(policy),
    delivery: normalized(delivery),
    review: normalized(review),
  };
}

test("Herdr policy pins the sole tab topology and role effort", async () => {
  const { policy } = await policyAndSkills();

  assert.match(policy, /one supported parent-level topology/i);
  assert.match(policy, /coordinating session is the \*\*Orchestrator\*\* tab/i);
  assert.match(policy, /separate \*\*Dev\*\* tab for each mutation-owning result/i);
  assert.match(policy, /pi --model openai-codex\/gpt-5\.6-luna --thinking max/);
  assert.match(policy, /separate \*\*Review\*\* tab for each independent review result/i);
  assert.match(policy, /pi --model openai-codex\/gpt-5\.6-sol --thinking medium/);
  assert.match(policy, /Each Dev or Review tab returns exactly one durable final result/i);
  assert.match(policy, /Dev and Review tabs may use internal subagents/i);
  assert.match(policy, /Review tab idle until the Orchestrator supplies the complete frozen review input/i);
});

test("Herdr policy rejects alternate parent-level delegation topologies", async () => {
  const { policy } = await policyAndSkills();

  assert.match(policy, /orchestrator-launched headless `subagent` or `workflowScript` children/i);
  assert.match(policy, /Herdr project panes opened through `project\.open`/i);
  assert.match(policy, /ordinary split panes or split-pane final lanes/i);
  assert.match(policy, /Orchestrator tab doing the mutation or review itself/i);
  assert.match(policy, /internal child result treated as the tab's final result/i);
  assert.match(policy, /If Herdr or the required separate tab cannot be established, stop and ask the human/i);
});

test("Herdr policy preserves leases, workspace separation, and frozen-input gates", async () => {
  const { policy } = await policyAndSkills();

  assert.match(policy, /managed leased worktree/i);
  assert.match(policy, /one concurrent writer per leased worktree/i);
  assert.match(policy, /distinct managed review workspace\/clone/i);
  assert.match(policy, /own opaque lease/i);
  assert.match(policy, /not a linked worktree and never the Dev tab's writable worktree/i);
  assert.match(policy, /Freeze the whole input set before review/i);
  assert.match(policy, /delta-only review is not valid/i);
  assert.match(policy, /changed binding.*invalidate/i);
});

test("Herdr policy keeps lifecycle authority sticky", async () => {
  const { policy } = await policyAndSkills();

  assert.match(policy, /Commit,\s*push, PR creation or mutation,\s*tracker\/Linear mutation, publication, cleanup, and merge remain separate\s+explicit authorities/i);
  assert.match(policy, /sticky.*`do not merge`.*exactly \*\*`Merge PR #N`\*\*/is);
  assert.match(policy, /ready to merge.*passing review.*never overrides/i);
  assert.match(policy, /Orchestrator remains the sole coordinator/i);
});

test("project skills require the same Herdr Dev and Review tab ownership", async () => {
  const { delivery, review } = await policyAndSkills();

  assert.match(delivery, /only supported parent-level delivery delegation is the tab-owned workflow/i);
  assert.match(delivery, /openai-codex\/gpt-5\.6-luna.*--thinking max/i);
  assert.match(delivery, /openai-codex\/gpt-5\.6-sol.*--thinking medium/i);
  assert.match(delivery, /must not replace these tabs with parent-launched headless subagents/i);
  assert.match(delivery, /Herdr project panes opened through `project\.open`/i);
  assert.match(delivery, /split-pane delivery lanes/i);
  assert.match(delivery, /Keep the Review tab idle until the\s+Orchestrator freezes and supplies its complete input/i);
  assert.match(delivery, /complete frozen review input/i);
  assert.match(delivery, /distinct managed review workspace/i);
  assert.match(delivery, /`do not merge` remains sticky until the exact user action `Merge PR #N`/i);

  assert.match(review, /independent review final result must be owned by a separate Review tab/i);
  assert.match(review, /pi --model openai-codex\/gpt-5\.6-sol --thinking medium/);
  assert.match(review, /Do not substitute a parent-launched headless/i);
  assert.match(review, /Herdr project pane opened through\s*`project\.open`/i);
  assert.match(review, /split pane/i);
  assert.match(review, /required Review tab cannot be established, review is unavailable and the gate remains blocked/i);
  assert.match(review, /complete frozen set/i);
  assert.match(review, /distinct managed review workspace/i);
  assert.match(review, /delta-only review is invalid/i);
});

test("Herdr policy's local Markdown links resolve", async () => {
  const policy = await text(policyUrl);
  const targets = [...policy.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)].map((match) => match[1]);

  assert.ok(targets.length > 0, "policy should retain links to its operational skills");
  for (const target of targets) {
    assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(target), `expected a local link: ${target}`);
    await access(new URL(target, policyUrl));
  }
});
