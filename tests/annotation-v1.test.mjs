import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ANNOTATION_TARGET_KINDS,
  ANNOTATION_TYPES,
  ANNOTATION_V1_SCHEMA_ID,
  ANNOTATION_V1_SCHEMA_VERSION,
  annotationContentDigest,
  migrateAnnotationV1,
  validateAnnotationV1,
} from "../contracts/annotation-v1.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const now = "2026-08-20T00:00:00.000Z";
function annotation(overrides = {}) {
  const value = {
    schema: { id: ANNOTATION_V1_SCHEMA_ID, version: ANNOTATION_V1_SCHEMA_VERSION },
    id: "annotation-1",
    type: "helped",
    target: { kind: "event", id: "event-1" },
    author: { id: "human-1", kind: "human" },
    createdAt: now,
    sensitivity: "internal",
    rationale: "The intervention reduced rework.",
    evidenceClass: "human_annotation",
    revision: { id: "revision-1", number: 1 },
    ...overrides,
  };
  value.contentDigest = annotationContentDigest(value);
  return value;
}
const codes = (result) => result.errors.map((error) => error.code);

test("Annotation v1 enumerates the portable target and human annotation types", () => {
  assert.deepEqual(ANNOTATION_TARGET_KINDS, ["event", "range", "decision", "artifact", "outcome", "retrospective_claim", "lesson", "experiment"]);
  assert.deepEqual(ANNOTATION_TYPES, ["helped", "hurt", "incorrect", "important-context", "caused-rework", "repeat", "avoid", "value-assessment", "freeform"]);
  assert.equal(validateAnnotationV1(annotation()).ok, true);
  assert.equal(validateAnnotationV1(annotation({ target: { kind: "range", id: "event-1", start: 2, end: 4 } })).ok, true);
});

test("Annotation v1 rejects authority masquerading, malformed ancestry, and invalid ranges", () => {
  const observed = validateAnnotationV1(annotation({ evidenceClass: "observed_evidence" }));
  assert.equal(observed.ok, false);
  assert.ok(codes(observed).includes("schema_invalid"));

  const modelAuthor = validateAnnotationV1(annotation({ author: { id: "model-1", kind: "model" } }));
  assert.equal(modelAuthor.ok, false);
  assert.ok(codes(modelAuthor).includes("schema_invalid") || codes(modelAuthor).includes("author_kind_invalid"));

  const range = validateAnnotationV1(annotation({ target: { kind: "range", id: "event-1", start: 4, end: 2 } }));
  assert.equal(range.ok, false);
  assert.ok(codes(range).includes("target_range_invalid"));

  const parent = validateAnnotationV1(annotation({ revision: { id: "revision-1", number: 1, parentId: "parent" } }));
  assert.equal(parent.ok, false);
  assert.ok(codes(parent).includes("revision_parent_incomplete"));
});

test("Annotation v1 enforces default UTF-8 byte bounds for rationale fields", () => {
  const oversized = "😀".repeat(8192);
  const rationale = validateAnnotationV1(annotation({ rationale: oversized }));
  assert.equal(rationale.ok, false);
  assert.ok(codes(rationale).includes("rationale_oversized"));

  const tombstoneReason = validateAnnotationV1(annotation({ rationale: "Withdrawn.", tombstone: true, tombstoneReason: oversized }));
  assert.equal(tombstoneReason.ok, false);
  assert.ok(codes(tombstoneReason).includes("tombstone_reason_oversized"));
});

test("Annotation v1 enforces custom UTF-8 byte bounds for rationale fields", () => {
  const rationale = validateAnnotationV1(annotation({ rationale: "12345" }), { limits: { maxRationaleBytes: 4 } });
  assert.equal(rationale.ok, false);
  assert.ok(codes(rationale).includes("rationale_oversized"));

  const tombstoneReason = validateAnnotationV1(annotation({ rationale: "short", tombstone: true, tombstoneReason: "12345" }), { limits: { maxRationaleBytes: 4 } });
  assert.equal(tombstoneReason.ok, false);
  assert.ok(codes(tombstoneReason).includes("tombstone_reason_oversized"));
});

test("legacy annotation migration fills only versioned human defaults and recomputes identity", () => {
  const migrated = migrateAnnotationV1({
    id: "legacy-1",
    annotationType: "freeform",
    target: { type: "lesson", identity: "lesson-1" },
    authorId: "human-1",
    timestamp: now,
    sensitivity: "public",
    rationale: "Retained for compatibility.",
    revision: 1,
  });
  const result = validateAnnotationV1(migrated);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(migrated.schema, { id: ANNOTATION_V1_SCHEMA_ID, version: ANNOTATION_V1_SCHEMA_VERSION });
  assert.equal(migrated.evidenceClass, "human_annotation");
  assert.equal(migrated.revision.number, 1);
  assert.equal(migrated.contentDigest, annotationContentDigest(migrated));
});

test("Annotation schema exporter writes and validates the checked-in artifact", async () => {
  const schemaPath = join(root, "contracts", "annotation-v1.schema.json");
  await assert.doesNotReject(access(schemaPath));
  const command = spawnSync(process.execPath, ["scripts/export-annotation-v1-schema.mjs", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.equal(schema.$id, ANNOTATION_V1_SCHEMA_ID);
  assert.equal(schema.title, "Portable human Annotation v1");
  assert.equal(schema.properties.evidenceClass.const, "human_annotation");
  assert.equal(schema.properties.schema.properties.version.const, ANNOTATION_V1_SCHEMA_VERSION);
});
