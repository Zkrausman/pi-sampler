import { createHash } from "node:crypto";

export const DEFAULT_SYNTHESIS_CHUNK_BYTES = 24 * 1024;

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function bytes(value) { return Buffer.byteLength(value, "utf8"); }
function fingerprint(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

function selectedSource(sources) {
  if (!Array.isArray(sources) || sources.length !== 1 || !sources[0] || typeof sources[0] !== "object" || sources[0].excluded || !Array.isArray(sources[0].events)) throw new Error("Select exactly one included redacted conversation before planning chunks.");
  return sources[0];
}

function canonicalEvidence(source) {
  const prefix = text(source.reference) || "selected-conversation-1";
  const seen = new Set();
  return source.events.map((event, order) => {
    const reference = text(event?.evidence?.reference);
    if (!reference) throw new Error(`Redacted event ${order + 1} has no evidence reference; review redaction and retry.`);
    if (seen.has(reference)) throw new Error(`Redacted evidence reference ${reference} is duplicated; review redaction and retry.`);
    seen.add(reference);
    const metadata = Array.isArray(event?.metadata) ? event.metadata.map((item) => ({ label: text(item?.label), value: text(item?.value) })).filter((item) => item.label || item.value) : [];
    return {
      sourceReference: prefix,
      reference,
      order,
      category: text(event?.category) || "Event",
      timestamp: text(event?.timestamp),
      title: text(event?.title),
      summary: text(event?.summary),
      metadata,
    };
  });
}

/**
 * Deterministically groups already redacted event evidence without invoking a
 * model. Notes, model output, and citation synthesis are intentionally outside
 * this primitive. Each serialized chunk is UTF-8 byte bounded and fingerprints
 * its canonical payload so a future isolated runner can validate exact inputs.
 */
export function planCanonicalSynthesisChunks(sources, { maxBytes = DEFAULT_SYNTHESIS_CHUNK_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new Error("Chunk byte limit must be a safe integer of at least 256 bytes.");
  const evidence = canonicalEvidence(selectedSource(sources));
  const chunks = [];
  let current = [];
  const emit = () => {
    if (!current.length) return;
    const payload = JSON.stringify(current);
    chunks.push({ ordinal: chunks.length + 1, references: current.map((item) => item.reference), bytes: bytes(payload), fingerprint: fingerprint(payload), evidence: current });
    current = [];
  };
  for (const item of evidence) {
    const alone = JSON.stringify([item]);
    if (bytes(alone) > maxBytes) throw new Error(`Redacted event ${item.reference} is ${bytes(alone).toLocaleString()} UTF-8 bytes and exceeds the ${maxBytes.toLocaleString()} byte chunk limit. Redact that event further or select a shorter conversation, then retry.`);
    const candidate = JSON.stringify([...current, item]);
    if (current.length && bytes(candidate) > maxBytes) emit();
    current.push(item);
  }
  emit();
  const planPayload = JSON.stringify(chunks.map(({ ordinal, references, bytes: chunkBytes, fingerprint: chunkFingerprint }) => ({ ordinal, references, bytes: chunkBytes, fingerprint: chunkFingerprint })));
  return { version: 1, maxBytes, chunks, fingerprint: fingerprint(planPayload) };
}
