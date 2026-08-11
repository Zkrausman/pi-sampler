import assert from "node:assert/strict";
import test from "node:test";
import { buildHindsightDocument } from "../extensions/conversation-catalog/src/synthesis.mjs";
const source = (id, summary) => ({ events: [{ summary, evidence: { reference: `${id}:event-0001` } }] });
test("hindsight document uses only selected included conversations with citations", () => {
 const html = buildHindsightDocument([source("one", "First"), source("two", "Second"), { excluded: true, events: [{ summary: "Hidden", evidence: { reference: "hidden:event-1" } }] }]);
 assert.match(html, /one:event-0001/); assert.match(html, /two:event-0001/); assert.doesNotMatch(html, /Hidden/);
});
test("hindsight document rejects fewer than two included conversations", () => assert.throws(() => buildHindsightDocument([source("one", "First")]), /at least two/));
