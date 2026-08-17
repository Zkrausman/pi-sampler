import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
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

const hash = (value) => createHash("sha256").update(value).digest("hex");
const codes = (error) => error instanceof AuthoritativeReceiptValidationError ? error.errors.map((entry) => entry.code) : [error.code];
const rebind = (fixture) => { fixture.receipt.authority.attestation.bindingDigest = authoritativeReceiptBindingDigest(fixture.receipt); return fixture; };
async function withLedger(options, body) {
  const root = await mkdtemp(join(tmpdir(), "authority-receipt-")); let ledger;
  try { ledger = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow, ...options }); await body(ledger, root); }
  finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
}
async function artifactNames(root) { return (await readdir(join(root, "artifacts"))).sort(); }
function addArtifact(fixture, id = "artifact-2", body = new TextEncoder().encode("second authoritative evidence")) {
  const source = fixture.receipt.observed.artifacts[0];
  fixture.receipt.observed.artifacts.push({ ...structuredClone(source), id, digest: hash(body), size: body.byteLength, identity: { id: `source-${id}`, kind: "test_run" } });
  fixture.artifactBodies.push({ artifactId: id, bytes: body });
  return rebind(fixture);
}

// CRLF check: generated JSON uses JSON.stringify + a terminal LF. Node's
// readFile does not translate CRLF, so the exporter check is byte-exact on both
// Windows and POSIX clean checkouts.
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
  await runReceiptConformance(t, scenarios.map((scenario) => ({ ...scenario, assert: ({ result }) => {
    assert.equal(result.ok, scenario.code === undefined, scenario.name);
    if (scenario.code) assert.ok(result.errors.some((entry) => entry.code === scenario.code), `${scenario.name}: ${scenario.code}`);
  } })), async (scenario) => ({ scenario, result: await scenario.run() }));
});

test("duplicate and malformed roots fail closed in every supported verifier input form", async () => {
  const fixture = receiptFixture().receipt, accepting = fakeTrustRoot(), rejecting = fakeTrustRoot({ mode: "reject" });
  for (const roots of [[accepting, rejecting], [rejecting, accepting], new Map([["first", accepting], ["second", rejecting]]), new Map([["first", rejecting], ["second", accepting]])]) {
    const result = await verifyAuthoritativeReceiptV1(fixture, { trustRoots: roots, now: conformanceNow });
    assert.equal(result.ok, false); assert.ok(result.errors.some((entry) => entry.code === "trust_roots_duplicate"));
  }
  for (const roots of [undefined, [], [{ authorityId: 7 }], new Map([["bad", { authorityId: 7 }]])]) {
    const result = await verifyAuthoritativeReceiptV1(fixture, { trustRoots: roots, now: conformanceNow });
    assert.equal(result.ok, false); assert.ok(result.errors.some((entry) => entry.code === "trust_roots_invalid"));
  }
  assert.equal((await verifyAuthoritativeReceiptV1(fixture, { trustRoots: [accepting], now: conformanceNow })).ok, true);
});

test("stored receipt lookup uses original issued, observed, and expiration timestamps", async () => {
  let clock = conformanceNow;
  await withLedger({ now: () => clock, freshness: { maxAgeMs: 120_000, maxFutureSkewMs: 0, requireExpiresAt: true } }, async (ledger) => {
    const expiring = receiptFixture(); expiring.receipt.receipt.expiresAt = "2026-08-18T00:00:01.000Z"; rebind(expiring);
    await ledger.accept(expiring.receipt, { artifactBodies: expiring.artifactBodies });
    assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "stored_not_reverified");
    clock += 2_000;
    const expired = await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" });
    assert.equal(expired.status, "stale"); assert.ok(expired.freshness.errors.some((entry) => entry.code === "evidence_expired"));
    const replay = await ledger.accept(expiring.receipt, { artifactBodies: expiring.artifactBodies });
    assert.equal(replay.status, "idempotent"); assert.equal(replay.freshness.ok, false);
  });
  clock = conformanceNow + 70_000;
  await withLedger({ now: () => clock, freshness: { maxAgeMs: 60_000, maxFutureSkewMs: 0, requireExpiresAt: false } }, async (ledger) => {
    const stale = receiptFixture(); await assert.rejects(ledger.accept(stale.receipt, { artifactBodies: stale.artifactBodies }), (error) => codes(error).includes("evidence_stale"));
  });
});

test("all contract-valid boundary identities derive valid bounded Ticket Episode identities", async () => {
  const fixture = receiptFixture(), max = "a".repeat(128), min = "z";
  fixture.receipt.receipt.id = max;
  fixture.receipt.operation.id = max;
  fixture.receipt.authority.id = max;
  fixture.receipt.idempotency.key = max;
  fixture.receipt.observed.artifacts[0].provenance.receiptId = max;
  fixture.receipt.observed.artifacts[0].provenance.operationId = max;
  fixture.receipt.observed.artifacts[0].provenance.authorityId = max;
  rebind(fixture);
  await withLedger({ trustRoots: [fakeTrustRoot({ authorityId: max })] }, async (ledger) => assert.equal((await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "committed"));
  const minimum = receiptFixture(); minimum.receipt.receipt.id = min; minimum.receipt.operation.id = min; minimum.receipt.authority.id = min; minimum.receipt.idempotency.key = min; minimum.receipt.observed.artifacts[0].provenance.receiptId = min; minimum.receipt.observed.artifacts[0].provenance.operationId = min; minimum.receipt.observed.artifacts[0].provenance.authorityId = min; rebind(minimum);
  await withLedger({ trustRoots: [fakeTrustRoot({ authorityId: min })] }, async (ledger) => assert.equal((await ledger.accept(minimum.receipt, { artifactBodies: minimum.artifactBodies })).status, "committed"));
});

test("receipt ledger is idempotent, conflict-safe, restart-stable, and preserves real receipt freshness", async () => withLedger({}, async (ledger, root) => {
  const fixture = receiptFixture();
  assert.equal((await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "committed");
  assert.equal((await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "idempotent");
  assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "stored_not_reverified");
  const changed = receiptFixture(); changed.receipt.claims.entries[0].valueSize += 1;
  await assert.rejects(ledger.accept(changed.receipt, { artifactBodies: changed.artifactBodies }), (error) => error instanceof AuthoritativeReceiptLedgerError && error.code === "idempotency_conflict");
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
  ]) { const changed = receiptFixture(); mutate(changed.receipt); rebind(changed); await assert.rejects(ledger.accept(changed.receipt, { artifactBodies: changed.artifactBodies }), (error) => error.code === "idempotency_conflict"); }
  assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "stored_not_reverified");
}));

test("all prepublication artifact and commit failures are residue-free and retryable", async (t) => {
  const lifecycle = (purpose) => [`before_${purpose}_stage`, `after_${purpose}_write`, `after_${purpose}_sync`, `before_${purpose}_publish`, `after_${purpose}_publish`, `after_${purpose}_dirsync`];
  const boundaries = [0, 1, 2].flatMap((index) => lifecycle(`receipt_artifact_${index}`)).concat(lifecycle("receipt_commit"), ["before_receipt_commit_directory", "after_receipt_commit_directory"]);
  for (const boundary of boundaries) await t.test(boundary, async () => {
    const root = await mkdtemp(join(tmpdir(), "authority-receipt-batch-")); let ledger;
    try {
      ledger = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow, faultInjector: (name) => name === boundary });
      const fixture = addArtifact(receiptFixture());
      const commitPublished = boundary === "after_receipt_commit_dirsync";
      if (commitPublished) assert.equal((await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "committed");
      else await assert.rejects(ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies }));
      const lookup = await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" });
      assert.equal(lookup.status, commitPublished ? "stored_not_reverified" : "missing");
      if (!commitPublished) assert.deepEqual(await artifactNames(root), []);
      await ledger.close(); ledger = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow });
      if (!commitPublished) { assert.equal((await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "committed"); }
      assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "stored_not_reverified");
    } finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
  });
});

test("crash after artifact publication recovers the durable batch marker without residue", async () => {
  const root = await mkdtemp(join(tmpdir(), "authority-receipt-crash-"));
  try {
    const facadeUrl = new URL("../ledgers/authoritative-receipt-ledger.mjs", import.meta.url).href, helperUrl = new URL("./helpers/authoritative-receipt-conformance.mjs", import.meta.url).href;
    const program = `import { AuthoritativeReceiptLedger } from ${JSON.stringify(facadeUrl)}; import { receiptFixture, fakeTrustRoot, conformanceNow } from ${JSON.stringify(helperUrl)}; const fixture = receiptFixture(); const ledger = await AuthoritativeReceiptLedger.open({ root: ${JSON.stringify(root)}, trustRoots: [fakeTrustRoot()], now: conformanceNow, faultInjector: (boundary) => { if (boundary === "after_receipt_artifact_0_dirsync") process.exit(71); return false; } }); await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies });`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8" });
    assert.equal(child.status, 71, child.stderr);
    let ledger = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow });
    try {
      assert.deepEqual(await artifactNames(root), []);
      assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "missing");
      const fixture = receiptFixture(); assert.equal((await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "committed");
    } finally { await ledger.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("crash after linked-but-unacknowledged commit aborts it with its artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "authority-receipt-commit-crash-"));
  try {
    const facadeUrl = new URL("../ledgers/authoritative-receipt-ledger.mjs", import.meta.url).href, helperUrl = new URL("./helpers/authoritative-receipt-conformance.mjs", import.meta.url).href;
    const program = `import { AuthoritativeReceiptLedger } from ${JSON.stringify(facadeUrl)}; import { receiptFixture, fakeTrustRoot, conformanceNow } from ${JSON.stringify(helperUrl)}; const f=receiptFixture(); const l=await AuthoritativeReceiptLedger.open({root:${JSON.stringify(root)},trustRoots:[fakeTrustRoot()],now:conformanceNow,faultInjector:b=>{if(b==='after_receipt_commit_publish')process.exit(72);return false}});await l.accept(f.receipt,{artifactBodies:f.artifactBodies})`;
    assert.equal(spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8" }).status, 72);
    const ledger = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow });
    try { assert.deepEqual(await artifactNames(root), []); assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "missing"); }
    finally { await ledger.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repeated rejected batch attempts do not accumulate artifacts or reduce later capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "authority-receipt-repeat-")); let fault = true, ledger;
  try {
    ledger = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow, faultInjector: (boundary) => fault && boundary === "after_receipt_artifact_1_publish" });
    const fixture = addArtifact(receiptFixture());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies }));
      assert.deepEqual(await artifactNames(root), []);
      assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "missing");
    }
    fault = false;
    assert.equal((await ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies })).status, "committed");
    await ledger.close(); ledger = await AuthoritativeReceiptLedger.open({ root, trustRoots: [fakeTrustRoot()], now: conformanceNow });
    assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "stored_not_reverified");
  } finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
});

test("invalid second artifacts and capacity/derived-record preflights leave no residue", async () => {
  await withLedger({}, async (ledger, root) => {
    const invalid = addArtifact(receiptFixture()); invalid.artifactBodies[1].bytes = new TextEncoder().encode("tampered");
    await assert.rejects(ledger.accept(invalid.receipt, { artifactBodies: invalid.artifactBodies }), (error) => error.code === "artifact_content_mismatch");
    assert.deepEqual(await artifactNames(root), []); assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "missing");
    const valid = addArtifact(receiptFixture()); assert.equal((await ledger.accept(valid.receipt, { artifactBodies: valid.artifactBodies })).status, "committed");
  });
  for (const limits of [{ maxArtifactBytes: 1 }, { maxEncodedRecordBytes: 1 }, { maxStorageBytes: 100 }]) await withLedger({ limits }, async (ledger, root) => {
    const fixture = receiptFixture(); await assert.rejects(ledger.accept(fixture.receipt, { artifactBodies: fixture.artifactBodies }));
    assert.deepEqual(await artifactNames(root), []); assert.equal((await ledger.lookup({ episodeId: "episode-1", idempotencyKey: "operation-key-1" })).status, "missing");
  });
});

test("structural validation binds ticket episode revision digest and artifact size", () => {
  for (const mutate of [(r) => { r.repository.revision = "not-a-revision"; }, (r) => { r.observed.payload.digest = "f".repeat(64); }, (r) => { r.observed.payload.size += 1; }, (r) => { r.observed.coverage = { status: "partial", expectedCount: 2, observedCount: 1, missingIds: ["missing"] }; }]) {
    const fixture = receiptFixture(); mutate(fixture.receipt); assert.equal(validateAuthoritativeReceiptV1(fixture.receipt).ok, false);
  }
});
