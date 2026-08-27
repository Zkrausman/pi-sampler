import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

function lineEndingSignature(value) {
  return value.match(/\r\n|\r|\n/g) ?? [];
}

async function copyManifestValidationFixture(targetRoot) {
  await Promise.all([
    mkdir(join(targetRoot, "docs", "techPlans"), { recursive: true }),
    mkdir(join(targetRoot, "governance", "docs", "delivery-evidence"), { recursive: true }),
  ]);
  await Promise.all([
    cp(join(root, "docs/techPlans/AIDEV-158-implementation-plan.md"), join(targetRoot, "docs/techPlans/AIDEV-158-implementation-plan.md")),
    cp(join(root, "docs/techPlans/AIDEV-158-acceptance-manifest-v1.json"), join(targetRoot, "docs/techPlans/AIDEV-158-acceptance-manifest-v1.json")),
    ...schemaPaths.map((schemaPath) => cp(join(root, schemaPath), join(targetRoot, schemaPath))),
  ]);
}

test("approved rows have a strict sibling acceptance manifest", async () => {
  const [plan, manifest, requirement] = await Promise.all([
    text("docs/techPlans/AIDEV-158-implementation-plan.md"),
    json("docs/techPlans/AIDEV-158-acceptance-manifest-v1.json"),
    text(".llm-wiki/wiki/requirements/AIDEV-133-flat-memory-rebuild.md"),
  ]);
  const canonicalPlan = plan.replace(/\r\n?/g, "\n");
  const digest = createHash("sha256").update(canonicalPlan).digest("hex");
  assert.equal(manifest.schema_version, "acceptance-manifest/v1");
  assert.equal(manifest.plan_sha256, digest);
  assert.equal(new Set(manifest.rows.map((row) => row.id)).size, manifest.rows.length);
  assert.match(requirement, /^status: blocked$/m);
  const planIds = [...plan.matchAll(/\bA158-T\d{2,4}\b/g)].map((match) => match[0]);
  assert.deepEqual(manifest.rows.map((row) => row.id), planIds);
});

test("plan digest is newline-independent", async () => {
  const plan = await text("docs/techPlans/AIDEV-158-implementation-plan.md");
  const canonical = plan.replace(/\r\n?/g, "\n");
  const digest = createHash("sha256").update(canonical).digest("hex");
  const crlf = canonical.replace(/\n/g, "\r\n");
  const crlfDigest = createHash("sha256").update(crlf.replace(/\r\n?/g, "\n")).digest("hex");
  assert.equal(crlfDigest, digest);
});

test("manifest digest rejects ordinary content changes with preserved line endings", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "aidev158-manifest-negative-"));
  try {
    await copyManifestValidationFixture(fixtureRoot);
    const planPath = join(fixtureRoot, "docs", "techPlans", "AIDEV-158-implementation-plan.md");
    const original = await readFile(planPath, "utf8");
    const mutated = original.replace(
      "The user—not repository code—is the merge authority.",
      "The user—not repository code—is the merge authority for this manifest.",
    );
    assert.notEqual(mutated, original);
    assert.deepEqual(lineEndingSignature(mutated), lineEndingSignature(original));
    await writeFile(planPath, mutated);

    const result = spawnSync(process.execPath, [
      join(root, "scripts/validate-delivery-evidence.mjs"),
      "--mode", "manifest",
      "--acceptance-manifest", join(fixtureRoot, "docs", "techPlans", "AIDEV-158-acceptance-manifest-v1.json"),
      "--repo-root", fixtureRoot,
      "--expected-repository", "Zkrausman/pi-sampler",
      "--expected-base", "407b31cce5c6f418ad7cdae15ce91c94b09b60a7",
    ], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.notEqual(result.status, 0, "ordinary plan-content mutation was accepted");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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

test("v2 acceptance support is additive and leaves the frozen v1 surface untouched", async () => {
  const [schema, packageJson, v1Schema] = await Promise.all([
    text("governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json"),
    json("package.json"),
    text("governance/docs/delivery-evidence/acceptance-matrix-v1.schema.json"),
  ]);
  const parsed = JSON.parse(schema);
  assert.equal(parsed.properties.schema_version.const, "acceptance-matrix/v2");
  assert.equal(parsed.additionalProperties, false);
  assert.equal(packageJson.scripts["validate:delivery-acceptance"], "node scripts/validate-delivery-evidence.mjs --mode acceptance");
  assert.match(packageJson.scripts["validate:delivery-schemas"], /acceptance-matrix-v2\.schema\.json/);
  assert.equal(createHash("sha256").update(v1Schema).digest("hex"), "c52283e1d360491ff67f90d1801f2f5ee7b98f4df9ff6e4c8c9f8dd3d94c0021");
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
