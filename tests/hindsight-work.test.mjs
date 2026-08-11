import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HindsightWorkError,
  acceptedHindsightRecommendations,
  buildLinearIssueCreatePayload,
  digestHindsightWorkPayload,
  parseHindsightWorkDispositions,
  readHindsightWorkLinks,
  requireFinalHindsightWorkConfirmation,
  validateHindsightLinearConfig,
  validateHindsightWorkContext,
  withHindsightWorkLinkLock,
  workLinkKey,
  writeHindsightWorkLink,
} from "../extensions/conversation-catalog/src/hindsight-work.mjs";
import { HindsightLinearAdapter, ISSUE_CREATE_MUTATION, ISSUE_LOOKUP_QUERY, MAX_LINEAR_RESPONSE_BYTES } from "../extensions/conversation-catalog/src/hindsight-linear-adapter.mjs";

const recommendation = {
  recommendationNumber: 1,
  modelSuggestion: {
    status: "proposed", source: "model-suggestion", recommendation: "Add a bounded retry policy",
    priority: "high", expectedImpact: "Reduce transient failures", suggestedOwner: "Platform team",
    dependencies: ["Error budget agreed"], acceptanceCriteria: ["Retries are capped at three attempts"],
    evidenceReferences: ["session-ab12:event-0001"],
  },
  userDisposition: { status: "accepted", source: "user-confirmed", rationale: "Approved after review", confirmedAt: "2026-08-11T12:00:00.000Z" },
};

function metadata(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: "pi-hindsight-recommendation-dispositions",
    reportId: "hindsight-1234abcd",
    provenance: { modelSuggestions: "model-suggestion", userDispositions: "user-confirmed" },
    exportedAt: "2026-08-11T12:01:00.000Z",
    recommendations: [recommendation],
    ...overrides,
  };
}

function response(value, ok = true, { chunks, contentLength } = {}) {
  const bytes = chunks || [new TextEncoder().encode(JSON.stringify(value))];
  let index = 0;
  let cancelled = false;
  return {
    ok,
    headers: { get: (name) => name === "content-length" ? contentLength : null },
    body: {
      getReader: () => ({
        read: async () => index < bytes.length ? { value: bytes[index++], done: false } : { done: true },
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }),
    },
    wasCancelled: () => cancelled,
  };
}

test("strict accepted disposition metadata produces an excerpt-free create payload", () => {
  const parsed = parseHindsightWorkDispositions(metadata());
  const [accepted] = acceptedHindsightRecommendations(parsed);
  const payload = buildLinearIssueCreatePayload("team_1", parsed.reportId, accepted);
  assert.equal(payload.teamId, "team_1");
  assert.equal(payload.title, "Add a bounded retry policy");
  assert.equal(payload.priority, 2);
  assert.match(payload.description, /Suggested owner \(text only; no assignment\):/);
  assert.match(payload.description, /Priority \(model suggestion\): high/);
  assert.match(payload.description, /Reduce transient failures/);
  assert.match(payload.description, /Error budget agreed/);
  assert.match(payload.description, /Retries are capped at three attempts/);
  assert.match(payload.description, /session-ab12:event-0001/);
  assert.match(payload.description, /local report: hindsight-1234abcd/);
  assert.match(payload.description, /user disposition: accepted · user-confirmed/);
  assert.doesNotMatch(payload.description, /Approved after review|RAW-SESSION-ID|source excerpt/i);
  assert.match(digestHindsightWorkPayload(payload), /^[a-f0-9]{64}$/);
});

test("metadata rejects old, malformed, unconfirmed, and non-pseudonymous inputs without fabrication", () => {
  assert.throws(() => parseHindsightWorkDispositions({ ...metadata(), schemaVersion: 1 }), /malformed_metadata/);
  assert.throws(() => parseHindsightWorkDispositions(metadata({ recommendations: [{ ...recommendation, modelSuggestion: { ...recommendation.modelSuggestion, evidenceReferences: ["RAW-SESSION-ID"] } }] })), /malformed_metadata/);
  assert.throws(() => acceptedHindsightRecommendations(parseHindsightWorkDispositions(metadata({ recommendations: [{ ...recommendation, userDisposition: { ...recommendation.userDisposition, status: "deferred" } }] }))), /no_accepted_recommendations/);
  assert.throws(() => parseHindsightWorkDispositions(metadata({ unexpected: true })), /malformed_metadata/);
});

test("workflow preflight requires an interactive trusted project", () => {
  assert.throws(() => validateHindsightWorkContext({ hasUI: false, trusted: true }), /ui_required/);
  assert.throws(() => validateHindsightWorkContext({ hasUI: true, trusted: false }), /untrusted_project/);
  assert.doesNotThrow(() => validateHindsightWorkContext({ hasUI: true, trusted: true }));
});

test("no final confirmation rejects the action before an adapter operation can be attempted", () => {
  assert.throws(() => requireFinalHindsightWorkConfirmation(false), (error) => error instanceof HindsightWorkError && error.code === "confirmation_required");
  assert.throws(() => requireFinalHindsightWorkConfirmation(undefined), /confirmation_required/);
  assert.doesNotThrow(() => requireFinalHindsightWorkConfirmation(true));
});

test("trusted project config accepts only the official endpoint and an environment reference", () => {
  const valid = { teamId: "team_1", endpoint: "https://api.linear.app/graphql", tokenEnvRef: "$LINEAR_TOKEN" };
  assert.equal(validateHindsightLinearConfig(valid, { env: { LINEAR_TOKEN: "secret" } }).ok, true);
  assert.deepEqual(validateHindsightLinearConfig(undefined, { env: {} }), { ok: false, code: "invalid_config" });
  assert.deepEqual(validateHindsightLinearConfig({ ...valid, endpoint: "https://linear.example/graphql" }, { env: { LINEAR_TOKEN: "secret" } }), { ok: false, code: "invalid_endpoint" });
  assert.deepEqual(validateHindsightLinearConfig({ ...valid, tokenEnvRef: "secret" }, { env: { LINEAR_TOKEN: "secret" } }), { ok: false, code: "invalid_token_reference" });
  assert.deepEqual(validateHindsightLinearConfig(valid, { env: {} }), { ok: false, code: "missing_token" });
});

test("narrow adapter sends the documented create contract and accepts only the configured team", async () => {
  const seen = [];
  const adapter = new HindsightLinearAdapter({
    endpoint: "https://api.linear.app/graphql", token: "never-log-this", timeoutMs: 50,
    fetchImpl: async (_url, options) => {
      seen.push(options);
      return response({ data: { issueCreate: { success: true, issue: { id: "issue_1", url: "https://linear.app/acme/issue/ABC-1", team: { id: "team_1" }, state: { name: "Backlog" } } } } });
    },
  });
  const issue = await adapter.createIssue({ teamId: "team_1", title: "Title", description: "Text", priority: 2 }, "team_1");
  assert.deepEqual(issue, { id: "issue_1", url: "https://linear.app/acme/issue/ABC-1", status: "Backlog" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, "Bearer never-log-this");
  const body = JSON.parse(seen[0].body);
  assert.equal(body.query, ISSUE_CREATE_MUTATION);
  assert.deepEqual(body.variables.input, { teamId: "team_1", title: "Title", description: "Text", priority: 2 });

  const mismatch = new HindsightLinearAdapter({
    endpoint: "https://api.linear.app/graphql", token: "secret",
    fetchImpl: async () => response({ data: { issue: { id: "issue_2", url: "https://linear.app/acme/issue/ABC-2", team: { id: "other_team" }, state: { name: "Todo" } } } }),
  });
  await assert.rejects(() => mismatch.resolveIssue("issue_2", "team_1"), (error) => error instanceof HindsightWorkError && error.code === "team_mismatch");
});

test("every post-dispatch create failure is unknown and non-retryable", async () => {
  const input = { teamId: "team_1", title: "Title", description: "Text", priority: 2 };
  const cases = [
    { name: "HTTP status", response: () => ({ ok: false }) },
    { name: "malformed JSON", response: () => response(undefined, true, { chunks: [new TextEncoder().encode("not-json")] }) },
    { name: "GraphQL error", response: () => response({ errors: [{ message: "private body" }] }) },
    { name: "create rejection", response: () => response({ data: { issueCreate: { success: false } } }) },
    { name: "malformed issue response", response: () => response({ data: { issueCreate: { success: true, issue: { id: "issue_1" } } } }) },
  ];
  for (const scenario of cases) {
    let calls = 0;
    const adapter = new HindsightLinearAdapter({
      endpoint: "https://api.linear.app/graphql", token: "secret",
      fetchImpl: async () => { calls += 1; return scenario.response(); },
    });
    await assert.rejects(() => adapter.createIssue(input, "team_1"), (error) => error instanceof HindsightWorkError && error.code === "unknown_create_outcome", scenario.name);
    assert.equal(calls, 1, `${scenario.name} is not retried`);
  }
});

test("response reading is bounded before JSON decoding", async () => {
  const oversized = response(undefined, true, { chunks: [new Uint8Array(MAX_LINEAR_RESPONSE_BYTES + 1)] });
  const adapter = new HindsightLinearAdapter({
    endpoint: "https://api.linear.app/graphql", token: "secret", fetchImpl: async () => oversized,
  });
  await assert.rejects(() => adapter.resolveIssue("issue_3", "team_1"), (error) => error instanceof HindsightWorkError && error.code === "linear_response_too_large");
  assert.equal(oversized.wasCancelled(), true);
  const create = new HindsightLinearAdapter({
    endpoint: "https://api.linear.app/graphql", token: "secret", fetchImpl: async () => response(undefined, true, { contentLength: String(MAX_LINEAR_RESPONSE_BYTES + 1) }),
  });
  await assert.rejects(() => create.createIssue({ teamId: "team_1", title: "Title", description: "Text", priority: 2 }, "team_1"), (error) => error instanceof HindsightWorkError && error.code === "unknown_create_outcome");
});

test("GraphQL and HTTP failures are opaque and never expose response bodies or credentials", async () => {
  const http = new HindsightLinearAdapter({
    endpoint: "https://api.linear.app/graphql", token: "credential-not-for-output",
    fetchImpl: async () => ({ ok: false, json: async () => ({ errors: [{ message: "response-body-secret" }] }) }),
  });
  await assert.rejects(() => http.resolveIssue("issue_3", "team_1"), (error) => error instanceof HindsightWorkError
    && error.code === "linear_http_error" && !error.message.includes("response-body-secret") && !error.message.includes("credential-not-for-output"));
  const graphql = new HindsightLinearAdapter({
    endpoint: "https://api.linear.app/graphql", token: "credential-not-for-output",
    fetchImpl: async () => response({ errors: [{ message: "response-body-secret" }] }),
  });
  await assert.rejects(() => graphql.resolveIssue("issue_3", "team_1"), (error) => error instanceof HindsightWorkError
    && error.code === "linear_graphql_error" && !error.message.includes("response-body-secret") && !error.message.includes("credential-not-for-output"));
});

test("link lookup has a bounded contract and create timeout remains unknown without a retry", async () => {
  const seen = [];
  const linked = new HindsightLinearAdapter({
    endpoint: "https://api.linear.app/graphql", token: "secret",
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body));
      return response({ data: { issue: { id: "issue_3", url: "https://linear.app/acme/issue/ABC-3", team: { id: "team_1" }, state: { name: "Todo" } } } });
    },
  });
  assert.equal((await linked.resolveIssue("issue_3", "team_1")).status, "Todo");
  assert.equal(seen[0].query, ISSUE_LOOKUP_QUERY);
  assert.deepEqual(seen[0].variables, { id: "issue_3" });

  let calls = 0;
  const timeout = new HindsightLinearAdapter({
    endpoint: "https://api.linear.app/graphql", token: "secret", timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      calls += 1;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("transport body must stay private"))));
    },
  });
  await assert.rejects(() => timeout.createIssue({ teamId: "team_1", title: "Title", description: "Text", priority: 2 }, "team_1"), (error) => error instanceof HindsightWorkError && error.code === "unknown_create_outcome");
  assert.equal(calls, 1);
});

test("concurrent work transactions serialize duplicate check, mutation, and backlink write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-work-lock-"));
  const path = join(directory, "report.work-links.json");
  const reportId = "hindsight-1234abcd";
  const payload = { teamId: "team_1", title: "Title", description: "Text", priority: 2 };
  const link = { issueId: "issue_5", issueUrl: "https://linear.app/acme/issue/ABC-5", status: "Todo", timestamp: "2026-08-11T12:04:00.000Z", payloadDigest: digestHindsightWorkPayload(payload), action: "created" };
  let remoteMutations = 0;
  const transaction = () => withHindsightWorkLinkLock(reportId, 1, async () => {
    const existing = await readHindsightWorkLinks(path);
    if (existing.links[workLinkKey(reportId, 1)]) return "duplicate";
    remoteMutations += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeHindsightWorkLink(path, reportId, 1, link);
    return "created";
  });
  try {
    assert.deepEqual(await Promise.all([transaction(), transaction()]), ["created", "duplicate"]);
    assert.equal(remoteMutations, 1);
    assert.deepEqual((await readHindsightWorkLinks(path)).links[workLinkKey(reportId, 1)], link);
    await assert.rejects(() => withHindsightWorkLinkLock(reportId, 2, async () => { throw new Error("simulated failure"); }), /simulated failure/);
    assert.equal(await withHindsightWorkLinkLock(reportId, 2, async () => "recovered"), "recovered");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful links are atomically recorded once and duplicate links are rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hindsight-work-"));
  const path = join(directory, "report.work-links.json");
  try {
    const payload = { teamId: "team_1", title: "Title", description: "Text", priority: 2 };
    const link = { issueId: "issue_4", issueUrl: "https://linear.app/acme/issue/ABC-4", status: "Todo", timestamp: "2026-08-11T12:03:00.000Z", payloadDigest: digestHindsightWorkPayload(payload), action: "linked" };
    await writeHindsightWorkLink(path, "hindsight-1234abcd", 1, link);
    const stored = await readHindsightWorkLinks(path);
    assert.deepEqual(stored.links[workLinkKey("hindsight-1234abcd", 1)], link);
    assert.match(await readFile(path, "utf8"), /"pi-hindsight-work-links"/);
    await assert.rejects(() => writeHindsightWorkLink(path, "hindsight-1234abcd", 1, link), (error) => error instanceof HindsightWorkError && error.code === "duplicate_link");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
