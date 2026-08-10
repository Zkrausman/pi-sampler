import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JobLedger, LedgerError } from "./ledger.mjs";
import { digestRedacted, evidenceEntry, redactObject, redactText, sha256Hex } from "./redact.mjs";
import { IMPLEMENTATION_PROMPT_PACK, renderPromptPack, validatePromptPack } from "./jules-prompt-pack.mjs";

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORK_ITEM_ID = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const BASE_REF = /^[A-Za-z0-9\/._-]+$/;
const SHA = /^[a-f0-9]{64}$/;
const ENV_REF = /^\$[A-Z][A-Z0-9_]{0,127}$/;

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function requireID(value, field) {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value)) fail(`invalid_${field}`);
  return value;
}

function providerSessionInput({ ticket, prompt, promptRef, idempotencyKey, correlationId }) {
  return {
    prompt,
    source: redactText(ticket.source),
    startingBranch: redactText(ticket.baseRef),
    title: `[${ticket.id}] ${redactText(ticket.title ?? ticket.id).slice(0, 120)}`,
    promptRef,
    branch: redactText(ticket.branch),
    baseRef: redactText(ticket.baseRef),
    idempotencyKey,
    correlationId,
  };
}

export function buildPrompt(ticket, { promptPack = IMPLEMENTATION_PROMPT_PACK } = {}) {
  if (!ticket || typeof ticket !== "object") fail("invalid_ticket");
  if (typeof ticket.id !== "string" || !WORK_ITEM_ID.test(ticket.id)) fail("invalid_work_item_id");
  if (typeof ticket.branch !== "string" || ticket.branch.trim() === "") fail("invalid_branch");
  if (typeof ticket.baseRef !== "string" || !BASE_REF.test(ticket.baseRef) || ticket.baseRef.includes("..")) fail("invalid_base_ref");
  if (typeof ticket.source !== "string" || !ticket.source.startsWith("sources/")) fail("invalid_source");
  if (typeof ticket.verificationContract !== "string" || ticket.verificationContract.trim() === "") fail("invalid_verification_contract");
  if (!Array.isArray(ticket.instructions) || ticket.instructions.length === 0) fail("invalid_project_instructions");
  try { validatePromptPack(promptPack); } catch { fail("invalid_prompt_pack"); }
  const title = typeof ticket.title === "string" && ticket.title.trim() !== "" ? ticket.title.trim() : ticket.id;
  const description = typeof ticket.description === "string" ? ticket.description.trim() : "";
  const context = typeof ticket.context === "string" ? ticket.context.trim() : "";
  const parts = [`[${ticket.id}] ${title}`, `Branch: ${ticket.branch} (base: ${ticket.baseRef})`];
  if (description) parts.push(`\n## Work Item\n${description}`);
  parts.push(`\n## Verification Contract\n${ticket.verificationContract}`);
  if (context) parts.push(`\n## Additional Context\n${context}`);
  let renderedPack;
  try { renderedPack = renderPromptPack(promptPack, { workItemId: ticket.id, branch: ticket.branch, baseRef: ticket.baseRef, instructions: ticket.instructions }); } catch { fail("invalid_prompt_pack"); }
  parts.push(renderedPack);
  const prompt = redactText(parts.join("\n"));
  const snapshot = {
    id: ticket.id,
    source: ticket.source,
    branch: ticket.branch,
    baseRef: ticket.baseRef,
    verificationContract: ticket.verificationContract,
    title: title.slice(0, 200),
    promptVersion: promptPack.version,
  };
  const digest = createHash("sha256").update(prompt).digest("hex");
  const promptRef = `prompt:${ticket.id}:${digest.slice(0, 12)}`;
  return { prompt, promptRef, digest, promptVersion: promptPack.version, snapshot };
}

export function buildPromptRef(ticket, options) {
  return buildPrompt(ticket, options);
}

export function validateFeedback(input) {
  if (!input || typeof input !== "object") fail("invalid_feedback");
  const text = typeof input.text === "string" ? input.text : "";
  if (text.length === 0 || text.length > 4000) fail("invalid_feedback_length");
  // Deterministic allowlist: reject embedded instructions, code fences that could hide payloads, and governance/merge/credential terms.
  const lower = text.toLowerCase();
  const forbidden = ["linear", "merge", "governance", "token", "secret", "credential", "api_key", "apikey", "select ticket", "choose ticket", "mark done", "done status"];
  for (const term of forbidden) if (lower.includes(term)) fail("feedback_contains_forbidden_term");
  if (/```/.test(text)) fail("feedback_contains_code_fence");
  const redacted = redactObject({ text }).text;
  const digest = createHash("sha256").update(redacted).digest("hex");
  return { redacted, digest };
}

export function validateProviderAuth(env, ref) {
  if (typeof ref !== "string" || !ENV_REF.test(ref)) fail("invalid_provider_auth_reference");
  const name = ref.slice(1);
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") fail("provider_unavailable");
  // Never return or log the raw value.
  return name;
}

export const Budgets = Object.freeze({ maxAttempts: 2, maxCancels: 1, maxFeedback: 1 });

async function countState(root, jobId, state) {
  const path = join(root, "jobs.ndjson");
  try {
    const text = await readFile(path, "utf8");
    if (text.trim() === "") return 0;
    const events = text.trim().split("\n").map((l) => JSON.parse(l));
    return events.filter((e) => e.job_id === jobId && e.state === state).length;
  } catch (e) {
    if (e?.code === "ENOENT") return 0;
    throw e;
  }
}

async function hasEventId(root, eventId) {
  const path = join(root, "jobs.ndjson");
  try {
    const text = await readFile(path, "utf8");
    if (text.trim() === "") return false;
    return text.trim().split("\n").some((l) => {
      try { return JSON.parse(l).event_id === eventId; } catch { return false; }
    });
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

export class JulesAdapter {
  constructor({ ledger, provider, env = process.env, now = () => new Date(), promptPack = IMPLEMENTATION_PROMPT_PACK } = {}) {
    if (!ledger || !(ledger instanceof JobLedger)) fail("invalid_ledger");
    if (!provider || typeof provider !== "object") fail("invalid_provider");
    this.ledger = ledger;
    this.provider = provider;
    this.env = env;
    this.now = now;
    this.promptPack = promptPack;
    this.budgets = { ...Budgets };
    // Derive root from ledger path: ledger.path is join(root,"jobs.ndjson")
    this.root = ledger.path.replace(/[/\\]jobs\.ndjson$/, "");
  }

  async dispatch({ ticket, idempotencyKey, correlationId, approvalEnvRef, providerAuthEnvRef }) {
    if (!ticket || typeof ticket !== "object") fail("invalid_ticket");
    requireID(ticket.id, "ticket_id");
    requireID(idempotencyKey, "idempotency_key");
    requireID(correlationId, "correlation_id");
    if (typeof approvalEnvRef !== "string" || !ENV_REF.test(approvalEnvRef)) fail("invalid_approval_reference");
    if (this.env[approvalEnvRef.slice(1)] !== "approved") fail("dispatch_not_authorized");
    validateProviderAuth(this.env, providerAuthEnvRef);
    const { prompt, promptRef, digest, promptVersion } = buildPrompt(ticket, { promptPack: this.promptPack });

    // One active job per ticket: if snapshot has non-terminal state for this ticket, reject.
    const snapshot = await this.ledger.snapshot();
    const existing = snapshot.get(ticket.id);
    if (existing && !["merged", "failed", "human-escalated"].includes(existing.state)) {
      // If the existing job already has this idempotencyKey as event_id, treat as idempotent (do not double-call provider).
      if (await hasEventId(this.root, idempotencyKey)) {
        return { idempotent: true, state: existing.state, providerRunId: null };
      }
      fail("ticket_already_active");
    }

    // Budget: count dispatched attempts for this ticket.
    const attempts = await countState(this.root, ticket.id, "dispatched");
    if (attempts >= this.budgets.maxAttempts) {
      const ev = [evidenceEntry(ticket.id, digest), evidenceEntry(correlationId, sha256Hex(correlationId))];
      try {
        await this.ledger.append({
          event_id: `budget-${idempotencyKey}`,
          job_id: ticket.id,
          at: this.now().toISOString(),
          state: "human-escalated",
          outcome: "budget_exhausted",
          evidence: ev,
          error_category: "budget_exhausted",
        });
      } catch (e) {
        if (!(e instanceof LedgerError) || e.code !== "invalid_transition") throw e;
      }
      fail("budget_exhausted");
    }

    // Ensure requested exists if job is new.
    if (!existing) {
      const reqId = `req-${ticket.id}-${correlationId.slice(0, 8)}`;
      if (!(await hasEventId(this.root, reqId))) {
        await this.ledger.append({
          event_id: reqId,
          job_id: ticket.id,
          at: this.now().toISOString(),
          state: "requested",
          outcome: "authorized",
          evidence: [evidenceEntry(ticket.id, digest)],
        });
      }
    }

    // Idempotent persist-before-call: try to append dispatched intent with idempotencyKey as event_id.
    const dispatchedEvidence = [
      evidenceEntry(ticket.id, digest),
      evidenceEntry(correlationId, sha256Hex(correlationId)),
      evidenceEntry(`prompt-${ticket.id}`, digest),
      evidenceEntry(`prompt-version-${promptVersion}`, sha256Hex(promptVersion)),
    ];
    const intent = {
      event_id: idempotencyKey,
      job_id: ticket.id,
      at: this.now().toISOString(),
      state: "dispatched",
      outcome: "accepted",
      evidence: dispatchedEvidence,
    };

    let appended;
    try {
      appended = await this.ledger.append(intent);
    } catch (e) {
      if (e instanceof LedgerError && e.code === "ledger_locked") throw e;
      throw e;
    }
    if (!appended.appended) {
      // Duplicate dispatch: do not call provider again.
      return { idempotent: true, state: appended.state.state, providerRunId: null };
    }

    // Now call provider with the full human-readable prompt (Linear description + verification contract + OKF + spike).
    // prompt is redacted before persist; ledger stores digest only, never raw prompt.
    let providerRunId;
    try {
      const result = await this.provider.createSession(providerSessionInput({ ticket, prompt, promptRef, idempotencyKey, correlationId }));
      providerRunId = result?.providerRunId ?? result?.provider_run_id ?? `provider-${correlationId.slice(0, 8)}`;
      if (!/^sessions\/[A-Za-z0-9._-]+$/.test(providerRunId)) requireID(providerRunId, "provider_run_id");
    } catch (e) {
      // Provider failure → escalate (do not guess). Keep dispatched but add human-escalated with digested error.
      const errDigest = sha256Hex(redactObject({ message: e?.message ?? String(e), code: e?.code ?? "provider_error" }));
      await this.ledger.append({
        event_id: `provider-fail-${idempotencyKey}`,
        job_id: ticket.id,
        at: this.now().toISOString(),
        state: "human-escalated",
        outcome: "provider_unavailable",
        evidence: [evidenceEntry(ticket.id, digest), evidenceEntry(correlationId, sha256Hex(correlationId)), evidenceEntry(`err-${idempotencyKey}`, errDigest)],
        error_category: "provider_unavailable",
      });
      fail("provider_error");
    }

    // Success: providerRunId is returned; evidence already persisted via dispatched intent includes correlation digests.
    // For audit, we return providerRunId but never persist raw token/prompt.
    return { idempotent: false, state: "dispatched", providerRunId, promptRef };
  }

  async poll({ ticketId, providerRunId }) {
    requireID(ticketId, "ticket_id");
    if (!/^sessions\//.test(providerRunId)) requireID(providerRunId, "provider_run_id");
    const snapshot = await this.ledger.snapshot();
    const current = snapshot.get(ticketId);
    if (!current) fail("job_not_found");
    if (["merged", "failed", "human-escalated"].includes(current.state)) {
      return { state: current.state, terminal: true };
    }

    let session;
    let activities = [];
    try {
      session = await this.provider.getSession(providerRunId);
      if (typeof this.provider.listActivities === "function") {
        activities = await this.provider.listActivities(providerRunId);
      }
    } catch (e) {
      const errDigest = sha256Hex(redactObject({ message: e?.message ?? String(e) }));
      await this.ledger.append({
        event_id: `poll-fail-${ticketId}-${Date.now()}`,
        job_id: ticketId,
        at: this.now().toISOString(),
        state: "human-escalated",
        outcome: "poll_error",
        evidence: [evidenceEntry(ticketId, errDigest)],
        error_category: "poll_error",
      });
      fail("poll_error");
    }

    // Ingest PR/commit evidence digests only (never raw URLs).
    const evidence = [];
    const redactedSession = redactObject(session);
    const sessionDigest = sha256Hex(JSON.stringify(redactedSession));
    evidence.push(evidenceEntry(ticketId, sessionDigest));

    let prDigest = null;
    for (const act of activities) {
      const redacted = redactObject(act);
      const d = sha256Hex(JSON.stringify(redacted));
      // Collect PR/commit digests if activity contains them, but store only digests.
      if (act?.data?.pullRequestUrl || act?.pullRequestUrl || act?.prUrl) {
        const url = act.data?.pullRequestUrl ?? act.pullRequestUrl ?? act.prUrl;
        prDigest = sha256Hex(String(url));
        evidence.push(evidenceEntry(`pr-${ticketId}`, prDigest));
      }
      if (act?.data?.commitSha || act?.commitSha) {
        const sha = String(act.data?.commitSha ?? act.commitSha);
        if (/^[a-f0-9]{40}$/.test(sha)) evidence.push(evidenceEntry(`commit-${ticketId}`, sha256Hex(sha)));
      }
    }

    // Map provider state to ledger state.
    const providerState = String(session?.state ?? session?.status ?? "unknown").toLowerCase();
    let nextState = null;
    if (providerState.includes("complete") || prDigest) {
      if (current.state === "dispatched") nextState = "implementation-ready";
      else if (current.state === "implementation-ready") nextState = "implementation-ready";
    } else if (providerState.includes("fail")) {
      nextState = "failed";
    } else if (providerState.includes("human") || providerState.includes("escalat")) {
      nextState = "human-escalated";
    }

    // Stale event guard: if ledger already beyond target, do not regress.
    if (nextState && current.state !== nextState) {
      // Validate transition allowed; if not, escalate.
      const { transitionAllowed } = await import("./ledger.mjs");
      if (!transitionAllowed(current.state, nextState)) {
        await this.ledger.append({
          event_id: `stale-${ticketId}-${Date.now()}`,
          job_id: ticketId,
          at: this.now().toISOString(),
          state: "human-escalated",
          outcome: "stale_event",
          evidence,
          error_category: "stale_event",
        });
        return { state: "human-escalated", terminal: true };
      }
      const outcome = nextState === "failed" ? "provider_failed" : nextState === "human-escalated" ? "provider_escalated" : "observed";
      const ev = {
        event_id: `poll-${ticketId}-${randomUUID().slice(0, 8)}`,
        job_id: ticketId,
        at: this.now().toISOString(),
        state: nextState,
        outcome,
        evidence,
      };
      if (nextState === "human-escalated") ev.error_category = "provider_escalated";
      if (nextState === "failed") ev.error_category = "provider_failed";
      await this.ledger.append(ev);
      return { state: nextState, terminal: ["failed", "human-escalated", "merged"].includes(nextState), providerState, prDigest };
    }

    return { state: current.state, terminal: false, providerState, prDigest, evidenceDigests: evidence.map((e) => e.sha256) };
  }

  async cancel({ ticketId, providerRunId, reason, approvalEnvRef }) {
    requireID(ticketId, "ticket_id");
    if (!/^sessions\//.test(providerRunId)) requireID(providerRunId, "provider_run_id");
    if (typeof approvalEnvRef !== "string" || !ENV_REF.test(approvalEnvRef)) fail("invalid_approval_reference");
    if (this.env[approvalEnvRef.slice(1)] !== "approved") fail("cancel_not_authorized");
    const cancels = await countState(this.root, ticketId, "human-escalated");
    // Also count prior cancel attempts via specific outcome.
    const path = join(this.root, "jobs.ndjson");
    let cancelCount = 0;
    try {
      const text = await readFile(path, "utf8");
      if (text.trim() !== "") cancelCount = text.trim().split("\n").filter((l) => {
        try { const e = JSON.parse(l); return e.job_id === ticketId && e.outcome === "cancel_requested"; } catch { return false; }
      }).length;
    } catch {}
    if (cancelCount >= this.budgets.maxCancels) fail("cancel_budget_exhausted");

    const cancelDigest = sha256Hex(redactObject({ reason }).reason ?? String(reason));

    let canceled = false;
    let cancelError = null;
    try {
      const res = await this.provider.cancelSession(providerRunId, String(reason));
      canceled = Boolean(res?.accepted ?? res?.ok ?? true);
    } catch (e) {
      cancelError = e;
      canceled = false;
    }

    // Verify terminal state via poll.
    let terminalVerified = false;
    try {
      const s = await this.provider.getSession(providerRunId);
      const st = String(s?.state ?? s?.status ?? "").toLowerCase();
      terminalVerified = st.includes("cancel") || st.includes("terminal") || st.includes("failed") || st.includes("human");
    } catch {
      terminalVerified = false;
    }

    if (canceled && terminalVerified) {
      await this.ledger.append({
        event_id: `cancel-ok-${ticketId}-${randomUUID().slice(0, 8)}`,
        job_id: ticketId,
        at: this.now().toISOString(),
        state: "failed",
        outcome: "canceled",
        evidence: [evidenceEntry(ticketId, cancelDigest)],
        error_category: "canceled",
      });
      return { canceled: true, terminal: true };
    }

    // Uncertainty → human-escalated, do not guess.
    const errDigest = sha256Hex(redactObject({ reason, error: cancelError?.message ?? "unknown" }));
    await this.ledger.append({
      event_id: `cancel-uncertain-${ticketId}-${randomUUID().slice(0, 8)}`,
      job_id: ticketId,
      at: this.now().toISOString(),
      state: "human-escalated",
      outcome: "cancellation-uncertain",
      evidence: [evidenceEntry(ticketId, cancelDigest), evidenceEntry(`cancel-err-${ticketId}`, errDigest)],
      error_category: "cancellation_uncertain",
    });
    return { canceled: false, terminal: false, escalated: true };
  }

  async feedback({ ticketId, providerRunId, feedbackText, approvalEnvRef, idempotencyKey, correlationId, ticket }) {
    requireID(ticketId, "ticket_id");
    if (!/^sessions\//.test(providerRunId)) requireID(providerRunId, "provider_run_id");
    requireID(idempotencyKey, "idempotency_key");
    requireID(correlationId, "correlation_id");
    if (typeof approvalEnvRef !== "string" || !ENV_REF.test(approvalEnvRef)) fail("invalid_approval_reference");
    if (this.env[approvalEnvRef.slice(1)] !== "approved") fail("feedback_not_authorized");
    const { redacted, digest } = validateFeedback({ text: feedbackText });

    const snapshot = await this.ledger.snapshot();
    const current = snapshot.get(ticketId);
    if (!current) fail("job_not_found");
    // Feedback only allowed from review-requested or changes-requested.
    if (!["review-requested", "changes-requested"].includes(current.state)) fail("feedback_not_allowed_in_state");

    // Budget: one bounded re-dispatch.
    const feedbackCount = await countState(this.root, ticketId, "changes-requested");
    // Also count dispatched after first attempt: total dispatched -1
    const dispatchedCount = await countState(this.root, ticketId, "dispatched");
    if (dispatchedCount >= this.budgets.maxAttempts) fail("feedback_budget_exhausted");
    if (feedbackCount >= this.budgets.maxFeedback) fail("feedback_budget_exhausted");

    // Transition to changes-requested if currently review-requested.
    if (current.state === "review-requested") {
      await this.ledger.append({
        event_id: `feedback-req-${ticketId}-${randomUUID().slice(0, 8)}`,
        job_id: ticketId,
        at: this.now().toISOString(),
        state: "changes-requested",
        outcome: "review_rejected",
        evidence: [evidenceEntry(ticketId, digest), evidenceEntry(correlationId, sha256Hex(correlationId))],
        error_category: "review_rejected",
      });
    }

    // Idempotent re-dispatch with same pattern as dispatch: append before provider call.
    const evidence = [evidenceEntry(ticketId, digest), evidenceEntry(correlationId, sha256Hex(correlationId)), evidenceEntry(`feedback-${ticketId}`, digest)];
    const intent = {
      event_id: idempotencyKey,
      job_id: ticketId,
      at: this.now().toISOString(),
      state: "dispatched",
      outcome: "retry",
      evidence,
    };
    if (await hasEventId(this.root, idempotencyKey)) {
      return { idempotent: true, state: "dispatched" };
    }
    const appended = await this.ledger.append(intent);
    if (!appended.appended) return { idempotent: true, state: appended.state.state };

    // Send redacted feedback to provider (digest only persisted, raw redacted sent to provider but not logged raw).
    try {
      await this.provider.sendFeedback(providerRunId, redacted);
    } catch (e) {
      const errDigest = sha256Hex(redactObject({ message: e?.message ?? String(e) }));
      await this.ledger.append({
        event_id: `feedback-fail-${ticketId}-${randomUUID().slice(0, 8)}`,
        job_id: ticketId,
        at: this.now().toISOString(),
        state: "human-escalated",
        outcome: "feedback_failed",
        evidence: [evidenceEntry(ticketId, digest), evidenceEntry(`fb-err-${ticketId}`, errDigest)],
        error_category: "feedback_failed",
      });
      fail("feedback_provider_error");
    }

    // Also trigger provider retry via createSession if ticket provided (bounded re-dispatch creates new provider run).
    if (ticket) {
      const { prompt, promptRef: retryPromptRef } = buildPrompt(ticket, { promptPack: this.promptPack });
      try {
        await this.provider.createSession(providerSessionInput({ ticket, prompt, promptRef: retryPromptRef, idempotencyKey, correlationId }));
      } catch (e) {
        const errDigest = sha256Hex(redactObject({ message: e?.message ?? String(e) }));
        await this.ledger.append({
          event_id: `retry-provider-fail-${ticketId}-${randomUUID().slice(0, 8)}`,
          job_id: ticketId,
          at: this.now().toISOString(),
          state: "human-escalated",
          outcome: "provider_unavailable",
          evidence: [evidenceEntry(ticketId, digest), evidenceEntry(`retry-err-${ticketId}`, errDigest)],
          error_category: "provider_unavailable",
        });
        fail("provider_error");
      }
    }

    return { idempotent: false, state: "dispatched", digest };
  }
}
