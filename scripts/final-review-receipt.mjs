#!/usr/bin/env node
/**
 * Validate the local lifecycle receipt for the final Terra review child.
 *
 * The receipt is deliberately local evidence. It binds one fresh child and at
 * most two complete correction passes to immutable review inputs. Only the
 * small, privacy-safe marker rendered by createFinalReviewAttestation is
 * suitable for publication.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertValidReviewPacketAgainstGit } from "./validate-review-packet.mjs";

export const FINAL_REVIEW_RECEIPT_FORMAT = "pi-sampler.final-review-receipt";
export const FINAL_REVIEW_RECEIPT_VERSION = 1;
export const FINAL_REVIEW_ATTESTATION_FORMAT = "pi-sampler.adversarial-review-attestation";
export const FINAL_REVIEW_RECEIPT_LIMITS = Object.freeze({
  receiptBytes: 128 * 1024,
  repository: 256,
  pullRequest: 32,
  commit: 64,
  digest: 64,
  identifier: 192,
  modelId: 128,
  profileVersion: 64,
  nonce: 128,
  reason: 1024,
  passes: 3,
  findings: 128,
  inputBytes: 2 * 1024 * 1024,
  jsonDepth: 16,
  jsonNodes: 4096,
  jsonStringBytes: 64 * 1024,
});

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PULL_REQUEST = /^[1-9][0-9]{0,30}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,191}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+/\-]{0,127}$/;
const PROFILE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+\-]{0,63}$/;
const NONCE = /^[a-f0-9]{32,128}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MARKER_PREFIX = "pi-sampler-adversarial-review-attestation";
const RECEIPT_TAG = `<!-- ${MARKER_PREFIX}:v3`;
const RECEIPT_MARKER = new RegExp(`<!-- ${MARKER_PREFIX}:v3 ([^\\r\\n]{1,4096}) -->`, "g");

const TOP_KEYS = [
  "format", "version", "repository", "pullRequest", "nonce", "base", "head",
  "packetSha256", "acceptanceMatrixSha256", "verificationEvidenceSha256",
  "reviewerModelId", "reviewProfileVersion", "outcome", "lifecycle",
  "revocation", "receiptSha256",
];
const LIFECYCLE_KEYS = ["lineageId", "fresh", "correctionCount", "passes"];
const PASS_KEYS = [
  "index", "kind", "lineageId", "base", "head", "packetSha256",
  "acceptanceMatrixSha256", "verificationEvidenceSha256", "outcome",
  "blockerCount", "highCount", "recordedAt",
];
const REVOCATION_KEYS = ["revoked", "reason", "source", "recordedAt"];
const MARKER_KEYS = [
  "acceptanceMatrixSha256", "base", "format", "head", "outcome",
  "packetSha256", "receiptSha256", "reviewerModelId", "reviewProfileVersion",
  "verificationEvidenceSha256", "version",
];

function fail(message) { throw new Error(message); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unsupported, missing, or duplicate fields`);
  }
}
function boundedString(value, label, maximum, pattern = undefined) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0")) {
    fail(`${label} is missing, unsafe, or exceeds its bound`);
  }
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}
function boundedNullableString(value, label, maximum, pattern = undefined) {
  if (value === null) return value;
  return boundedString(value, label, maximum, pattern);
}
function exactInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} is outside its fixed bound`);
  return value;
}
function canonicalTimestamp(value, label) {
  boundedString(value, label, 24, TIMESTAMP);
  if (new Date(value).toISOString() !== value) fail(`${label} is not a canonical UTC timestamp`);
  return value;
}
function digest(value, label) { return boundedString(value, label, FINAL_REVIEW_RECEIPT_LIMITS.digest, DIGEST); }
function commit(value, label) { return boundedString(value, label, FINAL_REVIEW_RECEIPT_LIMITS.commit, COMMIT); }

/** Canonical JSON used for all local receipt and evidence digests. */
export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("canonical JSON contains an unsafe number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("canonical JSON contains an unsupported value");
}
export function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }
export function digestBytes(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail("digest input must be bytes");
  return sha256Hex(Buffer.from(value));
}
export function digestCanonicalJson(value) { return sha256Hex(`${canonicalJson(value)}\n`); }

function receiptBinding(receipt) {
  if (!isRecord(receipt)) fail("final-review receipt must be an object");
  const { receiptSha256: _receiptSha256, ...binding } = receipt;
  return binding;
}
export function canonicalReceiptPayload(receipt) { return canonicalJson(receiptBinding(receipt)); }
export function finalReviewReceiptSha256(receipt) { return sha256Hex(canonicalReceiptPayload(receipt)); }
export const receiptSha256 = finalReviewReceiptSha256;

function parseStrictJson(text, label = "JSON") {
  if (typeof text !== "string") fail(`${label} must be UTF-8 text`);
  if (Buffer.byteLength(text, "utf8") > FINAL_REVIEW_RECEIPT_LIMITS.receiptBytes) fail(`${label} exceeds its fixed byte bound`);
  let nodes = 0;
  let depth = 0;
  const scan = (value, currentDepth) => {
    if (++nodes > FINAL_REVIEW_RECEIPT_LIMITS.jsonNodes) fail(`${label} exceeds its JSON node bound`);
    if (currentDepth > FINAL_REVIEW_RECEIPT_LIMITS.jsonDepth) fail(`${label} exceeds its JSON depth bound`);
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) scan(item, currentDepth + 1); return; }
    for (const key of Object.keys(value)) {
      if (Buffer.byteLength(key, "utf8") > FINAL_REVIEW_RECEIPT_LIMITS.jsonStringBytes) fail(`${label} contains an oversized key`);
      scan(value[key], currentDepth + 1);
    }
  };
  // JSON.parse is used only after a duplicate-key scan. The scanner keeps the
  // parser small while still rejecting duplicate object keys before values are
  // accepted into the receipt binding.
  const duplicateScan = (source) => {
    let index = 0;
    const whitespace = () => { while (index < source.length && " \t\r\n".includes(source[index])) index += 1; };
    const string = () => {
      if (source[index] !== '"') fail(`${label} contains malformed JSON`);
      const start = index++;
      while (index < source.length) {
        const code = source.charCodeAt(index++);
        if (code === 0x22) {
          const raw = source.slice(start, index);
          let decoded;
          try { decoded = JSON.parse(raw); } catch { fail(`${label} contains malformed JSON string`); }
          if (Buffer.byteLength(decoded, "utf8") > FINAL_REVIEW_RECEIPT_LIMITS.jsonStringBytes) fail(`${label} contains an oversized string`);
          return decoded;
        }
        if (code < 0x20) fail(`${label} contains an unescaped control character`);
        if (code === 0x5c) {
          if (index >= source.length) fail(`${label} contains a malformed escape`);
          const escaped = source[index++];
          if (escaped === "u") index += 4;
          else if (!'"\\/bfnrt'.includes(escaped)) fail(`${label} contains an invalid escape`);
        }
      }
      fail(`${label} contains an unterminated string`);
    };
    const value = (level) => {
      if (level > FINAL_REVIEW_RECEIPT_LIMITS.jsonDepth) fail(`${label} exceeds its JSON depth bound`);
      whitespace();
      const character = source[index];
      if (character === '"') { string(); return; }
      if (character === "{") {
        index += 1; whitespace(); const keys = new Set();
        if (source[index] === "}") { index += 1; return; }
        for (;;) {
          const key = string();
          if (keys.has(key)) fail(`${label} contains a duplicate object key`);
          keys.add(key); whitespace(); if (source[index++] !== ":") fail(`${label} contains a malformed object`);
          value(level + 1); whitespace();
          if (source[index] === "}") { index += 1; return; }
          if (source[index++] !== ",") fail(`${label} contains a malformed object`);
          whitespace();
        }
      }
      if (character === "[") {
        index += 1; whitespace();
        if (source[index] === "]") { index += 1; return; }
        for (;;) {
          value(level + 1); whitespace();
          if (source[index] === "]") { index += 1; return; }
          if (source[index++] !== ",") fail(`${label} contains a malformed array`);
          whitespace();
        }
      }
      const start = index;
      while (index < source.length && !",]} \t\r\n".includes(source[index])) index += 1;
      const token = source.slice(start, index);
      if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*))$/.test(token)) fail(`${label} contains a non-canonical JSON value`);
    };
    value(0); whitespace(); if (index !== source.length) fail(`${label} contains trailing data`);
  };
  duplicateScan(text);
  let value;
  try { value = JSON.parse(text); } catch { fail(`${label} contains invalid JSON`); }
  scan(value, depth);
  return value;
}

function validatePass(pass, expected, index) {
  exactKeys(pass, PASS_KEYS, `lifecycle.passes[${index}]`);
  exactInteger(pass.index, `lifecycle.passes[${index}].index`, 0, FINAL_REVIEW_RECEIPT_LIMITS.passes - 1);
  if (pass.index !== index) fail(`lifecycle.passes[${index}] has a noncanonical index`);
  if (pass.kind !== (index === 0 ? "initial" : "resume")) fail(`lifecycle.passes[${index}] has an invalid kind`);
  boundedString(pass.lineageId, `lifecycle.passes[${index}].lineageId`, FINAL_REVIEW_RECEIPT_LIMITS.identifier, OPAQUE_ID);
  if (pass.lineageId !== expected.lineageId) fail(`lifecycle.passes[${index}] is not bound to the one child lineage`);
  commit(pass.base, `lifecycle.passes[${index}].base`);
  commit(pass.head, `lifecycle.passes[${index}].head`);
  if (pass.base !== expected.base) fail(`lifecycle.passes[${index}] base is not the frozen base`);
  digest(pass.packetSha256, `lifecycle.passes[${index}].packetSha256`);
  digest(pass.acceptanceMatrixSha256, `lifecycle.passes[${index}].acceptanceMatrixSha256`);
  digest(pass.verificationEvidenceSha256, `lifecycle.passes[${index}].verificationEvidenceSha256`);
  if (!["clean", "blocked"].includes(pass.outcome)) fail(`lifecycle.passes[${index}].outcome is unsupported`);
  exactInteger(pass.blockerCount, `lifecycle.passes[${index}].blockerCount`, 0, FINAL_REVIEW_RECEIPT_LIMITS.findings);
  exactInteger(pass.highCount, `lifecycle.passes[${index}].highCount`, 0, FINAL_REVIEW_RECEIPT_LIMITS.findings);
  if (pass.outcome === "clean" && (pass.blockerCount !== 0 || pass.highCount !== 0)) fail(`lifecycle.passes[${index}] clean outcome has blocker/high findings`);
  canonicalTimestamp(pass.recordedAt, `lifecycle.passes[${index}].recordedAt`);
  if (index > 0) {
    const previous = expected.previousPass;
    if (previous && pass.head === previous.head) fail(`lifecycle.passes[${index}] correction must bind a newly frozen exact head`);
    if (previous && pass.packetSha256 === previous.packetSha256
      && pass.acceptanceMatrixSha256 === previous.acceptanceMatrixSha256
      && pass.verificationEvidenceSha256 === previous.verificationEvidenceSha256) {
      fail(`lifecycle.passes[${index}] correction does not change its complete frozen input binding`);
    }
    if (previous && Date.parse(pass.recordedAt) < Date.parse(previous.recordedAt)) fail("final-review passes are not chronological");
  }
  expected.previousPass = pass;
  return pass;
}

/** Validate structure, lifecycle invariants, digest, and optional exact inputs. */
export function validateFinalReviewReceipt(receipt, options = {}) {
  const errors = [];
  try {
    exactKeys(receipt, TOP_KEYS, "final-review receipt");
    if (receipt.format !== FINAL_REVIEW_RECEIPT_FORMAT || receipt.version !== FINAL_REVIEW_RECEIPT_VERSION) fail("final-review receipt format or version is unsupported");
    boundedString(receipt.repository, "repository", FINAL_REVIEW_RECEIPT_LIMITS.repository, REPOSITORY);
    boundedString(receipt.pullRequest, "pullRequest", FINAL_REVIEW_RECEIPT_LIMITS.pullRequest, PULL_REQUEST);
    boundedString(receipt.nonce, "nonce", FINAL_REVIEW_RECEIPT_LIMITS.nonce, NONCE);
    commit(receipt.base, "base"); commit(receipt.head, "head");
    digest(receipt.packetSha256, "packetSha256");
    digest(receipt.acceptanceMatrixSha256, "acceptanceMatrixSha256");
    digest(receipt.verificationEvidenceSha256, "verificationEvidenceSha256");
    boundedString(receipt.reviewerModelId, "reviewerModelId", FINAL_REVIEW_RECEIPT_LIMITS.modelId, MODEL_ID);
    boundedString(receipt.reviewProfileVersion, "reviewProfileVersion", FINAL_REVIEW_RECEIPT_LIMITS.profileVersion, PROFILE_VERSION);
    if (!["clean", "blocked"].includes(receipt.outcome)) fail("final-review receipt outcome is unsupported");

    exactKeys(receipt.lifecycle, LIFECYCLE_KEYS, "lifecycle");
    boundedString(receipt.lifecycle.lineageId, "lifecycle.lineageId", FINAL_REVIEW_RECEIPT_LIMITS.identifier, OPAQUE_ID);
    if (receipt.lifecycle.fresh !== true) fail("final-review lifecycle must begin with one fresh child");
    exactInteger(receipt.lifecycle.correctionCount, "lifecycle.correctionCount", 0, FINAL_REVIEW_RECEIPT_LIMITS.passes - 1);
    if (!Array.isArray(receipt.lifecycle.passes) || receipt.lifecycle.passes.length < 1 || receipt.lifecycle.passes.length > FINAL_REVIEW_RECEIPT_LIMITS.passes) fail("lifecycle.passes exceeds the initial-plus-two-corrections bound");
    if (receipt.lifecycle.correctionCount !== receipt.lifecycle.passes.length - 1) fail("lifecycle correction count does not match its complete pass history");
    const expected = { lineageId: receipt.lifecycle.lineageId, base: receipt.base, previousPass: undefined };
    for (let index = 0; index < receipt.lifecycle.passes.length; index += 1) validatePass(receipt.lifecycle.passes[index], expected, index);
    const latest = receipt.lifecycle.passes.at(-1);
    if (latest.head !== receipt.head || latest.packetSha256 !== receipt.packetSha256 || latest.acceptanceMatrixSha256 !== receipt.acceptanceMatrixSha256 || latest.verificationEvidenceSha256 !== receipt.verificationEvidenceSha256) {
      fail("final-review receipt is not bound to the latest complete packet, acceptance matrix, and verification evidence");
    }
    if (!receipt.revocation?.revoked && receipt.outcome !== latest.outcome) fail("final-review receipt outcome does not match the latest child pass");
    if (receipt.outcome === "clean" && latest.outcome !== "clean") fail("clean final-review receipt has a blocked latest pass");

    exactKeys(receipt.revocation, REVOCATION_KEYS, "revocation");
    if (typeof receipt.revocation.revoked !== "boolean") fail("revocation.revoked must be boolean");
    boundedNullableString(receipt.revocation.reason, "revocation.reason", FINAL_REVIEW_RECEIPT_LIMITS.reason);
    if (receipt.revocation.source !== null && !["final-child", "terra-parent", "head-change", "operator", "validation"].includes(receipt.revocation.source)) fail("revocation.source is unsupported");
    if (receipt.revocation.recordedAt !== null) canonicalTimestamp(receipt.revocation.recordedAt, "revocation.recordedAt");
    if (receipt.revocation.revoked) {
      if (!receipt.revocation.reason || !receipt.revocation.source || !receipt.revocation.recordedAt) fail("a revoked receipt requires a bounded reason, source, and timestamp");
      if (receipt.outcome !== "blocked") fail("a revoked receipt cannot have a clean outcome");
    } else if (receipt.revocation.reason !== null || receipt.revocation.source !== null || receipt.revocation.recordedAt !== null) {
      fail("an active receipt cannot carry revocation details");
    }
    if (receipt.receiptSha256 !== finalReviewReceiptSha256(receipt)) fail("final-review receipt digest does not match its canonical binding");
    digest(receipt.receiptSha256, "receiptSha256");

    const expectedValues = {
      repository: options.repository ?? options.expectedRepository,
      pullRequest: options.pullRequest ?? options.expectedPullRequest,
      nonce: options.nonce ?? options.expectedNonce,
      base: options.base ?? options.expectedBase,
      head: options.head ?? options.expectedHead ?? options.currentHead,
      packetSha256: options.packetSha256 ?? options.expectedPacketSha256,
      acceptanceMatrixSha256: options.acceptanceMatrixSha256 ?? options.expectedAcceptanceMatrixSha256,
      verificationEvidenceSha256: options.verificationEvidenceSha256 ?? options.expectedVerificationEvidenceSha256,
      reviewerModelId: options.reviewerModelId ?? options.expectedReviewerModelId,
      reviewProfileVersion: options.reviewProfileVersion ?? options.expectedReviewProfileVersion,
    };
    for (const [key, value] of Object.entries(expectedValues)) if (value !== undefined && receipt[key] !== value) fail(`final-review receipt ${key} does not match the exact expected value`);
    if (options.requireClean === true && (receipt.outcome !== "clean" || receipt.revocation.revoked || latest.outcome !== "clean")) fail("final-review receipt is not a current clean attestation");
    return { ok: true, errors: [], receipt, canonicalPayload: canonicalReceiptPayload(receipt), receiptSha256: receipt.receiptSha256, latestPass: latest };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "final-review receipt validation failed");
    return { ok: false, errors };
  }
}
export const validateFinalReviewReceiptV1 = validateFinalReviewReceipt;

export function assertValidFinalReviewReceipt(receipt, options = {}) {
  const result = validateFinalReviewReceipt(receipt, options);
  if (!result.ok) fail(result.errors[0]);
  return result;
}

function receiptObject(fields) {
  const receipt = {
    format: FINAL_REVIEW_RECEIPT_FORMAT,
    version: FINAL_REVIEW_RECEIPT_VERSION,
    repository: fields.repository,
    pullRequest: String(fields.pullRequest),
    nonce: fields.nonce,
    base: fields.base,
    head: fields.head,
    packetSha256: fields.packetSha256,
    acceptanceMatrixSha256: fields.acceptanceMatrixSha256,
    verificationEvidenceSha256: fields.verificationEvidenceSha256,
    reviewerModelId: fields.reviewerModelId,
    reviewProfileVersion: fields.reviewProfileVersion,
    outcome: fields.outcome ?? "clean",
    lifecycle: fields.lifecycle,
    revocation: fields.revocation ?? { revoked: false, reason: null, source: null, recordedAt: null },
  };
  return { ...receipt, receiptSha256: finalReviewReceiptSha256(receipt) };
}

/** Build a canonical initial receipt or a complete resumed receipt. */
export function createFinalReviewReceipt({
  repository, pullRequest, nonce = randomBytes(16).toString("hex"), base, head, packetSha256, acceptanceMatrixSha256,
  verificationEvidenceSha256, reviewerModelId, reviewProfileVersion,
  lineageId, recordedAt = new Date().toISOString(), outcome = "clean",
  blockerCount = 0, highCount = 0,
}) {
  const lineage = lineageId ?? `child-${randomBytes(16).toString("hex")}`;
  const lifecycle = {
    lineageId: lineage,
    fresh: true,
    correctionCount: 0,
    passes: [{
      index: 0, kind: "initial", lineageId: lineage, base, head, packetSha256,
      acceptanceMatrixSha256, verificationEvidenceSha256, outcome, blockerCount,
      highCount, recordedAt,
    }],
  };
  return receiptObject({ repository, pullRequest, nonce, base, head, packetSha256, acceptanceMatrixSha256, verificationEvidenceSha256, reviewerModelId, reviewProfileVersion, outcome, lifecycle });
}

/** Revoke a clean receipt without changing HEAD; the new digest is distinct. */
export function revokeFinalReviewReceipt(receipt, { reason, source = "terra-parent", recordedAt = new Date().toISOString() } = {}) {
  assertValidFinalReviewReceipt(receipt);
  boundedString(reason, "revocation.reason", FINAL_REVIEW_RECEIPT_LIMITS.reason);
  if (!["final-child", "terra-parent", "head-change", "operator", "validation"].includes(source)) fail("revocation.source is unsupported");
  const revoked = { ...receipt, outcome: "blocked", revocation: { revoked: true, reason, source, recordedAt } };
  return { ...revoked, receiptSha256: finalReviewReceiptSha256(revoked) };
}

/** Append one complete same-child correction pass. A replacement child is not accepted. */
export function resumeFinalReviewReceipt(receipt, {
  head, packetSha256, acceptanceMatrixSha256, verificationEvidenceSha256,
  outcome = "clean", blockerCount = 0, highCount = 0,
  recordedAt = new Date().toISOString(),
}) {
  const current = assertValidFinalReviewReceipt(receipt).receipt;
  if (current.lifecycle.correctionCount >= FINAL_REVIEW_RECEIPT_LIMITS.passes - 1) fail("final-review correction limit exhausted; a third correction or replacement child is blocked");
  const previous = current.lifecycle.passes.at(-1);
  const pass = {
    index: current.lifecycle.passes.length,
    kind: "resume",
    lineageId: current.lifecycle.lineageId,
    base: current.base,
    head,
    packetSha256,
    acceptanceMatrixSha256,
    verificationEvidenceSha256,
    outcome,
    blockerCount,
    highCount,
    recordedAt,
  };
  if (head === previous.head) fail("a correction must bind a newly frozen exact head");
  if (packetSha256 === previous.packetSha256 && acceptanceMatrixSha256 === previous.acceptanceMatrixSha256 && verificationEvidenceSha256 === previous.verificationEvidenceSha256) fail("a correction must bind a newly frozen complete input set");
  const next = {
    ...current,
    head,
    packetSha256,
    acceptanceMatrixSha256,
    verificationEvidenceSha256,
    outcome,
    lifecycle: { ...current.lifecycle, correctionCount: current.lifecycle.correctionCount + 1, passes: [...current.lifecycle.passes, pass] },
    revocation: { revoked: false, reason: null, source: null, recordedAt: null },
  };
  return { ...next, receiptSha256: finalReviewReceiptSha256(next) };
}
export const appendFinalReviewCorrection = resumeFinalReviewReceipt;

function markerObject(receipt) {
  return {
    format: FINAL_REVIEW_ATTESTATION_FORMAT,
    version: 3,
    base: receipt.base,
    head: receipt.head,
    outcome: "clean",
    packetSha256: receipt.packetSha256,
    acceptanceMatrixSha256: receipt.acceptanceMatrixSha256,
    verificationEvidenceSha256: receipt.verificationEvidenceSha256,
    reviewerModelId: receipt.reviewerModelId,
    reviewProfileVersion: receipt.reviewProfileVersion,
    receiptSha256: receipt.receiptSha256,
  };
}
export function createFinalReviewAttestation(receipt, options = {}) {
  const expected = {
    repository: options.repository ?? options.expectedRepository,
    pullRequest: options.pullRequest ?? options.expectedPullRequest,
    base: options.base ?? options.expectedBase,
    head: options.head ?? options.expectedHead,
    packetSha256: options.packetSha256 ?? options.expectedPacketSha256,
    acceptanceMatrixSha256: options.acceptanceMatrixSha256 ?? options.expectedAcceptanceMatrixSha256,
    verificationEvidenceSha256: options.verificationEvidenceSha256 ?? options.expectedVerificationEvidenceSha256,
  };
  if (Object.values(expected).some((value) => value === undefined)) fail("final-review marker rendering requires all exact frozen repository, PR, base/head, packet, acceptance-matrix, and verification-evidence bindings");
  const result = assertValidFinalReviewReceipt(receipt, { ...options, ...expected, requireClean: true });
  const marker = markerObject(result.receipt);
  return `<!-- ${MARKER_PREFIX}:v3 ${JSON.stringify(marker)} -->`;
}
export const renderFinalReviewAttestation = createFinalReviewAttestation;
export const finalReviewAttestationMarker = createFinalReviewAttestation;

export function parseFinalReviewAttestation(body) {
  boundedString(body, "body", 24 * 1024, undefined);
  RECEIPT_MARKER.lastIndex = 0;
  const markers = [...body.matchAll(RECEIPT_MARKER)];
  RECEIPT_MARKER.lastIndex = 0;
  const tagOccurrences = body.split(RECEIPT_TAG).length - 1;
  if (tagOccurrences === 0) return null;
  if (tagOccurrences !== 1 || markers.length !== 1) fail("final-review attestation marker must appear exactly once");
  const marker = parseStrictJson(markers[0][1], "final-review attestation marker");
  exactKeys(marker, MARKER_KEYS, "final-review attestation marker");
  if (marker.format !== FINAL_REVIEW_ATTESTATION_FORMAT || marker.version !== 3) fail("final-review attestation marker format or version is unsupported");
  commit(marker.base, "marker.base"); commit(marker.head, "marker.head");
  if (marker.outcome !== "clean") fail("final-review attestation marker outcome must be clean");
  digest(marker.packetSha256, "marker.packetSha256");
  digest(marker.acceptanceMatrixSha256, "marker.acceptanceMatrixSha256");
  digest(marker.verificationEvidenceSha256, "marker.verificationEvidenceSha256");
  digest(marker.receiptSha256, "marker.receiptSha256");
  boundedString(marker.reviewerModelId, "marker.reviewerModelId", FINAL_REVIEW_RECEIPT_LIMITS.modelId, MODEL_ID);
  boundedString(marker.reviewProfileVersion, "marker.reviewProfileVersion", FINAL_REVIEW_RECEIPT_LIMITS.profileVersion, PROFILE_VERSION);
  return marker;
}

export async function readBoundedRegularFile(path, { maximum = FINAL_REVIEW_RECEIPT_LIMITS.inputBytes } = {}) {
  if (typeof path !== "string" || !path || path.includes("\0")) fail("input path is missing or unsafe");
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > maximum) fail("input must be a bounded regular file");
  const bytes = await readFile(path);
  if (bytes.length > maximum) fail("input changed beyond its fixed byte bound");
  return bytes;
}
export async function digestRegularFile(path, { maximum = FINAL_REVIEW_RECEIPT_LIMITS.inputBytes } = {}) {
  return digestBytes(await readBoundedRegularFile(path, { maximum }));
}

export async function frozenInputDigests({ base, head, packet, acceptanceMatrix, verificationEvidence, cwd = process.cwd() } = {}) {
  if (packet === undefined || acceptanceMatrix === undefined || verificationEvidence === undefined) fail("final review requires packet, acceptance matrix, and verification evidence");
  const packetResult = await assertValidReviewPacketAgainstGit(packet, { base, head, cwd });
  const matrixBytes = Buffer.isBuffer(acceptanceMatrix) ? acceptanceMatrix : Buffer.from(String(acceptanceMatrix), "utf8");
  const evidenceBytes = Buffer.isBuffer(verificationEvidence) ? verificationEvidence : Buffer.from(String(verificationEvidence), "utf8");
  if (matrixBytes.length > FINAL_REVIEW_RECEIPT_LIMITS.inputBytes || evidenceBytes.length > FINAL_REVIEW_RECEIPT_LIMITS.inputBytes) fail("final review input exceeds its fixed bound");
  return {
    packetSha256: packetResult.packetSha256,
    acceptanceMatrixSha256: digestBytes(matrixBytes),
    verificationEvidenceSha256: digestBytes(evidenceBytes),
  };
}

function cliArguments(argv) {
  const names = new Map([
    ["--receipt", "receipt"], ["--base", "base"], ["--head", "head"],
    ["--repository", "repository"], ["--pull-request", "pullRequest"],
    ["--packet", "packet"], ["--acceptance-matrix", "acceptanceMatrix"],
    ["--verification-evidence", "verificationEvidence"], ["--emit-marker", "emitMarker"],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key || Object.hasOwn(options, key)) fail("expected each supported option at most once");
    if (key === "emitMarker") { options[key] = true; continue; }
    if (index + 1 >= argv.length) fail(`${argv[index]} requires a value`);
    options[key] = argv[++index];
  }
  if (!options.receipt) fail("--receipt is required");
  return options;
}

async function main() {
  try {
    const options = cliArguments(process.argv.slice(2));
    if (options.emitMarker && (!options.base || !options.head || !options.repository || !options.pullRequest || !options.packet || !options.acceptanceMatrix || !options.verificationEvidence)) {
      fail("--emit-marker requires exact --repository, --pull-request, --base, --head, --packet, --acceptance-matrix, and --verification-evidence inputs");
    }
    const bytes = await readBoundedRegularFile(options.receipt, { maximum: FINAL_REVIEW_RECEIPT_LIMITS.receiptBytes });
    const receipt = parseStrictJson(bytes.toString("utf8"), "final-review receipt");
    const expected = { repository: options.repository, pullRequest: options.pullRequest, base: options.base, head: options.head };
    if (options.packet) {
      expected.packetSha256 = (await assertValidReviewPacketAgainstGit(await readBoundedRegularFile(options.packet), { base: options.base, head: options.head })).packetSha256;
    }
    if (options.acceptanceMatrix) expected.acceptanceMatrixSha256 = await digestRegularFile(options.acceptanceMatrix);
    if (options.verificationEvidence) expected.verificationEvidenceSha256 = await digestRegularFile(options.verificationEvidence);
    const result = assertValidFinalReviewReceipt(receipt, { ...expected, requireClean: Boolean(options.emitMarker) });
    if (options.emitMarker) console.log(createFinalReviewAttestation(result.receipt, expected));
    else console.log(`Final review receipt validated (${result.receiptSha256}).`);
  } catch (error) {
    console.error(`final-review-receipt: ${error instanceof Error ? error.message : "validation failed"}`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
