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
import { HindsightOutcomeError, createHindsightOutcomeOrigin, hindsightReportPathForDispositionPath, outcomeHistoryPathForDispositionPath, outcomeHistoryReportPathForDispositionPath, readHindsightOutcomeHistory, recordHindsightOutcomeUpdate } from "./hindsight-outcomes.mjs";
import { HindsightFeedbackError, createHindsightFeedbackMetadata, feedbackPathForDispositionPath, feedbackReportPathForDispositionPath, readHindsightFeedback, recordHindsightFeedback, refreshHindsightFeedbackViews, writeHindsightFeedbackSeed } from "./hindsight-feedback.mjs";
import { HindsightNotesError, addHindsightNote, deleteHindsightNote, editHindsightNote, hindsightNotesPath, hindsightNotesSessionReference, readHindsightNotes } from "./hindsight-notes.mjs";
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

async function writeHindsightReport(outputPath: string, html: string, reportDocument: { claims: unknown[]; recommendations: unknown[] }) {
  const dispositionPath = hindsightDispositionMetadataPath(outputPath);
  const feedbackPath = feedbackPathForDispositionPath(dispositionPath);
  const temporaryDispositionPath = `${dispositionPath}.${randomUUID()}.tmp`;
  const metadata = createHindsightRecommendationDispositionMetadata(reportDocument);
  const feedbackSeed = createHindsightFeedbackMetadata({ reportId: metadata.reportId, ...reportDocument });
  await mkdir(dirname(outputPath), { recursive: true });
  // Stage the disposition seed first, but do not replace an existing seed until
  // the report itself has written. A failed HTML write therefore leaves the
  // prior local disposition and feedback records intact.
  await writeFile(temporaryDispositionPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  try {
    await writeFile(outputPath, html, "utf8");
    await rename(temporaryDispositionPath, dispositionPath);
    // Matching report identities retain prior entries by immutable target hash;
    // unrelated report edits cannot detach local feedback from its target.
    await writeHindsightFeedbackSeed(feedbackPath, feedbackSeed);
    await refreshHindsightFeedbackViews(feedbackPath, {
      reportPath: outputPath,
      feedbackReportPath: feedbackReportPathForDispositionPath(dispositionPath),
      dispositionPath,
      outcomePath: outcomeHistoryPathForDispositionPath(dispositionPath),
    });
  } catch (error) {
    await rm(temporaryDispositionPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { dispositionPath, feedbackPath };
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
    outcome_report_refresh_failed: "The local outcome JSON was recorded, but its inspectable HTML history could not be fully refreshed. Do not retry solely for the report refresh.",
    outcome_lock_timeout: "Another local outcome update is still in progress; no change was made.",
    confirmation_required: "Hindsight outcome update canceled.",
  };
  return messages[code] || "Unable to record the local hindsight outcome update.";
}

function hindsightFeedbackErrorMessage(error: unknown) {
  const code = error instanceof HindsightFeedbackError ? error.code : "operation_failed";
  const messages: Record<string, string> = {
    ui_required: "Hindsight feedback requires Pi's interactive UI.",
    invalid_feedback_path: "Use a report companion path ending in .dispositions.json.",
    feedback_missing: "The local feedback metadata is missing. Regenerate the report before recording feedback.",
    malformed_feedback: "The local feedback metadata is malformed, unsupported, or too old; it was not changed.",
    invalid_feedback_target: "The report does not expose a valid claim or recommendation feedback target.",
    unsafe_feedback_text: "Corrected framing must not include raw session identifiers or credentials; it was not saved.",
    aggregate_metadata_malformed: "Associated local disposition or outcome metadata is malformed or unsupported; feedback was not changed.",
    aggregate_metadata_mismatch: "Associated local aggregate metadata belongs to a different report; feedback was not changed.",
    feedback_report_marker_missing: "The generated hindsight report has no safe feedback placeholder; feedback was not changed.",
    feedback_report_refresh_failed: "The local feedback JSON was recorded, but its inspectable calibration views could not be refreshed. Do not retry solely for rendering.",
    feedback_lock_timeout: "Another local feedback update is still in progress; no change was made.",
    confirmation_required: "Hindsight feedback canceled.",
  };
  return messages[code] || "Unable to record local hindsight feedback.";
}

function hindsightNotesErrorMessage(error: unknown) {
  const code = error instanceof HindsightNotesError ? error.code : "operation_failed";
  const messages: Record<string, string> = {
    ui_required: "Hindsight notes require Pi's interactive UI.",
    untrusted_project: "Hindsight notes require a trusted project root.",
    current_session_unavailable: "Pi did not expose the active session identity; no note was read or changed.",
    invalid_session_reference: "The local session reference is invalid; no note was read or changed.",
    invalid_notes_path: "The local hindsight-notes path is invalid; no note was read or changed.",
    unsafe_notes_path: "The local hindsight-notes path is a symlink or unsafe filesystem object; no note was read or changed.",
    malformed_notes: "The local hindsight-notes store is malformed or unsupported; it was not changed.",
    session_mismatch: "The local hindsight-notes store belongs to another session; it was not read or changed.",
    unsafe_note_text: "Notes must not include raw session identifiers or credentials; nothing was saved.",
    invalid_note_id: "The selected local note identity is invalid; it was not changed.",
    note_missing: "That local note no longer exists; it was not changed.",
    notes_missing: "No local notes exist for this session.",
    notes_limit_reached: "This session already has the maximum number of local notes.",
    notes_lock_timeout: "Another local hindsight-note operation is in progress; no change was made.",
    confirmation_required: "Hindsight notes canceled.",
  };
  return messages[code] || "Unable to update local hindsight notes.";
}

function isTrustedProject(ctx: any) {
  return typeof ctx?.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
}

// Pi exposes the active session on current command contexts. We only use the
// raw value long enough to match its saved metadata and derive a local opaque
// reference; it is never written, rendered, exported, or sent to a model.
async function currentHindsightSessionReference(ctx: any) {
  const current = ctx?.session || ctx?.currentSession;
  const managedId = typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined;
  const rawId = typeof managedId === "string" ? managedId : typeof current?.id === "string" ? current.id
    : typeof ctx?.sessionId === "string" ? ctx.sessionId : "";
  if (!rawId) throw new HindsightNotesError("current_session_unavailable");
  // The note key intentionally derives from the actual Pi session ID only;
  // display names and legacy 32-bit catalog pseudonyms cannot select notes.
  return hindsightNotesSessionReference(rawId);
}

async function reviewHindsightNotes(ctx: any, notes: any[], patterns: any[]) {
  const included: any[] = [];
  for (const [index, note] of notes.entries()) {
    const projection = { events: [{ id: note.noteId, summary: note.text, metadata: [] }], edges: [] };
    const findings = findSensitiveContent(projection, patterns);
    let decisions: Record<string, string> = {};
    if (findings.length === 0) {
      const choice = await ctx.ui.select(`Hindsight note ${index + 1}: no sensitive content detected`, ["Include as user-authored context", "Exclude this note", "Cancel"]);
      if (!choice || choice === "Cancel") throw new HindsightNotesError("confirmation_required");
      if (choice === "Exclude this note") continue;
    } else {
      const begin = await ctx.ui.select(`Hindsight note ${index + 1}: sensitive content detected`, ["Review findings", "Exclude this note", "Cancel"]);
      if (!begin || begin === "Cancel") throw new HindsightNotesError("confirmation_required");
      if (begin === "Exclude this note") continue;
      let excluded = false;
      for (const [findingIndex, finding] of findings.entries()) {
        const choice = await ctx.ui.select(
          `Note finding ${findingIndex + 1}/${findings.length}: ${finding.pattern} — ${finding.preview}`,
          ["Redact (recommended)", "Retain", "Exclude this note", "Cancel"],
        );
        if (!choice || choice === "Cancel") throw new HindsightNotesError("confirmation_required");
        if (choice === "Exclude this note") { excluded = true; break; }
        decisions[finding.id] = choice === "Retain" ? "retain" : "redact";
      }
      if (excluded) continue;
    }
    const redacted = redactProjection(projection, findings, decisions).events[0]?.summary;
    // Preserve only the reviewed/redacted text and explicit user provenance.
    included.push({ noteId: note.noteId, text: redacted, provenance: note.provenance });
  }
  return included;
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
    hindsightNotes: any[];
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
        const html = buildHindsightDocument(pendingHindsight.sources, params, undefined, pendingHindsight.priorOutcomes, pendingHindsight.hindsightNotes);
        const paths = await writeHindsightReport(pendingHindsight.outputPath, html, { claims: params.claims, recommendations: params.recommendations });
        const outputPath = pendingHindsight.outputPath;
        // Keep the pending state until agent_settled restores the original tool set.
        return { content: [{ type: "text", text: `Hindsight document written to ${outputPath}. Model-suggestion disposition seed written locally to ${paths.dispositionPath}. Local feedback seed written to ${paths.feedbackPath}.` }] };
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
        const html = buildHindsightDocument(pendingHindsight.sources, pendingHindsight.modelOutput, params, pendingHindsight.priorOutcomes, pendingHindsight.hindsightNotes);
        const paths = await writeHindsightReport(pendingHindsight.outputPath, html, { claims: pendingHindsight.modelOutput.claims, recommendations: pendingHindsight.modelOutput.recommendations });
        const outputPath = pendingHindsight.outputPath;
        return { content: [{ type: "text", text: `Hindsight document with claim-support validation written to ${outputPath}. Model-suggestion disposition seed written locally to ${paths.dispositionPath}. Local feedback seed written to ${paths.feedbackPath}.` }] };
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

  pi.registerCommand("hindsight-notes", {
    description: "Add, view, edit, or delete local user-authored notes for the current Pi session",
    async handler(_args, ctx) {
      try {
        if (!ctx.hasUI || typeof ctx.ui.input !== "function") throw new HindsightNotesError("ui_required");
        if (!isTrustedProject(ctx)) throw new HindsightNotesError("untrusted_project");
        const sessionReference = await currentHindsightSessionReference(ctx);
        const path = hindsightNotesPath(ctx.cwd, sessionReference);
        const store = await readHindsightNotes(ctx.cwd, sessionReference);
        const notes = store?.notes || [];
        const action = await ctx.ui.select("Current-session hindsight notes", ["Add note", "View notes", "Edit note", "Delete note", "Cancel"]);
        if (!action || action === "Cancel") throw new HindsightNotesError("confirmation_required");
        if (action === "View notes") {
          if (notes.length === 0) { ctx.ui.notify("No local hindsight notes exist for this current session.", "info"); return; }
          // This picker deliberately lists only the active session's opaque-keyed store.
          await ctx.ui.select("Current-session hindsight notes (user-authored context)", ["Close", ...notes.map((note, index) => `${index + 1}. ${note.text.slice(0, 120)}${note.text.length > 120 ? "…" : ""}`)]);
          return;
        }
        if (action === "Add note") {
          const text = await ctx.ui.input("Add hindsight note", "User-authored context only. Do not paste session logs, session IDs, or credentials.");
          if (text === undefined) throw new HindsightNotesError("confirmation_required");
          const confirmed = await ctx.ui.confirm("Final confirmation: save local hindsight note", "This writes a user-authored, current-session note under an opaque local session reference. It does not modify session logs, make a network request, or make the note evidence. Save this note?");
          if (confirmed !== true) throw new HindsightNotesError("confirmation_required");
          await addHindsightNote(ctx.cwd, sessionReference, text);
          ctx.ui.notify(`Local user-authored hindsight note saved in ${path}.`, "info");
          return;
        }
        if (notes.length === 0) throw new HindsightNotesError("notes_missing");
        const options = ["Cancel", ...notes.map((note, index) => `${index + 1}. ${note.text.slice(0, 120)}${note.text.length > 120 ? "…" : ""}`)];
        const selectedLabel = await ctx.ui.select(`Select a current-session note to ${action === "Edit note" ? "edit" : "delete"}`, options);
        if (!selectedLabel || selectedLabel === "Cancel") throw new HindsightNotesError("confirmation_required");
        const note = notes[options.indexOf(selectedLabel) - 1];
        if (!note) throw new HindsightNotesError("note_missing");
        if (action === "Edit note") {
          const text = await ctx.ui.input("Edit hindsight note", "Replace the selected note with user-authored context only. Do not paste session logs, session IDs, or credentials.");
          if (text === undefined) throw new HindsightNotesError("confirmation_required");
          const confirmed = await ctx.ui.confirm("Final confirmation: edit local hindsight note", "This replaces this local user-authored context note. It does not modify session logs, make a network request, or make the note evidence. Save the edit?");
          if (confirmed !== true) throw new HindsightNotesError("confirmation_required");
          await editHindsightNote(ctx.cwd, sessionReference, note.noteId, text);
          ctx.ui.notify(`Local user-authored hindsight note updated in ${path}.`, "info");
          return;
        }
        const confirmed = await ctx.ui.confirm("Final confirmation: delete local hindsight note", "This permanently removes this local user-authored note. It will not be rendered, exported, or sent to hindsight synthesis. Delete it?");
        if (confirmed !== true) throw new HindsightNotesError("confirmation_required");
        await deleteHindsightNote(ctx.cwd, sessionReference, note.noteId);
        ctx.ui.notify(`Local user-authored hindsight note deleted from ${path}.`, "info");
      } catch (error) {
        ctx.ui.notify(hindsightNotesErrorMessage(error), "error");
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
        const noteSessionReference = hindsightNotesSessionReference(session.id);
        // Keep a local pseudonym so an excluded source can link to an explicit
        // redaction-review fallback without retaining conversation content.
        const sources: any[] = [];
        if (review.excluded) {
          sources.push({ reference, excluded: true });
        } else {
          const cited = attachEvidenceReferences(reference, redactProjection(projection, findings, review.decisions));
          sources.push({ reference, events: cited.events, edges: cited.edges });
        }
        // The store key is derived only from the selected Pi session ID. Only
        // that exact store is read, and excluded/deleted notes never enter this
        // reviewed bundle.
        // Never access a project-local note store from an untrusted project.
        let noteStore: any;
        if (isTrustedProject(ctx)) noteStore = await readHindsightNotes(ctx.cwd, noteSessionReference);
        const hindsightNotes = noteStore ? await reviewHindsightNotes(ctx, noteStore.notes, patterns) : [];
        const outputPath = resolveOutputPath(requested.outputPath, ctx.cwd, "pi-hindsight-document.html", "hindsight document");
        const restoreTools = restrictToolsForHindsightSynthesis(pi);
        try {
          pendingHindsight = { sources, outputPath, restoreTools, validateClaimSupport: requested.validateClaimSupport, priorOutcomes, hindsightNotes, phase: "draft" };
          // Prior outcomes remain in pending state for safe post-model rendering;
          // they are deliberately never placed in a model synthesis prompt.
          pi.sendUserMessage(buildSynthesisPrompt(sources, { validateClaimSupport: requested.validateClaimSupport, hindsightNotes }));
        } catch (error) {
          pendingHindsight = undefined;
          restoreTools();
          throw error;
        }
        ctx.ui.notify(`Redacted evidence submitted to the active model. It can only generate the hindsight document through the safe report contract at ${outputPath}.${requested.validateClaimSupport ? " Claim-support validation will run as a separate evidence-scoped model pass." : ""}${priorOutcomes ? " Deliberately supplied prior outcomes are labeled context, not evidence." : ""}${hindsightNotes.length ? " Reviewed user-authored notes are separate context, never evidence or citations." : ""}`, "info");
      } catch (error) { ctx.ui.notify(error instanceof HindsightOutcomeError ? hindsightOutcomeErrorMessage(error) : error instanceof HindsightNotesError ? hindsightNotesErrorMessage(error) : error instanceof Error ? error.message : "Unable to generate hindsight document.", "error"); }
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
        await recordHindsightOutcomeUpdate(outcomesPath, origin, update, { reportPath, outcomeReportPath });
        ctx.ui.notify(`Local outcome update recorded in ${outcomesPath}. Inspectable history refreshed in ${reportPath} and ${outcomeReportPath}.`, "info");
      } catch (error: any) {
        ctx.ui.notify(error?.message === "Hindsight outcome update canceled." ? "Hindsight outcome update canceled." : hindsightOutcomeErrorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("hindsight-feedback", {
    description: "Record local user feedback on one stable hindsight claim or recommendation",
    async handler(args, ctx) {
      try {
        if (!ctx.hasUI || typeof ctx.ui.input !== "function") throw new HindsightFeedbackError("ui_required");
        const input = args.trim();
        if (!input || input.includes("\0")) throw new HindsightFeedbackError("invalid_feedback_path");
        const dispositionPath = resolve(ctx.cwd, input);
        const feedbackPath = feedbackPathForDispositionPath(dispositionPath);
        const feedbackReportPath = feedbackReportPathForDispositionPath(dispositionPath);
        const reportPath = hindsightReportPathForDispositionPath(dispositionPath);
        const outcomePath = outcomeHistoryPathForDispositionPath(dispositionPath);
        const store = await readHindsightFeedback(feedbackPath);
        if (!store) throw new HindsightFeedbackError("feedback_missing");
        const options = ["Cancel", ...store.targets.map((target) => `${target.type === "claim" ? "Claim" : "Recommendation"} ${target.targetId.slice(target.type.length + 1)} · ${target.evidenceReferences.join(", ")}`)];
        const selectedLabel = await ctx.ui.select("Select one stable report claim or recommendation", options);
        if (!selectedLabel || selectedLabel === "Cancel") throw new HindsightFeedbackError("confirmation_required");
        const target = store.targets[options.indexOf(selectedLabel) - 1];
        if (!target) throw new HindsightFeedbackError("invalid_feedback_target");
        const classification = await ctx.ui.select("How was this report item for you?", ["helpful", "incorrect", "overstated", "incomplete", "not-actionable", "Cancel"]);
        if (!classification || classification === "Cancel") throw new HindsightFeedbackError("confirmation_required");
        const correctedFraming = await ctx.ui.input("Optional corrected framing", "Optional: describe a correction or what would make this actionable. Do not paste session logs or credentials; leave blank to skip.");
        if (correctedFraming === undefined) throw new HindsightFeedbackError("confirmation_required");
        const confirmed = await ctx.ui.confirm("Final confirmation: save local feedback", "This records user-provided local feedback against only this report identity and its pseudonymous citations. It makes no network request, does not read or modify session logs, and is never model evidence or prompt input. Save this feedback?");
        if (confirmed !== true) throw new HindsightFeedbackError("confirmation_required");
        await recordHindsightFeedback(feedbackPath, target.targetId, {
          classification,
          correctedFraming,
          provenance: { source: "user-feedback", confirmation: "user-confirmed", recordedAt: new Date().toISOString() },
        }, { reportPath, feedbackReportPath, dispositionPath, outcomePath });
        ctx.ui.notify(`Local feedback recorded in ${feedbackPath}. User-provided calibration signals refreshed in ${reportPath} and ${feedbackReportPath}.`, "info");
      } catch (error) {
        ctx.ui.notify(hindsightFeedbackErrorMessage(error), "error");
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
