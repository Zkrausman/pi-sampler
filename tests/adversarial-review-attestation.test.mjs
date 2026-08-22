import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const validator = join(root, "scripts", "validate-adversarial-review-attestation.mjs");
const packetGenerator = join(root, "scripts", "generate-review-packet.mjs");
const { TRUSTED_V3_ATTESTATION_ACTIVATION } = await import(pathToFileURL(validator).href);
const ticketBranch = "zkrausman/aidev-109-make-adversarial-review-gate-solo-maintainer-compatible";

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
  await writeFile(join(cwd, "scripts", "validate-adversarial-review-attestation.mjs"), "export const legacyTrustedValidator = true;\n");
  git(cwd, "add", "tracked.txt", "scripts/validate-adversarial-review-attestation.mjs"); git(cwd, "commit", "--quiet", "-m", "base");
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
  assert.match(hook, /execFileSync/);
  assert.doesNotMatch(hook, /execSync|`gh pr view|origin\\\/\\$\{base/);
  assert.match(hook, /gh.*pr.*list/);
  assert.match(hook, /explicitlyVerifiedNoPr/);
  assert.match(hook, /refusing to skip attestation validation/);
  assert.match(hook, /pre-push ref input could not be read/);
  assert.match(hook, /current Git branch could not be inspected/);
  assert.match(hook, /parts\.length !== 4/);
  assert.match(hook, /remoteDeletion/);
  assert.doesNotMatch(hook, /ADVERSARIAL_REVIEW_REQUIRE_V3|--require-v3/);
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

test("bootstrap uses trusted legacy behavior and post-activation requires v3", async () => {
  const bootstrap = await repository();
  const activated = await activatedRepository();
  try {
    const bootstrapTicket = invoke(bootstrap.cwd, { ...bootstrap, branch: ticketBranch, body: "No review marker." });
    assert.equal(bootstrapTicket.status, 0, bootstrapTicket.stderr);
    assert.match(bootstrapTicket.stdout, /No v3 final-review attestation required before trusted-base activation/);
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
    const bootstrapResult = invoke(bootstrap.cwd, { ...bootstrap, branch: ticketBranch, body: "No review marker." }, { ADVERSARIAL_REVIEW_REQUIRE_V3: "true" });
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
      ["private body is not printed", "private-example $(do-not-execute)", /required for an AIDEV ticket branch/],
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
