import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ANNOTATION_V1_SCHEMA_ID,
  ANNOTATION_V1_SCHEMA_VERSION,
  annotationContentDigest,
} from "../contracts/annotation-v1.mjs";
import { AnnotationLedger } from "../ledgers/annotation-ledger.mjs";

const now = "2026-08-20T00:00:00.000Z";
function annotation(id = "annotation-1", overrides = {}) {
  const value = {
    schema: { id: ANNOTATION_V1_SCHEMA_ID, version: ANNOTATION_V1_SCHEMA_VERSION },
    id,
    type: "helped",
    target: { kind: "event", id: `event-${id}` },
    author: { id: "human-1", kind: "human" },
    createdAt: now,
    sensitivity: "internal",
    rationale: "The human reviewer recorded useful context.",
    evidenceClass: "human_annotation",
    revision: { id: `revision-${id}`, number: 1 },
    ...overrides,
  };
  if (overrides.contentDigest === undefined) value.contentDigest = annotationContentDigest(value);
  return value;
}
async function withStore(options, body) {
  const root = await mkdtemp(join(tmpdir(), "annotation-ledger-"));
  let store;
  try {
    store = await AnnotationLedger.open({ root, now: () => now, ...options });
    await body(store, root);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("append-only revisions preserve history and tombstones mask only the latest view", async () => withStore({}, async (store) => {
  const first = await store.append(annotation());
  assert.equal(first.status, "committed");
  const edited = await store.edit("annotation-1", { rationale: "The revised human rationale." }, { expectedRevision: 1 });
  assert.equal(edited.status, "committed");
  const deleted = await store.tombstone("annotation-1", { reason: "The annotation was withdrawn.", expectedRevision: 2 });
  assert.equal(deleted.status, "committed");

  assert.equal(store.list().annotations.length, 0);
  assert.equal(store.list({ includeTombstones: true }).annotations.length, 1);
  assert.equal(store.listHistory("annotation-1").annotations.length, 3);
  assert.equal(store.get("annotation-1").tombstone, true);
  const exported = await store.export();
  assert.equal(exported.annotations.length, 3);
  assert.equal(JSON.parse(exported.contents).annotations.length, 3);
}));

test("stale concurrent edits and non-head parents fail closed", async () => withStore({}, async (store) => {
  await store.append(annotation());
  const outcomes = await Promise.allSettled([
    store.edit("annotation-1", { rationale: "first writer" }, { expectedRevision: 1 }),
    store.edit("annotation-1", { rationale: "second writer" }, { expectedRevision: 1 }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
  assert.equal(outcomes.find((result) => result.status === "rejected").reason.code, "revision_conflict");

  const head = store.get("annotation-1");
  await assert.rejects(store.append({
    ...head,
    revision: { id: "cycle-revision", number: head.revision.number + 1, parentId: "cycle-revision", parentDigest: head.contentDigest },
    rationale: "cycle",
  }), (error) => error.code === "revision_cycle");
}));

test("orphan tombstones are rejected before durable publication", async () => withStore({}, async (store) => {
  await assert.rejects(store.append(annotation("orphan", { tombstone: true, tombstoneReason: "missing" })), (error) => error.code === "tombstone_orphan");
  assert.equal(store.list({ includeTombstones: true }).annotations.length, 0);
}));

test("listing is bounded and cursor pagination is deterministic", async () => withStore({ limits: { maxQueryRecords: 2 } }, async (store) => {
  await store.append(annotation("annotation-a"));
  await store.append(annotation("annotation-b"));
  await store.append(annotation("annotation-c"));
  const first = store.list({ limit: 2 });
  assert.deepEqual(first.annotations.map((item) => item.id), ["annotation-a", "annotation-b"]);
  assert.equal(first.truncated, true);
  const second = store.list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.annotations.map((item) => item.id), ["annotation-c"]);
  assert.equal(second.truncated, false);
  await assert.rejects(Promise.resolve().then(() => store.list({ limit: 3 })), (error) => error.code === "limit_exceeded");
}));

test("backup and restore retain all annotation revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "annotation-ledger-backup-"));
  const restoreRoot = join(root, "restored");
  let store;
  let restored;
  try {
    store = await AnnotationLedger.open({ root, now: () => now });
    await store.append(annotation());
    await store.edit("annotation-1", { rationale: "retained revision" });
    const backup = await store.backup();
    await store.close();
    store = undefined;
    restored = await AnnotationLedger.restore({ backupPath: backup.path, root: restoreRoot, now: () => now });
    assert.equal(restored.listHistory("annotation-1").annotations.length, 2);
    assert.equal((await restored.verifyIntegrity()).ok, true);
  } finally {
    await restored?.close();
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable batch faults recover deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "annotation-ledger-fault-"));
  let store;
  try {
    store = await AnnotationLedger.open({ root, now: () => now, faultInjector: (boundary) => boundary === "before_receipt_commit_publish" });
    await assert.rejects(store.append(annotation()), (error) => error.code === "injected_fault");
    await store.close();
    store = undefined;
    store = await AnnotationLedger.open({ root, now: () => now });
    assert.equal(store.list({ includeTombstones: true }).annotations.length, 0);
    await store.close();
    store = undefined;
    store = await AnnotationLedger.open({ root, now: () => now, faultInjector: (boundary) => boundary === "after_receipt_batch_ack_dirsync" });
    const recovered = await store.append(annotation());
    assert.equal(recovered.status, "committed");
    assert.equal(recovered.recovered, true);
    assert.equal(store.list({ includeTombstones: true }).annotations.length, 1);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy payload migration upgrades reads and exports without minting authority", async () => withStore({}, async (store) => {
  const migrated = await store.migrate({ fromVersion: 0, toVersion: 1 });
  assert.equal(migrated.version, 1);
  assert.equal(migrated.status, "already_current");
  assert.equal(store.migratePayload({ evidenceClass: "observed_evidence" }).evidenceClass, "observed_evidence");
}));

test("annotation migration rejects unsupported source versions", async () => withStore({}, async (store) => {
  await assert.rejects(store.migrate({ fromVersion: 999, toVersion: 1 }), (error) => error.code === "migration_source_unsupported");
}));
