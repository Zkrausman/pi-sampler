import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canonicalSkillUrl = new URL("../.agents/skills/create-implementation-plan/SKILL.md", import.meta.url);
const retiredTeamSkillUrl = new URL("../.agents/skills/create-implementation-plan-team/SKILL.md", import.meta.url);
const planningDocumentationUrl = new URL("../docs/IMPLEMENTATION-PLANNING.md", import.meta.url);
const historicalPlanUrl = new URL("../docs/techPlans/AIDEV-159-implementation-plan.md", import.meta.url);

const planningAgents = [
  { path: "codebase-researcher.md", thinking: "low" },
  { path: "lead-architect.md", thinking: "high" },
  { path: "adversarial-red-teamer.md", thinking: "high" },
];

const namedReviewerModels = ["S" + "ol", "Ter" + "ra"];

function requirePolicy(text, pattern, reason) {
  if (!pattern.test(text)) throw new Error(reason);
}

function rejectPolicy(text, pattern, reason) {
  if (pattern.test(text)) throw new Error(reason);
}

function assertExplicitBasePolicy(text) {
  requirePolicy(
    text,
    /npm run delivery:worktree -- prepare --purpose plan --profile <approved-profile> --work-item \[TICKET-ID\] --slug implementation-plan --base <TRUSTED-BASE-SHA>/i,
    "explicit planning-base command is missing",
  );
  requirePolicy(text, /`?--base`? argument is mandatory|--base.*mandatory for every preparation/i, "base argument is not mandatory");
  requirePolicy(text, /full lowercase 40- or 64-character hexadecimal[\s\S]{0,40}Git[\s\S]{0,20}commit SHA/i, "base is not constrained to a full commit SHA");
  requirePolicy(text, /omission(?: of `?--base`?)?[\s\S]{0,80}invalid/i, "base omission is not rejected");
  requirePolicy(text, /never fall back to the profile-declared base[\s\S]{0,20}branch/i, "profile branch fallback is not rejected");
  requirePolicy(text, /current[\s\S]{0,30}`HEAD`[\s\S]{0,100}(?:not|invalid|mutable)/is, "current HEAD is not rejected as a planning identity");
  requirePolicy(text, /remote branch[\s\S]{0,100}(?:not|invalid|mutable)/is, "remote branch is not rejected as a planning identity");
  requirePolicy(text, /tag[\s\S]{0,100}(?:not|invalid|mutable)/is, "tag is not rejected as a planning identity");
  requirePolicy(text, /mutable ref/i, "mutable refs are not rejected as planning identities");
  rejectPolicy(text, /(?:omit|omission).{0,80}(?:permitted|allowed|optional|may be skipped)/is, "base omission is permitted");
  rejectPolicy(text, /profile-declared base branch.{0,100}(?:fallback|may resolve|may supply|is acceptable)/is, "profile branch fallback is permitted");
}

function isExplicitCommitSha(value) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function assertApprovalPolicy(text) {
  requirePolicy(text, /(?:No\s+)?implementation may begin before[\s\S]{0,180}independent[\s\S]{0,120}approved|implementation cannot begin before[\s\S]{0,180}independent[\s\S]{0,120}approved/i, "independent approval is not an implementation precondition");
  requirePolicy(text, /human escalation may[\s\S]{0,20}resolve[\s\S]{0,180}(?:requirements|contradictions|scope|policy|replacement-session authority)/i, "human escalation boundary is missing");
  requirePolicy(text, /human resolution alone (?:never satisfies independent approval|cannot approve a plan|never satisfies)/i, "human resolution can bypass approval");
  requirePolicy(text, /corrected plan[\s\S]{0,160}(?:return to independent review|receiv(?:e|es) independent[\s\S]{0,20}approval)/i, "corrected plans do not return to independent approval");
  rejectPolicy(text, /implementation may begin after reviewer approval or human resolution/i, "human resolution bypasses independent approval");
  rejectPolicy(text, /reviewer approval\s+or\s+(?:a\s+)?human resolution[\s\S]{0,80}(?:implementation|begin)/i, "human resolution is an alternative implementation gate");
}

function assertDefectPolicy(text) {
  requirePolicy(text, /blocking (?:\*\*defect\*\*|defect) must be reproducible/i, "blocking defects are not required to be reproducible");
  requirePolicy(text, /evidence-tied to at least[\s\S]{0,10}one/i, "blocking defects are not evidence-tied");
  for (const term of ["explicit acceptance", "trusted invariant", "documented contract", "concrete material harm"]) {
    requirePolicy(text, new RegExp(term, "i"), `missing defect evidence class: ${term}`);
  }
  requirePolicy(text, /unsupported allegation,[\s\S]{0,40}speculative concern,[\s\S]{0,40}hardening idea,[\s\S]{0,40}or preference cannot block approval or consume a remediation[\s\S]{0,20}cycle/i, "non-reproducible findings are not excluded from blocking cycles");
  rejectPolicy(text, /(?:unsupported|speculative).{0,100}(?:may|can) block approval/i, "unsupported findings can block approval");
}

function assertCyclePolicy(text) {
  requirePolicy(text, /failed `verification_1`[\s\S]{0,100}remaining reproducible defect[\s\S]{0,100}proceeds to[\s\S]{0,30}`remediation_2`/i, "verification 1 does not proceed to remediation 2");
  requirePolicy(text, /failed or unresolved `verification_2`[\s\S]{0,100}proceeds to[\s\S]{0,30}`human_escalation`/i, "verification 2 does not escalate to a human");
  requirePolicy(text, /hardening and preferences do not consume either remediation cycle/i, "hardening or preferences consume a remediation cycle");
  requirePolicy(text, /there is no third automatic remediation cycle/i, "a third automatic remediation cycle is not prohibited");
  requirePolicy(text, /implementation remains blocked until a corrected plan receives independent[\s\S]{0,20}approval/i, "cycle escalation does not preserve the implementation block");
  rejectPolicy(text, /failed `?verification_1`?[\s\S]{0,80}proceeds directly[\s\S]{0,80}(?:human_escalation|human escalation)/i, "verification 1 escalates instead of permitting remediation 2");
  rejectPolicy(text, /remediation_3|third automatic remediation cycle is permitted/i, "a third automatic remediation cycle is permitted");
}

function assertReviewerPolicy(text) {
  requirePolicy(text, /independent reviewer[\s\S]{0,20}selected by operator-owned trusted policy/i, "reviewer selection is not operator-owned trusted policy");
  requirePolicy(text, /durable[\s\S]{0,30}workflow documentation is[\s\S]{0,20}model-neutral/i, "reviewer documentation is not model-neutral");
  requirePolicy(text, /Gemini is the initial high-effort lead planner/i, "Gemini is not preserved as the initial lead planner");
  requirePolicy(text, /manual planning tool/i, "Gemini's manual planning boundary is missing");
  for (const model of namedReviewerModels) {
    if (text.includes(model)) throw new Error(`named reviewer model is selected: ${model}`);
  }
}

function assertAuthorityPolicy(text) {
  requirePolicy(text, /must not be represented or[\s\S]{0,20}invoked as a Pi provider\/model,[\s\S]{0,100}local provider,[\s\S]{0,30}Pi subagent/i, "Gemini is not excluded from Pi provider/model/subagent representation");
  requirePolicy(text, /has no authority to commit,[\s\S]{0,240}publish a review marker,[\s\S]{0,40}merge/i, "automatic lifecycle authority is not separated");
  requirePolicy(text, /automatic commit\/push\/PR\/Linear\/merge behavior[\s\S]{0,160}out of scope/i, "automatic lifecycle behavior is not prohibited");
  rejectPolicy(text, /Gemini\s+(?:is|may be invoked as)\s+a Pi (?:provider|model|subagent)/i, "Gemini is represented as a Pi provider/model/subagent");
  rejectPolicy(text, /(?:may|can|is authorized to)\s+(?:automatically\s+)?(?:commit|push|create or update a PR|mutate Linear|merge)/i, "automatic lifecycle authority is granted");
}

function assertRollbackPolicy(text) {
  requirePolicy(text, /not a blind checkout or revert[\s\S]{0,30}pre-Slice-1 bytes/i, "rollback permits unsafe blind restoration");
  requirePolicy(text, /preserve manual-only, uncommitted[\s\S]{0,30}planning and separate action authority/i, "rollback does not preserve manual-only authority");
  const rollbackAuthorities = [
    ["Linear mutation", /must never restore automatic Linear[\s\S]{0,220}mutation/i],
    ["commit", /must never restore automatic Linear[\s\S]{0,220}automatic commit/i],
    ["push", /must never restore automatic Linear[\s\S]{0,220}automatic push/i],
    ["PR creation or update", /must never restore automatic Linear[\s\S]{0,220}automatic PR creation or update/i],
    ["merge", /must never restore automatic Linear[\s\S]{0,220}automatic merge/i],
  ];
  for (const [authority, pattern] of rollbackAuthorities) {
    requirePolicy(text, pattern, `rollback can restore automatic ${authority}`);
  }
  requirePolicy(text, /deleted team wrapper as an active workflow/i, "rollback does not protect wrapper deletion");
  requirePolicy(text, /disable planning[\s\S]{0,30}fail-closed with a reviewed minimal manual-only stub/i, "fail-closed sanitized stub is missing");
  requirePolicy(text, /rollback change requires its own normal review,[\s\S]{0,30}publication, and merge authority/i, "rollback lacks separate authority");
  requirePolicy(text, /historical (?:plans|artifacts)[\s\S]{0,100}without silently rewriting/i, "rollback can rewrite historical artifacts");
  rejectPolicy(text, /rollback (?:may|can|should) restore automatic (?:Linear|commit|push|PR|merge)/i, "rollback mutation restores lifecycle authority");
  rejectPolicy(text, /rollback (?:may|can|should) restore[\s\S]{0,100}team wrapper[\s\S]{0,60}active workflow/i, "rollback mutation restores the team wrapper");
}

function assertV2ActivationPolicy(text) {
  requirePolicy(text, /docs\/techPlans\/\[TICKET-ID\]-acceptance-manifest-v2\.json/i, "deterministic v2 manifest filename is missing");
  requirePolicy(text, /schema_version:\s*implementation-plan-manifest\/v2/i, "v2 schema version is missing");
  requirePolicy(text, /scripts\/validate-implementation-plan\.mjs[\s\S]{0,500}--plan[\s\S]{0,160}--manifest[\s\S]{0,160}--base[\s\S]{0,160}--profile[\s\S]{0,160}--repository[\s\S]{0,160}--ticket[\s\S]{0,160}--ticket-revision[\s\S]{0,160}--json/i, "trusted validator command is incomplete");
  requirePolicy(text, /exact trusted base[\s\S]{0,180}(?:contains both|containing both)[\s\S]{0,160}implementation-plan-manifest-v2\.mjs[\s\S]{0,160}validate-implementation-plan\.mjs/i, "trusted-base activation condition is missing");
  requirePolicy(text, /(?:validator[\s\S]{0,180}before[\s\S]{0,180}(?:one fresh independent|independent) (?:plan )?review|before[\s\S]{0,120}validator[\s\S]{0,180}(?:one fresh independent|independent) (?:plan )?review)/i, "validation-before-review boundary is missing");
  requirePolicy(text, /validation success is necessary[\s\S]{0,80}never plan approval/i, "validation is incorrectly treated as approval");
  requirePolicy(text, /(?:validator[\s\S]{0,220}manual planner[\s\S]{0,220}(?:reproducible defect|reproducible)|reproducible validator defect[\s\S]{0,220}manual planner)/i, "validator remediation owner is missing");
  requirePolicy(text, /(?:existing two|two planner-fix)[\s\S]{0,140}(?:planner-fix|same-reviewer-verify|cycle)/i, "validator remediation cycle bound is missing");
  requirePolicy(text, /historical[\s\S]{0,120}(?:v1|acceptance-manifest\/v1)[\s\S]{0,160}(?:readable|never silently)/i, "historical v1 boundary is missing");
  rejectPolicy(text, /validation success (?:is|means|constitutes) (?:plan )?approval/i, "validation grants plan approval");
}

function assertWorkflowPolicy(text) {
  assertExplicitBasePolicy(text);
  assertApprovalPolicy(text);
  assertDefectPolicy(text);
  assertCyclePolicy(text);
  assertReviewerPolicy(text);
  assertAuthorityPolicy(text);
  assertRollbackPolicy(text);
  assertV2ActivationPolicy(text);
}

test("canonical skill provisions an explicit immutable leased planning worktree", async () => {
  const skill = await readFile(canonicalSkillUrl, "utf8");
  assertExplicitBasePolicy(skill);
  assert.match(skill, /configured worktree root's[\s\S]{0,30}`plan\/` subfolder/i);
  assert.match(skill, /returned worktree/i);
  assert.match(skill, /branch, exact base SHA, approved profile path, lease ID, and lease token/i);
  assert.match(skill, /never handcraft `git worktree add`/i);
  assert.doesNotMatch(skill, /squire prep/i);
  assert.doesNotMatch(skill, /cd \.\.\/ai-workspaces\/\[TICKET-ID\]/i);
});

test("the team wrapper is deleted and repository documentation is authoritative", async () => {
  await assert.rejects(readFile(retiredTeamSkillUrl, "utf8"), (error) => error?.code === "ENOENT");
  const [skill, documentation] = await Promise.all([
    readFile(canonicalSkillUrl, "utf8"),
    readFile(planningDocumentationUrl, "utf8"),
  ]);

  assert.match(skill, /single canonical planning skill/i);
  assert.match(skill, /manual[\s\S]*Gemini[\s\S]*Antigravity/i);
  assert.match(documentation, /canonical\s+`create-implementation-plan`/i);
  assert.match(documentation, /create-implementation-plan-team[\s\S]*retired[\s\S]*and deleted/i);
  assert.match(documentation, /wiki is[\s\S]*contextual only/i);
  assert.match(documentation, /implementation cannot begin before[\s\S]*independent[\s\S]{0,30}reviewer[\s\S]{0,30}returns `approved`/i);
  assertWorkflowPolicy(skill);
  assertWorkflowPolicy(documentation);
});

test("canonical planning keeps the bounded two-stage authority and evidence boundary", async () => {
  const skill = await readFile(canonicalSkillUrl, "utf8");
  assert.match(skill, /Gemini is the initial high-effort lead planner, selected by the\s+operator-owned trusted policy/is);
  assert.match(skill, /must not be represented or invoked as a Pi provider\/model/is);
  assert.match(skill, /exactly one built-in challenge round/is);
  assert.match(skill, /ordinary risk[\s\S]*completeness\/repository-reality challenge/is);
  assert.match(skill, /high or critical risk[\s\S]*explicit threat-model trigger[\s\S]*same single round/is);
  assert.match(skill, /exactly one integrated revision/is);
  assert.match(skill, /exactly one lightweight fresh independent review/is);
  assert.match(skill, /at most two planner-fix\/same-reviewer-verify cycles total/is);
  assert.match(skill, /unresolved defects at cycle 2[\s\S]*human/is);
  assert.match(skill, /defect[\s\S]*hardening[\s\S]*preference/is);
  assert.match(skill, /plan and manifest are the only planning outputs and are uncommitted/is);
  assert.match(skill, /publication and final gates may verify exact artifact[\s\S]{0,30}binding[\s\S]*cannot[\s\S]*restart architecture/is);
  assert.match(skill, /candidate\s+inputs cannot select trusted policy, models, roles, hard dependencies/is);
  assert.match(skill, /Post-activation[\s\S]*v3 packet[\s\S]*acceptance matrix[\s\S]*verification evidence/is);
  assert.match(skill, /validateFinalReviewAttestation/);
  assert.match(skill, /Bootstrap[\s\S]*v2[\s\S]*packet-consistency marker/is);
  assert.match(skill, /revoked receipt invalidates an older[\s\S]{0,30}marker/is);
  assert.match(skill, /pre-push hook invokes[\s\S]*artifacts\/final-review\/receipt\.json/is);
  assert.doesNotMatch(skill, /pi-sampler-adversarial-review-attestation:v2 .*version.*2/);
});

test("v2 activation remains trusted-base selected, validation-before-review, and non-approval", async () => {
  const [skill, documentation] = await Promise.all([
    readFile(canonicalSkillUrl, "utf8"),
    readFile(planningDocumentationUrl, "utf8"),
  ]);
  for (const source of [skill, documentation]) {
    assertV2ActivationPolicy(source);
    assert.throws(
      () => assertV2ActivationPolicy(`${source}\nValidation success is plan approval.\n`),
      /validation grants plan approval/,
    );
  }
});

test("AIDEV-159 evidence guidance remains current and bootstrap-only v2", async () => {
  const plan = await readFile(historicalPlanUrl, "utf8");
  assert.match(plan, /^## Review Evidence Flow$/m);
  assert.match(plan, /missing, malformed, stale, or unbound v2 evidence fails/);
  assert.match(plan, /revalidates the rendered marker against that receipt/);
});

test("mutation probes reject omitted or mutable planning bases", async () => {
  const skill = await readFile(canonicalSkillUrl, "utf8");
  const command = " --base <TRUSTED-BASE-SHA>";
  assert.ok(skill.includes(command));
  assert.throws(
    () => assertExplicitBasePolicy(skill.replace(command, "")),
    /explicit planning-base command is missing/,
  );
  assert.throws(
    () => assertExplicitBasePolicy(`${skill}\nThe profile-declared base branch is an acceptable fallback.\n`),
    /profile branch fallback is permitted/,
  );
  assert.equal(isExplicitCommitSha("a".repeat(40)), true);
  assert.equal(isExplicitCommitSha("b".repeat(64)), true);
  for (const mutableRef of ["main", "origin/main", "HEAD", "v1.0.0", "refs/heads/main"]) {
    assert.equal(isExplicitCommitSha(mutableRef), false, mutableRef);
  }
});

test("mutation probes reject human escalation as an approval bypass", async () => {
  const [skill, documentation] = await Promise.all([
    readFile(canonicalSkillUrl, "utf8"),
    readFile(planningDocumentationUrl, "utf8"),
  ]);
  for (const source of [skill, documentation]) {
    assertApprovalPolicy(source);
    assert.throws(
      () => assertApprovalPolicy(`${source}\nImplementation may begin after reviewer approval or human resolution.\n`),
      /human resolution bypasses independent approval/,
    );
  }
});

test("mutation probes reject non-reproducible blocking findings", async () => {
  const [skill, documentation] = await Promise.all([
    readFile(canonicalSkillUrl, "utf8"),
    readFile(planningDocumentationUrl, "utf8"),
  ]);
  for (const source of [skill, documentation]) {
    assertDefectPolicy(source);
    assert.throws(
      () => assertDefectPolicy(`${source}\nUnsupported allegations may block approval.\n`),
      /unsupported findings can block approval/,
    );
  }
});

test("mutation probes preserve verification-1 remediation-2 and verification-2 escalation", async () => {
  const [skill, documentation] = await Promise.all([
    readFile(canonicalSkillUrl, "utf8"),
    readFile(planningDocumentationUrl, "utf8"),
  ]);
  for (const source of [skill, documentation]) {
    assertCyclePolicy(source);
    assert.throws(
      () => assertCyclePolicy(`${source}\nA failed verification_1 proceeds directly to human_escalation.\n`),
      /verification 1 escalates instead of permitting remediation 2/,
    );
    assert.throws(
      () => assertCyclePolicy(`${source}\nA third automatic remediation cycle is permitted.\n`),
      /a third automatic remediation cycle is permitted/,
    );
  }
});

test("mutation probes reject named reviewer selection while preserving Gemini", async () => {
  const [skill, documentation] = await Promise.all([
    readFile(canonicalSkillUrl, "utf8"),
    readFile(planningDocumentationUrl, "utf8"),
  ]);
  for (const source of [skill, documentation]) {
    assertReviewerPolicy(source);
    for (const model of namedReviewerModels) {
      assert.throws(
        () => assertReviewerPolicy(`${source}\nThe independent reviewer selected by policy is ${model}.\n`),
        /named reviewer model is selected/,
      );
    }
  }
});

test("mutation probes reject Pi-provider and automatic lifecycle authority", async () => {
  const skill = await readFile(canonicalSkillUrl, "utf8");
  assertAuthorityPolicy(skill);
  assert.throws(
    () => assertAuthorityPolicy(`${skill}\nGemini is a Pi provider/model/subagent.\n`),
    /Gemini is represented as a Pi provider\/model\/subagent/,
  );
  assert.throws(
    () => assertAuthorityPolicy(`${skill}\nThe planner may automatically commit, push, create or update a PR, mutate Linear, and merge.\n`),
    /automatic lifecycle authority is granted/,
  );
});

test("mutation probes reject unsafe rollback restoration", async () => {
  const [skill, documentation] = await Promise.all([
    readFile(canonicalSkillUrl, "utf8"),
    readFile(planningDocumentationUrl, "utf8"),
  ]);
  for (const source of [skill, documentation]) {
    assertRollbackPolicy(source);
    assert.throws(
      () => assertRollbackPolicy(`${source}\nRollback may restore automatic commit, push, PR, Linear, and merge authority.\n`),
      /rollback mutation restores lifecycle authority/,
    );
    assert.throws(
      () => assertRollbackPolicy(`${source}\nRollback may restore the deleted team wrapper as an active workflow.\n`),
      /rollback mutation restores the team wrapper/,
    );
  }
});

test("planning agents inherit a registered model and retain role-specific thinking", async () => {
  for (const agent of planningAgents) {
    const url = new URL(`../.agents/agents/${agent.path}`, import.meta.url);
    const definition = await readFile(url, "utf8");

    assert.doesNotMatch(definition, /^model:/m, `${agent.path} must not pin a runtime-specific model alias`);
    assert.match(definition, new RegExp(`^thinking: ${agent.thinking}$`, "m"));
  }
});
