import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  IMPLEMENTATION_PLAN_VALIDATOR_DIAGNOSTIC_CODES,
  IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS,
  IMPLEMENTATION_PLAN_VALIDATOR_LIMITS,
  isSafeImplementationPlanPath,
  parseImplementationPlanValidatorArgs,
  parseStrictBoundedJson,
  resolveTrustedGitExecutable,
  resolveTrustedGitExecutableFromFixedCandidates,
  safeReadCandidateFile,
  trustedGitCandidatePaths,
} from "../scripts/validate-implementation-plan.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts", "validate-implementation-plan.mjs");
const fixtures = join(root, "tests", "fixtures", "implementation-plan-validator");
const validPlan = "tests/fixtures/implementation-plan-validator/valid-plan.md";
const validManifest = "tests/fixtures/implementation-plan-validator/valid-manifest-v2.json";
const base = "6393664dae343b8e655bbf0e4a36704cfbd3164c";
const ticketRevision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const repository = "Zkrausman/pi-sampler";
const profile = "profiles/pi-sampler.json";
const validManifestValue = JSON.parse(await readFile(join(root, validManifest), "utf8"));
const validPlanBytes = await readFile(join(root, validPlan));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cliArgs(overrides = {}) {
  const values = {
    plan: validPlan,
    manifest: validManifest,
    base,
    profile,
    repository,
    ticket: "AIDEV-182",
    ticketRevision,
    ...overrides,
  };
  return [
    "--plan", values.plan,
    "--manifest", values.manifest,
    "--base", values.base,
    "--profile", values.profile,
    "--repository", values.repository,
    "--ticket", values.ticket,
    "--ticket-revision", values.ticketRevision,
    "--json",
  ];
}

function runValidator(overrides = {}, options = {}) {
  const result = spawnSync(process.execPath, [script, ...cliArgs(overrides)], {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  let output;
  if (result.stdout && result.stdout.trim()) output = JSON.parse(result.stdout);
  return { ...result, output };
}

async function withRootTemp(callback) {
  const directory = await mkdtemp(join(root, "tests", "validator-temp-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeCandidate(directory, manifestOverrides = {}, plan = validPlanBytes, planName = "plan.md", manifestName = "manifest.json") {
  const planPath = `tests/${relative(join(root, "tests"), directory).replaceAll("\\", "/")}/${planName}`;
  const manifestPath = `tests/${relative(join(root, "tests"), directory).replaceAll("\\", "/")}/${manifestName}`;
  await writeFile(join(directory, planName), plan);
  const manifest = structuredClone(validManifestValue);
  manifest.plan_path = planPath;
  manifest.plan_sha256 = sha256(plan);
  Object.assign(manifest, manifestOverrides);
  await writeFile(join(directory, manifestName), `${JSON.stringify(manifest)}\n`, "utf8");
  return { planPath, manifestPath, manifest };
}

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      ...options.env,
    },
  });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function makeGitFixture({ profileMode = "valid", objectFormat = undefined } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "implementation-plan-validator-git-"));
  const profileDirectory = join(directory, "profiles");
  await mkdir(profileDirectory, { recursive: true });
  if (profileMode === "valid") await writeFile(join(profileDirectory, "pi-sampler.json"), await readFile(join(root, profile)), "utf8");
  if (profileMode === "wrong-type") {
    await mkdir(join(profileDirectory, "pi-sampler.json"));
    await writeFile(join(profileDirectory, "pi-sampler.json", "nested.txt"), "tree object\n", "utf8");
  }
  await writeFile(join(directory, "README.md"), "bounded fixture\n", "utf8");
  const initArgs = ["init", "--initial-branch", "main"];
  if (objectFormat) initArgs.push("--object-format", objectFormat);
  runGit(directory, initArgs);
  runGit(directory, ["config", "user.name", "validator-test"]);
  runGit(directory, ["config", "user.email", "validator-test@example.invalid"]);
  runGit(directory, ["add", "."]);
  runGit(directory, ["commit", "-m", "fixture"]);
  const exactBase = runGit(directory, ["rev-parse", "HEAD"]);
  return { directory, exactBase, objectFormat: objectFormat || "sha1" };
}

async function closeGitFixture(fixture) {
  await rm(fixture.directory, { recursive: true, force: true });
}

function codes(result) {
  return new Set(result.output?.diagnostics?.map((entry) => entry.code) || []);
}

function assertCode(result, code) {
  assert.ok(codes(result).has(code), `${code} missing from ${JSON.stringify(result.output?.diagnostics)}`);
}

async function runTempCandidate(directory, overrides = {}, manifestOverrides = {}, plan = validPlanBytes) {
  const candidate = await writeCandidate(directory, manifestOverrides, plan);
  return runValidator({ ...overrides, plan: candidate.planPath, manifest: candidate.manifestPath });
}

test("exports bounded validator limits and rejects unsafe Windows/Linux path identities", async () => {
  assert.ok(IMPLEMENTATION_PLAN_VALIDATOR_LIMITS.maxPlanBytes > 0);
  assert.ok(IMPLEMENTATION_PLAN_VALIDATOR_DIAGNOSTIC_CODES.includes("plan_digest_mismatch"));
  const pathCases = JSON.parse(await readFile(join(fixtures, "path-policy-cases.json"), "utf8"));
  for (const unsafe of pathCases) assert.equal(isSafeImplementationPlanPath(unsafe), false, unsafe);
  for (const safe of ["docs/techPlans/AIDEV-182-implementation-plan.md", "tests/.fixture/file.json", "a/b-c_1.json"]) {
    assert.equal(isSafeImplementationPlanPath(safe), true, safe);
  }
});

test("parses only the exact CLI shape and rejects duplicates, positionals, fallbacks, and abbreviations", () => {
  const parsed = parseImplementationPlanValidatorArgs(cliArgs());
  assert.equal(parsed.plan, validPlan);
  for (const mutation of [
    ["--plan", validPlan, "--plan", validPlan],
    ["--pla", validPlan],
    ["--json", "true"],
    ["--unknown", "value"],
    ["--base", "main"],
  ]) {
    assert.throws(() => parseImplementationPlanValidatorArgs(mutation), /invocation invalid/);
  }
});

test("valid v2 CLI succeeds with one bounded JSON object and deterministic repeated bytes", () => {
  const first = runValidator();
  const second = runValidator();
  assert.equal(first.status, IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.success);
  assert.equal(first.stderr, "");
  assert.equal(first.output.ok, true);
  assert.equal(first.output.summary.input_schema, "implementation-plan-manifest/v2");
  assert.equal(first.output.summary.acceptance_lines, 23);
  assert.deepEqual(first.output, second.output);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.trim().split(/\r?\n/).length, 1);
});

test("v1 AIDEV-182 bootstrap is readable but never silently upgraded", async () => {
  const path = join(root, "docs", "techPlans", "AIDEV-182-acceptance-manifest-v1.json");
  const before = await readFile(path);
  const result = runValidator({ plan: "docs/techPlans/AIDEV-182-implementation-plan.md", manifest: "docs/techPlans/AIDEV-182-acceptance-manifest-v1.json" });
  const after = await readFile(path);
  assert.equal(result.status, IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.validationFailure);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.summary.input_schema, "acceptance-manifest/v1");
  assertCode(result, "legacy_v1_readable");
  assertCode(result, "legacy_v1_semantics_unavailable");
  assertCode(result, "legacy_v1_not_v2");
  assert.deepEqual(after, before);
});

test("strict JSON rejects duplicate keys, trailing data, unsafe object keys, numbers, and bounds", () => {
  assert.throws(() => parseStrictBoundedJson(Buffer.from('{"a":1,"a":2}')), (error) => error?.name === "StrictJsonError");
  assert.throws(() => parseStrictBoundedJson(Buffer.from('{"a":1}\ntrailing')), (error) => error?.code === "json_trailing_data");
  assert.throws(() => parseStrictBoundedJson(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), (error) => error?.code === "file_bom");
  assert.throws(() => parseStrictBoundedJson(Buffer.from([0xff, 0xfe])), (error) => error?.code === "file_invalid_utf8");
  for (const key of ["__proto__", "prototype", "constructor"]) {
    assert.throws(() => parseStrictBoundedJson(Buffer.from(JSON.stringify({ [key]: 1 }))), (error) => error?.code === "json_unsafe_key");
  }
  const values = ["constructor", "prototype", "__proto__", "escaped \\\"text\\\" \\\\ slash\nline", `${String.fromCodePoint(0xfeff)} value`];
  for (const value of values) {
    const parsed = parseStrictBoundedJson(Buffer.from(JSON.stringify({ value }), "utf8")).value;
    assert.equal(parsed.value, value);
  }
  assert.throws(() => parseStrictBoundedJson(Buffer.from("9e999")), (error) => error?.code === "json_unsafe_number");
  const deep = Buffer.from(`${"[".repeat(IMPLEMENTATION_PLAN_VALIDATOR_LIMITS.maxJsonDepth + 2)}0${"]".repeat(IMPLEMENTATION_PLAN_VALIDATOR_LIMITS.maxJsonDepth + 2)}`);
  assert.throws(() => parseStrictBoundedJson(deep), (error) => error?.code === "json_bounds");
  const duplicate = runValidator({ manifest: "tests/fixtures/implementation-plan-validator/malformed-duplicate-key.json" });
  const trailing = runValidator({ manifest: "tests/fixtures/implementation-plan-validator/malformed-trailing.json" });
  assertCode(duplicate, "json_duplicate_key");
  assertCode(trailing, "json_trailing_data");
});

test("valid Manifest-v2 string values retain structural parity with strict JSON", async () => {
  await withRootTemp(async (directory) => {
    for (const [index, value] of ["constructor", "prototype", "__proto__", "escaped \\\"text\\\" \\\\ slash\nline", `${String.fromCodePoint(0xfeff)} value`].entries()) {
      const result = await runTempCandidate(directory, {}, {
        compatibility: { ...validManifestValue.compatibility, assumptions: [value] },
      }, validPlanBytes);
      assert.equal(result.status, IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.success, `${index}: ${JSON.stringify(result.output)}`);
      assert.equal(result.output.ok, true);
    }
  });
});

test("schema, authority, and exact binding diagnostics are bounded and deterministic", async () => {
  const unknown = runValidator({ manifest: "tests/fixtures/implementation-plan-validator/unknown-field.json" });
  assertCode(unknown, "manifest_schema_invalid");
  assertCode(unknown, "manifest_authority_field");
  const mismatch = runValidator({ ticket: "AIDEV-183", ticketRevision: "cccccccccccccccccccccccccccccccccccccccc" });
  assertCode(mismatch, "manifest_binding_mismatch");
  const digest = await withRootTemp(async (directory) => runTempCandidate(directory, {}, { plan_sha256: "e".repeat(64) }));
  assertCode(digest, "plan_digest_mismatch");
});

test("acceptance parity catches missing, extra, duplicate, case-drift, reordered, malformed, and requirement rows", async () => {
  await withRootTemp(async (directory) => {
    const planWithoutFirst = Buffer.from(validPlanBytes.toString("utf8").split("\n").filter((line) => !line.includes("A182-T01:")).join("\n"), "utf8");
    const missing = await runTempCandidate(directory, {}, {}, planWithoutFirst);
    assertCode(missing, "acceptance_id_missing");

    const extraPlan = Buffer.concat([validPlanBytes, Buffer.from("*   [ ] A182-T99: Extra independently authored row.\n")]);
    const extra = await runTempCandidate(directory, {}, {}, extraPlan);
    assertCode(extra, "acceptance_id_extra");

    const duplicatePlan = Buffer.concat([validPlanBytes, Buffer.from("*   [ ] A182-T01: Duplicate independently authored row.\n")]);
    const duplicate = await runTempCandidate(directory, {}, {}, duplicatePlan);
    assertCode(duplicate, "acceptance_id_duplicate");

    const caseManifest = structuredClone(validManifestValue);
    caseManifest.rows[0].id = "a182-T01";
    const caseCandidate = await writeCandidate(directory, {}, validPlanBytes, "case-plan.md", "case-manifest.json");
    caseCandidate.manifest.rows[0].id = "a182-T01";
    await writeFile(join(directory, "case-manifest.json"), `${JSON.stringify(caseCandidate.manifest)}\n`);
    const caseDrift = runValidator({ plan: caseCandidate.planPath, manifest: caseCandidate.manifestPath });
    assertCode(caseDrift, "acceptance_id_case_drift");

    const reordered = structuredClone(validManifestValue);
    [reordered.rows[0], reordered.rows[1]] = [reordered.rows[1], reordered.rows[0]];
    const reorderedCandidate = await writeCandidate(directory, {}, validPlanBytes, "reordered-plan.md", "reordered-manifest.json");
    reorderedCandidate.manifest.rows = reordered.rows;
    await writeFile(join(directory, "reordered-manifest.json"), `${JSON.stringify(reorderedCandidate.manifest)}\n`);
    const order = runValidator({ plan: reorderedCandidate.planPath, manifest: reorderedCandidate.manifestPath });
    assertCode(order, "acceptance_id_order");

    const malformedPlan = Buffer.concat([validPlanBytes, Buffer.from("*   [ ] A182-T98 malformed row\n")]);
    const malformed = await runTempCandidate(directory, {}, {}, malformedPlan);
    assertCode(malformed, "acceptance_line_malformed");

    const requirement = await runTempCandidate(directory, {}, { rows: validManifestValue.rows.map((row, index) => index === 0 ? { ...row, requirement: "different" } : row) });
    assertCode(requirement, "acceptance_requirement_mismatch");
  });
});

test("dependency, readiness, epic, ownership, staleness, and revalidation gaps fail closed", async () => {
  await withRootTemp(async (directory) => {
    const missingOutput = await runTempCandidate(directory, {}, {
      hard_dependencies: [{ ...validManifestValue.hard_dependencies[0], required_outputs: ["missing-output"] }],
    });
    assertCode(missingOutput, "predecessor_output_invalid");

    const revisionOnlyManifest = structuredClone(validManifestValue);
    delete revisionOnlyManifest.predecessor_outputs[0].expected_digest;
    revisionOnlyManifest.just_in_time_revalidation.inputs = revisionOnlyManifest.just_in_time_revalidation.inputs.map((input) => input.kind === "predecessor_output" ? { ...input, expected: revisionOnlyManifest.predecessor_outputs[0].expected_revision } : input);
    const revisionOnly = await runTempCandidate(directory, {}, {
      predecessor_outputs: revisionOnlyManifest.predecessor_outputs,
      just_in_time_revalidation: revisionOnlyManifest.just_in_time_revalidation,
    });
    assert.equal(revisionOnly.status, IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.success, JSON.stringify(revisionOnly.output));

    const missingJit = await runTempCandidate(directory, {}, {
      just_in_time_revalidation: { ...validManifestValue.just_in_time_revalidation, inputs: validManifestValue.just_in_time_revalidation.inputs.filter((input) => input.kind !== "predecessor_output") },
    });
    assertCode(missingJit, "revalidation_invalid");

    const duplicateJit = await runTempCandidate(directory, {}, {
      just_in_time_revalidation: { ...validManifestValue.just_in_time_revalidation, inputs: [...validManifestValue.just_in_time_revalidation.inputs, { kind: "predecessor_output", name: "AIDEV-181/contract-v1", expected: "d".repeat(64) }] },
    });
    assertCode(duplicateJit, "revalidation_invalid");

    const wrongJit = await runTempCandidate(directory, {}, {
      just_in_time_revalidation: { ...validManifestValue.just_in_time_revalidation, inputs: validManifestValue.just_in_time_revalidation.inputs.map((input) => input.kind === "predecessor_output" ? { ...input, expected: "e".repeat(64) } : input) },
    });
    assertCode(wrongJit, "revalidation_invalid");

    const noImmutableExpectation = structuredClone(validManifestValue.predecessor_outputs);
    delete noImmutableExpectation[0].expected_digest;
    delete noImmutableExpectation[0].expected_revision;
    const noImmutable = await runTempCandidate(directory, {}, { predecessor_outputs: noImmutableExpectation });
    assertCode(noImmutable, "revalidation_invalid");

    const unrelatedJit = await runTempCandidate(directory, {}, {
      just_in_time_revalidation: { ...validManifestValue.just_in_time_revalidation, inputs: [...validManifestValue.just_in_time_revalidation.inputs, { kind: "predecessor_output", name: "AIDEV-999/unrelated", expected: "d".repeat(64) }] },
    });
    assertCode(unrelatedJit, "revalidation_invalid");

    const duplicateDependency = await runTempCandidate(directory, {}, {
      hard_dependencies: [validManifestValue.hard_dependencies[0], validManifestValue.hard_dependencies[0]],
    });
    assertCode(duplicateDependency, "dependency_invalid");

    const selfDependency = await runTempCandidate(directory, {}, {
      hard_dependencies: [{ ...validManifestValue.hard_dependencies[0], ticket_id: "AIDEV-182" }],
    });
    assertCode(selfDependency, "dependency_invalid");

    const softOverlap = await runTempCandidate(directory, {}, {
      soft_dependencies: [{ ticket_id: "AIDEV-181", evidence: [{ kind: "repository", source: "fixture", summary: "overlap" }], confidence: "low" }],
    });
    assertCode(softOverlap, "dependency_overlap");

    const notReady = await runTempCandidate(directory, {}, {
      portfolio: { ...validManifestValue.portfolio, requirement_readiness: "not_ready", unresolved_human_decisions: [{ id: "decision", question: "blocked", blocking: true }] },
    });
    assertCode(notReady, "readiness_blocked");

    const incoherentEpic = await runTempCandidate(directory, {}, { epic: { kind: "standalone", title: "not standalone" } });
    assertCode(incoherentEpic, "epic_incoherent");

    const duplicateOwnership = await runTempCandidate(directory, {}, {
      ownership: { ...validManifestValue.ownership, files: ["scripts/validate-implementation-plan.mjs", "scripts/validate-implementation-plan.mjs"] },
    });
    assertCode(duplicateOwnership, "ownership_duplicate");

    const stale = await runTempCandidate(directory, {}, {
      staleness: { ...validManifestValue.staleness, triggers: [validManifestValue.staleness.triggers[0], validManifestValue.staleness.triggers[0]] },
    });
    assertCode(stale, "staleness_invalid");

    const revalidation = await runTempCandidate(directory, {}, {
      just_in_time_revalidation: { ...validManifestValue.just_in_time_revalidation, inputs: validManifestValue.just_in_time_revalidation.inputs.map((input) => input.kind === "plan_digest" ? { ...input, expected: "e".repeat(64) } : input) },
    });
    assertCode(revalidation, "revalidation_invalid");
  });
});

test("filesystem reads reject symlinks, non-regular files, missing files, and oversized files", async () => {
  await withRootTemp(async (directory) => {
    const candidate = await writeCandidate(directory);
    const linkName = "linked-plan.md";
    try {
      await symlink(join(root, validPlan), join(directory, linkName));
      const linkedPath = `${candidate.planPath.slice(0, candidate.planPath.lastIndexOf("/"))}/${linkName}`;
      const result = runValidator({ plan: linkedPath, manifest: candidate.manifestPath });
      assertCode(result, "path_symlink");
    } catch (error) {
      assert.ok(["EPERM", "EACCES", "ENOSYS"].includes(error?.code), `unexpected symlink error: ${error?.code}`);
    }

    const missing = runValidator({ plan: `${candidate.planPath.slice(0, candidate.planPath.lastIndexOf("/"))}/missing.md`, manifest: candidate.manifestPath });
    assertCode(missing, "path_missing");

    const largePlan = Buffer.alloc(IMPLEMENTATION_PLAN_VALIDATOR_LIMITS.maxPlanBytes + 1, 0x61);
    const large = await runTempCandidate(directory, {}, {}, largePlan);
    assertCode(large, "file_oversized");

    await mkdir(join(directory, "manifest-directory"));
    const nonRegular = runValidator({ manifest: `${candidate.manifestPath.slice(0, candidate.manifestPath.lastIndexOf("/"))}/manifest-directory` });
    assertCode(nonRegular, "path_not_regular");
  });
});

test("fixed Git resolution rejects hostile Windows roots through the production boundary", () => {
  const fixedCandidates = trustedGitCandidatePaths("win32");
  const expectedWindows = [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\mingw64\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\bin\\git.exe",
  ];
  assert.deepEqual(fixedCandidates, expectedWindows);
  assert.deepEqual(trustedGitCandidatePaths("linux"), ["/usr/bin/git", "/bin/git", "/usr/local/bin/git", "/usr/lib/git-core/git"]);

  const environmentNames = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"];
  const originalEnvironment = new Map(environmentNames.map((name) => [name, {
    present: Object.hasOwn(process.env, name),
    value: process.env[name],
  }]));
  const hostileRoot = "Z:\\Program Files";
  const hostilePrefix = `${hostileRoot}\\Git\\`;
  const attemptedCandidates = [];
  const acceptedFakeCandidates = [];
  try {
    for (const name of environmentNames) process.env[name] = hostileRoot;
    assert.deepEqual(Object.fromEntries(environmentNames.map((name) => [name, process.env[name]])), {
      ProgramFiles: hostileRoot,
      ProgramW6432: hostileRoot,
      "ProgramFiles(x86)": hostileRoot,
    });
    assert.throws(() => resolveTrustedGitExecutableFromFixedCandidates("win32", {
      realpathSync(candidate) {
        attemptedCandidates.push(candidate);
        if (candidate.startsWith(hostilePrefix)) return candidate;
        throw new Error("missing fixed executable");
      },
      statSync(candidate) {
        acceptedFakeCandidates.push(candidate);
        return { isFile: () => true };
      },
    }), /trusted Git executable unavailable/);
    assert.deepEqual(attemptedCandidates, fixedCandidates);
    assert.deepEqual(acceptedFakeCandidates, []);
    assert.ok(attemptedCandidates.every((candidate) => !candidate.startsWith("Z:")));
  } finally {
    for (const [name, state] of originalEnvironment) {
      if (state.present) process.env[name] = state.value;
      else delete process.env[name];
    }
  }
  assert.deepEqual(trustedGitCandidatePaths("win32"), fixedCandidates);
  let attempts = 0;
  assert.throws(() => resolveTrustedGitExecutableFromFixedCandidates("win32", {
    realpathSync() {
      attempts += 1;
      throw new Error("missing fixed executable");
    },
  }), /trusted Git executable unavailable/);
  assert.equal(attempts, fixedCandidates.length);
});

test("hostile PATH and Windows Git-root environment cannot replace the concrete trusted Git executable", async () => {
  await withRootTemp(async (directory) => {
    const fakeDirectory = join(directory, "fake-git-bin");
    const fakeRoot = join(directory, "z-program-files", "Git", "cmd");
    const marker = join(directory, "fake-git-marker");
    await mkdir(fakeDirectory);
    await mkdir(fakeRoot, { recursive: true });
    const fakeExecutable = join(fakeDirectory, process.platform === "win32" ? "git.cmd" : "git");
    const fakeRootExecutable = join(fakeRoot, process.platform === "win32" ? "git.exe" : "git");
    if (process.platform === "win32") {
      const body = `@echo off\r\n>"${marker}" echo fake-git\r\nexit /b 1\r\n`;
      await writeFile(fakeExecutable, body, "utf8");
      await writeFile(fakeRootExecutable, body, "utf8");
    } else {
      const body = `#!/bin/sh\nprintf fake-git > "${marker}"\nexit 1\n`;
      await writeFile(fakeExecutable, body, "utf8");
      await writeFile(fakeRootExecutable, body, "utf8");
      await chmod(fakeExecutable, 0o755);
      await chmod(fakeRootExecutable, 0o755);
    }
    const hostileEnvironment = {
      ...process.env,
      PATH: fakeDirectory,
      ProgramFiles: "Z:\\Program Files",
      ProgramW6432: "Z:\\Program Files",
      "ProgramFiles(x86)": "Z:\\Program Files",
    };
    const result = runValidator({}, { env: hostileEnvironment });
    assert.ok([IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.success, IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.validationFailure].includes(result.status));
    if (result.status === IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.success) {
      assert.equal(result.output.ok, true);
    } else {
      assert.ok(result.output.diagnostics.some((entry) => ["repository_unavailable", "git_object_format_invalid", "base_unavailable"].includes(entry.code)));
    }
    assert.ok(resolveTrustedGitExecutable());
    let markerExists = true;
    try {
      await readFile(marker);
    } catch (error) {
      assert.equal(error?.code, "ENOENT");
      markerExists = false;
    }
    assert.equal(markerExists, false);
    assert.ok(trustedGitCandidatePaths("win32").every((candidate) => !candidate.includes("z-program-files") && !candidate.startsWith("Z:")));
  });
});

test("parent-directory rename and reparse swaps fail closed before candidate bytes escape", async () => {
  await withRootTemp(async (directory) => {
    const parent = join(directory, "race-parent");
    const moved = join(directory, "race-parent-moved");
    const outside = await mkdtemp(join(tmpdir(), "implementation-plan-validator-outside-"));
    const planName = "plan.md";
    const planPath = `tests/${relative(join(root, "tests"), parent).split(sep).join("/")}/${planName}`;
    await mkdir(parent);
    await writeFile(join(parent, planName), "inside\n", "utf8");
    await writeFile(join(outside, planName), "outside\n", "utf8");
    let swapped = false;
    let readError;
    try {
      try {
        await safeReadCandidateFile(root, planPath, IMPLEMENTATION_PLAN_VALIDATOR_LIMITS.maxPlanBytes, {
          beforeOpen: async () => {
            await rename(parent, moved);
            try {
              await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
              swapped = true;
            } catch (error) {
              await rename(moved, parent);
              throw error;
            }
          },
        });
      } catch (error) {
        readError = error;
      }
      if (swapped) {
        assert.ok(readError, "the synchronized parent swap must fail closed");
        assert.ok(
          ["path_symlink", "path_outside_root", "path_missing"].includes(readError.code),
          `Linux traversal may observe the replaced parent as missing: ${readError.code}`,
        );
      } else {
        assert.ok(["EPERM", "EACCES", "ENOSYS"].includes(readError?.code), `unexpected native reparse limitation: ${readError?.code}`);
      }
      const pathCases = JSON.parse(await readFile(join(fixtures, "path-policy-cases.json"), "utf8"));
      for (const unsafe of [...pathCases, "C:/junction/plan.md", "\\\\server\\share\\junction\\plan.md", "\\\\?\\C:\\junction\\plan.md"]) {
        assert.equal(isSafeImplementationPlanPath(unsafe), false, unsafe);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rename(moved, parent).catch(() => {});
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("poisoned Git environment is ignored and success/failure leave repository bytes and status unchanged", async () => {
  const beforeStatus = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).stdout;
  const beforeIndex = spawnSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" }).stdout;
  const poisoned = {
    ...process.env,
    GIT_DIR: join(root, "does-not-exist"),
    GIT_WORK_TREE: join(root, "does-not-exist"),
    GIT_OBJECT_DIRECTORY: join(root, "does-not-exist"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(root, "does-not-exist"),
    GIT_CONFIG_GLOBAL: join(root, "does-not-exist"),
    GIT_REPLACE_REF_BASE: "refs/replace/",
    GIT_TRACE: "1",
    GIT_PAGER: "less",
    GIT_EXTERNAL_DIFF: "unsafe",
  };
  const success = runValidator({}, { env: poisoned });
  const failure = runValidator({ base: "f".repeat(40) }, { env: poisoned });
  assert.equal(success.status, 0);
  assertCode(failure, "base_unavailable");
  const afterStatus = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).stdout;
  const afterIndex = spawnSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" }).stdout;
  assert.equal(afterStatus, beforeStatus);
  assert.equal(afterIndex, beforeIndex);
});

test("exact base type, mutable refs, unavailable profiles, repository mismatch, and SHA-256 object format are bounded", async () => {
  const blob = runGit(root, ["rev-parse", "HEAD:profiles/pi-sampler.json"]);
  const wrongType = runValidator({ base: blob });
  assertCode(wrongType, "base_not_commit");
  const repositoryMismatch = runValidator({ repository: "Other/repository" });
  assertCode(repositoryMismatch, "profile_repository_mismatch");
  const ticketMismatch = runValidator({ ticket: "OTHER-1" });
  assertCode(ticketMismatch, "profile_ticket_mismatch");
  const mutable = spawnSync(process.execPath, [script, ...cliArgs({ base: "main" })], { cwd: root, encoding: "utf8" });
  assert.equal(mutable.status, IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.invocationFailure);
  assertCode({ output: JSON.parse(mutable.stdout) }, "invocation_invalid");

  const missingProfile = await makeGitFixture({ profileMode: "missing" });
  try {
    const missing = runValidator({ cwd: missingProfile.directory, base: missingProfile.exactBase, plan: "README.md", manifest: "README.md", ticketRevision: missingProfile.exactBase }, { cwd: missingProfile.directory });
    assertCode(missing, "profile_unavailable");
  } finally {
    await closeGitFixture(missingProfile);
  }

  const wrongProfile = await makeGitFixture({ profileMode: "wrong-type" });
  try {
    const result = runValidator({ cwd: wrongProfile.directory, base: wrongProfile.exactBase, plan: "README.md", manifest: "README.md", ticketRevision: wrongProfile.exactBase }, { cwd: wrongProfile.directory });
    assertCode(result, "profile_wrong_type");
  } finally {
    await closeGitFixture(wrongProfile);
  }

  const sha256Fixture = await makeGitFixture({ objectFormat: "sha256" });
  try {
    const result = runValidator({ cwd: sha256Fixture.directory, base: sha256Fixture.exactBase, plan: "README.md", manifest: "README.md", ticketRevision: sha256Fixture.exactBase }, { cwd: sha256Fixture.directory });
    assert.equal(result.output.bindings.base_sha.length, 64);
    assertCode(result, "json_invalid");
  } finally {
    await closeGitFixture(sha256Fixture);
  }
});

function diagnosticCodes(result) {
  return [...new Set(result.output?.diagnostics?.map((entry) => entry.code) || [])].sort();
}

function assertExactDiagnosticCodes(result, expectedCodes) {
  assert.deepEqual(diagnosticCodes(result), [...new Set(expectedCodes)].sort(), JSON.stringify(result.output?.diagnostics));
}

function assertCorpusDigestBindings(corpus, actualHashes) {
  for (const entry of corpus) assert.equal(actualHashes.get(entry.plan_path), entry.plan_sha256, entry.plan_path);
}

function derivedAuditPlan(historicalBytes, ticket) {
  const text = historicalBytes.toString("utf8");
  const rowId = `${ticket.replace("AIDEV-", "A")}-T01`;
  return Buffer.from(`${text.endsWith("\n") ? text : `${text}\n`}*   [ ] ${rowId}: Frozen audit baseline.\n`, "utf8");
}

function auditBaselineOverrides(entry, planBytes) {
  const rowId = `${entry.ticket.replace("AIDEV-", "A")}-T01`;
  const planDigest = sha256(planBytes);
  const staleness = {
    ...validManifestValue.staleness,
    triggers: validManifestValue.staleness.triggers.filter((trigger) => !["predecessor_output_changed", "requirement_changed"].includes(trigger.kind)),
  };
  return {
    ticket_id: entry.ticket,
    repository,
    base_sha: base,
    ticket_revision: "a".repeat(40),
    rows: [{ id: rowId, title: "Audit baseline", acceptance_class: "ordinary", requirement: "Frozen audit baseline." }],
    hard_dependencies: [],
    predecessor_outputs: [],
    soft_dependencies: [],
    ownership: { files: ["tests/fixtures/implementation-plan-validator/audit-corpus.json"], symbols: [], contracts: [] },
    portfolio: { ...validManifestValue.portfolio, requirement_readiness: "ready", unresolved_human_decisions: [] },
    staleness,
    just_in_time_revalidation: {
      ...validManifestValue.just_in_time_revalidation,
      inputs: validManifestValue.just_in_time_revalidation.inputs
        .filter((input) => input.kind !== "predecessor_output")
        .map((input) => ({
          ...input,
          expected: input.kind === "repository_revision" ? base : input.kind === "ticket_revision" ? "a".repeat(40) : input.kind === "plan_digest" ? planDigest : input.expected,
        })),
    },
  };
}

test("AIDEV-132 through AIDEV-140 are immutable audit inputs with identity-valid baselines and exact independent diagnostics", async () => {
  const corpus = JSON.parse(await readFile(join(fixtures, "audit-corpus.json"), "utf8"));
  assert.equal(corpus.length, 9);
  const actualHashes = new Map();
  const historicalBytes = new Map();
  for (const entry of corpus) {
    const bytes = await readFile(join(root, entry.plan_path));
    historicalBytes.set(entry.plan_path, bytes);
    actualHashes.set(entry.plan_path, sha256(bytes));
  }
  assertCorpusDigestBindings(corpus, actualHashes);

  const auditResults = new Map();
  await withRootTemp(async (directory) => {
    for (const [index, entry] of corpus.entries()) {
      if (entry.class === "legacy-v1-boundary") {
        const result = runValidator({ plan: entry.plan_path, manifest: "docs/techPlans/AIDEV-182-acceptance-manifest-v1.json", ticket: entry.ticket, ticketRevision: "a".repeat(40) });
        assert.equal(result.status, IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.validationFailure);
        assertExactDiagnosticCodes(result, entry.expected_codes);
        auditResults.set(entry.class, result);
        continue;
      }
      const planBytes = derivedAuditPlan(historicalBytes.get(entry.plan_path), entry.ticket);
      const baselineOverrides = auditBaselineOverrides(entry, planBytes);
      const baseline = await writeCandidate(directory, baselineOverrides, planBytes, `audit-${index}-baseline.md`, `audit-${index}-baseline.json`);
      const baselineResult = runValidator({ ticket: entry.ticket, ticketRevision: "a".repeat(40), plan: baseline.planPath, manifest: baseline.manifestPath });
      assert.equal(baselineResult.status, IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.success, `${entry.ticket} baseline: ${JSON.stringify(baselineResult.output)}`);
      assertExactDiagnosticCodes(baselineResult, []);

      const mutation = structuredClone(baselineOverrides);
      if (entry.class === "digest-mismatch") mutation.plan_sha256 = "e".repeat(64);
      if (entry.class === "acceptance-id-mismatch") mutation.rows = mutation.rows.map((row) => ({ ...row, id: `${entry.ticket.replace("AIDEV-", "A")}-T02` }));
      if (entry.class === "base-drift") mutation.base_sha = "5c1e144b0ab8e36378050996a1c112a06d2b5a30";
      if (entry.class === "repository-mismatch") mutation.repository = "Other/repository";
      if (entry.class === "readiness-gap") mutation.portfolio = { ...mutation.portfolio, requirement_readiness: "not_ready", unresolved_human_decisions: [{ id: "blocked", question: "blocked", blocking: true }] };
      if (entry.class === "ticket-mismatch") mutation.ticket_id = "AIDEV-999";
      if (entry.class === "dependency-evidence-gap") {
        mutation.hard_dependencies = [{ ticket_id: "AIDEV-181", reason: "required output must be revalidated", required_outputs: ["contract-v1"], requirement_ids: [`${entry.ticket.replace("AIDEV-", "A")}-T01`] }];
        mutation.predecessor_outputs = [{ ticket_id: "AIDEV-181", output_id: "contract-v1", contract: "implementation-plan-manifest/v2", expected_digest: "d".repeat(64) }];
        mutation.staleness = { ...mutation.staleness, triggers: [...mutation.staleness.triggers, { kind: "predecessor_output_changed", input: "AIDEV-181/contract-v1", action: "manual_refresh" }] };
      }
      if (entry.class === "missing-ticket-revision") mutation.ticket_revision = undefined;
      const candidate = await writeCandidate(directory, mutation, planBytes, `audit-${index}-mutation.md`, `audit-${index}-mutation.json`);
      const result = runValidator({ ticket: entry.ticket, ticketRevision: "a".repeat(40), plan: candidate.planPath, manifest: candidate.manifestPath });
      assert.equal(result.status, IMPLEMENTATION_PLAN_VALIDATOR_EXIT_STATUS.validationFailure, `${entry.ticket} mutation unexpectedly passed`);
      assertExactDiagnosticCodes(result, entry.expected_codes);
      auditResults.set(entry.class, result);
    }
  });

  const digestMutation = structuredClone(corpus);
  digestMutation[0].plan_sha256 = "0".repeat(64);
  assert.throws(() => assertCorpusDigestBindings(digestMutation, actualHashes));
  const pathMutation = structuredClone(corpus);
  pathMutation[0].plan_path = corpus[1].plan_path;
  assert.throws(() => assertCorpusDigestBindings(pathMutation, actualHashes));
  const bytesMutation = new Map(actualHashes);
  bytesMutation.set(corpus[0].plan_path, sha256(Buffer.concat([historicalBytes.get(corpus[0].plan_path), Buffer.from("mutation")])));
  assert.throws(() => assertCorpusDigestBindings(corpus, bytesMutation));
  const expectedMutation = structuredClone(corpus);
  expectedMutation[0].expected_codes = ["manifest_binding_mismatch"];
  assert.throws(() => assertExactDiagnosticCodes(auditResults.get("digest-mismatch"), expectedMutation[0].expected_codes));
  const finalHashes = new Map();
  for (const entry of corpus) finalHashes.set(entry.plan_path, sha256(await readFile(join(root, entry.plan_path))));
  assertCorpusDigestBindings(corpus, finalHashes);
  assert.deepEqual(finalHashes, actualHashes);
});
