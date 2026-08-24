import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFinalReviewAttestation, createFinalReviewReceipt, revokeFinalReviewReceipt } from "../scripts/final-review-receipt.mjs";
import { PRE_PUSH_KINDS, PRE_PUSH_LIFECYCLE_KINDS, PRE_PUSH_LIFECYCLE_TABLE, PRE_PUSH_PR_STATES, PRE_PUSH_STATE_TABLE, classifyPrePushLifecycle, classifyTrustedDestination, normalizePrePushInput } from "../scripts/hooks/pre-push-protocol.mjs";
import { REVIEW_PROVENANCE_CANONICAL_EXAMPLES, REVIEW_PROVENANCE_PRIVACY_PROBES } from "./helpers/review-provenance-probes.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const validator = join(root, "scripts", "validate-adversarial-review-attestation.mjs");
const packetGenerator = join(root, "scripts", "generate-review-packet.mjs");
const { TRUSTED_V3_ATTESTATION_ACTIVATION } = await import(pathToFileURL(validator).href);
const ticketBranch = "zkrausman/aidev-109-make-adversarial-review-gate-solo-maintainer-compatible";
const RETIRED_HISTORICAL_OBJECT = "465e7a4a20e78f100b5cefcf29fbf41c65656f94";
const V2_TEMPLATE_MARKER = /<!-- pi-sampler-adversarial-review-attestation:v2 [^\r\n]* -->/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-adversarial-attestation-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "user.name", "Attestation Test");
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await mkdir(join(cwd, "scripts"));
  await mkdir(join(cwd, "profiles"));
  await mkdir(join(cwd, ".github"));
  await copyFile(join(root, "profiles", "pi-sampler.json"), join(cwd, "profiles", "pi-sampler.json"));
  const legacyValidator = [
    'const MARKER_PREFIX = "pi-sampler-adversarial-review-attestation";',
    'const V2_TAG = `<!-- ${MARKER_PREFIX}:v2`;',
    'const MARKER_V2 = new RegExp(`<!-- ${MARKER_PREFIX}:v2 ([^\\\\r\\\\n]{1,4096}) -->`, "g");',
    'function legacyRule(body, required) {',
    '  const marker = parseMarkerJson(body);',
    '  if (!marker) {',
    '    if (required) fail("legacy v2 required");',
    '  }',
    '}',
  ].join("\n");
  const legacyTemplate = [
    "## Summary",
    "",
    "<!-- What changes, and why? -->",
    "",
    "## AIDEV adversarial review evidence",
    "",
    "<!-- Required only for an AIDEV ticket branch; keep review material local. -->",
    '<!-- pi-sampler-adversarial-review-attestation:v2 {"format":"pi-sampler.adversarial-review-attestation","version":2,"base":"<exact-base-sha>","head":"<exact-head-sha>","outcome":"clean","packetSha256":"<packet-sha256>"} -->',
    "",
    "## Checklist",
    "",
    "- [ ] I kept credentials and review material out of this body.",
  ].join("\n");
  await writeFile(join(cwd, "scripts", "validate-adversarial-review-attestation.mjs"), legacyValidator);
  await writeFile(join(cwd, ".github", "pull_request_template.md"), `${legacyTemplate}\n`);
  git(cwd, "add", "tracked.txt", "profiles/pi-sampler.json", "scripts/validate-adversarial-review-attestation.mjs", ".github/pull_request_template.md"); git(cwd, "commit", "--quiet", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  await writeFile(join(cwd, "tracked.txt"), "head\n");
  git(cwd, "add", "tracked.txt"); git(cwd, "commit", "--quiet", "-m", "head");
  return { cwd, base, head: git(cwd, "rev-parse", "HEAD") };
}
async function historicalBootstrapRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-adversarial-historical-bootstrap-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "user.name", "Attestation Test");
  await writeFile(join(cwd, "tracked.txt"), "bootstrap\n");
  await mkdir(join(cwd, "scripts"));
  await mkdir(join(cwd, "profiles"));
  await mkdir(join(cwd, ".github"));
  await copyFile(join(root, "profiles", "pi-sampler.json"), join(cwd, "profiles", "pi-sampler.json"));
  const legacyValidator = [
    'export const TRUSTED_V3_ATTESTATION_ACTIVATION = "synthetic-legacy-only";',
    'const MARKER_PREFIX = "pi-sampler-adversarial-review-attestation";',
    'const V2_TAG = `<!-- ${MARKER_PREFIX}:v2`;',
    'const MARKER_V2 = new RegExp(`<!-- ${MARKER_PREFIX}:v2 ([^\\\\r\\\\n]{1,4096}) -->`, "g");',
    'function legacyRule(body, required) {',
    '  const marker = parseMarkerJson(body);',
    '  if (!marker) {',
    '    if (required) fail("a v2 adversarial-review attestation is required by the exact trusted base");',
    '  }',
    '}',
  ].join("\n");
  await writeFile(join(cwd, "scripts", "validate-adversarial-review-attestation.mjs"), legacyValidator);
  git(cwd, "add", "tracked.txt", "profiles/pi-sampler.json", "scripts/validate-adversarial-review-attestation.mjs");
  git(cwd, "commit", "--quiet", "-m", "synthetic legacy bootstrap base");
  const base = git(cwd, "rev-parse", "HEAD");

  const template = [
    "## Summary",
    "",
    "<!-- What changes, and why? -->",
    "",
    "## AIDEV adversarial review evidence",
    "",
    "<!-- Required only for an AIDEV ticket branch; keep review material local. -->",
    '<!-- pi-sampler-adversarial-review-attestation:v2 {"format":"pi-sampler.adversarial-review-attestation","version":2,"base":"<exact-base-sha>","head":"<exact-head-sha>","outcome":"clean","packetSha256":"<packet-sha256>"} -->',
    "",
    "## Checklist",
    "",
    "- [ ] I kept credentials and review material out of this body.",
  ].join("\n");
  await writeFile(join(cwd, ".github", "pull_request_template.md"), `${template}\n`);
  git(cwd, "add", ".github/pull_request_template.md");
  git(cwd, "commit", "--quiet", "-m", "synthetic v2 template descendant");
  const templateBase = git(cwd, "rev-parse", "HEAD");

  await writeFile(join(cwd, "tracked.txt"), "candidate\n");
  git(cwd, "add", "tracked.txt");
  git(cwd, "commit", "--quiet", "-m", "synthetic candidate head");
  const head = git(cwd, "rev-parse", "HEAD");
  return { cwd, base, templateBase, head, template: git(cwd, "show", `${templateBase}:.github/pull_request_template.md`) };
}
async function activatedRepository() {
  const fixture = await repository();
  const legacyBase = fixture.base;
  const trustedValidator = `export const TRUSTED_V3_ATTESTATION_ACTIVATION = ${JSON.stringify(TRUSTED_V3_ATTESTATION_ACTIVATION)};\n`;
  await writeFile(join(fixture.cwd, "scripts", "validate-adversarial-review-attestation.mjs"), trustedValidator);
  git(fixture.cwd, "add", "scripts/validate-adversarial-review-attestation.mjs");
  git(fixture.cwd, "commit", "--quiet", "-m", "activate v3 on trusted base");
  const base = git(fixture.cwd, "rev-parse", "HEAD");
  await writeFile(join(fixture.cwd, "tracked.txt"), "activated-head\n");
  git(fixture.cwd, "add", "tracked.txt");
  git(fixture.cwd, "commit", "--quiet", "-m", "activated head");
  return { ...fixture, legacyBase, base, head: git(fixture.cwd, "rev-parse", "HEAD") };
}
async function alternateProfileRepository(objectFormat = null) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-adversarial-alternate-profile-"));
  const initArgs = ["init", "--quiet"];
  if (objectFormat) initArgs.push("--object-format", objectFormat);
  git(cwd, ...initArgs);
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "user.name", "Attestation Test");
  await mkdir(join(cwd, "scripts"));
  await mkdir(join(cwd, "profiles"));
  for (const file of [
    "validate-adversarial-review-attestation.mjs", "generate-review-packet.mjs", "final-review-receipt.mjs", "review-provenance-contract.mjs", "validate-review-packet.mjs",
    "package-lock-admission.mjs", "package-lock-entry.mjs", "package-lock-validation.mjs",
  ]) {
    await copyFile(join(root, "scripts", file), join(cwd, "scripts", file));
  }
  const profile = JSON.parse(await readFile(join(root, "profiles", "pi-sampler.json"), "utf8"));
  profile.repository.source = "Alternate/consumer-repository";
  profile.delivery.branchPrefix = "alternate";
  profile.workItem.idPattern = "^TASK-[0-9]+$";
  await writeFile(join(cwd, "profiles", "pi-sampler.json"), `${JSON.stringify(profile, null, 2)}\n`);
  await writeFile(join(cwd, "candidate.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "alternate trusted consumer base");
  const base = git(cwd, "rev-parse", "HEAD");
  profile.repository.source = "Candidate/forged-repository";
  profile.delivery.branchPrefix = "candidate";
  profile.workItem.idPattern = "^OTHER-[0-9]+$";
  await writeFile(join(cwd, "profiles", "pi-sampler.json"), `${JSON.stringify(profile, null, 2)}\n`);
  await writeFile(join(cwd, "candidate.txt"), "head\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "candidate profile drift");
  return {
    cwd,
    base,
    head: git(cwd, "rev-parse", "HEAD"),
    trustedRepository: "Alternate/consumer-repository",
    candidateRepository: "Candidate/forged-repository",
    trustedBranch: "alternate/task-159-implement-8bba52",
    candidateBranch: "candidate/other-159-implement-8bba52",
  };
}
function digest(cwd, base, head, version = 2) {
  const packet = execFileSync(process.execPath, [packetGenerator, "--version", String(version), "--base", base, "--head", head], { cwd, encoding: "utf8" });
  return createHash("sha256").update(packet, "utf8").digest("hex");
}
function marker({ base, head, packetSha256, outcome = "clean" }) {
  return `<!-- pi-sampler-adversarial-review-attestation:v2 ${JSON.stringify({ format: "pi-sampler.adversarial-review-attestation", version: 2, base, head, outcome, packetSha256 })} -->`;
}
function markerV3({ base, head, packetSha256, outcome = "clean", ...provenance }) {
  return `<!-- pi-sampler-adversarial-review-attestation:v3 ${JSON.stringify({ format: "pi-sampler.adversarial-review-attestation", version: 3, base, head, outcome, packetSha256, acceptanceMatrixSha256: provenance.acceptanceMatrixSha256 ?? "a".repeat(64), verificationEvidenceSha256: provenance.verificationEvidenceSha256 ?? "b".repeat(64), reviewerModelId: provenance.reviewerModelId ?? "openai-codex/gpt-5.6-sol", reviewProfileVersion: provenance.reviewProfileVersion ?? "terra-final-v1", receiptSha256: provenance.receiptSha256 ?? "c".repeat(64) })} -->`;
}
function templateWithMarker(template, replacement) {
  assert.match(template, V2_TEMPLATE_MARKER);
  return template.replace(V2_TEMPLATE_MARKER, replacement);
}
async function fakeGithub(record) {
  const directory = await mkdtemp(join(tmpdir(), "pi-adversarial-fake-gh-"));
  const recordPath = join(directory, "record.json");
  await writeFile(recordPath, JSON.stringify(record));
  const fakeGithubBehavior = String.raw`
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.env.FAKE_GH_RECORD, "utf8"));
const argv = process.argv.slice(1);
const firstIsPr = argv[0] === "pr" || argv[0]?.endsWith("pr");
const args = firstIsPr ? ["pr", ...argv.slice(1)] : argv.slice(1);
if (args[0] === "pr") {
  const isList = args[1] === "list";
  const isView = args[1] === "view";
  if (record.mode === "absent") {
    if (isList) process.stdout.write("[]");
    process.exit(isList ? 0 : 1);
  }
  if (record.mode === "unavailable") process.exit(2);
  if (record.mode === "malformed") {
    if (isView) process.stdout.write("{");
    process.exit(0);
  }
  if (record.mode === "ambiguous") {
    if (isList) process.stdout.write('[{"number":160}]');
    process.exit(isList ? 0 : 1);
  }
  process.stdout.write(JSON.stringify(record));
  process.exit(0);
}
`;
  let nodeOptions;
  if (process.platform === "win32") {
    const preload = join(directory, "fake-gh-preload.cjs");
    await writeFile(preload, fakeGithubBehavior);
    await copyFile(process.execPath, join(directory, "gh.exe"));
    nodeOptions = `--require=${preload}`;
  } else {
    await writeFile(join(directory, "gh"), `#!/usr/bin/env node\n${fakeGithubBehavior}`);
    await chmod(join(directory, "gh"), 0o755);
  }
  return {
    directory,
    env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`, FAKE_GH_RECORD: recordPath, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}) },
    async update(nextRecord) { await writeFile(recordPath, JSON.stringify(nextRecord)); },
    async record() { return JSON.parse(await readFile(recordPath, "utf8")); },
  };
}
function invoke(cwd, { base, head, branch, body }, extraEnvironment = {}) {
  return spawnSync(process.execPath, [validator], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnvironment,
      ADVERSARIAL_REVIEW_BASE_SHA: base,
      ADVERSARIAL_REVIEW_HEAD_SHA: head,
      ADVERSARIAL_REVIEW_HEAD_REF: branch,
      ADVERSARIAL_REVIEW_PR_BODY: body,
    },
  });
}
function validInput(fixture) {
  return {
    ...fixture,
    branch: ticketBranch,
    body: marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head) }),
  };
}
function trustedV3Review(fixture, head = fixture.head, repository = fixture.trustedRepository) {
  const packetSha256 = digest(fixture.cwd, fixture.base, head, 3);
  const receipt = createFinalReviewReceipt({
    repository, pullRequest: "160", base: fixture.base, head,
    packetSha256, acceptanceMatrixSha256: "a".repeat(64), verificationEvidenceSha256: "b".repeat(64),
    reviewerModelId: "openai-codex/gpt-5.6-sol", reviewProfileVersion: "terra-final-v1", recordedAt: "2026-08-22T00:00:00.000Z",
  });
  const body = createFinalReviewAttestation(receipt, {
    repository, pullRequest: "160", base: fixture.base, head, packetSha256,
    acceptanceMatrixSha256: receipt.acceptanceMatrixSha256, verificationEvidenceSha256: receipt.verificationEvidenceSha256,
  });
  return { receipt, body };
}
async function writeReceipt(fixture, receipt) {
  const receiptPath = join(fixture.cwd, "artifacts", "final-review", "receipt.json");
  await mkdir(join(fixture.cwd, "artifacts", "final-review"), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
}
async function installRealPrePushHook(fixture, remote, objectFormat = null) {
  const initArgs = ["init", "--bare", "--quiet"];
  if (objectFormat) initArgs.push("--object-format", objectFormat);
  initArgs.push(remote);
  git(dirname(remote), ...initArgs);
  git(fixture.cwd, "remote", "add", "origin", remote);
  const hooks = join(fixture.cwd, ".git", "hooks");
  await mkdir(hooks, { recursive: true });
  const hookPath = join(hooks, "pre-push");
  await copyFile(join(root, "scripts", "hooks", "pre-push.mjs"), hookPath);
  await copyFile(join(root, "scripts", "hooks", "pre-push-protocol.mjs"), join(hooks, "pre-push-protocol.mjs"));
  await chmod(hookPath, 0o755);
}

test("adversarial review gate is isolated from ordinary validation and executes only trusted base files", async () => {
  const validate = (await readFile(join(root, ".github", "workflows", "validate.yml"), "utf8")).replace(/\r\n/g, "\n");
  assert.match(validate, /^on:\n  pull_request:\n  push:\n    branches: \[main\]$/m);
  assert.doesNotMatch(validate, /pull_request_target|pull_request_review|adversarial-review-attestation/);

  const workflow = (await readFile(join(root, ".github", "workflows", "adversarial-review.yml"), "utf8")).replace(/\r\n/g, "\n");
  const start = workflow.indexOf("  adversarial-review-attestation:");
  assert.ok(start >= 0, "adversarial-review-attestation job must remain present");
  const job = workflow.slice(start);

  assert.match(workflow, /^  pull_request_target:\n    types: \[opened, reopened, synchronize, edited\]$/m);
  assert.doesNotMatch(workflow, /pull_request_review/);
  assert.match(job, /name: Adversarial review evidence/);
  assert.match(job, /contents: read/);
  assert.doesNotMatch(job, /pull-requests: read/);
  assert.match(job, /ADVERSARIAL_REVIEW_HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/);
  assert.match(job, /ADVERSARIAL_REVIEW_PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
  assert.doesNotMatch(job, /ADVERSARIAL_REVIEW_PR_(AUTHOR|NUMBER)|REVIEWS_FILE/);
  assert.equal((job.match(/uses: actions\/checkout/g) ?? []).length, 1, "gate must use one explicitly pinned checkout");
  assert.match(job, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(job, /persist-credentials: false/);
  assert.doesNotMatch(job, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.doesNotMatch(job, /\bgit checkout\b/);
  assert.match(job, /git fetch --no-tags origin "\$ADVERSARIAL_REVIEW_HEAD_SHA"/);
  assert.match(job, /git cat-file -e "\$ADVERSARIAL_REVIEW_HEAD_SHA\^\{commit\}"/);
  assert.match(job, /node scripts\/validate-adversarial-review-attestation\.mjs/);
  assert.doesNotMatch(job, /--require-v3|ADVERSARIAL_REVIEW_REQUIRE_V3/);
  assert.doesNotMatch(job, /\bgh api\b|reviews\?per_page|npm run validate:adversarial-review/);
});

test("pre-push marker validation uses bounded argv and fail-closed PR lookup", async () => {
  const hook = (await readFile(join(root, "scripts", "hooks", "pre-push.mjs"), "utf8")).replace(/\r\n/g, "\n");
  const protocol = (await readFile(join(root, "scripts", "hooks", "pre-push-protocol.mjs"), "utf8")).replace(/\r\n/g, "\n");
  const contributing = (await readFile(join(root, "CONTRIBUTING.md"), "utf8")).replace(/\r\n/g, "\n");
  const validatorSource = (await readFile(validator, "utf8")).replace(/\r\n/g, "\n");
  assert.match(hook, /execFileSync/);
  assert.doesNotMatch(hook, /execSync|`gh pr view|origin\\\/\\$\{base/);
  assert.match(hook, /gh.*pr.*list/);
  assert.match(hook, /explicitlyVerifiedNoPr/);
  assert.match(hook, /refusing to skip attestation validation/);
  assert.match(hook, /pre-push ref input could not be read/);
  assert.match(hook, /current Git branch could not be inspected/);
  assert.match(hook, /normalizePrePushInput/);
  assert.match(hook, /--receipt/);
  assert.match(hook, /currentBranchCandidate/);
  assert.match(hook, /exactLocalCommit/);
  assert.match(hook, /classifyPrePushLifecycle/);
  assert.match(hook, /trustedTicketDestination/);
  assert.match(hook, /--show-object-format/);
  assert.match(hook, /Protected trusted-base CI/);
  assert.match(protocol, /PRE_PUSH_STATE_TABLE/);
  assert.match(protocol, /PRE_PUSH_KINDS\.CREATE/);
  assert.match(protocol, /PRE_PUSH_KINDS\.UPDATE/);
  assert.match(protocol, /PRE_PUSH_KINDS\.DELETION/);
  assert.match(protocol, /PRE_PUSH_KINDS\.IGNORED/);
  assert.match(protocol, /PRE_PUSH_KINDS\.INVALID/);
  assert.match(protocol, /PRE_PUSH_LIFECYCLE_TABLE/);
  assert.match(protocol, /PRE_PUSH_LIFECYCLE_KINDS\.INITIAL_PUBLICATION/);
  assert.match(protocol, /SHA-1 and SHA-256 widths/);
  assert.match(protocol, /DELETE_REF/);
  assert.match(protocol, /duplicate remote destinations/);
  assert.match(contributing, /trusted-base CI job remains the authoritative evidence gate/);
  assert.match(contributing, /pre-push hook is fail-closed early feedback only/);
  assert.match(contributing, /initial-publication/);
  assert.match(contributing, /verified-absent PR/);
  assert.match(contributing, /grants no approval or merge authority/);
  assert.match(hook, /hasInput/);
  assert.doesNotMatch(hook, /localRef\.slice\("refs\/heads\//);
  assert.doesNotMatch(hook, /TICKET_BRANCH|zkrausman\/aidev-|Zkrausman\/pi-sampler/);
  assert.doesNotMatch(hook, /--repository|ADVERSARIAL_REVIEW_REPOSITORY/);
  assert.match(hook, /--pull-request/);
  assert.doesNotMatch(hook, /ADVERSARIAL_REVIEW_REQUIRE_V3|--require-v3/);
  assert.match(validatorSource, /trustedBaseProfile/);
  assert.match(validatorSource, /branchPrefix/);
  assert.match(validatorSource, /workItemPattern/);
  assert.doesNotMatch(validatorSource, /TICKET_BRANCH|zkrausman\/aidev-|Zkrausman\/pi-sampler/);
  assert.doesNotMatch(validatorSource, /--repository|ADVERSARIAL_REVIEW_REPOSITORY/);
});

test("pre-push protocol and lifecycle normalization are table-driven and state-complete", () => {
  const local = "a".repeat(40);
  const remote = "b".repeat(40);
  const zero = "0".repeat(40);
  const wide = "c".repeat(64);
  const wideZero = "0".repeat(64);
  const cases = [
    { name: "create", input: `refs/heads/zkrausman/aidev-159-create ${local} refs/heads/zkrausman/aidev-159-create ${zero}\n`, kind: PRE_PUSH_KINDS.CREATE },
    { name: "update", input: `refs/heads/zkrausman/aidev-159-update ${local} refs/heads/zkrausman/aidev-159-update ${remote}\n`, kind: PRE_PUSH_KINDS.UPDATE },
    { name: "detached HEAD create", input: `HEAD ${local} refs/heads/zkrausman/aidev-159-detached ${zero}\n`, kind: PRE_PUSH_KINDS.CREATE },
    { name: "deletion", input: `(delete) ${zero} refs/heads/zkrausman/aidev-159-delete ${remote}\n`, kind: PRE_PUSH_KINDS.DELETION },
    { name: "ignored non-ticket destination", input: `refs/heads/local ${local} refs/tags/release ${zero}\n`, kind: PRE_PUSH_KINDS.IGNORED },
    { name: "invalid zero remote deletion", input: `(delete) ${zero} refs/heads/zkrausman/aidev-159-delete ${zero}\n`, kind: PRE_PUSH_KINDS.INVALID },
    { name: "invalid deletion token", input: `refs/heads/local ${zero} refs/heads/zkrausman/aidev-159-delete ${remote}\n`, kind: PRE_PUSH_KINDS.INVALID },
    { name: "invalid non-deletion token", input: `(delete) ${local} refs/heads/zkrausman/aidev-159-update ${zero}\n`, kind: PRE_PUSH_KINDS.INVALID },
    { name: "invalid short SHA", input: `HEAD ${local.slice(0, 12)} refs/heads/zkrausman/aidev-159-update ${zero}\n`, kind: PRE_PUSH_KINDS.INVALID },
    { name: "invalid blank line", input: " \n", kind: PRE_PUSH_KINDS.INVALID },
  ];
  for (const scenario of cases) {
    const normalized = normalizePrePushInput(scenario.input, { shaWidth: 40 });
    assert.equal(normalized.hasInput, true, scenario.name);
    assert.equal(normalized.updates.length, 1, scenario.name);
    assert.equal(normalized.updates[0].kind, scenario.kind, scenario.name);
  }
  const mixedWidthCases = [
    `refs/heads/create ${local} refs/heads/aidev-159-mixed-create ${wideZero}`,
    `refs/heads/update ${local} refs/heads/aidev-159-mixed-update ${wide}`,
    `(delete) ${zero} refs/heads/aidev-159-mixed-delete ${wide}`,
  ];
  for (const input of mixedWidthCases) {
    assert.equal(normalizePrePushInput(`${input}\n`, { shaWidth: 40 }).updates[0].kind, PRE_PUSH_KINDS.INVALID);
  }
  assert.equal(normalizePrePushInput(`HEAD ${wide} refs/heads/aidev-159-wrong-format ${wideZero}\n`, { shaWidth: 40 }).updates[0].kind, PRE_PUSH_KINDS.INVALID);

  const update = normalizePrePushInput(`refs/heads/local ${local} refs/heads/zkrausman/aidev-159-update ${remote}\n`, { shaWidth: 40 }).updates[0];
  assert.equal(classifyTrustedDestination(update, () => true).kind, PRE_PUSH_KINDS.UPDATE);
  assert.equal(classifyTrustedDestination(update, () => false).kind, PRE_PUSH_KINDS.IGNORED);
  assert.equal(classifyPrePushLifecycle(update, { prStatus: PRE_PUSH_PR_STATES.EXISTING, isTicketDestination: () => true }).kind, PRE_PUSH_LIFECYCLE_KINDS.EXISTING_PR);
  assert.equal(classifyPrePushLifecycle(update, { prStatus: PRE_PUSH_PR_STATES.EXISTING, isTicketDestination: () => false }).kind, PRE_PUSH_LIFECYCLE_KINDS.IGNORED);
  assert.equal(classifyPrePushLifecycle(update, { prStatus: PRE_PUSH_PR_STATES.VERIFIED_ABSENT }).kind, PRE_PUSH_LIFECYCLE_KINDS.NO_PR_UPDATE);
  const create = normalizePrePushInput(`HEAD ${local} refs/heads/aidev-159-initial ${zero}\n`, { shaWidth: 40 }).updates[0];
  assert.equal(classifyPrePushLifecycle(create, { prStatus: PRE_PUSH_PR_STATES.VERIFIED_ABSENT }).kind, PRE_PUSH_LIFECYCLE_KINDS.INITIAL_PUBLICATION);
  assert.equal(classifyPrePushLifecycle(create, { prStatus: PRE_PUSH_PR_STATES.LOOKUP_FAILURE }).kind, PRE_PUSH_LIFECYCLE_KINDS.PR_LOOKUP_FAILURE);

  const duplicate = normalizePrePushInput([
    `refs/heads/one ${local} refs/heads/zkrausman/aidev-159-duplicate ${zero}`,
    `refs/heads/two ${local} refs/heads/zkrausman/aidev-159-duplicate ${remote}`,
  ].join("\n"), { shaWidth: 40 });
  assert.equal(duplicate.updates[0].kind, PRE_PUSH_KINDS.CREATE);
  assert.equal(duplicate.updates[1].kind, PRE_PUSH_KINDS.INVALID);
  assert.deepEqual(PRE_PUSH_STATE_TABLE.map(({ kind }) => kind), Object.values(PRE_PUSH_KINDS));
  assert.deepEqual(PRE_PUSH_LIFECYCLE_TABLE.map(({ kind }) => kind), Object.values(PRE_PUSH_LIFECYCLE_KINDS));
});

test("pre-push rejects malformed, ambiguous, zero, and non-commit candidate updates safely", async () => {
  const hook = join(root, "scripts", "hooks", "pre-push.mjs");
  const head = git(root, "rev-parse", "HEAD");
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  const remote = `refs/heads/${ticketBranch}`;
  const wide = "a".repeat(64);
  const wideZero = "0".repeat(64);
  const run = (input) => spawnSync(process.execPath, [hook], { cwd: root, encoding: "utf8", input });
  const cases = [
    `refs/heads/source not-a-commit ${remote} ${"0".repeat(40)}\n`,
    `HEAD ${head.slice(0, 12)} ${remote} ${"0".repeat(40)}\n`,
    `HEAD ${tree} ${remote} ${"0".repeat(40)}\n`,
    `HEAD ${head} refs/heads/ ${"0".repeat(40)}\n`,
    `(delete) ${head} ${remote} ${"0".repeat(40)}\n`,
    `(delete) ${"0".repeat(40)} refs/tags/not-a-branch ${head}\n`,
    `(delete) ${"0".repeat(40)} ${remote} ${head.slice(0, 12)}\n`,
    `refs/heads/source ${"0".repeat(40)} ${remote} ${head}\n`,
    `refs/heads/source ${head} ${remote} ${wideZero}\n`,
    `refs/heads/source ${head} ${remote} ${wide}\n`,
    `(delete) ${"0".repeat(40)} ${remote} ${wide}\n`,
  ];
  for (const input of cases) {
    const result = run(input);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  const deletion = run(`(delete) ${"0".repeat(40)} ${remote} ${head}\n`);
  assert.equal(deletion.status, 0, `${deletion.stdout}\n${deletion.stderr}`);
  const zeroRemoteDeletion = run(`(delete) ${"0".repeat(40)} ${remote} ${"0".repeat(40)}\n`);
  assert.notEqual(zeroRemoteDeletion.status, 0, `${zeroRemoteDeletion.stdout}\n${zeroRemoteDeletion.stderr}`);
  assert.match(`${zeroRemoteDeletion.stdout}\n${zeroRemoteDeletion.stderr}`, /non-zero remote commit SHA|validation failed/);
});

test("the real pre-push attached-HEAD path accepts clean then rejects same-head revocation", async () => {
  const fixture = await alternateProfileRepository();
  const hook = join(root, "scripts", "hooks", "pre-push.mjs");
  const receiptPath = join(fixture.cwd, "artifacts", "final-review", "receipt.json");
  let fakeGithubCommand;
  try {
    git(fixture.cwd, "checkout", "--quiet", "-b", fixture.trustedBranch);
    const symbolicRef = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: fixture.cwd, encoding: "utf8" });
    assert.equal(symbolicRef.status, 0, symbolicRef.stderr);
    assert.equal(symbolicRef.stdout.trim(), fixture.trustedBranch);
    assert.equal(git(fixture.cwd, "branch", "--show-current"), fixture.trustedBranch);

    const exactHead = git(fixture.cwd, "rev-parse", "HEAD");
    assert.equal(exactHead, fixture.head);
    const packetSha256 = digest(fixture.cwd, fixture.base, exactHead, 3);
    const clean = createFinalReviewReceipt({
      repository: fixture.trustedRepository, pullRequest: "160", base: fixture.base, head: exactHead,
      packetSha256, acceptanceMatrixSha256: "a".repeat(64), verificationEvidenceSha256: "b".repeat(64),
      reviewerModelId: "openai-codex/gpt-5.6-sol", reviewProfileVersion: "terra-final-v1", recordedAt: "2026-08-22T00:00:00.000Z",
    });
    const marker = createFinalReviewAttestation(clean, {
      repository: clean.repository, pullRequest: clean.pullRequest, base: fixture.base, head: exactHead,
      packetSha256, acceptanceMatrixSha256: clean.acceptanceMatrixSha256, verificationEvidenceSha256: clean.verificationEvidenceSha256,
    });
    const markerBytes = marker;
    await mkdir(join(fixture.cwd, "artifacts", "final-review"), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(clean)}\n`);
    fakeGithubCommand = await fakeGithub({ number: 160, baseRefOid: fixture.base, headRefName: fixture.trustedBranch, body: marker });
    const runAttachedHook = () => spawnSync(process.execPath, [hook], {
      cwd: fixture.cwd, encoding: "utf8", input: "", env: fakeGithubCommand.env,
    });
    const accepted = runAttachedHook();
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);

    const revoked = revokeFinalReviewReceipt(clean, { reason: "same-head blocker", source: "terra-parent", recordedAt: "2026-08-22T00:01:00.000Z" });
    assert.equal(revoked.base, clean.base);
    assert.equal(revoked.head, clean.head);
    const published = await fakeGithubCommand.record();
    assert.equal(published.baseRefOid, clean.base);
    assert.equal(published.headRefName, fixture.trustedBranch);
    assert.equal(published.body, markerBytes);
    await writeFile(receiptPath, `${JSON.stringify(revoked)}\n`);
    const rejected = runAttachedHook();
    assert.notEqual(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /pre-push.*validation failed|current clean|non-revoked receipt/);
  } finally {
    if (fakeGithubCommand) await rm(fakeGithubCommand.directory, { recursive: true, force: true });
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("detached four-field pre-push enforces alternate trusted policy despite candidate drift", async () => {
  const fixture = await alternateProfileRepository();
  const hook = join(root, "scripts", "hooks", "pre-push.mjs");
  const receiptPath = join(fixture.cwd, "artifacts", "final-review", "receipt.json");
  let fakeGithubCommand;
  try {
    git(fixture.cwd, "checkout", "--quiet", "--detach", fixture.head);
    const symbolicRef = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: fixture.cwd, encoding: "utf8" });
    assert.notEqual(symbolicRef.status, 0);
    assert.equal(git(fixture.cwd, "branch", "--show-current"), "");

    const packetSha256 = digest(fixture.cwd, fixture.base, fixture.head, 3);
    const review = (repository) => {
      const receipt = createFinalReviewReceipt({
        repository, pullRequest: "160", base: fixture.base, head: fixture.head,
        packetSha256, acceptanceMatrixSha256: "a".repeat(64), verificationEvidenceSha256: "b".repeat(64),
        reviewerModelId: "openai-codex/gpt-5.6-sol", reviewProfileVersion: "terra-final-v1", recordedAt: "2026-08-22T00:00:00.000Z",
      });
      return { receipt, marker: createFinalReviewAttestation(receipt, {
        repository, pullRequest: "160", base: fixture.base, head: fixture.head,
        packetSha256, acceptanceMatrixSha256: receipt.acceptanceMatrixSha256, verificationEvidenceSha256: receipt.verificationEvidenceSha256,
      }) };
    };
    const unmarked = invoke(fixture.cwd, {
      base: fixture.base, head: fixture.head, branch: fixture.trustedBranch, body: "No review marker.",
    }, {
      ADVERSARIAL_REVIEW_BRANCH_PREFIX: fixture.candidateBranch.split("/", 1)[0],
      ADVERSARIAL_REVIEW_WORK_ITEM_PATTERN: "^OTHER-[0-9]+$",
      ADVERSARIAL_REVIEW_REMOTE_BRANCH: fixture.candidateBranch,
    });
    assert.notEqual(unmarked.status, 0, unmarked.stdout);
    assert.match(unmarked.stderr, /v3 final-review attestation is required/);

    await mkdir(join(fixture.cwd, "artifacts", "final-review"), { recursive: true });
    const trusted = review(fixture.trustedRepository);
    const markerBytes = trusted.marker;
    await writeFile(receiptPath, `${JSON.stringify(trusted.receipt)}\n`);
    fakeGithubCommand = await fakeGithub({ number: 160, baseRefOid: fixture.base, headRefName: fixture.trustedBranch, body: markerBytes });
    const input = `refs/heads/${fixture.candidateBranch} ${fixture.head} refs/heads/${fixture.trustedBranch} ${"0".repeat(40)}\n`;
    const runHook = () => spawnSync(process.execPath, [hook], { cwd: fixture.cwd, encoding: "utf8", input, env: fakeGithubCommand.env });
    const accepted = runHook();
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);

    const revoked = revokeFinalReviewReceipt(trusted.receipt, { reason: "same-head blocker", source: "terra-parent", recordedAt: "2026-08-22T00:01:00.000Z" });
    assert.equal(revoked.base, trusted.receipt.base);
    assert.equal(revoked.head, trusted.receipt.head);
    const published = await fakeGithubCommand.record();
    assert.equal(published.baseRefOid, trusted.receipt.base);
    assert.equal(published.headRefName, fixture.trustedBranch);
    assert.equal(published.body, markerBytes);
    await writeFile(receiptPath, `${JSON.stringify(revoked)}\n`);
    const revokedResult = runHook();
    assert.notEqual(revokedResult.status, 0, `${revokedResult.stdout}\n${revokedResult.stderr}`);
    assert.match(`${revokedResult.stdout}\n${revokedResult.stderr}`, /pre-push.*validation failed|current clean|non-revoked receipt/);

    const candidate = review(fixture.candidateRepository);
    await writeFile(receiptPath, `${JSON.stringify(candidate.receipt)}\n`);
    await fakeGithubCommand.update({ number: 160, baseRefOid: fixture.base, headRefName: fixture.trustedBranch, body: candidate.marker });
    const rejected = runHook();
    assert.notEqual(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /repository|validation failed/);
  } finally {
    if (fakeGithubCommand) await rm(fakeGithubCommand.directory, { recursive: true, force: true });
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("real Git detached HEAD push to a trusted destination enforces clean and revoked receipts", async () => {
  const fixture = await alternateProfileRepository();
  const remoteRoot = await mkdtemp(join(tmpdir(), "pi-adversarial-bare-remote-"));
  const remote = join(remoteRoot, "remote.git");
  const receiptPath = join(fixture.cwd, "artifacts", "final-review", "receipt.json");
  let fakeGithubCommand;
  try {
    await installRealPrePushHook(fixture, remote);
    git(fixture.cwd, "checkout", "--quiet", "--detach", fixture.head);
    const symbolicRef = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: fixture.cwd, encoding: "utf8" });
    assert.notEqual(symbolicRef.status, 0);

    const packetSha256 = digest(fixture.cwd, fixture.base, fixture.head, 3);
    const clean = createFinalReviewReceipt({
      repository: fixture.trustedRepository, pullRequest: "160", base: fixture.base, head: fixture.head,
      packetSha256, acceptanceMatrixSha256: "a".repeat(64), verificationEvidenceSha256: "b".repeat(64),
      reviewerModelId: "openai-codex/gpt-5.6-sol", reviewProfileVersion: "terra-final-v1", recordedAt: "2026-08-22T00:00:00.000Z",
    });
    const marker = createFinalReviewAttestation(clean, {
      repository: clean.repository, pullRequest: clean.pullRequest, base: fixture.base, head: fixture.head,
      packetSha256, acceptanceMatrixSha256: clean.acceptanceMatrixSha256, verificationEvidenceSha256: clean.verificationEvidenceSha256,
    });
    await mkdir(join(fixture.cwd, "artifacts", "final-review"), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(clean)}\n`);
    fakeGithubCommand = await fakeGithub({ number: 160, baseRefOid: fixture.base, headRefName: fixture.trustedBranch, body: marker });
    const runPush = (force = false) => spawnSync("git", ["push", ...(force ? ["--force"] : []), "origin", `HEAD:refs/heads/${fixture.trustedBranch}`], {
      cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env,
    });

    const accepted = runPush();
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    assert.equal(git(remote, "rev-parse", `refs/heads/${fixture.trustedBranch}`), fixture.head);

    const revoked = revokeFinalReviewReceipt(clean, { reason: "same-head blocker", source: "terra-parent", recordedAt: "2026-08-22T00:01:00.000Z" });
    assert.equal(revoked.base, clean.base);
    assert.equal(revoked.head, clean.head);
    const published = await fakeGithubCommand.record();
    assert.equal(published.baseRefOid, clean.base);
    assert.equal(published.headRefName, fixture.trustedBranch);
    assert.equal(published.body, marker);
    await writeFile(receiptPath, `${JSON.stringify(revoked)}\n`);
    // Remove the already-pushed ref so Git invokes the hook again for the same
    // exact local commit instead of optimizing the update as up-to-date.
    git(remote, "update-ref", "-d", `refs/heads/${fixture.trustedBranch}`, fixture.head);

    const rejected = runPush();
    assert.notEqual(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /pre-push.*validation failed|current clean|non-revoked receipt/);
    const remoteRef = spawnSync("git", ["show-ref", "--verify", `refs/heads/${fixture.trustedBranch}`], { cwd: remote, encoding: "utf8" });
    assert.notEqual(remoteRef.status, 0);
  } finally {
    if (fakeGithubCommand) await rm(fakeGithubCommand.directory, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("real Git branch creation and deletion use the deletion protocol without evidence", async () => {
  const fixture = await alternateProfileRepository();
  const remoteRoot = await mkdtemp(join(tmpdir(), "pi-adversarial-delete-remote-"));
  const remote = join(remoteRoot, "remote.git");
  const receiptPath = join(fixture.cwd, "artifacts", "final-review", "receipt.json");
  let fakeGithubCommand;
  try {
    await installRealPrePushHook(fixture, remote);
    git(fixture.cwd, "checkout", "--quiet", "-b", fixture.trustedBranch);

    const packetSha256 = digest(fixture.cwd, fixture.base, fixture.head, 3);
    const clean = createFinalReviewReceipt({
      repository: fixture.trustedRepository, pullRequest: "160", base: fixture.base, head: fixture.head,
      packetSha256, acceptanceMatrixSha256: "a".repeat(64), verificationEvidenceSha256: "b".repeat(64),
      reviewerModelId: "openai-codex/gpt-5.6-sol", reviewProfileVersion: "terra-final-v1", recordedAt: "2026-08-22T00:00:00.000Z",
    });
    const marker = createFinalReviewAttestation(clean, {
      repository: clean.repository, pullRequest: clean.pullRequest, base: fixture.base, head: fixture.head,
      packetSha256, acceptanceMatrixSha256: clean.acceptanceMatrixSha256, verificationEvidenceSha256: clean.verificationEvidenceSha256,
    });
    await mkdir(join(fixture.cwd, "artifacts", "final-review"), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(clean)}\n`);
    fakeGithubCommand = await fakeGithub({ number: 160, baseRefOid: fixture.base, headRefName: fixture.trustedBranch, body: marker });

    const created = spawnSync("git", ["push", "origin", fixture.trustedBranch], {
      cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env,
    });
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    assert.equal(git(remote, "rev-parse", `refs/heads/${fixture.trustedBranch}`), fixture.head);

    // Deliberately remove the receipt and make any accidental PR lookup
    // malformed; a valid deletion must not request candidate evidence.
    await rm(receiptPath, { force: true });
    await fakeGithubCommand.update({});
    const deleted = spawnSync("git", ["push", "origin", "--delete", fixture.trustedBranch], {
      cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env,
    });
    assert.equal(deleted.status, 0, `${deleted.stdout}\n${deleted.stderr}`);
    const remoteRef = spawnSync("git", ["show-ref", "--verify", `refs/heads/${fixture.trustedBranch}`], { cwd: remote, encoding: "utf8" });
    assert.notEqual(remoteRef.status, 0);
  } finally {
    if (fakeGithubCommand) await rm(fakeGithubCommand.directory, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("real Git attached branch update validates the new exact local candidate", async () => {
  const fixture = await alternateProfileRepository();
  const remoteRoot = await mkdtemp(join(tmpdir(), "pi-adversarial-update-remote-"));
  const remote = join(remoteRoot, "remote.git");
  let fakeGithubCommand;
  try {
    await installRealPrePushHook(fixture, remote);
    git(fixture.cwd, "checkout", "--quiet", "-b", fixture.trustedBranch);
    const first = trustedV3Review(fixture);
    await writeReceipt(fixture, first.receipt);
    fakeGithubCommand = await fakeGithub({ number: 160, baseRefOid: fixture.base, headRefName: fixture.trustedBranch, body: first.body });
    const created = spawnSync("git", ["push", "origin", fixture.trustedBranch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    assert.equal(git(remote, "rev-parse", `refs/heads/${fixture.trustedBranch}`), fixture.head);

    await writeFile(join(fixture.cwd, "candidate.txt"), "updated\n");
    git(fixture.cwd, "add", "candidate.txt");
    git(fixture.cwd, "commit", "--quiet", "-m", "candidate update");
    const nextHead = git(fixture.cwd, "rev-parse", "HEAD");
    const next = trustedV3Review(fixture, nextHead);
    await writeReceipt(fixture, next.receipt);
    await fakeGithubCommand.update({ number: 160, baseRefOid: fixture.base, headRefName: fixture.trustedBranch, body: next.body });
    const updated = spawnSync("git", ["push", "origin", fixture.trustedBranch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
    assert.equal(updated.status, 0, `${updated.stdout}\n${updated.stderr}`);
    assert.equal(git(remote, "rev-parse", `refs/heads/${fixture.trustedBranch}`), nextHead);
  } finally {
    if (fakeGithubCommand) await rm(fakeGithubCommand.directory, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("real Git verified-absent PR allows initial publication but rejects an existing-branch update", async () => {
  const fixture = await alternateProfileRepository();
  const remoteRoot = await mkdtemp(join(tmpdir(), "pi-adversarial-initial-publication-remote-"));
  const remote = join(remoteRoot, "remote.git");
  let fakeGithubCommand;
  try {
    await installRealPrePushHook(fixture, remote);
    git(fixture.cwd, "checkout", "--quiet", "-b", fixture.trustedBranch);
    fakeGithubCommand = await fakeGithub({ mode: "absent" });
    const created = spawnSync("git", ["push", "origin", fixture.trustedBranch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    assert.match(`${created.stdout}\n${created.stderr}`, /initial-publication/);
    assert.match(`${created.stdout}\n${created.stderr}`, /bootstrap PR creation/);
    assert.match(`${created.stdout}\n${created.stderr}`, /protected trusted-base CI remains blocked until the required review evidence exists/i);
    assert.doesNotMatch(`${created.stdout}\n${created.stderr}`, /early validation passed/);
    assert.equal(git(remote, "rev-parse", `refs/heads/${fixture.trustedBranch}`), fixture.head);

    await writeFile(join(fixture.cwd, "initial-publication-update.txt"), "existing branch\n");
    git(fixture.cwd, "add", "initial-publication-update.txt");
    git(fixture.cwd, "commit", "--quiet", "-m", "existing branch update without PR");
    const updated = spawnSync("git", ["push", "origin", fixture.trustedBranch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
    assert.notEqual(updated.status, 0, `${updated.stdout}\n${updated.stderr}`);
    assert.match(`${updated.stdout}\n${updated.stderr}`, /verified absent for an existing branch update|no-pr-update/);
    assert.equal(git(remote, "rev-parse", `refs/heads/${fixture.trustedBranch}`), fixture.head);
  } finally {
    if (fakeGithubCommand) await rm(fakeGithubCommand.directory, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("real Git unavailable, malformed, and ambiguous PR lookup fails closed", async () => {
  for (const mode of ["unavailable", "malformed", "ambiguous"]) {
    const fixture = await alternateProfileRepository();
    const remoteRoot = await mkdtemp(join(tmpdir(), `pi-adversarial-pr-lookup-${mode}-remote-`));
    const remote = join(remoteRoot, "remote.git");
    let fakeGithubCommand;
    try {
      await installRealPrePushHook(fixture, remote);
      git(fixture.cwd, "checkout", "--quiet", "-b", fixture.trustedBranch);
      fakeGithubCommand = await fakeGithub({ mode });
      const result = spawnSync("git", ["push", "origin", fixture.trustedBranch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
      assert.notEqual(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /GitHub|lookup|valid JSON|unexpected|absence/i, mode);
      const remoteRef = spawnSync("git", ["show-ref", "--verify", `refs/heads/${fixture.trustedBranch}`], { cwd: remote, encoding: "utf8" });
      assert.notEqual(remoteRef.status, 0, mode);
    } finally {
      if (fakeGithubCommand) await rm(fakeGithubCommand.directory, { recursive: true, force: true });
      await rm(remoteRoot, { recursive: true, force: true });
      await rm(fixture.cwd, { recursive: true, force: true });
    }
  }
});

test("real Git SHA-256 create, update, and deletion bind every tuple SHA to the inspected format", async () => {
  const fixture = await alternateProfileRepository("sha256");
  const remoteRoot = await mkdtemp(join(tmpdir(), "pi-adversarial-sha256-remote-"));
  const remote = join(remoteRoot, "remote.git");
  const receiptPath = join(fixture.cwd, "artifacts", "final-review", "receipt.json");
  let fakeGithubCommand;
  try {
    assert.equal(git(fixture.cwd, "rev-parse", "--show-object-format"), "sha256");
    await installRealPrePushHook(fixture, remote, "sha256");
    git(fixture.cwd, "checkout", "--quiet", "-b", fixture.trustedBranch);
    const first = trustedV3Review(fixture);
    await writeReceipt(fixture, first.receipt);
    fakeGithubCommand = await fakeGithub({ number: 160, baseRefOid: fixture.base, headRefName: fixture.trustedBranch, body: first.body });
    const created = spawnSync("git", ["push", "origin", fixture.trustedBranch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    assert.equal(git(remote, "rev-parse", `refs/heads/${fixture.trustedBranch}`), fixture.head);
    assert.equal(fixture.head.length, 64);

    await writeFile(join(fixture.cwd, "sha256-update.txt"), "updated\n");
    git(fixture.cwd, "add", "sha256-update.txt");
    git(fixture.cwd, "commit", "--quiet", "-m", "sha256 update");
    const nextHead = git(fixture.cwd, "rev-parse", "HEAD");
    const next = trustedV3Review(fixture, nextHead);
    await writeReceipt(fixture, next.receipt);
    await fakeGithubCommand.update({ number: 160, baseRefOid: fixture.base, headRefName: fixture.trustedBranch, body: next.body });
    const updated = spawnSync("git", ["push", "origin", fixture.trustedBranch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
    assert.equal(updated.status, 0, `${updated.stdout}\n${updated.stderr}`);
    assert.equal(git(remote, "rev-parse", `refs/heads/${fixture.trustedBranch}`), nextHead);

    await fakeGithubCommand.update({});
    const deleted = spawnSync("git", ["push", "origin", "--delete", fixture.trustedBranch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
    assert.equal(deleted.status, 0, `${deleted.stdout}\n${deleted.stderr}`);
    const remoteRef = spawnSync("git", ["show-ref", "--verify", `refs/heads/${fixture.trustedBranch}`], { cwd: remote, encoding: "utf8" });
    assert.notEqual(remoteRef.status, 0);
    await rm(receiptPath, { force: true });
  } finally {
    if (fakeGithubCommand) await rm(fakeGithubCommand.directory, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("real Git non-ticket branch destination remains explicitly evidence-free", async () => {
  const fixture = await alternateProfileRepository();
  const remoteRoot = await mkdtemp(join(tmpdir(), "pi-adversarial-non-ticket-remote-"));
  const remote = join(remoteRoot, "remote.git");
  const branch = "other/non-ticket-159";
  let fakeGithubCommand;
  try {
    await installRealPrePushHook(fixture, remote);
    git(fixture.cwd, "checkout", "--quiet", "-b", branch);
    fakeGithubCommand = await fakeGithub({ number: 160, baseRefOid: fixture.base, headRefName: branch, body: "not an attestation marker" });
    const pushed = spawnSync("git", ["push", "origin", branch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
    assert.equal(pushed.status, 0, `${pushed.stdout}\n${pushed.stderr}`);
    assert.match(`${pushed.stdout}\n${pushed.stderr}`, /exact trusted PR base classifies this destination as non-ticket/);
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), fixture.head);
  } finally {
    if (fakeGithubCommand) await rm(fakeGithubCommand.directory, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("real hook rejects malformed deletion before allowing a valid bare-remote deletion", async () => {
  const fixture = await alternateProfileRepository();
  const remoteRoot = await mkdtemp(join(tmpdir(), "pi-adversarial-malformed-delete-remote-"));
  const remote = join(remoteRoot, "remote.git");
  const branch = "other/malformed-delete-159";
  let fakeGithubCommand;
  try {
    await installRealPrePushHook(fixture, remote);
    git(fixture.cwd, "checkout", "--quiet", "-b", branch);
    fakeGithubCommand = await fakeGithub({ number: 160, baseRefOid: fixture.base, headRefName: branch, body: "not an attestation marker" });
    const created = spawnSync("git", ["push", "origin", branch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), fixture.head);

    await fakeGithubCommand.update({});
    const hook = join(fixture.cwd, ".git", "hooks", "pre-push");
    const malformed = spawnSync(process.execPath, [hook], {
      cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env,
      input: `(delete) ${"0".repeat(40)} refs/heads/${branch} ${"0".repeat(40)}\n`,
    });
    assert.notEqual(malformed.status, 0, `${malformed.stdout}\n${malformed.stderr}`);
    assert.match(`${malformed.stdout}\n${malformed.stderr}`, /non-zero remote commit SHA|validation failed/);
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), fixture.head);

    const deleted = spawnSync("git", ["push", "origin", "--delete", branch], { cwd: fixture.cwd, encoding: "utf8", env: fakeGithubCommand.env });
    assert.equal(deleted.status, 0, `${deleted.stdout}\n${deleted.stderr}`);
    const remoteRef = spawnSync("git", ["show-ref", "--verify", `refs/heads/${branch}`], { cwd: remote, encoding: "utf8" });
    assert.notEqual(remoteRef.status, 0);
  } finally {
    if (fakeGithubCommand) await rm(fakeGithubCommand.directory, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("solo maintainer attestation accepts a privacy-safe clean marker on the exact packet", async () => {
  const fixture = await repository();
  try {
    const input = validInput(fixture);
    assert.doesNotMatch(input.body, /reviewer|session|credential/i);
    const result = invoke(fixture.cwd, input);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /attestation validated/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("historical v2 attestation remains bound to frozen v2 bytes", async () => {
  const fixture = await repository();
  try {
    const v3Digest = digest(fixture.cwd, fixture.base, fixture.head, 3);
    const result = invoke(fixture.cwd, { ...fixture, branch: ticketBranch, body: marker({ ...fixture, packetSha256: v3Digest }) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packet digest/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("historical bootstrap base rejects missing v2 and accepts a bound v2 template marker", async () => {
  const fixture = await historicalBootstrapRepository();
  try {
    assert.equal(git(fixture.cwd, "cat-file", "-t", fixture.base), "commit");
    assert.equal(git(fixture.cwd, "cat-file", "-t", fixture.templateBase), "commit");
    assert.equal(git(fixture.cwd, "cat-file", "-t", fixture.head), "commit");
    assert.equal(git(fixture.cwd, "remote"), "");
    assert.match(fixture.template, V2_TEMPLATE_MARKER);

    const baseToTemplate = spawnSync("git", ["merge-base", "--is-ancestor", fixture.base, fixture.templateBase], { cwd: fixture.cwd, encoding: "utf8" });
    const templateToHead = spawnSync("git", ["merge-base", "--is-ancestor", fixture.templateBase, fixture.head], { cwd: fixture.cwd, encoding: "utf8" });
    assert.equal(baseToTemplate.status, 0, baseToTemplate.stderr);
    assert.equal(templateToHead.status, 0, templateToHead.stderr);

    // The enclosing checkout has neither the old candidate object nor an ancestry path to it.
    const unavailableHistoricalObject = spawnSync("git", ["cat-file", "-e", `${RETIRED_HISTORICAL_OBJECT}^{commit}`], { cwd: fixture.cwd, encoding: "utf8" });
    const unrelatedHistoricalBase = spawnSync("git", ["merge-base", "--is-ancestor", RETIRED_HISTORICAL_OBJECT, fixture.head], { cwd: fixture.cwd, encoding: "utf8" });
    assert.notEqual(unavailableHistoricalObject.status, 0);
    assert.notEqual(unrelatedHistoricalBase.status, 0);

    const packetSha256 = digest(fixture.cwd, fixture.base, fixture.head);
    const wrongPacketSha256 = digest(fixture.cwd, fixture.templateBase, fixture.head);
    const cases = [
      ["missing v2 marker", templateWithMarker(fixture.template, ""), /v2 adversarial-review attestation is required by the exact trusted base/],
      ["malformed v2 marker", templateWithMarker(fixture.template, "<!-- pi-sampler-adversarial-review-attestation:v2 not-json -->"), /exactly once|invalid JSON/],
      ["wrong base", templateWithMarker(fixture.template, marker({ base: fixture.templateBase, head: fixture.head, packetSha256 })), /base or head does not match/],
      ["wrong head", templateWithMarker(fixture.template, marker({ base: fixture.base, head: fixture.templateBase, packetSha256 })), /base or head does not match/],
      ["stale digest", templateWithMarker(fixture.template, marker({ base: fixture.base, head: fixture.head, packetSha256: "0".repeat(64) })), /packet digest/],
      ["wrong packet", templateWithMarker(fixture.template, marker({ base: fixture.base, head: fixture.head, packetSha256: wrongPacketSha256 })), /packet digest/],
    ];
    for (const [name, body, expected] of cases) {
      const result = invoke(fixture.cwd, { base: fixture.base, head: fixture.head, branch: ticketBranch, body });
      assert.notEqual(result.status, 0, `${name}: ${result.stdout}`);
      assert.match(result.stderr, expected, name);
    }

    const valid = invoke(fixture.cwd, {
      base: fixture.base, head: fixture.head, branch: ticketBranch,
      body: templateWithMarker(fixture.template, marker({ base: fixture.base, head: fixture.head, packetSha256 })),
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /Adversarial review attestation validated/);

    const v3OnLegacyBase = invoke(fixture.cwd, {
      base: fixture.base, head: fixture.head, branch: ticketBranch,
      body: templateWithMarker(fixture.template, markerV3({ base: fixture.base, head: fixture.head, packetSha256: digest(fixture.cwd, fixture.base, fixture.head, 3) })),
    });
    assert.notEqual(v3OnLegacyBase.status, 0);
    assert.match(v3OnLegacyBase.stderr, /not accepted until the exact trusted base activates v3/);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
    assert.equal(existsSync(fixture.cwd), false);
  }
});

test("v3 final-review attestation binds the complete v3 packet and bounded provenance", async () => {
  const fixture = await activatedRepository();
  try {
    const packetSha256 = digest(fixture.cwd, fixture.base, fixture.head, 3);
    const body = markerV3({ ...fixture, packetSha256 });
    const result = invoke(fixture.cwd, { ...fixture, branch: ticketBranch, body });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Final review attestation validated/);
    assert.doesNotMatch(body, /session|transcript|finding|path|token|cost/i);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("public v3 validation has provenance parity and never echoes privacy probes", async () => {
  const fixture = await activatedRepository();
  try {
    const packetSha256 = digest(fixture.cwd, fixture.base, fixture.head, 3);
    for (const reviewerModelId of REVIEW_PROVENANCE_CANONICAL_EXAMPLES.reviewerModelId) {
      for (const reviewProfileVersion of REVIEW_PROVENANCE_CANONICAL_EXAMPLES.reviewProfileVersion) {
        const body = markerV3({ ...fixture, packetSha256, reviewerModelId, reviewProfileVersion });
        const result = invoke(fixture.cwd, { ...fixture, branch: ticketBranch, body });
        assert.equal(result.status, 0, `${reviewerModelId}/${reviewProfileVersion}: ${result.stderr}`);
      }
    }
    for (const [field, probes] of Object.entries(REVIEW_PROVENANCE_PRIVACY_PROBES)) {
      for (const rejected of probes) {
        const body = markerV3({ ...fixture, packetSha256, [field]: rejected });
        const result = invoke(fixture.cwd, { ...fixture, branch: ticketBranch, body });
        assert.notEqual(result.status, 0, `public validator accepted ${field} privacy probe`);
        assert.ok(!result.stderr.includes(rejected), `public validator echoed ${field} privacy probe`);
      }
    }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("v2 remains legacy evidence and cannot satisfy the v3 final-review requirement after trusted-base activation", async () => {
  const fixture = await activatedRepository();
  try {
    const body = marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head) });
    const result = invoke(fixture.cwd, { ...fixture, branch: ticketBranch, body });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy packet-consistency evidence|v3 final-review gate/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("trusted-base activation rejects tree, annotated-tag, ref, and short base inputs", async () => {
  const fixture = await activatedRepository();
  try {
    git(fixture.cwd, "tag", "--annotate", "legacy-base-tag", "--message", "legacy base", fixture.legacyBase);
    const tree = git(fixture.cwd, "rev-parse", `${fixture.legacyBase}^{tree}`);
    const tagObject = git(fixture.cwd, "rev-parse", "refs/tags/legacy-base-tag^{tag}");
    const invalidBases = [
      ["tree object", tree, /exact commit object/],
      ["annotated tag object", tagObject, /exact commit object/],
      ["ref", "refs/tags/legacy-base-tag", /exact lowercase (?:commit SHA|40- or 64-character commit SHAs)/],
      ["short SHA", fixture.legacyBase.slice(0, 12), /exact lowercase (?:commit SHA|40- or 64-character commit SHAs)/],
    ];
    for (const [name, base, expected] of invalidBases) {
      const result = invoke(fixture.cwd, { ...fixture, base, branch: ticketBranch, body: "No review marker." });
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, expected, name);
    }
    const valid = invoke(fixture.cwd, {
      ...fixture,
      branch: ticketBranch,
      body: markerV3({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head, 3) }),
    });
    assert.equal(valid.status, 0, valid.stderr);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("v3 rejects extra provenance, stale digests, and non-clean outcomes", async () => {
  const fixture = await activatedRepository();
  try {
    const packetSha256 = digest(fixture.cwd, fixture.base, fixture.head, 3);
    const valid = markerV3({ ...fixture, packetSha256 });
    const cases = [
      [valid.replace('"outcome":"clean"', '"sessionId":"secret","outcome":"clean"'), /unsupported or missing fields/],
      [valid.replace('"outcome":"clean"', '"outcome":"clean","outcome":"clean"'), /duplicate object key/],
      [markerV3({ ...fixture, packetSha256: "0".repeat(64) }), /packet digest/],
      [markerV3({ ...fixture, packetSha256, outcome: "blocked" }), /outcome must be clean/],
    ];
    for (const [body, expected] of cases) {
      const result = invoke(fixture.cwd, { ...fixture, branch: ticketBranch, body: `${body}` });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stderr, /secret/);
    }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("bootstrap preserves trusted legacy v2 enforcement and post-activation requires v3", async () => {
  const bootstrap = await repository();
  const activated = await activatedRepository();
  try {
    const bootstrapPacketSha256 = digest(bootstrap.cwd, bootstrap.base, bootstrap.head);
    const bootstrapV2 = marker({ ...bootstrap, packetSha256: bootstrapPacketSha256 });
    const bootstrapTicket = invoke(bootstrap.cwd, { ...bootstrap, branch: ticketBranch, body: bootstrapV2 });
    assert.equal(bootstrapTicket.status, 0, bootstrapTicket.stderr);
    assert.match(bootstrapTicket.stdout, /Adversarial review attestation validated/);
    const bootstrapCases = [
      ["missing v2 marker", "No review marker.", /v2 adversarial-review attestation is required by the exact trusted base/],
      ["malformed v2 marker", "<!-- pi-sampler-adversarial-review-attestation:v2 not-json -->", /exactly once|invalid JSON/],
      ["stale v2 digest", marker({ ...bootstrap, packetSha256: "0".repeat(64) }), /packet digest/],
      ["unbound v2 marker", marker({ base: bootstrap.head, head: bootstrap.head, packetSha256: bootstrapPacketSha256 }), /base or head does not match/],
    ];
    for (const [name, body, expected] of bootstrapCases) {
      const result = invoke(bootstrap.cwd, { ...bootstrap, branch: ticketBranch, body });
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, expected, name);
    }
    const bootstrapV3 = invoke(bootstrap.cwd, { ...bootstrap, branch: ticketBranch, body: markerV3({ ...bootstrap, packetSha256: digest(bootstrap.cwd, bootstrap.base, bootstrap.head, 3) }) });
    assert.notEqual(bootstrapV3.status, 0);
    assert.match(bootstrapV3.stderr, /not accepted until the exact trusted base activates v3/);
    const activatedTicket = invoke(activated.cwd, { ...activated, branch: ticketBranch, body: "No review marker." });
    assert.notEqual(activatedTicket.status, 0);
    assert.match(activatedTicket.stderr, /v3 final-review attestation is required/);
    const activatedV2 = invoke(activated.cwd, { ...activated, branch: ticketBranch, body: marker({ ...activated, packetSha256: digest(activated.cwd, activated.base, activated.head) }) });
    assert.notEqual(activatedV2.status, 0);
    assert.match(activatedV2.stderr, /legacy packet-consistency evidence|v3 final-review gate/);
  } finally {
    await rm(bootstrap.cwd, { recursive: true, force: true });
    await rm(activated.cwd, { recursive: true, force: true });
  }
});

test("candidate flags and environment cannot select v3 activation", async () => {
  const bootstrap = await repository();
  const activated = await activatedRepository();
  try {
    const bootstrapResult = invoke(bootstrap.cwd, { ...bootstrap, branch: ticketBranch, body: marker({ ...bootstrap, packetSha256: digest(bootstrap.cwd, bootstrap.base, bootstrap.head) }) }, { ADVERSARIAL_REVIEW_REQUIRE_V3: "true" });
    assert.equal(bootstrapResult.status, 0, bootstrapResult.stderr);
    const activatedResult = invoke(activated.cwd, { ...activated, branch: ticketBranch, body: "No review marker." }, { ADVERSARIAL_REVIEW_REQUIRE_V3: "false" });
    assert.notEqual(activatedResult.status, 0);
    assert.match(activatedResult.stderr, /v3 final-review attestation is required/);
  } finally {
    await rm(bootstrap.cwd, { recursive: true, force: true });
    await rm(activated.cwd, { recursive: true, force: true });
  }
});

test("adversarial review attestation fails closed for malformed, multiple, stale, non-clean, and sensitive markers", async () => {
  const fixture = await activatedRepository();
  try {
    const packetSha256 = digest(fixture.cwd, fixture.base, fixture.head, 3);
    const valid = { ...fixture, branch: ticketBranch, body: markerV3({ ...fixture, packetSha256 }) };
    const cases = [
      ["reviewer identity field", markerV3({ ...fixture, packetSha256 }).replace('"outcome"', '"reviewerRole":"private-reviewer","outcome"'), /unsupported or missing fields/],
      ["malformed", "<!-- pi-sampler-adversarial-review-attestation:v3 not-json -->", /exactly once|invalid JSON/],
      ["multiple", `${valid.body}\n${valid.body}`, /exactly once/],
      ["stale digest", markerV3({ ...fixture, packetSha256: "0".repeat(64) }), /packet digest/],
      ["stale base", markerV3({ ...fixture, base: "0".repeat(40), packetSha256 }), /trusted base validator|base or head does not match/],
      ["unresolved outcome", markerV3({ ...fixture, packetSha256, outcome: "blocker" }), /outcome must be clean/],
      ["private body is not printed", "private-example $(do-not-execute)", /required for a trusted ticket branch/],
      ["oversized body", "x".repeat(24 * 1024 + 1), /body is missing, unsafe, or exceeds its bound/],
    ];
    for (const [name, body, expected] of cases) {
      const result = invoke(fixture.cwd, { ...valid, body });
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, expected, name);
      assert.doesNotMatch(result.stderr, /private-example|do-not-execute|private-reviewer/, name);
    }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});
