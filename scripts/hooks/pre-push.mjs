#!/usr/bin/env node
/**
 * Validate the already-published PR marker before a ticket branch is pushed.
 * This hook has no publication, push, merge, or PR-body mutation authority.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const MAX_STDIN_BYTES = 64 * 1024;
const MAX_GH_OUTPUT_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 24 * 1024;
const TICKET_BRANCH = /^zkrausman\/aidev-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LOCAL_FINAL_REVIEW_RECEIPT = "artifacts/final-review/receipt.json";
const REPOSITORY = "Zkrausman/pi-sampler";

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
function pushedTicketRefs() {
  let stdin;
  try { stdin = fs.readFileSync(0); } catch { throw new Error("pre-push ref input could not be read"); }
  if (stdin.length > MAX_STDIN_BYTES) throw new Error("pre-push input exceeds its fixed bound");
  const decoded = stdin.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(stdin)) throw new Error("pre-push ref input is not valid UTF-8");
  const refs = [];
  for (const line of decoded.split(/\r?\n/)) {
    if (!line) continue;
    if (line.includes("\0")) throw new Error("pre-push input contains an unsupported NUL byte");
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) throw new Error("pre-push input contains a malformed four-field ref line");
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    const localDeletion = /^0{40}$|^0{64}$/.test(localSha);
    const remoteDeletion = /^0{40}$|^0{64}$/.test(remoteSha);
    if (!localRef || !remoteRef.startsWith("refs/") || (!SHA.test(localSha) && !localDeletion) || (!SHA.test(remoteSha) && !remoteDeletion)) throw new Error("pre-push input contains an invalid ref or SHA");
    if (!localRef.startsWith("refs/heads/")) continue;
    const branch = localRef.slice("refs/heads/".length);
    if (!TICKET_BRANCH.test(branch)) continue;
    // A zero object is a branch deletion; it has no candidate to attest.
    if (localDeletion) continue;
    refs.push({ branch, head: localSha });
  }
  return refs;
}
function currentTicketRef() {
  let branch;
  try {
    branch = safeExec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { maxBuffer: 512 }).trim();
  } catch (error) {
    // A detached HEAD is a verified no-branch state; all other inspection
    // failures must block instead of silently skipping a ticket validation.
    if (error?.status === 1) return [];
    throw new Error("current Git branch could not be inspected");
  }
  let head;
  try {
    head = safeExec("git", ["rev-parse", "--verify", "HEAD^{commit}"], { maxBuffer: 256 }).trim();
  } catch {
    throw new Error("current Git HEAD could not be inspected");
  }
  if (!TICKET_BRANCH.test(branch)) return [];
  if (!SHA.test(head)) throw new Error("current Git HEAD is not an exact commit SHA");
  return [{ branch, head }];
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
function prRecord(branch) {
  let text;
  try {
    text = safeExec("gh", ["pr", "view", branch, "--json", "number,baseRefOid,headRefName,body"], { maxBuffer: MAX_GH_OUTPUT_BYTES });
  } catch (error) {
    if (error?.status !== undefined && explicitlyVerifiedNoPr(branch)) return null;
    throw new Error("GitHub PR lookup failed; refusing to skip attestation validation");
  }
  let record;
  try { record = JSON.parse(text); } catch { throw new Error("GitHub response is not valid JSON"); }
  if (!record || Array.isArray(record) || typeof record !== "object") throw new Error("GitHub response is not an object");
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "baseRefOid,body,headRefName,number") throw new Error("GitHub response has an unexpected shape");
  if (!Number.isSafeInteger(record.number) || record.number < 1) throw new Error("GitHub response is not bound to a valid pull request");
  if (record.headRefName !== branch || !SHA.test(record.baseRefOid)) throw new Error("GitHub response is not bound to the exact branch/base");
  bounded(record.body ?? "", "PR body", MAX_BODY_BYTES, { allowEmpty: true });
  return record;
}
function validateMarker({ branch, head, base, body, pullRequest }) {
  const env = { ...process.env };
  for (const key of ["ADVERSARIAL_REVIEW_BASE_SHA", "ADVERSARIAL_REVIEW_HEAD_SHA", "ADVERSARIAL_REVIEW_HEAD_REF", "ADVERSARIAL_REVIEW_PR_BODY", "ADVERSARIAL_REVIEW_RECEIPT_PATH", "ADVERSARIAL_REVIEW_REPOSITORY", "ADVERSARIAL_REVIEW_PULL_REQUEST"]) delete env[key];
  env.ADVERSARIAL_REVIEW_PR_BODY = body;
  const args = ["scripts/validate-adversarial-review-attestation.mjs", "--base", base, "--head", head, "--branch", branch, "--receipt", LOCAL_FINAL_REVIEW_RECEIPT, "--repository", REPOSITORY, "--pull-request", String(pullRequest)];
  // Activation is selected only by the validator bytes at the exact trusted
  // base; this hook must not provide a candidate-controlled override.
  safeExec(process.execPath, args, { env, stdio: "inherit" });
}

try {
  const refs = pushedTicketRefs();
  const candidates = refs.length ? refs : currentTicketRef();
  for (const candidate of candidates) {
    console.log(`[pre-push] Ticket branch detected (${candidate.branch}). Checking attestation...`);
    const pr = prRecord(candidate.branch);
    if (!pr) {
      console.log("[pre-push] No PR found for this branch yet. Skipping attestation validation.");
      console.log("[pre-push] Do not publish review material; add the required privacy-safe marker when the PR exists.");
      continue;
    }
    try {
      validateMarker({ branch: candidate.branch, head: candidate.head, base: pr.baseRefOid, body: pr.body ?? "", pullRequest: pr.number });
      console.log("[pre-push] Adversarial review attestation is valid for this exact push.");
    } catch {
      console.error("[pre-push] Adversarial review attestation validation failed for the exact pushed head.");
      console.error("[pre-push] Refresh the privacy-safe marker after the final review; this hook does not update the PR or push for you.");
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`[pre-push] ${error instanceof Error ? error.message : "validation failed"}`);
  process.exitCode = 1;
}
