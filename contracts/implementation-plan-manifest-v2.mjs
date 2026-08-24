import { Type } from "typebox";
import { Compile } from "typebox/compile";

export const IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_ID = "https://pi-sampler.dev/contracts/implementation-plan-manifest/v2";
export const IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_VERSION = "implementation-plan-manifest/v2";
export const IMPLEMENTATION_PLAN_MANIFEST_V2_LIMITS = Object.freeze({
  minStringLength: 1,
  minArrayItems: 0,
  minRequiredArrayItems: 1,
  minRevisionLength: 40,
  minMemberCount: 0,
  maxIdentifierLength: 128,
  maxTicketIdLength: 32,
  maxRepositoryLength: 256,
  maxPathLength: 256,
  maxDigestLength: 64,
  maxRevisionLength: 64,
  maxTitleLength: 256,
  maxTextLength: 2048,
  maxShortTextLength: 512,
  maxQuestionLength: 1024,
  maxRows: 128,
  maxHardDependencies: 64,
  maxPredecessorOutputs: 64,
  maxSoftDependencies: 64,
  maxSoftEvidence: 8,
  maxDownstreamUnblockSet: 128,
  maxAffectedContracts: 128,
  maxAffectedPackages: 128,
  maxOwnedFiles: 256,
  maxOwnedSymbols: 256,
  maxOwnedContracts: 128,
  maxCompatibilityAssumptions: 32,
  maxStalenessTriggers: 32,
  maxRevalidationInputs: 32,
  maxUnresolvedDecisions: 32,
  maxRequiredOutputs: 32,
  maxRequirementIds: 32,
  maxEvidenceTextLength: 512,
  minHorizonDays: 1,
  maxHorizonDays: 3650,
});

const L = IMPLEMENTATION_PLAN_MANIFEST_V2_LIMITS;
const identifierPattern = "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$";
const ticketIdPattern = "^[A-Z][A-Z0-9]+-[0-9]+$";
const digestPattern = "^[a-f0-9]{64}$";
const revisionPattern = "^[a-f0-9]{40}([a-f0-9]{24})?$";
const repositoryPattern = "^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$";
// Percent escapes are rejected as a whole so encoded traversal cannot pass a
// structural check. Cross-platform filesystem and Git-object checks are later
// validator responsibilities.
const relativePosixPathPattern = "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*//)(?!.*%)(?!.*(?:^|/)\\.\\.?(?:/|$))[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9._-])?$";

const boundedString = (title, maxLength = L.maxTextLength) => Type.String({
  title,
  minLength: L.minStringLength,
  maxLength,
});
const identifier = (title = "Identifier", maxLength = L.maxIdentifierLength) => Type.String({
  title,
  minLength: L.minStringLength,
  maxLength,
  pattern: identifierPattern,
});
const ticketId = Type.String({
  title: "Ticket identity",
  minLength: L.minStringLength,
  maxLength: L.maxTicketIdLength,
  pattern: ticketIdPattern,
});
const digest = Type.String({
  title: "Lowercase SHA-256 digest",
  minLength: L.maxDigestLength,
  maxLength: L.maxDigestLength,
  pattern: digestPattern,
});
const revision = Type.String({
  title: "Immutable Git revision",
  minLength: L.minRevisionLength,
  maxLength: L.maxRevisionLength,
  pattern: revisionPattern,
});
const repository = Type.String({
  title: "Repository identity",
  minLength: L.minStringLength,
  maxLength: L.maxRepositoryLength,
  pattern: repositoryPattern,
});
const relativePosixPath = Type.String({
  title: "Portable repository-relative POSIX path",
  minLength: L.minStringLength,
  maxLength: L.maxPathLength,
  pattern: relativePosixPathPattern,
});
const boundedArray = (schema, maxItems, minItems = L.minArrayItems) => Type.Array(schema, { minItems, maxItems });
const enumOf = (values, title) => Type.Union(values.map((value) => Type.Literal(value)), { title });

export const IMPLEMENTATION_PLAN_MANIFEST_V2_ACCEPTANCE_CLASSES = Object.freeze([
  "ordinary",
  "authority",
  "requirement",
  "resource-bounded",
  "concurrency",
  "evidence",
  "benchmark",
]);
export const IMPLEMENTATION_PLAN_MANIFEST_V2_CONFIDENCE_LEVELS = Object.freeze(["low", "medium", "high"]);

const acceptanceClass = enumOf(IMPLEMENTATION_PLAN_MANIFEST_V2_ACCEPTANCE_CLASSES, "Acceptance class");
const confidence = enumOf(IMPLEMENTATION_PLAN_MANIFEST_V2_CONFIDENCE_LEVELS, "Soft dependency confidence");
const scale = enumOf(["low", "medium", "high"], "Bounded qualitative scale");

export const ImplementationPlanManifestV2AcceptanceRowSchema = Type.Object({
  id: identifier("Acceptance requirement identity", L.maxIdentifierLength),
  title: boundedString("Acceptance requirement title", L.maxTitleLength),
  acceptance_class: acceptanceClass,
  requirement: boundedString("Acceptance requirement", L.maxTextLength),
}, { additionalProperties: false });

export const ImplementationPlanManifestV2HardDependencySchema = Type.Object({
  ticket_id: ticketId,
  reason: boundedString("Explicit hard dependency reason", L.maxTextLength),
  required_outputs: boundedArray(identifier("Required predecessor output", L.maxIdentifierLength), L.maxRequiredOutputs),
  requirement_ids: boundedArray(identifier("Dependent requirement identity", L.maxIdentifierLength), L.maxRequirementIds),
}, { additionalProperties: false });

export const ImplementationPlanManifestV2PredecessorOutputSchema = Type.Object({
  ticket_id: ticketId,
  output_id: identifier("Expected predecessor output identity"),
  contract: identifier("Expected predecessor contract identity"),
  expected_digest: Type.Optional(digest),
  expected_revision: Type.Optional(revision),
}, { additionalProperties: false });

export const ImplementationPlanManifestV2SoftDependencyEvidenceSchema = Type.Object({
  kind: identifier("Soft dependency evidence kind", L.maxIdentifierLength),
  source: boundedString("Soft dependency evidence source", L.maxEvidenceTextLength),
  summary: boundedString("Soft dependency evidence summary", L.maxEvidenceTextLength),
}, { additionalProperties: false });

export const ImplementationPlanManifestV2SoftDependencySchema = Type.Object({
  ticket_id: ticketId,
  evidence: boundedArray(ImplementationPlanManifestV2SoftDependencyEvidenceSchema, L.maxSoftEvidence, L.minRequiredArrayItems),
  confidence,
}, { additionalProperties: false });

export const ImplementationPlanManifestV2EpicSchema = Type.Object({
  kind: enumOf(["standalone", "member", "umbrella"], "Epic or umbrella role"),
  epic_id: Type.Optional(identifier("Epic or umbrella identity")),
  title: Type.Optional(boundedString("Epic or umbrella title", L.maxTitleLength)),
  member_count: Type.Optional(Type.Integer({ minimum: L.minMemberCount, maximum: L.maxDownstreamUnblockSet })),
}, { additionalProperties: false });

export const ImplementationPlanManifestV2PortfolioSchema = Type.Object({
  planning_effort: enumOf(["small", "medium", "large", "very_large"], "Planning effort"),
  implementation_size: enumOf(["small", "medium", "large", "very_large"], "Implementation size"),
  requirement_readiness: enumOf(["not_ready", "partially_ready", "ready"], "Requirement readiness"),
  information_gain: scale,
  downstream_unblock_set: boundedArray(ticketId, L.maxDownstreamUnblockSet),
  affected_contracts: boundedArray(identifier("Affected contract identity"), L.maxAffectedContracts),
  affected_packages: boundedArray(identifier("Affected package identity"), L.maxAffectedPackages),
  conflict_surface: scale,
  staleness_horizon_days: Type.Integer({ minimum: L.minHorizonDays, maximum: L.maxHorizonDays }),
  risk_reduction_value: scale,
  unresolved_human_decisions: boundedArray(Type.Object({
    id: identifier("Human decision identity"),
    question: boundedString("Unresolved human decision", L.maxQuestionLength),
    blocking: Type.Boolean(),
  }, { additionalProperties: false }), L.maxUnresolvedDecisions),
}, { additionalProperties: false });

export const ImplementationPlanManifestV2OwnershipSchema = Type.Object({
  files: boundedArray(relativePosixPath, L.maxOwnedFiles, L.minRequiredArrayItems),
  symbols: boundedArray(identifier("Owned symbol identity"), L.maxOwnedSymbols),
  contracts: boundedArray(identifier("Owned contract identity"), L.maxOwnedContracts),
}, { additionalProperties: false });

export const ImplementationPlanManifestV2CompatibilitySchema = Type.Object({
  assumptions: boundedArray(boundedString("Compatibility assumption", L.maxTextLength), L.maxCompatibilityAssumptions),
  preserves_v1_readability: Type.Boolean(),
  silently_upgrades_v1: Type.Literal(false),
}, { additionalProperties: false });

export const IMPLEMENTATION_PLAN_MANIFEST_V2_STALENESS_TRIGGER_KINDS = Object.freeze([
  "plan_changed",
  "ticket_changed",
  "base_revision_changed",
  "predecessor_output_changed",
  "contract_changed",
  "requirement_changed",
  "approval_expired",
]);
const stalenessTrigger = Type.Object({
  kind: enumOf(IMPLEMENTATION_PLAN_MANIFEST_V2_STALENESS_TRIGGER_KINDS, "Staleness trigger kind"),
  input: identifier("Staleness trigger input"),
  action: enumOf(["manual_refresh", "revalidate", "renew_approval"], "Staleness response"),
}, { additionalProperties: false });

export const ImplementationPlanManifestV2StalenessSchema = Type.Object({
  triggers: boundedArray(stalenessTrigger, L.maxStalenessTriggers, L.minRequiredArrayItems),
  descendant_base_campaign_drift_is_not_plan_staleness: Type.Literal(true),
}, { additionalProperties: false });

export const IMPLEMENTATION_PLAN_MANIFEST_V2_REVALIDATION_INPUT_KINDS = Object.freeze([
  "repository_revision",
  "ticket_revision",
  "plan_digest",
  "predecessor_output",
  "contract_digest",
]);
export const ImplementationPlanManifestV2RevalidationSchema = Type.Object({
  inputs: boundedArray(Type.Object({
    kind: enumOf(IMPLEMENTATION_PLAN_MANIFEST_V2_REVALIDATION_INPUT_KINDS, "Just-in-time revalidation input kind"),
    name: identifier("Just-in-time revalidation input name"),
    expected: boundedString("Expected revalidation value", L.maxShortTextLength),
  }, { additionalProperties: false }), L.maxRevalidationInputs, L.minRequiredArrayItems),
  required_before: enumOf(["implementation", "validation", "publication"], "Revalidation phase"),
}, { additionalProperties: false });

/**
 * Canonical structural source for the Manifest v2 contract. This schema is
 * executable by TypeBox and is the sole source for the committed JSON Schema.
 * Cross-artifact digest, Git-object, and approval semantics belong to Slice 3.
 */
export const ImplementationPlanManifestV2Schema = Type.Object({
  schema_version: Type.Literal(IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_VERSION),
  ticket_id: ticketId,
  repository,
  plan_path: relativePosixPath,
  plan_sha256: digest,
  base_sha: revision,
  ticket_revision: revision,
  epic: ImplementationPlanManifestV2EpicSchema,
  hard_dependencies: boundedArray(ImplementationPlanManifestV2HardDependencySchema, L.maxHardDependencies),
  predecessor_outputs: boundedArray(ImplementationPlanManifestV2PredecessorOutputSchema, L.maxPredecessorOutputs),
  soft_dependencies: boundedArray(ImplementationPlanManifestV2SoftDependencySchema, L.maxSoftDependencies),
  rows: boundedArray(ImplementationPlanManifestV2AcceptanceRowSchema, L.maxRows, L.minRequiredArrayItems),
  portfolio: ImplementationPlanManifestV2PortfolioSchema,
  ownership: ImplementationPlanManifestV2OwnershipSchema,
  compatibility: ImplementationPlanManifestV2CompatibilitySchema,
  staleness: ImplementationPlanManifestV2StalenessSchema,
  just_in_time_revalidation: ImplementationPlanManifestV2RevalidationSchema,
}, {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: IMPLEMENTATION_PLAN_MANIFEST_V2_SCHEMA_ID,
  title: "Implementation Plan Manifest v2",
  additionalProperties: false,
});

const compiledSchema = Compile(ImplementationPlanManifestV2Schema);
const issue = (code, message, path = "") => ({ code, message, path });

/** Structural validation only; cross-file and Git-object semantics are Slice 3. */
export function validateImplementationPlanManifestV2(manifest) {
  const errors = [...compiledSchema.Errors(manifest)].map((error) => issue("schema_invalid", error.message, error.path));
  return { ok: errors.length === 0, errors };
}

export function assertImplementationPlanManifestV2(manifest) {
  const result = validateImplementationPlanManifestV2(manifest);
  if (!result.ok) throw new TypeError(`Implementation Plan Manifest v2 validation failed: ${result.errors.map((error) => error.path).join(", ")}`);
  return manifest;
}

export const ImplementationPlanManifestV2 = ImplementationPlanManifestV2Schema;
export default ImplementationPlanManifestV2Schema;
