/**
 * Pure Git pre-push protocol and lifecycle normalization.
 *
 * The protected trusted-base CI validator is the authoritative evidence gate.
 * This module only models hook input and returns fail-closed states; the
 * pre-push hook is optional early feedback and has no approval, publication,
 * push, or merge authority.
 */

export const MAX_STDIN_BYTES = 64 * 1024;
export const MAX_REF_BYTES = 1024;
export const MAX_BRANCH_BYTES = 256;
export const SHA_WIDTHS = Object.freeze([40, 64]);
export const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const ZERO_SHA = /^0{40}$|^0{64}$/;
export const DELETE_REF = "(delete)";

export const PRE_PUSH_KINDS = Object.freeze({
  CREATE: "create",
  UPDATE: "update",
  DELETION: "deletion",
  IGNORED: "ignored-non-ticket-destination",
  INVALID: "invalid",
});

export const PRE_PUSH_PR_STATES = Object.freeze({
  EXISTING: "existing-pr",
  VERIFIED_ABSENT: "verified-absent-pr",
  LOOKUP_FAILURE: "pr-lookup-failure",
});

export const PRE_PUSH_LIFECYCLE_KINDS = Object.freeze({
  DELETION: "deletion",
  IGNORED: "ignored-non-ticket-destination",
  EXISTING_PR: "existing-pr",
  INITIAL_PUBLICATION: "initial-publication",
  NO_PR_UPDATE: "no-pr-update",
  PR_LOOKUP_FAILURE: "pr-lookup-failure",
  INVALID: "invalid-lifecycle",
});

/**
 * Protocol state table:
 *
 * | kind | local SHA/ref | remote destination/SHA | candidate/evidence |
 * | create | exact non-zero SHA and ordinary ref or HEAD | refs/heads/<branch> and zero SHA | exact local commit, then trusted policy/evidence |
 * | update | exact non-zero SHA and ordinary ref or HEAD | refs/heads/<branch> and exact non-zero SHA | exact local commit, then trusted policy/evidence |
 * | deletion | zero SHA and literal (delete) | refs/heads/<branch> and exact non-zero SHA | no candidate or evidence |
 * | ignored | valid non-deletion update | non-branch destination | no candidate or evidence |
 * | invalid | any malformed/ambiguous tuple | any malformed/ambiguous tuple | fail closed |
 *
 * A refs/heads destination remains a create/update candidate until the
 * lifecycle classifier applies the PR state and trusted-base branch policy.
 * `oldSha` is protocol metadata only: the hook never assumes that a remote
 * tip object is present in the local object database.
 */
export const PRE_PUSH_STATE_TABLE = Object.freeze([
  Object.freeze({ kind: PRE_PUSH_KINDS.CREATE, local: "non-zero exact repository-width SHA + ref/HEAD", remote: "refs/heads/<branch> + repository-width zero SHA", action: "validate exact local commit; classify lifecycle" }),
  Object.freeze({ kind: PRE_PUSH_KINDS.UPDATE, local: "non-zero exact repository-width SHA + ref/HEAD", remote: "refs/heads/<branch> + non-zero exact repository-width SHA", action: "validate exact local commit; classify lifecycle" }),
  Object.freeze({ kind: PRE_PUSH_KINDS.DELETION, local: "repository-width zero SHA + (delete)", remote: "refs/heads/<branch> + non-zero exact repository-width SHA", action: "skip candidate/evidence validation" }),
  Object.freeze({ kind: PRE_PUSH_KINDS.IGNORED, local: "valid non-deletion tuple", remote: "non-branch destination", action: "skip candidate/evidence validation" }),
  Object.freeze({ kind: PRE_PUSH_KINDS.INVALID, local: "malformed/mixed-width/ambiguous", remote: "malformed/mixed-width/ambiguous", action: "fail closed" }),
]);

/**
 * Lifecycle state table, applied only after protocol normalization:
 *
 * | lifecycle | precondition | action |
 * | deletion | valid deletion tuple | allow ref deletion without evidence |
 * | ignored-non-ticket-destination | non-branch destination or trusted non-ticket PR branch | allow without evidence |
 * | existing-pr | PR lookup is an existing, well-shaped PR | require trusted policy/evidence validation |
 * | initial-publication | PR absence is explicitly verified and tuple is a genuine create | allow only to bootstrap PR creation; make no approval claim |
 * | no-pr-update | PR absence is explicitly verified and tuple updates an existing branch | fail closed |
 * | pr-lookup-failure | lookup unavailable, malformed, or ambiguous | fail closed |
 */
export const PRE_PUSH_LIFECYCLE_TABLE = Object.freeze([
  Object.freeze({ kind: PRE_PUSH_LIFECYCLE_KINDS.DELETION, precondition: "valid deletion tuple", action: "allow deletion without candidate/evidence validation" }),
  Object.freeze({ kind: PRE_PUSH_LIFECYCLE_KINDS.IGNORED, precondition: "non-branch destination or trusted non-ticket branch", action: "allow without candidate/evidence validation" }),
  Object.freeze({ kind: PRE_PUSH_LIFECYCLE_KINDS.EXISTING_PR, precondition: "existing exact PR", action: "require trusted policy and evidence validation" }),
  Object.freeze({ kind: PRE_PUSH_LIFECYCLE_KINDS.INITIAL_PUBLICATION, precondition: "verified-absent PR + genuine branch create", action: "allow only to bootstrap PR creation; emit no approval claim" }),
  Object.freeze({ kind: PRE_PUSH_LIFECYCLE_KINDS.NO_PR_UPDATE, precondition: "verified-absent PR + existing branch update", action: "fail closed" }),
  Object.freeze({ kind: PRE_PUSH_LIFECYCLE_KINDS.PR_LOOKUP_FAILURE, precondition: "unavailable, malformed, or ambiguous lookup", action: "fail closed" }),
  Object.freeze({ kind: PRE_PUSH_LIFECYCLE_KINDS.INVALID, precondition: "unsupported lifecycle input", action: "fail closed" }),
]);

function invalid(line, reason) {
  return Object.freeze({ kind: PRE_PUSH_KINDS.INVALID, line, reason });
}
function lifecycle(update, kind, reason) {
  return Object.freeze({ ...update, kind, ...(reason ? { reason } : {}) });
}
function bounded(value, label, maximum) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0") || !value) throw new Error(`${label} is missing or exceeds its bound`);
  return value;
}
function resolveShaWidth(value) {
  if (value === undefined || value === null) return null;
  if (value === "sha1") return 40;
  if (value === "sha256") return 64;
  if (SHA_WIDTHS.includes(value)) return value;
  return -1;
}
function shaHasWidth(value, width = null) {
  return SHA.test(value) && (width === null || value.length === width);
}
function zeroSha(value, width = null) {
  return shaHasWidth(value, width) && /^0+$/.test(value);
}
function defaultRefValidator(value, label, { allowHead = false } = {}) {
  const ref = bounded(value, label, MAX_REF_BYTES);
  if (allowHead && ref === "HEAD") return ref;
  if (!ref.startsWith("refs/") || ref === "refs/" || ref === "@" || ref.includes("..") || ref.includes("//") || ref.includes("@{") || ref.endsWith("/") || ref.endsWith(".") || /[\u0000-\u0020~^:?*[\\\]]/.test(ref)) throw new Error(`${label} is malformed`);
  return ref;
}
function ref(refValidator, value, label, options = {}) {
  return refValidator(value, label, options);
}
function normalizedLine(line, lineNumber, refValidator, expectedWidth) {
  if (!line || !line.trim()) return invalid(lineNumber, "pre-push input contains a blank ref line");
  if (line.includes("\0")) return invalid(lineNumber, "pre-push input contains an unsupported NUL byte");
  if (/^[\t ]|[\t ]$|[\t ]{2,}/.test(line)) return invalid(lineNumber, "pre-push input contains non-canonical field spacing");
  const parts = line.split(" ");
  if (parts.length !== 4 || parts.some((part) => !part)) return invalid(lineNumber, "pre-push input contains a malformed four-field ref line");
  const [localRef, localSha, remoteRef, remoteSha] = parts;

  // Width binding occurs before local-ref validation, state classification, or
  // the deletion exemption. A 40/64 mixed tuple is never a deletion.
  if (!shaHasWidth(localSha) || !shaHasWidth(remoteSha)) return invalid(lineNumber, "pre-push input contains an invalid or ambiguous SHA");
  if (localSha.length !== remoteSha.length) return invalid(lineNumber, "pre-push input mixes SHA-1 and SHA-256 widths");
  if (expectedWidth !== null && localSha.length !== expectedWidth) return invalid(lineNumber, "pre-push SHA width does not match this repository object format");

  const localDeletion = zeroSha(localSha, expectedWidth ?? localSha.length);
  const remoteDeletion = zeroSha(remoteSha, expectedWidth ?? remoteSha.length);
  let validatedRemoteRef;
  try {
    validatedRemoteRef = ref(refValidator, remoteRef, "remote ref");
  } catch {
    return invalid(lineNumber, "pre-push input contains an invalid remote ref");
  }

  // Classify deletion only after both SHA widths are proven identical and
  // bound to the repository object format.
  if (localDeletion) {
    if (localRef !== DELETE_REF) return invalid(lineNumber, "pre-push deletion contains an invalid local ref");
    if (remoteDeletion) return invalid(lineNumber, "pre-push deletion requires a non-zero remote commit SHA");
    if (!validatedRemoteRef.startsWith("refs/heads/")) return invalid(lineNumber, "pre-push deletion must target a remote branch");
    let branch;
    try { branch = bounded(validatedRemoteRef.slice("refs/heads/".length), "remote branch", MAX_BRANCH_BYTES); } catch {
      return invalid(lineNumber, "pre-push deletion contains an invalid remote branch");
    }
    return Object.freeze({
      kind: PRE_PUSH_KINDS.DELETION, line: lineNumber, localRef, newSha: null, oldSha: remoteSha,
      remoteRef: validatedRemoteRef, branch,
    });
  }

  try {
    ref(refValidator, localRef, "local ref", { allowHead: true });
  } catch {
    return invalid(lineNumber, "pre-push input contains an invalid local ref");
  }

  if (!validatedRemoteRef.startsWith("refs/heads/")) {
    return Object.freeze({
      kind: PRE_PUSH_KINDS.IGNORED, reason: "non-ticket destination", line: lineNumber,
      localRef, newSha: localSha, oldSha: remoteSha, remoteRef: validatedRemoteRef,
    });
  }

  let branch;
  try { branch = bounded(validatedRemoteRef.slice("refs/heads/".length), "remote branch", MAX_BRANCH_BYTES); } catch {
    return invalid(lineNumber, "pre-push input contains an invalid remote branch");
  }
  return Object.freeze({
    kind: remoteDeletion ? PRE_PUSH_KINDS.CREATE : PRE_PUSH_KINDS.UPDATE,
    line: lineNumber, localRef, newSha: localSha, oldSha: remoteSha,
    remoteRef: validatedRemoteRef, branch,
  });
}

/** Normalize all four-field pre-push lines without resolving any Git object. */
export function normalizePrePushInput(input, { validateRef = defaultRefValidator, shaWidth = null, objectFormat = undefined } = {}) {
  const expectedWidth = resolveShaWidth(objectFormat ?? shaWidth);
  if (expectedWidth === -1) return { hasInput: true, updates: [invalid(0, "pre-push object format is unsupported")] };
  let bytes;
  if (Buffer.isBuffer(input)) bytes = input;
  else if (typeof input === "string") bytes = Buffer.from(input, "utf8");
  else return { hasInput: true, updates: [invalid(0, "pre-push ref input is not text or bytes")] };
  if (bytes.length > MAX_STDIN_BYTES) return { hasInput: true, updates: [invalid(0, "pre-push input exceeds its fixed bound")] };
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) return { hasInput: true, updates: [invalid(0, "pre-push ref input is not valid UTF-8")] };
  if (decoded.length === 0) return { hasInput: false, updates: [] };
  const lines = decoded.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const updates = lines.map((line, index) => normalizedLine(line, index + 1, validateRef, expectedWidth));
  const destinations = new Set();
  const unambiguousUpdates = updates.map((update) => {
    if (update.kind === PRE_PUSH_KINDS.INVALID || !update.remoteRef) return update;
    if (destinations.has(update.remoteRef)) return invalid(update.line, "pre-push input contains duplicate remote destinations");
    destinations.add(update.remoteRef);
    return update;
  });
  return { hasInput: true, updates: unambiguousUpdates };
}

/** Apply a trusted-base branch-policy classifier to a parsed candidate. */
export function classifyTrustedDestination(update, isTicketDestination) {
  if (!update || update.kind === PRE_PUSH_KINDS.INVALID || update.kind === PRE_PUSH_KINDS.DELETION || update.kind === PRE_PUSH_KINDS.IGNORED) return update;
  if (typeof isTicketDestination !== "function") throw new Error("trusted destination classifier is required");
  if (isTicketDestination(update.branch)) return update;
  return Object.freeze({ ...update, kind: PRE_PUSH_KINDS.IGNORED, reason: "non-ticket destination" });
}

/** Apply explicit PR lookup/lifecycle policy after protocol normalization. */
export function classifyPrePushLifecycle(update, { prStatus, prReason, isTicketDestination } = {}) {
  if (!update || update.kind === PRE_PUSH_KINDS.INVALID) return lifecycle(update ?? {}, PRE_PUSH_LIFECYCLE_KINDS.INVALID, "pre-push protocol state is invalid");
  if (update.kind === PRE_PUSH_KINDS.DELETION) return lifecycle(update, PRE_PUSH_LIFECYCLE_KINDS.DELETION);
  if (update.kind === PRE_PUSH_KINDS.IGNORED) return lifecycle(update, PRE_PUSH_LIFECYCLE_KINDS.IGNORED, update.reason);
  if (update.kind !== PRE_PUSH_KINDS.CREATE && update.kind !== PRE_PUSH_KINDS.UPDATE) return lifecycle(update, PRE_PUSH_LIFECYCLE_KINDS.INVALID, "pre-push protocol state is unsupported");

  if (prStatus === PRE_PUSH_PR_STATES.VERIFIED_ABSENT) {
    return update.kind === PRE_PUSH_KINDS.CREATE
      ? lifecycle(update, PRE_PUSH_LIFECYCLE_KINDS.INITIAL_PUBLICATION)
      : lifecycle(update, PRE_PUSH_LIFECYCLE_KINDS.NO_PR_UPDATE, "GitHub PR is verified absent for an existing branch update");
  }
  if (prStatus !== PRE_PUSH_PR_STATES.EXISTING) return lifecycle(update, PRE_PUSH_LIFECYCLE_KINDS.PR_LOOKUP_FAILURE, prReason ?? "GitHub PR lookup was unavailable, malformed, or ambiguous");

  let classified;
  try { classified = classifyTrustedDestination(update, isTicketDestination); } catch {
    return lifecycle(update, PRE_PUSH_LIFECYCLE_KINDS.PR_LOOKUP_FAILURE, "trusted destination policy could not be classified");
  }
  if (classified.kind === PRE_PUSH_KINDS.IGNORED) return lifecycle(classified, PRE_PUSH_LIFECYCLE_KINDS.IGNORED, classified.reason);
  return lifecycle(classified, PRE_PUSH_LIFECYCLE_KINDS.EXISTING_PR);
}
