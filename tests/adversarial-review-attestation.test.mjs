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
const ticketBranch = "zkrausman/aidev-108-enforce-adversarial-review-evidence";

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
function digest(cwd, base, head) {
  const packet = execFileSync(process.execPath, [packetGenerator, "--base", base, "--head", head], { cwd, encoding: "utf8" });
  return createHash("sha256").update(packet, "utf8").digest("hex");
}
function marker({ base, head, packetSha256, outcome = "clean" }) {
  return `<!-- pi-sampler-adversarial-review-attestation:v2 ${JSON.stringify({ format: "pi-sampler.adversarial-review-attestation", version: 2, base, head, outcome, packetSha256 })} -->`;
}
function review({ id, login = "independent-reviewer", state = "APPROVED", commitId }) {
  return { id, state, commit_id: commitId, user: { login } };
}
async function invoke(cwd, { base, head, branch, body, author = "pr-author", reviews = [[]] }) {
  const reviewsFile = join(cwd, "reviews.json");
  await writeFile(reviewsFile, typeof reviews === "string" ? reviews : JSON.stringify(reviews));
  return spawnSync(process.execPath, [validator], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ADVERSARIAL_REVIEW_BASE_SHA: base,
      ADVERSARIAL_REVIEW_HEAD_SHA: head,
      ADVERSARIAL_REVIEW_HEAD_REF: branch,
      ADVERSARIAL_REVIEW_PR_BODY: body,
      ADVERSARIAL_REVIEW_PR_AUTHOR: author,
      ADVERSARIAL_REVIEW_REVIEWS_FILE: reviewsFile,
    },
  });
}
function validInput(fixture, reviews = [review({ id: 1, commitId: fixture.head })]) {
  return {
    ...fixture,
    branch: ticketBranch,
    body: marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head) }),
    reviews: [reviews],
  };
}

test("adversarial review gate is isolated from ordinary validation and revalidates trusted PR and review events", async () => {
  const validate = (await readFile(join(root, ".github", "workflows", "validate.yml"), "utf8")).replace(/\r\n/g, "\n");
  assert.match(validate, /^on:\n  pull_request:\n  push:\n    branches: \[main\]$/m);
  assert.doesNotMatch(validate, /pull_request_target|pull_request_review|adversarial-review-attestation/);

  const workflow = (await readFile(join(root, ".github", "workflows", "adversarial-review.yml"), "utf8")).replace(/\r\n/g, "\n");
  const start = workflow.indexOf("  adversarial-review-attestation:");
  assert.ok(start >= 0, "adversarial-review-attestation job must remain present");
  const job = workflow.slice(start);

  assert.match(workflow, /^  pull_request_target:\n    types: \[opened, reopened, synchronize, edited\]$/m);
  assert.match(workflow, /^  pull_request_review:\n    types: \[submitted, edited, dismissed\]$/m);
  assert.match(job, /if: github\.event_name == 'pull_request_target' \|\| github\.event_name == 'pull_request_review'/);
  assert.match(job, /name: Adversarial review evidence/);
  assert.match(job, /contents: read/);
  assert.match(job, /pull-requests: read/);
  assert.match(job, /ADVERSARIAL_REVIEW_HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/);
  assert.doesNotMatch(job, /ADVERSARIAL_REVIEW_HEAD_REF: \$\{\{ github\.head_ref \}\}/);
  assert.equal((job.match(/uses: actions\/checkout/g) ?? []).length, 1, "gate must use one explicitly pinned checkout");
  assert.match(job, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(job, /persist-credentials: false/);
  assert.doesNotMatch(job, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.doesNotMatch(job, /\bgit checkout\b/);
  assert.match(job, /git fetch --no-tags origin "\$ADVERSARIAL_REVIEW_HEAD_SHA"/);
  assert.match(job, /git cat-file -e "\$ADVERSARIAL_REVIEW_HEAD_SHA\^\{commit\}"/);
  assert.match(job, /pulls\/\$\{ADVERSARIAL_REVIEW_PR_NUMBER\}\/reviews\?per_page=100/);
  assert.match(job, /trap 'rm -f "\$askpass"' EXIT/);
  assert.match(job, /trap 'rm -f "\$ADVERSARIAL_REVIEW_REVIEWS_FILE"' EXIT/);
  assert.match(job, /node scripts\/validate-adversarial-review-attestation\.mjs/);
  assert.doesNotMatch(job, /npm run validate:adversarial-review/);
});

test("adversarial review attestation accepts a privacy-safe marker plus independent API approval on the PR head", async () => {
  const fixture = await repository();
  try {
    const input = validInput(fixture);
    assert.doesNotMatch(input.body, /reviewer|independent-reviewer/);
    const result = await invoke(fixture.cwd, input);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /attestation validated/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("adversarial review attestation permits no marker only for strict non-ticket branches", async () => {
  const fixture = await repository();
  try {
    const nonTicket = await invoke(fixture.cwd, { ...fixture, branch: "maintenance/update-ci", body: "No review marker." });
    assert.equal(nonTicket.status, 0, nonTicket.stderr);
    const ticket = await invoke(fixture.cwd, { ...fixture, branch: ticketBranch, body: "No review marker." });
    assert.notEqual(ticket.status, 0);
    assert.match(ticket.stderr, /required for an AIDEV ticket branch/);
    const nearMiss = await invoke(fixture.cwd, { ...fixture, branch: "zkrausman/AIDEV-108-enforce-adversarial-review-evidence", body: "" });
    assert.equal(nearMiss.status, 0, nearMiss.stderr);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("adversarial review attestation fails closed for malformed, multiple, stale, and non-clean markers", async () => {
  const fixture = await repository();
  try {
    const valid = validInput(fixture);
    const cases = [
      ["old self-asserted role field", marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head) }).replace('"outcome"', '"reviewerRole":"independent-human-reviewer","outcome"'), /unsupported or missing fields/],
      ["malformed", "<!-- pi-sampler-adversarial-review-attestation:v2 not-json -->", /exactly once|invalid JSON/],
      ["multiple", `${valid.body}\n${valid.body}`, /exactly once/],
      ["stale digest", marker({ ...fixture, packetSha256: "0".repeat(64) }), /packet digest/],
      ["stale base", marker({ ...fixture, base: "0".repeat(40), packetSha256: digest(fixture.cwd, fixture.base, fixture.head) }), /base or head does not match/],
      ["unresolved outcome", marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head), outcome: "blocker" }), /outcome must be clean/],
      ["private body is not printed", "private-example $(do-not-execute)", /required for an AIDEV ticket branch/],
    ];
    for (const [name, body, expected] of cases) {
      const result = await invoke(fixture.cwd, { ...valid, body });
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, expected, name);
      assert.doesNotMatch(result.stderr, /private-example|do-not-execute/, name);
    }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("adversarial review attestation rejects self, stale-head, and missing approvals", async () => {
  const fixture = await repository();
  try {
    const otherCommit = "a".repeat(40);
    const cases = [
      ["self approval", [review({ id: 1, login: "pr-author", commitId: fixture.head })]],
      ["case-variant self approval", [review({ id: 1, login: "Pr-Author", commitId: fixture.head })]],
      ["approval on another commit", [review({ id: 1, commitId: otherCommit })]],
      ["no approval", [review({ id: 1, state: "COMMENTED", commitId: fixture.head })]],
      ["no reviews", []],
    ];
    for (const [name, reviews] of cases) {
      const result = await invoke(fixture.cwd, validInput(fixture, reviews));
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /does not prove an independent approval/, name);
    }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("adversarial review attestation uses the latest review state per reviewer regardless of API ordering", async () => {
  const fixture = await repository();
  try {
    const cases = [
      ["later comment invalidates approval", [review({ id: 9, state: "COMMENTED", commitId: fixture.head }), review({ id: 2, commitId: fixture.head })]],
      ["later change request invalidates approval", [review({ id: 9, state: "CHANGES_REQUESTED", commitId: fixture.head }), review({ id: 2, commitId: fixture.head })]],
      ["later approval on another commit invalidates approval", [review({ id: 9, commitId: "b".repeat(40) }), review({ id: 2, commitId: fixture.head })]],
    ];
    for (const [name, reviews] of cases) {
      const result = await invoke(fixture.cwd, validInput(fixture, reviews));
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /does not prove an independent approval/, name);
    }
    const independent = await invoke(fixture.cwd, validInput(fixture, [
      review({ id: 10, login: "pr-author", commitId: fixture.head }),
      review({ id: 9, login: "independent-reviewer", commitId: fixture.head }),
    ]));
    assert.equal(independent.status, 0, independent.stderr);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("adversarial review attestation rejects malformed review data without disclosing review contents", async () => {
  const fixture = await repository();
  try {
    const cases = [
      ["invalid JSON", "{private-review-content"],
      ["non-page root", JSON.stringify([{}])],
      ["missing login", JSON.stringify([[{ id: 1, state: "APPROVED", commit_id: fixture.head, user: {} }]])],
      ["invalid review id", JSON.stringify([[{ id: "one", state: "APPROVED", commit_id: fixture.head, user: { login: "secret-reviewer" } }]])],
      ["unsupported state", JSON.stringify([[{ id: 1, state: "UNKNOWN", commit_id: fixture.head, user: { login: "secret-reviewer" } }]])],
      ["duplicate ids", JSON.stringify([[{ id: 1, state: "APPROVED", commit_id: fixture.head, user: { login: "secret-reviewer" } }, { id: 1, state: "COMMENTED", commit_id: fixture.head, user: { login: "another-reviewer" } }]])],
    ];
    for (const [name, reviews] of cases) {
      const input = validInput(fixture);
      input.reviews = reviews;
      const result = await invoke(fixture.cwd, input);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /GitHub (review data|reviewer login)/, name);
      assert.doesNotMatch(result.stderr, /private-review-content|secret-reviewer/, name);
    }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});
