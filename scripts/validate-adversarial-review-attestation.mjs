#!/usr/bin/env node
/**
 * Fail-closed validation for the privacy-safe adversarial-review PR marker.
 * The marker carries only commit-bound metadata; review reports stay local.
 */
import { generateReviewPacket, reviewPacketSha256 } from "./generate-review-packet.mjs";
import { lstat, readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const LIMITS = Object.freeze({
  argument: 4096, branch: 256, sha: 64, body: 24 * 1024, markerJson: 4096,
  author: 256, reviewsFile: 4096, reviews: 2 * 1024 * 1024, reviewPages: 100,
  reviewRecords: 10_000, login: 256, reviewState: 64,
});
const TICKET_BRANCH = /^zkrausman\/aidev-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MARKER_TAG = "<!-- pi-sampler-adversarial-review-attestation:v2";
const MARKER = /<!-- pi-sampler-adversarial-review-attestation:v2 ([^\r\n]{1,4096}) -->/g;
const FORMAT = "pi-sampler.adversarial-review-attestation";
const EXPECTED_KEYS = ["base", "format", "head", "outcome", "packetSha256", "version"];
const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);

function fail(message) { throw new Error(message); }
function boundedString(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0") || (!allowEmpty && !value)) fail(`${label} is missing, unsafe, or exceeds its bound`);
  return value;
}
function singleOptionArguments(argv) {
  if (argv.length > 12 || argv.length % 2) fail("expected supported option/value pairs");
  const names = new Map([["--base", "base"], ["--head", "head"], ["--branch", "branch"], ["--body", "body"], ["--author", "author"], ["--reviews-file", "reviewsFile"]]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || Object.hasOwn(options, key)) fail("expected each supported option at most once");
    options[key] = boundedString(argv[index + 1], argv[index], LIMITS.argument, { allowEmpty: key === "body" });
  }
  return options;
}
function inputValue(options, environment, key, environmentKey, maximum, allowEmpty = false) {
  if (options[key] !== undefined && environment[environmentKey] !== undefined) fail(`${key} must be supplied by either CLI or environment, not both`);
  const value = options[key] ?? environment[environmentKey];
  return boundedString(value, key, maximum, { allowEmpty });
}
export function isTicketBranch(branch) {
  return typeof branch === "string" && TICKET_BRANCH.test(branch);
}
function markerJson(body) {
  const markers = [...body.matchAll(MARKER)];
  const tagOccurrences = body.split(MARKER_TAG).length - 1;
  if (tagOccurrences === 0) return null;
  if (tagOccurrences !== 1 || markers.length !== 1) fail("review attestation marker must appear exactly once as one single-line JSON marker");
  const json = markers[0][1];
  if (Buffer.byteLength(json, "utf8") > LIMITS.markerJson) fail("review attestation marker exceeds its bound");
  try { return JSON.parse(json); } catch { fail("review attestation marker contains invalid JSON"); }
}
function validateSchema(attestation, { base, head, packetSha256 }) {
  if (!attestation || Array.isArray(attestation) || typeof attestation !== "object") fail("review attestation must be a JSON object");
  const keys = Object.keys(attestation).sort();
  if (keys.length !== EXPECTED_KEYS.length || keys.some((key, index) => key !== EXPECTED_KEYS[index])) fail("review attestation has unsupported or missing fields");
  if (attestation.format !== FORMAT || attestation.version !== 2) fail("review attestation format or version is unsupported");
  if (attestation.base !== base || attestation.head !== head) fail("review attestation base or head does not match the resolved PR commits");
  if (attestation.outcome !== "clean") fail("review attestation outcome must be clean with no unresolved blocker or high finding");
  if (typeof attestation.packetSha256 !== "string" || !/^[0-9a-f]{64}$/.test(attestation.packetSha256) || attestation.packetSha256 !== packetSha256) fail("review attestation packet digest does not match the commit-only review packet");
}
function reviewPages(value) {
  if (!Array.isArray(value) || value.length > LIMITS.reviewPages) fail("GitHub review data must be a bounded array of pages");
  // gh api --paginate --slurp produces an outer array of REST response pages.
  if (!value.every(Array.isArray)) fail("GitHub review data contains a malformed page");
  const reviews = value.flat();
  if (reviews.length > LIMITS.reviewRecords) fail("GitHub review data exceeds its record bound");
  return reviews;
}
function validReview(review) {
  if (!review || Array.isArray(review) || typeof review !== "object") fail("GitHub review data contains a malformed review");
  const { id, state, commit_id: commitId, user } = review;
  if (!Number.isSafeInteger(id) || id < 0) fail("GitHub review data contains an invalid review id");
  boundedString(state, "GitHub review state", LIMITS.reviewState);
  if (!REVIEW_STATES.has(state)) fail("GitHub review data contains an unsupported review state");
  boundedString(commitId, "GitHub review commit", LIMITS.sha);
  if (!SHA.test(commitId)) fail("GitHub review data contains an invalid review commit");
  if (!user || Array.isArray(user) || typeof user !== "object") fail("GitHub review data contains a malformed reviewer");
  const login = boundedString(user.login, "GitHub reviewer login", LIMITS.login);
  return { id, state, commitId, login };
}
/**
 * Return whether GitHub's review API proves an independent, current approval.
 * A review ID is monotonic in GitHub's REST API, so the greatest ID is the
 * latest effective review state for a login. Later comments, dismissals, or
 * reviews on another commit therefore invalidate an earlier approval.
 */
export function hasIndependentHeadApproval(reviewData, { author, head }) {
  author = boundedString(author, "author", LIMITS.author);
  head = boundedString(head, "head", LIMITS.sha);
  if (!SHA.test(head)) fail("head must be an exact lowercase 40- or 64-character commit SHA");
  const latestByReviewer = new Map();
  const reviewIds = new Set();
  for (const rawReview of reviewPages(reviewData)) {
    const review = validReview(rawReview);
    if (reviewIds.has(review.id)) fail("GitHub review data contains duplicate review ids");
    reviewIds.add(review.id);
    const reviewerKey = review.login.toLowerCase(); // GitHub login comparison is case-insensitive.
    const prior = latestByReviewer.get(reviewerKey);
    if (!prior || review.id > prior.id) latestByReviewer.set(reviewerKey, review);
  }
  return [...latestByReviewer.entries()].some(([reviewerKey, review]) => reviewerKey !== author.toLowerCase() && review.state === "APPROVED" && review.commitId === head);
}
async function reviewsFromFile(filePath) {
  filePath = boundedString(filePath, "reviewsFile", LIMITS.reviewsFile);
  let metadata;
  try { metadata = await lstat(filePath); } catch { fail("GitHub review data file is unavailable"); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > LIMITS.reviews) fail("GitHub review data file is unsafe or exceeds its bound");
  let content;
  try { content = await readFile(filePath); } catch { fail("GitHub review data file is unavailable"); }
  if (content.length > LIMITS.reviews) fail("GitHub review data file exceeds its bound");
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) fail("GitHub review data file is not valid UTF-8");
  try { return JSON.parse(text); } catch { fail("GitHub review data file contains invalid JSON"); }
}

/** Validate a PR body and GitHub review metadata without emitting either. */
export async function validateAdversarialReviewAttestation({ base, head, branch, body, author, reviews } = {}) {
  base = boundedString(base, "base", LIMITS.sha);
  head = boundedString(head, "head", LIMITS.sha);
  branch = boundedString(branch, "branch", LIMITS.branch);
  body = boundedString(body ?? "", "body", LIMITS.body, { allowEmpty: true });
  if (!SHA.test(base) || !SHA.test(head)) fail("base and head must be exact lowercase 40- or 64-character commit SHAs");

  const marker = markerJson(body);
  const required = isTicketBranch(branch);
  if (!marker) {
    if (required) fail("an adversarial-review attestation is required for an AIDEV ticket branch");
    return { required: false, attested: false };
  }

  const packet = await generateReviewPacket({ base, head });
  // generateReviewPacket resolves commits and verifies base ancestry. Requiring
  // exact equality prevents abbreviated, stale, replacement, or ref-derived claims.
  if (packet.base !== base || packet.head !== head) fail("base or head did not resolve exactly to the supplied commit SHA");
  const digest = reviewPacketSha256(packet);
  validateSchema(marker, { base: packet.base, head: packet.head, packetSha256: digest });
  if (!hasIndependentHeadApproval(reviews, { author, head: packet.head })) fail("GitHub review data does not prove an independent approval of the exact PR head commit");
  return { required, attested: true, base: packet.base, head: packet.head, packetSha256: digest };
}

function cliInputs(argv = process.argv.slice(2), environment = process.env) {
  const options = singleOptionArguments(argv);
  return {
    base: inputValue(options, environment, "base", "ADVERSARIAL_REVIEW_BASE_SHA", LIMITS.sha),
    head: inputValue(options, environment, "head", "ADVERSARIAL_REVIEW_HEAD_SHA", LIMITS.sha),
    branch: inputValue(options, environment, "branch", "ADVERSARIAL_REVIEW_HEAD_REF", LIMITS.branch),
    body: inputValue(options, environment, "body", "ADVERSARIAL_REVIEW_PR_BODY", LIMITS.body, true),
    author: inputValue(options, environment, "author", "ADVERSARIAL_REVIEW_PR_AUTHOR", LIMITS.author),
    reviewsFile: inputValue(options, environment, "reviewsFile", "ADVERSARIAL_REVIEW_REVIEWS_FILE", LIMITS.reviewsFile),
  };
}

async function main() {
  try {
    const { reviewsFile, ...inputs } = cliInputs();
    const result = await validateAdversarialReviewAttestation({ ...inputs, reviews: await reviewsFromFile(reviewsFile) });
    console.log(result.attested ? "Adversarial review attestation validated." : "No adversarial review attestation required for this non-ticket branch.");
  } catch (error) {
    // Never echo the PR body, review JSON, or reviewer identities.
    console.error(`adversarial-review-attestation: ${error.message}`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
