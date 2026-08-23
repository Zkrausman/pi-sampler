/**
 * Versioned, repository-trusted public provenance catalog.
 *
 * The catalog is intentionally exact. It is not a semantic classifier and it
 * does not accept caller-provided provider/model suffixes. A future model or
 * profile requires a reviewed trusted-base catalog change.
 */

export const REVIEW_PROVENANCE_CATALOG_FORMAT = "pi-sampler.public-review-provenance-catalog";
export const REVIEW_PROVENANCE_CATALOG_VERSION = 1;
export const REVIEW_PROVENANCE_LIMITS = Object.freeze({
  reviewerModelId: 128,
  reviewProfileVersion: 64,
});

export const REVIEW_PROVENANCE_CATALOG = Object.freeze({
  format: REVIEW_PROVENANCE_CATALOG_FORMAT,
  version: REVIEW_PROVENANCE_CATALOG_VERSION,
  reviewerModelIds: Object.freeze([
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-terra",
  ]),
  reviewProfileVersions: Object.freeze([
    "terra-final-v1",
  ]),
});

const REVIEWER_MODEL_IDS = new Set(REVIEW_PROVENANCE_CATALOG.reviewerModelIds);
const REVIEW_PROFILE_VERSIONS = new Set(REVIEW_PROVENANCE_CATALOG.reviewProfileVersions);

export const REVIEWER_MODEL_ID_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: REVIEW_PROVENANCE_LIMITS.reviewerModelId,
  enum: [...REVIEW_PROVENANCE_CATALOG.reviewerModelIds],
});
export const REVIEW_PROFILE_VERSION_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: REVIEW_PROVENANCE_LIMITS.reviewProfileVersion,
  enum: [...REVIEW_PROVENANCE_CATALOG.reviewProfileVersions],
});

export const REVIEW_PROVENANCE_CONTRACT = Object.freeze({
  catalog: REVIEW_PROVENANCE_CATALOG,
  reviewerModelId: REVIEWER_MODEL_ID_SCHEMA,
  reviewProfileVersion: REVIEW_PROFILE_VERSION_SCHEMA,
  canonicalExamples: Object.freeze({
    reviewerModelId: Object.freeze([...REVIEW_PROVENANCE_CATALOG.reviewerModelIds]),
    reviewProfileVersion: Object.freeze([...REVIEW_PROVENANCE_CATALOG.reviewProfileVersions]),
  }),
  grammar: Object.freeze({
    reviewerModelId: "exact membership in the versioned trusted public reviewer-model catalog",
    reviewProfileVersion: "exact membership in the versioned trusted public review-profile catalog",
  }),
});

function catalogMember(value, maximum, members) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maximum
    && members.has(value);
}

export function isPrivacySafeReviewerModelId(value) {
  return catalogMember(value, REVIEW_PROVENANCE_LIMITS.reviewerModelId, REVIEWER_MODEL_IDS);
}

export function isPrivacySafeReviewProfileVersion(value) {
  return catalogMember(value, REVIEW_PROVENANCE_LIMITS.reviewProfileVersion, REVIEW_PROFILE_VERSIONS);
}

function fail(message) { throw new Error(message); }
function assertCatalogMember(value, label, predicate, description) {
  if (!predicate(value)) fail(`${label} must be an entry in the trusted public ${description} catalog`);
  return value;
}

export function assertPrivacySafeReviewerModelId(value, label = "reviewerModelId") {
  return assertCatalogMember(value, label, isPrivacySafeReviewerModelId, "reviewer model");
}

export function assertPrivacySafeReviewProfileVersion(value, label = "reviewProfileVersion") {
  return assertCatalogMember(value, label, isPrivacySafeReviewProfileVersion, "review profile");
}

export function assertPrivacySafeReviewProvenance({ reviewerModelId, reviewProfileVersion } = {}, labels = {}) {
  assertPrivacySafeReviewerModelId(reviewerModelId, labels.reviewerModelId ?? "reviewerModelId");
  assertPrivacySafeReviewProfileVersion(reviewProfileVersion, labels.reviewProfileVersion ?? "reviewProfileVersion");
  return { reviewerModelId, reviewProfileVersion };
}

export const isPrivacySafeProvenance = ({ reviewerModelId, reviewProfileVersion } = {}) => (
  isPrivacySafeReviewerModelId(reviewerModelId)
  && isPrivacySafeReviewProfileVersion(reviewProfileVersion)
);

export const PROVENANCE_CONTRACT = REVIEW_PROVENANCE_CONTRACT;
