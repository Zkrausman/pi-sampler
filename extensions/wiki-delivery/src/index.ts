import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DeliveryFailure,
  ObservedWikiLifecycle,
  assertExpectedDeliveryCommit,
  validateSafeSourceFile,
  missingRequiredWikiTools,
  REQUIRED_WIKI_TOOLS,
} from "./controller.mjs";

const REQUIRED_WIKI_TOOL_SET = new Set(REQUIRED_WIKI_TOOLS);
const DELIVERY_MANIFEST_DIRECTORY = "evidence/delivery";
const runs = new Map<string, ObservedWikiLifecycle>();

function toolDetails(event: { details?: unknown }): Record<string, unknown> {
  return event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
}

function pageID(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const match = path.replace(/\\/g, "/").match(/\.llm-wiki\/wiki\/(concepts|entities|requirements|analysis|cases|skills|synthesis)\/([a-z0-9][a-z0-9-]*)\.md$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function safeError(error: unknown): { stage: string; code: string } {
  if (error instanceof DeliveryFailure) return { stage: error.stage, code: error.code };
  return { stage: "controller", code: "operation_failed" };
}

function inputFrom(params: Record<string, any>) {
  return {
    ticketId: params.ticket_id,
      recallQuery: params.recall_query,
    okfPath: params.okf_path,
    deliveryState: params.delivery_state,
    pullRequest: { number: params.pr_number, url: params.pr_url, draft: params.pr_draft },
    reviewVerdict: params.review_verdict,
    merge: params.merge_commit ? { status: params.merge_status, commit_sha: params.merge_commit } : { status: params.merge_status },
    sources: params.sources.map((source: Record<string, unknown>) => ({
      kind: source.kind,
      title: source.title,
      filePath: source.file_path,
    })),
    canonicalPages: params.canonical_pages,
    verifications: params.verifications,
  };
}

async function inspectCommit(pi: ExtensionAPI, expected: string) {
  const exists = await pi.exec("git", ["cat-file", "-e", `${expected}^{commit}`]);
  const head = await pi.exec("git", ["rev-parse", "HEAD"]);
  const status = await pi.exec("git", ["status", "--porcelain"]);
  return {
    exists: exists.code === 0,
    head: head.code === 0 ? head.stdout.trim() : "",
    clean: status.code === 0 && status.stdout.trim() === "",
  };
}

function lifecyclePrompt(runID: string, input: ReturnType<typeof inputFrom>) {
  const sourceLines = input.sources.map((source: Record<string, string>) =>
    `- ${source.kind}: call wiki_capture_source with file_path=${JSON.stringify(source.filePath)} and title=${JSON.stringify(source.title)}`,
  );
  const pageLines = input.canonicalPages.map((page: Record<string, string>) =>
    `- Search with wiki_search, then call wiki_ensure_page(type=${JSON.stringify(page.type)}, title=${JSON.stringify(page.title)})`,
  );
  return [
    `Run ${runID} is a fail-closed Wiki delivery lifecycle for ${input.ticketId}.`,
    "Use only the installed Wiki tools. Do not read or edit .llm-wiki/raw or .llm-wiki/meta, do not emit source/tool contents, and do not update Linear.",
    "1. Call wiki_recall.",
    "2. Capture these redacted local inputs as immutable sources:",
    ...sourceLines,
    "3. Call wiki_ingest separately with source_id for every captured source ID. Wait for every supported completion report. A dispatch acknowledgement is not completion.",
    "4. Resolve/create only these canonical pages:",
    ...pageLines,
    "5. Call wiki_observe with paths/commit/results but no raw output, credentials, broker data, or hidden reasoning.",
    "6. Call wiki_lint, wait for its supported completion report, then call wiki_status. Call wiki_delivery_attest once for ingestion and once for lint. The controller derives completion-report digests and lint counts from the installed Wiki action reports; do not supply output text or counts.",
    "7. Do not finalize while canonical Wiki changes are uncommitted. Have the authorized caller commit the tracked canonical/redacted inputs, then call wiki_delivery_finalize with that new clean delivery SHA. It will write the allowed manifest and invoke the authoritative Go validator only if all observed stages are complete.",
  ].join("\n");
}

const sourceSchema = Type.Object({
  kind: Type.String(),
  title: Type.String(),
  file_path: Type.String(),
});
const pageSchema = Type.Object({ type: Type.String(), title: Type.String() });
const verificationSchema = Type.Object({
  command: Type.String(),
  exit_code: Type.Integer(),
  outcome: Type.String(),
  output_sha256: Type.String(),
  failure_marker: Type.Optional(Type.String()),
  classification: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
});
const beginSchema = Type.Object({
  ticket_id: Type.String(),
  recall_query: Type.String(),
  okf_path: Type.String(),
  delivery_state: Type.String(),
  pr_number: Type.Integer(),
  pr_url: Type.String(),
  pr_draft: Type.Boolean(),
  review_verdict: Type.String(),
  merge_status: Type.String(),
  merge_commit: Type.Optional(Type.String()),
  sources: Type.Array(sourceSchema, { minItems: 5 }),
  canonical_pages: Type.Array(pageSchema, { minItems: 1 }),
  verifications: Type.Array(verificationSchema, { minItems: 1 }),
});

export default function wikiDeliveryController(pi: ExtensionAPI) {
  const record = (data: Record<string, unknown>) => pi.appendEntry("wiki-delivery-controller", data);

  pi.on("session_start", async () => {
    // An interrupted/reloaded run cannot be safely resumed because Pi exposes
    // no durable public handle for another extension's in-flight Wiki tools.
    // Dropping it forces a fresh lifecycle rather than a false success claim.
    runs.clear();
  });

  pi.on("tool_call", async (event) => {
    if (!REQUIRED_WIKI_TOOL_SET.has(event.toolName) || runs.size === 0) return;
    const run = [...runs.values()][0];
    if (!run.canExecute(event.toolName, event.input as Record<string, unknown>)) {
      return { block: true, reason: "Wiki delivery lifecycle requires the next controller-approved operation." };
    }
  });

  pi.on("tool_result", async (event) => {
    if (!REQUIRED_WIKI_TOOL_SET.has(event.toolName) || runs.size === 0) return;
    const details = toolDetails(event);
    const normalized = {
      sourceId: details.sourceId,
      slug: details.slug,
      pageId: pageID(details.path),
    };
    const run = [...runs.values()][0];
    run.observeToolResult(event.toolName, normalized, event.isError === true);
  });

  pi.on("message_end", async (event) => {
    const message = event.message as { customType?: unknown; content?: unknown };
    if (message.customType !== "wiki-action-report" || typeof message.content !== "string" || runs.size === 0) return;
    // The installed Wiki runtime emits this completion message. Keep only its
    // digest and parsed aggregate lint counts; never return or persist content.
    const digest = createHash("sha256").update(message.content).digest("hex");
    [...runs.values()][0].recordActionReport(message.content, digest);
  });

  pi.registerTool({
    name: "wiki_delivery_begin",
    label: "Wiki Delivery Begin",
    description: "Begin an agent-mediated, fail-closed delivery lifecycle using the installed LLM Wiki tools.",
    parameters: beginSchema,
    async execute(_id, params, _signal, _update, ctx) {
      if (runs.size > 0) throw new Error("A Wiki delivery run is already active.");
      const missing = missingRequiredWikiTools(pi.getActiveTools());
      if (missing.length > 0) throw new DeliveryFailure("setup", "required_wiki_tools_unavailable");
      const input = inputFrom(params);
      try {
        const checkout = await pi.exec("git", ["status", "--porcelain"]);
        if (checkout.code !== 0 || checkout.stdout.trim() !== "") throw new DeliveryFailure("commit", "worktree_not_clean_at_begin");
        await Promise.all(input.sources.map((source: Record<string, unknown>) => validateSafeSourceFile(ctx.cwd ?? process.cwd(), source)));
        const runID = `${input.ticketId}-delivery`;
        const run = new ObservedWikiLifecycle(input);
        runs.set(runID, run);
        record({ run_id: runID, ticket_id: input.ticketId, status: "pending" });
        pi.sendUserMessage(lifecyclePrompt(runID, input), { deliverAs: "followUp" });
        return { content: [{ type: "text", text: `Wiki delivery run ${runID} started; delivery remains pending until finalization.` }], details: { run_id: runID, status: "pending" } };
      } catch (error) {
        const failure = safeError(error);
        record({ status: "failed", ...failure });
        return { content: [{ type: "text", text: `Wiki delivery failed closed at ${failure.stage}: ${failure.code}.` }], details: { status: "failed", ...failure } };
      }
    },
  });

  pi.registerTool({
    name: "wiki_delivery_attest",
    label: "Wiki Delivery Attest",
    description: "Record a redacted completion attestation for an already-observed Wiki ingestion or lint request.",
    parameters: Type.Object({
      run_id: Type.String(),
      stage: Type.String(),
    }),
    async execute(_id, params) {
      const run = runs.get(params.run_id);
      if (!run) throw new Error("Unknown Wiki delivery run.");
      try {
        if (params.stage === "ingestion") run.attestIngestionComplete();
        else if (params.stage === "lint") run.attestLintComplete();
        else throw new DeliveryFailure("attestation", "invalid_attestation_stage");
        record({ run_id: params.run_id, status: "pending", stage: params.stage });
        return { content: [{ type: "text", text: `Recorded ${params.stage} completion for ${params.run_id}.` }], details: { status: "pending", stage: params.stage } };
      } catch (error) {
        const failure = safeError(error);
        record({ run_id: params.run_id, status: "failed", ...failure });
        return { content: [{ type: "text", text: `Wiki delivery failed closed at ${failure.stage}: ${failure.code}.` }], details: { status: "failed", ...failure } };
      }
    },
  });

  pi.registerTool({
    name: "wiki_delivery_finalize",
    label: "Wiki Delivery Finalize",
    description: "Write a delivery manifest to evidence/delivery/<TICKET>.json and run the authoritative Go validator after every Wiki stage is observed and attested.",
    parameters: Type.Object({ run_id: Type.String(), expected_delivery_commit: Type.String() }),
    async execute(_id, params) {
      const run = runs.get(params.run_id);
      if (!run) throw new Error("Unknown Wiki delivery run.");
      let manifestPath: string | undefined;
      let manifestWritten = false;
      try {
        const manifest = run.manifest(params.expected_delivery_commit);
        await assertExpectedDeliveryCommit({ inspect: async (expected: string) => inspectCommit(pi, expected) }, manifest.commit_sha);
        manifestPath = resolve(process.cwd(), DELIVERY_MANIFEST_DIRECTORY, `${manifest.ticket_id}.json`);
        await mkdir(dirname(manifestPath), { recursive: true });
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        manifestWritten = true;
        const result = await pi.exec("go", ["run", "./cmd/delivery-evidence-validator", "-manifest", relative(process.cwd(), manifestPath), "-repo-root", ".", "-expected-commit", manifest.commit_sha]);
        if (result.code !== 0) throw new DeliveryFailure("validation", "manifest_validation_failed");
        const outcome = { run_id: params.run_id, status: "delivered", manifest_path: `${DELIVERY_MANIFEST_DIRECTORY}/${manifest.ticket_id}.json`, expected_delivery_commit: manifest.commit_sha };
        record(outcome);
        runs.delete(params.run_id);
        return { content: [{ type: "text", text: `Wiki delivery manifest validated: ${DELIVERY_MANIFEST_DIRECTORY}/${manifest.ticket_id}.json` }], details: outcome };
      } catch (error) {
        // Do not leave an unvalidated delivery manifest for an operator to
        // mistake as evidence. The safe local session receipt remains auditable.
        if (manifestWritten && manifestPath) await unlink(manifestPath).catch(() => {});
        const failure = safeError(error);
        const outcome = { run_id: params.run_id, status: "failed", ...failure };
        record(outcome);
        return { content: [{ type: "text", text: `Wiki delivery failed closed at ${failure.stage}: ${failure.code}. No delivery success is claimed.` }], details: outcome };
      }
    },
  });
}
