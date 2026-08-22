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
import process from "node:process";
import { pathToFileURL } from "node:url";

const LIMITS = Object.freeze({
  argument: 4096, branch: 256, sha: 64, body: 24 * 1024, markerJson: 4096,
  modelId: 128, profileVersion: 64,
});
const TICKET_BRANCH = /^zkrausman\/aidev-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+/\-]{0,127}$/;
const PROFILE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+\-]{0,63}$/;
const FORMAT = "pi-sampler.adversarial-review-attestation";
export const TRUSTED_V3_ATTESTATION_ACTIVATION = "pi-sampler.adversarial-review-attestation:v3";
const TRUSTED_VALIDATOR_PATH = "scripts/validate-adversarial-review-attestation.mjs";
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
function trustedBaseValidatorSource(base) {
  try {
    return execFileSync("git", [...TRUSTED_GIT_OPTIONS, "cat-file", "blob", `${base}:${TRUSTED_VALIDATOR_PATH}`], {
      cwd: process.cwd(), encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 128 * 1024, env: fixedGitEnvironment(),
    });
  } catch {
    fail("the exact trusted base validator could not be inspected");
  }
}
export function trustedBaseActivatesV3(base) {
  const source = trustedBaseValidatorSource(base).replace(/\r\n/g, "\n");
  return source.split("\n").some((line) => line.trim() === TRUSTED_V3_ACTIVATION_LINE);
}
function boundedString(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0") || (!allowEmpty && !value)) fail(`${label} is missing, unsafe, or exceeds its bound`);
  return value;
}
function exactDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}
function singleOptionArguments(argv) {
  if (argv.length > 8) fail("too many attestation validator arguments");
  const names = new Map([
    ["--base", "base"], ["--head", "head"], ["--branch", "branch"], ["--body", "body"],
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
export function isTicketBranch(branch) { return typeof branch === "string" && TICKET_BRANCH.test(branch); }

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
  if (typeof attestation.reviewerModelId !== "string" || !MODEL_ID.test(attestation.reviewerModelId) || Buffer.byteLength(attestation.reviewerModelId, "utf8") > LIMITS.modelId) fail("final-review reviewer model ID is missing or outside its bound");
  if (typeof attestation.reviewProfileVersion !== "string" || !PROFILE_VERSION.test(attestation.reviewProfileVersion) || Buffer.byteLength(attestation.reviewProfileVersion, "utf8") > LIMITS.profileVersion) fail("final-review profile version is missing or outside its bound");
}

/** Validate a bounded PR body without emitting its contents. */
export async function validateAdversarialReviewAttestation({ base, head, branch, body } = {}) {
  base = boundedString(base, "base", LIMITS.sha);
  head = boundedString(head, "head", LIMITS.sha);
  branch = boundedString(branch, "branch", LIMITS.branch);
  body = boundedString(body ?? "", "body", LIMITS.body, { allowEmpty: true });
  if (!SHA.test(base) || !SHA.test(head)) fail("base and head must be exact lowercase 40- or 64-character commit SHAs");

  // Activation is selected only by the exact trusted base's validator bytes.
  // Candidate workflow flags, environment variables, and CLI claims cannot
  // turn the v3 gate on or off.
  const v3Active = trustedBaseActivatesV3(base);
  const marker = parseMarkerJson(body);
  const required = isTicketBranch(branch);
  if (!marker) {
    if (required && v3Active) fail("a v3 final-review attestation is required for an AIDEV ticket branch");
    return { required, attested: false, finalReview: false, legacy: !v3Active, bootstrap: !v3Active, activation: v3Active ? "v3" : "legacy" };
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
