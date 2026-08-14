import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  DeliveryController,
  DeliveryFailure,
  ObservedWikiLifecycle,
  REQUIRED_WIKI_TOOLS,
} from "./controller.mjs";
import { syncPullRequestEvidence } from "./sync-pr-evidence.mjs";

const ticket = "AIDEV-91";
const sha = "a".repeat(40);
const syncScript = new URL("./sync-pr-evidence.mjs", import.meta.url);

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-wiki-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function deliveryInput() {
  return {
    ticketId: ticket,
    expectedDeliveryCommit: sha,
    recallQuery: "AIDEV-91 delivery",
    okfPath: "docs/specs/AIDEV-91.md",
    deliveryState: "review_ready",
    pullRequest: { number: 0, url: "", draft: true },
    reviewVerdict: "approved",
    merge: { status: "not_merged" },
    sources: [
      { kind: "ticket", title: "Ticket", filePath: "docs/okf/AIDEV-91-ticket.md" },
      { kind: "spec", title: "Specification", filePath: "docs/specs/AIDEV-91.md" },
      { kind: "pull_request", title: "Pull request", filePath: "docs/okf/AIDEV-91-pr.md" },
      { kind: "review", title: "Review", filePath: "docs/okf/AIDEV-91-review.md" },
      { kind: "verification", title: "Verification", filePath: "docs/okf/AIDEV-91-verification.md" },
    ],
    canonicalPages: [{ type: "requirement", title: "AIDEV-91 manifest path" }],
    verifications: [{ command: "node --test", exit_code: 0, outcome: "passed", output_sha256: "b".repeat(64) }],
  };
}

function wiki(overrides = {}) {
  let source = 0;
  return {
    recall: async () => {},
    capture: async () => ({ sourceId: `SRC-2026-01-01-${String(++source).padStart(3, "0")}` }),
    ingest: async () => ({ complete: true }),
    search: async () => {},
    ensurePage: async () => ({ id: "requirements/aidev-91-manifest-path" }),
    observe: async () => ({ observationId: "obs-2026-01-01-aidev-91" }),
    lint: async () => ({ complete: true, orphans: 0, missingPages: 0, contradictions: 0 }),
    ...overrides,
  };
}

function manifestWriter(root) {
  const path = join(root, "evidence", "delivery", `${ticket}.json`).replace(/\\/g, "/");
  return {
    path,
    write: async (_ticket, manifest) => {
      await mkdir(join(root, "evidence", "delivery"), { recursive: true });
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      return path;
    },
    remove: async (manifestPath) => rm(manifestPath, { force: true }),
  };
}

function controller(root, { valid = true, wikiOverrides, git, writer, audit } = {}) {
  const deliveryWriter = writer ?? manifestWriter(root);
  return {
    writer: deliveryWriter,
    audit: audit ?? [],
    value: new DeliveryController({
      wiki: wiki(wikiOverrides),
      git: git ?? { inspect: async () => ({ exists: true, head: sha, clean: true }) },
      manifestWriter: deliveryWriter,
      validator: { validate: async () => ({ valid }) },
      audit: { record: async (outcome) => (audit ?? []).push(outcome) },
    }),
  };
}

function expectFailure(fn, stage, code) {
  assert.throws(fn, (error) => error instanceof DeliveryFailure && error.stage === stage && error.code === code);
}

function recordLifecycleResult(run, toolName, params, details = {}) {
  assert.equal(run.canExecute(toolName, params), true, `${toolName} must be the approved next operation`);
  run.observeToolResult(toolName, details);
}

function completeObservedLifecycle(run) {
  recordLifecycleResult(run, "wiki_recall", { query: run.input.recallQuery });
  for (let index = 0; index < run.input.sources.length; index += 1) {
    const source = run.input.sources[index];
    recordLifecycleResult(run, "wiki_capture_source", { file_path: source.filePath }, { sourceId: `SRC-2026-01-01-${String(index + 1).padStart(3, "0")}` });
  }
  for (const sourceId of run.sourceIds) recordLifecycleResult(run, "wiki_ingest", { source_id: sourceId });
  for (const page of run.input.canonicalPages) {
    recordLifecycleResult(run, "wiki_search", { query: page.title, type: page.type });
    recordLifecycleResult(run, "wiki_ensure_page", { title: page.title, type: page.type }, { pageId: "requirements/aidev-91-manifest-path" });
  }
  recordLifecycleResult(run, "wiki_observe", {}, { slug: "obs-2026-01-01-aidev-91" });
  recordLifecycleResult(run, "wiki_lint");
  recordLifecycleResult(run, "wiki_status");
}

function documentedBeginInput() {
  return readFile(new URL("../README.md", import.meta.url), "utf8").then((readme) => {
    const match = readme.match(/## Example:[\s\S]*?```json\s*([\s\S]*?)```/);
    assert.ok(match, "README must include a JSON wiki_delivery_begin example");
    return JSON.parse(match[1]);
  });
}

function lifecycleInputFromBegin(params) {
  return {
    ticketId: params.ticket_id,
    recallQuery: params.recall_query,
    okfPath: params.okf_path,
    deliveryState: params.delivery_state,
    pullRequest: { number: params.pr_number, url: params.pr_url, draft: params.pr_draft },
    reviewVerdict: params.review_verdict,
    merge: params.merge_commit ? { status: params.merge_status, commit_sha: params.merge_commit } : { status: params.merge_status },
    sources: params.sources.map((source) => ({ kind: source.kind, title: source.title, filePath: source.file_path })),
    canonicalPages: params.canonical_pages,
    verifications: params.verifications,
  };
}

async function loadExtension() {
  const controllerSource = await readFile(new URL("./controller.mjs", import.meta.url), "utf8");
  let extensionSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  extensionSource = extensionSource
    .replace(/import type \{ ExtensionAPI \}[^\n]+\n/, "")
    .replace(/import \{ Type \} from "typebox";\r?\n/, "")
    .replace(/import \{\r?\n  DeliveryFailure,[\s\S]*?\r?\n\} from "\.\/controller\.mjs";\r?\n/, "");
  const typebox = "const Type = { Object: (value) => value, String: () => ({}), Integer: () => ({}), Boolean: () => ({}), Array: () => ({}), Optional: (value) => value };\n";
  const compiled = ts.transpileModule(`${controllerSource}\n${typebox}${extensionSource}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "wiki-delivery.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

function extensionAPI({ activeTools = REQUIRED_WIKI_TOOLS, dirty = false, validatorPasses = true } = {}) {
  const events = new Map();
  const tools = new Map();
  const records = [];
  const messages = [];
  return {
    events,
    messages,
    records,
    tools,
    api: {
      appendEntry: (_type, value) => records.push(value),
      exec: async (command, args) => {
        if (command === "git" && args[0] === "status") return { code: 0, stdout: dirty ? " M changed.md\n" : "" };
        if (command === "git" && args[0] === "cat-file") return { code: 0, stdout: "" };
        if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${sha}\n` };
        if (command === "go") return { code: validatorPasses ? 0 : 1, stdout: "" };
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
      getActiveTools: () => activeTools,
      on: (name, handler) => events.set(name, handler),
      registerTool: (tool) => tools.set(tool.name, tool),
      sendUserMessage: (message, options) => messages.push({ message, options }),
    },
  };
}

async function writeDocumentedSources(root, params) {
  await Promise.all(params.sources.map(async ({ file_path }) => {
    const target = join(root, ...file_path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "# Redacted source\n");
  }));
}

test("README lifecycle JSON uses every accepted source kind and path contract", async () => {
  const documented = await documentedBeginInput();
  assert.doesNotThrow(() => new ObservedWikiLifecycle(lifecycleInputFromBegin(documented)));
  assert.deepEqual(documented.sources.map(({ kind }) => kind).sort(), ["pull_request", "review", "spec", "ticket", "verification"]);
  assert.equal(documented.sources.every(({ file_path }) => /^(docs\/specs\/[^/]+\.md|docs\/okf\/(?:[^/]+\/)*[^/]+\.md)$/.test(file_path)), true);
});

test("finalized delivery is found and synchronized at the canonical manifest default", async (t) => {
  const root = await project(t);
  const { writer, value } = controller(root);
  const finalized = await value.run(deliveryInput());

  assert.equal(finalized.status, "delivered");
  assert.equal(finalized.manifestPath, writer.path);
  assert.deepEqual(JSON.parse(await readFile(writer.path, "utf8")).pull_request, { number: 0, url: "", draft: true });

  const originalCwd = process.cwd();
  let synced;
  process.chdir(root);
  try {
    synced = await syncPullRequestEvidence(ticket, undefined, () => ({
      number: 91,
      url: "https://github.com/example/project/pull/91",
    }));
  } finally {
    process.chdir(originalCwd);
  }
  assert.match(synced, /evidence\/delivery\/AIDEV-91\.json/);
  assert.deepEqual(JSON.parse(await readFile(writer.path, "utf8")).pull_request, {
    number: 91,
    url: "https://github.com/example/project/pull/91",
    draft: true,
  });
});

test("controller fails closed at every injected lifecycle stage", async (t) => {
  const scenarios = [
    ["commit", "expected_commit_not_found", { git: { inspect: async () => ({ exists: false, head: sha, clean: true }) } }],
    ["recall", "operation_failed", { wikiOverrides: { recall: async () => { throw new Error("recall unavailable"); } } }],
    ["capture", "invalid_source_id", { wikiOverrides: { capture: async () => ({ sourceId: "not-a-source" }) } }],
    ["ingestion", "ingestion_not_complete", { wikiOverrides: { ingest: async () => ({ complete: false }) } }],
    ["canonical_pages", "invalid_page_id", { wikiOverrides: { ensurePage: async () => ({ id: "wrong/page" }) } }],
    ["observation", "invalid_observation_id", { wikiOverrides: { observe: async () => ({ observationId: "wrong-observation" }) } }],
    ["lint", "orphans_present", { wikiOverrides: { lint: async () => ({ complete: true, orphans: 1, missingPages: 0, contradictions: 0 }) } }],
    ["manifest", "manifest_write_failed", { writer: { write: async () => "not-a-manifest-path" } }],
    ["validation", "manifest_validation_failed", { valid: false }],
  ];
  for (const [stage, code, options] of scenarios) {
    const root = await project(t);
    const audit = [];
    const { value, writer } = controller(root, { ...options, audit });
    assert.deepEqual(await value.run(deliveryInput()), { status: "failed", stage, code });
    assert.deepEqual(audit, [{ status: "failed", stage, code }]);
    if (stage === "validation") await assert.rejects(readFile(writer.path, "utf8"));
  }
});

test("observed lifecycle blocks out-of-order, incomplete, and invalid transitions before manifest creation", () => {
  const run = new ObservedWikiLifecycle(deliveryInput());
  expectFailure(() => run.manifest(sha), "lifecycle", "lifecycle_not_complete");
  assert.equal(run.canExecute("wiki_capture_source", { file_path: run.input.sources[0].filePath }), false);
  run.observeToolResult("wiki_recall", {}, true);
  assert.equal(run.phase, "recall");
  recordLifecycleResult(run, "wiki_recall", { query: run.input.recallQuery });
  expectFailure(() => run.observeToolResult("wiki_capture_source", { sourceId: "bad" }), "capture", "invalid_source_id");

  const duplicateSource = new ObservedWikiLifecycle(deliveryInput());
  recordLifecycleResult(duplicateSource, "wiki_recall", { query: duplicateSource.input.recallQuery });
  recordLifecycleResult(duplicateSource, "wiki_capture_source", { file_path: duplicateSource.input.sources[0].filePath }, { sourceId: "SRC-2026-01-01-001" });
  expectFailure(() => duplicateSource.observeToolResult("wiki_capture_source", { sourceId: "SRC-2026-01-01-001" }), "capture", "duplicate_source_id");

  const duplicatePage = new ObservedWikiLifecycle({
    ...deliveryInput(),
    canonicalPages: [
      { type: "requirement", title: "AIDEV-91 manifest path" },
      { type: "requirement", title: "AIDEV-91 duplicate page" },
    ],
  });
  recordLifecycleResult(duplicatePage, "wiki_recall", { query: duplicatePage.input.recallQuery });
  for (let index = 0; index < duplicatePage.input.sources.length; index += 1) {
    recordLifecycleResult(duplicatePage, "wiki_capture_source", { file_path: duplicatePage.input.sources[index].filePath }, { sourceId: `SRC-2026-01-01-${String(index + 1).padStart(3, "0")}` });
  }
  for (const sourceId of duplicatePage.sourceIds) recordLifecycleResult(duplicatePage, "wiki_ingest", { source_id: sourceId });
  recordLifecycleResult(duplicatePage, "wiki_search", { query: duplicatePage.input.canonicalPages[0].title, type: "requirement" });
  recordLifecycleResult(duplicatePage, "wiki_ensure_page", { title: duplicatePage.input.canonicalPages[0].title, type: "requirement" }, { pageId: "requirements/aidev-91-manifest-path" });
  recordLifecycleResult(duplicatePage, "wiki_search", { query: duplicatePage.input.canonicalPages[1].title, type: "requirement" });
  expectFailure(() => duplicatePage.observeToolResult("wiki_ensure_page", { pageId: "requirements/aidev-91-manifest-path" }), "canonical_pages", "duplicate_page_id");

  const complete = new ObservedWikiLifecycle(deliveryInput());
  completeObservedLifecycle(complete);
  expectFailure(() => complete.attestIngestionComplete(), "ingestion", "missing_completion_receipt");
  for (const sourceId of complete.sourceIds) complete.recordActionReport(`LLM Wiki: ingested ${sourceId}`, "c".repeat(64));
  complete.attestIngestionComplete();
  expectFailure(() => complete.attestLintComplete(), "lint", "lint_not_complete");
  complete.recordActionReport("LLM Wiki lint complete\n- Orphans: 1\n- Missing: 0\n- Contradictions: 0", "d".repeat(64));
  expectFailure(() => complete.attestLintComplete(), "lint", "orphans_present");
  complete.recordActionReport("LLM Wiki lint complete\n- Orphans: 0\n- Missing: 0\n- Contradictions: 0", "e".repeat(64));
  complete.attestLintComplete();
  assert.equal(complete.manifest(sha).commit_sha, sha);
});

test("registered extension rejects invalid setup and completes an observed README lifecycle", async (t) => {
  const documented = await documentedBeginInput();
  const module = await loadExtension();
  const extension = extensionAPI();
  module.default(extension.api);
  assert.deepEqual([...extension.tools.keys()], ["wiki_delivery_begin", "wiki_delivery_attest", "wiki_delivery_finalize"]);

  const begin = extension.tools.get("wiki_delivery_begin");
  const attest = extension.tools.get("wiki_delivery_attest");
  const finalize = extension.tools.get("wiki_delivery_finalize");
  const root = await project(t);
  await writeDocumentedSources(root, documented);

  const unavailable = extensionAPI({ activeTools: REQUIRED_WIKI_TOOLS.slice(1) });
  module.default(unavailable.api);
  await assert.rejects(
    unavailable.tools.get("wiki_delivery_begin").execute("", documented, undefined, undefined, { cwd: root }),
    (error) => error instanceof Error && error.message === "setup:required_wiki_tools_unavailable",
  );

  const dirty = extensionAPI({ dirty: true });
  module.default(dirty.api);
  assert.deepEqual((await dirty.tools.get("wiki_delivery_begin").execute("", documented, undefined, undefined, { cwd: root })).details, {
    status: "failed", stage: "commit", code: "worktree_not_clean_at_begin",
  });

  const unsafe = { ...documented, sources: documented.sources.map((source, index) => index === 0 ? { ...source, file_path: "../outside.md" } : source) };
  assert.deepEqual((await begin.execute("", unsafe, undefined, undefined, { cwd: root })).details, {
    status: "failed", stage: "capture", code: "forbidden_source_path",
  });

  const started = await begin.execute("", documented, undefined, undefined, { cwd: root });
  const runID = started.details.run_id;
  assert.equal(started.details.status, "pending");
  assert.match(extension.messages.at(-1).message, /wiki_capture_source/);
  await assert.rejects(begin.execute("", documented, undefined, undefined, { cwd: root }), /already active/);
  assert.deepEqual(await extension.events.get("tool_call")({ toolName: "wiki_capture_source", input: { file_path: documented.sources[0].file_path } }), {
    block: true, reason: "Wiki delivery lifecycle requires the next controller-approved operation.",
  });
  assert.deepEqual((await finalize.execute("", { run_id: runID, expected_delivery_commit: sha })).details, {
    run_id: runID, status: "failed", stage: "lifecycle", code: "lifecycle_not_complete",
  });
  assert.deepEqual((await attest.execute("", { run_id: runID, stage: "unsupported" })).details, {
    status: "failed", stage: "attestation", code: "invalid_attestation_stage",
  });
  await assert.rejects(attest.execute("", { run_id: "unknown-delivery", stage: "ingestion" }), /Unknown Wiki delivery run/);
  await extension.events.get("session_start")();

  const successful = await begin.execute("", documented, undefined, undefined, { cwd: root });
  const successfulRunID = successful.details.run_id;
  const toolCall = extension.events.get("tool_call");
  const toolResult = extension.events.get("tool_result");
  const actionReport = extension.events.get("message_end");
  async function executeObservedTool(toolName, input, details = {}) {
    assert.equal(await toolCall({ toolName, input }), undefined);
    await toolResult({ toolName, details, isError: false });
  }

  await executeObservedTool("wiki_recall", { query: documented.recall_query });
  const sourceIDs = [];
  for (const [index, source] of documented.sources.entries()) {
    const sourceId = `SRC-2026-01-01-${String(index + 1).padStart(3, "0")}`;
    sourceIDs.push(sourceId);
    await executeObservedTool("wiki_capture_source", { file_path: source.file_path }, { sourceId });
  }
  for (const sourceId of sourceIDs) await executeObservedTool("wiki_ingest", { source_id: sourceId });
  for (const page of documented.canonical_pages) {
    await executeObservedTool("wiki_search", { query: page.title, type: page.type });
    await executeObservedTool("wiki_ensure_page", { title: page.title, type: page.type }, { path: ".llm-wiki/wiki/requirements/aidev-92-lifecycle.md" });
  }
  await executeObservedTool("wiki_observe", {}, { slug: "obs-2026-01-01-aidev-92-lifecycle" });
  await executeObservedTool("wiki_lint");
  await executeObservedTool("wiki_status");
  for (const sourceId of sourceIDs) await actionReport({ message: { customType: "wiki-action-report", content: `LLM Wiki: ingested ${sourceId}` } });
  await actionReport({ message: { customType: "wiki-action-report", content: "LLM Wiki lint complete\n- Orphans: 0\n- Missing: 0\n- Contradictions: 0" } });
  assert.equal((await attest.execute("", { run_id: successfulRunID, stage: "ingestion" })).details.status, "pending");
  assert.equal((await attest.execute("", { run_id: successfulRunID, stage: "lint" })).details.status, "pending");

  const originalCwd = process.cwd();
  process.chdir(root);
  try {
    const result = await finalize.execute("", { run_id: successfulRunID, expected_delivery_commit: sha });
    assert.deepEqual(result.details, {
      run_id: successfulRunID,
      status: "delivered",
      manifest_path: `evidence/delivery/${documented.ticket_id}.json`,
      expected_delivery_commit: sha,
    });
    assert.equal(JSON.parse(await readFile(join(root, "evidence", "delivery", `${documented.ticket_id}.json`), "utf8")).ticket_id, documented.ticket_id);
  } finally {
    process.chdir(originalCwd);
  }
});

test("failed validation removes the canonical manifest rather than synchronizing unvalidated evidence", async (t) => {
  const root = await project(t);
  const { writer, value } = controller(root, { valid: false });

  assert.deepEqual(await value.run(deliveryInput()), {
    status: "failed",
    stage: "validation",
    code: "manifest_validation_failed",
  });
  await assert.rejects(readFile(writer.path, "utf8"));
});

test("production finalization reports and synchronization defaults use evidence/delivery", async () => {
  const [index, sync] = await Promise.all([
    readFile(new URL("./index.ts", import.meta.url), "utf8"),
    readFile(syncScript, "utf8"),
  ]);

  assert.equal(index.includes("delivery/evidence"), false);
  assert.equal(sync.includes("delivery/evidence"), false);
  assert.match(index, /DELIVERY_MANIFEST_DIRECTORY = "evidence\/delivery"/);
  assert.match(index, /Wiki delivery manifest validated: \$\{DELIVERY_MANIFEST_DIRECTORY\}\//);
  assert.match(sync, /`evidence\/delivery\/\$\{ticket\}\.json`/);
});
