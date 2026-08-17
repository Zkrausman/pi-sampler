import { createHash } from "node:crypto";
import { AUTHORITATIVE_RECEIPT_V1_SCHEMA_ID, AUTHORITATIVE_RECEIPT_V1_SCHEMA_VERSION, authoritativeReceiptBindingDigest } from "../../contracts/authoritative-receipt-v1.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export const conformanceNow = Date.parse("2026-08-18T00:00:00.000Z");

export function receiptFixture(overrides = {}) {
  const bytes = new TextEncoder().encode("authoritative evidence");
  const artifact = {
    id: "artifact-1", digest: hash(bytes), size: bytes.byteLength,
    identity: { id: "test-run-1", kind: "test_run" }, evidenceClass: "observed_evidence",
    coverage: { status: "complete", expectedCount: 1, observedCount: 1, missingIds: [] },
    provenance: { producerId: "adapter-1", authorityId: "authority-1", receiptId: "receipt-1", operationId: "operation-1" }, sensitivity: "internal",
  };
  const base = {
    schema: { id: AUTHORITATIVE_RECEIPT_V1_SCHEMA_ID, version: AUTHORITATIVE_RECEIPT_V1_SCHEMA_VERSION },
    receipt: { id: "receipt-1", issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:05:00.000Z" },
    project: { id: "pi-sampler" }, repository: { id: "github.com/Zkrausman/pi-sampler", revision: "a".repeat(40) }, ticket: { system: "linear", id: "AIDEV-125" }, episode: { id: "episode-1" }, operation: { id: "operation-1", kind: "test" },
    producer: { id: "adapter-1", kind: "adapter" }, authority: { id: "authority-1", attestation: { id: "attestation-1", bindingDigest: "0".repeat(64) } }, idempotency: { key: "operation-key-1" },
    observed: { observedAt: "2026-08-18T00:00:00.000Z", payload: { artifactId: artifact.id, digest: artifact.digest, size: artifact.size }, coverage: { status: "complete", expectedCount: 1, observedCount: 1, missingIds: [] }, artifacts: [artifact], sensitivity: "internal" },
    claims: { class: "caller_claim", producer: { id: "caller-1", kind: "caller" }, entries: [{ name: "source", valueDigest: hash("fake adapter fixture"), valueSize: 20, sensitivity: "internal" }] },
  };
  const receipt = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) receipt[key] = value;
  return finalizeReceipt(receipt, bytes);
}
export function finalizeReceipt(receipt, bytes = new TextEncoder().encode("authoritative evidence")) {
  receipt.authority.attestation.bindingDigest = authoritativeReceiptBindingDigest(receipt);
  return { receipt, artifactBodies: receipt.observed.artifacts.map((artifact) => ({ artifactId: artifact.id, bytes: artifact.id === "artifact-1" ? bytes : new Uint8Array() })) };
}
export function fakeTrustRoot({ mode = "accept", producerIds = ["adapter-1"], authorityId = "authority-1" } = {}) {
  return {
    authorityId, producerIds, timeoutMs: 50,
    verifier: async ({ bindingDigest }) => {
      if (mode === "reject") return { accepted: false, bindingDigest };
      if (mode === "throw") throw new Error("fake verifier fault");
      if (mode === "timeout") return new Promise(() => {});
      if (mode === "malformed") return { accepted: true };
      if (mode === "wrong-binding") return { accepted: true, bindingDigest: "f".repeat(64) };
      return { accepted: true, bindingDigest };
    },
  };
}
/** Reusable table-driven harness for fake authoritative-adapter conformance. */
export async function runReceiptConformance(t, cases, setup) {
  for (const scenario of cases) await t.test(scenario.name, async () => scenario.assert(await setup(scenario)));
}
