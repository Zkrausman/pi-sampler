import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix as path, relative, resolve, sep } from "node:path";

const TICKET_ID = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/;
const SHA = /^[a-f0-9]{40}$/;
const SOURCE_ID = /^SRC-\d{4}-\d{2}-\d{2}-\d{3}$/;
const PAGE_ID = /^(concepts|entities|requirements|analysis|cases|skills|synthesis)\/[a-z0-9][a-z0-9-]*$/;
const OBSERVATION_ID = /^obs-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

export const REQUIRED_SOURCE_KINDS = ["ticket", "spec", "pull_request", "review", "verification"];
export const REQUIRED_WIKI_TOOLS = [
  "wiki_recall",
  "wiki_capture_source",
  "wiki_ingest",
  "wiki_search",
  "wiki_ensure_page",
  "wiki_observe",
  "wiki_lint",
  "wiki_status",
];

export class DeliveryFailure extends Error {
  constructor(stage, code) {
    super(`${stage}:${code}`);
    this.stage = stage;
    this.code = code;
  }
}

function fail(stage, code) {
  throw new DeliveryFailure(stage, code);
}

function assert(condition, stage, code) {
  if (!condition) fail(stage, code);
}

function safeCode(error) {
  return error instanceof DeliveryFailure ? error.code : "operation_failed";
}

export function isAllowedSourcePath(value, kind) {
  if (typeof value !== "string" || value.trim() === "") return false;
  if (isAbsolute(value)) return false;
  const normalized = path.normalize(value.replace(/\\/g, "/")).toLowerCase();
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/") || /^[a-z]:\//.test(normalized)) return false;
  if (/\.(env|token|pem|key)$/.test(normalized)) return false;
  if (kind === "spec" && /^docs\/specs\/[^/]+\.md$/.test(normalized)) return true;
  return /^docs\/okf\/(?:[^/]+\/)*[^/]+\.md$/.test(normalized);
}

// Resolve and inspect every component before the installed Wiki tool can read
// it. The approved surface contains only redacted, repository-tracked Markdown.
export async function validateSafeSourceFile(repositoryRoot, source) {
  if (!isAllowedSourcePath(source?.filePath, source?.kind)) fail("capture", "forbidden_source_path");
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, source.filePath);
  const candidateRelative = relative(root, candidate);
  if (candidateRelative === "" || candidateRelative === ".." || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative)) {
    fail("capture", "forbidden_source_path");
  }
  let current = root;
  for (const component of candidateRelative.split(sep)) {
    current = resolve(current, component);
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink()) fail("capture", "forbidden_source_path");
  }
  const resolvedRoot = await realpath(root).catch(() => undefined);
  const resolvedCandidate = await realpath(candidate).catch(() => undefined);
  if (!resolvedRoot || !resolvedCandidate) fail("capture", "forbidden_source_path");
  const resolvedRelative = relative(resolvedRoot, resolvedCandidate);
  if (resolvedRelative === "" || resolvedRelative === ".." || resolvedRelative.startsWith(`..${sep}`) || isAbsolute(resolvedRelative)) {
    fail("capture", "forbidden_source_path");
  }
  return candidate;
}

function validateInput(input, requireExpectedCommit = true) {
  assert(TICKET_ID.test(input.ticketId), "request", "invalid_ticket_id");
  if (requireExpectedCommit) assert(SHA.test(input.expectedDeliveryCommit), "request", "invalid_expected_delivery_commit");
  assert(Array.isArray(input.sources), "request", "missing_sources");
  assert(Array.isArray(input.canonicalPages) && input.canonicalPages.length > 0, "request", "missing_canonical_pages");
  assert(Array.isArray(input.verifications) && input.verifications.length > 0, "request", "missing_verifications");

  const kinds = new Set();
  for (const source of input.sources) {
    assert(REQUIRED_SOURCE_KINDS.includes(source.kind), "request", "invalid_source_kind");
    assert(!kinds.has(source.kind), "request", "duplicate_source_kind");
    assert(typeof source.title === "string" && source.title.trim() !== "", "request", "missing_source_title");
    assert(isAllowedSourcePath(source.filePath, source.kind), "request", "forbidden_source_path");
    kinds.add(source.kind);
  }
  for (const kind of REQUIRED_SOURCE_KINDS) assert(kinds.has(kind), "request", "missing_required_source");

  for (const page of input.canonicalPages) {
    assert(["entity", "concept", "synthesis", "analysis", "requirement", "skill", "case"].includes(page.type), "request", "invalid_page_type");
    assert(typeof page.title === "string" && page.title.trim() !== "", "request", "missing_page_title");
  }
}

function validateCompleteLint(lint) {
  assert(lint?.complete === true, "lint", "lint_not_complete");
  assert(lint.orphans === 0, "lint", "orphans_present");
  assert(lint.missingPages === 0, "lint", "missing_pages_present");
  assert(lint.contradictions === 0, "lint", "contradictions_present");
}

export async function assertExpectedDeliveryCommit(git, expectedDeliveryCommit) {
  assert(SHA.test(expectedDeliveryCommit), "commit", "invalid_expected_delivery_commit");
  const commit = await git.inspect(expectedDeliveryCommit);
  assert(commit?.exists === true, "commit", "expected_commit_not_found");
  assert(commit.head === expectedDeliveryCommit, "commit", "expected_commit_is_not_head");
  assert(commit.clean === true, "commit", "worktree_not_clean_before_manifest");
}

function manifestFor(input, sourceIds, pageIds, observationIds) {
  return {
    schema_version: "delivery-evidence/v1",
    ticket_id: input.ticketId,
    okf_path: input.okfPath,
    delivery_state: input.deliveryState,
    pull_request: input.pullRequest,
    commit_sha: input.expectedDeliveryCommit,
    wiki: {
      source_ids: sourceIds,
      page_ids: pageIds,
      observation_ids: observationIds,
    },
    verifications: input.verifications,
    review: {
      verdict: input.reviewVerdict,
      commit_sha: input.expectedDeliveryCommit,
    },
    merge: input.merge,
  };
}

/**
 * Executes the delivery lifecycle against injected interfaces. It deliberately
 * records identifiers and digests only: source material and tool output never
 * cross this boundary. Production adapters must use the installed Wiki tools.
 */
export class DeliveryController {
  constructor({ wiki, git, manifestWriter, validator, audit }) {
    this.wiki = wiki;
    this.git = git;
    this.manifestWriter = manifestWriter;
    this.validator = validator;
    this.audit = audit ?? { record: async () => {} };
  }

  async run(input) {
    let stage = "request";
    let manifestPath;
    try {
      validateInput(input);
      stage = "commit";
      await assertExpectedDeliveryCommit(this.git, input.expectedDeliveryCommit);

      stage = "recall";
      await this.wiki.recall(input.recallQuery);

      stage = "capture";
      const sourceIds = [];
      for (const source of input.sources) {
        const captured = await this.wiki.capture(source);
        assert(SOURCE_ID.test(captured?.sourceId ?? ""), stage, "invalid_source_id");
        assert(!sourceIds.includes(captured.sourceId), stage, "duplicate_source_id");
        sourceIds.push(captured.sourceId);
      }

      stage = "ingestion";
      const ingestion = await this.wiki.ingest(sourceIds);
      assert(ingestion?.complete === true, stage, "ingestion_not_complete");

      stage = "canonical_pages";
      const pageIds = [];
      for (const page of input.canonicalPages) {
        await this.wiki.search(page.title, page.type);
        const resolved = await this.wiki.ensurePage(page);
        assert(PAGE_ID.test(resolved?.id ?? ""), stage, "invalid_page_id");
        assert(!pageIds.includes(resolved.id), stage, "duplicate_page_id");
        pageIds.push(resolved.id);
      }

      stage = "observation";
      const observed = await this.wiki.observe({
        ticketId: input.ticketId,
        pageIds,
        sourceIds,
      });
      assert(OBSERVATION_ID.test(observed?.observationId ?? ""), stage, "invalid_observation_id");

      stage = "lint";
      validateCompleteLint(await this.wiki.lint());

      stage = "manifest";
      const manifest = manifestFor(input, sourceIds, pageIds, [observed.observationId]);
      manifestPath = await this.manifestWriter.write(input.ticketId, manifest);
      assert(typeof manifestPath === "string" && manifestPath.endsWith(`/${input.ticketId}.json`), stage, "manifest_write_failed");

      stage = "validation";
      const validation = await this.validator.validate(manifestPath, input.expectedDeliveryCommit);
      assert(validation?.valid === true, stage, "manifest_validation_failed");

      return { status: "delivered", manifestPath, manifest };
    } catch (error) {
      // An unvalidated manifest is not evidence. A production writer removes
      // it, while a fake may omit remove for focused stage testing.
      if (manifestPath && typeof this.manifestWriter.remove === "function") await this.manifestWriter.remove(manifestPath);
      const outcome = { status: "failed", stage: error instanceof DeliveryFailure ? error.stage : stage, code: safeCode(error) };
      await this.audit.record(outcome);
      return outcome;
    }
  }
}

/**
 * Tracks one ordered official-Wiki lifecycle. Calls are permitted only at their
 * expected transition and use the source/page values chosen at begin time, so
 * unrelated Wiki actions cannot satisfy a delivery run.
 */
export class ObservedWikiLifecycle {
  constructor(input) {
    validateInput(input, false);
    this.input = input;
    this.phase = "recall";
    this.sourceIndex = 0;
    this.pageIndex = 0;
    this.sourceIds = [];
    this.pageIds = [];
    this.observationIds = [];
    this.ingestIndex = 0;
    this.ingestionRequested = false;
    this.requestedIngestionIDs = new Set();
    this.ingestionReceipts = new Map();
    this.lintRequested = false;
    this.statusObserved = false;
    this.lint = undefined;
  }

  expectedTool() {
    return {
      recall: "wiki_recall",
      capture: "wiki_capture_source",
      ingest: "wiki_ingest",
      search: "wiki_search",
      ensure: "wiki_ensure_page",
      observe: "wiki_observe",
      lint: "wiki_lint",
      status: "wiki_status",
    }[this.phase];
  }

  canExecute(toolName, params = {}) {
    if (toolName !== this.expectedTool()) return false;
    if (this.phase === "recall") return params.query === this.input.recallQuery;
    if (this.phase === "capture") return params.file_path === this.input.sources[this.sourceIndex]?.filePath;
    if (this.phase === "ingest") return params.source_id === this.sourceIds[this.ingestIndex];
    if (this.phase === "search") {
      const page = this.input.canonicalPages[this.pageIndex];
      return params.query === page?.title && params.type === page?.type;
    }
    if (this.phase === "ensure") {
      const page = this.input.canonicalPages[this.pageIndex];
      return params.title === page?.title && params.type === page?.type;
    }
    return true;
  }

  observeToolResult(toolName, details, isError = false) {
    if (isError || toolName !== this.expectedTool()) return;
    if (this.phase === "recall") {
      this.phase = "capture";
      return;
    }
    if (this.phase === "capture") {
      assert(SOURCE_ID.test(details?.sourceId ?? ""), "capture", "invalid_source_id");
      this.sourceIds.push(details.sourceId);
      this.sourceIndex += 1;
      if (this.sourceIndex === this.input.sources.length) this.phase = "ingest";
      return;
    }
    if (this.phase === "ingest") {
      this.ingestionRequested = true;
      this.requestedIngestionIDs.add(this.sourceIds[this.ingestIndex]);
      this.ingestIndex += 1;
      this.phase = this.ingestIndex === this.sourceIds.length ? "search" : "ingest";
      return;
    }
    if (this.phase === "search") {
      this.phase = "ensure";
      return;
    }
    if (this.phase === "ensure") {
      assert(PAGE_ID.test(details?.pageId ?? ""), "canonical_pages", "invalid_page_id");
      this.pageIds.push(details.pageId);
      this.pageIndex += 1;
      this.phase = this.pageIndex === this.input.canonicalPages.length ? "observe" : "search";
      return;
    }
    if (this.phase === "observe") {
      assert(OBSERVATION_ID.test(details?.slug ?? ""), "observation", "invalid_observation_id");
      this.observationIds.push(details.slug);
      this.phase = "lint";
      return;
    }
    if (this.phase === "lint") {
      this.lintRequested = true;
      this.phase = "status";
      return;
    }
    if (this.phase === "status") {
      this.statusObserved = true;
      this.phase = "ingestion_attestation";
    }
  }

  recordActionReport(content, digest) {
    if (typeof content !== "string" || !/^[a-f0-9]{64}$/.test(digest ?? "")) return;
    const ingestion = content.match(/LLM Wiki: ingested (SRC-\d{4}-\d{2}-\d{2}-\d{3})/);
    if (ingestion && this.requestedIngestionIDs.has(ingestion[1])) this.ingestionReceipts.set(ingestion[1], digest);
    if (!this.lintRequested || !content.includes("LLM Wiki lint complete")) return;
    const orphans = content.match(/- Orphans:\s*(\d+)/);
    const missingPages = content.match(/- Missing:\s*(\d+)/);
    const contradictions = content.match(/- Contradictions:\s*(\d+)/);
    if (!orphans || !missingPages || !contradictions) return;
    this.lint = {
      complete: true,
      orphans: Number(orphans[1]),
      missingPages: Number(missingPages[1]),
      contradictions: Number(contradictions[1]),
      receiptSHA256: digest,
    };
  }

  attestIngestionComplete() {
    assert(this.phase === "ingestion_attestation" && this.ingestionRequested, "ingestion", "ingestion_not_ready_for_attestation");
    assert(this.sourceIds.every((sourceID) => this.ingestionReceipts.has(sourceID)), "ingestion", "missing_completion_receipt");
    this.phase = "lint_attestation";
  }

  attestLintComplete() {
    assert(this.phase === "lint_attestation" && this.lintRequested && this.statusObserved, "lint", "lint_not_ready_for_attestation");
    validateCompleteLint(this.lint);
    this.phase = "ready";
  }

  manifest(expectedDeliveryCommit) {
    assert(SHA.test(expectedDeliveryCommit), "commit", "invalid_expected_delivery_commit");
    assert(this.phase === "ready", "lifecycle", "lifecycle_not_complete");
    assert(this.sourceIds.length === this.input.sources.length, "capture", "capture_not_complete");
    assert(this.sourceIds.every((sourceID) => this.ingestionReceipts.has(sourceID)), "ingestion", "ingestion_not_complete");
    assert(this.pageIds.length === this.input.canonicalPages.length, "canonical_pages", "canonical_pages_not_complete");
    assert(this.observationIds.length > 0, "observation", "observation_not_complete");
    validateCompleteLint(this.lint);
    return manifestFor({ ...this.input, expectedDeliveryCommit }, this.sourceIds, this.pageIds, this.observationIds);
  }
}

export function missingRequiredWikiTools(toolNames) {
  const available = new Set(toolNames);
  return REQUIRED_WIKI_TOOLS.filter((tool) => !available.has(tool));
}
