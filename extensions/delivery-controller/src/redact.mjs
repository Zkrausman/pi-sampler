import { createHash } from "node:crypto";

const SECRET_KEYS = new Set(["token", "secret", "password", "apikey", "api_key", "authorization", "bearer"]);
const SECRET_PATTERN = /["']?(api[_-]?key|secret|password|token|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"']+)/gi;
const BEARER_PATTERN = /["']?authorization["']?\s*[:=]\s*(?:"bearer\s+[^"]*"|'bearer\s+[^']*'|bearer\s+[^\s"']+)/gi;
const JULES_KEY_PATTERN = /X-Goog-Api-Key\s*[:=]\s*["']?[^"'\s]+["']?/gi;

export function redactText(value) {
  if (typeof value !== "string") return value;
  let out = value;
  out = out.replace(SECRET_PATTERN, (match) => {
    const key = match.split(/[:=]/)[0].trim();
    return `${key}=[REDACTED]`;
  });
  out = out.replace(BEARER_PATTERN, (match) => {
    const key = match.split(/[:=]/)[0].trim();
    return `${key} [REDACTED]`;
  });
  out = out.replace(JULES_KEY_PATTERN, (match) => {
    const key = match.split(/[:=]/)[0].trim();
    return `${key}=[REDACTED]`;
  });
  return out;
}

export function redactObject(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const lower = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const isSecretKey = [...SECRET_KEYS].some((secret) => lower.includes(secret));
      if (isSecretKey) {
        out[key] = "[REDACTED]";
      } else if (lower === "xgoogapikey") {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactObject(val);
      }
    }
    return out;
  }
  return value;
}

export function sha256Hex(value) {
  const input = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(input).digest("hex");
}

export function digestRedacted(value) {
  const redacted = redactObject(value);
  return sha256Hex(JSON.stringify(redacted));
}

export function evidenceEntry(ref, content) {
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const digest = typeof content === "string" && /^[a-f0-9]{64}$/.test(content) ? content : sha256Hex(typeof content === "string" ? content : JSON.stringify(redactObject(content)));
  if (!ID.test(ref)) throw new Error(`invalid_evidence_ref:${ref}`);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid_digest");
  return { ref, sha256: digest };
}

export function containsSecret(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (/(api[_-]?key|secret|password|token)\s*[:=]/i.test(text) && !text.includes("[REDACTED]")) return true;
  if (/bearer\s+[A-Za-z0-9_\-\.]+/i.test(text) && !text.includes("[REDACTED]")) return true;
  if (/X-Goog-Api-Key/i.test(text) && !text.includes("[REDACTED]")) return true;
  return false;
}
