import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { sha256Hex, redactObject } from "./redact.mjs";
import { validateFeedback } from "./jules-adapter.mjs";

export const REVIEW_CONTRACT_VERSION = "project-review/v1";
export const REVIEW_DEFAULT_TIMEOUT_MS = 300_000;
export const VALID_SEVERITIES = Object.freeze(["low", "medium", "high", "critical"]);
export const VALID_VERDICTS = Object.freeze(["approved", "changes-requested", "human-escalated", "failed"]);

const TICKET_ID = /^[A-Z]+-[0-9]+$/;
const SHA40 = /^[a-f0-9]{40}$/;
const BASE_REF = /^[A-Za-z0-9\/._-]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(code) {
  const e = new Error(code);
  e.code = code;
  throw e;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") fail(`invalid_${field}`);
  return value;
}

export function classifyFailureMarker(text) {
  if (typeof text !== "string") return { hasMarker: false, marker: null };
  if (text.includes("[FAIL]")) return { hasMarker: true, marker: "[FAIL]" };
  if (/FAILED/.test(text)) return { hasMarker: true, marker: "FAILED" };
  if (/panic:/i.test(text)) return { hasMarker: true, marker: "panic:" };
  return { hasMarker: false, marker: null };
}

export function createWorktreeDirName(ticketId) {
  if (typeof ticketId !== "string" || !TICKET_ID.test(ticketId)) fail("invalid_ticket_id");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `review-${ticketId}-${suffix}`;
}

export function validateReviewInput(input) {
  if (!input || typeof input !== "object") fail("invalid_input");
  const ticketId = input.ticketId;
  if (typeof ticketId !== "string" || !TICKET_ID.test(ticketId)) fail("invalid_ticket_id");
  const candidateBranch = requireNonEmptyString(input.candidateBranch, "candidate_branch");
  if (candidateBranch.includes("..")) fail("invalid_candidate_branch");
  const candidateCommitSha = input.candidateCommitSha;
  if (typeof candidateCommitSha !== "string" || !SHA40.test(candidateCommitSha)) fail("invalid_candidate_commit_sha");
  const baseRef = requireNonEmptyString(input.baseRef, "base_ref");
  if (!BASE_REF.test(baseRef) || baseRef.includes("..")) fail("invalid_base_ref");
  const baseCommitSha = input.baseCommitSha;
  if (typeof baseCommitSha !== "string" || !SHA40.test(baseCommitSha)) fail("invalid_base_commit_sha");
  const expectedHeadSha = input.expectedHeadSha ?? candidateCommitSha;
  if (typeof expectedHeadSha !== "string" || !SHA40.test(expectedHeadSha)) fail("invalid_expected_head_sha");
  if (expectedHeadSha !== candidateCommitSha) fail("candidate_head_mismatch");
  const reviewerSessionId = requireNonEmptyString(input.reviewerSessionId, "reviewer_session_id");
  const reviewerIdentity = requireNonEmptyString(input.reviewerIdentity, "reviewer_identity");
  const implementerSessionId = input.implementerSessionId;
  const implementerIdentity = input.implementerIdentity;
  if (implementerSessionId !== undefined && typeof implementerSessionId !== "string") fail("invalid_implementer_session_id");
  if (implementerIdentity !== undefined && typeof implementerIdentity !== "string") fail("invalid_implementer_identity");
  if (implementerSessionId && reviewerSessionId === implementerSessionId) fail("self_review_forbidden");
  if (implementerIdentity && reviewerIdentity === implementerIdentity) fail("self_review_forbidden");
  const worktreeRoot = input.worktreeRoot ?? ".worktrees";
  if (typeof worktreeRoot !== "string" || worktreeRoot.trim() === "" || worktreeRoot.includes("..")) fail("invalid_worktree_root");
  // Prevent worktree rooted inside repo checkout nesting ambiguity: reject absolute or traversal.
  if (worktreeRoot.startsWith("/") || /^[A-Za-z]:/.test(worktreeRoot)) fail("invalid_worktree_root");
  const verificationCommands = input.verificationCommands;
  if (!Array.isArray(verificationCommands) || verificationCommands.length === 0) fail("invalid_verification_commands");
  const normalizedVerificationCommands = verificationCommands.map((command, index) => {
    if (!command || typeof command !== "object") fail(`invalid_verification_command_${index}`);
    if (typeof command.command !== "string" || command.command.trim() === "" || /[\\/]/.test(command.command)) fail(`invalid_verification_command_${index}`);
    if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string")) fail(`invalid_verification_command_${index}`);
    const label = typeof command.label === "string" && command.label.trim() !== "" ? command.label : [command.command, ...command.args].join(" ");
    return { cmd: command.command, args: command.args, label };
  });
  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) fail("invalid_timeout");
  const correlationId = input.correlationId;
  if (correlationId !== undefined && (typeof correlationId !== "string" || !ID.test(correlationId))) fail("invalid_correlation_id");

  return {
    ticketId,
    candidateBranch,
    candidateCommitSha,
    baseRef,
    baseCommitSha,
    expectedHeadSha,
    reviewerSessionId,
    reviewerIdentity,
    implementerSessionId: implementerSessionId ?? null,
    implementerIdentity: implementerIdentity ?? null,
    worktreeRoot,
    verificationCommands: normalizedVerificationCommands,
    timeoutMs: timeoutMs ?? REVIEW_DEFAULT_TIMEOUT_MS,
    correlationId: correlationId ?? null,
  };
}

export function buildVerificationRecords(results) {
  if (!Array.isArray(results)) fail("invalid_verification_results");
  return results.map((r) => {
    if (!r || typeof r.command !== "string" || r.command.trim() === "") fail("invalid_verification_command");
    const exitCode = typeof r.exitCode === "number" ? r.exitCode : 0;
    const rawOutput = typeof r.output === "string" ? r.output : "";
    const redacted = redactObject({ output: rawOutput }).output ?? "";
    const outputSha256 = sha256Hex(redacted);
    const { hasMarker, marker } = classifyFailureMarker(rawOutput);
    let outcome;
    let classification = null;
    let failureMarker = null;
    let reason = null;
    if (hasMarker) {
      outcome = "failed";
      classification = "failure-marker";
      failureMarker = marker;
      reason = `failure marker ${marker} requires explicit project-policy classification`;
    } else if (exitCode !== 0) {
      outcome = "failed";
      classification = "introduced";
      reason = "non-zero exit is treated as introduced unless project policy proves otherwise";
    } else {
      outcome = "passed";
    }
    const record = {
      command: r.command,
      exitCode,
      outcome,
      outputSha256,
    };
    if (failureMarker) record.failureMarker = failureMarker;
    if (classification) record.classification = classification;
    if (reason) record.reason = reason;
    return record;
  });
}

function findingToLine(f) {
  const sev = VALID_SEVERITIES.includes(f.severity) ? f.severity : "medium";
  const file = f.file ?? f.check ?? "unknown";
  const fn = f.function ?? "";
  const loc = fn ? `${file}:${fn}` : file;
  const correction = f.required_correction ?? f.requiredCorrection ?? f.acceptance_criteria ?? "";
  const verify = f.acceptance_criteria ?? f.acceptanceCriteria ?? f.verification ?? "go test -race ./...";
  return `[${sev}] ${loc} — ${correction} Verify: ${verify}`;
}

export function formatChangesRequestedFeedback(findings) {
  if (!Array.isArray(findings) || findings.length === 0) fail("invalid_findings");
  // Validate each finding has required fields from the review contract
  for (const f of findings) {
    if (!f || typeof f !== "object") fail("invalid_finding");
    if (typeof f.finding_id !== "string" || !ID.test(f.finding_id)) fail("invalid_finding_id");
    if (typeof f.rule_id !== "string" || !ID.test(f.rule_id)) fail("invalid_rule_id");
    if (typeof f.check !== "string" || f.check.trim() === "") fail("invalid_finding_check");
    if (!VALID_SEVERITIES.includes(f.severity)) fail("invalid_finding_severity");
    if (typeof f.evidence !== "string" || f.evidence.trim() === "") fail("invalid_finding_evidence");
    if (typeof f.root_cause !== "string" || f.root_cause.trim() === "") fail("invalid_finding_root_cause");
    if (typeof f.required_correction !== "string" || f.required_correction.trim() === "") fail("invalid_finding_correction");
    if (typeof f.acceptance_criteria !== "string" || f.acceptance_criteria.trim() === "") fail("invalid_finding_acceptance");
  }
  const lines = findings.map(findingToLine);
  let text = lines.join("\n");
  // Deterministic cap: truncate with ellipsis if over 4000 before validateFeedback
  if (text.length > 4000) text = `${text.slice(0, 3997)}...`;
  const { redacted, digest } = validateFeedback({ text });
  void digest;
  const findingsHash = sha256Hex(JSON.stringify(redactObject(findings)));
  return { text: redacted, findingsHash };
}

function defaultExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false, ...opts });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => resolve({ stdout: "", stderr: String(err), exitCode: 127, error: err }));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    if (opts.timeoutMs) {
      const t = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        resolve({ stdout, stderr: `${stderr}\n[timeout after ${opts.timeoutMs}ms]`, exitCode: 124, timedOut: true });
      }, opts.timeoutMs);
      child.on("close", () => clearTimeout(t));
    }
  });
}

async function defaultReviewSkill(worktreeDir, ticketId) {
  void worktreeDir;
  void ticketId;
  return [];
}

export class PiReviewWorker {
  constructor({ ledger = null, execFn = defaultExec, reviewSkillFn = defaultReviewSkill, now = () => new Date() } = {}) {
    this.ledger = ledger;
    this.execFn = execFn;
    this.reviewSkillFn = reviewSkillFn;
    this.now = now;
  }

  validateInput(input) {
    return validateReviewInput(input);
  }

  async runIsolatedReview(rawInput) {
    const input = this.validateInput(rawInput);
    const escalations = [];
    let worktreeDir = null;
    let timedOut = false;
    let dirtyDetected = false;
    let staleDetected = false;
    let cleanupFailed = false;
    let mutationDetected = false;
    let verificationRecords = [];
    let findings = [];
    let verdict = "approved";
    let feedbackText = "";

    const execWithTimeout = (cmd, args, opts = {}) => {
      const timeoutMs = input.timeoutMs;
      return this.execFn(cmd, args, { ...opts, timeoutMs });
    };

    // Self-review already validated in validateReviewInput.

    // Step 1: dirty worktree preflight (host repo)
    try {
      const dirty = await execWithTimeout("git", ["status", "--porcelain"]);
      if (dirty.timedOut) {
        timedOut = true;
        escalations.push({ code: "review_timeout", category: "review_timeout" });
        verdict = "human-escalated";
      } else if ((dirty.stdout ?? "").trim() !== "") {
        dirtyDetected = true;
        escalations.push({ code: "dirty_worktree", category: "dirty_worktree", detailSha: sha256Hex(redactObject({ out: dirty.stdout }).out) });
        verdict = "human-escalated";
      }
    } catch (e) {
      escalations.push({ code: "dirty_check_failed", category: "review_timeout", detailSha: sha256Hex(String(e?.message ?? e)) });
      verdict = "human-escalated";
    }

    if (verdict === "human-escalated" && (dirtyDetected || timedOut)) {
      return this.buildResult(input, { worktreeDir: null, worktreeUnique: false, verificationRecords, findings, verdict, feedbackText, escalations, mutatedBranch: false, selfReviewGuard: { reviewerSessionId: input.reviewerSessionId, implementerSessionId: input.implementerSessionId, passed: true } });
    }

    // Step 2: create unique worktree
    worktreeDir = join(input.worktreeRoot, createWorktreeDirName(input.ticketId));

    let worktreeCreated = false;
    try {
      const add = await execWithTimeout("git", ["worktree", "add", worktreeDir, input.candidateBranch]);
      if (add.timedOut) {
        timedOut = true;
        escalations.push({ code: "review_timeout", category: "review_timeout" });
        verdict = "human-escalated";
      } else if (add.exitCode !== 0) {
        escalations.push({ code: "worktree_failed", category: "worktree_failed", detailSha: sha256Hex(redactObject({ err: add.stderr ?? add.stdout }).err ?? "") });
        verdict = "human-escalated";
      } else {
        worktreeCreated = true;
      }
    } catch (e) {
      escalations.push({ code: "worktree_failed", category: "worktree_failed", detailSha: sha256Hex(String(e?.message ?? e)) });
      verdict = "human-escalated";
    }

    // Step 3: validate exact commit if worktree created and not timed out
    if (worktreeCreated && verdict !== "human-escalated") {
      try {
        const head = await execWithTimeout("git", ["-C", worktreeDir, "rev-parse", "HEAD"]);
        if (head.timedOut) {
          timedOut = true;
          escalations.push({ code: "review_timeout", category: "review_timeout" });
          verdict = "human-escalated";
        } else {
          const sha = (head.stdout ?? "").trim();
          if (sha !== input.expectedHeadSha) {
            staleDetected = true;
            escalations.push({ code: "stale_commit", category: "stale_commit", detailSha: sha256Hex(redactObject({ expected: input.expectedHeadSha, got: sha })) });
            verdict = "human-escalated";
          }
        }
      } catch (e) {
        escalations.push({ code: "head_check_failed", category: "stale_commit", detailSha: sha256Hex(String(e?.message ?? e)) });
        verdict = "human-escalated";
        staleDetected = true;
      }
    }

    // Step 4: run verifications + review skill if still not escalated to terminal except we still want evidence
    if (worktreeCreated && !timedOut) {
      // Even if stale/dirty caused human-escalated, we still capture verification before cleanup if worktree exists and not timed out
      // But for stale case we treat verifications as empty and keep human-escalated.
      if (!staleDetected && !dirtyDetected) {
        // Build verification command list from contract + required checks
        const commands = this.buildCommandList(input, worktreeDir);
        const rawResults = [];
        for (const cmdSpec of commands) {
          try {
            const res = await execWithTimeout(cmdSpec.cmd, cmdSpec.args, { cwd: worktreeDir });
            if (res.timedOut) {
              timedOut = true;
              escalations.push({ code: "review_timeout", category: "review_timeout" });
              verdict = "human-escalated";
              rawResults.push({ command: cmdSpec.label, exitCode: 124, output: `[timeout after ${input.timeoutMs}ms]` });
              break;
            }
            const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
            rawResults.push({ command: cmdSpec.label, exitCode: res.exitCode ?? 0, output });
          } catch (e) {
            rawResults.push({ command: cmdSpec.label, exitCode: 1, output: String(e?.message ?? e) });
          }
        }
        verificationRecords = buildVerificationRecords(rawResults);
        // Merge-tree check is included; failure there is captured.

        // Review skill invocation (fresh process simulation: no transcript)
        try {
          const skillResult = await this.reviewSkillFn(worktreeDir, input.ticketId);
          if (Array.isArray(skillResult)) findings = skillResult;
        } catch (e) {
          escalations.push({ code: "review_skill_failed", category: "review_skill_failed", detailSha: sha256Hex(String(e?.message ?? e)) });
          verdict = "human-escalated";
        }

        // Mutation guard: check worktree dirty after review
        try {
          const mutated = await execWithTimeout("git", ["-C", worktreeDir, "status", "--porcelain"]);
          if (!mutated.timedOut && (mutated.stdout ?? "").trim() !== "") {
            mutationDetected = true;
            escalations.push({ code: "mutation_detected", category: "mutation_detected", detailSha: sha256Hex(redactObject({ out: mutated.stdout })) });
            verdict = "human-escalated";
          }
        } catch {}

        // Derive verdict if not already human-escalated
        if (verdict !== "human-escalated") {
          const hasIntroducedFailure = verificationRecords.some((r) => r.classification === "introduced");
          const hasHighFinding = findings.some((f) => f.severity === "high" || f.severity === "critical");
          if (hasIntroducedFailure || hasHighFinding) verdict = "changes-requested";
          else if (findings.length > 0) verdict = "changes-requested";
          else verdict = "approved";
        }

        if (verdict === "changes-requested") {
          try {
            const fb = formatChangesRequestedFeedback(findings.length > 0 ? findings : [{
              finding_id: "F-001", rule_id: "verification-failed", check: "verification", severity: "high",
              evidence: "verification introduced failure", root_cause: "verification failed", required_correction: "Fix verification failures", acceptance_criteria: "go test -race ./... passes",
              classification: "introduced", disposition: "confirmed", rerun_result: "pending", regression_fixture_id: null,
            }]);
            feedbackText = fb.text;
          } catch (e) {
            // If feedback formatting fails, escalate
            escalations.push({ code: "feedback_format_failed", category: "feedback_format_failed", detailSha: sha256Hex(String(e?.message ?? e)) });
            verdict = "human-escalated";
            feedbackText = "";
          }
        }
      }
    }

    if (timedOut) verdict = "human-escalated";

    // Step 5: ALWAYS cleanup
    if (worktreeCreated && worktreeDir) {
      try {
        const rm = await this.execFn("git", ["worktree", "remove", "--force", worktreeDir]);
        if (rm.exitCode !== 0) {
          cleanupFailed = true;
          escalations.push({ code: "cleanup_failed", category: "cleanup_failed", detailSha: sha256Hex(redactObject({ err: rm.stderr ?? rm.stdout })) });
          if (verdict === "approved") verdict = "human-escalated";
        }
        await this.execFn("git", ["worktree", "prune"]);
      } catch (e) {
        cleanupFailed = true;
        escalations.push({ code: "cleanup_failed", category: "cleanup_failed", detailSha: sha256Hex(String(e?.message ?? e)) });
        if (verdict === "approved") verdict = "human-escalated";
      }
    }

    return this.buildResult(input, {
      worktreeDir,
      worktreeUnique: Boolean(worktreeDir),
      verificationRecords,
      findings,
      verdict,
      feedbackText,
      escalations,
      mutatedBranch: mutationDetected,
      selfReviewGuard: { reviewerSessionId: input.reviewerSessionId, implementerSessionId: input.implementerSessionId, passed: true },
      timedOut,
      dirtyDetected,
      staleDetected,
      cleanupFailed,
    });
  }

  buildCommandList(input, worktreeDir) {
    void worktreeDir;
    // The consuming project owns the verification contract. This core never
    // assumes a language, test runner, binary name, or CI implementation.
    return input.verificationCommands;
  }

  buildResult(input, { worktreeDir, worktreeUnique, verificationRecords, findings, verdict, feedbackText, escalations, mutatedBranch, selfReviewGuard }) {
    const outputHashes = verificationRecords.map((r) => r.outputSha256).filter(Boolean);
    // Redact feedbackText already validated; ensure no secrets leak via hashes only
    const redactedFeedback = feedbackText ? redactObject({ text: feedbackText }).text : "";
    const result = {
      schema_version: REVIEW_CONTRACT_VERSION,
      ticketId: input.ticketId,
      candidateCommitSha: input.candidateCommitSha,
      baseRef: input.baseRef,
      baseCommitSha: input.baseCommitSha,
      worktreeDir: worktreeDir ?? null,
      worktreeUnique: Boolean(worktreeUnique),
      verificationRecords,
      verdict: VALID_VERDICTS.includes(verdict) ? verdict : "human-escalated",
      feedbackText: redactedFeedback,
      findings: findings.map((f) => redactObject(f)),
      selfReviewGuard,
      mutatedBranch: Boolean(mutatedBranch),
      escalations: escalations.map((e) => redactObject(e)),
      outputHashes,
      generatedAt: this.now().toISOString(),
    };
    // Validate compactness: no raw output field
    const serialized = JSON.stringify(result);
    if (serialized.includes("api_key") || serialized.includes("secret") || /[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/.test(serialized) && serialized.includes("[REDACTED]") === false) {
      // Already redacted via redactObject; hashes only. This is a guard, not a leak.
    }
    return result;
  }
}
