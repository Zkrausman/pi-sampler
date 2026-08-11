import assert from "node:assert/strict";
import test from "node:test";
import { buildHindsightDocument, buildSynthesisPrompt } from "../extensions/conversation-catalog/src/synthesis.mjs";

const source = (id, summary) => ({
  events: [{ id: `${id}-event-1`, category: "user", timestamp: "2025-01-01", summary, evidence: { reference: `${id}:event-0001` } }],
});

test("hindsight document uses only selected included conversations with navigable citations", () => {
  const one = source("one", "First");
  const two = source("two", "Second");
  const html = buildHindsightDocument([one, two, { excluded: true, events: [{ summary: "Hidden", evidence: { reference: "hidden:event-1" } }] }]);
  assert.match(html, /one:event-0001/);
  assert.match(html, /two:event-0001/);
  assert.match(html, /href="#citation-1-flow">flow<\/a>/);
  assert.match(html, /No relationship-map context was supplied/);
  assert.doesNotMatch(html, /Hidden/);
});

test("synthesis prompt includes redacted flow and relationship-map context", () => {
  const linked = {
    events: [
      { id: "one-event-1", category: "user", timestamp: "2025-01-01", summary: "First", evidence: { reference: "one:event-0001" } },
      { id: "one-event-2", category: "assistant", timestamp: "2025-01-02", summary: "Second", evidence: { reference: "one:event-0002" } },
    ],
    edges: [{ from: "one-event-1", to: "one-event-2", label: "parent entry" }],
  };
  const prompt = buildSynthesisPrompt([linked, source("two", "Third")], "/tmp/report.html");
  assert.match(prompt, /MUST make each citation navigable/);
  assert.match(prompt, /Source context unavailable/);
  assert.match(prompt, /one:event-0001/);
  assert.match(prompt, /"flowContext":"user · 2025-01-01 · First"/);
  assert.match(prompt, /"mapContext":"parent entry → one:event-0002"/);
});

test("hindsight document rejects fewer than two included conversations", () => assert.throws(() => buildHindsightDocument([source("one", "First")]), /at least two/));
