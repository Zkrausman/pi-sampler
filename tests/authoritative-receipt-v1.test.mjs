import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  AUTHORITATIVE_RECEIPT_V1_SCHEMA_ID,
  AUTHORITATIVE_RECEIPT_V1_SCHEMA_VERSION,
  authoritativeReceiptBindingDigest,
  validateAuthoritativeReceiptV1,
  verifyAuthoritativeReceiptV1,
} from "../contracts/authoritative-receipt-v1.mjs";
import { AuthoritativeReceiptLedger, AuthoritativeReceiptLedgerError } from "../ledgers/authoritative-receipt-ledger.mjs";
import { AuthoritativeReceiptValidationError } from "../contracts/authoritative-receipt-v1.mjs";
import { conformanceNow, fakeTrustRoot, receiptFixture, runReceiptConformance } from "./helpers/authoritative-receipt-conformance.mjs";

const codes = (error) => error instanceof AuthoritativeReceiptValidationError ? error.errors.map((entry) => entry.code) : [error.code];
const rebind = (fixture) => { fixture.receipt.authority.attestation.bindingDigest = authoritativeReceiptBindingDigest(fixture.receipt); return fixture; };
async function withLedger(options, body) {
  const root = await mkdtemp(join(tmpdir(), "authority-receipt-")); let ledger;
  try { ledger = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow, ...options }); await body(ledger, root); }
  finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
}

test("generated authoritative receipt JSON Schema matches its executable source", () => {
  const result = spawnSync(process.execPath, ["scripts/export-authoritative-receipt-v1-schema.mjs", "--check"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(receiptFixture().receipt.schema.id, AUTHORITATIVE_RECEIPT_V1_SCHEMA_ID);
  assert.equal(receiptFixture().receipt.schema.version, AUTHORITATIVE_RECEIPT_V1_SCHEMA_VERSION);
});

test("table-driven fake-adapter conformance rejects every trust-boundary failure", async (t) => {
  const scenarios = [
    { name: "valid authoritative receipt", run: () => verifyAuthoritativeReceiptV1(receiptFixture().receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }), code: undefined },
    { name: "forged authority", run: () => { const x = receiptFixture(); x.receipt.authority.id = "forged"; x.receipt.observed.artifacts[0].provenance.authorityId = "forged"; return verifyAuthoritativeReceiptV1(rebind(x).receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }); }, code: "authority_unconfigured" },
    { name: "missing verifier", run: () => verifyAuthoritativeReceiptV1(receiptFixture().receipt, { trustRoots: [{ authorityId: "authority-1", producerIds: ["adapter-1"] }], now: conformanceNow }), code: "verifier_required" },
    { name: "verifier rejection", run: () => verifyAuthoritativeReceiptV1(receiptFixture().receipt, { trustRoots: [fakeTrustRoot({ mode: "reject" })], now: conformanceNow }), code: "verifier_rejected" },
    { name: "verifier exception", run: () => verifyAuthoritativeReceiptV1(receiptFixture().receipt, { trustRoots: [fakeTrustRoot({ mode: "throw" })], now: conformanceNow }), code: "verifier_exception" },
    { name: "verifier timeout", run: () => verifyAuthoritativeReceiptV1(receiptFixture().receipt, { trustRoots: [fakeTrustRoot({ mode: "timeout" })], now: conformanceNow }), code: "verifier_timeout" },
    { name: "verifier malformed response", run: () => verifyAuthoritativeReceiptV1(receiptFixture().receipt, { trustRoots: [fakeTrustRoot({ mode: "malformed" })], now: conformanceNow }), code: "verifier_malformed_response" },
    { name: "producer authority mismatch", run: () => { const x = receiptFixture(); x.receipt.producer.id = "other-adapter"; x.receipt.observed.artifacts[0].provenance.producerId = "other-adapter"; return verifyAuthoritativeReceiptV1(rebind(x).receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }); }, code: "producer_authority_mismatch" },
    { name: "unknown schema version", run: () => { const x = receiptFixture(); x.receipt.schema.version = "1.0.1"; return verifyAuthoritativeReceiptV1(x.receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }); }, code: "schema_invalid" },
    { name: "future-dated evidence", run: () => { const x = receiptFixture(); x.receipt.observed.observedAt = "2026-08-18T00:00:31.000Z"; x.receipt.receipt.issuedAt = "2026-08-18T00:00:31.000Z"; return verifyAuthoritativeReceiptV1(rebind(x).receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }); }, code: "evidence_future_dated" },
    { name: "stale evidence", run: () => { const x = receiptFixture(); x.receipt.observed.observedAt = "2026-08-17T23:54:00.000Z"; return verifyAuthoritativeReceiptV1(rebind(x).receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }); }, code: "evidence_stale" },
    { name: "noncanonical timestamp", run: () => { const x = receiptFixture(); x.receipt.observed.observedAt = "2026-08-18T00:00:00Z"; return verifyAuthoritativeReceiptV1(rebind(x).receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }); }, code: "timestamp_not_canonical" },
    { name: "partial coverage cannot be complete", run: () => { const x = receiptFixture(); x.receipt.observed.artifacts[0].coverage = { status: "partial", expectedCount: 2, observedCount: 1, missingIds: ["missing"] }; return verifyAuthoritativeReceiptV1(rebind(x).receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }); }, code: "partial_artifact_coverage" },
    { name: "missing sensitivity", run: () => { const x = receiptFixture(); delete x.receipt.observed.artifacts[0].sensitivity; return verifyAuthoritativeReceiptV1(x.receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }); }, code: "schema_invalid" },
    { name: "downgraded sensitivity", run: () => { const x = receiptFixture(); x.receipt.observed.sensitivity = "public"; return verifyAuthoritativeReceiptV1(rebind(x).receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }); }, code: "sensitivity_downgrade" },
    { name: "caller cannot claim observed evidence", run: () => { const x = receiptFixture(); x.receipt.claims.class = "observed_evidence"; return verifyAuthoritativeReceiptV1(x.receipt, { trustRoots: [fakeTrustRoot()], now: conformanceNow }); }, code: "schema_invalid" },
  ];
  await runReceiptConformance(t, scenarios.map((scenario) => ({
    ...scenario,
    assert: ({ result }) => {
      assert.equal(result.ok, scenario.code === undefined, scenario.name);
      if (scenario.code) assert.ok(result.errors.some((entry) => entry.code === scenario.code), `${scenario.name}: ${scenario.code}`);
    },
  })), async (scenario) => ({ scenario, result: await scenario.run() }));
});

test("receipt ledger admits only verified evidence, is idempotent, conflict-safe, and restart-stable", async () => withLedger({}, async (ledger, root) => {
  const fixture = receiptFixture();
  assert.equal((await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "committed");
  assert.equal((await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "idempotent");
  assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "stored_not_reverified");

  const changed = receiptFixture(); changed.receipt.claims.entries[0].valueSize += 1;
  await assert.rejects(ledger.accept(changed.receipt, { artifactBodies: changed.artifactBodies }), (error) => error instanceof AuthoritativeReceiptLedgerError && error.code === "idempotency_conflict");
  assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "stored_not_reverified");
  const second = receiptFixture(); second.receipt.idempotency.key = "operation-key-2"; second.receipt.receipt.id = "receipt-2"; second.receipt.authority.attestation.id = "attestation-2"; second.receipt.operation.id = "operation-2"; second.receipt.observed.artifacts[0].provenance.receiptId = "receipt-2"; second.receipt.observed.artifacts[0].provenance.operationId = "operation-2"; rebind(second);
  assert.equal((await ledger.accept(second.receipt, { artifactBodies: second.artifactBodies })).status, "committed");
  await ledger.close();
  const reopened = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow });
  try { assert.equal((await reopened.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "idempotent"); }
  finally { await reopened.close(); }
}));

test("idempotency ownership conflicts across ticket, episode, operation, and producer without replacing accepted state", async () => withLedger({}, async (ledger) => {
  const first = receiptFixture(); await ledger.accept(first.receipt, { artifactBodies: first.artifactBodies });
  for (const mutate of [
    (r) => { r.ticket = { ...r.ticket, id: "AIDEV-126" }; },
    (r) => { r.episode = { id: "episode-2" }; },
    (r) => { r.operation = { ...r.operation, id: "operation-2" }; r.observed.artifacts[0].provenance.operationId = "operation-2"; },
    (r) => { r.producer = { ...r.producer, id: "adapter-2" }; r.observed.artifacts[0].provenance.producerId = "adapter-2"; },
  ]) {
    const changed = receiptFixture(); mutate(changed.receipt); rebind(changed);
    await assert.rejects(ledger.accept(changed.receipt, { artifactBodies: changed.artifactBodies }), (error) => error.code === "idempotency_conflict");
  }
  assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "stored_not_reverified");
}));

test("artifact digest/size, receipt bounds, and pre-publication failure do not expose accepted state", async () => {
  const bad = receiptFixture(); bad.artifactBodies[0].bytes = new TextEncoder().encode("tampered");
  await withLedger({}, async (ledger) => await assert.rejects(ledger.accept(bad.receipt, { artifactBodies: bad.artifactBodies }), (error) => error.code === "artifact_content_mismatch"));
  const oversized = receiptFixture();
  await withLedger({ limits: { maxReceiptBytes: 100 } }, async (ledger) => await assert.rejects(ledger.accept(oversized.receipt, { artifactBodies: oversized.artifactBodies }), (error) => codes(error).includes("receipt_oversized")));

  const root = await mkdtemp(join(tmpdir(), "authority-receipt-fault-")); let ledger;
  try {
    ledger = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow, faultInjector: (boundary) => boundary === "before_commit_publish" });
    const fixture = receiptFixture(); await assert.rejects(ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies }));
    assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "missing");
    await ledger.close(); ledger = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow });
    assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "missing");
    assert.equal((await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "committed");
  } finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
});

test("structural validation binds ticket episode revision digest and artifact size", () => {
  for (const mutate of [
    (r) => { r.repository.revision = "not-a-revision"; },
    (r) => { r.observed.payload.digest = "f".repeat(64); },
    (r) => { r.observed.payload.size += 1; },
    (r) => { r.observed.coverage = { status: "partial", expectedCount: 2, observedCount: 1, missingIds: ["missing"] }; },
  ]) {
    const fixture = receiptFixture(); mutate(fixture.receipt);
    const result = validateAuthoritativeReceiptV1(fixture.receipt);
    assert.equal(result.ok, false);
  }
});
