import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "../contracts/lesson-v1.mjs";
import { lessonAdmissionAuthorityId, lessonAdmissionBindingDigest } from "./episode-evolution-ledger.mjs";

export const LESSON_AUTHORITY_FILE = ".lesson-registry-authority.json";
const AUTHORITY_B64 = /^[A-Za-z0-9+/]+={0,2}$/;
export class LessonRegistryAuthorityError extends Error {
  constructor(code, message) { super(message); this.name = "LessonRegistryAuthorityError"; this.code = code; }
}

function authorityPayload(authority) {
  return { format: 1, algorithm: "ed25519", publicKey: authority.publicKey, privateKey: authority.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
}
function parseAuthority(payload) {
  if (!payload || payload.format !== 1 || payload.algorithm !== "ed25519" || typeof payload.publicKey !== "string" || !AUTHORITY_B64.test(payload.publicKey) || typeof payload.privateKey !== "string" || !AUTHORITY_B64.test(payload.privateKey) || payload.publicKey.length > 1024 || payload.privateKey.length > 4096) throw new LessonRegistryAuthorityError("lesson_admission_authority_invalid", "lesson registry authority is invalid");
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(payload.privateKey, "base64"), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey({ key: Buffer.from(payload.publicKey, "base64"), format: "der", type: "spki" });
    if (publicKey.export({ type: "spki", format: "der" }).toString("base64") !== payload.publicKey || createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64") !== payload.publicKey) throw new Error("authority binding mismatch");
    return Object.freeze({ publicKey: payload.publicKey, privateKey, authorityId: lessonAdmissionAuthorityId(payload.publicKey) });
  } catch { throw new LessonRegistryAuthorityError("lesson_admission_authority_invalid", "lesson registry authority is invalid"); }
}
export function generateAuthority() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "der" } });
  return parseAuthority({ format: 1, algorithm: "ed25519", publicKey: publicKey.toString("base64"), privateKey: privateKey.toString("base64") });
}
export async function readAuthorityPath(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === "ENOENT") return { path, authority: undefined }; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new LessonRegistryAuthorityError("lesson_admission_authority_invalid", "lesson registry authority file is unsafe");
  let payload; try { payload = JSON.parse(await readFile(path, "utf8")); } catch { throw new LessonRegistryAuthorityError("lesson_admission_authority_invalid", "lesson registry authority file is invalid"); }
  return { path, authority: parseAuthority(payload) };
}
export async function readAuthority(root) { return readAuthorityPath(join(resolve(root), LESSON_AUTHORITY_FILE)); }
export async function writeAuthority(path, authority) {
  const body = canonicalJson(authorityPayload(authority));
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    finally { await handle.close(); }
    try {
      const directory = await open(resolve(path, ".."), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { if (!["EINVAL", "EPERM", "EISDIR"].includes(error.code)) throw error; }
  } catch (error) {
    if (error.code !== "EEXIST") throw new LessonRegistryAuthorityError("lesson_admission_authority_invalid", "lesson registry authority could not be persisted");
    const existing = await readAuthorityPath(path);
    if (!existing.authority || existing.authority.publicKey !== authority.publicKey || existing.authority.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") !== authority.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")) throw new LessonRegistryAuthorityError("lesson_admission_authority_conflict", "lesson registry authority was replaced");
  }
}
export async function authorityForRoot(root, durablePublicKey) {
  const loaded = await readAuthority(root);
  const authority = loaded.authority ?? generateAuthority();
  if (durablePublicKey !== undefined && durablePublicKey !== authority.publicKey) throw new LessonRegistryAuthorityError("lesson_admission_authority_conflict", "registry authority does not match the durable ledger authority");
  return { ...loaded, authority, created: loaded.authority === undefined };
}
export function authorityPayloadForBackup(authority) { return canonicalJson(authorityPayload(authority)); }
export async function backupRegistryLedger(ledger, authority, options = {}) {
  const result = await ledger.backup(options), archive = resolve(result.path), authorityPath = `${archive}.${LESSON_AUTHORITY_FILE}`;
  const authorityBody = authorityPayloadForBackup(authority), authorityBytes = Buffer.byteLength(authorityBody);
  if (Number.isSafeInteger(options.maxBytes) && result.bytes + authorityBytes > options.maxBytes) throw new LessonRegistryAuthorityError("backup_limit_exceeded", "registry authority would exceed the requested backup byte bound");
  await writeAuthority(authorityPath, authority);
  return { ...result, registryAuthorityPath: authorityPath, bytes: result.bytes + authorityBytes };
}
export function signedLessonAdmission(authority, envelope) {
  const binding = lessonAdmissionBindingDigest(envelope);
  return { version: 1, algorithm: "ed25519", authority: authority.authorityId, binding, signature: sign(null, Buffer.from(binding), authority.privateKey).toString("base64url") };
}
