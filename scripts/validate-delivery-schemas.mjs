import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expected = new Map([
  ["acceptance-manifest-v1.schema.json", {
    version: "acceptance-manifest/v1",
    sha256: "03733cedbc78f42ffc9268d7da7071184b2bf2ab702a0d4211237b278526d53d",
    required: ["schema_version", "ticket_id", "repository", "plan_path", "plan_sha256", "base_sha", "rows"],
  }],
  ["acceptance-matrix-v1.schema.json", {
    version: "acceptance-matrix/v1",
    sha256: "c52283e1d360491ff67f90d1801f2f5ee7b98f4df9ff6e4c8c9f8dd3d94c0021",
    required: ["schema_version", "ticket_id", "repository", "plan_sha256", "manifest_sha256", "base_sha", "head_sha", "pull_request_number", "generated_at", "rows"],
  }],
  ["benchmark-evidence-v1.schema.json", {
    version: "benchmark-evidence/v1",
    sha256: "13d0cf915275add74498cb12792ec396433bde522d5910af8e3e9f1220e1e899",
    required: ["schema_version", "ticket_id", "repository", "base_sha", "head_sha", "class", "workload_digest", "event_count", "warmup_events", "repetitions", "timeout_ms", "started_at", "completed_at", "event_complete", "slope_estimator", "runs", "summary", "environment", "outcome"],
  }],
  ["waiver-v1.schema.json", {
    version: "delivery-waiver/v1",
    sha256: "fc77195091aa1cb343673285e8b348cdf666f5eb335230b77c0403a54add33a6",
    required: ["schema_version", "waiver_id", "issuer", "key_id", "repository", "ticket_id", "pull_request", "row_id", "plan_sha256", "rationale", "issue", "nonce", "issued_at", "expires_at", "revocation_ref", "signature"],
  }],
  ["acceptance-matrix-v2.schema.json", {
    version: "acceptance-matrix/v2",
    sha256: "ae9844c1e0797d35c586619895d4bd39f20a4f296ce7d26b69a135b925a204a9",
    required: ["schema_version", "manifest_schema_version", "evaluation_scope", "repository", "ticket_id", "ticket_revision", "profile_path", "profile_sha256", "base_sha", "head_sha", "pull_request_number", "plan_path", "plan_sha256", "manifest_path", "manifest_sha256", "manifest_contract_path", "manifest_contract_sha256", "manifest_validator_path", "manifest_validator_sha256", "matrix_contract_path", "matrix_contract_sha256", "policy_path", "policy_sha256", "evidence_root_id", "generated_at", "rows"],
  }],
]);

const v2PortablePathCorpus = [
  ["a", true], ["dir/file.txt", true], ["dir/.hidden", false], ["_hidden/file", false],
  ["dir/-leading", false], ["dir/name-", true], ["dir/report.", false], ["dir/report ", false],
  ["CON/file", false], ["dir/CON.txt", false], ["dir/COM1.log", false], ["dir/clock$.txt", false],
  ["dir//file", false], ["../file", false], ["dir/./file", false], ["dir\\file", false],
  ["dir%2Ffile", false], ["dir:file", false], ["/file", false], ["C:file", false],
  ["a/b/c/d/e/f/g/h/i/j", true], ["a/b/c/d/e/f/g/h/i/j/k", false], ["é/file", false],
  ["file\n", false], ["a/", false], ["a/b_c+,-.txt", true],
];
const v2ArtifactNameCorpus = [
  ["é", true], ["name with spaces", true], ["logical/name", true], ["é", 64, true],
  ["é", 64, "a", false], ["", false], ["name\u0007", false], ["invalid-utf8", "ff", false],
  ["duplicate", "duplicate", false], ["CaseName", "casename", false],
];

function fail(message) {
  throw new Error(`delivery schema validation failed: ${message}`);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
function sameJSON(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function at(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}
function assertAt(value, path, expectedValue) {
  assert(sameJSON(at(value, path), expectedValue), `${path.join(".")} drifted`);
}
function visitSchema(value, path = "$", seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => visitSchema(child, `${path}[${index}]`, seen));
    return;
  }
  if (value.type === "object") {
    assert(value.additionalProperties === false, `${path} must reject additional properties`);
    assert(Array.isArray(value.required), `${path} must declare required properties`);
    assert(value.properties && typeof value.properties === "object", `${path} must declare properties`);
    for (const name of value.required) assert(Object.hasOwn(value.properties, name), `${path} requires undeclared ${name}`);
  }
  for (const [key, child] of Object.entries(value)) visitSchema(child, `${path}.${key}`, seen);
}
function validateV2RuntimeParity(schema) {
  const expectedRoot = expected.get("acceptance-matrix-v2.schema.json").required;
  assertAt(schema, ["required"], expectedRoot);
  assertAt(schema, ["properties", "schema_version", "const"], "acceptance-matrix/v2");
  assertAt(schema, ["properties", "manifest_schema_version", "const"], "implementation-plan-manifest/v2");
  assertAt(schema, ["properties", "rows", "minItems"], 1);
  assertAt(schema, ["properties", "rows", "maxItems"], 128);
  assertAt(schema, ["$defs", "defaultString", "maxLength"], 2048);
  assertAt(schema, ["$defs", "defaultString", "x-maxUtf8Bytes"], 2048);
  assertAt(schema, ["$defs", "defaultString256", "maxLength"], 256);
  assertAt(schema, ["$defs", "defaultString256", "x-maxUtf8Bytes"], 256);
  assertAt(schema, ["$defs", "verifier", "properties", "argv", "minItems"], 1);
  assertAt(schema, ["$defs", "verifier", "properties", "argv", "maxItems"], 32);
  assertAt(schema, ["$defs", "evidence", "properties", "artifacts", "minItems"], 1);
  assertAt(schema, ["$defs", "evidence", "properties", "artifacts", "maxItems"], 32);
  assertAt(schema, ["$defs", "artifact", "properties", "bytes", "minimum"], 0);
  assertAt(schema, ["$defs", "artifact", "properties", "bytes", "maximum"], 10485760);
  assertAt(schema, ["$defs", "portablePath", "maxLength"], 240);
  assertAt(schema, ["$defs", "portablePath256", "maxLength"], 256);
  assertAt(schema, ["$defs", "artifactPath", "allOf", 1, "type"], "string");
  assertAt(schema, ["$defs", "blocker", "properties", "code", "maxLength"], 64);
  assertAt(schema, ["$defs", "blocker", "properties", "reason", "$ref"], "#/$defs/defaultString");
  assertAt(schema, ["$defs", "blocker", "properties", "blocked_by", "anyOf", 1, "type"], "null");
  assert(sameJSON(schema["x-portable-path-corpus"].map((entry) => [entry.value, entry.valid]), v2PortablePathCorpus), "portable path corpus drifted");
  assert(sameJSON(schema["x-artifact-name-corpus"].map((entry) => {
    if (entry.encoding === "invalid-utf8") return ["invalid-utf8", entry.bytes_hex, entry.valid];
    if (entry.kind === "duplicate") return [entry.values[0], entry.values[1], entry.valid];
    if (entry.kind === "identity-case") return [entry.values[0], entry.values[1], entry.valid];
    return [entry.value, entry.repeat, entry.suffix, entry.valid].filter((item) => item !== undefined);
  }), v2ArtifactNameCorpus), "artifact name corpus drifted");
}

assert(expected.size === 5, "source-fixed schema set must contain five entries");
for (const [name, contract] of expected) {
  const path = join(root, "governance", "docs", "delivery-evidence", name);
  const bytes = await readFile(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert(digest === contract.sha256, `${name} bytes drifted`);
  let schema;
  try {
    schema = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail(`${name} is not valid UTF-8 JSON: ${error.message}`);
  }
  assert(schema && typeof schema === "object" && !Array.isArray(schema), `${name} root must be an object`);
  assert(schema.properties?.schema_version?.const === contract.version, `${name} has the wrong schema version`);
  assert(sameJSON(schema.required, contract.required), `${name} required set drifted`);
  visitSchema(schema, name);
  if (name === "acceptance-matrix-v2.schema.json") validateV2RuntimeParity(schema);
}
console.log("validated 5 delivery-evidence schemas");
