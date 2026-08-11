import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rename as renameAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachEvidenceReferences } from "../extensions/conversation-catalog/src/evidence.mjs";
import { findSensitiveContent, redactProjection } from "../extensions/conversation-catalog/src/redaction.mjs";
import { generateRelationshipMapHtml, projectRelationshipMap, writeRelationshipMapExport } from "../extensions/conversation-catalog/src/map.mjs";

function reviewedProjection() {
  const raw = {
    events: [
      { id: "raw-entry-SECRET-1", order: 0, title: "<img src=x onerror=bad()>", summary: "Contact jane@example.com", category: "user", timestamp: "2025-01-01 UTC", metadata: [{ label: "Entry", value: "raw-entry-SECRET-1" }, { label: "Arguments", value: "email=jane@example.com" }] },
      { id: "raw-entry-SECRET-2", order: 1, title: "Assistant", summary: "Reviewed response", category: "assistant", timestamp: "2025-01-02 UTC", metadata: [{ label: "Parent", value: "raw-entry-SECRET-1" }] },
      { id: "raw-entry-SECRET-3", order: 2, title: "Tool result", summary: "Completed", category: "tool-result", timestamp: "2025-01-03 UTC", metadata: [{ label: "Call ID", value: "call-secret" }] },
    ],
    edges: [
      { from: "raw-entry-SECRET-1", to: "raw-entry-SECRET-2", label: "parent entry" },
      { from: "raw-entry-SECRET-2", to: "raw-entry-SECRET-3", label: "tool result" },
      { from: "raw-entry-SECRET-3", to: "raw-entry-SECRET-2", label: "next assistant (chronological)" },
      { from: "raw-entry-SECRET-1", to: "raw-entry-SECRET-3", label: "invented causal relation" },
      { from: "raw-entry-SECRET-1", to: "missing", label: "parent entry" },
    ],
  };
  const findings = findSensitiveContent(raw);
  const redacted = redactProjection(raw, findings, Object.fromEntries(findings.map((finding) => [finding.id, "redact"])));
  return attachEvidenceReferences("session-safe", redacted);
}

test("map keeps only session-supported edge types and map-local event identities", () => {
  const graph = projectRelationshipMap(reviewedProjection());
  assert.deepEqual(graph.nodes.map((node) => node.id), ["map-event-1", "map-event-2", "map-event-3"]);
  assert.deepEqual(graph.nodes.map((node) => node.order), [1, 2, 3]);
  assert.deepEqual(graph.edges.map((edge) => edge.type), ["parent entry", "tool result", "chronological order"]);
  assert.ok(graph.nodes.every((node) => node.evidenceReference.startsWith("session-safe:event-")));
  assert.ok(graph.nodes.every((node) => node.metadata.every((item) => !/entry|parent|call id/i.test(item.label))));
  assert.match(graph.nodes[0].summary, /\[REDACTED: email address\]/);
  assert.doesNotMatch(JSON.stringify(graph), /raw-entry-SECRET|call-secret|invented causal relation/);
});

test("required Slack redaction is enforced before map projection", () => {
  const token = "xoxb-1234567890-AbCdEfGhIjKl";
  const raw = { events: [{ id: "raw", summary: `Use ${token}`, category: "user", metadata: [] }], edges: [] };
  const findings = findSensitiveContent(raw);
  assert.throws(() => redactProjection(raw, findings, { [findings[0].id]: "retain" }), /required_redaction/);
  const reviewed = attachEvidenceReferences("session-safe", redactProjection(raw, findings, { [findings[0].id]: "redact" }));
  const html = generateRelationshipMapHtml({ id: "session-safe" }, projectRelationshipMap(reviewed));
  assert.match(html, /\[REDACTED: Slack token\]/);
  assert.doesNotMatch(html, new RegExp(token));
});

test("map HTML is evidence-aware, safely escaped, filterable, and navigable without remote assets", () => {
  const html = generateRelationshipMapHtml({ id: "session-safe" }, projectRelationshipMap(reviewedProjection()));
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /Chronological evidence/);
  assert.match(html, /data-event-filter/);
  assert.match(html, /data-edge-filter/);
  assert.match(html, /focus-connected-evidence/);
  assert.match(html, /Fit map/);
  assert.match(html, /Reset view/);
  assert.match(html, /Zoom in/);
  assert.match(html, /session-safe:event-0001/);
  assert.match(html, /id="map-citation-1"/);
  assert.match(html, /id="map-flow-1"/);
  assert.match(html, /Embedded relationship context|embedded relationship context/);
  assert.match(html, /time order only; not causal/);
  assert.match(html, /setAttribute\("role","button"\)/);
  assert.match(html, /\[REDACTED: email address\]/);
  assert.doesNotMatch(html, /raw-entry-SECRET|call-secret|jane@example\.com|<img src=x/);
  assert.doesNotMatch(html, /<script[^>]+src=|\bfetch\s*\(/i);
});

test("map export stages redaction/evidence metadata before final map paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-map-export-"));
  const outputPath = join(directory, "map.html");
  const metadataPath = join(directory, "map.redaction.json");
  const metadata = { schemaVersion: 1, sessionId: "session-safe", evidence: { citations: [{ reference: "session-safe:event-0001" }] } };
  await writeRelationshipMapExport(outputPath, "<html>map</html>", metadata);
  assert.equal(readFileSync(outputPath, "utf8"), "<html>map</html>");
  assert.deepEqual(JSON.parse(readFileSync(metadataPath, "utf8")), metadata);

  const failedPath = join(directory, "failed.html");
  await assert.rejects(() => writeRelationshipMapExport(failedPath, "<html>map</html>", metadata, {
    writeFile: async (path, contents, encoding) => {
      if (String(path).includes(".redaction.json.")) throw new Error("metadata staging failed");
      return writeFileAsync(path, contents, encoding);
    },
  }), /metadata staging failed/);
  assert.equal(existsSync(failedPath), false);
  assert.equal(existsSync(join(directory, "failed.redaction.json")), false);
});

test("metadata finalization failure leaves no map or companion export", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-map-metadata-finalize-"));
  const outputPath = join(directory, "map.html");
  const metadataPath = join(directory, "map.redaction.json");
  await assert.rejects(() => writeRelationshipMapExport(outputPath, "map", { schemaVersion: 1 }, {
    rename: async (from, to) => {
      if (to === metadataPath) throw new Error("metadata finalization failed");
      return renameAsync(from, to);
    },
  }), /metadata finalization failed/);
  assert.equal(existsSync(outputPath), false);
  assert.equal(existsSync(metadataPath), false);
});

test("metadata staging failure preserves an existing completed map pair", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-map-rollback-"));
  const outputPath = join(directory, "map.html");
  const metadataPath = join(directory, "map.redaction.json");
  writeFileSync(outputPath, "old map");
  writeFileSync(metadataPath, "{\"old\":true}\n");
  await assert.rejects(() => writeRelationshipMapExport(outputPath, "new map", { new: true }, {
    writeFile: async (path, contents, encoding) => {
      if (String(path).includes(".redaction.json.")) throw new Error("metadata unavailable");
      return writeFileAsync(path, contents, encoding);
    },
  }), /metadata unavailable/);
  assert.equal(readFileSync(outputPath, "utf8"), "old map");
  assert.equal(readFileSync(metadataPath, "utf8"), "{\"old\":true}\n");
});
