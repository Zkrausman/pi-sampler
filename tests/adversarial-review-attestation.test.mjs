import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const validator = join(root, "scripts", "validate-adversarial-review-attestation.mjs");
const packetGenerator = join(root, "scripts", "generate-review-packet.mjs");

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
function marker({ base, head, packetSha256, reviewerRole = "independent-fresh-context-reviewer", outcome = "clean" }) {
  return `<!-- pi-sampler-adversarial-review-attestation:v1 ${JSON.stringify({ format: "pi-sampler.adversarial-review-attestation", version: 1, base, head, reviewerRole, outcome, packetSha256 })} -->`;
}
function invoke(cwd, { base, head, branch, body }) {
  return spawnSync(process.execPath, [validator], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ADVERSARIAL_REVIEW_BASE_SHA: base, ADVERSARIAL_REVIEW_HEAD_SHA: head, ADVERSARIAL_REVIEW_HEAD_REF: branch, ADVERSARIAL_REVIEW_PR_BODY: body },
  });
}

test("adversarial review attestation accepts one clean, commit-bound marker for a ticket branch", async () => {
  const fixture = await repository();
  try {
    const body = `## Summary\n\n${marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head) })}\n`;
    const result = invoke(fixture.cwd, { ...fixture, branch: "zkrausman/aidev-108-enforce-adversarial-review-evidence", body });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /attestation validated/);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("adversarial review attestation permits no marker only for strict non-ticket branches", async () => {
  const fixture = await repository();
  try {
    const nonTicket = invoke(fixture.cwd, { ...fixture, branch: "maintenance/update-ci", body: "No review marker." });
    assert.equal(nonTicket.status, 0, nonTicket.stderr);
    const ticket = invoke(fixture.cwd, { ...fixture, branch: "zkrausman/aidev-108-enforce-adversarial-review-evidence", body: "No review marker." });
    assert.notEqual(ticket.status, 0);
    assert.match(ticket.stderr, /required for an AIDEV ticket branch/);
    const nearMiss = invoke(fixture.cwd, { ...fixture, branch: "zkrausman/AIDEV-108-enforce-adversarial-review-evidence", body: "" });
    assert.equal(nearMiss.status, 0, nearMiss.stderr);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("adversarial review attestation fails closed for malformed, multiple, stale, non-independent, and non-clean evidence", async () => {
  const fixture = await repository();
  try {
    const valid = marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head) });
    const common = { ...fixture, branch: "zkrausman/aidev-108-enforce-adversarial-review-evidence" };
    const cases = [
      ["malformed", "<!-- pi-sampler-adversarial-review-attestation:v1 not-json -->", /exactly once|invalid JSON/],
      ["multiple", `${valid}\n${valid}`, /exactly once/],
      ["stale digest", marker({ ...fixture, packetSha256: "0".repeat(64) }), /packet digest/],
      ["stale base", marker({ ...fixture, base: "0".repeat(40), packetSha256: digest(fixture.cwd, fixture.base, fixture.head) }), /base or head does not match/],
      ["non-independent reviewer", marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head), reviewerRole: "author" }), /independent reviewer role/],
      ["unresolved outcome", marker({ ...fixture, packetSha256: digest(fixture.cwd, fixture.base, fixture.head), outcome: "blocker" }), /outcome must be clean/],
      ["private body is not printed", "private-example $(do-not-execute)", /required for an AIDEV ticket branch/],
    ];
    for (const [name, body, expected] of cases) {
      const result = invoke(fixture.cwd, { ...common, body });
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, expected, name);
      assert.doesNotMatch(result.stderr, /private-example|do-not-execute/, name);
    }
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});
