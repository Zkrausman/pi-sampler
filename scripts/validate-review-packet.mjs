#!/usr/bin/env node
/** Strict bounded validation for canonical scoped review packet v3 JSON. */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  REVIEW_PACKET_LIMITS,
  generateReviewPacketV3,
  reconstructV3Hunk,
  safeChangedPath,
  serializeReviewPacketV3,
  splitTransportSegments,
} from "./generate-review-packet.mjs";

const LIMITS = REVIEW_PACKET_LIMITS;
const SHA = /^[0-9a-f]{40,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const V3_FORMAT = "pi-sampler.scoped-review-packet.v3";
const SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_ID = "https://pi-sampler.dev/schemas/scoped-review-packet-v3.json";
const SCHEMA_TITLE = "Pi Sampler scoped review packet v3";
const MAX_DEPTH = 32;
const MAX_NODES = 200_000;
const MAX_STRING_BYTES = 64 * 1024;
const ROOT_KEYS = ["format", "base", "head", "changedFiles", "diffStat", "patches", "incomplete", "omittedHunks", "byteTruncatedHunks", "immutableMaterial"];
const FILE_KEYS = ["path", "status"];
const PATCH_KEYS = ["path", "hunks"];
const HUNK_KEYS = ["header", "logicalLines"];
const LINE_KEYS = ["segments", "byteLength", "sha256"];

function fail(message) { throw new Error(`review-packet: ${message}`); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail(`${label} has unsupported, missing, or noncanonical fields`);
}
function utf8Bytes(value, label, maximum = MAX_STRING_BYTES, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(`${label} must be a bounded UTF-8 string`);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.toString("utf8") !== value) fail(`${label} is not valid UTF-8`);
  if (bytes.length > maximum || value.includes("\0")) fail(`${label} exceeds its fixed UTF-8 bound`);
  return bytes;
}
function safePath(value, label) {
  utf8Bytes(value, label, LIMITS.path, { allowEmpty: false });
  try { safeChangedPath(value); } catch { fail(`${label} is unsafe or unsupported`); }
  return value;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

class StrictJsonParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
    this.nodes = 0;
  }
  parse() {
    this.skipWhitespace();
    const value = this.value(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) fail("packet contains trailing data");
    return value;
  }
  skipWhitespace() {
    while (this.index < this.text.length && " \t\r\n".includes(this.text[this.index])) this.index += 1;
  }
  value(depth) {
    if (++this.nodes > MAX_NODES) fail("packet exceeds its node bound");
    if (depth > MAX_DEPTH) fail("packet exceeds its JSON depth bound");
    const character = this.text[this.index];
    if (character === "{") return this.object(depth + 1);
    if (character === "[") return this.array(depth + 1);
    if (character === '"') return this.string();
    if (character === "t" && this.text.startsWith("true", this.index)) { this.index += 4; return true; }
    if (character === "f" && this.text.startsWith("false", this.index)) { this.index += 5; return false; }
    if (character === "n" && this.text.startsWith("null", this.index)) { this.index += 4; return null; }
    if (character === "-" || (character >= "0" && character <= "9")) return this.number();
    fail("packet contains malformed JSON");
  }
  object(depth) {
    this.index += 1;
    const object = Object.create(null);
    this.skipWhitespace();
    if (this.text[this.index] === "}") { this.index += 1; return object; }
    while (true) {
      if (this.text[this.index] !== '"') fail("packet object key is malformed");
      const key = this.string();
      if (Object.hasOwn(object, key)) fail("packet contains a duplicate object key");
      this.skipWhitespace();
      if (this.text[this.index] !== ":") fail("packet object is missing a colon");
      this.index += 1;
      this.skipWhitespace();
      object[key] = this.value(depth);
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "}") { this.index += 1; return object; }
      if (separator !== ",") fail("packet object is missing a separator");
      this.index += 1;
      this.skipWhitespace();
    }
  }
  array(depth) {
    this.index += 1;
    const array = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") { this.index += 1; return array; }
    while (true) {
      array.push(this.value(depth));
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "]") { this.index += 1; return array; }
      if (separator !== ",") fail("packet array is missing a separator");
      this.index += 1;
      this.skipWhitespace();
    }
  }
  string() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        const raw = this.text.slice(start, this.index);
        let value;
        try { value = JSON.parse(raw); } catch { fail("packet contains malformed JSON string"); }
        if (typeof value !== "string") fail("packet string is malformed");
        utf8Bytes(value, "packet string", MAX_STRING_BYTES);
        return value;
      }
      if (code < 0x20) fail("packet string contains an unescaped control character");
      if (code === 0x5c) {
        this.index += 1;
        const escaped = this.text[this.index];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.index + 1, this.index + 5))) fail("packet string contains an invalid Unicode escape");
          this.index += 5;
        } else if (!'"\\/bfnrt'.includes(escaped)) fail("packet string contains an invalid escape");
      }
      this.index += 1;
      if (this.index - start > MAX_STRING_BYTES * 2) fail("packet string exceeds its parser bound");
    }
    fail("packet string is unterminated");
  }
  number() {
    const start = this.index;
    if (this.text[this.index] === "-") this.index += 1;
    if (this.text[this.index] === "0") this.index += 1;
    else {
      if (!/[1-9]/.test(this.text[this.index] ?? "")) fail("packet number is malformed");
      while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    }
    if (this.text[this.index] === "." || this.text[this.index] === "e" || this.text[this.index] === "E") fail("packet numbers must be canonical safe integers");
    const raw = this.text.slice(start, this.index);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || (Object.is(value, -0))) fail("packet number is outside the safe integer bound");
    return value;
  }
}

function decodeInput(input) {
  let bytes;
  let originalText;
  if (Buffer.isBuffer(input)) {
    if (input.length > LIMITS.packet) fail(`packet exceeds the fixed ${LIMITS.packet}-byte bound`);
    bytes = input;
  } else if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > LIMITS.packet) fail(`packet exceeds the fixed ${LIMITS.packet}-byte bound`);
    originalText = input;
    bytes = Buffer.from(input, "utf8");
  } else fail("packet input must be UTF-8 text or a Buffer");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || (originalText !== undefined && text !== originalText)) fail("packet is not valid UTF-8");
  return { bytes, text };
}
function validateLine(line, path) {
  exactKeys(line, LINE_KEYS, `${path} logical line`);
  if (!Array.isArray(line.segments) || line.segments.length < 1 || line.segments.length > LIMITS.segments) fail(`${path} logical line segments exceed their bound`);
  let reconstructed = "";
  for (let index = 0; index < line.segments.length; index += 1) {
    const segment = line.segments[index];
    const bytes = utf8Bytes(segment, `${path} segment`, LIMITS.transportSegment, { allowEmpty: false });
    if (bytes.includes(0)) fail(`${path} segment contains unsupported bytes`);
    reconstructed += segment;
  }
  const lineBytes = Buffer.from(reconstructed, "utf8");
  const newlineCount = [...reconstructed].filter((character) => character === "\n").length;
  if (newlineCount > 1 || (newlineCount === 1 && !reconstructed.endsWith("\n"))) fail(`${path} logical line contains an embedded line ending`);
  if (!reconstructed || ![" ", "+", "-", "\\"].includes(reconstructed[0])) fail(`${path} is not a Git diff logical line`);
  const canonicalSegments = splitTransportSegments(reconstructed, path);
  if (canonicalSegments.length !== line.segments.length || canonicalSegments.some((segment, index) => segment !== line.segments[index])) fail(`${path} logical line segments are not the canonical v3 segmentation`);
  if (!Number.isSafeInteger(line.byteLength) || line.byteLength < 1 || line.byteLength !== lineBytes.length) fail(`${path} logical line byte length does not match its reconstruction`);
  if (typeof line.sha256 !== "string" || !DIGEST.test(line.sha256) || line.sha256 !== sha256(lineBytes)) fail(`${path} logical line digest does not match its reconstruction`);
  return lineBytes.length;
}
function validateHunk(hunk, path) {
  exactKeys(hunk, HUNK_KEYS, `${path} hunk`);
  utf8Bytes(hunk.header, `${path} hunk header`, 1024, { allowEmpty: false });
  if (!/^@@ -[0-9]+(?:,[0-9]+)? \+[0-9]+(?:,[0-9]+)? @@(?: .*)?$/.test(hunk.header) || hunk.header.includes("\n")) fail(`${path} hunk header is malformed`);
  if (!Array.isArray(hunk.logicalLines) || hunk.logicalLines.length < 1 || hunk.logicalLines.length > LIMITS.hunk) fail(`${path} logical lines exceed their bound`);
  let lineBytes = 0;
  for (let index = 0; index < hunk.logicalLines.length; index += 1) lineBytes += validateLine(hunk.logicalLines[index], `${path} logicalLines[${index}]`);
  const reconstructed = reconstructV3Hunk(hunk);
  const hunkBytes = Buffer.byteLength(reconstructed, "utf8");
  if (hunkBytes > LIMITS.hunk) fail(`${path} reconstructed hunk exceeds the fixed ${LIMITS.hunk}-byte bound`);
  if (lineBytes + Buffer.byteLength(hunk.header, "utf8") + 1 !== hunkBytes) fail(`${path} hunk reconstruction has inconsistent line bytes`);
  return hunkBytes;
}
function validatePacketObject(packet) {
  if (!isRecord(packet)) fail("packet root must be an object");
  const rootKeys = [...ROOT_KEYS, ...(Object.hasOwn(packet, "validationEvidence") ? ["validationEvidence"] : [])];
  exactKeys(packet, rootKeys, "packet root");
  if (packet.format !== V3_FORMAT) fail("packet format is not v3");
  utf8Bytes(packet.base, "packet base", 64, { allowEmpty: false });
  utf8Bytes(packet.head, "packet head", 64, { allowEmpty: false });
  if (!SHA.test(packet.base) || !SHA.test(packet.head)) fail("packet base and head must be exact lowercase commit IDs");
  if (!Array.isArray(packet.changedFiles) || packet.changedFiles.length > LIMITS.files) fail("packet changed-file list exceeds its bound");
  const changedPaths = [];
  for (let index = 0; index < packet.changedFiles.length; index += 1) {
    const file = packet.changedFiles[index];
    exactKeys(file, FILE_KEYS, `changedFiles[${index}]`);
    safePath(file.path, `changedFiles[${index}].path`);
    if (!/^[ADM]$/.test(file.status)) fail(`changedFiles[${index}] has an unsupported status`);
    changedPaths.push(file.path);
  }
  if (new Set(changedPaths).size !== changedPaths.length) fail("packet changed-file list contains duplicate paths");
  utf8Bytes(packet.diffStat, "packet diffStat", LIMITS.stat);
  if (!Array.isArray(packet.patches) || packet.patches.length !== changedPaths.length) fail("packet patches do not exactly cover changed files");
  let aggregate = 0;
  for (let index = 0; index < packet.patches.length; index += 1) {
    const patch = packet.patches[index];
    exactKeys(patch, PATCH_KEYS, `patches[${index}]`);
    if (patch.path !== changedPaths[index]) fail(`patches[${index}] is out of changed-file order or has an unknown path`);
    if (!Array.isArray(patch.hunks) || patch.hunks.length < 1 || patch.hunks.length > LIMITS.hunks) fail(`patches[${index}] hunk list exceeds its bound`);
    let pathTotal = 0;
    for (let hunkIndex = 0; hunkIndex < patch.hunks.length; hunkIndex += 1) {
      const bytes = validateHunk(patch.hunks[hunkIndex], `patches[${index}].hunks[${hunkIndex}]`);
      pathTotal += bytes;
      aggregate += bytes;
      if (pathTotal > LIMITS.patch) fail(`patches[${index}] exceeds the fixed ${LIMITS.patch}-byte path bound`);
      if (aggregate > LIMITS.patches) fail(`packet exceeds the fixed ${LIMITS.patches}-byte aggregate patch bound`);
    }
  }
  if (packet.incomplete !== false) fail("packet must declare complete coverage");
  for (const field of ["omittedHunks", "byteTruncatedHunks", "immutableMaterial"]) {
    if (!Array.isArray(packet[field]) || packet[field].length !== 0) fail(`packet ${field} must be empty`);
  }
  if (Object.hasOwn(packet, "validationEvidence")) utf8Bytes(packet.validationEvidence, "packet validationEvidence", LIMITS.argument, { allowEmpty: false });
  return packet;
}
function validateCanonical(packet, text) {
  const canonical = serializeReviewPacketV3(packet);
  if (text !== undefined && canonical !== text) fail("packet bytes are not canonical v3 serialization");
  if (Buffer.byteLength(canonical, "utf8") > LIMITS.packet) fail(`packet exceeds the fixed ${LIMITS.packet}-byte bound`);
  return canonical;
}

function parsePacketInput(input, options = {}) {
  const decoded = typeof input === "string" || Buffer.isBuffer(input) ? decodeInput(input) : { text: undefined };
  const packet = decoded.text === undefined ? input : new StrictJsonParser(decoded.text).parse();
  return { packet, decodedText: decoded.text, canonicalText: options.canonicalText ?? decoded.text };
}
export function assertValidReviewPacketStructure(packet, { canonicalText } = {}) {
  validatePacketObject(packet);
  const canonical = validateCanonical(packet, canonicalText);
  return { packet, canonical, packetSha256: sha256(Buffer.from(canonical, "utf8")) };
}
function assertValidPacketInput(input, options = {}) {
  const parsed = parsePacketInput(input, options);
  return assertValidReviewPacketStructure(parsed.packet, { canonicalText: parsed.canonicalText });
}
function trustedDigestOption(options = {}) {
  const candidates = [options.trustedPacketSha256, options.trustedDigest, options.packetSha256, options.digest].filter((value) => value !== undefined);
  if (new Set(candidates).size > 1) fail("trusted packet digest options disagree");
  return candidates[0];
}
function assertTrustedPacketDigest(result, expectedDigest) {
  if (typeof expectedDigest !== "string" || !DIGEST.test(expectedDigest)) fail("a trusted packet digest is required");
  if (result.packetSha256 !== expectedDigest) fail("packet digest does not match the trusted v3 packet digest");
  return result;
}
/** Structural parsing is available for inspecting untrusted input; callers must use a trust binding before accepting it. */
export function validateReviewPacketStructure(input, options = {}) {
  try { return { ok: true, ...assertValidPacketInput(input, options) }; }
  catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : "review-packet: validation failed"] }; }
}
/** Validate a v3 packet against a caller-supplied trusted canonical packet digest. */
export function assertValidReviewPacket(packet, options = {}) {
  return assertTrustedPacketDigest(assertValidReviewPacketStructure(packet, options), trustedDigestOption(options));
}
export function validateReviewPacket(input, options = {}) {
  try { return { ok: true, ...assertTrustedPacketDigest(assertValidPacketInput(input, options), trustedDigestOption(options)) }; }
  catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : "review-packet: validation failed"] }; }
}
export function validateReviewPacketText(input, options = {}) { return validateReviewPacket(input, options); }

function trustedRef(value, label) {
  return utf8Bytes(value, `trusted ${label} ref`, LIMITS.ref, { allowEmpty: false }).toString("utf8");
}
/** Validate packet bytes against exact Git-derived v3 content for trusted expected refs. */
export async function assertValidReviewPacketAgainstGit(input, options = {}) {
  const { cwd = process.cwd() } = options;
  const base = trustedRef(options.base ?? options.expectedBase, "base");
  const head = trustedRef(options.head ?? options.expectedHead, "head");
  const result = assertValidPacketInput(input);
  const generatedOptions = { base, head };
  if (Object.hasOwn(result.packet, "validationEvidence")) generatedOptions.validation = result.packet.validationEvidence;
  const expected = await generateReviewPacketV3(generatedOptions, { cwd });
  const expectedCanonical = serializeReviewPacketV3(expected);
  if (result.packet.base !== expected.base || result.packet.head !== expected.head || result.canonical !== expectedCanonical) fail("packet content does not match the trusted Git-derived v3 packet");
  if (result.packetSha256 !== sha256(Buffer.from(expectedCanonical, "utf8"))) fail("packet digest does not match the trusted Git-derived v3 packet");
  return { ...result, trustedBinding: "git" };
}
export async function validateReviewPacketAgainstGit(input, options = {}) {
  try { return { ok: true, ...(await assertValidReviewPacketAgainstGit(input, options)) }; }
  catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : "review-packet: validation failed"] }; }
}
export const validateReviewPacketWithGit = validateReviewPacketAgainstGit;

async function readBoundedStream(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > LIMITS.packet) fail(`packet exceeds the fixed ${LIMITS.packet}-byte bound`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}
async function readBoundedFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > LIMITS.packet) fail("packet input file is missing, non-regular, or oversized");
  return readFile(path);
}
export function scopedReviewPacketV3Schema() {
  return {
    $schema: SCHEMA_DRAFT,
    $id: SCHEMA_ID,
    title: SCHEMA_TITLE,
    type: "object",
    additionalProperties: false,
    required: ["format", "base", "head", "changedFiles", "diffStat", "patches", "incomplete", "omittedHunks", "byteTruncatedHunks", "immutableMaterial"],
    properties: {
      format: { const: V3_FORMAT },
      base: { $ref: "#/$defs/commitSha" },
      head: { $ref: "#/$defs/commitSha" },
      changedFiles: { type: "array", maxItems: LIMITS.files, items: { $ref: "#/$defs/changedFile" } },
      diffStat: { type: "string", maxLength: LIMITS.stat },
      patches: { type: "array", maxItems: LIMITS.files, items: { $ref: "#/$defs/patch" } },
      incomplete: { const: false },
      omittedHunks: { type: "array", maxItems: 0, items: false },
      byteTruncatedHunks: { type: "array", maxItems: 0, items: false },
      immutableMaterial: { type: "array", maxItems: 0, items: false },
      validationEvidence: { type: "string", minLength: 1, maxLength: LIMITS.argument },
    },
    $defs: {
      commitSha: { type: "string", pattern: "^[0-9a-f]{40,64}$", minLength: 40, maxLength: 64 },
      changedFile: {
        type: "object",
        additionalProperties: false,
        required: ["path", "status"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: LIMITS.path },
          status: { enum: ["A", "D", "M"] },
        },
      },
      patch: {
        type: "object",
        additionalProperties: false,
        required: ["path", "hunks"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: LIMITS.path },
          hunks: { type: "array", minItems: 1, maxItems: LIMITS.hunks, items: { $ref: "#/$defs/hunk" } },
        },
      },
      hunk: {
        type: "object",
        additionalProperties: false,
        required: ["header", "logicalLines"],
        properties: {
          header: { type: "string", minLength: 1, maxLength: 1024 },
          logicalLines: { type: "array", minItems: 1, maxItems: LIMITS.hunk, items: { $ref: "#/$defs/logicalLine" } },
        },
      },
      logicalLine: {
        type: "object",
        additionalProperties: false,
        required: ["segments", "byteLength", "sha256"],
        properties: {
          segments: { type: "array", minItems: 1, maxItems: LIMITS.segments, items: { type: "string", minLength: 1, maxLength: LIMITS.transportSegment } },
          byteLength: { type: "integer", minimum: 1, maximum: LIMITS.hunk },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 },
        },
      },
    },
  };
}
export function assertValidReviewPacketSchema(schema) {
  const comparable = isRecord(schema) ? JSON.parse(JSON.stringify(schema)) : schema;
  if (!isDeepStrictEqual(comparable, scopedReviewPacketV3Schema())) fail("v3 schema does not match the full canonical contract");
  return schema;
}
async function validateSchema() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const path = join(root, "docs", "scoped-review-packet-v3.schema.json");
  const input = await readBoundedFile(path);
  const decoded = decodeInput(input);
  const schema = new StrictJsonParser(decoded.text).parse();
  assertValidReviewPacketSchema(schema);
  console.log("Scoped review packet v3 schema validated.");
}
function cliValue(value, label, maximum) {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) fail(`${label} is missing, unsafe, or exceeds its bound`);
  return value;
}
function parseCliArguments(argv) {
  if (argv.length % 2 || argv.length > 10) fail("expected supported option/value pairs");
  const options = {};
  const names = new Map([["--packet", "packetPath"], ["--base", "base"], ["--head", "head"], ["--digest", "digest"]]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || Object.hasOwn(options, key)) fail("expected each supported option at most once");
    options[key] = cliValue(argv[index + 1], argv[index], key === "packetPath" ? LIMITS.argument : key === "digest" ? 64 : LIMITS.ref);
  }
  if (options.base !== undefined || options.head !== undefined) {
    if (options.base === undefined || options.head === undefined || options.digest !== undefined) fail("trusted Git validation requires --base and --head, without --digest");
    return options;
  }
  if (options.digest === undefined) fail("supply trusted --base/--head refs or a trusted --digest");
  if (!DIGEST.test(options.digest)) fail("--digest must be a lowercase SHA-256 digest");
  return options;
}
async function main() {
  try {
    const argv = process.argv.slice(2);
    if (argv.length === 1 && argv[0] === "--schema") { await validateSchema(); return; }
    const options = parseCliArguments(argv);
    const input = options.packetPath === undefined ? await readBoundedStream(process.stdin) : await readBoundedFile(options.packetPath);
    const result = options.base === undefined
      ? validateReviewPacket(input, { trustedPacketSha256: options.digest })
      : await validateReviewPacketAgainstGit(input, { base: options.base, head: options.head, cwd: process.cwd() });
    if (!result.ok) fail(result.errors[0].replace(/^review-packet:\s*/, ""));
    console.log(`Scoped review packet v3 validated (${result.packetSha256}).`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "review-packet: validation failed"}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1]?.endsWith("validate-review-packet.mjs")) await main();
