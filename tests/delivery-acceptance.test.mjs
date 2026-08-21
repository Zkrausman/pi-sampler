import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateDeliveryWaiver, waiverSigningPayload } from "../scripts/validate-delivery-waiver.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const text = (path) => readFile(join(root, path), "utf8");
const json = async (path) => JSON.parse(await text(path));

const schemaPaths = [
  "governance/docs/delivery-evidence/acceptance-manifest-v1.schema.json",
  "governance/docs/delivery-evidence/acceptance-matrix-v1.schema.json",
  "governance/docs/delivery-evidence/benchmark-evidence-v1.schema.json",
  "governance/docs/delivery-evidence/waiver-v1.schema.json",
];

test("approved rows have a strict sibling acceptance manifest", async () => {
  const [plan, manifest, requirement] = await Promise.all([
    text("docs/techPlans/AIDEV-158-implementation-plan.md"),
    json("docs/techPlans/AIDEV-158-acceptance-manifest-v1.json"),
    text(".llm-wiki/wiki/requirements/AIDEV-133-flat-memory-rebuild.md"),
  ]);
  const digest = createHash("sha256").update(plan).digest("hex");
  assert.equal(manifest.schema_version, "acceptance-manifest/v1");
  assert.equal(manifest.plan_sha256, digest);
  assert.equal(new Set(manifest.rows.map((row) => row.id)).size, manifest.rows.length);
  assert.match(requirement, /^status: blocked$/m);
  const planIds = [...plan.matchAll(/\bA158-T\d{2,4}\b/g)].map((match) => match[0]);
  assert.deepEqual(manifest.rows.map((row) => row.id), planIds);
});

test("delivery evidence schemas reject additional fields and expose all contracts", async () => {
  for (const path of schemaPaths) {
    const schema = await json(path);
    assert.equal(schema.type, "object", path);
    assert.equal(schema.additionalProperties, false, path);
    assert.equal(typeof schema.properties.schema_version.const, "string", path);
  }
});

test("profile and CI select distinct acceptance classes", async () => {
  const [profile, workflow] = await Promise.all([
    json("profiles/pi-sampler.json"),
    text(".github/workflows/validate.yml"),
  ]);
  const classes = new Map(profile.acceptance.classes.map((entry) => [entry.id, entry]));
  assert.equal(classes.get("benchmark-local-10m").eventCount, 10_000_000);
  assert.equal(classes.get("benchmark-ci-regression").eventCount, 10_000);
  assert.match(workflow, /benchmark:lesson-registry:ci/);
  assert.doesNotMatch(workflow, /benchmark:lesson-registry\s*$/m);
});

test("recursive executable authority audit finds no tracker mutation path", async () => {
  const packageJson = await json("package.json");
  assert.equal("merge-train" in packageJson.scripts, false);
  await assert.rejects(access(join(root, "scripts/merge-train.mjs")));
  const extensions = new Set([".go", ".mjs", ".js", ".cjs", ".yml", ".yaml", ".sh", ".ps1", ".bat", ".cmd"]);
  const ignoredDirectories = new Set([".git", "node_modules", "artifacts", ".review-artifacts"]);
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
        await walk(join(directory, entry.name));
      } else if (entry.isFile() && extensions.has(entry.name.slice(entry.name.lastIndexOf("."))) && !entry.name.endsWith("_test.go") && !entry.name.endsWith(".test.mjs")) {
        files.push(join(directory, entry.name));
      }
    }
  }
  await walk(root);
  assert.equal(files.some((path) => path.includes(`${join("governance", "cmd", "linear-reconciler")}`)), false);
  assert.equal(files.some((path) => path.includes(`${join("governance", "pkg", "linearreconciler")}`)), false);
  const forbidden = [
    ["gh", "pr", "merge"].join("\\s+"),
    ["git", "push", "-f"].join("\\s+"),
    ["api", "linear", "app"].join("\\."),
    ["issue", "Update"].join("") + "\\s*\\(",
    ["Transition", "To", "Done"].join(""),
    ["LINEAR", "_API_KEY"].join(""),
  ].map((pattern) => new RegExp(pattern, "i"));
  const graphqlMutation = new RegExp(["mutation", "\\s*(?:\\$|\\{)"].join(""));
  for (const path of files) {
    const source = await readFile(path, "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, path);
    assert.doesNotMatch(source, graphqlMutation, path);
  }
});

test("signed waivers require external trust and single-use replay state", async () => {
  const operatorRoot = await mkdtemp(join(tmpdir(), "aidev158-waiver-test-"));
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const now = Date.now();
    const waiver = {
      schema_version: "delivery-waiver/v1",
      waiver_id: "waiver-aidev158-node-test",
      issuer: "operator",
      key_id: "operator-key",
      repository: "Zkrausman/pi-sampler",
      ticket_id: "AIDEV-158",
      pull_request: { number: 42, base_sha: "a".repeat(40), head_sha: "b".repeat(40) },
      row_id: "A158-T05",
      plan_sha256: "c".repeat(64),
      rationale: "external owner approved the bounded exception",
      issue: "AIDEV-133",
      nonce: "n".repeat(32),
      issued_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      revocation_ref: "rev-node-test",
    };
    waiver.signature = sign(null, waiverSigningPayload(waiver), privateKey).toString("base64url");
    const waiverPath = join(operatorRoot, "waiver.json");
    const trustConfigPath = join(operatorRoot, "trust.json");
    const replayStatePath = join(operatorRoot, "replay.json");
    await writeFile(waiverPath, JSON.stringify(waiver));
    await writeFile(trustConfigPath, JSON.stringify({
      schema_version: "delivery-waiver-trust/v1",
      keys: [{ key_id: "operator-key", issuer: "operator", algorithm: "ed25519", public_key: publicKey.export({ type: "spki", format: "pem" }), revoked: false }],
      revoked_refs: [],
    }));
    const bindings = { repository: waiver.repository, ticket: waiver.ticket_id, row: waiver.row_id, plan: waiver.plan_sha256, base: waiver.pull_request.base_sha, head: waiver.pull_request.head_sha, pr: 42 };
    await validateDeliveryWaiver({ waiverPath, trustConfigPath, replayStatePath, repositoryRoot: root, ...bindings });
    await assert.rejects(validateDeliveryWaiver({ waiverPath, trustConfigPath, replayStatePath, repositoryRoot: root, ...bindings }), /consumed/);
  } finally {
    await rm(operatorRoot, { recursive: true, force: true });
  }
});

test("delivery skills preserve explicit sticky merge authority", async () => {
  const [delivery, planning, evidence] = await Promise.all([
    text(".agents/skills/project-delivery/SKILL.md"),
    text(".agents/skills/create-implementation-plan/SKILL.md"),
    text("governance/docs/delivery-evidence/README.md"),
  ]);
  for (const source of [delivery, planning, evidence]) {
    assert.match(source, /do not merge/i);
    assert.match(source, /Merge PR #N/);
  }
  assert.match(delivery, /every approved-plan acceptance ID must appear exactly once/i);
  assert.match(delivery, /Ready to merge/);
  assert.match(delivery, /Refresh PR #N/);
  assert.match(delivery, /Push PR #N/);
  assert.match(planning, /stable.*ASCII.*ticket-scoped ID/i);
});
