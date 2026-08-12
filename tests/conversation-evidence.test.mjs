import assert from "node:assert/strict";
import test from "node:test";
import { attachEvidenceReferences, createEvidenceManifest, generateCitedHindsightDocumentHtml } from "../extensions/conversation-catalog/src/evidence.mjs";
import { generateConversationFlowHtml } from "../extensions/conversation-catalog/src/flow.mjs";

const projection = {
  events: [
    { id: "event-1", category: "user", title: "User", timestamp: "2025-01-01 UTC", summary: "Customer asked for <b>help</b>", metadata: [] },
    { id: "event-2", category: "assistant", title: "Assistant", timestamp: "2025-01-02 UTC", summary: "Provided a response", metadata: [] },
  ],
  edges: [{ from: "event-1", to: "event-2", label: "parent entry" }],
};

test("evidence references are stable, direct, and persistence-safe", () => {
  const cited = attachEvidenceReferences('session"><secret>', projection);
  assert.deepEqual(cited.events.map((event) => event.evidence.reference), ["session---secret-:event-0001", "session---secret-:event-0002"]);
  assert.ok(cited.events.every((event) => event.evidence.classification === "direct evidence"));
  const manifest = createEvidenceManifest(cited);
  assert.deepEqual(manifest.citations.map((citation) => citation.eventAnchor), ["#event-1", "#event-2"]);
  assert.doesNotMatch(JSON.stringify(manifest), /Customer asked|Provided a response/);
});

test("flow exposes direct citations that point to inspectable event context", () => {
  const cited = attachEvidenceReferences("session-abc", projection);
  const html = generateConversationFlowHtml({ id: "session-abc", name: "Selected conversation" }, cited);
  assert.match(html, /direct evidence/);
  assert.match(html, /session-abc:event-0001/);
  assert.match(html, /this card is the inspectable source context/);
  assert.doesNotMatch(html, /<b>help<\/b>/);
});

test("cited hindsight documents link claims to embedded redacted source, flow, and map context", () => {
  const html = generateCitedHindsightDocumentHtml({
    title: "Review",
    claims: [
      { statement: "The user asked for help.", classification: "direct evidence", evidenceReferences: ["session-abc:event-0001"] },
      { statement: "Support may need follow-up.", classification: "inference", evidenceReferences: ["session-abc:event-0002"] },
    ],
    evidence: [
      { reference: "session-abc:event-0001", context: "Customer asked for help", flowContext: "user · Customer asked for help", mapContext: "parent entry → session-abc:event-0002" },
      { reference: "session-abc:event-0002", context: "Provided a response" },
    ],
  });
  assert.match(html, /claim-direct-evidence/);
  assert.match(html, /claim-inference/);
  assert.match(html, /href="#citation-1"/);
  assert.match(html, /href="#citation-1-flow">flow<\/a>/);
  assert.match(html, /href="#citation-1-map">map<\/a>/);
  assert.match(html, /id="citation-1-flow"/);
  assert.match(html, /id="citation-1-map"/);
  assert.match(html, /Redacted source context/);
  assert.match(html, /Customer asked for help/);
  assert.match(html, /No relationship-map context was supplied/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ claims: [{ statement: "Unsupported", classification: "direct evidence" }], evidence: [] }), /no inspectable source evidence/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ claims: [{ statement: "Model statement", classification: "model inference", evidenceReferences: ["event-1"] }], evidence: [{ reference: "event-1", context: "Context" }] }), /explicitly classified/);
});

test("evidence-first story steps render escaped chronological reading chips, keep a no-JS order, and locally filter inference", () => {
  const html = generateCitedHindsightDocumentHtml({
    title: "Story review",
    claims: [],
    storySteps: [
      { title: "<img src=x onerror=alert(1)>", body: "Direct <script>alert(1)</script>", classification: "direct evidence", evidenceReferences: ["a/b"] },
      { title: "Pivotal inference", body: "A follow-up may help.", classification: "inference", evidenceReferences: ["a?b"] },
    ],
    recommendations: [],
    evidence: [{ reference: "a/b", context: "First redacted context" }, { reference: "a?b", context: "Second redacted context" }],
  });
  assert.match(html, /Evidence-first story reading order/);
  assert.match(html, /Model-suggested evidence-first reading guide; story steps are not user-confirmed facts/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Direct &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>|<script>alert\(1\)<\/script>/);
  assert.match(html, /class="evidence-chip" href="#citation-1">a\/b<\/a>/);
  assert.match(html, /class="evidence-chip" href="#citation-2">a\?b<\/a>/);
  assert.match(html, /Inference · model-suggested interpretation/);
  assert.match(html, /id="story-direct-evidence-filter" aria-pressed="false" aria-controls="story-reading-order"/);
  assert.doesNotMatch(html, /<li[^>]*\shidden(?:[=>\s])/);
  assert.ok(html.indexOf("&lt;img src=x") < html.indexOf("Pivotal inference"), "no-JS markup retains model reading order");
  assert.match(html, /default-src 'none'/);

  const script = html.match(/<script>(\(\(\) => \{[\s\S]*?\}\)\(\);)<\/script>/)?.[1];
  assert.ok(script, "story filter is local inline behavior under the fixed CSP");
  const button = { setAttribute(name, value) { this[name] = value; }, addEventListener(_event, listener) { this.listener = listener; } };
  const status = {};
  const steps = [{ dataset: { storyClassification: "direct evidence" } }, { dataset: { storyClassification: "inference" } }];
  new Function("document", script)({
    getElementById: (id) => id === "story-direct-evidence-filter" ? button : id === "story-filter-status" ? status : undefined,
    querySelectorAll: () => steps,
  });
  button.listener();
  assert.equal(button["aria-pressed"], "true");
  assert.equal(steps[0].hidden, false);
  assert.equal(steps[1].hidden, true);
  assert.match(status.textContent, /direct-evidence story steps only/);
  button.listener();
  assert.equal(button["aria-pressed"], "false");
  assert.equal(steps[1].hidden, false);
});

test("story-step runtime validation rejects malformed, uncited, duplicate, unavailable, and excluded citations", () => {
  const base = { title: "Step", body: "Body", classification: "direct evidence", evidenceReferences: ["included"] };
  const document = { claims: [], recommendations: [], evidence: [{ reference: "included", context: "Redacted" }] };
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, storySteps: [{ title: "Only a title" }] }), /Story step 1 is malformed/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, storySteps: [{ ...base, evidenceReferences: [] }] }), /cite between 1 and 3/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, storySteps: [{ ...base, evidenceReferences: ["included", "included"] }] }), /duplicate references/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, storySteps: [{ ...base, evidenceReferences: ["other"] }] }), /outside the included redacted source bundle/);
  assert.throws(() => generateCitedHindsightDocumentHtml({
    ...document, evidence: [{ reference: "included", availability: "excluded", context: "Must not render" }], storySteps: [base],
  }), /outside the included redacted source bundle/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, storySteps: [base, { ...base }] }), /duplicates an earlier story step/);
});

test("opt-in narrative maps use a fixed cited chronological no-JS renderer", () => {
  const narrativeMap = {
    layout: "chronological",
    groups: [{ id: "opening", title: "Opening evidence" }, { id: "followup", title: "Follow-up" }],
    nodes: [
      { id: "request", groupId: "opening", title: "Initial request", body: "The request is recorded.", classification: "direct relationship", evidenceReferences: ["session-abc:event-0001"] },
      { id: "response", groupId: "followup", title: "Response", body: "A response followed.", classification: "inference", evidenceReferences: ["session-abc:event-0002"] },
    ],
    edges: [{ from: "request", to: "response", label: "was followed by", classification: "inference", evidenceReferences: ["session-abc:event-0001", "session-abc:event-0002"] }],
  };
  const html = generateCitedHindsightDocumentHtml({
    claims: [], recommendations: [], narrativeMapEnabled: true, narrativeMap,
    evidence: [
      { reference: "session-abc:event-0001", context: "First redacted context" },
      { reference: "session-abc:event-0002", context: "Second redacted context" },
    ],
  });
  assert.match(html, /Cited narrative map/);
  assert.match(html, /fixed chronological layout/);
  assert.match(html, /Direct relationship · model-suggested relationship/);
  assert.match(html, /Inference · model-suggested relationship/);
  assert.match(html, /href="#citation-1">session-abc:event-0001/);
  assert.match(html, /href="#citation-2">session-abc:event-0002/);
  assert.match(html, /order does not imply causation/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<(?:svg|script\s+src|img\s+src|iframe)\b/i);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/i);
});

test("narrative-map runtime rejects markup, directives, duplicate, unknown, and excluded citations", () => {
  const base = {
    layout: "chronological", groups: [{ id: "group", title: "Group" }],
    nodes: [{ id: "node", groupId: "group", title: "Node", body: "Body", classification: "direct relationship", evidenceReferences: ["included"] }],
    edges: [],
  };
  const document = { claims: [], recommendations: [], narrativeMapEnabled: true, narrativeMap: base, evidence: [{ reference: "included", context: "Redacted" }] };
  assert.doesNotThrow(() => generateCitedHindsightDocumentHtml(document));
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, narrativeMapEnabled: false }), /explicit opt-in/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, narrativeMap: { ...base, layout: "freeform-svg" } }), /supported chronological layout/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, narrativeMap: { ...base, directive: "<script>" } }), /unsupported directive/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, narrativeMap: { ...base, nodes: [{ ...base.nodes[0], title: "<script>alert(1)<\/script>" }] } }), /must not contain markup or script/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, narrativeMap: { ...base, nodes: [{ ...base.nodes[0], evidenceReferences: ["included", "included"] }] } }), /duplicate references/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, narrativeMap: { ...base, nodes: [{ ...base.nodes[0], evidenceReferences: ["unknown"] }] } }), /unknown or excluded evidence/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ ...document, evidence: [{ reference: "included", availability: "excluded", context: "Hidden" }] }), /unknown or excluded evidence/);
});

test("an opted-in excluded narrative map is a content-free placeholder", () => {
  const html = generateCitedHindsightDocumentHtml({
    claims: [], recommendations: [], narrativeMapEnabled: true, narrativeMapExcluded: true,
    evidence: [],
  });
  assert.match(html, /Narrative map unavailable: the selected conversation was excluded during redaction review/);
  assert.doesNotMatch(html, /DO-NOT-RENDER|selected:excluded/);
  assert.throws(() => generateCitedHindsightDocumentHtml({
    claims: [], recommendations: [], narrativeMapEnabled: true, narrativeMapExcluded: true,
    narrativeMap: { layout: "chronological", groups: [{ id: "group", title: "Hidden" }], nodes: [{ id: "node", groupId: "group", title: "Hidden", body: "Hidden", classification: "inference", evidenceReferences: ["selected:excluded"] }], edges: [] },
    evidence: [{ reference: "selected:excluded", availability: "excluded" }],
  }), /content-free narrative-map placeholder/);
});

test("missing and excluded citations stay navigable with redaction-safe fallbacks", () => {
  const html = generateCitedHindsightDocumentHtml({
    claims: [
      { statement: "Missing source claim", classification: "inference", evidenceReferences: ["unknown:event-0001"] },
      { statement: "Excluded source claim", classification: "direct evidence", evidenceReferences: ["excluded:event-0001"] },
    ],
    excludedEvidenceReferences: ["excluded:event-0001"],
    evidence: [],
  });
  assert.match(html, /href="#citation-1">unknown:event-0001<\/a>/);
  assert.match(html, /id="citation-1"/);
  assert.match(html, /Source context is unavailable in this report/);
  assert.match(html, /id="citation-2"/);
  assert.match(html, /Source context was excluded during redaction review/);
  assert.doesNotMatch(html, /raw session ID|unredacted content/);
});

test("claim-support rendering only accepts scoped model validation and emits safe citations", () => {
  const document = {
    claims: [{ statement: "Claim", classification: "inference", evidenceReferences: ["event-1"] }],
    evidence: [{ reference: "event-1", context: "Redacted context" }],
    claimSupportValidation: {
      source: "model-validation",
      userDisposition: "not-user-confirmed",
      assessments: [{ claimNumber: 1, support: "partially supported", rationale: "<img src=x onerror=alert(1)>", evidenceReferences: ["event-1"] }],
    },
  };
  const html = generateCitedHindsightDocumentHtml(document);
  assert.match(html, /Claim-support validation/);
  assert.match(html, /Model-generated validation only; it is not a user-confirmed disposition/);
  assert.match(html, /partially supported/);
  assert.match(html, /Rationale:<\/span> &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /href="#citation-1">event-1<\/a>/);
  assert.throws(() => generateCitedHindsightDocumentHtml({
    ...document,
    claimSupportValidation: { ...document.claimSupportValidation, userDisposition: "<script>user-confirmed<\/script>" },
  }), /model-generated and not user-confirmed/);
  assert.throws(() => generateCitedHindsightDocumentHtml({
    ...document,
    claimSupportValidation: {
      ...document.claimSupportValidation,
      assessments: [{ claimNumber: 1, support: "supported", rationale: "Not scoped.", evidenceReferences: ["other-event"] }],
    },
  }), /exactly the claim's cited redacted evidence excerpts/);
  assert.throws(() => generateCitedHindsightDocumentHtml({
    ...document,
    claimSupportValidation: {
      ...document.claimSupportValidation,
      assessments: [{ claimNumber: 1, support: "supported", rationale: "", evidenceReferences: ["event-1"] }],
    },
  }), /requires a readable rationale/);
});

test("citation anchors do not collide for distinct punctuation and duplicate evidence is rejected", () => {
  const html = generateCitedHindsightDocumentHtml({
    claims: [{ statement: "Two sources", classification: "direct evidence", evidenceReferences: ["a/b", "a?b"] }],
    evidence: [{ reference: "a/b", context: "First" }, { reference: "a?b", context: "Second" }],
  });
  assert.match(html, /id="citation-1"/);
  assert.match(html, /id="citation-2"/);
  assert.throws(() => generateCitedHindsightDocumentHtml({ evidence: [{ reference: "same", context: "A" }, { reference: "same", context: "B" }] }), /unique and non-empty/);
});

test("reader-first layout provides TOC, deterministic top actions, closed appendix, citations, and safe fallbacks", () => {
  const recommendation = (recommendationText, priority, reference) => ({
    recommendation: recommendationText, priority, expectedImpact: "Reduce repeated work", suggestedOwner: "Support team",
    dependencies: [], acceptanceCriteria: ["A cited check passes"], status: "proposed", source: "model-suggestion", evidenceReferences: [reference],
  });
  const html = generateCitedHindsightDocumentHtml({
    title: '<img src=x onerror=alert(1)>',
    claims: [{ statement: "A direct finding", classification: "direct evidence", evidenceReferences: ["event-1"] }],
    recommendations: [
      recommendation("Low priority", "low", "event-1"), recommendation("Critical first", "critical", "event-1"),
      recommendation("High second", "high", "event-1"), recommendation("Medium omitted", "medium", "event-1"),
    ],
    evidence: [{ reference: "event-1", context: "Redacted <script>alert(1)</script> context" }],
  });
  for (const anchor of ["summary", "context", "top-actions", "what-happened", "what-worked", "lessons-risks", "visualizations", "evidence-appendix"]) {
    assert.match(html, new RegExp(`href="#${anchor}"`));
    assert.match(html, new RegExp(`id="${anchor}"`));
  }
  assert.match(html, /position:sticky/);
  assert.match(html, /Model-generated reading summary/);
  assert.match(html, /no raw session identity is displayed/);
  assert.equal((html.match(/class="action-card"/g) || []).length, 3);
  assert.ok(html.indexOf("Critical first") < html.indexOf("High second"));
  assert.doesNotMatch(html.slice(html.indexOf('id="top-actions"'), html.indexOf('id="what-happened"')), /Low priority/);
  assert.match(html, /<details><summary>Claims \(1\)<\/summary>/);
  assert.match(html, /<details><summary>Embedded redacted evidence \(1\)<\/summary>/);
  assert.match(html, /href="#citation-1">event-1<\/a>/);
  assert.match(html, /Safe fallback assembled from cited claims/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/i);
});
