import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { generateCatalogHtml, groupSessions } from "./catalog.mjs";
import { generateConversationFlowHtml, projectConversation } from "./flow.mjs";
import { attachEvidenceReferences, createEvidenceManifest, createHindsightRecommendationDispositionMetadata } from "./evidence.mjs";
import { generateRelationshipMapHtml, projectRelationshipMap } from "./map.mjs";
import { buildClaimSupportValidationPrompt, buildHindsightDocument, buildSynthesisPrompt } from "./synthesis.mjs";
import { restrictToolsForHindsightSynthesis } from "./hindsight-tools.mjs";
import { HINDSIGHT_WORK_CONFIG_PATH, HindsightWorkError, acceptedHindsightRecommendations, buildLinearIssueCreatePayload, digestHindsightWorkPayload, isValidExistingIssueId, parseHindsightWorkDispositions, readHindsightWorkLinks, requireFinalHindsightWorkConfirmation, validateHindsightLinearConfig, validateHindsightWorkContext, withHindsightWorkBacklinkLock, workLinkKey, workLinksPathForDispositionPath, writeHindsightWorkLink } from "./hindsight-work.mjs";
import { HindsightOutcomeError, appendHindsightOutcomeUpdate, createHindsightOutcomeOrigin, hindsightReportPathForDispositionPath, outcomeHistoryPathForDispositionPath, outcomeHistoryReportPathForDispositionPath, readHindsightOutcomeHistory, refreshHindsightReportOutcomeHistory, withHindsightOutcomeLock, writeHindsightOutcomeHistoryReport } from "./hindsight-outcomes.mjs";
import { HindsightLinearAdapter, createRequestPreview, linkLookupRequestPreview } from "./hindsight-linear-adapter.mjs";
import { compileSensitivePatterns, createRedactionMetadata, findSensitiveContent, generateExcludedConversationHtml, pseudonymizeSession, redactProjection } from "./redaction.mjs";

const DEFAULT_FILENAME = "pi-conversation-catalog.html";

function resolveOutputPath(args: string, cwd: string, defaultFilename = DEFAULT_FILENAME, label = "catalog"): string {
  const requestedPath = args.trim() || defaultFilename;
  if (requestedPath.includes("\0")) throw new Error("The output path is invalid.");

  const outputPath = resolve(cwd, requestedPath);
  if (extname(outputPath).toLowerCase() !== ".html") {
    throw new Error(`The ${label} output path must end in .html.`);
  }
  return outputPath;
}

function flowArguments(args: string) {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return match ? { sessionId: match[1], outputPath: match[2] || "" } : undefined;
}

function hindsightArguments(args: string) {
  const flag = "--validate-claim-support";
  let remaining = args.trim();
  let validateClaimSupport = false;
  if (remaining === flag || remaining.startsWith(`${flag} `)) {
    validateClaimSupport = true;
    remaining = remaining.slice(flag.length).trim();
  }
  const priorMatch = remaining.match(/(?:^|\s)--prior-outcomes\s+(\S+)/);
  let priorOutcomesPath: string | undefined;
  if (priorMatch) {
    priorOutcomesPath = priorMatch[1];
    remaining = `${remaining.slice(0, priorMatch.index)}${remaining.slice((priorMatch.index || 0) + priorMatch[0].length)}`.trim();
  } else if (/(?:^|\s)--prior-outcomes(?:\s|$)/.test(remaining)) {
    throw new Error("--prior-outcomes requires one .outcomes.json path.");
  }
  return { outputPath: remaining, validateClaimSupport, priorOutcomesPath };
}

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "session";
}

function metadataPath(outputPath: string) {
  return outputPath.replace(/\.html$/i, ".redaction.json");
}

function hindsightDispositionMetadataPath(outputPath: string) {
  return outputPath.replace(/\.html$/i, ".dispositions.json");
}

async function writeHindsightReport(outputPath: string, html: string, recommendationDocument: { recommendations: unknown[] }) {
  const dispositionPath = hindsightDispositionMetadataPath(outputPath);
  const temporaryDispositionPath = `${dispositionPath}.${randomUUID()}.tmp`;
  const metadata = createHindsightRecommendationDispositionMetadata(recommendationDocument);
  await mkdir(dirname(outputPath), { recursive: true });
  // Stage the replacement seed first, but do not replace an existing seed until
  // the report itself has written. A failed HTML write therefore leaves the
  // prior local disposition record intact.
  await writeFile(temporaryDispositionPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  try {
    await writeFile(outputPath, html, "utf8");
    await rename(temporaryDispositionPath, dispositionPath);
  } catch (error) {
    await rm(temporaryDispositionPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return dispositionPath;
}

function pickerDescription(value: unknown) {
  const words = typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean) : [];
  return words.length > 10 ? `${words.slice(0, 10).join(" ")}…` : words.join(" ");
}

function pickerLabel(session: any) {
  const description = pickerDescription(session.name || session.firstMessage) || "Untitled session";
  const id = typeof session.id === "string" ? session.id.slice(0, 8) : "unknown";
  return `${session.cwd || "Unknown location"} — ${description} (${id})`;
}

async function configuredPatterns(cwd: string) {
  try {
    const configPath = resolve(cwd, ".pi", "conversation-redaction-patterns.json");
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    return compileSensitivePatterns(parsed?.patterns);
  } catch (error: any) {
    if (error?.code === "ENOENT") return compileSensitivePatterns();
    throw new Error("Unable to read .pi/conversation-redaction-patterns.json.");
  }
}

function hindsightWorkErrorMessage(error: unknown) {
  const code = error instanceof HindsightWorkError ? error.code : "operation_failed";
  const messages: Record<string, string> = {
    untrusted_project: "Hindsight work requires a trusted project.",
    ui_required: "Hindsight work requires Pi's interactive UI.",
    confirmation_required: "Hindsight work canceled.",
    config_missing: "Hindsight work is unavailable: .pi/hindsight-linear.json was not found.",
    invalid_config: "Hindsight work is unavailable: the trusted project config is invalid.",
    invalid_team_id: "Hindsight work is unavailable: the configured team ID is invalid.",
    invalid_endpoint: "Hindsight work is unavailable: the configured endpoint is not the official Linear GraphQL endpoint.",
    invalid_token_reference: "Hindsight work is unavailable: the configured token environment reference is invalid.",
    missing_token: "Hindsight work is unavailable: the referenced token environment variable is not set.",
    invalid_disposition_path: "Use a report companion path ending in .dispositions.json.",
    malformed_metadata: "The disposition metadata is malformed, unsupported, or lacks the required version 2 immutable model fields.",
    no_accepted_recommendations: "The disposition metadata contains no user-confirmed accepted recommendations.",
    duplicate_link: "This recommendation already has a local work link; no remote request was made.",
    invalid_work_links: "The existing local work-links record is invalid; it was not replaced.",
    linear_request_failed: "Linear could not resolve the requested issue. No local link was written.",
    linear_http_error: "Linear returned an HTTP error. No local link was written.",
    linear_graphql_error: "Linear rejected the request. No local link was written.",
    linear_response_too_large: "Linear returned an oversized response. No local link was written.",
    linear_issue_not_found: "The specified Linear issue was not found. No local link was written.",
    team_mismatch: "The specified Linear issue is not in the configured team. No local link was written.",
    invalid_linear_response: "Linear returned an unexpected response. No local link was written.",
    linear_create_rejected: "Linear did not create the issue. No local link was written.",
    unknown_create_outcome: "The Linear create outcome is unknown. It was not retried; resolve and explicitly link an existing issue instead.",
    local_record_failed_after_create: "Linear created the issue, but the local work-link record could not be written. Do not retry creation; resolve and explicitly link the existing issue.",
  };
  return messages[code] || "Unable to create or link hindsight work. No local link was written.";
}

function hindsightOutcomeErrorMessage(error: unknown) {
  const code = error instanceof HindsightOutcomeError ? error.code : "operation_failed";
  const messages: Record<string, string> = {
    ui_required: "Hindsight outcome updates require Pi's interactive UI.",
    invalid_disposition_path: "Use a report companion path ending in .dispositions.json.",
    malformed_metadata: "The disposition metadata is malformed, unsupported, or lacks an accepted user-confirmed recommendation.",
    no_accepted_recommendations: "The disposition metadata contains no user-confirmed accepted recommendations.",
    accepted_recommendation_required: "Outcome updates require a user-confirmed accepted recommendation.",
    malformed_outcome: "The outcome history or update is malformed; it was not changed.",
    unsafe_outcome_text: "Outcome text must not include raw session identifiers or credentials; it was not saved.",
    outcome_origin_mismatch: "The outcome history belongs to a different immutable recommendation; it was not changed.",
    outcome_history_missing: "No outcome history exists at the supplied path.",
    outcome_report_marker_missing: "The generated hindsight report has no safe outcome-history placeholder; the JSON record was not changed.",
    confirmation_required: "Hindsight outcome update canceled.",
  };
  return messages[code] || "Unable to record the local hindsight outcome update.";
}

function isTrustedProject(ctx: any) {
  return typeof ctx?.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
}

function acceptedRecommendationLabel(recommendation: any) {
  const text = typeof recommendation?.recommendation === "string" ? recommendation.recommendation.trim() : "";
  const preview = Array.from(text).slice(0, 80).join("");
  return `Recommendation ${recommendation?.recommendationNumber}: ${preview}${Array.from(text).length > 80 ? "…" : ""}`;
}

async function loadHindsightLinearConfiguration(cwd: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(cwd, HINDSIGHT_WORK_CONFIG_PATH), "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new HindsightWorkError("config_missing");
    throw new HindsightWorkError("invalid_config");
  }
  const validated = validateHindsightLinearConfig(parsed);
  if (!validated.ok) throw new HindsightWorkError(validated.code);
  return validated;
}

async function reviewRedactionChoices(ctx: any, findings: any[]) {
  if (!ctx.hasUI) throw new Error("Conversation export requires an interactive Pi UI so redaction choices can be reviewed.");
  if (findings.length === 0) {
    const approved = await ctx.ui.confirm("No sensitive content detected", "Export this conversation flow without redactions?");
    if (!approved) throw new Error("Conversation export canceled.");
    return { excluded: false, decisions: {} };
  }

  const begin = await ctx.ui.select("Conversation redaction preview", ["Review findings", "Exclude this conversation"]);
  if (!begin) throw new Error("Conversation export canceled.");
  if (begin === "Exclude this conversation") return { excluded: true, decisions: {} };

  const decisions: Record<string, string> = {};
  for (const [index, finding] of findings.entries()) {
    const choice = await ctx.ui.select(
      `Finding ${index + 1}/${findings.length}: ${finding.pattern} — ${finding.preview}`,
      ["Redact (recommended)", "Retain", "Exclude this conversation"],
    );
    if (!choice) throw new Error("Conversation export canceled.");
    if (choice === "Exclude this conversation") return { excluded: true, decisions };
    decisions[finding.id] = choice === "Retain" ? "retain" : "redact";
  }
  return { excluded: false, decisions };
}

/** A read-only catalog of Pi session metadata and an opt-in historical flow viewer. */
export default function conversationCatalog(pi: ExtensionAPI) {
  let pendingHindsight: {
    sources: any[];
    outputPath: string;
    restoreTools: () => void;
    validateClaimSupport: boolean;
    priorOutcomes?: any;
    phase: "draft" | "validation";
    modelOutput?: any;
  } | undefined;

  // Keep every direct write-capable session tool disabled until the model run
  // settles, including any follow-up turn after the safe tool returns.
  pi.on("agent_settled", () => {
    const pending = pendingHindsight;
    if (!pending) return;
    pendingHindsight = undefined;
    pending.restoreTools();
  });

  pi.registerTool({
    name: "hindsight_document_write",
    label: "Write safe hindsight document",
    description: "Writes the requested hindsight report through its safe HTML citation contract. Use this instead of writing hindsight HTML directly.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      claims: Type.Array(Type.Object({
        statement: Type.String({ minLength: 1, maxLength: 2000 }),
        classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]),
        evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }),
      }, { additionalProperties: false }), { maxItems: 80 }),
      recommendations: Type.Array(Type.Object({
        recommendation: Type.String({ minLength: 1, maxLength: 1000 }),
        priority: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
        expectedImpact: Type.String({ minLength: 1, maxLength: 500 }),
        suggestedOwner: Type.String({ minLength: 1, maxLength: 200 }),
        dependencies: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }),
        acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 20 }),
        status: Type.Literal("proposed"),
        source: Type.Literal("model-suggestion"),
        evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }),
      }, { additionalProperties: false }), { maxItems: 40 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      if (!pendingHindsight || pendingHindsight.phase !== "draft") {
        return { content: [{ type: "text", text: "No hindsight document draft is awaiting generation." }] };
      }
      try {
        if (pendingHindsight.validateClaimSupport) {
          const validationPrompt = buildClaimSupportValidationPrompt(pendingHindsight.sources, params);
          pendingHindsight.modelOutput = params;
          pendingHindsight.phase = "validation";
          // The draft writer is removed before its result asks the model for the
          // separate support pass, so only the validator can finish this report.
          pi.setActiveTools(["hindsight_claim_support_validate"]);
          return { content: [{ type: "text", text: validationPrompt }] };
        }
        const html = buildHindsightDocument(pendingHindsight.sources, params, undefined, pendingHindsight.priorOutcomes);
        const dispositionPath = await writeHindsightReport(pendingHindsight.outputPath, html, { recommendations: params.recommendations });
        const outputPath = pendingHindsight.outputPath;
        // Keep the pending state until agent_settled restores the original tool set.
        return { content: [{ type: "text", text: `Hindsight document written to ${outputPath}. Model-suggestion disposition seed written locally to ${dispositionPath}.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? `Unable to write hindsight document: ${error.message}` : "Unable to write hindsight document." }] };
      }
    },
  });

  pi.registerTool({
    name: "hindsight_claim_support_validate",
    label: "Validate cited hindsight claim support",
    description: "Completes an opt-in claim-support pass using only the cited, redacted excerpts returned by the safe report contract.",
    parameters: Type.Object({
      source: Type.Literal("model-validation"),
      userDisposition: Type.Literal("not-user-confirmed"),
      assessments: Type.Array(Type.Object({
        claimNumber: Type.Integer({ minimum: 1 }),
        support: Type.Union([
          Type.Literal("supported"),
          Type.Literal("partially supported"),
          Type.Literal("unsupported"),
          Type.Literal("unverifiable"),
        ]),
        rationale: Type.String({ minLength: 1, maxLength: 1000 }),
        evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }),
      }, { additionalProperties: false }), { maxItems: 80 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      if (!pendingHindsight || pendingHindsight.phase !== "validation" || !pendingHindsight.modelOutput) {
        return { content: [{ type: "text", text: "No claim-support validation is awaiting completion." }] };
      }
      try {
        const html = buildHindsightDocument(pendingHindsight.sources, pendingHindsight.modelOutput, params, pendingHindsight.priorOutcomes);
        const dispositionPath = await writeHindsightReport(pendingHindsight.outputPath, html, { recommendations: pendingHindsight.modelOutput.recommendations });
        const outputPath = pendingHindsight.outputPath;
        return { content: [{ type: "text", text: `Hindsight document with claim-support validation written to ${outputPath}. Model-suggestion disposition seed written locally to ${dispositionPath}.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? `Unable to validate hindsight claim support: ${error.message}` : "Unable to validate hindsight claim support." }] };
      }
    },
  });

  pi.registerCommand("conversation-catalog", {
    description: "Write a standalone HTML catalog of saved Pi sessions",
    async handler(args, ctx) {
      let outputPath: string;
      try {
        outputPath = resolveOutputPath(args, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "The output path is invalid.", "error");
        return;
      }

      try {
        // Deliberately retain only the catalog allowlist; transcript text never reaches the renderer or output.
        const metadata = (await SessionManager.listAll()).map((session) => ({
          id: session.id,
          name: session.name,
          firstMessage: session.firstMessage,
          cwd: session.cwd,
          modified: session.modified,
          messageCount: session.messageCount,
        }));
        const html = generateCatalogHtml(groupSessions(metadata));

        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, html, "utf8");
        ctx.ui.notify(`Conversation catalog written to ${outputPath}. Open this .html file directly in your browser.`, "info");
      } catch {
        ctx.ui.notify("Unable to write the conversation catalog.", "error");
      }
    },
  });

  pi.registerCommand("conversation-flow", {
    description: "Review redactions, then write a standalone HTML flow view for one saved Pi session",
    async handler(args, ctx) {
      const requested = flowArguments(args);
      if (!requested) {
        ctx.ui.notify("Usage: /conversation-flow <session-id> [output-path]", "error");
        return;
      }

      try {
        // listAll selects a historical file; Pi itself parses it through open(), never this extension.
        const sessions = await SessionManager.listAll();
        const exact = sessions.filter((session) => session.id === requested.sessionId);
        const candidates = exact.length > 0 ? exact : sessions.filter((session) => session.id.startsWith(requested.sessionId));
        if (candidates.length === 0) {
          ctx.ui.notify(`No saved session matches “${requested.sessionId}”.`, "error");
          return;
        }
        if (candidates.length > 1) {
          ctx.ui.notify(`Session ID prefix “${requested.sessionId}” is ambiguous; provide a longer ID.`, "error");
          return;
        }

        const selected = candidates[0];
        const outputPath = resolveOutputPath(
          requested.outputPath,
          ctx.cwd,
          `pi-conversation-flow-${safeFilename(pseudonymizeSession(selected))}.html`,
          "conversation flow",
        );
        const manager = await SessionManager.open(selected.path);
        const projection = projectConversation(manager.getEntries());
        const findings = findSensitiveContent(projection, await configuredPatterns(ctx.cwd));
        const review = await reviewRedactionChoices(ctx, findings);
        const exportSession = { id: pseudonymizeSession(selected), name: "Selected conversation" };
        const citedProjection = review.excluded
          ? undefined
          : attachEvidenceReferences(exportSession.id, redactProjection(projection, findings, review.decisions));
        const metadata = {
          ...createRedactionMetadata(exportSession.id, findings, review.decisions, review.excluded),
          evidence: citedProjection ? createEvidenceManifest(citedProjection) : { schemaVersion: 1, citations: [] },
        };
        const html = review.excluded
          ? generateExcludedConversationHtml(exportSession)
          : generateConversationFlowHtml(exportSession, citedProjection);
        const decisionPath = metadataPath(outputPath);
        await mkdir(dirname(outputPath), { recursive: true });
        // A metadata write must succeed before content is created; remove it if the
        // content write fails so callers never receive an orphaned decision record.
        await writeFile(decisionPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        try {
          await writeFile(outputPath, html, "utf8");
        } catch (error) {
          await rm(decisionPath, { force: true }).catch(() => undefined);
          throw error;
        }
        ctx.ui.notify(
          review.excluded
            ? `Conversation excluded. Decision metadata written to ${metadataPath(outputPath)}.`
            : `Conversation flow written to ${outputPath}. Redaction decisions are recorded in ${metadataPath(outputPath)}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Unable to write the conversation flow.", "error");
      }
    },
  });

  pi.registerCommand("hindsight-document", {
    description: "Interactively select one conversation and write a cited hindsight document (optional --validate-claim-support)",
    async handler(args, ctx) {
      try {
        if (!ctx.hasUI) throw new Error("Hindsight generation requires Pi's interactive UI.");
        const requested = hindsightArguments(args);
        let priorOutcomes: any;
        if (requested.priorOutcomesPath) {
          if (!requested.priorOutcomesPath.endsWith(".outcomes.json") || requested.priorOutcomesPath.includes("\0")) {
            throw new HindsightOutcomeError("invalid_disposition_path");
          }
          priorOutcomes = await readHindsightOutcomeHistory(resolve(ctx.cwd, requested.priorOutcomesPath));
          if (!priorOutcomes) throw new HindsightOutcomeError("outcome_history_missing");
        }
        const sessions = await SessionManager.listAll();
        if (sessions.length === 0) throw new Error("No saved conversations are available for hindsight generation.");
        // Numbered choices remain unambiguous even if saved-session labels match.
        // This command deliberately accepts exactly one conversation for now.
        const sessionOptions = sessions.map((session, index) => `${index + 1}. ${pickerLabel(session)}`);
        const choice = await ctx.ui.select("Select one conversation for hindsight", ["Cancel", ...sessionOptions]);
        if (!choice || choice === "Cancel") throw new Error("Hindsight generation canceled.");
        const selectedIndex = sessionOptions.indexOf(choice);
        if (selectedIndex < 0) throw new Error("Select exactly one conversation for hindsight generation.");
        const session = sessions[selectedIndex];
        const patterns = await configuredPatterns(ctx.cwd);
        const projection = projectConversation((await SessionManager.open(session.path)).getEntries());
        const findings = findSensitiveContent(projection, patterns);
        const review = await reviewRedactionChoices(ctx, findings);
        const reference = pseudonymizeSession(session);
        // Keep a local pseudonym so an excluded source can link to an explicit
        // redaction-review fallback without retaining conversation content.
        const sources: any[] = [];
        if (review.excluded) {
          sources.push({ reference, excluded: true });
        } else {
          const cited = attachEvidenceReferences(reference, redactProjection(projection, findings, review.decisions));
          sources.push({ reference, events: cited.events, edges: cited.edges });
        }
        const outputPath = resolveOutputPath(requested.outputPath, ctx.cwd, "pi-hindsight-document.html", "hindsight document");
        const restoreTools = restrictToolsForHindsightSynthesis(pi);
        try {
          pendingHindsight = { sources, outputPath, restoreTools, validateClaimSupport: requested.validateClaimSupport, priorOutcomes, phase: "draft" };
          pi.sendUserMessage(buildSynthesisPrompt(sources, { validateClaimSupport: requested.validateClaimSupport, priorOutcomes }));
        } catch (error) {
          pendingHindsight = undefined;
          restoreTools();
          throw error;
        }
        ctx.ui.notify(`Redacted evidence submitted to the active model. It can only generate the hindsight document through the safe report contract at ${outputPath}.${requested.validateClaimSupport ? " Claim-support validation will run as a separate evidence-scoped model pass." : ""}${priorOutcomes ? " Deliberately supplied prior outcomes are labeled context, not evidence." : ""}`, "info");
      } catch (error) { ctx.ui.notify(error instanceof HindsightOutcomeError ? hindsightOutcomeErrorMessage(error) : error instanceof Error ? error.message : "Unable to generate hindsight document.", "error"); }
    },
  });

  pi.registerCommand("hindsight-outcome", {
    description: "Record a local user-observed outcome update for one accepted hindsight recommendation",
    async handler(args, ctx) {
      try {
        if (!ctx.hasUI) throw new HindsightOutcomeError("ui_required");
        if (typeof ctx.ui.input !== "function") throw new HindsightOutcomeError("ui_required");
        const input = args.trim();
        if (!input || input.includes("\0")) throw new HindsightOutcomeError("invalid_disposition_path");
        const dispositionPath = resolve(ctx.cwd, input);
        const outcomesPath = outcomeHistoryPathForDispositionPath(dispositionPath);
        const outcomeReportPath = outcomeHistoryReportPathForDispositionPath(dispositionPath);
        const reportPath = hindsightReportPathForDispositionPath(dispositionPath);
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(dispositionPath, "utf8"));
        } catch {
          throw new HindsightOutcomeError("malformed_metadata");
        }
        const metadata = parseHindsightWorkDispositions(parsed);
        const accepted = acceptedHindsightRecommendations(metadata);
        const options = ["Cancel", ...accepted.map(acceptedRecommendationLabel)];
        const selectedLabel = await ctx.ui.select("Select a user-confirmed accepted recommendation", options);
        if (!selectedLabel || selectedLabel === "Cancel") throw new Error("Hindsight outcome update canceled.");
        const selected = accepted[options.indexOf(selectedLabel) - 1];
        if (!selected) throw new HindsightOutcomeError("accepted_recommendation_required");
        const status = await ctx.ui.select("User-observed implementation status", ["not-started", "in-progress", "completed", "paused", "stopped", "Cancel"]);
        if (!status || status === "Cancel") throw new Error("Hindsight outcome update canceled.");
        const observedResult = await ctx.ui.input("Observed result", "What did you personally observe? This is not model inference.");
        const measurementEvidence = await ctx.ui.input("Measurement or user-supplied evidence", "What measurement or observation supports the result? Do not paste session logs.");
        const unexpectedEffects = await ctx.ui.input("Unexpected effects", "What unexpected effects did you observe? Enter 'None observed' when applicable.");
        const followUpDecision = await ctx.ui.select("User-confirmed follow-up decision", ["continue", "adjust", "monitor", "stop", "no-follow-up", "Cancel"]);
        if (observedResult === undefined || measurementEvidence === undefined || unexpectedEffects === undefined || !followUpDecision || followUpDecision === "Cancel") {
          throw new Error("Hindsight outcome update canceled.");
        }
        const origin = createHindsightOutcomeOrigin(metadata.reportId, selected);
        const links = await readHindsightWorkLinks(workLinksPathForDispositionPath(dispositionPath));
        const workLink = links.links[workLinkKey(metadata.reportId, selected.recommendationNumber)];
        const update = {
          status,
          observedResult,
          measurementEvidence,
          unexpectedEffects,
          followUpDecision,
          provenance: { source: "user-observed", confirmation: "user-confirmed", confirmedAt: new Date().toISOString() },
          ...(workLink ? { workLink } : {}),
        };
        const confirmed = await ctx.ui.confirm("Final confirmation: save local outcome update", "This appends a user-observed/user-confirmed local outcome record. It makes no network request, does not read or modify session logs, and labels the text as context rather than source evidence. Save this update?");
        if (confirmed !== true) throw new HindsightOutcomeError("confirmation_required");
        const history = await withHindsightOutcomeLock(outcomesPath, () => appendHindsightOutcomeUpdate(outcomesPath, origin, update));
        try {
          await Promise.all([
            writeHindsightOutcomeHistoryReport(outcomeReportPath, history),
            refreshHindsightReportOutcomeHistory(reportPath, history),
          ]);
          ctx.ui.notify(`Local outcome update recorded in ${outcomesPath}. Inspectable history refreshed in ${reportPath} and ${outcomeReportPath}.`, "info");
        } catch {
          ctx.ui.notify(`Local outcome update recorded in ${outcomesPath}, but its inspectable HTML history could not be fully refreshed. The JSON record remains intact.`, "error");
        }
      } catch (error: any) {
        ctx.ui.notify(error?.message === "Hindsight outcome update canceled." ? "Hindsight outcome update canceled." : hindsightOutcomeErrorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("hindsight-work", {
    description: "Interactively create or link one accepted hindsight recommendation in configured Linear",
    async handler(args, ctx) {
      try {
        validateHindsightWorkContext({ hasUI: ctx.hasUI, trusted: isTrustedProject(ctx) });
        const input = args.trim();
        if (!input || input.includes("\0")) throw new HindsightWorkError("invalid_disposition_path");
        const dispositionPath = resolve(ctx.cwd, input);
        const linksPath = workLinksPathForDispositionPath(dispositionPath);
        const configuration = await loadHindsightLinearConfiguration(ctx.cwd);
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(dispositionPath, "utf8"));
        } catch {
          throw new HindsightWorkError("malformed_metadata");
        }
        const metadata = parseHindsightWorkDispositions(parsed);
        const accepted = acceptedHindsightRecommendations(metadata);
        const options = ["Cancel", ...accepted.map(acceptedRecommendationLabel)];
        const selectedLabel = await ctx.ui.select("Select a user-confirmed accepted recommendation", options);
        if (!selectedLabel || selectedLabel === "Cancel") throw new Error("Hindsight work canceled.");
        const selected = accepted[options.indexOf(selectedLabel) - 1];
        if (!selected) throw new HindsightWorkError("malformed_metadata");
        const linkAction = await withHindsightWorkBacklinkLock(linksPath, async () => {
          // Keep this whole transaction serialized by backlink file: another
          // recommendation cannot overwrite the same report record mid-write.
          const existing = await readHindsightWorkLinks(linksPath);
          if (existing.links[workLinkKey(metadata.reportId, selected.recommendationNumber)]) throw new HindsightWorkError("duplicate_link");
          const payload = buildLinearIssueCreatePayload(configuration.config.teamId, metadata.reportId, selected);
          const payloadDigest = digestHindsightWorkPayload(payload);
          const action = await ctx.ui.select("Choose confirmed work action", ["Create new Linear issue", "Link existing Linear issue", "Cancel"]);
          if (!action || action === "Cancel") throw new Error("Hindsight work canceled.");
          const adapter = new HindsightLinearAdapter({ endpoint: configuration.config.endpoint, token: configuration.token });
          let issue: { id: string; url: string; status: string };
          let timestamp: string;
          let actionRecord: "created" | "linked";

          if (action === "Create new Linear issue") {
            timestamp = new Date().toISOString();
            const preview = JSON.stringify({ request: JSON.parse(createRequestPreview(payload)), backlink: { action: "created", timestamp, payloadDigest } }, null, 2);
            const confirmed = await ctx.ui.confirm("Final confirmation: create Linear issue", `The exact redacted GraphQL request and local backlink fields below will be used. It contains no source excerpts, raw session IDs, credentials, assignments, or status changes.\n\n${preview}\n\nCreate this issue now?`);
            requireFinalHindsightWorkConfirmation(confirmed);
            issue = await adapter.createIssue(payload, configuration.config.teamId);
            actionRecord = "created";
          } else if (action === "Link existing Linear issue") {
            if (typeof ctx.ui.input !== "function") throw new Error("Hindsight work requires a Pi UI that supports entering an existing issue ID.");
            const issueId = (await ctx.ui.input("Existing Linear issue ID", "Paste the exact Linear issue ID to link"))?.trim();
            if (!isValidExistingIssueId(issueId)) throw new Error("Enter one valid existing Linear issue ID.");
            const lookupPreview = linkLookupRequestPreview(issueId);
            const lookupConfirmed = await ctx.ui.confirm("Confirm Linear issue lookup", `The exact read-only GraphQL lookup payload below will be sent to validate the issue's configured team membership. It does not modify the issue.\n\n${lookupPreview}\n\nResolve this issue now?`);
            requireFinalHindsightWorkConfirmation(lookupConfirmed);
            issue = await adapter.resolveIssue(issueId, configuration.config.teamId);
            timestamp = new Date().toISOString();
            const localPreview = JSON.stringify({ action: "linked", issue, timestamp, payloadDigest }, null, 2);
            const confirmed = await ctx.ui.confirm("Final confirmation: link existing Linear issue", `The issue was resolved in the configured team. The exact local work-link record below will be written; the existing issue will not be modified.\n\n${localPreview}\n\nLink this issue now?`);
            requireFinalHindsightWorkConfirmation(confirmed);
            actionRecord = "linked";
          } else {
            throw new Error("Hindsight work canceled.");
          }

          try {
            await writeHindsightWorkLink(linksPath, metadata.reportId, selected.recommendationNumber, {
              issueId: issue.id,
              issueUrl: issue.url,
              status: issue.status,
              timestamp,
              payloadDigest,
              action: actionRecord,
            });
          } catch (error) {
            if (actionRecord === "created") throw new HindsightWorkError("local_record_failed_after_create");
            throw error;
          }
          return actionRecord;
        });
        ctx.ui.notify(`Hindsight work ${linkAction === "created" ? "created" : "linked"}; local record written to ${linksPath}.`, "info");
      } catch (error: any) {
        ctx.ui.notify(error?.message === "Hindsight work canceled." ? "Hindsight work canceled." : hindsightWorkErrorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("conversation-map", {
    description: "Review redactions, then write an interactive relationship map for one saved session",
    async handler(args, ctx) {
      const requested = flowArguments(args);
      if (!requested) { ctx.ui.notify("Usage: /conversation-map <session-id> [output-path]", "error"); return; }
      try {
        const sessions = await SessionManager.listAll();
        const candidates = sessions.filter((s) => s.id === requested.sessionId || s.id.startsWith(requested.sessionId));
        if (candidates.length !== 1) throw new Error(candidates.length ? "Session ID prefix is ambiguous." : "No saved session matches that ID.");
        const selected = candidates[0];
        const outputPath = resolveOutputPath(requested.outputPath, ctx.cwd, `pi-conversation-map-${safeFilename(pseudonymizeSession(selected))}.html`, "conversation map");
        const projection = projectConversation((await SessionManager.open(selected.path)).getEntries());
        const findings = findSensitiveContent(projection, await configuredPatterns(ctx.cwd));
        const review = await reviewRedactionChoices(ctx, findings);
        if (review.excluded) throw new Error("Conversation excluded; no map was created.");
        const cited = attachEvidenceReferences(pseudonymizeSession(selected), redactProjection(projection, findings, review.decisions));
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, generateRelationshipMapHtml({ id: pseudonymizeSession(selected) }, projectRelationshipMap(cited)), "utf8");
        ctx.ui.notify(`Conversation map written to ${outputPath}.`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to write conversation map.", "error"); }
    },
  });
}
