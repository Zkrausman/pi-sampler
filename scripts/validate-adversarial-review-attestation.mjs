#!/usr/bin/env node
/**
 * Fail-closed validation for privacy-safe adversarial-review PR markers.
 *
 * V2 is retained as historical packet-consistency evidence. V3 is the final
 * review gate: it binds the complete v3 packet plus local acceptance/evidence
 * digests and a private receipt digest to exact base/head commits. The latter
 * digests are opaque to CI; the local receipt validator owns their meaning.
 */
import { execFileSync } from "node:child_process";
import { generateReviewPacketV2, generateReviewPacketV3, reviewPacketSha256V2, reviewPacketSha256V3 } from "./generate-review-packet.mjs";
import { assertPrivacySafeReviewerModelId, assertPrivacySafeReviewProfileVersion } from "./review-provenance-contract.mjs";
import { parseFinalReviewReceipt, readBoundedRegularFile, validateFinalReviewAttestation } from "./final-review-receipt.mjs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const LIMITS = Object.freeze({
  argument: 4096, branch: 256, sha: 64, body: 24 * 1024, markerJson: 4096,
});
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FORMAT = "pi-sampler.adversarial-review-attestation";
export const TRUSTED_V3_ATTESTATION_ACTIVATION = "pi-sampler.adversarial-review-attestation:v3";
const TRUSTED_VALIDATOR_PATH = "scripts/validate-adversarial-review-attestation.mjs";
const TRUSTED_PROFILE_PATH = "profiles/pi-sampler.json";
const TRUSTED_PROFILE_MAX_BYTES = 128 * 1024;
const TRUSTED_WORK_ITEM_PATTERN_MAX_BYTES = 1024;
const REPOSITORY_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH_PREFIX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_SUFFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRUSTED_V3_ACTIVATION_LINE = `export const TRUSTED_V3_ATTESTATION_ACTIVATION = ${JSON.stringify(TRUSTED_V3_ATTESTATION_ACTIVATION)};`;
const SAFE_ENVIRONMENT_NAMES = Object.freeze(process.platform === "win32"
  ? ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA"]
  : ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]);
const TRUSTED_GIT_OPTIONS = Object.freeze([
  "--no-pager", "--no-replace-objects", "-c", "trace2.eventTarget=", "-c", "trace2.normalTarget=", "-c", "trace2.perfTarget=",
  "-c", "color.ui=false", "-c", "core.hooksPath=/dev/null", "-c", "user.useConfigOnly=true",
]);
const MARKER_PREFIX = "pi-sampler-adversarial-review-attestation";
const V2_TAG = `<!-- ${MARKER_PREFIX}:v2`;
const V3_TAG = `<!-- ${MARKER_PREFIX}:v3`;
const MARKER_V2 = new RegExp(`<!-- ${MARKER_PREFIX}:v2 ([^\\r\\n]{1,4096}) -->`, "g");
const MARKER_V3 = new RegExp(`<!-- ${MARKER_PREFIX}:v3 ([^\\r\\n]{1,4096}) -->`, "g");
const EXPECTED_KEYS_V2 = ["base", "format", "head", "outcome", "packetSha256", "version"];
const EXPECTED_KEYS_V3 = [
  "acceptanceMatrixSha256", "base", "format", "head", "outcome", "packetSha256",
  "receiptSha256", "reviewerModelId", "reviewProfileVersion", "verificationEvidenceSha256", "version",
];

function fail(message) { throw new Error(message); }
function fixedGitEnvironment(source = process.env) {
  const environment = {};
  for (const expectedName of SAFE_ENVIRONMENT_NAMES) {
    const entry = Object.entries(source).find(([name]) => name.toLowerCase() === expectedName.toLowerCase());
    if (entry && !/^git_/i.test(entry[0])) environment[entry[0]] = entry[1];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}
function resolveExactCommit(base) {
  if (!SHA.test(base)) fail("the supplied base must be an exact lowercase commit SHA");
  try {
    const resolved = execFileSync("git", [...TRUSTED_GIT_OPTIONS, "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], {
      cwd: process.cwd(), encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 256, env: fixedGitEnvironment(),
    }).trim();
    const type = execFileSync("git", [...TRUSTED_GIT_OPTIONS, "cat-file", "-t", base], {
      cwd: process.cwd(), encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 256, env: fixedGitEnvironment(),
    }).trim();
    if (resolved !== base || type !== "commit") fail("the supplied base must be the exact commit object");
    return base;
  } catch {
    fail("the supplied base must be the exact commit object");
  }
}
function trustedBaseValidatorSource(base) {
  const exactBase = resolveExactCommit(base);
  try {
    return execFileSync("git", [...TRUSTED_GIT_OPTIONS, "cat-file", "blob", `${exactBase}:${TRUSTED_VALIDATOR_PATH}`], {
      cwd: process.cwd(), encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 128 * 1024, env: fixedGitEnvironment(),
    });
  } catch {
    fail("the exact trusted base validator could not be inspected");
  }
}
function readTrustedStringExpression(source, start, substitutions = {}) {
  const quote = source[start];
  if (!['"', "'", "`"].includes(quote)) return null;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === quote) return value;
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) return null;
      value += ({ b: "\\b", f: "\\f", n: "\\n", r: "\\r", t: "\\t", v: "\\v" }[escaped] ?? escaped);
      index += 1;
      continue;
    }
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      const end = source.indexOf("}", index + 2);
      if (end < 0) return null;
      const expression = source.slice(index + 2, end).trim();
      if (!Object.hasOwn(substitutions, expression) || typeof substitutions[expression] !== "string") return null;
      value += substitutions[expression];
      index = end;
      continue;
    }
    if (quote !== "`" && (character === "\r" || character === "\n")) return null;
    value += character;
  }
  return null;
}
function readTrustedStringConstant(source, name, substitutions = {}) {
  const declaration = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=\\s*`, "g");
  const match = declaration.exec(source);
  return match ? readTrustedStringExpression(source, declaration.lastIndex, substitutions) : null;
}
function trustedBaseUsesLegacyV2Marker(source) {
  const markerPrefix = readTrustedStringConstant(source, "MARKER_PREFIX");
  if (markerPrefix !== null && markerPrefix !== MARKER_PREFIX) return false;
  const substitutions = { MARKER_PREFIX: markerPrefix ?? MARKER_PREFIX };
  const v2Tag = readTrustedStringConstant(source, "V2_TAG", substitutions);
  const markerTag = readTrustedStringConstant(source, "MARKER_TAG", substitutions);
  return v2Tag === V2_TAG || markerTag === V2_TAG;
}
function trustedBaseRequiresLegacyV2(source) {
  return trustedBaseUsesLegacyV2Marker(source)
    && /if\s*\(\s*!\s*marker\s*\)\s*\{[\s\S]{0,4096}?if\s*\(\s*required\s*\)\s*fail\s*\(/.test(source);
}
function trustedBaseProfile(base) {
  const exactBase = resolveExactCommit(base);
  let profileText;
  try {
    profileText = execFileSync("git", [...TRUSTED_GIT_OPTIONS, "cat-file", "blob", `${exactBase}:${TRUSTED_PROFILE_PATH}`], {
      cwd: process.cwd(), encoding: "utf8", shell: false, windowsHide: true, maxBuffer: TRUSTED_PROFILE_MAX_BYTES, env: fixedGitEnvironment(),
    });
  } catch {
    fail("the exact trusted base consumer profile could not be inspected");
  }
  if (Buffer.byteLength(profileText, "utf8") > TRUSTED_PROFILE_MAX_BYTES) fail("the exact trusted base consumer profile exceeds its bound");
  let profile;
  try { profile = JSON.parse(profileText); } catch { fail("the exact trusted base consumer profile is not valid JSON"); }
  const repository = profile?.repository?.source;
  if (typeof repository !== "string" || !REPOSITORY_SOURCE.test(repository)) fail("the exact trusted base consumer profile has no valid repository source");
  const branchPrefix = profile?.delivery?.branchPrefix;
  if (typeof branchPrefix !== "string" || !BRANCH_PREFIX.test(branchPrefix)) fail("the exact trusted base consumer profile has no valid branch prefix");
  const workItemPatternSource = profile?.workItem?.idPattern;
  if (typeof workItemPatternSource !== "string" || Buffer.byteLength(workItemPatternSource, "utf8") > TRUSTED_WORK_ITEM_PATTERN_MAX_BYTES || workItemPatternSource.includes("\0")) {
    fail("the exact trusted base consumer profile has no valid work-item policy");
  }
  let workItemPattern;
  try { workItemPattern = new RegExp(workItemPatternSource); } catch { fail("the exact trusted base consumer profile has no valid work-item policy"); }
  return Object.freeze({ repository, branchPrefix, workItemPattern });
}
function trustedBaseConsumerRepository(profile) { return profile.repository; }
function trustedBasePolicy(base) {
  const source = trustedBaseValidatorSource(base).replace(/\r\n/g, "\n");
  const profile = trustedBaseProfile(base);
  return {
    v3: source.split("\n").some((line) => line.trim() === TRUSTED_V3_ACTIVATION_LINE),
    legacyV2Required: trustedBaseRequiresLegacyV2(source),
    ...profile,
    repository: trustedBaseConsumerRepository(profile),
  };
}
function trustedTicketBranch(branch, policy) {
  if (!policy || typeof branch !== "string") return false;
  const prefix = `${policy.branchPrefix}/`;
  if (!branch.startsWith(prefix)) return false;
  const suffix = branch.slice(prefix.length);
  if (!BRANCH_SUFFIX.test(suffix)) return false;
  const segments = suffix.split("-");
  for (let end = 1; end < segments.length; end += 1) {
    const workItem = segments.slice(0, end).join("-").toUpperCase();
    policy.workItemPattern.lastIndex = 0;
    if (policy.workItemPattern.test(workItem)) return true;
  }
  return false;
}
export function trustedBaseActivatesV3(base) { return trustedBasePolicy(base).v3; }
function boundedString(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0") || (!allowEmpty && !value)) fail(`${label} is missing, unsafe, or exceeds its bound`);
  return value;
}
function exactDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}
function singleOptionArguments(argv) {
  if (argv.length > 12) fail("too many attestation validator arguments");
  const names = new Map([
    ["--base", "base"], ["--head", "head"], ["--branch", "branch"], ["--body", "body"],
    ["--receipt", "receiptPath"], ["--pull-request", "pullRequest"],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = names.get(argument);
    if (!key || Object.hasOwn(options, key)) fail("expected each supported option at most once");
    if (index + 1 >= argv.length) fail(`${argument} requires a value`);
    const value = argv[++index];
    const maximum = key === "body" ? LIMITS.body : key === "branch" ? LIMITS.branch : LIMITS.argument;
    options[key] = boundedString(value, argument, maximum, { allowEmpty: key === "body" });
  }
  return options;
}
function inputValue(options, environment, key, environmentKey, maximum, allowEmpty = false) {
  if (options[key] !== undefined && environment[environmentKey] !== undefined) fail(`${key} must be supplied by either CLI or environment, not both`);
  const value = options[key] ?? environment[environmentKey];
  return boundedString(value, key, maximum, { allowEmpty });
}
function optionalInputValue(options, environment, key, environmentKey, maximum) {
  if (options[key] !== undefined && environment[environmentKey] !== undefined) fail(`${key} must be supplied by either CLI or environment, not both`);
  const value = options[key] ?? environment[environmentKey];
  return value === undefined ? undefined : boundedString(value, key, maximum);
}
export function isTicketBranch(branch, policy) { return trustedTicketBranch(branch, policy); }

function parseStrictMarkerJson(text) {
  let index = 0;
  const skip = () => { while (index < text.length && " \\t\\r\\n".includes(text[index])) index += 1; };
  const parseString = () => {
    if (text[index] !== '"') fail("review attestation marker contains malformed JSON");
    const start = index++;
    while (index < text.length) {
      const code = text.charCodeAt(index++);
      if (code === 0x22) {
        const raw = text.slice(start, index);
        try { return JSON.parse(raw); } catch { fail("review attestation marker contains invalid JSON string"); }
      }
      if (code < 0x20) fail("review attestation marker contains an unescaped control character");
      if (code === 0x5c) {
        const escaped = text[index++];
        if (escaped === "u") index += 4;
        else if (!'"\\\\/bfnrt'.includes(escaped)) fail("review attestation marker contains an invalid escape");
      }
    }
    fail("review attestation marker contains an unterminated string");
  };
  const value = (depth) => {
    if (depth > 16) fail("review attestation marker exceeds its JSON depth bound");
    skip();
    if (text[index] === '"') return parseString();
    if (text[index] === "{") {
      index += 1; skip(); const object = Object.create(null); const keys = new Set();
      if (text[index] === "}") { index += 1; return object; }
      for (;;) {
        const key = parseString();
        if (keys.has(key)) fail("review attestation marker contains a duplicate object key");
        keys.add(key); skip(); if (text[index++] !== ":") fail("review attestation marker contains a malformed object");
        object[key] = value(depth + 1); skip();
        if (text[index] === "}") { index += 1; return object; }
        if (text[index++] !== ",") fail("review attestation marker contains a malformed object");
        skip();
      }
    }
    if (text[index] === "[") {
      index += 1; skip(); const array = [];
      if (text[index] === "]") { index += 1; return array; }
      for (;;) {
        array.push(value(depth + 1)); skip();
        if (text[index] === "]") { index += 1; return array; }
        if (text[index++] !== ",") fail("review attestation marker contains a malformed array");
        skip();
      }
    }
    const start = index;
    while (index < text.length && !",]} \\t\\r\\n".includes(text[index])) index += 1;
    const token = text.slice(start, index);
    if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*))$/.test(token)) fail("review attestation marker contains invalid JSON");
    return token === "true" ? true : token === "false" ? false : token === "null" ? null : Number(token);
  };
  const valueResult = value(0); skip(); if (index !== text.length) fail("review attestation marker contains trailing data");
  return valueResult;
}

function parseMarkerJson(body) {
  MARKER_V2.lastIndex = 0;
  MARKER_V3.lastIndex = 0;
  const v2 = [...body.matchAll(MARKER_V2)];
  MARKER_V2.lastIndex = 0;
  MARKER_V3.lastIndex = 0;
  const v3 = [...body.matchAll(MARKER_V3)];
  MARKER_V2.lastIndex = 0;
  MARKER_V3.lastIndex = 0;
  const tagOccurrences = body.split(V2_TAG).length - 1 + body.split(V3_TAG).length - 1;
  if (tagOccurrences === 0) return null;
  if (tagOccurrences !== 1 || v2.length + v3.length !== 1) fail("review attestation marker must appear exactly once as one single-line JSON marker");
  const match = v2[0] ?? v3[0];
  const json = match[1];
  if (Buffer.byteLength(json, "utf8") > LIMITS.markerJson) fail("review attestation marker exceeds its bound");
  const value = parseStrictMarkerJson(json);
  return { version: v2.length ? 2 : 3, value };
}
export function parseAdversarialReviewMarker(body) { return parseMarkerJson(body); }

function validateKeys(value, expected, label) {
  if (!value || Array.isArray(value) || typeof value !== "object") fail(`${label} must be a JSON object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) fail(`${label} has unsupported or missing fields`);
}
function validateSchemaV2(attestation, { base, head, packetSha256 }) {
  validateKeys(attestation, EXPECTED_KEYS_V2, "review attestation");
  if (attestation.format !== FORMAT || attestation.version !== 2) fail("review attestation format or version is unsupported");
  if (attestation.base !== base || attestation.head !== head) fail("review attestation base or head does not match the resolved PR commits");
  if (attestation.outcome !== "clean") fail("review attestation outcome must be clean with no unresolved blocker or high finding");
  if (typeof attestation.packetSha256 !== "string" || !DIGEST.test(attestation.packetSha256) || attestation.packetSha256 !== packetSha256) fail("review attestation packet digest does not match the commit-only review packet");
}
function validateSchemaV3(attestation, { base, head, packetSha256 }) {
  validateKeys(attestation, EXPECTED_KEYS_V3, "final-review attestation");
  if (attestation.format !== FORMAT || attestation.version !== 3) fail("final-review attestation format or version is unsupported");
  if (attestation.base !== base || attestation.head !== head) fail("final-review attestation base or head does not match the resolved PR commits");
  if (attestation.outcome !== "clean") fail("final-review attestation outcome must be clean with no unresolved blocker or high finding");
  if (typeof attestation.packetSha256 !== "string" || !DIGEST.test(attestation.packetSha256) || attestation.packetSha256 !== packetSha256) fail("final-review attestation packet digest does not match the complete v3 review packet");
  exactDigest(attestation.acceptanceMatrixSha256, "final-review acceptance matrix digest");
  exactDigest(attestation.verificationEvidenceSha256, "final-review verification evidence digest");
  exactDigest(attestation.receiptSha256, "final-review local receipt digest");
  assertPrivacySafeReviewerModelId(attestation.reviewerModelId, "final-review reviewer model ID");
  assertPrivacySafeReviewProfileVersion(attestation.reviewProfileVersion, "final-review profile version");
}

/** Validate the opaque local receipt against the exact public marker before push. */
async function validateLocalFinalReviewMarker({ body, receiptPath, base, head, pullRequest, policy }) {
  if (!receiptPath) fail("a local final-review receipt is required to validate an activated v3 marker");
  let receipt;
  try {
    receipt = parseFinalReviewReceipt((await readBoundedRegularFile(receiptPath)).toString("utf8"));
  } catch {
    fail("the local final-review receipt could not be read or parsed");
  }
  const result = validateFinalReviewAttestation(body, receipt, {
    base,
    head,
    repository: policy.repository,
    ...(pullRequest === undefined ? {} : { pullRequest }),
  });
  if (!result.ok) fail(result.errors[0]);
}

/** Validate a bounded PR body without emitting its contents. */
export async function validateAdversarialReviewAttestation({ base, head, branch, body, receiptPath, pullRequest } = {}) {
  base = boundedString(base, "base", LIMITS.sha);
  head = boundedString(head, "head", LIMITS.sha);
  branch = boundedString(branch, "branch", LIMITS.branch);
  body = boundedString(body ?? "", "body", LIMITS.body, { allowEmpty: true });
  if (!SHA.test(base) || !SHA.test(head)) fail("base and head must be exact lowercase 40- or 64-character commit SHAs");

  // Activation is selected only by the exact trusted base's validator bytes.
  // Candidate workflow flags, environment variables, and CLI claims cannot
  // turn the v3 gate on or off.
  const policy = trustedBasePolicy(base);
  const v3Active = policy.v3;
  const marker = parseMarkerJson(body);
  const required = isTicketBranch(branch, policy);
  if (!marker) {
    if (required && v3Active) fail("a v3 final-review attestation is required for a trusted ticket branch");
    if (required && policy.legacyV2Required) fail("a v2 adversarial-review attestation is required by the exact trusted base for a trusted ticket branch");
    return { required, attested: false, finalReview: false, legacy: !v3Active, bootstrap: false, activation: v3Active ? "v3" : "legacy" };
  }

  if (marker.version === 2) {
    if (v3Active && required) fail("a v2 marker is legacy packet-consistency evidence and cannot satisfy the v3 final-review gate");
    const packet = await generateReviewPacketV2({ base, head });
    if (packet.base !== base || packet.head !== head) fail("base or head did not resolve exactly to the supplied commit SHA");
    const packetSha256 = reviewPacketSha256V2(packet);
    validateSchemaV2(marker.value, { base: packet.base, head: packet.head, packetSha256 });
    return { required, attested: true, finalReview: false, legacy: true, bootstrap: !v3Active, activation: v3Active ? "v3" : "legacy", version: 2, base: packet.base, head: packet.head, packetSha256 };
  }

  if (!v3Active) fail("a v3 final-review attestation is not accepted until the exact trusted base activates v3");
  // CI has only the opaque public digest; the local pre-push path supplies the
  // ignored receipt path and therefore also enforces revocation state.
  if (receiptPath !== undefined) await validateLocalFinalReviewMarker({ body, receiptPath, base, head, pullRequest, policy });
  const packet = await generateReviewPacketV3({ base, head });
  if (packet.base !== base || packet.head !== head) fail("base or head did not resolve exactly to the supplied commit SHA");
  const packetSha256 = reviewPacketSha256V3(packet);
  validateSchemaV3(marker.value, { base: packet.base, head: packet.head, packetSha256 });
  return {
    required,
    attested: true,
    finalReview: true,
    bootstrap: false,
    activation: "v3",
    legacy: false,
    version: 3,
    base: packet.base,
    head: packet.head,
    packetSha256,
    acceptanceMatrixSha256: marker.value.acceptanceMatrixSha256,
    verificationEvidenceSha256: marker.value.verificationEvidenceSha256,
    reviewerModelId: marker.value.reviewerModelId,
    reviewProfileVersion: marker.value.reviewProfileVersion,
    receiptSha256: marker.value.receiptSha256,
    provenance: "maintainer-attested caller claim; not external model proof",
  };
}

function cliInputs(argv = process.argv.slice(2), environment = process.env) {
  const options = singleOptionArguments(argv);
  return {
    base: inputValue(options, environment, "base", "ADVERSARIAL_REVIEW_BASE_SHA", LIMITS.sha),
    head: inputValue(options, environment, "head", "ADVERSARIAL_REVIEW_HEAD_SHA", LIMITS.sha),
    branch: inputValue(options, environment, "branch", "ADVERSARIAL_REVIEW_HEAD_REF", LIMITS.branch),
    body: inputValue(options, environment, "body", "ADVERSARIAL_REVIEW_PR_BODY", LIMITS.body, true),
    receiptPath: optionalInputValue(options, environment, "receiptPath", "ADVERSARIAL_REVIEW_RECEIPT_PATH", LIMITS.argument),
    pullRequest: optionalInputValue(options, environment, "pullRequest", "ADVERSARIAL_REVIEW_PULL_REQUEST", LIMITS.argument),
  };
}

async function main() {
  try {
    const result = await validateAdversarialReviewAttestation(cliInputs());
    console.log(result.finalReview ? "Final review attestation validated." : result.attested ? "Adversarial review attestation validated." : result.bootstrap ? "No v3 final-review attestation required before trusted-base activation." : "No adversarial review attestation required for this non-ticket branch.");
  } catch (error) {
    // Never echo the PR body or any local review content.
    console.error(`adversarial-review-attestation: ${error.message}`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
