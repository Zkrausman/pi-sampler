import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DELIVERY_V2_SUPPORT_AUTHORITY,
  DELIVERY_V2_SUPPORT_CAN_GRANT_AUTHORITY,
  PLAN_AMENDMENT_4_SHA,
  SLICE1A_SHA,
  SLICE1B_SHA,
  SUPPORT_CURRENT_PATHS,
  SUPPORT_OPERATIONAL_PATHS,
  SUPPORT_PREDECESSOR_PATHS,
  TRUSTED_DELIVERY_PATHS,
  buildNormalizedFacts,
  buildSupportReport,
  validateSupportInventory,
  canonicalJSONString,
  classifyAcceptanceVersionPair,
  locateFixedGit,
  readTrustedBlob,
  runSupportForTest,
  parseTrustedDeliveryArgs,
  sha256Bytes,
} from "../scripts/trusted-delivery-evidence-controller.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const run = (args) => spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 });

function supportOptions(overrides = {}) {
  return { candidateRoot: root, trustedBase: SLICE1B_SHA, expectedHead: SLICE1B_SHA, ...overrides };
}

function fakeSupportCommands({ commands }) {
  return commands.map((command) => ({
    argv: command.reportArgv,
    status: 0,
    ok: true,
    stdoutSha256: "0".repeat(64),
    stderrSha256: "0".repeat(64),
  }));
}

async function supportReport(overrides = {}, dependencies = { runCommands: fakeSupportCommands }) {
  return runSupportForTest(supportOptions(overrides), dependencies);
}

const digest = (letter) => letter.repeat(64);

function supportInventoryFixture() {
  const statusRecords = SUPPORT_CURRENT_PATHS.map(({ path, status }) => ({
    path,
    kind: status === "added" ? "untracked" : "ordinary",
    xy: status === "added" ? "??" : ".M",
  }));
  const predecessor = SUPPORT_PREDECESSOR_PATHS.map((path, index) => ({
    path,
    partition: "predecessor",
    status: "clean",
    mode: "100644",
    type: "blob",
    bytes: index + 1,
    sha256: digest("0123456789"[index]),
    base_object_id: "abcdef0123"[index].repeat(40),
    base_sha256: digest("0123456789"[index]),
  }));
  const current = SUPPORT_CURRENT_PATHS.map(({ path, status }, index) => ({
    path,
    partition: "current",
    status,
    mode: "100644",
    type: "blob",
    bytes: index + 20,
    sha256: digest("b"),
    base_object_id: status === "added" ? null : "2".repeat(40),
    base_sha256: status === "added" ? null : digest("c"),
  }));
  return {
    format: "pi-sampler.delivery-v2-support-inventory",
    version: 1,
    base_sha: SLICE1B_SHA,
    head_sha: SLICE1B_SHA,
    git: { object_format: "sha1", common_sha256: digest("d"), objects_sha256: digest("e"), branch: "" },
    status: { format: "git-porcelain-v2", index: "clean", sha256: digest("f"), records: statusRecords },
    partition: { predecessor: SUPPORT_PREDECESSOR_PATHS.slice(), current: SUPPORT_CURRENT_PATHS.map(({ path, status }) => ({ path, status })) },
    paths: [...predecessor, ...current],
  };
}

function mockedSupportDependencies(before, after = before) {
  const calls = { freezes: 0, imports: 0, spawns: 0 };
  const dependencies = {
    canonicalDirectory: (value) => value,
    gitIdentity: (_repo, expectedHead) => ({ head: expectedHead ?? SLICE1B_SHA }),
    verifyCommit: () => {},
    assertAncestry: () => {},
    freezeInventory: () => { calls.freezes += 1; return structuredClone(before); },
    importCore: async () => {
      calls.imports += 1;
      return { runSupportCommands: () => [], freezeSupportInventory: () => structuredClone(after) };
    },
    runCommands: ({ commands }) => {
      calls.spawns += 1;
      return fakeSupportCommands({ commands });
    },
  };
  return { dependencies, calls };
}

async function assertInventoryFailure(mutator, code) {
  const before = supportInventoryFixture();
  mutator(before);
  const { dependencies, calls } = mockedSupportDependencies(before);
  await assert.rejects(() => runSupportForTest(supportOptions(), dependencies), new RegExp(code));
  assert.equal(calls.imports, 0, `${code}: candidate core import must remain untouched`);
  assert.equal(calls.spawns, 0, `${code}: test-spawn sentinel must remain untouched`);
}

function supportCommandResults() {
  return [
    { argv: ["node", "--test", "tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs"], status: 0, ok: true, stdoutSha256: digest("0"), stderrSha256: digest("1") },
    { argv: ["node", "scripts/run-governance-tests.mjs"], status: 0, ok: true, stdoutSha256: digest("2"), stderrSha256: digest("3") },
    { argv: ["npm", "test"], status: 0, ok: true, stdoutSha256: digest("4"), stderrSha256: digest("5") },
  ];
}


test("A191-T01 strict schema route remains additive to frozen v1", async () => {
  const result = run(["scripts/validate-delivery-schemas.mjs"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "validated 5 delivery-evidence schemas\n");
  const v1 = await readFile(join(root, "governance/docs/delivery-evidence/acceptance-matrix-v1.schema.json"));
  assert.equal(sha256(v1), "c52283e1d360491ff67f90d1801f2f5ee7b98f4df9ff6e4c8c9f8dd3d94c0021");
});

test("A191-T02 version dispatch accepts only exact pairs and fixed argv", () => {
  assert.equal(classifyAcceptanceVersionPair(
    Buffer.from('{"schema_version":"acceptance-matrix/v1"}'),
    Buffer.from('{"schema_version":"acceptance-manifest/v1"}'),
  ), "v1/v1");
  assert.equal(classifyAcceptanceVersionPair(
    Buffer.from('{"schema_version":"acceptance-matrix/v2"}'),
    Buffer.from('{"schema_version":"implementation-plan-manifest/v2"}'),
  ), "v2/v2");
  assert.equal(classifyAcceptanceVersionPair(
    Buffer.from('{"schema_version":"acceptance-matrix/v1"}'),
    Buffer.from('{"schema_version":"implementation-plan-manifest/v2"}'),
  ), "version_pair_mixed");
  assert.throws(() => parseTrustedDeliveryArgs(["--mode", "support", "--candidate-root", root, "--json", "--unknown", "x"]), /usage_invalid/);
  const parsed = parseTrustedDeliveryArgs(["--mode", "support", "--candidate-root", root, "--trusted-base", SLICE1B_SHA, "--expected-head", SLICE1B_SHA, "--json"]);
  assert.equal(parsed.mode, "support");
});

test("A191-T03 predecessor inventory is the exact ten-path ordered set", async () => {
  assert.equal(SUPPORT_PREDECESSOR_PATHS.length, 10);
  assert.deepEqual(SUPPORT_PREDECESSOR_PATHS, [
    TRUSTED_DELIVERY_PATHS.matrixSchema,
    TRUSTED_DELIVERY_PATHS.acceptanceGo,
    TRUSTED_DELIVERY_PATHS.acceptanceWire,
    TRUSTED_DELIVERY_PATHS.posixRoot,
    TRUSTED_DELIVERY_PATHS.windowsRoot,
    TRUSTED_DELIVERY_PATHS.validatorMain,
    "scripts/validate-delivery-schemas.mjs",
    "governance/pkg/deliveryevidence/validator_test.go",
    "tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json",
    "tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md",
  ]);
  assert.deepEqual(SUPPORT_CURRENT_PATHS, [
    { path: "scripts/trusted-delivery-evidence-controller.mjs", status: "added" },
    { path: "scripts/trusted-delivery-evidence-controller-core.mjs", status: "added" },
    { path: "tests/delivery-acceptance-v2.test.mjs", status: "added" },
    { path: "tests/delivery-acceptance.test.mjs", status: "modified" },
    { path: "package.json", status: "modified" },
  ]);
  const manifest = JSON.parse(await readFile(join(root, "tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json"), "utf8"));
  assert.equal(manifest.schema_version, "implementation-plan-manifest/v2");
  assert.deepEqual(manifest.rows.map(({ id }) => id), Array.from({ length: 12 }, (_, index) => `AIDEV-187-${index + 1}`));
});

test("A191-T04 trusted blobs and the core boundary are fixed", async () => {
  const profile = readTrustedBlob(root, SLICE1B_SHA, TRUSTED_DELIVERY_PATHS.profile);
  assert.equal(profile.mode, "100644");
  assert.equal(profile.type, "blob");
  assert.equal(profile.sha256, sha256(profile.bytes));
  assert.throws(() => readTrustedBlob(root, SLICE1B_SHA, "profiles/../profiles/pi-sampler.json"), /trusted_blob_invalid/);
  const core = await readFile(join(root, "scripts/trusted-delivery-evidence-controller-core.mjs"), "utf8");
  assert.doesNotMatch(core, /process\.argv/);
  assert.doesNotMatch(core, /function\s+main\s*\(/);
  const entry = await readFile(join(root, "scripts/trusted-delivery-evidence-controller.mjs"), "utf8");
  assert.doesNotMatch(entry, /from\s+["']\.\/trusted-delivery-evidence-controller-core/);
});

test("A191-T05 facts preserve order, Unicode, and domain separation", () => {
  const matrix = {
    repository: "Zkrausman/pi-sampler", ticket_id: "AIDEV-201", ticket_revision: "a".repeat(64),
    profile_path: "profiles/pi-sampler.json", profile_sha256: "b".repeat(64), base_sha: SLICE1B_SHA, head_sha: "c".repeat(40),
    pull_request_number: 201, plan_path: "docs/plan.md", plan_sha256: "d".repeat(64), manifest_path: "docs/manifest.json",
    manifest_sha256: "e".repeat(64), manifest_schema_version: "implementation-plan-manifest/v2", manifest_contract_sha256: "f".repeat(64),
    manifest_validator_sha256: "0".repeat(64), matrix_contract_sha256: "1".repeat(64), policy_sha256: "b".repeat(64),
    evaluation_scope: "plan-publication", rows: [{ id: "A191-T01", acceptance_class: "ordinary", requirement: "literal \u2028 and literal \\u2028" }],
  };
  const facts = buildNormalizedFacts(matrix);
  assert.deepEqual(Object.keys(facts.facts), [
    "format", "version", "repository", "ticketId", "ticketRevision", "profilePath", "profileSha256", "baseSha", "headSha",
    "pullRequestNumber", "planPath", "planSha256", "manifestPath", "manifestSha256", "manifestSchemaVersion", "manifestContractSha256",
    "manifestValidatorSha256", "matrixContractSha256", "policySha256", "evaluationScope", "rows",
  ]);
  assert.match(facts.bytes.toString("utf8"), /literal \u2028/);
  assert.match(facts.bytes.toString("utf8"), /literal \\\\u2028/);
  assert.equal(facts.factsSha256, sha256Bytes(Buffer.concat([Buffer.from("pi-sampler.delivery-normalized-facts/v1\0"), facts.bytes])));
});

test("A191-T06 support is functional-only and never authority", () => {
  assert.equal(DELIVERY_V2_SUPPORT_AUTHORITY, "functional-only");
  assert.equal(DELIVERY_V2_SUPPORT_CAN_GRANT_AUTHORITY, false);
  const report = buildSupportReport(SLICE1B_SHA, SLICE1B_SHA, [], { partition: { predecessor: [], current: [] } });
  assert.equal(report.status, "functional-only");
  assert.equal(report.authority, false);
});

test("support inventory mutations fail closed before candidate import or test spawn", async () => {
  await assertInventoryFailure((inventory) => { inventory.paths[0].status = "modified"; }, "candidate_not_clean");
  await assertInventoryFailure((inventory) => { inventory.paths.splice(0, 1); }, "candidate_blob_invalid");
  await assertInventoryFailure((inventory) => { inventory.paths[0].base_object_id = "not-a-git-object"; }, "candidate_blob_invalid");
  await assertInventoryFailure((inventory) => { inventory.paths[0].sha256 = digest("9"); }, "candidate_blob_invalid");
  await assertInventoryFailure((inventory) => { inventory.paths[0].mode = "100755"; }, "candidate_blob_invalid");
  await assertInventoryFailure((inventory) => { inventory.paths[0].type = "tree"; }, "candidate_blob_invalid");
  await assertInventoryFailure((inventory) => { inventory.status.records.push({ path: "extra.txt", kind: "untracked", xy: "??" }); }, "candidate_not_clean");
  await assertInventoryFailure((inventory) => { inventory.status.records[0] = { ...inventory.status.records[0], kind: "ordinary", xy: ".M" }; }, "candidate_not_clean");
  await assertInventoryFailure((inventory) => { inventory.paths[10].path = inventory.paths[0].path; }, "candidate_blob_invalid");
});

test("support inventory selectors and ordering remain fixed", async () => {
  assert.equal(Object.isFrozen(SUPPORT_CURRENT_PATHS), true);
  assert.equal(Object.isFrozen(SUPPORT_CURRENT_PATHS[0]), true);
  assert.throws(() => { SUPPORT_CURRENT_PATHS[0].status = "modified"; }, TypeError);
  const before = supportInventoryFixture();
  [before.partition.predecessor[0], before.partition.predecessor[1]] = [before.partition.predecessor[1], before.partition.predecessor[0]];
  let observedInput;
  const { dependencies, calls } = mockedSupportDependencies(before);
  dependencies.freezeInventory = (input) => {
    observedInput = input;
    return structuredClone(before);
  };
  await assert.rejects(() => runSupportForTest(supportOptions(), dependencies), /candidate_blob_invalid/);
  assert.deepEqual(Object.keys(observedInput).sort(), ["base", "head", "repo"]);
  assert.equal(calls.imports, 0);
  assert.equal(calls.spawns, 0);
  assert.throws(() => parseTrustedDeliveryArgs(["--mode", "support", "--candidate-root", root, "--predecessor-paths", "other", "--json"]), /usage_invalid/);
  assert.throws(() => parseTrustedDeliveryArgs(["--mode", "support", "--candidate-root", root, "--current-paths", "other", "--json"]), /usage_invalid/);
});

test("support detects a post-freeze inventory mutation after commands", async () => {
  const before = supportInventoryFixture();
  const after = structuredClone(before);
  after.paths.at(-1).sha256 = digest("9");
  after.paths[0].base_object_id = "3".repeat(40);
  const { dependencies, calls } = mockedSupportDependencies(before, after);
  await assert.rejects(() => runSupportForTest(supportOptions(), dependencies), /candidate_inventory_changed/);
  assert.equal(calls.freezes, 2);
  assert.equal(calls.imports, 1);
  assert.equal(calls.spawns, 1);
});

test("support freezes inventory bytes before candidate execution", async () => {
  const before = supportInventoryFixture();
  const { dependencies, calls } = mockedSupportDependencies(before);
  let mutationBlocked = false;
  dependencies.runCommands = ({ before: frozen, commands }) => {
    assert.equal(Object.isFrozen(frozen), true);
    assert.equal(Object.isFrozen(frozen.paths), true);
    assert.throws(() => { frozen.paths[0].sha256 = digest("9"); }, TypeError);
    mutationBlocked = true;
    calls.spawns += 1;
    return fakeSupportCommands({ commands });
  };
  const report = await runSupportForTest(supportOptions(), dependencies);
  assert.equal(report.authority, false);
  assert.equal(mutationBlocked, true);
  assert.equal(calls.imports, 1);
  assert.equal(calls.spawns, 1);
});

test("A191-T07 fixed path validation rejects unsafe aliases", () => {
  for (const value of ["../secret", "dir\\file", "/absolute", "dir//file", "dir:colon", "dir/report."]) {
    assert.throws(() => readTrustedBlob(root, SLICE1B_SHA, value), /trusted_blob_invalid/);
  }
});

test("A191-T08 activation declarations remain absent", async () => {
  await assert.rejects(access(join(root, "contracts/delivery-acceptance-v2-activation.json")), { code: "ENOENT" });
  await assert.rejects(access(join(root, "contracts/delivery-acceptance-v2-trusted-map.json")), { code: "ENOENT" });
});

test("A191-T09 support freezes before importing core or spawning tests", async () => {
  let called = false;
  await assert.rejects(
    () => supportReport({ trustedBase: PLAN_AMENDMENT_4_SHA }, {
      gitIdentity: () => ({ head: SLICE1B_SHA }),
      runCommands: () => { called = true; return []; },
    }),
    /trusted_base_invalid/,
  );
  assert.equal(called, false);
  await assert.rejects(
    () => supportReport({ expectedHead: SLICE1A_SHA }, { runCommands: () => { called = true; return []; } }),
    /candidate_head_mismatch/,
  );
  assert.equal(called, false);
  const report = buildSupportReport(SLICE1B_SHA, SLICE1B_SHA, [], { paths: [] });
  assert.equal(report.base_sha, SLICE1B_SHA);
  assert.equal(report.head_sha, SLICE1B_SHA);
});

test("A191-T10 compatibility fixtures remain source bytes, not admission", async () => {
  const plan = await readFile(join(root, "tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md"));
  assert.equal(sha256(plan), "e88bafec7997fa247e56451dc72fd49007e9ac1128679d9ee21a6cc061848744");
  assert.equal(SLICE1B_SHA, "cd1eb4581eac403c2e0f3eaec6b0607c6853af6a");
});

test("A191-T11 fixed Git selection is deterministic", () => {
  const git = locateFixedGit();
  assert.equal(typeof git, "string");
  assert.throws(() => locateFixedGit("win32", {
    lstatSync: (value) => ({ isFile: () => value.endsWith("git.exe"), isSymbolicLink: () => false }),
    realpathSync: () => { throw new Error("redirected"); },
  }), /test_failed/);
});

test("A191-T12 trusted lifecycle blob map", () => {
  const commands = supportCommandResults();
  const before = supportInventoryFixture();
  const after = structuredClone(before);
  validateSupportInventory(before, SLICE1B_SHA, SLICE1B_SHA);
  validateSupportInventory(after, SLICE1B_SHA, SLICE1B_SHA);
  const report = buildSupportReport(SLICE1B_SHA, SLICE1B_SHA, commands, before, after);
  assert.deepEqual(Object.keys(report), [
    "format", "version", "status", "authority", "base_sha", "head_sha", "paths", "test_report_sha256", "repository_inventory_sha256",
  ]);
  assert.equal(report.format, "pi-sampler.delivery-v2-support-report");
  assert.equal(report.version, 1);
  assert.equal(report.status, "functional-only");
  assert.equal(report.authority, false);
  assert.equal(report.base_sha, SLICE1B_SHA);
  assert.equal(report.head_sha, SLICE1B_SHA);
  assert.deepEqual(report.paths, SUPPORT_OPERATIONAL_PATHS);
  assert.equal(report.paths.length, 6);
  assert.equal(SUPPORT_CURRENT_PATHS.length, 5);
  assert.equal(SUPPORT_PREDECESSOR_PATHS.length + SUPPORT_CURRENT_PATHS.length, 15);
  assert.deepEqual(before.partition.predecessor, SUPPORT_PREDECESSOR_PATHS);
  assert.deepEqual(before.partition.current, SUPPORT_CURRENT_PATHS);
  assert.equal(before.paths.length, 15);
  assert.equal(after.paths.length, 15);
  assert.equal(new Set(before.paths.slice(0, 10).map(({ base_object_id }) => base_object_id)).size, 10);
  assert.equal(before.paths.slice(0, 10).every(({ mode, type }) => mode === "100644" && type === "blob"), true);
  assert.deepEqual(commands.map(({ argv }) => argv), [
    ["node", "--test", "tests/delivery-acceptance.test.mjs", "tests/delivery-acceptance-v2.test.mjs"],
    ["node", "scripts/run-governance-tests.mjs"],
    ["npm", "test"],
  ]);
  const testPreimage = { format: "pi-sampler.delivery-v2-support-tests", version: 1, commands };
  const inventoryPreimage = { before, after };
  assert.equal(report.test_report_sha256, sha256Bytes(Buffer.from(`${canonicalJSONString(testPreimage)}\n`)));
  assert.equal(report.repository_inventory_sha256, sha256Bytes(Buffer.from(`${canonicalJSONString(inventoryPreimage)}\n`)));
  assert.notEqual(report.test_report_sha256, buildSupportReport(SLICE1B_SHA, SLICE1B_SHA, commands.map((command) => ({ ...command, status: 1 })), before, after).test_report_sha256);
  const changedAfter = structuredClone(after);
  changedAfter.paths[0].sha256 = digest("9");
  assert.notEqual(report.repository_inventory_sha256, buildSupportReport(SLICE1B_SHA, SLICE1B_SHA, commands, before, changedAfter).repository_inventory_sha256);
  assert.equal("lease" in report, false);
});
