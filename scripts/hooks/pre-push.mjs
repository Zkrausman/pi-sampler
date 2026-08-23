#!/usr/bin/env node
/**
 * Fail-closed early feedback for the already-published PR marker before a
 * push. Protected trusted-base CI is the authoritative evidence gate. This
 * hook is optional and bypassable by design; it has no approval, publication,
 * push, merge, or PR-body mutation authority.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  MAX_BRANCH_BYTES,
  MAX_REF_BYTES,
  PRE_PUSH_KINDS,
  PRE_PUSH_LIFECYCLE_KINDS,
  PRE_PUSH_PR_STATES,
  classifyPrePushLifecycle,
  normalizePrePushInput,
} from "./pre-push-protocol.mjs";

const MAX_GH_OUTPUT_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 24 * 1024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH_PREFIX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_SUFFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRUSTED_PROFILE_PATH = "profiles/pi-sampler.json";
const TRUSTED_PROFILE_MAX_BYTES = 128 * 1024;
const TRUSTED_WORK_ITEM_PATTERN_MAX_BYTES = 1024;
const SAFE_ENVIRONMENT_NAMES = Object.freeze(process.platform === "win32"
  ? ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA"]
  : ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]);
const TRUSTED_GIT_OPTIONS = Object.freeze([
  "--no-pager", "--no-replace-objects", "-c", "trace2.eventTarget=", "-c", "trace2.normalTarget=", "-c", "trace2.perfTarget=",
  "-c", "color.ui=false", "-c", "core.hooksPath=/dev/null", "-c", "user.useConfigOnly=true",
]);
const LOCAL_FINAL_REVIEW_RECEIPT = "artifacts/final-review/receipt.json";

function bounded(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0") || (!allowEmpty && !value)) throw new Error(`${label} is missing or exceeds its bound`);
  return value;
}
function safeExec(file, args, options = {}) {
  return execFileSync(file, args, {
    windowsHide: true,
    shell: false,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? MAX_GH_OUTPUT_BYTES,
    stdio: options.stdio ?? ["ignore", "pipe", "ignore"],
    env: options.env,
  });
}
function fixedGitEnvironment(source = process.env) {
  const environment = {};
  for (const expectedName of SAFE_ENVIRONMENT_NAMES) {
    const entry = Object.entries(source).find(([name]) => name.toLowerCase() === expectedName.toLowerCase());
    if (entry && !/^git_/i.test(entry[0])) environment[entry[0]] = entry[1];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}
function safeGit(args, options = {}) {
  return safeExec("git", [...TRUSTED_GIT_OPTIONS, ...args], { ...options, env: fixedGitEnvironment() });
}
function repositoryObjectFormat() {
  let format;
  try { format = safeGit(["rev-parse", "--show-object-format"], { maxBuffer: 128 }).trim(); } catch {
    throw new Error("Git object format could not be inspected safely");
  }
  if (format === "sha1") return Object.freeze({ name: format, width: 40 });
  if (format === "sha256") return Object.freeze({ name: format, width: 64 });
  throw new Error("Git object format is unsupported or ambiguous");
}
function shaHasWidth(value, width) {
  return SHA.test(value) && value.length === width;
}
function validateRef(value, label, { allowHead = false } = {}) {
  const ref = bounded(value, label, MAX_REF_BYTES);
  if (allowHead && ref === "HEAD") return ref;
  try {
    safeGit(["check-ref-format", ref], { maxBuffer: 1024 });
  } catch {
    throw new Error(`pre-push input contains an invalid ${label}`);
  }
  return ref;
}
function exactLocalCommit(sha, width) {
  if (!shaHasWidth(sha, width)) throw new Error("pre-push input contains a non-commit or non-exact local candidate");
  let resolved;
  let type;
  try {
    resolved = safeGit(["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`], { maxBuffer: 256 }).trim();
    type = safeGit(["cat-file", "-t", sha], { maxBuffer: 256 }).trim();
  } catch {
    throw new Error("pre-push input contains a non-commit or non-exact local candidate");
  }
  if (resolved !== sha || type !== "commit") throw new Error("pre-push input contains a non-commit or non-exact local candidate");
  return sha;
}
function pushedUpdates(objectFormat) {
  let stdin;
  try { stdin = fs.readFileSync(0); } catch { throw new Error("pre-push ref input could not be read"); }
  return normalizePrePushInput(stdin, { validateRef, shaWidth: objectFormat.width });
}
function exactTrustedBase(base, width) {
  if (!shaHasWidth(base, width)) throw new Error("GitHub PR base is not an exact commit SHA for this repository object format");
  let resolved;
  let type;
  try {
    resolved = safeGit(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], { maxBuffer: 256 }).trim();
    type = safeGit(["cat-file", "-t", base], { maxBuffer: 256 }).trim();
  } catch {
    throw new Error("trusted PR base could not be resolved as an exact commit");
  }
  if (resolved !== base || type !== "commit") throw new Error("trusted PR base could not be resolved as an exact commit");
  return base;
}
function trustedTicketDestination(branch, base, width) {
  const exactBase = exactTrustedBase(base, width);
  let profileText;
  try {
    profileText = safeGit(["cat-file", "blob", `${exactBase}:${TRUSTED_PROFILE_PATH}`], { maxBuffer: TRUSTED_PROFILE_MAX_BYTES });
  } catch {
    throw new Error("trusted destination policy could not be read from the exact PR base");
  }
  let profile;
  try { profile = JSON.parse(profileText); } catch { throw new Error("trusted destination policy is not valid JSON"); }
  const repository = profile?.repository?.source;
  const branchPrefix = profile?.delivery?.branchPrefix;
  const workItemSource = profile?.workItem?.idPattern;
  if (!REPOSITORY_SOURCE.test(repository ?? "") || !BRANCH_PREFIX.test(branchPrefix ?? "") || typeof workItemSource !== "string" || Buffer.byteLength(workItemSource, "utf8") > TRUSTED_WORK_ITEM_PATTERN_MAX_BYTES || workItemSource.includes("\0")) {
    throw new Error("trusted destination policy is malformed");
  }
  let workItemPattern;
  try { workItemPattern = new RegExp(workItemSource); } catch { throw new Error("trusted destination policy is malformed"); }
  const prefix = `${branchPrefix}/`;
  if (!branch.startsWith(prefix)) return false;
  const suffix = branch.slice(prefix.length);
  if (!BRANCH_SUFFIX.test(suffix)) return false;
  const segments = suffix.split("-");
  for (let end = 1; end < segments.length; end += 1) {
    const workItem = segments.slice(0, end).join("-").toUpperCase();
    workItemPattern.lastIndex = 0;
    if (workItemPattern.test(workItem)) return true;
  }
  return false;
}
function currentBranchCandidate(width) {
  let branch;
  try {
    branch = safeGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { maxBuffer: 512 }).trim();
  } catch (error) {
    // An empty stdin is only a direct hook invocation. A detached HEAD is a
    // verified no-branch state; all other inspection failures must block.
    if (error?.status === 1) return [];
    throw new Error("current Git branch could not be inspected");
  }
  let head;
  try {
    head = safeGit(["rev-parse", "--verify", "HEAD^{commit}"], { maxBuffer: 256 }).trim();
  } catch {
    throw new Error("current Git HEAD could not be inspected");
  }
  if (!shaHasWidth(head, width)) throw new Error("current Git HEAD is not an exact commit SHA for this repository object format");
  return [{ kind: PRE_PUSH_KINDS.UPDATE, source: "attached-fallback", branch: bounded(branch, "branch", MAX_BRANCH_BYTES), newSha: head }];
}
function explicitlyVerifiedNoPr(branch) {
  let text;
  try {
    text = safeExec("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number", "--limit", "1"], { maxBuffer: 4096 });
  } catch {
    throw new Error("GitHub PR absence could not be verified within its fixed bound");
  }
  let records;
  try { records = JSON.parse(text); } catch { throw new Error("GitHub PR list response is not valid JSON"); }
  if (!Array.isArray(records) || records.length > 1) throw new Error("GitHub PR list response has an unexpected shape");
  if (records.length === 0) return true;
  const record = records[0];
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).join(",") !== "number" || !Number.isSafeInteger(record.number) || record.number < 1) {
    throw new Error("GitHub PR list response has an unexpected shape");
  }
  return false;
}
function prRecord(branch, width) {
  let text;
  try {
    text = safeExec("gh", ["pr", "view", branch, "--json", "number,baseRefOid,headRefName,body"], { maxBuffer: MAX_GH_OUTPUT_BYTES });
  } catch (error) {
    if (error?.status !== undefined) {
      try {
        if (explicitlyVerifiedNoPr(branch)) return { state: PRE_PUSH_PR_STATES.VERIFIED_ABSENT };
      } catch (lookupError) {
        return { state: PRE_PUSH_PR_STATES.LOOKUP_FAILURE, reason: lookupError instanceof Error ? lookupError.message : "GitHub PR absence could not be verified" };
      }
    }
    return { state: PRE_PUSH_PR_STATES.LOOKUP_FAILURE, reason: "GitHub PR lookup failed; refusing to skip attestation validation" };
  }
  let record;
  try { record = JSON.parse(text); } catch {
    return { state: PRE_PUSH_PR_STATES.LOOKUP_FAILURE, reason: "GitHub response is not valid JSON" };
  }
  if (!record || Array.isArray(record) || typeof record !== "object") return { state: PRE_PUSH_PR_STATES.LOOKUP_FAILURE, reason: "GitHub response is not an object" };
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "baseRefOid,body,headRefName,number") return { state: PRE_PUSH_PR_STATES.LOOKUP_FAILURE, reason: "GitHub response has an unexpected shape" };
  if (!Number.isSafeInteger(record.number) || record.number < 1 || typeof record.headRefName !== "string" || typeof record.body !== "string") {
    return { state: PRE_PUSH_PR_STATES.LOOKUP_FAILURE, reason: "GitHub response is not bound to a valid pull request" };
  }
  if (record.headRefName !== branch || !shaHasWidth(record.baseRefOid, width)) return { state: PRE_PUSH_PR_STATES.LOOKUP_FAILURE, reason: "GitHub response is not bound to the exact branch/base object format" };
  try { bounded(record.body, "PR body", MAX_BODY_BYTES, { allowEmpty: true }); } catch {
    return { state: PRE_PUSH_PR_STATES.LOOKUP_FAILURE, reason: "GitHub PR body exceeds its fixed bound" };
  }
  return { state: PRE_PUSH_PR_STATES.EXISTING, record };
}
function validateMarker({ branch, head, base, body, pullRequest }) {
  const env = { ...process.env };
  for (const key of ["ADVERSARIAL_REVIEW_BASE_SHA", "ADVERSARIAL_REVIEW_HEAD_SHA", "ADVERSARIAL_REVIEW_HEAD_REF", "ADVERSARIAL_REVIEW_PR_BODY", "ADVERSARIAL_REVIEW_RECEIPT_PATH", "ADVERSARIAL_REVIEW_PULL_REQUEST"]) delete env[key];
  env.ADVERSARIAL_REVIEW_PR_BODY = body;
  const args = ["scripts/validate-adversarial-review-attestation.mjs", "--base", base, "--head", head, "--branch", branch, "--receipt", LOCAL_FINAL_REVIEW_RECEIPT, "--pull-request", String(pullRequest)];
  // This invokes the same trusted-base-aware validator used for early local
  // feedback. It does not approve, publish, push, merge, or replace CI.
  safeExec(process.execPath, args, { env, stdio: "inherit" });
}
function processUpdate(update, objectFormat) {
  if (update.kind !== PRE_PUSH_KINDS.CREATE && update.kind !== PRE_PUSH_KINDS.UPDATE) {
    const lifecycleState = classifyPrePushLifecycle(update);
    if (lifecycleState.kind === PRE_PUSH_LIFECYCLE_KINDS.IGNORED) {
      console.log(`[pre-push] Ignoring ${update.reason}; no branch candidate or evidence is required.`);
      return;
    }
    if (lifecycleState.kind === PRE_PUSH_LIFECYCLE_KINDS.DELETION) {
      console.log(`[pre-push] Valid branch deletion for destination (${update.branch}); no candidate evidence is required.`);
      return;
    }
    throw new Error(lifecycleState.reason ?? "pre-push input contains an unsupported normalized state");
  }

  const head = exactLocalCommit(update.newSha, objectFormat.width);
  console.log(`[pre-push] Checking ${update.kind} attestation for destination branch (${update.branch})...`);
  const pr = prRecord(update.branch, objectFormat.width);
  const lifecycleState = classifyPrePushLifecycle(update, {
    prStatus: pr.state,
    prReason: pr.reason,
    isTicketDestination: pr.record ? (branch) => trustedTicketDestination(branch, pr.record.baseRefOid, objectFormat.width) : undefined,
  });
  if (lifecycleState.kind === PRE_PUSH_LIFECYCLE_KINDS.INITIAL_PUBLICATION) {
    console.log("[pre-push] PR absence was explicitly verified and this genuine first branch creation is classified as initial-publication.");
    console.log("[pre-push] This push is allowed only to bootstrap PR creation; it grants no approval or merge authority.");
    console.log("[pre-push] Protected trusted-base CI remains blocked until the required review evidence exists.");
    return;
  }
  if (lifecycleState.kind === PRE_PUSH_LIFECYCLE_KINDS.NO_PR_UPDATE) {
    throw new Error(lifecycleState.reason ?? "a branch update requires an existing pull request");
  }
  if (lifecycleState.kind === PRE_PUSH_LIFECYCLE_KINDS.PR_LOOKUP_FAILURE) {
    throw new Error(lifecycleState.reason ?? "GitHub PR lookup failed; refusing to skip attestation validation");
  }
  if (lifecycleState.kind === PRE_PUSH_LIFECYCLE_KINDS.IGNORED) {
    console.log("[pre-push] The exact trusted PR base classifies this destination as non-ticket; no evidence is required.");
    return;
  }
  if (lifecycleState.kind !== PRE_PUSH_LIFECYCLE_KINDS.EXISTING_PR) throw new Error(lifecycleState.reason ?? "pre-push lifecycle state is unsupported");

  const { record } = pr;
  try {
    // The validator remains the authoritative evidence implementation; this
    // hook's trusted-base classification is only bypassable early feedback.
    validateMarker({ branch: update.branch, head, base: record.baseRefOid, body: record.body, pullRequest: record.number });
    console.log("[pre-push] Trusted-base early validation passed for this exact push.");
  } catch {
    console.error("[pre-push] Adversarial review attestation validation failed for the exact pushed head.");
    console.error("[pre-push] Refresh the privacy-safe marker after the final review; this hook does not update the PR or push for you.");
    process.exitCode = 1;
  }
}
function main() {
  const objectFormat = repositoryObjectFormat();
  const normalized = pushedUpdates(objectFormat);
  const invalidUpdate = normalized.updates.find((update) => update.kind === PRE_PUSH_KINDS.INVALID);
  if (invalidUpdate) throw new Error(`${invalidUpdate.reason}${invalidUpdate.line ? ` (line ${invalidUpdate.line})` : ""}`);
  const updates = normalized.hasInput ? normalized.updates : currentBranchCandidate(objectFormat.width);
  for (const update of updates) processUpdate(update, objectFormat);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[pre-push] ${error instanceof Error ? error.message : "validation failed"}`);
    process.exitCode = 1;
  }
}
