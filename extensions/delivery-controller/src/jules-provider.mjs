import { redactObject } from "./redact.mjs";

const JULES_API_BASE = "https://jules.googleapis.com/v1alpha";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireID(value, field) {
  if (typeof value !== "string" || !ID.test(value)) fail(`invalid_${field}`);
  return value;
}
function fail(code) { const e = new Error(code); e.code = code; throw e; }

function authHeader(env, ref) {
  if (typeof ref !== "string" || !/^\$[A-Z][A-Z0-9_]{0,127}$/.test(ref)) fail("invalid_provider_auth_reference");
  const name = ref.slice(1);
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") fail("provider_unavailable");
  return { header: value, name };
}

function redactForLog(obj) {
  const redacted = redactObject(obj);
  return JSON.stringify(redacted).slice(0, 2000);
}

export class JulesProvider {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, baseUrl = JULES_API_BASE, providerAuthEnvRef = "$JULES_API_KEY" } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
    this.providerAuthEnvRef = providerAuthEnvRef;
  }

  headers() {
    const { header, name } = authHeader(this.env, this.providerAuthEnvRef);
    return { "X-Goog-Api-Key": header, "Content-Type": "application/json", _authName: name };
  }

  // Live Jules v1alpha contract (see https://developers.google.com/jules/api
  // and SRC-2026-08-08-001..004):
  // POST /v1alpha/sessions { prompt, sourceContext: { source, githubRepoContext: { startingBranch } }, title?, automationMode?, requirePlanApproval? }
  // Response { name: "sessions/{id}", id, prompt, ... }
  // Base URL is https://jules.googleapis.com/v1alpha, source is "sources/github/{owner}/{repo}".
  // The adapter supplies a repository source and branch from its explicit project profile.
  async createSession({ promptRef, branch, baseRef, idempotencyKey, correlationId, prompt, source, startingBranch, title, automationMode, requirePlanApproval, sourceContext } = {}) {
    // idempotency/correlation are ledger concerns — not part of Jules API. Validate when present but don't require.
    if (idempotencyKey !== undefined) requireID(idempotencyKey, "idempotency_key");
    if (correlationId !== undefined) requireID(correlationId, "correlation_id");
    const h = this.headers();
    // A consuming project must supply its source explicitly or through its own runtime environment.
    const resolvedSource = sourceContext?.source ?? source ?? this.env.JULES_SOURCE;
    if (typeof resolvedSource !== "string" || !resolvedSource.startsWith("sources/")) fail("invalid_source");
    let resolvedBranch = startingBranch ?? sourceContext?.githubRepoContext?.startingBranch ?? branch ?? baseRef ?? "master";
    if (typeof resolvedBranch !== "string" || resolvedBranch.trim() === "") resolvedBranch = "master";
    // Resolve prompt: explicit prompt > legacy promptRef > error
    let resolvedPrompt = prompt ?? promptRef;
    if (typeof resolvedPrompt !== "string" || resolvedPrompt.trim() === "") fail("invalid_prompt");
    resolvedPrompt = String(resolvedPrompt).slice(0, 8000);
    const bodyObj = {
      prompt: resolvedPrompt,
      sourceContext: { source: resolvedSource, githubRepoContext: { startingBranch: resolvedBranch } },
    };
    if (typeof title === "string" && title.trim() !== "") bodyObj.title = String(title).slice(0, 200);
    if (typeof automationMode === "string" && automationMode) bodyObj.automationMode = automationMode;
    if (typeof requirePlanApproval === "boolean") bodyObj.requirePlanApproval = requirePlanApproval;
    const body = JSON.stringify(bodyObj);
    const res = await this.fetch(`${this.baseUrl}/sessions`, { method: "POST", headers: { "X-Goog-Api-Key": h["X-Goog-Api-Key"], "Content-Type": "application/json" }, body });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`provider_create_failed:${res.status}:${redactForLog({ text: text.slice(0, 800) })}`), { code: "provider_create_failed", status: res.status });
    }
    const json = await res.json().catch(() => ({}));
    // Live shape: { name: "sessions/{id}", id, ... } — accept either, normalize to full name
    const providerRunId = json.name ?? (json.id ? `sessions/${json.id}` : null) ?? json.providerRunId ?? json.sessionId;
    if (!providerRunId || typeof providerRunId !== "string") fail("invalid_provider_run_id");
    // name is "sessions/<digits>" — allow "/" in addition to JOB_ID_PATTERN
    if (!/^sessions\/[A-Za-z0-9._-]+$/.test(providerRunId) && !ID.test(providerRunId)) fail("invalid_provider_run_id");
    return { providerRunId };
  }

  static normalizeSessionName(id) {
    if (typeof id !== "string" || id.trim() === "") fail("invalid_provider_run_id");
    if (id.startsWith("sessions/")) return id;
    requireID(id, "provider_run_id");
    return `sessions/${id}`;
  }

  async getSession(providerRunId) {
    const name = JulesProvider.normalizeSessionName(providerRunId);
    const h = this.headers();
    const res = await this.fetch(`${this.baseUrl}/${name}`, { headers: { "X-Goog-Api-Key": h["X-Goog-Api-Key"] } });
    if (!res.ok) throw Object.assign(new Error(`provider_get_failed:${res.status}`), { code: "provider_get_failed", status: res.status });
    return res.json();
  }

  async listActivities(providerRunId) {
    const name = JulesProvider.normalizeSessionName(providerRunId);
    const h = this.headers();
    const res = await this.fetch(`${this.baseUrl}/${name}/activities`, { headers: { "X-Goog-Api-Key": h["X-Goog-Api-Key"] } });
    if (!res.ok) return [];
    const json = await res.json().catch(() => ({}));
    return Array.isArray(json.activities) ? json.activities : Array.isArray(json) ? json : [];
  }

  // Jules v1alpha has no cancel endpoint (only create/get/list/approvePlan/sendMessage + activities).
  // Keep the method for adapter compatibility — report not-supported so adapter escalates rather than guessing.
  async cancelSession(providerRunId, reason) {
    if (typeof providerRunId !== "string" || providerRunId.trim() === "") fail("invalid_provider_run_id");
    // No-op: provider does not support cancel. Caller (adapter) treats this as cancellation-uncertain -> human-escalated.
    return { accepted: false, reason: "cancel_not_supported", requestedReason: String(reason).slice(0, 200) };
  }

  // Live contract is POST /v1alpha/{session=sessions/*}:sendMessage { prompt }
  async sendFeedback(providerRunId, redactedText) {
    if (typeof providerRunId !== "string" || providerRunId.trim() === "") fail("invalid_provider_run_id");
    if (typeof redactedText !== "string" || redactedText.length === 0) fail("invalid_feedback");
    const h = this.headers();
    // providerRunId is already "sessions/{id}" — encode preserving slash for path param per gRPC transcoding
    const session = /^sessions\//.test(providerRunId) ? providerRunId : `sessions/${providerRunId}`;
    const res = await this.fetch(`${this.baseUrl}/${session}:sendMessage`, {
      method: "POST",
      headers: { "X-Goog-Api-Key": h["X-Goog-Api-Key"], "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: redactedText }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`provider_feedback_failed:${res.status}:${redactForLog({ text: text.slice(0, 500) })}`), { code: "provider_feedback_failed", status: res.status });
    }
    return { ok: true };
  }
}

export function createRecordingProvider() {
  const calls = [];
  const provider = {
    async createSession(args) { calls.push({ method: "createSession", args: redactObject(args) }); return { providerRunId: "provider-rec-001" }; },
    async getSession(id) { calls.push({ method: "getSession", id }); return { state: "completed" }; },
    async listActivities(id) { calls.push({ method: "listActivities", id }); return []; },
    async cancelSession(id, reason) { calls.push({ method: "cancelSession", id, reason: String(reason).slice(0, 40) }); return { accepted: true }; },
    async sendFeedback(id, text) { calls.push({ method: "sendFeedback", id, text: String(text).slice(0, 80) }); return { ok: true }; },
    _calls: calls,
  };
  return provider;
}
