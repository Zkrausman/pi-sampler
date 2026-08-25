import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Compile } from "typebox/compile";
import {
  IMPLEMENTATION_PLAN_MANIFEST_V2_LIMITS as L,
  IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_ID,
  IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_VERSION,
  ImplementationPlanManifestV2Schema,
  validateImplementationPlanManifestV2,
} from "../contracts/implementation-plan-manifest-v2.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = join(root, "contracts", "implementation-plan-manifest-v2.schema.json");
const v1Path = join(root, "docs", "techPlans", "AIDEV-182-acceptance-manifest-v1.json");
const digest = "a".repeat(64);
const revision = "b".repeat(40);
const long = (length) => "a".repeat(length);
const generated = JSON.parse(await readFile(schemaPath, "utf8"));
const generatedValidator = Compile(generated);
const runtimeValidator = Compile(ImplementationPlanManifestV2Schema);

function manifest(overrides = {}) {
  const base = {
    schema_version: IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_VERSION,
    ticket_id: "AIDEV-182",
    repository: "Zkrausman/pi-sampler",
    plan_path: "docs/techPlans/AIDEV-182-implementation-plan.md",
    plan_sha256: digest,
    base_sha: revision,
    ticket_revision: "c".repeat(64),
    epic: { kind: "standalone" },
    hard_dependencies: [],
    predecessor_outputs: [],
    soft_dependencies: [],
    rows: [{ id: "A182-T05", title: "Manifest v2 contract", acceptance_class: "ordinary", requirement: "The runtime and generated contract agree." }],
    portfolio: {
      planning_effort: "medium",
      implementation_size: "large",
      requirement_readiness: "ready",
      information_gain: "high",
      downstream_unblock_set: [],
      affected_contracts: ["implementation-plan-manifest/v2"],
      affected_packages: ["pi-sampler"],
      conflict_surface: "low",
      staleness_horizon_days: 30,
      risk_reduction_value: "high",
      unresolved_human_decisions: [],
    },
    ownership: {
      files: ["contracts/implementation-plan-manifest-v2.mjs"],
      symbols: ["ImplementationPlanManifestV2Schema"],
      contracts: ["implementation-plan-manifest/v2"],
    },
    compatibility: {
      assumptions: ["Historical v1 artifacts remain readable."],
      preserves_v1_readability: true,
      silently_upgrades_v1: false,
    },
    staleness: {
      triggers: [{ kind: "predecessor_output_changed", input: "AIDEV-181", action: "manual_refresh" }],
      descendant_base_campaign_drift_is_not_plan_staleness: true,
    },
    just_in_time_revalidation: {
      inputs: [{ kind: "repository_revision", name: "base_sha", expected: revision }],
      required_before: "implementation",
    },
  };
  return {
    ...base,
    ...overrides,
    epic: { ...base.epic, ...overrides.epic },
    portfolio: { ...base.portfolio, ...overrides.portfolio },
    ownership: { ...base.ownership, ...overrides.ownership },
    compatibility: { ...base.compatibility, ...overrides.compatibility },
    staleness: { ...base.staleness, ...overrides.staleness },
    just_in_time_revalidation: { ...base.just_in_time_revalidation, ...overrides.just_in_time_revalidation },
  };
}

function runtimeOk(value) { return runtimeValidator.Check(value); }
function generatedOk(value) { return generatedValidator.Check(value); }
function bothOk(value, expected = true) {
  assert.equal(runtimeOk(value), expected);
  assert.equal(generatedOk(value), expected);
  assert.equal(validateImplementationPlanManifestV2(value).ok, expected);
}
function repeated(value, count) { return Array.from({ length: count }, () => structuredClone(value)); }
function over(value, path, replacement) {
  const result = structuredClone(value);
  let target = result;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = replacement;
  return result;
}

function hardDependency() {
  return { ticket_id: "AIDEV-181", reason: "The predecessor contract is required.", required_outputs: ["contract-v1"], requirement_ids: ["A182-T03"] };
}
function predecessorOutput() {
  return { ticket_id: "AIDEV-181", output_id: "contract-v1", contract: "ticket-episode/v1", expected_digest: digest, expected_revision: revision };
}
function softDependency() {
  return { ticket_id: "AIDEV-180", evidence: [{ kind: "repository", source: "approved-plan", summary: "A bounded proposed relation." }], confidence: "medium" };
}

 test("accepts an ordinary ticket manifest and an epic-member manifest", () => {
  bothOk(manifest());
  bothOk(manifest({
    epic: { kind: "member", epic_id: "AIDEV-100", title: "Umbrella planning", member_count: 3 },
    portfolio: { ...manifest().portfolio, downstream_unblock_set: ["AIDEV-183"] },
  }));
});

test("accepts hard dependencies, predecessor outputs, soft evidence, acceptance, portfolio, ownership, and revalidation metadata", () => {
  const value = manifest({
    hard_dependencies: [hardDependency()],
    predecessor_outputs: [predecessorOutput()],
    soft_dependencies: [softDependency()],
    rows: [
      { id: "A182-T05", title: "Contract", acceptance_class: "ordinary", requirement: "Contract foundation." },
      { id: "A182-T08", title: "Portfolio", acceptance_class: "requirement", requirement: "Bounded metadata." },
    ],
    portfolio: {
      ...manifest().portfolio,
      unresolved_human_decisions: [{ id: "decision-1", question: "Which later validator policy is approved?", blocking: true }],
    },
    ownership: {
      files: ["contracts/implementation-plan-manifest-v2.mjs", "scripts/export-implementation-plan-manifest-v2-schema.mjs"],
      symbols: ["validateImplementationPlanManifestV2"],
      contracts: ["implementation-plan-manifest/v2"],
    },
    compatibility: { assumptions: ["v1 is read-only historical input."], preserves_v1_readability: true, silently_upgrades_v1: false },
    staleness: {
      triggers: [
        { kind: "plan_changed", input: "plan_sha256", action: "renew_approval" },
        { kind: "contract_changed", input: "implementation-plan-manifest/v2", action: "revalidate" },
      ],
      descendant_base_campaign_drift_is_not_plan_staleness: true,
    },
    just_in_time_revalidation: {
      inputs: [
        { kind: "ticket_revision", name: "ticket_revision", expected: revision },
        { kind: "predecessor_output", name: "contract-v1", expected: digest },
        { kind: "contract_digest", name: "implementation-plan-manifest/v2", expected: digest },
      ],
      required_before: "validation",
    },
  });
  bothOk(value);
  assert.equal(value.hard_dependencies[0].ticket_id, "AIDEV-181");
  assert.equal(value.soft_dependencies[0].confidence, "medium");
  assert.equal(value.hard_dependencies[0].required_outputs.includes("contract-v1"), true);
});

test("rejects unknown properties recursively, missing required fields, and invalid enums/types", () => {
  bothOk({ ...manifest(), unknown: true }, false);
  bothOk(over(manifest(), ["portfolio", "unknown"], true), false);
  bothOk(over(manifest(), ["hard_dependencies"], [{ ...hardDependency(), unknown: true }]), false);
  const missing = structuredClone(manifest());
  delete missing.ticket_revision;
  bothOk(missing, false);
  bothOk(over(manifest(), ["portfolio", "implementation_size"], "huge"), false);
  bothOk(over(manifest(), ["compatibility", "silently_upgrades_v1"], true), false);
  bothOk(over(manifest(), ["portfolio", "staleness_horizon_days"], "30"), false);
});

test("rejects malformed identities, digests, revisions, repositories, and unsafe paths", () => {
  for (const [path, value] of [
    [["ticket_id"], "AIDEV"],
    [["plan_sha256"], "A".repeat(64)],
    [["base_sha"], "g".repeat(40)],
    [["ticket_revision"], "b".repeat(39)],
    [["repository"], "owner/no space"],
    [["plan_path"], "/absolute/file.md"],
    [["plan_path"], "C:/drive/file.md"],
    [["plan_path"], "docs\\file.md"],
    [["plan_path"], "docs/../file.md"],
    [["plan_path"], "docs/%2e%2e/file.md"],
    [["ownership", "files"], ["docs//file.md"]],
  ]) bothOk(over(manifest(), path, value), false);
});

test("enforces centralized string, array, and numeric boundaries", () => {
  const stringBoundaries = [
    [["ticket_id"], "A".repeat(L.maxTicketIdLength - 2) + "-1", L.maxTicketIdLength],
    [["repository"], "o".repeat(127) + "/" + "r".repeat(128), L.maxRepositoryLength],
    [["plan_path"], "a".repeat(L.maxPathLength - 3) + ".md", L.maxPathLength],
    [["ownership", "symbols", 0], long(L.maxIdentifierLength), L.maxIdentifierLength],
    [["base_sha"], "a".repeat(L.maxRevisionLength), L.maxRevisionLength],
    [["plan_sha256"], "a".repeat(L.maxDigestLength), L.maxDigestLength],
    [["rows", 0, "title"], long(L.maxTitleLength), L.maxTitleLength],
    [["rows", 0, "requirement"], long(L.maxTextLength), L.maxTextLength],
    [["portfolio", "unresolved_human_decisions", 0, "question"], long(L.maxQuestionLength), L.maxQuestionLength],
    [["soft_dependencies", 0, "evidence", 0, "source"], long(L.maxEvidenceTextLength), L.maxEvidenceTextLength],
    [["just_in_time_revalidation", "inputs", 0, "expected"], long(L.maxShortTextLength), L.maxShortTextLength],
  ];
  for (const [path, value] of stringBoundaries) {
    let base = manifest();
    if (path[0] === "portfolio") base = manifest({ portfolio: { ...base.portfolio, unresolved_human_decisions: [{ id: "decision", question: "question", blocking: false }] } });
    if (path[0] === "soft_dependencies") base = manifest({ soft_dependencies: [softDependency()] });
    bothOk(over(base, path, value));
    bothOk(over(base, path, value + "a".repeat(L.maxTextLength + 1)), false);
  }

  const arrayBoundaries = [
    ["rows", L.maxRows, { id: "A182-T05", title: "r", acceptance_class: "ordinary", requirement: "r" }],
    ["hard_dependencies", L.maxHardDependencies, hardDependency()],
    ["predecessor_outputs", L.maxPredecessorOutputs, predecessorOutput()],
    ["soft_dependencies", L.maxSoftDependencies, softDependency()],
    ["portfolio.downstream_unblock_set", L.maxDownstreamUnblockSet, "AIDEV-1"],
    ["portfolio.affected_contracts", L.maxAffectedContracts, "contract"],
    ["portfolio.affected_packages", L.maxAffectedPackages, "package"],
    ["ownership.files", L.maxOwnedFiles, "a/file.mjs"],
    ["ownership.symbols", L.maxOwnedSymbols, "symbol"],
    ["ownership.contracts", L.maxOwnedContracts, "contract"],
    ["compatibility.assumptions", L.maxCompatibilityAssumptions, "assumption"],
    ["staleness.triggers", L.maxStalenessTriggers, { kind: "plan_changed", input: "plan_sha256", action: "revalidate" }],
    ["just_in_time_revalidation.inputs", L.maxRevalidationInputs, { kind: "plan_digest", name: "plan_sha256", expected: digest }],
    ["portfolio.unresolved_human_decisions", L.maxUnresolvedDecisions, { id: "decision", question: "question", blocking: false }],
  ];
  for (const [key, max, item] of arrayBoundaries) {
    const path = key.split(".");
    const atMax = over(manifest(), path, repeated(item, max));
    bothOk(atMax);
    bothOk(over(manifest(), path, repeated(item, max + 1)), false);
  }
  bothOk(over(manifest({ hard_dependencies: [hardDependency()] }), ["hard_dependencies", 0, "required_outputs"], repeated("output", L.maxRequiredOutputs)));
  bothOk(over(manifest({ hard_dependencies: [hardDependency()] }), ["hard_dependencies", 0, "requirement_ids"], repeated("A182-T1", L.maxRequirementIds)));
  bothOk(over(manifest(), ["soft_dependencies"], [softDependency()]), true);
  bothOk(over(manifest({ soft_dependencies: [softDependency()] }), ["soft_dependencies", 0, "evidence"], repeated({ kind: "k", source: "s", summary: "e" }, L.maxSoftEvidence)));
  bothOk(over(manifest({ soft_dependencies: [softDependency()] }), ["soft_dependencies", 0, "evidence"], repeated({ kind: "k", source: "s", summary: "e" }, L.maxSoftEvidence + 1)), false);
  for (const [path, replacement] of [
    [["rows"], []],
    [["ownership", "files"], []],
    [["soft_dependencies", 0, "evidence"], []],
    [["staleness", "triggers"], []],
    [["just_in_time_revalidation", "inputs"], []],
  ]) {
    let base = manifest();
    if (path[0] === "soft_dependencies") base = manifest({ soft_dependencies: [softDependency()] });
    if (path[0] === "staleness") base = manifest({ staleness: { ...base.staleness, triggers: [{ kind: "plan_changed", input: "plan_sha256", action: "revalidate" }] } });
    if (path[0] === "just_in_time_revalidation") base = manifest({ just_in_time_revalidation: { ...base.just_in_time_revalidation, inputs: [{ kind: "plan_digest", name: "plan_sha256", expected: digest }] } });
    bothOk(over(base, path, replacement), false);
  }

  bothOk(over(manifest(), ["portfolio", "staleness_horizon_days"], L.minHorizonDays));
  bothOk(over(manifest(), ["portfolio", "staleness_horizon_days"], L.minHorizonDays - 1), false);
  bothOk(over(manifest(), ["portfolio", "staleness_horizon_days"], L.maxHorizonDays));
  bothOk(over(manifest(), ["portfolio", "staleness_horizon_days"], L.maxHorizonDays + 1), false);
  bothOk(over(manifest(), ["epic", "member_count"], 0));
  bothOk(over(manifest({ epic: { kind: "member" } }), ["epic", "member_count"], L.maxDownstreamUnblockSet));
  bothOk(over(manifest({ epic: { kind: "member" } }), ["epic", "member_count"], L.maxDownstreamUnblockSet + 1), false);
});

test("exporter is deterministic, bounded, and has stable check mode", async () => {
  const command = spawnSync(process.execPath, ["scripts/export-implementation-plan-manifest-v2-schema.mjs", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  assert.equal(generated.$id, IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_ID);
  assert.deepEqual(generated, ImplementationPlanManifestV2Schema);
  const original = await readFile(schemaPath, "utf8");
  const fixtureRoot = await mkdtemp(join(root, ".implementation-plan-manifest-v2-exporter-"));
  const fixtureSchemaPath = join(fixtureRoot, "contracts", "implementation-plan-manifest-v2.schema.json");
  try {
    await mkdir(join(fixtureRoot, "contracts"), { recursive: true });
    await mkdir(join(fixtureRoot, "scripts"), { recursive: true });
    await copyFile(join(root, "contracts", "implementation-plan-manifest-v2.mjs"), join(fixtureRoot, "contracts", "implementation-plan-manifest-v2.mjs"));
    await copyFile(join(root, "scripts", "export-implementation-plan-manifest-v2-schema.mjs"), join(fixtureRoot, "scripts", "export-implementation-plan-manifest-v2-schema.mjs"));

    const staleFixture = `${original}stale\n`;
    await writeFile(fixtureSchemaPath, staleFixture, "utf8");
    const stale = spawnSync(process.execPath, ["scripts/export-implementation-plan-manifest-v2-schema.mjs", "--check"], { cwd: fixtureRoot, encoding: "utf8" });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /stale/);
    assert.equal(await readFile(fixtureSchemaPath, "utf8"), staleFixture);

    const crlfFixture = original.replace(/\n/g, "\r\n");
    assert.notEqual(crlfFixture, original);
    await writeFile(fixtureSchemaPath, crlfFixture, "utf8");
    const crlf = spawnSync(process.execPath, ["scripts/export-implementation-plan-manifest-v2-schema.mjs", "--check"], { cwd: fixtureRoot, encoding: "utf8" });
    assert.notEqual(crlf.status, 0);
    assert.match(crlf.stderr, /stale/);
    assert.equal(await readFile(fixtureSchemaPath, "utf8"), crlfFixture);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  assert.equal(await readFile(schemaPath, "utf8"), original);
  const unsupported = spawnSync(process.execPath, ["scripts/export-implementation-plan-manifest-v2-schema.mjs", "--check", "--output", "x"], { cwd: root, encoding: "utf8" });
  assert.notEqual(unsupported.status, 0);
});

test("generated JSON Schema and runtime TypeBox schema have exact structural parity", () => {
  assert.equal(JSON.stringify(generated), JSON.stringify(ImplementationPlanManifestV2Schema));
  assert.deepEqual(generated.required, ["schema_version", "ticket_id", "repository", "plan_path", "plan_sha256", "base_sha", "ticket_revision", "epic", "hard_dependencies", "predecessor_outputs", "soft_dependencies", "rows", "portfolio", "ownership", "compatibility", "staleness", "just_in_time_revalidation"]);
  assert.equal(generated.additionalProperties, false);
  assert.equal(generated.properties.plan_sha256.pattern, "^[a-f0-9]{64}$");
  assert.equal(generated.properties.plan_path.pattern.includes("\\\\"), true);
  assert.equal(generated.properties.rows.maxItems, L.maxRows);
  assert.equal(generated.properties.portfolio.properties.staleness_horizon_days.minimum, L.minHorizonDays);
  assert.equal(generated.properties.portfolio.properties.staleness_horizon_days.maximum, L.maxHorizonDays);
  for (const nested of [generated.properties.epic, generated.properties.portfolio, generated.properties.ownership, generated.properties.compatibility, generated.properties.staleness, generated.properties.just_in_time_revalidation]) assert.equal(nested.additionalProperties, false);
});

test("v1 remains distinct and readable; v2 grants no lifecycle authority or default activation", async () => {
  const before = await readFile(v1Path, "utf8");
  const v1 = JSON.parse(before);
  assert.equal(v1.schema_version, "acceptance-manifest/v1");
  assert.notEqual(v1.schema_version, IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_VERSION);
  bothOk(v1, false);
  const after = await readFile(v1Path, "utf8");
  assert.equal(after, before);
  const rootKeys = Object.keys(generated.properties);
  for (const prohibited of ["default", "activate", "priority", "schedule", "publish", "merge", "tracker"]) assert.equal(rootKeys.includes(prohibited), false);
  assert.equal(generated.properties.compatibility.properties.silently_upgrades_v1.const, false);
  assert.equal(generated.properties.staleness.properties.descendant_base_campaign_drift_is_not_plan_staleness.const, true);
});
