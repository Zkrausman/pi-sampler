import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browserPickerLabel, formatLocalConversationReader, resolveSessionReference } from "./browser.mjs";
import { projectConversation } from "./conversation.mjs";
import { attachEvidenceReferences } from "./evidence.mjs";
import { restrictToolsForHindsightSynthesis } from "./hindsight-tools.mjs";
import { buildHindsightDocument, preflightSynthesisPrompt } from "./synthesis.mjs";
import { HindsightNotesError, addHindsightNote, deleteHindsightNote, editHindsightNote, hindsightNotesEventReference, hindsightNotesSessionReference, migrateLegacyHindsightNote, readHindsightNotes } from "./hindsight-notes.mjs";
import { compileSensitivePatterns, findSensitiveContent, pseudonymizeSession, redactProjection } from "./redaction.mjs";
import { defaultHindsightReportDirectory, resolveExplicitHindsightOutputPath, writeDefaultHindsightReport, writeHindsightReport } from "./hindsight-output.mjs";

function hindsightArguments(args: string) {
  const values = args.trim().split(/\s+/).filter(Boolean);
  if (values.some((value) => value.startsWith("--"))) throw new Error("Unsupported hindsight option. Usage: /hindsight-document [session-identifier] [output-path]");
  if (values.length > 2) throw new Error("Usage: /hindsight-document [session-identifier] [output-path]");
  if (values.length === 0) return {};
  const [first, second] = values;
  if (first.startsWith("session-")) {
    if (!/^session-[a-z0-9]+$/.test(first)) throw new Error("The selected conversation identifier is invalid.");
    return second ? { reference: first, outputPath: second } : { reference: first };
  }
  if (second) throw new Error("A session identifier must come before an output path.");
  return { outputPath: first };
}
async function configuredPatterns(cwd: string) {
  try {
    const parsed = JSON.parse(await readFile(resolve(cwd, ".pi", "conversation-redaction-patterns.json"), "utf8"));
    return compileSensitivePatterns(parsed?.patterns);
  } catch (error: any) {
    if (error?.code === "ENOENT") return compileSensitivePatterns();
    throw new Error("Unable to read .pi/conversation-redaction-patterns.json.");
  }
}
function hindsightNotesErrorMessage(error: unknown) {
  const code = error instanceof HindsightNotesError ? error.code : "operation_failed";
  const messages: Record<string, string> = { ui_required: "Hindsight notes require Pi's interactive UI.", untrusted_project: "Hindsight notes require a trusted project root.", current_session_unavailable: "Pi did not expose the active session identity; no note was read or changed.", unsafe_note_text: "Notes must not include raw session identifiers or credentials; nothing was saved.", invalid_note_id: "The selected local note identity is invalid; it was not changed.", note_missing: "That local note no longer exists; it was not changed.", notes_missing: "No local notes exist for this session.", events_missing: "No current-session events are available to annotate.", notes_limit_reached: "This session already has the maximum number of local notes.", confirmation_required: "Hindsight notes canceled." };
  return messages[code] || "Unable to update local hindsight notes.";
}
function isTrustedProject(ctx: any) { return typeof ctx?.isProjectTrusted === "function" && ctx.isProjectTrusted() === true; }
function currentHindsightSession(ctx: any) {
  const current = ctx?.session || ctx?.currentSession;
  const managedId = typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined;
  const actualSessionId = typeof managedId === "string" ? managedId : typeof current?.id === "string" ? current.id : typeof ctx?.sessionId === "string" ? ctx.sessionId : "";
  if (!actualSessionId) throw new HindsightNotesError("current_session_unavailable");
  return { actualSessionId, sessionReference: hindsightNotesSessionReference(actualSessionId) };
}
function noteReviewPatterns(patterns: any[], actualSessionId: string) { return [...patterns, { name: "active Pi session ID", regex: new RegExp(actualSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), requiredRedaction: true }]; }
function hindsightNoteEvents(entries: any[], actualSessionId: string) { return projectConversation(entries, { includeThinking: true }).events.map((event: any) => ({ eventReference: hindsightNotesEventReference(actualSessionId, event.noteIdentity), eventIdentity: event.noteIdentity, eventLabel: `${event.timestamp} — ${event.title}`.slice(0, 240) })); }
async function reviewHindsightNotes(ctx: any, notes: any[], patterns: any[]) {
  const included: any[] = [];
  for (const [index, note] of notes.entries()) {
    const projection = { events: [{ id: note.noteId, summary: note.text, metadata: [] }], edges: [] }; const findings = findSensitiveContent(projection, patterns); const decisions: Record<string, string> = {};
    if (!findings.length) { const choice = await ctx.ui.select(`Hindsight note ${index + 1}: no sensitive content detected`, ["Include as user-authored context", "Exclude this note", "Cancel"]); if (!choice || choice === "Cancel") throw new HindsightNotesError("confirmation_required"); if (choice === "Exclude this note") continue; }
    else { const begin = await ctx.ui.select(`Hindsight note ${index + 1}: sensitive content detected`, ["Review findings", "Exclude this note", "Cancel"]); if (!begin || begin === "Cancel") throw new HindsightNotesError("confirmation_required"); if (begin === "Exclude this note") continue; let excluded = false; for (const [findingIndex, finding] of findings.entries()) { const choice = await ctx.ui.select(`Note finding ${findingIndex + 1}/${findings.length}: ${finding.pattern} — ${finding.preview}`, finding.requiredRedaction ? ["Redact (required)", "Exclude this note", "Cancel"] : ["Redact (recommended)", "Retain", "Exclude this note", "Cancel"]); if (!choice || choice === "Cancel") throw new HindsightNotesError("confirmation_required"); if (choice === "Exclude this note") { excluded = true; break; } if (finding.requiredRedaction && choice !== "Redact (required)") throw new HindsightNotesError("required_redaction"); decisions[finding.id] = choice === "Retain" ? "retain" : "redact"; } if (excluded) continue; }
    included.push({ noteId: note.noteId, eventReference: note.eventReference, eventLabel: note.eventLabel, text: redactProjection(projection, findings, decisions).events[0]?.summary, provenance: note.provenance });
  }
  return included;
}

async function reviewRedactionChoices(ctx: any, findings: any[]) {
  if (!ctx.hasUI) throw new Error("Conversation export requires an interactive Pi UI so redaction choices can be reviewed.");
  if (findings.length === 0) {
    if (!await ctx.ui.confirm("No sensitive content detected", "Export this conversation without redactions?")) throw new Error("Conversation export canceled.");
    return { excluded: false, decisions: {} };
  }
  const begin = await ctx.ui.select("Conversation redaction preview", ["Review findings", "Exclude this conversation"]);
  if (!begin) throw new Error("Conversation export canceled.");
  if (begin === "Exclude this conversation") return { excluded: true, decisions: {} };
  const decisions: Record<string, string> = {};
  for (const [index, finding] of findings.entries()) {
    const choice = await ctx.ui.select(`Finding ${index + 1}/${findings.length}: ${finding.pattern} — ${finding.preview}`, finding.requiredRedaction ? ["Redact (required)", "Exclude this conversation"] : ["Redact (recommended)", "Retain", "Exclude this conversation"]);
    if (!choice) throw new Error("Conversation export canceled.");
    if (choice === "Exclude this conversation") return { excluded: true, decisions };
    if (finding.requiredRedaction && choice !== "Redact (required)") throw new Error("Required sensitive finding must be redacted or the conversation excluded.");
    decisions[finding.id] = choice === "Retain" ? "retain" : "redact";
  }
  return { excluded: false, decisions };
}

/** Read-only catalog and redaction-reviewed hindsight reports of saved Pi conversations. */
export default function conversationCatalog(pi: ExtensionAPI) {
  let pendingHindsight: { sources: any[]; hindsightNotes: any[]; outputPath?: string; defaultDirectory?: string; reference: string; restoreTools: () => void } | undefined;
  pi.on("agent_settled", () => { const pending = pendingHindsight; if (pending) { pendingHindsight = undefined; pending.restoreTools(); } });
  pi.registerTool({
    name: "hindsight_document_write", label: "Write safe hindsight document",
    description: "Writes structured claims, optional story steps, and Fix/Harden proposals through the safe cited HTML contract.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      claims: Type.Array(Type.Object({ statement: Type.String({ minLength: 1, maxLength: 2000 }), classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { maxItems: 80 }),
      storySteps: Type.Optional(Type.Array(Type.Object({ title: Type.String({ minLength: 1, maxLength: 160 }), body: Type.String({ minLength: 1, maxLength: 2000 }), classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }), { maxItems: 30 })),
      subagentEfficiency: Type.Optional(Type.Object({
        delegationTiming: Type.Array(Type.Object({ statement: Type.String({ minLength: 1, maxLength: 2000 }), findingKind: Type.Union([Type.Literal("strength"), Type.Literal("risk")]), classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { maxItems: 20 }),
        deliveryQuality: Type.Array(Type.Object({ statement: Type.String({ minLength: 1, maxLength: 2000 }), findingKind: Type.Union([Type.Literal("strength"), Type.Literal("risk")]), classification: Type.Union([Type.Literal("direct evidence"), Type.Literal("inference")]), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { maxItems: 20 }),
      }, { additionalProperties: false })),
      recommendations: Type.Array(Type.Object({ recommendation: Type.String({ minLength: 1, maxLength: 1000 }), actionType: Type.Union([Type.Literal("fix"), Type.Literal("harden")]), priority: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]), expectedImpact: Type.String({ minLength: 1, maxLength: 500 }), suggestedOwner: Type.String({ minLength: 1, maxLength: 200 }), dependencies: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }), acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 20 }), status: Type.Literal("proposed"), source: Type.Literal("model-suggestion"), evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { maxItems: 40 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      if (!pendingHindsight) return { content: [{ type: "text", text: "No hindsight document draft is awaiting generation." }] };
      try {
        const html = buildHindsightDocument(pendingHindsight.sources, params, pendingHindsight.hindsightNotes);
        const outputPath = pendingHindsight.outputPath
          ? (await writeHindsightReport(pendingHindsight.outputPath, html), pendingHindsight.outputPath)
          : await writeDefaultHindsightReport({ directory: pendingHindsight.defaultDirectory!, reference: pendingHindsight.reference, html });
        return { content: [{ type: "text", text: `Hindsight document written to ${outputPath}.` }] };
      }
      catch (error) { return { content: [{ type: "text", text: error instanceof Error ? `Unable to write hindsight document: ${error.message}` : "Unable to write hindsight document." }] }; }
    },
  });
  async function selectSession(ctx: any, sessions: any[], title: string) {
    const options = sessions.map(browserPickerLabel);
    const choice = await ctx.ui.select(title, ["Cancel", ...options]);
    if (!choice || choice === "Cancel") throw new Error("Conversation selection canceled.");
    const index = options.indexOf(choice);
    if (index < 0) throw new Error("Select exactly one saved conversation.");
    return sessions[index];
  }

  async function beginHindsight(args: string, ctx: any) {
    if (!ctx.hasUI) throw new Error("Hindsight generation requires Pi's interactive UI.");
    const requested = hindsightArguments(args); const sessions = await SessionManager.listAll();
    if (!sessions.length) throw new Error("No saved conversations are available for hindsight generation.");
    const session = requested.reference
      ? resolveSessionReference(sessions, requested.reference)
      : await selectSession(ctx, sessions, "Select one conversation for hindsight");
    const projection = projectConversation((await SessionManager.open(session.path)).getEntries());
    const findings = findSensitiveContent(projection, await configuredPatterns(ctx.cwd)); const review = await reviewRedactionChoices(ctx, findings); const reference = pseudonymizeSession(session);
    const sources = review.excluded ? [{ reference, excluded: true }] : [{ reference, ...attachEvidenceReferences(reference, redactProjection(projection, findings, review.decisions)) }];
    // Notes are scoped to the selected session's own project root, matching the standalone viewer.
    // An unavailable secure backend must not block a normal hindsight document with no notes.
    let noteStore;
    if (isTrustedProject(ctx) && typeof session.cwd === "string" && session.cwd) {
      try { noteStore = await readHindsightNotes(session.cwd, hindsightNotesSessionReference(session.id)); }
      catch (error) { if (!(error instanceof HindsightNotesError) || error.code !== "secure_storage_unavailable") throw error; }
    }
    const hindsightNotes = noteStore ? await reviewHindsightNotes(ctx, noteStore.notes, noteReviewPatterns(await configuredPatterns(ctx.cwd), session.id)) : [];
    const outputPath = requested.outputPath ? resolveExplicitHindsightOutputPath(requested.outputPath, ctx.cwd) : undefined;
    const defaultDirectory = outputPath ? undefined : defaultHindsightReportDirectory({ home: homedir() });
    const prompt = preflightSynthesisPrompt(sources, { hindsightNotes }, ctx.getContextUsage?.()); const restoreTools = restrictToolsForHindsightSynthesis(pi);
    try { pendingHindsight = { sources, hindsightNotes, outputPath, defaultDirectory, reference, restoreTools }; pi.sendUserMessage(prompt); } catch (error) { pendingHindsight = undefined; restoreTools(); throw error; }
    const destination = outputPath || defaultDirectory;
    ctx.ui.notify(`Redacted evidence submitted to the active model. It can only generate the hindsight document through the safe report contract at ${destination}.`, "info");
  }

  pi.registerCommand("conversation-catalog", { description: "Browse and read saved Pi conversations locally", async handler(_args, ctx) {
    try {
      if (!ctx.hasUI) throw new Error("Conversation browsing requires Pi's interactive UI.");
      const sessions = await SessionManager.listAll();
      if (!sessions.length) throw new Error("No saved conversations are available.");
      while (true) {
        const session = await selectSession(ctx, sessions, "Browse saved conversations");
        const reference = pseudonymizeSession(session);
        const entries = (await SessionManager.open(session.path)).getEntries();
        await ctx.ui.editor("Saved conversation (local-only; edits are discarded)", formatLocalConversationReader(session, entries));
        const action = await ctx.ui.select("Selected conversation", ["Prepare scoped hindsight command", "Back to saved conversations", "Close browser"]);
        if (action === "Prepare scoped hindsight command") {
          const command = `/hindsight-document ${reference}`;
          ctx.ui.setEditorText(command);
          ctx.ui.notify(`Ready: ${command}`, "info");
          return;
        }
        if (action === "Back to saved conversations") continue;
        return;
      }
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to browse saved conversations.", "error"); }
  }});
  pi.registerCommand("hindsight-notes", { description: "Add, view, edit, or delete local notes attached to current-session events", async handler(_args, ctx) {
    try {
      if (!ctx.hasUI || typeof ctx.ui.input !== "function") throw new HindsightNotesError("ui_required"); if (!isTrustedProject(ctx)) throw new HindsightNotesError("untrusted_project");
      const { actualSessionId, sessionReference } = currentHindsightSession(ctx); const entries = typeof ctx?.sessionManager?.getEntries === "function" ? ctx.sessionManager.getEntries() : (ctx?.session?.getEntries?.() || []); const events = hindsightNoteEvents(entries, actualSessionId); if (!events.length) throw new HindsightNotesError("events_missing");
      const store = await readHindsightNotes(ctx.cwd, sessionReference); const allNotes = store?.notes || []; const legacyNotes = store?.legacyNotes || [];
      const action = await ctx.ui.select("Event-attached hindsight notes", ["Add note", "View notes", "Edit note", "Delete note", ...(legacyNotes.length ? ["Attach legacy note"] : []), "Cancel"]); if (!action || action === "Cancel") throw new HindsightNotesError("confirmation_required");
      const selectEvent = async (title: string) => { const labels = events.map((event: any, index: number) => `${index + 1}. ${event.eventLabel}`); const choice = await ctx.ui.select(title, ["Cancel", ...labels]); const event = events[labels.indexOf(choice)]; if (!choice || choice === "Cancel" || !event) throw new HindsightNotesError("confirmation_required"); return event; };
      if (action === "Add note") { const event = await selectEvent("Select an event to annotate"); const text = await ctx.ui.input("Add event note", "User-authored context only. Do not paste session logs, session IDs, or credentials."); if (text === undefined || !await ctx.ui.confirm("Final confirmation: save local event note", "Save this local user-authored note?")) throw new HindsightNotesError("confirmation_required"); await addHindsightNote(ctx.cwd, sessionReference, event.eventReference, event.eventLabel, text, { actualSessionId, eventIdentity: event.eventIdentity }); ctx.ui.notify("Local event note saved.", "info"); return; }
      if (action === "Attach legacy note") { const options = ["Cancel", ...legacyNotes.map((note: any, index: number) => `${index + 1}. ${note.text.slice(0, 120)}`)]; const choice = await ctx.ui.select("Select an unassigned legacy note", options); const note = legacyNotes[options.indexOf(choice) - 1]; if (!choice || choice === "Cancel" || !note) throw new HindsightNotesError("confirmation_required"); const event = await selectEvent("Select the event for this legacy note"); if (!await ctx.ui.confirm("Attach legacy note", "Attach this note to the selected event?")) throw new HindsightNotesError("confirmation_required"); await migrateLegacyHindsightNote(ctx.cwd, sessionReference, note.noteId, event.eventReference, event.eventLabel, { actualSessionId, eventIdentity: event.eventIdentity }); ctx.ui.notify("Legacy note attached to the selected event.", "info"); return; }
      if (!allNotes.length) throw new HindsightNotesError("notes_missing"); const options = ["Cancel", ...allNotes.map((note: any, index: number) => `${index + 1}. ${note.eventLabel}: ${note.text.slice(0, 100)}`)]; const choice = await ctx.ui.select(`Select an event note to ${action === "Edit note" ? "edit" : action === "Delete note" ? "delete" : "view"}`, options); const note = allNotes[options.indexOf(choice) - 1]; if (!choice || choice === "Cancel" || !note) throw new HindsightNotesError("confirmation_required"); if (action === "View notes") { ctx.ui.notify(`${note.eventLabel}: ${note.text}`, "info"); return; } if (action === "Edit note") { const text = await ctx.ui.input("Edit event note", "Replace with user-authored context only."); if (text === undefined || !await ctx.ui.confirm("Final confirmation: edit local event note", "Save this edit?")) throw new HindsightNotesError("confirmation_required"); await editHindsightNote(ctx.cwd, sessionReference, note.noteId, text, { actualSessionId }); ctx.ui.notify("Local event note updated.", "info"); return; } if (!await ctx.ui.confirm("Final confirmation: delete local event note", "Permanently delete this local note?")) throw new HindsightNotesError("confirmation_required"); await deleteHindsightNote(ctx.cwd, sessionReference, note.noteId); ctx.ui.notify("Local event note deleted.", "info");
    } catch (error) { ctx.ui.notify(hindsightNotesErrorMessage(error), "error"); }
  }});
  pi.registerCommand("hindsight-document", { description: "Write a cited hindsight document for one selected conversation", async handler(args, ctx) {
    try { await beginHindsight(args, ctx); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Unable to generate hindsight document.", "error"); }
  }});
}

export { hindsightArguments };
