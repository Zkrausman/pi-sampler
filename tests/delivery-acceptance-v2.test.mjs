import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Compile } from "typebox/compile";
import {
  DELIVERY_V2_SUPPORT_AUTHORITY,
  DELIVERY_V2_SUPPORT_CAN_GRANT_AUTHORITY,
  SLICE2_MAP_PATHS,
  TRUSTED_DELIVERY_PATHS,
  canonicalActivationJSON,
  canonicalJSONString,
  canonicalTrustedMapJSON,
  buildNormalizedFacts,
  classifyAcceptanceVersionPair,
  enumerateCommittedSlice2Diff,
  inspectTrustedGoExecutable,
  locateFixedGit,
  resolveTrustedGoExecutableFromFixedCandidates,
  resolveAuthorityGoToolchain,
  inspectTrustedGitExecutable,
  deriveAuthenticatedSourceRoot,
  runTransitionForTest,
  runValidateForTest,
  validateAcceptanceV2Utf8Fields,
  validateTrustedMap,
  validateUtf8ByteConstraint,
  parseEvaluatorEnvelope,
  parseTrustedDeliveryArgs,
  readTrustedBlob,
} from "../scripts/trusted-delivery-evidence-controller.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const currentHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const canonicalTimestamp = () => new Date().toISOString().replace(/Z$/, "").replace(/\d{3}$/, (value) => value) + "Z";
const transitionChild = process.env.AIDEV191_TRANSITION_CHILD === "1";

async function transitionChildTrustedRoot() {
  if (!transitionChild) return null;
  const managedRoot = dirname(dirname(root));
  const reviewRoot = join(managedRoot, "review");
  const entries = await readdir(reviewRoot, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("aidev191-s1-"));
  assert.equal(candidates.length, 1, "transition child must have one trusted S1 fixture");
  return join(reviewRoot, candidates[0].name);
}

async function runGoAcceptanceRequest(matrix, evidenceRoot, policy) {
  const buildRoot = await mkdtemp(join(tmpdir(), "aidev191-go-cli-"));
  const binary = join(buildRoot, process.platform === "win32" ? "delivery-evidence-validator.exe" : "delivery-evidence-validator");
  try {
    const build = spawnSync("go", ["build", "-o", binary, "./cmd/delivery-evidence-validator"], { cwd: join(root, "governance"), encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const facts = buildNormalizedFacts(matrix);
    const request = { format: "pi-sampler.delivery-acceptance-v2-request", version: 1, normalized_facts: facts.facts, facts_sha256: facts.factsSha256, matrix_base64: Buffer.from(`${canonicalJSONString(matrix)}\n`).toString("base64"), evidence_root: evidenceRoot, policy, controller_time: matrix.generated_at };
    return spawnSync(binary, ["-mode", "acceptance-v2"], { cwd: join(root, "governance"), input: `${canonicalJSONString(request)}\n`, encoding: "utf8", timeout: 120000 });
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

function testGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function testCommitTree(cwd, tree, parents) {
  const result = spawnSync("git", ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], {
    cwd,
    input: "direct-parent mutation\n",
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, GIT_AUTHOR_NAME: "AIDEV test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "AIDEV test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function matrixSkeleton(scope = "plan-publication") {
  return {
    schema_version: "acceptance-matrix/v2",
    manifest_schema_version: "implementation-plan-manifest/v2",
    evaluation_scope: scope,
    repository: "Zkrausman/pi-sampler",
    ticket_id: "AIDEV-191",
    ticket_revision: "d".repeat(64),
    profile_path: "profiles/pi-sampler.json",
    profile_sha256: "a".repeat(64),
    base_sha: "b".repeat(40),
    head_sha: "c".repeat(40),
    pull_request_number: 191,
    plan_path: "docs/techPlans/AIDEV-191-implementation-plan.md",
    plan_sha256: "d".repeat(64),
    manifest_path: "docs/techPlans/AIDEV-191-acceptance-manifest-v2.json",
    manifest_sha256: "e".repeat(64),
    manifest_contract_path: "contracts/implementation-plan-manifest-v2.mjs",
    manifest_contract_sha256: "f".repeat(64),
    manifest_validator_path: "scripts/validate-implementation-plan.mjs",
    manifest_validator_sha256: "0".repeat(64),
    matrix_contract_path: "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json",
    matrix_contract_sha256: "1".repeat(64),
    policy_path: "profiles/pi-sampler.json",
    policy_sha256: "a".repeat(64),
    evidence_root_id: "operator-root-191",
    generated_at: "2026-08-26T00:00:00.000Z",
    rows: [{ id: "AIDEV-191-1", acceptance_class: "ordinary", requirement: "A bounded requirement.", status: "specified", specification: { verifier: { id: "parent", version: "v1", environment: "review", argv: ["plan"] }, exit_status: 0, started_at: "2026-08-26T00:00:00.000Z", completed_at: "2026-08-26T00:00:01.000Z", artifacts: [{ name: "plan-validator-report.json", path: "plan-validator-report.json", sha256: "2".repeat(64), bytes: 1 }, { name: "independent-plan-review.md", path: "independent-plan-review.md", sha256: "3".repeat(64), bytes: 1 }] } }],
  };
}

async function externalInventoryReport(evidenceRoot) {
  const probeDir = await mkdtemp(join(tmpdir(), "aidev191-inventory-probe-"));
  const source = join(probeDir, "main.go");
  await writeFile(source, `package main
import (
  "os"
  deliveryevidence "github.com/zkrausman/pi-sampler/governance/pkg/deliveryevidence"
)
func main() {
  root := os.Args[1]
  opened, err := deliveryevidence.OpenExternalEvidenceRoot(root)
  if err != nil { panic(err) }
  inventory, err := deliveryevidence.InventoryExternalEvidenceRoot(opened)
  if err != nil { panic(err) }
  _, _ = os.Stdout.Write(deliveryevidence.CanonicalExternalEvidenceInventoryReport(inventory))
}
`);
  try {
    const result = spawnSync("go", ["run", source, evidenceRoot], { cwd: join(root, "governance"), encoding: "buffer", timeout: 120000 });
    assert.equal(result.status, 0, result.stderr?.toString() || result.stdout?.toString());
    return Buffer.from(result.stdout);
  } finally { await rm(probeDir, { recursive: true, force: true }); }
}

async function implementationMatrixForCLI(evidenceRoot, acceptanceClass = "ordinary") {
  const proof = Buffer.from("proof");
  await writeFile(join(evidenceRoot, "proof.txt"), proof);
  const inventory = await externalInventoryReport(evidenceRoot);
  await writeFile(join(evidenceRoot, "evidence-inventory.json"), inventory);
  const now = canonicalTimestamp();
  const matrix = matrixSkeleton("implementation-delivery");
  matrix.generated_at = now;
  matrix.rows = [{ id: "AIDEV-191-1", acceptance_class: acceptanceClass, requirement: "A bounded requirement.", status: "observed", evidence: { verifier: { id: "test-verifier", version: "v1", environment: "local", argv: ["test"] }, exit_status: 0, started_at: now, completed_at: now, artifacts: [{ name: "proof.txt", path: "proof.txt", sha256: sha256(proof), bytes: proof.length }, { name: "evidence-inventory.json", path: "evidence-inventory.json", sha256: sha256(inventory), bytes: inventory.length }] } }];
  return matrix;
}

let fixtureLock = Promise.resolve();
function exclusiveFixture(callback) {
  const previous = fixtureLock;
  let release;
  fixtureLock = new Promise((resolve) => { release = resolve; });
  return previous.then(async () => {
    try { return await callback(); } finally { release(); }
  });
}

test("D1-D2 trusted map omits self-digest and separates predecessor from activation head", () => {
  const activationBytes = canonicalActivationJSON({ format: "pi-sampler.delivery-acceptance-v2-activation", version: 1, state: "active" });
  const valid = { format: "pi-sampler.delivery-acceptance-v2-trusted-map", version: 1, activation_sha256: sha256(activationBytes), predecessor_base: "a".repeat(40), trusted_paths: [{ path: "scripts/validator.mjs", sha256: "c".repeat(64) }], candidate_paths: [{ path: "contracts/delivery-acceptance-v2-activation.json", sha256: "d".repeat(64) }] };
  assert.equal(JSON.parse(canonicalTrustedMapJSON(valid)).candidate_paths.length, 1);
  assert.doesNotThrow(() => validateTrustedMap(valid, { activationBytes, predecessorBase: valid.predecessor_base }));
  assert.throws(() => validateTrustedMap({ ...valid, candidate_paths: [{ path: "contracts/delivery-acceptance-v2-trusted-map.json", sha256: "e".repeat(64) }] }), /activation_map_invalid/);
  assert.throws(() => validateTrustedMap(valid, { activationBytes, predecessorBase: "c".repeat(40) }), /activation_map_invalid/);
  assert.throws(() => validateTrustedMap({ ...valid, activation_head: "c".repeat(40) }, { activationBytes, predecessorBase: valid.predecessor_base }), /activation_map_invalid/);
});

test("N1 trusted source root derives managed topology from trusted profile facts", async () => {
  const sourceRoot = resolve(root, "../../../pi-sampler");
  const managedRoot = resolve(sourceRoot, "../ai-workspaces");
  const trustedRoot = await mkdtemp(join(resolve(managedRoot, "review"), "aidev191-anchor-"));
  try {
    const sourceHead = testGit(sourceRoot, ["rev-parse", "HEAD"]);
    const clone = spawnSync("git", ["-c", "core.autocrlf=false", "clone", "--no-local", sourceRoot, trustedRoot], { cwd: sourceRoot, encoding: "utf8", timeout: 120000 });
    assert.equal(clone.status, 0, clone.stderr);
    testGit(trustedRoot, ["remote", "remove", "origin"]);
    testGit(trustedRoot, ["checkout", "--quiet", "--detach", sourceHead]);
    const authenticated = deriveAuthenticatedSourceRoot(trustedRoot, sourceHead, "Zkrausman/pi-sampler", root);
    const inside = (parent, child) => {
      const remainder = relative(resolve(parent), resolve(child));
      return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
    };
    assert.equal(authenticated.source.path, sourceRoot);
    assert.equal(inside(authenticated.roots.worktreeRoot, authenticated.roots.reviewRoot), true);
    assert.equal(inside(authenticated.roots.worktreeRoot, authenticated.roots.quarantineRoot), true);
    assert.equal(inside(authenticated.roots.reviewRoot, authenticated.roots.quarantineRoot), false);
    assert.equal(inside(authenticated.source.path, authenticated.roots.worktreeRoot), false);
    assert.throws(() => deriveAuthenticatedSourceRoot(trustedRoot, sourceHead, "Other/repository", root), /trusted_blob_invalid/);
    const alias = await mkdtemp(join(tmpdir(), "aidev191-anchor-alias-"));
    try {
      const link = join(alias, "trusted-link");
      try {
        await symlink(trustedRoot, link, "junction");
        assert.throws(() => deriveAuthenticatedSourceRoot(link, sourceHead, "Zkrausman/pi-sampler", root), /trusted_base_invalid/);
      } catch (error) {
        assert.ok(["EPERM", "EEXIST", "UNKNOWN", "ERR_INVALID_ARG_VALUE"].includes(error.code), error);
      }
    } finally { await rm(alias, { recursive: true, force: true }); }
  } finally { await rm(trustedRoot, { recursive: true, force: true }); }
});

test("N1/N3 real managed-topology transition traverses the production guards", () => exclusiveFixture(async () => {
  if (transitionChild) {
    const trustedRoot = await transitionChildTrustedRoot();
    const trustedBase = testGit(trustedRoot, ["rev-parse", "HEAD"]);
    const receipt = await runTransitionForTest({ trustedBase, trustedWorktree: trustedRoot, candidateRoot: root, candidateActivation: "contracts/delivery-acceptance-v2-activation.json", candidateActivationMap: "contracts/delivery-acceptance-v2-trusted-map.json", expectedHead: currentHead, expectedRepository: "Zkrausman/pi-sampler", expectedTicket: "AIDEV-191", expectedTicketRevision: "d".repeat(64), expectedPR: "191" }, {
      runSupportCommand(candidateRoot, argv) {
        assert.equal(candidateRoot, root);
        assert.deepEqual(argv, ["node", "--test", "tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs"]);
        return { argv, status: 0, ok: true, stdoutSha256: "0".repeat(64), stderrSha256: "0".repeat(64) };
      },
    });
    assert.equal(receipt.code, "transition_ready");
    return;
  }
  const fixtureBase = await mkdtemp(join(tmpdir(), "aidev191-managed-"));
  const sourceRoot = join(fixtureBase, "pi-sampler");
  const managedRoot = join(fixtureBase, "ai-workspaces");
  const dependencyLink = join(fixtureBase, "node_modules");
  await symlink(resolve(root, "../../../pi-sampler/node_modules"), dependencyLink, process.platform === "win32" ? "junction" : "dir");
  await mkdir(join(managedRoot, "review"), { recursive: true });
  await mkdir(join(managedRoot, "implement"), { recursive: true });
  await mkdir(join(managedRoot, "review-quarantine"), { recursive: true });
  const trustedRoot = await mkdtemp(join(managedRoot, "review", "aidev191-s1-"));
  const candidateRoot = await mkdtemp(join(managedRoot, "implement", "aidev191-s2-"));
  const trustedPaths = [TRUSTED_DELIVERY_PATHS.manifestContract, "contracts/implementation-plan-manifest-v2.schema.json", TRUSTED_DELIVERY_PATHS.manifestValidator, TRUSTED_DELIVERY_PATHS.matrixSchema, TRUSTED_DELIVERY_PATHS.profile, TRUSTED_DELIVERY_PATHS.profileSchema, TRUSTED_DELIVERY_PATHS.acceptanceGo, TRUSTED_DELIVERY_PATHS.posixRoot, TRUSTED_DELIVERY_PATHS.windowsRoot, TRUSTED_DELIVERY_PATHS.validatorMain, TRUSTED_DELIVERY_PATHS.controller];
  const sliceOnePaths = [...new Set([...trustedPaths, ...SLICE2_MAP_PATHS.slice(1), "package.json", "tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs", "tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md", "tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json", "governance/cmd/delivery-evidence-validator/main.go", "governance/pkg/deliveryevidence/validator_test.go"])];
  try {
    const sourceClone = spawnSync("git", ["-c", "core.autocrlf=false", "clone", "--no-local", root, sourceRoot], { cwd: root, encoding: "utf8", timeout: 120000 });
    assert.equal(sourceClone.status, 0, sourceClone.stderr);
    testGit(sourceRoot, ["config", "user.email", "test@example.invalid"]);
    testGit(sourceRoot, ["config", "user.name", "AIDEV test"]);
    for (const path of sliceOnePaths) { await mkdir(join(sourceRoot, dirname(path)), { recursive: true }); await copyFile(join(root, path), join(sourceRoot, path)); }
    testGit(sourceRoot, ["add", "."]); testGit(sourceRoot, ["commit", "--quiet", "-m", "slice1"]);
    const sliceOneHead = testGit(sourceRoot, ["rev-parse", "HEAD"]);
    const trustedClone = spawnSync("git", ["-c", "core.autocrlf=false", "clone", "--no-local", sourceRoot, trustedRoot], { cwd: root, encoding: "utf8", timeout: 120000 });
    assert.equal(trustedClone.status, 0, trustedClone.stderr);
    testGit(trustedRoot, ["config", "user.email", "test@example.invalid"]);
    testGit(trustedRoot, ["config", "user.name", "AIDEV test"]);
    testGit(trustedRoot, ["checkout", "--quiet", "--detach", sliceOneHead]);
    const candidateClone = spawnSync("git", ["-c", "core.autocrlf=false", "clone", "--no-local", trustedRoot, candidateRoot], { cwd: root, encoding: "utf8", timeout: 120000 });
    assert.equal(candidateClone.status, 0, candidateClone.stderr);
    testGit(candidateRoot, ["config", "user.email", "test@example.invalid"]);
    testGit(candidateRoot, ["config", "user.name", "AIDEV test"]);
    testGit(candidateRoot, ["checkout", "--quiet", "--detach", sliceOneHead]);
    for (const path of SLICE2_MAP_PATHS.slice(1)) {
      const current = await readFile(join(candidateRoot, path), "utf8");
      await writeFile(join(candidateRoot, path), path.endsWith(".json") ? `${current.trimEnd()}\n ` : `${current}\n<!-- Slice 2 transition fixture -->\n`);
    }
    const activation = { format: "pi-sampler.delivery-acceptance-v2-activation", version: 1, state: "active" };
    const activationBytes = Buffer.from(canonicalJSONString(activation) + "\n");
    await mkdir(join(candidateRoot, "contracts"), { recursive: true });
    await writeFile(join(candidateRoot, "contracts/delivery-acceptance-v2-activation.json"), activationBytes);
    const candidateEntries = [];
    for (const path of SLICE2_MAP_PATHS) candidateEntries.push({ path, sha256: sha256(await readFile(join(candidateRoot, path))) });
    const trustedEntries = [];
    for (const path of trustedPaths) trustedEntries.push({ path, sha256: sha256(await readFile(join(trustedRoot, path))) });
    const transitionMap = { format: "pi-sampler.delivery-acceptance-v2-trusted-map", version: 1, activation_sha256: sha256(activationBytes), predecessor_base: sliceOneHead, trusted_paths: trustedEntries, candidate_paths: candidateEntries };
    await writeFile(join(candidateRoot, "contracts/delivery-acceptance-v2-trusted-map.json"), Buffer.from(canonicalTrustedMapJSON(transitionMap)));
    testGit(candidateRoot, ["add", "."]); testGit(candidateRoot, ["commit", "--quiet", "-m", "slice2"]);
    const sliceTwoHead = testGit(candidateRoot, ["rev-parse", "HEAD"]);
    testGit(trustedRoot, ["remote", "remove", "origin"]);
    testGit(candidateRoot, ["remote", "remove", "origin"]);
    const controller = join(trustedRoot, "scripts/trusted-delivery-evidence-controller.mjs");
    const result = spawnSync(process.execPath, [controller, "--mode", "transition", "--trusted-base", sliceOneHead, "--trusted-worktree", trustedRoot, "--candidate-root", candidateRoot, "--candidate-activation", "contracts/delivery-acceptance-v2-activation.json", "--candidate-activation-map", "contracts/delivery-acceptance-v2-trusted-map.json", "--expected-repository", "Zkrausman/pi-sampler", "--expected-ticket", "AIDEV-191", "--expected-ticket-revision", "d".repeat(64), "--expected-head", sliceTwoHead, "--expected-pr", "191", "--json"], { cwd: root, encoding: "utf8", timeout: 900000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(receipt), ["format", "version", "status", "code", "authority", "trusted_base", "candidate_head", "repository", "ticket_id", "ticket_revision", "pull_request_number", "trusted_paths", "activation_path", "activation_sha256", "activation_map_path", "activation_map_sha256", "candidate_paths", "test_report_sha256", "inventory_before_sha256", "inventory_after_sha256", "state"]);
    assert.equal(receipt.code, "transition_ready");
    assert.equal(receipt.trusted_base, sliceOneHead);
    assert.equal(receipt.candidate_head, sliceTwoHead);
    assert.deepEqual(receipt.candidate_paths, [".agents/skills/create-implementation-plan/SKILL.md", ".agents/skills/project-delivery/SKILL.md", "contracts/delivery-acceptance-v2-activation.json", "contracts/delivery-acceptance-v2-trusted-map.json", "docs/IMPLEMENTATION-PLANNING.md", "governance/docs/delivery-evidence/README.md", "profiles/pi-sampler.json"].sort());
    const mutatedMap = JSON.parse(await readFile(join(candidateRoot, "contracts/delivery-acceptance-v2-trusted-map.json"), "utf8"));
    mutatedMap.predecessor_base = "a".repeat(40);
    await writeFile(join(candidateRoot, "contracts/delivery-acceptance-v2-trusted-map.json"), canonicalTrustedMapJSON(mutatedMap));
    testGit(candidateRoot, ["add", "."]); testGit(candidateRoot, ["commit", "--quiet", "-m", "map mutation"]);
    const mutatedHead = testGit(candidateRoot, ["rev-parse", "HEAD"]);
    const rejected = spawnSync(process.execPath, [controller, "--mode", "transition", "--trusted-base", sliceOneHead, "--trusted-worktree", trustedRoot, "--candidate-root", candidateRoot, "--candidate-activation", "contracts/delivery-acceptance-v2-activation.json", "--candidate-activation-map", "contracts/delivery-acceptance-v2-trusted-map.json", "--expected-repository", "Zkrausman/pi-sampler", "--expected-ticket", "AIDEV-191", "--expected-ticket-revision", "d".repeat(64), "--expected-head", mutatedHead, "--expected-pr", "191", "--json"], { cwd: root, encoding: "utf8", timeout: 120000 });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /activation_map_invalid/);
  } finally { await rm(dependencyLink, { recursive: true, force: true }); await rm(fixtureBase, { recursive: true, force: true }); }
}));

test("N3 production guard vectors fail behaviorally under guard mutation", async () => {
  const activationBytes = canonicalActivationJSON({ format: "pi-sampler.delivery-acceptance-v2-activation", version: 1, state: "active" });
  const map = { format: "pi-sampler.delivery-acceptance-v2-trusted-map", version: 1, activation_sha256: sha256(activationBytes), predecessor_base: "a".repeat(40), trusted_paths: [{ path: "scripts/validator.mjs", sha256: "c".repeat(64) }], candidate_paths: [{ path: "contracts/delivery-acceptance-v2-activation.json", sha256: "d".repeat(64) }] };
  assert.doesNotThrow(() => validateTrustedMap(map, { activationBytes, predecessorBase: map.predecessor_base }));
  for (const mutated of [
    { ...map, predecessor_base: "b".repeat(40) },
    { ...map, activation_sha256: "e".repeat(64) },
    { ...map, candidate_paths: [{ path: "contracts/delivery-acceptance-v2-trusted-map.json", sha256: "e".repeat(64) }] },
    { ...map, trusted_paths: [{ path: "scripts/validator.mjs", sha256: "d".repeat(64) }, { path: "scripts/validator.mjs", sha256: "d".repeat(64) }] },
  ]) assert.throws(() => validateTrustedMap(mutated, { activationBytes, predecessorBase: map.predecessor_base }), /activation_map_invalid|trusted_digest_mismatch/);
  const envelope = { format: "pi-sampler.delivery-acceptance-result", version: 1, status: "valid", code: "observed", evaluation_scope: "implementation-delivery", facts_sha256: "a".repeat(64), matrix_sha256: "b".repeat(64), rows: [{ id: "AIDEV-191-1", status: "valid", code: "observed" }], diagnostics: [] };
  assert.equal(parseEvaluatorEnvelope({ status: 0, stdout: Buffer.from(`${canonicalJSONString(envelope)}\n`) }).status, "valid");
  for (const mutation of [{ status: 3, body: envelope }, { status: 1, body: { ...envelope, status: "blocked", code: "rows_blocked", diagnostics: [{ code: "rows_blocked", path: "/rows" }], rows: [{ id: "AIDEV-191-1", status: "blocked", code: "blocked" }] } }]) {
    assert.throws(() => parseEvaluatorEnvelope({ status: mutation.status, stdout: Buffer.from(`${canonicalJSONString(mutation.body)}\n`) }), /test_failed/);
  }
  const temp = await mkdtemp(join(tmpdir(), "aidev191-n3-"));
  const executable = join(temp, process.platform === "win32" ? "go.exe" : "go");
  try {
    await writeFile(executable, Buffer.from("guard mutation executable"));
    if (process.platform !== "win32") await chmod(executable, 0o755);
    assert.throws(() => inspectTrustedGitExecutable(executable, "0".repeat(64)), /test_failed/);
    assert.throws(() => deriveAuthenticatedSourceRoot(executable, currentHead, "Zkrausman/pi-sampler", executable), /trusted_base_invalid/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("F2 activated S2-to-H validation reaches trusted guards and injected evaluators", () => exclusiveFixture(async () => {
  const fixtureParent = resolve(root, "../../..");
  const fixtureBase = await mkdtemp(join(fixtureParent, "aidev191-f2-"));
  const sourceRoot = join(fixtureBase, "pi-sampler");
  const managedRoot = join(fixtureBase, "ai-workspaces");
  const evidenceRoot = join(fixtureBase, "evidence");
  const matrixPath = join(fixtureBase, "matrix.json");
  const fixtureSource = await transitionChildTrustedRoot() ?? root;
  const dependencyLink = join(fixtureBase, "node_modules");
  await symlink(resolve(root, "../../../pi-sampler/node_modules"), dependencyLink, process.platform === "win32" ? "junction" : "dir");
  await mkdir(join(managedRoot, "review"), { recursive: true });
  await mkdir(join(managedRoot, "implement"), { recursive: true });
  await mkdir(join(managedRoot, "review-quarantine"), { recursive: true });
  const trustedPaths = [TRUSTED_DELIVERY_PATHS.manifestContract, "contracts/implementation-plan-manifest-v2.schema.json", TRUSTED_DELIVERY_PATHS.manifestValidator, TRUSTED_DELIVERY_PATHS.matrixSchema, TRUSTED_DELIVERY_PATHS.profile, TRUSTED_DELIVERY_PATHS.profileSchema, TRUSTED_DELIVERY_PATHS.acceptanceGo, TRUSTED_DELIVERY_PATHS.posixRoot, TRUSTED_DELIVERY_PATHS.windowsRoot, TRUSTED_DELIVERY_PATHS.validatorMain, TRUSTED_DELIVERY_PATHS.controller];
  const sliceOnePaths = [...new Set([...trustedPaths, ...SLICE2_MAP_PATHS.slice(1), "package.json", "tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs", "tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md", "tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json", "governance/cmd/delivery-evidence-validator/main.go", "governance/pkg/deliveryevidence/validator_test.go"])];
  try {
    const sourceClone = spawnSync("git", ["-c", "core.autocrlf=false", "clone", "--no-local", fixtureSource, sourceRoot], { cwd: root, encoding: "utf8", timeout: 120000 });
    assert.equal(sourceClone.status, 0, sourceClone.stderr);
    testGit(sourceRoot, ["config", "user.email", "test@example.invalid"]);
    testGit(sourceRoot, ["config", "user.name", "AIDEV test"]);
    for (const path of sliceOnePaths) { await mkdir(join(sourceRoot, dirname(path)), { recursive: true }); await copyFile(join(fixtureSource, path), join(sourceRoot, path)); }
    const sourceStatus = spawnSync("git", ["status", "--porcelain"], { cwd: sourceRoot, encoding: "utf8", timeout: 120000 });
    assert.equal(sourceStatus.status, 0, sourceStatus.stderr);
    if (sourceStatus.stdout.trim()) { testGit(sourceRoot, ["add", "."]); testGit(sourceRoot, ["commit", "--quiet", "-m", "slice1"]); }
    const sliceOneHead = testGit(sourceRoot, ["rev-parse", "HEAD"]);
    const trustedEntries = [];
    for (const path of trustedPaths) trustedEntries.push({ path, sha256: sha256(await readFile(join(sourceRoot, path))) });
    for (const path of SLICE2_MAP_PATHS.slice(1)) {
      const current = await readFile(join(sourceRoot, path), "utf8");
      const next = path.endsWith(".json") ? `${current.trimEnd()}\n ` : `${current}\n<!-- F2 activated fixture -->\n`;
      await writeFile(join(sourceRoot, path), next);
    }
    const activation = { format: "pi-sampler.delivery-acceptance-v2-activation", version: 1, state: "active" };
    const activationBytes = Buffer.from(canonicalJSONString(activation) + "\n");
    await writeFile(join(sourceRoot, "contracts/delivery-acceptance-v2-activation.json"), activationBytes);
    const candidateEntries = [];
    for (const path of SLICE2_MAP_PATHS) candidateEntries.push({ path, sha256: sha256(await readFile(join(sourceRoot, path))) });
    await writeFile(join(sourceRoot, "contracts/delivery-acceptance-v2-trusted-map.json"), Buffer.from(canonicalTrustedMapJSON({ format: "pi-sampler.delivery-acceptance-v2-trusted-map", version: 1, activation_sha256: sha256(activationBytes), predecessor_base: sliceOneHead, trusted_paths: trustedEntries, candidate_paths: candidateEntries })));
    testGit(sourceRoot, ["add", "."]); testGit(sourceRoot, ["commit", "--quiet", "-m", "slice2"]);
    const activatedHead = testGit(sourceRoot, ["rev-parse", "HEAD"]);
    const activatedRoot = await mkdtemp(join(managedRoot, "review", "aidev191-activated-"));
    const activatedClone = spawnSync("git", ["-c", "core.autocrlf=false", "clone", "--no-local", sourceRoot, activatedRoot], { cwd: root, encoding: "utf8", timeout: 120000 });
    assert.equal(activatedClone.status, 0, activatedClone.stderr);
    testGit(activatedRoot, ["remote", "remove", "origin"]); testGit(activatedRoot, ["checkout", "--quiet", "--detach", activatedHead]);
    const candidateRoot = await mkdtemp(join(managedRoot, "implement", "aidev191-h-"));
    const candidateClone = spawnSync("git", ["-c", "core.autocrlf=false", "clone", "--no-local", sourceRoot, candidateRoot], { cwd: root, encoding: "utf8", timeout: 120000 });
    assert.equal(candidateClone.status, 0, candidateClone.stderr);
    testGit(candidateRoot, ["config", "user.email", "test@example.invalid"]); testGit(candidateRoot, ["config", "user.name", "AIDEV test"]); testGit(candidateRoot, ["checkout", "--quiet", "--detach", activatedHead]);
    await writeFile(join(candidateRoot, "tests/fixtures/delivery-acceptance-v2/f2-h-marker.txt"), "H\n");
    testGit(candidateRoot, ["add", "."]); testGit(candidateRoot, ["commit", "--quiet", "-m", "h"]);
    const refreshedPlanBytes = await readFile(join(candidateRoot, "docs/techPlans/AIDEV-191-implementation-plan.md"));
    const refreshedManifest = JSON.parse(await readFile(join(candidateRoot, "docs/techPlans/AIDEV-191-acceptance-manifest-v2.json"), "utf8"));
    refreshedManifest.base_sha = activatedHead;
    refreshedManifest.ticket_revision = "d".repeat(64);
    refreshedManifest.plan_sha256 = sha256(refreshedPlanBytes);
    for (const input of refreshedManifest.just_in_time_revalidation.inputs) {
      if (input.kind === "repository_revision" && input.name === "base_sha") input.expected = activatedHead;
      if (input.kind === "ticket_revision" && input.name === "ticket_revision") input.expected = refreshedManifest.ticket_revision;
      if (input.kind === "plan_digest" && input.name === "plan_sha256") input.expected = refreshedManifest.plan_sha256;
    }
    await writeFile(join(candidateRoot, "docs/techPlans/AIDEV-191-acceptance-manifest-v2.json"), `${JSON.stringify(refreshedManifest, null, 2)}\n`);
    testGit(candidateRoot, ["add", "."]); testGit(candidateRoot, ["commit", "--quiet", "-m", "refresh"]);
    const candidateHead = testGit(candidateRoot, ["rev-parse", "HEAD"]);
    await mkdir(evidenceRoot, { recursive: true });
    const proof = Buffer.from("activated proof");
    await writeFile(join(evidenceRoot, "proof.txt"), proof);
    const inventory = await externalInventoryReport(evidenceRoot);
    await writeFile(join(evidenceRoot, "evidence-inventory.json"), inventory);
    const planBytes = refreshedPlanBytes;
    const manifestBytes = await readFile(join(candidateRoot, "docs/techPlans/AIDEV-191-acceptance-manifest-v2.json"));
    const profileBytes = await readFile(join(activatedRoot, "profiles/pi-sampler.json"));
    const contractBytes = await readFile(join(activatedRoot, TRUSTED_DELIVERY_PATHS.manifestContract));
    const validatorBytes = await readFile(join(activatedRoot, TRUSTED_DELIVERY_PATHS.manifestValidator));
    const matrixSchemaBytes = await readFile(join(activatedRoot, TRUSTED_DELIVERY_PATHS.matrixSchema));
    const now = canonicalTimestamp();
    const matrix = {
      ...matrixSkeleton("implementation-delivery"),
      ticket_revision: "d".repeat(64), base_sha: activatedHead, head_sha: candidateHead,
      profile_sha256: sha256(profileBytes), policy_sha256: sha256(profileBytes), plan_sha256: sha256(planBytes), manifest_sha256: sha256(manifestBytes), manifest_contract_sha256: sha256(contractBytes), manifest_validator_sha256: sha256(validatorBytes), matrix_contract_sha256: sha256(matrixSchemaBytes), generated_at: now,
      rows: [{ id: "AIDEV-191-F2", acceptance_class: "ordinary", requirement: "An activated route reaches the trusted evaluator.", status: "observed", evidence: { verifier: { id: "npm-test", version: "v1", environment: "local", argv: ["npm", "test"] }, exit_status: 0, started_at: now, completed_at: now, artifacts: [{ name: "proof.txt", path: "proof.txt", sha256: sha256(proof), bytes: proof.length }, { name: "evidence-inventory.json", path: "evidence-inventory.json", sha256: sha256(inventory), bytes: inventory.length }] } }],
    };
    await writeFile(matrixPath, Buffer.from(canonicalJSONString(matrix) + "\n"));
    const profile = JSON.parse(profileBytes.toString("utf8"));
    const goResult = await runGoAcceptanceRequest(matrix, evidenceRoot, profile.acceptance);
    assert.equal(goResult.status, 0, goResult.stderr?.toString() || goResult.stdout?.toString());
    const expectedPlanValidatorBindings = { plan_path: matrix.plan_path, manifest_path: matrix.manifest_path, base_sha: activatedHead, repository: matrix.repository, ticket_id: matrix.ticket_id, ticket_revision: matrix.ticket_revision };
    let evaluatorReached = false;
    const validateOptions = { trustedBase: activatedHead, trustedWorktree: activatedRoot, candidateRoot, plan: matrix.plan_path, manifest: matrix.manifest_path, matrix: matrixPath, evidenceRoot, expectedHead: candidateHead, expectedRepository: matrix.repository, expectedTicket: matrix.ticket_id, expectedTicketRevision: matrix.ticket_revision, expectedPR: String(matrix.pull_request_number), evaluationScope: matrix.evaluation_scope };
    const authenticated = deriveAuthenticatedSourceRoot(activatedRoot, activatedHead, matrix.repository, candidateRoot);
    const childExclusions = transitionChild ? {
      authenticatedExclusions(_trustedRepo, _candidateRepo, source, roots) {
        return { exclusions: [source.path, _trustedRepo, _candidateRepo, roots.worktreeRoot, roots.reviewRoot, roots.quarantineRoot], roots };
      },
    } : {};
    const result = await runValidateForTest(validateOptions, {
      ...childExclusions,
      resolveAuthorityGoToolchain() { return { path: "go1.25.0-fixture", sha256: "a".repeat(64), version: "go version go1.25.0 fixture" }; },
      invokeGoEvaluator(request, context) {
        evaluatorReached = true;
        assert.deepEqual(Object.keys(request), ["format", "version", "normalized_facts", "facts_sha256", "matrix_base64", "evidence_root", "policy", "controller_time"]);
        assert.equal(context.toolchain.version, "go version go1.25.0 fixture");
        assert.ok(context.exclusions.includes(sourceRoot));
        assert.deepEqual(JSON.parse(Buffer.from(request.matrix_base64, "base64").toString("utf8")), matrix);
        return JSON.parse(goResult.stdout.toString("utf8"));
      },
    });
    assert.equal(evaluatorReached, true);
    assert.equal(result.status, "valid");
    assert.equal(result.code, "observed");

    testGit(sourceRoot, ["checkout", "--quiet", "--detach", sliceOneHead]);
    testGit(sourceRoot, ["commit", "--allow-empty", "--quiet", "-m", "wrong activated first parent"]);
    const wrongFirstParent = testGit(sourceRoot, ["rev-parse", "HEAD"]);
    const activatedTree = testGit(sourceRoot, ["show", "-s", "--format=%T", activatedHead]);
    const invalidActivatedHead = testCommitTree(sourceRoot, activatedTree, [wrongFirstParent, sliceOneHead]);
    testGit(sourceRoot, ["update-ref", "refs/heads/aidev191-invalid-activated", invalidActivatedHead]);
    const invalidActivatedRoot = await mkdtemp(join(managedRoot, "review", "aidev191-invalid-activated-"));
    const invalidClone = spawnSync("git", ["-c", "core.autocrlf=false", "clone", "--no-local", sourceRoot, invalidActivatedRoot], { cwd: root, encoding: "utf8", timeout: 120000 });
    assert.equal(invalidClone.status, 0, invalidClone.stderr);
    try {
      testGit(invalidActivatedRoot, ["remote", "remove", "origin"]);
      testGit(invalidActivatedRoot, ["config", "core.autocrlf", "false"]);
      testGit(invalidActivatedRoot, ["checkout", "--quiet", "--detach", invalidActivatedHead]);
      testGit(invalidActivatedRoot, ["reset", "--hard", "--quiet", invalidActivatedHead]);
      await assert.rejects(() => runValidateForTest({ ...validateOptions, trustedBase: invalidActivatedHead, trustedWorktree: invalidActivatedRoot }, { ...childExclusions }), /activation_map_invalid/);
    } finally { await rm(invalidActivatedRoot, { recursive: true, force: true }); }

    const invalidEnvelope = JSON.parse(goResult.stdout.toString("utf8"));
    invalidEnvelope.status = "invalid";
    invalidEnvelope.code = "artifact_digest_mismatch";
    invalidEnvelope.rows = invalidEnvelope.rows.map((row) => ({ ...row, status: "invalid", code: "artifact_digest_mismatch" }));
    invalidEnvelope.diagnostics = [{ code: "artifact_digest_mismatch", path: "/rows/0/evidence/artifacts/0/sha256" }];
    const evaluatorFailure = await runValidateForTest(validateOptions, { ...childExclusions, runTrustedPlanValidator: () => ({ format: "pi-sampler.implementation-plan-validator", version: 1, ok: true, bindings: expectedPlanValidatorBindings, diagnostics: [], summary: { input_schema: "implementation-plan-manifest/v2", diagnostic_count: 0, error_count: 0 } }), resolveAuthorityGoToolchain: () => ({ path: "go1.25.0-fixture", sha256: "a".repeat(64), version: "go version go1.25.0 fixture" }), invokeGoEvaluator: () => invalidEnvelope });
    assert.equal(evaluatorFailure.status, "invalid");
    assert.equal(evaluatorFailure.code, "artifact_digest_mismatch");
    await assert.rejects(() => runValidateForTest(validateOptions, { ...childExclusions, authenticatedExclusions: () => ({ exclusions: [], roots: authenticated.roots }), runTrustedPlanValidator: () => ({ format: "pi-sampler.implementation-plan-validator", version: 1, ok: true, bindings: expectedPlanValidatorBindings, diagnostics: [], summary: { input_schema: "implementation-plan-manifest/v2", diagnostic_count: 0, error_count: 0 } }), resolveAuthorityGoToolchain: () => ({ path: "go1.25.0-fixture", sha256: "a".repeat(64), version: "go version go1.25.0 fixture" }), invokeGoEvaluator: () => JSON.parse(goResult.stdout.toString("utf8")) }), /candidate_root_invalid/);
    await assert.rejects(() => runValidateForTest(validateOptions, { ...childExclusions, runTrustedPlanValidator: () => ({ format: "pi-sampler.implementation-plan-validator", version: 1, ok: false, bindings: expectedPlanValidatorBindings, diagnostics: [{ code: "manifest_schema_invalid" }], summary: { input_schema: "implementation-plan-manifest/v2", diagnostic_count: 1, error_count: 1 } }), resolveAuthorityGoToolchain: () => ({ path: "go1.25.0-fixture", sha256: "a".repeat(64), version: "go version go1.25.0 fixture" }), invokeGoEvaluator: () => JSON.parse(goResult.stdout.toString("utf8")) }), /manifest_validator_failed/);
    await assert.rejects(() => runValidateForTest({ ...validateOptions, expectedHead: activatedHead }, { ...childExclusions, runTrustedPlanValidator: () => { throw new Error("must not reach validator"); } }), /candidate_head_mismatch/);
  } finally { await rm(dependencyLink, { recursive: true, force: true }); await rm(fixtureBase, { recursive: true, force: true }); }
}));

test("A191-T01 strict v2 schema and frozen v1 contracts are explicit", async () => {
  const schema = JSON.parse(await readFile(join(root, "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json"), "utf8"));
  assert.deepEqual(schema.required, [
    "schema_version", "manifest_schema_version", "evaluation_scope", "repository", "ticket_id", "ticket_revision", "profile_path", "profile_sha256", "base_sha", "head_sha", "pull_request_number", "plan_path", "plan_sha256", "manifest_path", "manifest_sha256", "manifest_contract_path", "manifest_contract_sha256", "manifest_validator_path", "manifest_validator_sha256", "matrix_contract_path", "matrix_contract_sha256", "policy_path", "policy_sha256", "evidence_root_id", "generated_at", "rows",
  ]);
  const visit = (value) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    if (value.type === "object") assert.equal(value.additionalProperties, false);
    Object.values(value).forEach(visit);
  };
  visit(schema);
  assert.equal(sha256(await readFile(join(root, "governance/docs/delivery-evidence/acceptance-matrix-v1.schema.json"))), "c52283e1d360491ff67f90d1801f2f5ee7b98f4df9ff6e4c8c9f8dd3d94c0021");
  const route = spawnSync("go", ["test", "./pkg/deliveryevidence", "-run", "^TestAcceptanceV2/A191-T01$", "-count=1"], { cwd: join(root, "governance"), encoding: "utf8", timeout: 120000 });
  assert.equal(route.status, 0, route.stderr || route.stdout);
});

test("A191-T02 version dispatch has one exact parser and no aliases", () => {
  const parsed = parseTrustedDeliveryArgs(["--mode", "support", "--candidate-root", root, "--trusted-base", currentHead, "--expected-head", currentHead, "--json"]);
  assert.equal(parsed.mode, "support");
  assert.equal(parseTrustedDeliveryArgs(["--mode", "transition", "--trusted-base", currentHead, "--trusted-worktree", root, "--candidate-root", root, "--candidate-activation", "contracts/delivery-acceptance-v2-activation.json", "--candidate-activation-map", "contracts/delivery-acceptance-v2-trusted-map.json", "--expected-repository", "Zkrausman/pi-sampler", "--expected-ticket", "AIDEV-191", "--expected-ticket-revision", "d".repeat(64), "--expected-head", currentHead, "--expected-pr", "191", "--json"]).mode, "transition");
  assert.equal(parseTrustedDeliveryArgs(["--mode", "validate", "--trusted-base", currentHead, "--trusted-worktree", root, "--candidate-root", root, "--plan", "docs/techPlans/AIDEV-191-implementation-plan.md", "--manifest", "docs/techPlans/AIDEV-191-acceptance-manifest-v2.json", "--matrix", join(root, "package.json"), "--evidence-root", root, "--expected-repository", "Zkrausman/pi-sampler", "--expected-ticket", "AIDEV-191", "--expected-ticket-revision", "d".repeat(64), "--expected-head", currentHead, "--expected-pr", "191", "--evaluation-scope", "plan-publication", "--json"]).mode, "validate");
  const v1 = Buffer.from('{"schema_version":"acceptance-matrix/v1","rows":[]}');
  const v1Manifest = Buffer.from('{"schema_version":"acceptance-manifest/v1","rows":[]}');
  const v2 = Buffer.from('{"schema_version":"acceptance-matrix/v2","manifest_schema_version":"implementation-plan-manifest/v2","rows":[]}');
  const v2Manifest = Buffer.from('{"schema_version":"implementation-plan-manifest/v2","rows":[]}');
  assert.equal(classifyAcceptanceVersionPair(v1, v1Manifest), "v1/v1");
  assert.equal(classifyAcceptanceVersionPair(v2, v2Manifest), "v2/v2");
  assert.equal(classifyAcceptanceVersionPair(v1, v2Manifest), "version_pair_mixed");
  assert.equal(classifyAcceptanceVersionPair(v2, v1Manifest), "version_pair_mixed");
  assert.equal(classifyAcceptanceVersionPair(Buffer.from('{"schema_version":"acceptance-matrix/v9"}'), v1Manifest), "version_pair_unsupported");
  assert.equal(classifyAcceptanceVersionPair(Buffer.from('{"schema_version":"acceptance-matrix/v1","schema_version":"acceptance-matrix/v1"}'), v1Manifest), "version_pair_unsupported");
  for (const argv of [["--mode", "future"], ["--mode", "support", "--profile", "candidate.json"], ["--mode", "support", "--pull-request", "191"], ["--mode", "support", "--mode", "validate"], ["--mode", "transition", "--trusted-base", currentHead, "--trusted-worktree", root, "--candidate-root", root, "--candidate-activation", "contracts/delivery-acceptance-v2-activation.json", "--candidate-activation-map", "contracts/delivery-acceptance-v2-trusted-map.json", "--expected-repository", "Zkrausman/pi-sampler", "--expected-ticket", "AIDEV-191", "--expected-ticket-revision", "d".repeat(64), "--expected-head", currentHead, "--expected-pr", "191", "--trusted-project-root", root, "--json"]]) {
    assert.throws(() => parseTrustedDeliveryArgs(argv));
  }
  const route = spawnSync("go", ["test", "./pkg/deliveryevidence", "-run", "^TestAcceptanceV2/A191-T02$", "-count=1"], { cwd: join(root, "governance"), encoding: "utf8", timeout: 120000 });
  assert.equal(route.status, 0, route.stderr || route.stdout);
});

test("A191-T03 immutable AIDEV-187 fixture keeps all twelve source tuples", async () => {
  const manifest = JSON.parse(await readFile(join(root, "tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json"), "utf8"));
  assert.equal(manifest.schema_version, "implementation-plan-manifest/v2");
  assert.equal(manifest.rows.length, 12);
  assert.deepEqual(manifest.rows.map(({ id }) => id), Array.from({ length: 12 }, (_, index) => `AIDEV-187-${index + 1}`));
  assert.equal(sha256(await readFile(join(root, "tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md"))), "e88bafec7997fa247e56451dc72fd49007e9ac1128679d9ee21a6cc061848744");
  const route = spawnSync("go", ["test", "./pkg/deliveryevidence", "-run", "^TestAcceptanceV2/A191-T03$", "-count=1"], { cwd: join(root, "governance"), encoding: "utf8", timeout: 120000 });
  assert.equal(route.status, 0, route.stderr || route.stdout);
});

test("D3 committed Slice 2 scope is exact and mode-bound", async () => {
  const repo = await mkdtemp(join(tmpdir(), "aidev191-diff-"));
  try {
    testGit(repo, ["init", "--quiet"]);
    testGit(repo, ["config", "user.email", "test@example.invalid"]);
    testGit(repo, ["config", "user.name", "AIDEV test"]);
    const all = [...SLICE2_MAP_PATHS, "contracts/delivery-acceptance-v2-trusted-map.json"];
    for (const path of all) { await mkdir(join(repo, dirname(path)), { recursive: true }); if (path.includes("activation") || path.includes("trusted-map")) continue; await writeFile(join(repo, path), "base\n"); }
    testGit(repo, ["add", "."]); testGit(repo, ["commit", "--quiet", "-m", "base"]); const base = testGit(repo, ["rev-parse", "HEAD"]);
    for (const path of all) { await mkdir(join(repo, dirname(path)), { recursive: true }); await writeFile(join(repo, path), "slice2\n"); }
    testGit(repo, ["add", "."]); testGit(repo, ["commit", "--quiet", "-m", "slice2"]); const head = testGit(repo, ["rev-parse", "HEAD"]);
    const diff = enumerateCommittedSlice2Diff(repo, base, head);
    assert.deepEqual(diff.map(({ path }) => path).sort(), [...all].sort());
    assert.ok(diff.every(({ mode }) => mode === "100644"));
    await writeFile(join(repo, "workflow-extra.yml"), "extra\n");
    testGit(repo, ["add", "."]); testGit(repo, ["commit", "--quiet", "-m", "extra"]); const extra = testGit(repo, ["rev-parse", "HEAD"]);
    assert.throws(() => enumerateCommittedSlice2Diff(repo, base, extra), /candidate_blob_invalid/);

    const mutationRepo = async (mutation) => {
      const fixture = await mkdtemp(join(tmpdir(), "aidev191-diff-mutation-"));
      try {
        testGit(fixture, ["init", "--quiet"]); testGit(fixture, ["config", "user.email", "test@example.invalid"]); testGit(fixture, ["config", "user.name", "AIDEV test"]);
        for (const path of all) { await mkdir(join(fixture, dirname(path)), { recursive: true }); if (!path.includes("activation") && !path.includes("trusted-map")) await writeFile(join(fixture, path), "base\n"); }
        testGit(fixture, ["add", "."]); testGit(fixture, ["commit", "--quiet", "-m", "base"]); const fixtureBase = testGit(fixture, ["rev-parse", "HEAD"]);
        await mutation(fixture, all);
        testGit(fixture, ["add", "-A"]); testGit(fixture, ["commit", "--quiet", "-m", "mutation"]); const fixtureHead = testGit(fixture, ["rev-parse", "HEAD"]);
        assert.throws(() => enumerateCommittedSlice2Diff(fixture, fixtureBase, fixtureHead), /candidate_blob_invalid/);
      } finally { await rm(fixture, { recursive: true, force: true }); }
    };
    const writeSlice2 = async (fixture, paths) => { for (const path of paths) { if (!path.includes("activation") && !path.includes("trusted-map")) await writeFile(join(fixture, path), "slice2\n"); } };
    await mutationRepo(async (fixture, paths) => { for (const path of paths.slice(0, -1)) if (!path.includes("activation") && !path.includes("trusted-map")) await writeFile(join(fixture, path), "slice2\n"); });
    await mutationRepo(async (fixture, paths) => { await writeSlice2(fixture, paths); await testGit(fixture, ["mv", paths[1], "renamed.txt"]); });
    await mutationRepo(async (fixture, paths) => { await writeSlice2(fixture, paths); await copyFile(join(fixture, paths[1]), join(fixture, "copy.txt")); });
    await mutationRepo(async (fixture, paths) => { await writeSlice2(fixture, paths); testGit(fixture, ["update-index", "--chmod=+x", paths[1]]); });
    await mutationRepo(async (fixture, paths) => { await writeSlice2(fixture, paths); await rm(join(fixture, paths[1])); await mkdir(join(fixture, paths[1])); });
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("A191-T04 trusted blob reads are exact and fixed-path only", () => {
  const profile = readTrustedBlob(root, currentHead, TRUSTED_DELIVERY_PATHS.profile);
  assert.equal(profile.path, TRUSTED_DELIVERY_PATHS.profile);
  assert.equal(profile.mode, "100644");
  assert.equal(profile.type, "blob");
  assert.equal(profile.sha256, sha256(profile.content));
  assert.throws(() => readTrustedBlob(root, currentHead, "profiles/../profiles/pi-sampler.json"));
});

test("D4 evaluator envelope preserves valid, invalid, and blocked exits", () => {
  const envelope = (status, code, rowStatus) => ({ format: "pi-sampler.delivery-acceptance-result", version: 1, status, code, evaluation_scope: "implementation-delivery", facts_sha256: "a".repeat(64), matrix_sha256: "b".repeat(64), rows: [{ id: "AIDEV-191-1", status: rowStatus, code }], diagnostics: status === "valid" ? [] : [{ code, path: "/matrix" }] });
  assert.equal(parseEvaluatorEnvelope({ status: 0, stdout: Buffer.from(`${canonicalJSONString(envelope("valid", "observed", "valid"))}\n`) }).status, "valid");
  assert.equal(parseEvaluatorEnvelope({ status: 1, stdout: Buffer.from(`${canonicalJSONString(envelope("invalid", "matrix_schema_invalid", "invalid"))}\n`) }).status, "invalid");
  assert.equal(parseEvaluatorEnvelope({ status: 3, stdout: Buffer.from(`${canonicalJSONString(envelope("blocked", "unsupported_class_policy", "blocked"))}\n`) }).status, "blocked");
  assert.throws(() => parseEvaluatorEnvelope({ status: 1, stdout: Buffer.from(`${canonicalJSONString(envelope("valid", "observed", "valid"))}\n`) }), /test_failed/);
});

test("A191-T05 normalized facts preserve prescribed order and domain separation", () => {
  const matrix = matrixSkeleton();
  const result = buildNormalizedFacts(matrix);
  assert.deepEqual(Object.keys(result.facts), ["format", "version", "repository", "ticketId", "ticketRevision", "profilePath", "profileSha256", "baseSha", "headSha", "pullRequestNumber", "planPath", "planSha256", "manifestPath", "manifestSha256", "manifestSchemaVersion", "manifestContractSha256", "manifestValidatorSha256", "matrixContractSha256", "policySha256", "evaluationScope", "rows"]);
  assert.equal(result.bytes.toString("utf8"), `${canonicalJSONString(result.facts)}\n`);
  assert.equal(result.factsSha256, sha256(Buffer.concat([Buffer.from("pi-sampler.delivery-normalized-facts/v1\0"), result.bytes])));
});

test("N5/D12 schema and runtime share the UTF-8 byte-bounded string language", async () => {
  const schema = JSON.parse(await readFile(join(root, "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json"), "utf8"));
  const defaultPattern = new RegExp(schema.$defs.defaultString.pattern);
  const pathSchema = { $schema: schema.$schema, $defs: schema.$defs, ...schema.$defs.artifactPath };
  const pathValidator = Compile(pathSchema);
  for (const corpusEntry of schema["x-portable-path-corpus"]) assert.equal(pathValidator.Check(corpusEntry.value), corpusEntry.valid, corpusEntry.value);
  const path256Validator = Compile({ $schema: schema.$schema, $defs: schema.$defs, ...schema.$defs.portablePath256 });
  assert.equal(path256Validator.Check("a".repeat(255)), true);
  assert.equal(path256Validator.Check("a".repeat(256)), false);
  assert.equal(defaultPattern.test("plain ASCII requirement"), true);
  assert.equal(defaultPattern.test("é"), true);
  assert.equal(validateUtf8ByteConstraint("é".repeat(1024), schema.$defs.defaultString), true);
  assert.equal(validateUtf8ByteConstraint("é".repeat(1025), schema.$defs.defaultString), false);
  const utf8Matrix = { rows: [{ requirement: "é", evidence: { verifier: { argv: ["é"] } } }] };
  assert.equal(validateAcceptanceV2Utf8Fields(utf8Matrix, schema), true);
  utf8Matrix.rows[0].blocker = { reason: "\u0007" };
  assert.equal(validateAcceptanceV2Utf8Fields(utf8Matrix, schema), false);
  assert.equal(defaultPattern.test("line\nfeed"), false);
  const verifierPattern = new RegExp(schema.$defs.verifierString.pattern);
  assert.equal(verifierPattern.test("test-verifier/v1"), true);
  assert.equal(verifierPattern.test("!unsafe"), false);
});

test("G3 artifact names use the shared UTF-8 logical-name corpus", async () => {
  const schema = JSON.parse(await readFile(join(root, "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json"), "utf8"));
  const validator = Compile({ $schema: schema.$schema, $defs: schema.$defs, ...schema.$defs.artifactName });
  const validName = (value) => validator.Check(value) && validateUtf8ByteConstraint(value, schema.$defs.artifactName);
  for (const entry of schema["x-artifact-name-corpus"]) {
    if (entry.encoding === "invalid-utf8") {
      assert.equal(validName(String.fromCharCode(0xd800)), entry.valid, entry.encoding);
      continue;
    }
    if (Array.isArray(entry.values)) {
      const seen = new Set();
      let actual = true;
      for (const value of entry.values) {
        const key = process.platform === "win32" ? value.toLowerCase() : value;
        if (!validName(value) || seen.has(key)) actual = false;
        seen.add(key);
      }
      const expected = entry.platform === "windows" && process.platform !== "win32" ? true : entry.valid;
      assert.equal(actual, expected, entry.kind);
      continue;
    }
    const value = (entry.value ?? "").repeat(entry.repeat ?? 1) + (entry.suffix ?? "");
    assert.equal(validName(value), entry.valid, value);
  }
  assert.equal(validName("name with spaces"), true);
  assert.equal(validName("logical/name"), true);
});

test("D13 acceptance-v2 CLI is stdin-only, bounded, and single-framed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aidev191-stdin-"));
  const binary = join(dir, process.platform === "win32" ? "validator.exe" : "validator");
  try {
    const build = spawnSync("go", ["build", "-o", binary, "./cmd/delivery-evidence-validator"], { cwd: join(root, "governance"), encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const fileMode = spawnSync(binary, ["-mode", "acceptance-v2", "-request", binary], { cwd: join(root, "governance"), input: "{}", encoding: "utf8", timeout: 120000 });
    assert.equal(fileMode.status, 2);
    const validEvidenceRoot = join(dir, "evidence");
    await mkdir(validEvidenceRoot, { recursive: true });
    const validMatrix = await implementationMatrixForCLI(validEvidenceRoot);
    const validFacts = buildNormalizedFacts(validMatrix);
    const validRequest = { format: "pi-sampler.delivery-acceptance-v2-request", version: 1, normalized_facts: validFacts.facts, facts_sha256: validFacts.factsSha256, matrix_base64: Buffer.from(`${canonicalJSONString(validMatrix)}\n`).toString("base64"), evidence_root: validEvidenceRoot, policy: { classes: [{ id: "ordinary", kind: "ordinary", verifier: "test-verifier", environment: "local", command: ["test"], version: "v1" }] }, controller_time: validMatrix.generated_at };
    const exactMode = spawnSync(binary, ["-mode", "acceptance-v2"], { cwd: join(root, "governance"), input: `${canonicalJSONString(validRequest)}\n`, encoding: "utf8", timeout: 120000 });
    assert.equal(exactMode.status, 0, exactMode.stderr || exactMode.stdout);
    const legacyFlags = ["-manifest", "-acceptance-manifest", "-acceptance-matrix", "-benchmark-evidence", "-waiver", "-repo-root", "-expected-commit", "-expected-repository", "-expected-ticket", "-expected-row", "-expected-plan", "-expected-base", "-expected-head", "-expected-pr", "-benchmark-class", "-trusted-config", "-replay-state"];
    const invalidArgv = [
      ["-mode", "acceptance-v2", "positional"],
      ["--mode", "acceptance-v2", "positional"],
      ["-mode", "acceptance-v2", "-mode", "acceptance-v2"],
      ["-mode", "acceptance-v2", "--mode", "acceptance-v2"],
      ["-mode=acceptance-v2"],
      ["--mode=acceptance-v2"],
      ["--mode", "acceptance-v2"],
      ["--mode=acceptance-v2", "-manifest", "ignored.json"],
      ["--mode", "acceptance-v2", "-unknown", "ignored"],
      ...legacyFlags.map((flag) => ["--mode", "acceptance-v2", flag, "ignored"]),
    ];
    for (const argv of invalidArgv) {
      const rejected = spawnSync(binary, argv, { cwd: join(root, "governance"), input: argv[0] === "--mode" && argv[1] === "acceptance-v2" && argv.length === 2 ? `${canonicalJSONString(validRequest)}\n` : "{}", encoding: "utf8", timeout: 120000 });
      assert.equal(rejected.status, 2, argv.join(" "));
    }
    const trailing = spawnSync(binary, ["-mode", "acceptance-v2"], { cwd: join(root, "governance"), input: "{}\n{}", encoding: "utf8", timeout: 120000 });
    assert.equal(trailing.status, 2);
    const overLimit = spawnSync(binary, ["-mode", "acceptance-v2"], { cwd: join(root, "governance"), input: Buffer.alloc(12 * 1024 * 1024 + 1, 0x20), encoding: "utf8", timeout: 120000 });
    assert.equal(overLimit.status, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("A191-T06 support is functional-only and never an acceptance authority", () => {
  assert.equal(DELIVERY_V2_SUPPORT_AUTHORITY, "functional-only");
  assert.equal(DELIVERY_V2_SUPPORT_CAN_GRANT_AUTHORITY, false);
});

test("A191-T07 portable artifact paths reject aliases and unsafe names", async () => {
  const schema = JSON.parse(await readFile(join(root, "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json"), "utf8"));
  const pattern = new RegExp(schema.$defs.portablePath.pattern);
  for (const unsafe of ["/absolute", "docs/../secret", "docs/CON/file", "docs/report./file", "docs/report%2e/file", "docs\\file"]) assert.equal(pattern.test(unsafe), false, unsafe);
  assert.equal(pattern.test("evidence/proof.txt"), true);
});

test("A191-T08 unsupported benchmark and evidence classes remain inert", async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "aidev191-evidence-"));
  try {
    const ordinary = await implementationMatrixForCLI(evidenceRoot, "ordinary");
    const ordinaryPolicy = { classes: [{ id: "ordinary", kind: "ordinary", verifier: "test-verifier", environment: "local", command: ["test"], version: "v1" }] };
    const ordinaryResult = await runGoAcceptanceRequest(ordinary, evidenceRoot, ordinaryPolicy);
    assert.equal(ordinaryResult.status, 0);
    assert.equal(JSON.parse(ordinaryResult.stdout).status, "valid");
    const matrix = await implementationMatrixForCLI(evidenceRoot, "benchmark");
    const policy = { classes: [{ id: "benchmark-ci-regression", kind: "benchmark", verifier: "benchmark", environment: "ci", command: ["benchmark"] }] };
    const result = await runGoAcceptanceRequest(matrix, evidenceRoot, policy);
    assert.equal(result.status, 3);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.status, "blocked");
    assert.equal(envelope.code, "unsupported_class_policy");
    assert.equal(envelope.rows[0].status, "blocked");
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test("A191-T09 activation and trusted-map declarations are absent before Slice 2", async () => {
  let activation;
  try { activation = JSON.parse(await readFile(join(root, "contracts/delivery-acceptance-v2-activation.json"), "utf8")); } catch (error) { assert.equal(error.code, "ENOENT"); }
  if (activation) {
    assert.equal(activation.format, "pi-sampler.delivery-acceptance-v2-activation");
    assert.equal(activation.version, 1);
    assert.equal(activation.state, "active");
    const trustedMap = JSON.parse(await readFile(join(root, "contracts/delivery-acceptance-v2-trusted-map.json"), "utf8"));
    assert.equal(trustedMap.format, "pi-sampler.delivery-acceptance-v2-trusted-map");
  } else {
    await assert.rejects(stat(join(root, "contracts/delivery-acceptance-v2-trusted-map.json")), { code: "ENOENT" });
    const sourceRoot = resolve(root, "../../../pi-sampler");
    const managedReviewRoot = resolve(sourceRoot, "../ai-workspaces/review");
    const clean = await mkdtemp(join(managedReviewRoot, "aidev191-trusted-"));
    try {
      const clone = spawnSync("git", ["-c", "core.autocrlf=false", "clone", "--no-local", root, clean], { cwd: root, encoding: "utf8", timeout: 120000 });
      assert.equal(clone.status, 0, clone.stderr);
      assert.equal(spawnSync("git", ["remote", "remove", "origin"], { cwd: clean, encoding: "utf8" }).status, 0);
      assert.equal(spawnSync("git", ["checkout", "--detach", currentHead], { cwd: clean, encoding: "utf8" }).status, 0);
      const result = spawnSync(process.execPath, [join(root, "scripts/trusted-delivery-evidence-controller.mjs"), "--mode", "validate", "--trusted-base", currentHead, "--trusted-worktree", clean, "--candidate-root", root, "--expected-head", currentHead, "--expected-repository", "Zkrausman/pi-sampler", "--expected-ticket", "AIDEV-191", "--expected-ticket-revision", "d".repeat(64), "--expected-pr", "191", "--plan", "docs/techPlans/AIDEV-191-implementation-plan.md", "--manifest", "docs/techPlans/AIDEV-191-acceptance-manifest-v2.json", "--matrix", join(root, "package.json"), "--evidence-root", root, "--evaluation-scope", "plan-publication", "--json"], { cwd: root, encoding: "utf8", timeout: 120000 });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /"code":"activation_absent"/);
      assert.doesNotMatch(result.stdout, /E:\\|\/Repos|AIDEV-191-0a00b7/);
    } finally { await rm(clean, { recursive: true, force: true }); }
  }
});

test("A191-T10 compatibility parsing remains low-level and non-admitting", async () => {
  const route = spawnSync("go", ["test", "./pkg/deliveryevidence", "-run", "^TestAcceptanceV2/A191-T10$", "-count=1"], { cwd: join(root, "governance"), encoding: "utf8", timeout: 120000 });
  assert.equal(route.status, 0, route.stderr || route.stdout);
  const manifest = JSON.parse(await readFile(join(root, "tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json"), "utf8"));
  assert.deepEqual(manifest.rows.map(({ id }) => id), Array.from({ length: 12 }, (_, index) => `AIDEV-187-${index + 1}`));
});

test("A191-T11 fixed Git selection is deterministic across hostile roots", () => {
  const actual = locateFixedGit();
  assert.equal(typeof actual, "string");
  const attempts = [];
  assert.throws(() => locateFixedGit("win32", { lstatSync: (path) => ({ isFile: () => path.endsWith("git.exe"), isDirectory: () => !path.endsWith("git.exe"), isSymbolicLink: () => false }), realpathSync(path) { if (path.endsWith("git.exe")) attempts.push(path); if (path.endsWith("git.exe")) throw new Error("missing"); return path; } }), /test_failed/);
  assert.deepEqual(attempts, ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe"]);
  assert.equal(typeof locateFixedGit("linux", { lstatSync: (path) => ({ isFile: () => path === "/usr/bin/git", isDirectory: () => path !== "/usr/bin/git", isSymbolicLink: () => false }), realpathSync: (path) => path, statSync: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }), accessSync: () => {} }), "string");
});

test("D7 authority toolchain selection is absolute, hashed, and version-bound", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aidev191-toolchain-"));
  const executable = join(dir, process.platform === "win32" ? "go.exe" : "go");
  const bytes = Buffer.from("deterministic fake go executable");
  try {
    await writeFile(executable, bytes);
    if (process.platform !== "win32") await chmod(executable, 0o755);
    const inspected = inspectTrustedGoExecutable(executable, { expectedSha256: sha256(bytes), versionOutput: "go version go1.25.0 test/amd64" });
    assert.equal(inspected.sha256, sha256(bytes));
    const fixed = resolveTrustedGoExecutableFromFixedCandidates("win32", { lstatSync: (path) => ({ isFile: () => path.endsWith("go.exe"), isDirectory: () => !path.endsWith("go.exe"), isSymbolicLink: () => false }), realpathSync: (value) => value, statSync: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }) });
    assert.equal(fixed, "C:\\Program Files\\Go\\bin\\go.exe");
    assert.throws(() => inspectTrustedGoExecutable(executable, { expectedSha256: "0".repeat(64), versionOutput: "go version go1.25.0 test/amd64" }), /test_failed/);
    assert.throws(() => inspectTrustedGoExecutable(executable, { expectedSha256: sha256(bytes), versionOutput: "go version go1.26.1 test/amd64" }), /test_failed/);
    assert.throws(() => inspectTrustedGoExecutable("go", { versionOutput: "go version go1.25.0 test/amd64" }), /test_failed/);
    const redirected = { lstatSync: (path) => ({ isFile: () => path.endsWith("go.exe"), isDirectory: () => !path.endsWith("go.exe"), isSymbolicLink: () => path.endsWith("\\bin"), }), realpathSync: (value) => value, statSync: () => ({ isFile: () => true, isDirectory: () => false }) };
    assert.throws(() => resolveTrustedGoExecutableFromFixedCandidates("win32", redirected), /test_failed/);
    const redirectedAncestor = { lstatSync: (path) => ({ isFile: () => path.endsWith("go.exe"), isDirectory: () => !path.endsWith("go.exe"), isSymbolicLink: () => false }), realpathSync: (path) => path.endsWith("\\bin") ? "C:\\attacker" : path, statSync: () => ({ isFile: () => true, isDirectory: () => false }) };
    assert.throws(() => resolveTrustedGoExecutableFromFixedCandidates("win32", redirectedAncestor), /test_failed/);
    assert.throws(() => inspectTrustedGitExecutable(executable, "0".repeat(64)), /test_failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("N7 toolchain selection has no caller-owned digest selector", () => {
  assert.equal(resolveAuthorityGoToolchain.length, 0);
});


test("A191-T12 trusted lifecycle blob map", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["validate:delivery-acceptance"], "node scripts/validate-delivery-evidence.mjs --mode acceptance");
  const expected = new Map([
    ["scripts/final-review-receipt.mjs", "6f54daaf0ca4d9e9d77a7b6ae10ef501dfefdcd3f95f86b0cf436494f36b8f70"],
    ["scripts/validate-adversarial-review-attestation.mjs", "3f82e8ac12170dff1dd97be463714000999fee1d23c01b4f436593b976771716"],
    ["scripts/hooks/pre-push.mjs", "909cbd70be40b99cd08c2087e4ed47a9e9fcc9cbef7147e40c938f100748d992"],
    [".github/workflows/adversarial-review.yml", "f13e54e13a3fa6243fce15c71e1cd8b85ab186d58ce8e17eb365bb001847e9cc"],
    [".github/workflows/validate.yml", "35c3e2e44099b88a877185670e6a6df9b6da5b404fdb9290d404bd5fed0dbdef"],
    [".github/pull_request_template.md", "39487f1e424b45a10ecab24cacb6ad45af79e0bab2873623f17b36f8420240c1"],
    ["scripts/generate-review-packet.mjs", "11ebb005703f69a4431e4a28fdc050409a442e340cc09902c82a348272bff2b2"],
    ["scripts/review-policy.mjs", "12d32a4b589dc1d1b05089409cc65e4fffcd7867b5eee438b140688a01cc7b4f"],
    ["docs/SCOPED-REVIEW.md", "46513d14f2c6da3e7290a80db3283b61668bc48e25485c3bc3a060ab28c1fe16"],
  ]);
  for (const [path, digest] of expected) assert.equal(sha256(await readFile(join(root, path))), digest, path);
  await assert.rejects(stat(join(root, ".github/workflows/test.yml")), { code: "ENOENT" });
  assert.doesNotMatch(await readFile(join(root, "scripts/trusted-delivery-evidence-controller.mjs"), "utf8"), /git\s+push|gh\s+pr\s+merge|linear/i);
});
