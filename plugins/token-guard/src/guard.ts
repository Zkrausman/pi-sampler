import { createHash } from "node:crypto";

export interface GuardConfig { enabled: boolean; warnAfter: number; stopAfter?: number }
export interface GuardDecision { suspected: boolean; warn: boolean; stop: boolean; reason?: string }

const MAX_DEPTH = 8;
const MAX_NODES = 256;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_CANONICAL_BYTES = 64 * 1024;
const MAX_KEYS = 256;
const MAX_PENDING = 128;

type Pending = { callDigest?: string };

/**
 * Hashes a bounded canonical form without retaining the payload. Own-key
 * enumeration is the one engine/proxy operation that may do internal work
 * before yielding a key; we cap the keys retained and reject throwing objects.
 */
function digest(value: unknown): string | undefined {
  const hash = createHash("sha256");
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const add = (text: string): boolean => {
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_CANONICAL_BYTES - bytes) return false;
    bytes += size;
    hash.update(text);
    return true;
  };
  const keys = (input: object): string[] | undefined => {
    const result: string[] = [];
    for (const key in input) {
      if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
      if (result.length >= MAX_KEYS || Buffer.byteLength(key, "utf8") > MAX_STRING_BYTES) return undefined;
      // Sorting is performed only after the bounded key cap is established.
      result.push(key);
    }
    result.sort();
    return result;
  };
  const visit = (input: unknown, depth: number): boolean => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return false;
    if (input === null) return add("null");
    if (typeof input === "string") {
      // Check the source string before JSON.stringify creates an escaped copy.
      if (Buffer.byteLength(input, "utf8") > MAX_STRING_BYTES) return false;
      const encoded = JSON.stringify(input);
      return encoded !== undefined && add(`s${encoded}`);
    }
    if (typeof input === "number") return Number.isFinite(input) && add(`n${JSON.stringify(input)}`);
    if (typeof input === "boolean") return add(input ? "b1" : "b0");
    if (typeof input !== "object" || seen.has(input)) return false;
    seen.add(input);
    try {
      const record = input as Record<string, unknown>;
      const typeDescriptor = Object.getOwnPropertyDescriptor(record, "type");
      if (typeDescriptor && !("value" in typeDescriptor)) return false;
      if (typeDescriptor?.value === "image" || typeDescriptor?.value === "input_image") return false;
      if (!add(Array.isArray(input) ? "[" : "{")) return false;
      const names = keys(input);
      if (!names) return false;
      if (Array.isArray(input)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
        if (!lengthDescriptor || typeof lengthDescriptor.value !== "number" || lengthDescriptor.value > MAX_NODES) return false;
        for (let index = 0; index < lengthDescriptor.value; index++) {
          if (index > 0 && !add(",")) return false;
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !("value" in descriptor) || !visit(descriptor.value, depth + 1)) return false;
        }
      } else {
        for (let index = 0; index < names.length; index++) {
          if (index > 0 && !add(",")) return false;
          const key = names[index];
          const descriptor = Object.getOwnPropertyDescriptor(record, key);
          if (!descriptor || !("value" in descriptor)) return false;
          const encodedKey = JSON.stringify(key);
          if (encodedKey === undefined || !add(`${encodedKey}:`) || !visit(descriptor.value, depth + 1)) return false;
        }
      }
      return add(Array.isArray(input) ? "]" : "}");
    } catch {
      return false;
    } finally {
      seen.delete(input);
    }
  };
  try {
    return visit(value, 0) ? hash.digest("hex") : undefined;
  } catch {
    return undefined;
  }
}

export class TokenGuard {
  private pending = new Map<string, Pending>();
  private previous?: string;
  private repeats = 0;
  private warned = false;
  private readonly config: GuardConfig;
  constructor(config: GuardConfig) { this.config = config; }

  reset(): void { this.pending.clear(); this.previous = undefined; this.repeats = 0; this.warned = false; }

  start(toolCallId: string, toolName: string, call: unknown): void {
    if (!this.config.enabled) return;
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
    let callDigest: string | undefined;
    try { callDigest = digest({ toolName, call }); } catch { callDigest = undefined; }
    this.pending.set(toolCallId, { callDigest });
  }

  complete(toolCallId: string, result: unknown): GuardDecision {
    const pending = this.pending.get(toolCallId);
    this.pending.delete(toolCallId);
    if (!this.config.enabled || !pending) return { suspected: false, warn: false, stop: false };
    let resultDigest: string | undefined;
    try { resultDigest = digest(result); } catch { resultDigest = undefined; }
    if (!pending.callDigest || !resultDigest) {
      this.previous = undefined; this.repeats = 0; this.warned = false;
      return { suspected: false, warn: false, stop: false, reason: "unsupported-or-oversized-evidence" };
    }
    const signature = `${pending.callDigest}:${resultDigest}`;
    if (signature === this.previous) this.repeats += 1; else { this.previous = signature; this.repeats = 1; this.warned = false; }
    const suspected = this.repeats >= this.config.warnAfter;
    const warn = suspected && !this.warned;
    if (warn) this.warned = true;
    const stop = suspected && this.config.stopAfter !== undefined && this.repeats >= this.config.stopAfter;
    return { suspected, warn, stop, reason: suspected ? "repeated-completed-signature-suspicion" : undefined };
  }
}
