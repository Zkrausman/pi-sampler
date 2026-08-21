import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const WAIVER_SCHEMA_VERSION = "delivery-waiver/v1";
export const TRUST_SCHEMA_VERSION = "delivery-waiver-trust/v1";
export const REPLAY_SCHEMA_VERSION = "delivery-waiver-replay/v1";
export const MAX_WAIVER_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_JSON_BYTES = 256 * 1024;
const SHA_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const TICKET_RE = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/;
const ROW_RE = /^A[0-9]{1,9}-T[0-9]{2,4}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const WAIVER_ID_RE = /^waiver-[a-z0-9][a-z0-9-]{0,95}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function fail(message) {
  throw new Error(message);
}

class StrictJsonParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
    this.values = 0;
  }

  parse() {
    if (Buffer.byteLength(this.text, "utf8") > MAX_JSON_BYTES) fail("JSON payload exceeds the waiver bound");
    const value = this.value(0);
    this.space();
    if (this.index !== this.text.length) fail("JSON payload contains trailing data");
    return value;
  }

  space() {
    while (this.index < this.text.length && " \t\r\n".includes(this.text[this.index])) this.index += 1;
  }

  value(depth) {
    if (depth > 32) fail("JSON nesting exceeds the waiver bound");
    this.values += 1;
    if (this.values > 100_000) fail("JSON value count exceeds the waiver bound");
    this.space();
    const character = this.text[this.index];
    if (character === "{") return this.object(depth + 1);
    if (character === "[") return this.array(depth + 1);
    if (character === '"') return this.string();
    if (this.text.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.text.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.text.startsWith("null", this.index)) { this.index += 4; return null; }
    const match = this.text.slice(this.index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) fail("malformed JSON value");
    this.index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail("JSON number is not finite");
    return number;
  }

  string() {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const character = this.text[this.index++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        try {
          return JSON.parse(this.text.slice(start, this.index));
        } catch {
          fail("malformed JSON string");
        }
      } else if (character.charCodeAt(0) < 0x20) {
        fail("JSON string contains a control character");
      }
    }
    fail("unterminated JSON string");
  }

  object(depth) {
    const result = Object.create(null);
    const keys = new Set();
    let entries = 0;
    this.index += 1;
    this.space();
    if (this.text[this.index] === "}") { this.index += 1; return result; }
    for (;;) {
      entries += 1;
      if (entries > 256) fail("JSON object exceeds the waiver bound");
      this.space();
      if (this.text[this.index] !== '"') fail("JSON object key is not a string");
      const key = this.string();
      if (keys.has(key)) fail(`duplicate JSON object key ${key}`);
      keys.add(key);
      this.space();
      if (this.text[this.index++] !== ":") fail("JSON object key lacks a value");
      result[key] = this.value(depth);
      this.space();
      const separator = this.text[this.index++];
      if (separator === "}") return result;
      if (separator !== ",") fail("JSON object is not separated correctly");
    }
  }

  array(depth) {
    const result = [];
    this.index += 1;
    this.space();
    if (this.text[this.index] === "]") { this.index += 1; return result; }
    for (;;) {
      if (result.length >= 1024) fail("JSON array exceeds the waiver bound");
      result.push(this.value(depth));
      this.space();
      const separator = this.text[this.index++];
      if (separator === "]") return result;
      if (separator !== ",") fail("JSON array is not separated correctly");
    }
  }
}

export function parseStrictJson(text) {
  if (typeof text !== "string") fail("JSON input must be text");
  return new StrictJsonParser(text).parse();
}

function keysExactly(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("JSON object required");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`unknown JSON field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`missing JSON field ${key}`);
}

function stringField(value, field, { pattern, max = 4096, min = 1 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max || (pattern && !pattern.test(value))) fail(`${field} is invalid`);
  return value;
}

function integerField(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${field} is invalid`);
  return value;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) fail("canonical JSON number is not finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function waiverSigningPayload(waiver) {
  const payload = { ...waiver };
  delete payload.signature;
  return Buffer.from(stableJson(payload), "utf8");
}

function digestJson(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function pathInside(root, candidate) {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(value));
}

async function externalFile(filePath, repositoryRoot, label, { mustExist = true } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) fail(`${label} is required`);
  const absolute = resolve(filePath);
  const root = await realpath(resolve(repositoryRoot));
  const candidate = await realpath(absolute).catch(() => absolute);
  if (pathInside(root, candidate)) fail(`${label} must be outside the candidate repository`);
  const info = await lstat(absolute).catch((error) => {
    if (!mustExist && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) {
    await realpath(dirname(absolute));
    return absolute;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) fail(`${label} is not a bounded regular file`);
  return absolute;
}

function validateWaiverShape(waiver) {
  keysExactly(waiver, ["schema_version", "waiver_id", "issuer", "key_id", "repository", "ticket_id", "pull_request", "row_id", "plan_sha256", "rationale", "issue", "nonce", "issued_at", "expires_at", "revocation_ref", "signature"]);
  stringField(waiver.schema_version, "schema_version");
  if (waiver.schema_version !== WAIVER_SCHEMA_VERSION) fail("unsupported waiver schema_version");
  stringField(waiver.waiver_id, "waiver_id", { pattern: WAIVER_ID_RE, max: 104 });
  stringField(waiver.issuer, "issuer", { pattern: /^[A-Za-z0-9][A-Za-z0-9._@:/ -]{0,127}$/ });
  stringField(waiver.key_id, "key_id", { pattern: IDENTIFIER_RE });
  stringField(waiver.repository, "repository", { pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/ });
  stringField(waiver.ticket_id, "ticket_id", { pattern: TICKET_RE, max: 64 });
  keysExactly(waiver.pull_request, ["number", "base_sha", "head_sha"]);
  integerField(waiver.pull_request.number, "pull_request.number", 1, 1_000_000_000);
  stringField(waiver.pull_request.base_sha, "pull_request.base_sha", { pattern: SHA_RE, max: 64 });
  stringField(waiver.pull_request.head_sha, "pull_request.head_sha", { pattern: SHA_RE, max: 64 });
  stringField(waiver.row_id, "row_id", { pattern: ROW_RE, max: 32 });
  stringField(waiver.plan_sha256, "plan_sha256", { pattern: DIGEST_RE, max: 64 });
  stringField(waiver.rationale, "rationale", { max: 4096 });
  stringField(waiver.issue, "issue", { pattern: TICKET_RE, max: 64 });
  stringField(waiver.nonce, "nonce", { pattern: NONCE_RE, max: 128 });
  stringField(waiver.issued_at, "issued_at", { max: 64 });
  stringField(waiver.expires_at, "expires_at", { max: 64 });
  stringField(waiver.revocation_ref, "revocation_ref", { pattern: IDENTIFIER_RE, max: 256 });
  stringField(waiver.signature, "signature", { pattern: /^[A-Za-z0-9_-]{80,128}$/, max: 128 });
}

function validateTrustConfig(config) {
  keysExactly(config, ["schema_version", "keys", "revoked_refs"]);
  if (config.schema_version !== TRUST_SCHEMA_VERSION || !Array.isArray(config.keys) || config.keys.length < 1 || config.keys.length > 32 || !Array.isArray(config.revoked_refs) || config.revoked_refs.length > 256) fail("trusted waiver configuration is invalid");
  const ids = new Set();
  for (const key of config.keys) {
    keysExactly(key, ["key_id", "issuer", "algorithm", "public_key", "revoked"]);
    stringField(key.key_id, "trusted key_id", { pattern: IDENTIFIER_RE });
    stringField(key.issuer, "trusted issuer", { max: 128 });
    if (key.algorithm !== "ed25519") fail("trusted waiver algorithm must be ed25519");
    stringField(key.public_key, "trusted public_key", { max: 8192 });
    if (typeof key.revoked !== "boolean" || ids.has(key.key_id)) fail("trusted waiver key list is invalid");
    ids.add(key.key_id);
    try { createPublicKey(key.public_key); } catch { try { createPublicKey({ key: Buffer.from(key.public_key, "base64"), format: "der", type: "spki" }); } catch { fail("trusted public_key is invalid"); } }
  }
  const refs = new Set();
  for (const ref of config.revoked_refs) {
    stringField(ref, "trusted revocation reference", { pattern: IDENTIFIER_RE });
    if (refs.has(ref)) fail("trusted revocation references are duplicated");
    refs.add(ref);
  }
  return { ids, refs };
}

function publicKeyFor(key) {
  try { return createPublicKey(key.public_key); } catch { return createPublicKey({ key: Buffer.from(key.public_key, "base64"), format: "der", type: "spki" }); }
}

function assertBinding(waiver, { repository, ticket, row, plan, base, head, pr }) {
  if (repository && waiver.repository !== repository) fail("waiver repository binding mismatch");
  if (ticket && waiver.ticket_id !== ticket) fail("waiver ticket binding mismatch");
  if (row && waiver.row_id !== row) fail("waiver row binding mismatch");
  if (plan && waiver.plan_sha256 !== plan) fail("waiver plan binding mismatch");
  if (base && waiver.pull_request.base_sha !== base) fail("waiver base binding mismatch");
  if (head && waiver.pull_request.head_sha !== head) fail("waiver head binding mismatch");
  if (pr && waiver.pull_request.number !== pr) fail("waiver pull request binding mismatch");
}

export function verifyWaiver(waiver, config, { now = new Date(), repository, ticket, row, plan, base, head, pr } = {}) {
  validateWaiverShape(waiver);
  const { refs } = validateTrustConfig(config);
  assertBinding(waiver, { repository, ticket, row, plan, base, head, pr });
  const key = config.keys.find((candidate) => candidate.key_id === waiver.key_id);
  if (!key || key.revoked || key.issuer !== waiver.issuer || refs.has(waiver.revocation_ref)) fail("waiver issuer, key, or revocation reference is not trusted");
  const issued = Date.parse(waiver.issued_at);
  const expires = Date.parse(waiver.expires_at);
  const current = new Date(now).getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > expires || issued > current + MAX_FUTURE_SKEW_MS || expires <= current || expires - issued > MAX_WAIVER_AGE_MS) fail("waiver is expired, future-dated, or too long-lived");
  let signature;
  try { signature = Buffer.from(waiver.signature, "base64url"); } catch { fail("waiver signature is not base64url"); }
  if (signature.length !== 64 || !verify(null, waiverSigningPayload(waiver), publicKeyFor(key), signature)) fail("waiver signature verification failed");
  return { waiverDigest: digestJson(waiver), keyId: key.key_id };
}

async function consumeNonce(replayPath, repositoryRoot, waiver, now) {
  const target = await externalFile(replayPath, repositoryRoot, "waiver replay state", { mustExist: false });
  const lockPath = `${target}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch(() => fail("waiver replay state is busy or unavailable"));
  await lock.close();
  try {
    let state = { schema_version: REPLAY_SCHEMA_VERSION, consumed: [] };
    const existing = await readFile(target, "utf8").catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (existing !== undefined) {
      state = parseStrictJson(existing);
      keysExactly(state, ["schema_version", "consumed"]);
      if (state.schema_version !== REPLAY_SCHEMA_VERSION || !Array.isArray(state.consumed) || state.consumed.length > 10_000) fail("waiver replay state is invalid");
    }
    const seen = new Set();
    for (const entry of state.consumed) {
      keysExactly(entry, ["nonce", "waiver_id", "consumed_at"]);
      stringField(entry.nonce, "replay nonce", { pattern: NONCE_RE });
      stringField(entry.waiver_id, "replay waiver_id", { pattern: WAIVER_ID_RE });
      stringField(entry.consumed_at, "replay consumed_at", { max: 64 });
      if (seen.has(entry.nonce)) fail("waiver replay state contains a duplicate nonce");
      seen.add(entry.nonce);
    }
    if (seen.has(waiver.nonce)) fail("delivery waiver nonce has already been consumed");
    state.consumed.push({ nonce: waiver.nonce, waiver_id: waiver.waiver_id, consumed_at: new Date(now).toISOString() });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(lockPath, { force: true }));
  }
}

export async function validateDeliveryWaiver({ waiverPath, trustConfigPath, replayStatePath, repositoryRoot = process.cwd(), now = new Date(), verifyOnly = false, ...bindings }) {
  const waiverFile = await externalFile(waiverPath, repositoryRoot, "delivery waiver");
  const trustFile = await externalFile(trustConfigPath, repositoryRoot, "trusted waiver configuration");
  const text = await readFile(waiverFile, "utf8");
  const waiver = parseStrictJson(text);
  const config = parseStrictJson(await readFile(trustFile, "utf8"));
  const result = verifyWaiver(waiver, config, { now, ...bindings });
  if (!verifyOnly) {
    if (!replayStatePath) fail("waiver replay state is required");
    await consumeNonce(replayStatePath, repositoryRoot, waiver, now);
  }
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--") || index + 1 >= argv.length) fail(`${argument} requires a value`);
    options[argument.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  return options;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const required = ["waiver", "trust_config", "repository", "ticket", "row", "plan", "base", "head", "pr"];
    for (const key of required) if (args[key] === undefined) fail(`--${key.replaceAll("_", "-")} is required`);
    const result = await validateDeliveryWaiver({
      waiverPath: args.waiver,
      trustConfigPath: args.trust_config,
      replayStatePath: args.replay_state,
      repositoryRoot: args.repo_root ?? process.cwd(),
      verifyOnly: args.verify_only === "true",
      repository: args.repository,
      ticket: args.ticket,
      row: args.row,
      plan: args.plan,
      base: args.base,
      head: args.head,
      pr: integerField(Number(args.pr), "pull request", 1, 1_000_000_000),
    });
    console.log(`delivery waiver valid (key=${result.keyId}, digest=${result.waiverDigest})`);
  } catch (error) {
    console.error(`delivery-waiver: ${error instanceof Error ? error.message : "invalid"}`);
    process.exitCode = 1;
  }
}
