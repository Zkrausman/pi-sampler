import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const validator = join(root, "scripts", "validate-adversarial-review-attestation.mjs");
const packetGenerator = join(root, "scripts", "generate-review-packet.mjs");
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
  git(cwd, "add", "tracked.txt"); git(cwd, "commit", "--quiet", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  await writeFile(join(cwd, "tracked.txt"), "head\n");
  git(cwd, "add", "tracked.txt"); git(cwd, "commit", "--quiet", "-m", "head");
  return { cwd, base, head: git(cwd, "rev-parse", "HEAD") };
}
function digest(cwd, base, head, version = 2) {
  const packet = execFileSync(process.execPath, [packetGenerator, "--version", String(version), "--base", base, "--head", head], { cwd, encoding: "utf8" });
  return createHash("sha256").update(packet, "utf8").digest("hex");
}
function marker({ base, head, packetSha256, outcome = "clean" }) {
  return `<!-- pi-sampler-adversarial-review-attestation:v2 ${JSON.stringify({ format: "pi-sampler.adversarial-review-attestation", version: 2, base, head, outcome, packetSha256 })} -->`;
}
function invoke(cwd, { base, head, branch, body }) {
  return spawnSync(process.execPath, [validator], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
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
  assert.doesNotMatch(job, /\bgh api\b|reviews\?per_page|npm run validate:adversarial-review/);
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

test("adversarial review attestation permits no marker only for strict non-ticket branches", async () => {
  const fixture = await repository();
  try {
    const nonTicket = invoke(fixture.cwd, { ...fixture, branch: "maintenance/update-ci", body: "No review marker." });
    assert.equal(nonTicket.status, 0, nonTicket.stderr);
    const ticket = invoke(fixture.cwd, { ...fixture, branch: ticketBranch, body: "No review marker." });
    assert.notEqual(ticket.status, 0);
    assert.match(ticket.stderr, /required for an AIDEV ticket branch/);
    const nearMiss = invoke(fixture.cwd, { ...fixture, branch: "zkrausman/AIDEV-109-example", body: "" });
    assert.equal(nearMiss.status, 0, nearMiss.stderr);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("adversarial review attestation fails closed for malformed, multiple, stale, non-clean, and sensitive markers", async () => {
  const fixture = await repository();
  try {
    const valid = validInput(fixture);
    const cases = [
      ["reviewer identity field", marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head) }).replace('"outcome"', '"reviewerRole":"private-reviewer","outcome"'), /unsupported or missing fields/],
      ["malformed", "<!-- pi-sampler-adversarial-review-attestation:v2 not-json -->", /exactly once|invalid JSON/],
      ["multiple", `${valid.body}\n${valid.body}`, /exactly once/],
      ["stale digest", marker({ ...fixture, packetSha256: "0".repeat(64) }), /packet digest/],
      ["stale base", marker({ ...fixture, base: "0".repeat(40), packetSha256: digest(fixture.cwd, fixture.base, fixture.head) }), /base or head does not match/],
      ["unresolved outcome", marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head), outcome: "blocker" }), /outcome must be clean/],
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
