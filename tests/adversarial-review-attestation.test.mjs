import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFinalReviewAttestation, createFinalReviewReceipt, revokeFinalReviewReceipt } from "../scripts/final-review-receipt.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const validator = join(root, "scripts", "validate-adversarial-review-attestation.mjs");
const packetGenerator = join(root, "scripts", "generate-review-packet.mjs");
const { TRUSTED_V3_ATTESTATION_ACTIVATION } = await import(pathToFileURL(validator).href);
const ticketBranch = "zkrausman/aidev-109-make-adversarial-review-gate-solo-maintainer-compatible";
const HISTORICAL_BOOTSTRAP_BASE = "465e7a4a20e78f100b5cefcf29fbf41c65656f94";
const HISTORICAL_V2_TEMPLATE_BASE = "92b538cefd1d50d3d109f36cdbe14e7c747d51f2";
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
async function alternateProfileRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-adversarial-alternate-profile-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "user.name", "Attestation Test");
  await mkdir(join(cwd, "scripts"));
  await mkdir(join(cwd, "profiles"));
  for (const file of [
    "validate-adversarial-review-attestation.mjs", "generate-review-packet.mjs", "final-review-receipt.mjs", "validate-review-packet.mjs",
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
  return `<!-- pi-sampler-adversarial-review-attestation:v3 ${JSON.stringify({ format: "pi-sampler.adversarial-review-attestation", version: 3, base, head, outcome, packetSha256, acceptanceMatrixSha256: provenance.acceptanceMatrixSha256 ?? "a".repeat(64), verificationEvidenceSha256: provenance.verificationEvidenceSha256 ?? "b".repeat(64), reviewerModelId: provenance.reviewerModelId ?? "openai/gpt-5.6", reviewProfileVersion: provenance.reviewProfileVersion ?? "terra-final-v1", receiptSha256: provenance.receiptSha256 ?? "c".repeat(64) })} -->`;
}
function templateWithMarker(template, replacement) {
  assert.match(template, V2_TEMPLATE_MARKER);
  return template.replace(V2_TEMPLATE_MARKER, replacement);
}
async function fakeGithub(record) {
  const directory = await mkdtemp(join(tmpdir(), "pi-adversarial-fake-gh-"));
  const recordPath = join(directory, "record.json");
  await writeFile(recordPath, JSON.stringify(record));
  let nodeOptions;
  if (process.platform === "win32") {
    const preload = join(directory, "fake-gh-preload.cjs");
    await writeFile(preload, String.raw`const fs = require("node:fs"); const arg = process.argv[1] || ""; if (arg === "pr" || arg.endsWith("\\pr") || arg.endsWith("/pr")) { process.stdout.write(fs.readFileSync(process.env.FAKE_GH_RECORD, "utf8")); process.exit(0); }` + "\n");
    await copyFile(process.execPath, join(directory, "gh.exe"));
    nodeOptions = `--require=${preload}`;
  } else {
    await writeFile(join(directory, "gh"), "#!/usr/bin/env node\nimport { readFileSync } from \"node:fs\"; process.stdout.write(readFileSync(process.env.FAKE_GH_RECORD, \"utf8\"));\n");
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
  const validatorSource = (await readFile(validator, "utf8")).replace(/\r\n/g, "\n");
  assert.match(hook, /execFileSync/);
  assert.doesNotMatch(hook, /execSync|`gh pr view|origin\\\/\\$\{base/);
  assert.match(hook, /gh.*pr.*list/);
  assert.match(hook, /explicitlyVerifiedNoPr/);
  assert.match(hook, /refusing to skip attestation validation/);
  assert.match(hook, /pre-push ref input could not be read/);
  assert.match(hook, /current Git branch could not be inspected/);
  assert.match(hook, /parts\.length !== 4/);
  assert.match(hook, /remoteDeletion/);
  assert.match(hook, /--receipt/);
  assert.match(hook, /currentBranchRef/);
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
      reviewerModelId: "openai/gpt-5.6", reviewProfileVersion: "terra-final-v1", recordedAt: "2026-08-22T00:00:00.000Z",
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
        reviewerModelId: "openai/gpt-5.6", reviewProfileVersion: "terra-final-v1", recordedAt: "2026-08-22T00:00:00.000Z",
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
    const input = `refs/heads/${fixture.trustedBranch} ${fixture.head} refs/heads/${fixture.candidateBranch} ${"0".repeat(40)}\n`;
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
  assert.equal(git(root, "cat-file", "-t", HISTORICAL_BOOTSTRAP_BASE), "commit");
  assert.equal(git(root, "cat-file", "-t", HISTORICAL_V2_TEMPLATE_BASE), "commit");
  const head = git(root, "rev-parse", "HEAD");
  const template = git(root, "show", `${HISTORICAL_V2_TEMPLATE_BASE}:.github/pull_request_template.md`);
  const packetSha256 = digest(root, HISTORICAL_BOOTSTRAP_BASE, head);
  const missing = invoke(root, {
    base: HISTORICAL_BOOTSTRAP_BASE, head, branch: ticketBranch,
    body: templateWithMarker(template, ""),
  });
  assert.notEqual(missing.status, 0, missing.stdout);
  assert.match(missing.stderr, /v2 adversarial-review attestation is required by the exact trusted base/);
  const valid = invoke(root, {
    base: HISTORICAL_BOOTSTRAP_BASE, head, branch: ticketBranch,
    body: templateWithMarker(template, marker({ base: HISTORICAL_BOOTSTRAP_BASE, head, packetSha256 })),
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Adversarial review attestation validated/);
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
