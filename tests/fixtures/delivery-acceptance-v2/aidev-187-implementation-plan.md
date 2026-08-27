# AIDEV-187 implementation plan — model-neutral delivery policy and successor interfaces

## Binding, outcome, and boundary

Implement GitHub issue 54 / AIDEV-187 at trusted base `3d858a0d4f8219f5ca1db13ad1de72e35ee09758`, ticket revision `08967f81071a97e0fa0adb2430906e04fd448413ad41546e6f0b19fa5d24f5d4`, repository `Zkrausman/pi-sampler`. Deliver exact-base model-neutral role configuration/resolution, additive non-authoritative packet-v4/receipt-v2/marker-v4 interfaces, frozen legacy readers, model-neutral durable names, and an opaque fail-closed context-admission consumer boundary.

AIDEV-187 does not implement signing, key custody, replay, primary/recovery authority, readiness, activation/rollback, break-glass, or Squire/Herdr orchestration. AIDEV-190 owns that subsystem. AIDEV-166 remains downstream through AIDEV-190. Packet v3, receipt v1, marker v3, and the current v3 publication gate remain authoritative. Planning grants no implementation, commit, push, PR/tracker mutation, publication, merge, or cleanup authority.

## 1. Exact model-neutral role policy

### 1.1 Schema, catalogs, and profile admission

Slice 1 adds optional `delivery.rolePolicy` only to `profiles/project-profile.schema.json`; it does not configure the current profile. The policy has `additionalProperties:false` and exact root keys `format`, `version`, `assignments`, `roles`; format/version are `pi-sampler.delivery-role-policy` / `1`.

Assignments contain 1–32 unique IDs matching `[a-z0-9][a-z0-9-]{0,63}` and 1–4 unique roles from `planner|implementer|primary-reviewer|final-reviewer`.

* Manual planner is exactly `{"id","roles":["planner"],"backend":"external-manual","mode":"manual-antigravity","label":"Gemini","effort":"high"}`. It has no Pi provider/model/thinking/profile fields.
* Pi assignment is exactly `{"id","roles","backend":"pi","provider":"openai-codex","model","thinking","profile"}`. Models are `gpt-5.6-luna|gpt-5.6-sol|gpt-5.6-terra`; thinking is `medium|high|xhigh`.

Profile-to-role admission is exact:

| Profile | Sole admitted role |
|---|---|
| `implementation-planner-v1` | `planner` |
| `project-delivery-v1` | `implementer` |
| `project-code-review-v1` | `primary-reviewer` |
| `final-review-v2` | `final-reviewer` |

A Pi assignment may list only its profile's sole role. `roles` has exact keys `planner`, `implementer`, `primaryReviewer`, `finalReviewer`; each is `{"selected","fallbacks","allowedOverrides"}`. References must exist and role-match. Fallbacks are ordered, unique, maximum 8, exclude selected; overrides are unique, maximum 8, include selected. Policy limits are 64 KiB canonical bytes, depth 8, 512 nodes, 32 assignments, 8 fallbacks/overrides per role, and 2048 UTF-8 bytes per string.

### 1.2 Canonicalization, digest, and trusted loading

Slice 2 adds self-contained `contracts/delivery-role-policy-v1.mjs`; `scripts/review-policy.mjs` remains unchanged. Exports are `DeliveryRolePolicyV1`, `normalizeDeliveryRolePolicyV1`, `serializeDeliveryRolePolicyV1`, `deliveryRolePolicySha256V1`, `loadTrustedDeliveryRolePolicy`, and `resolveDeliveryRoleAssignment`.

Normalization recursively sorts object keys, sorts assignment IDs and set-valued arrays, and preserves fallback order. Serialization is compact UTF-8 JSON with no BOM or newline. Digest is SHA-256 of `UTF8("pi-sampler.delivery-role-policy/v1\0") || canonicalBytes`, lowercase 64 hex. Golden bytes/digests are identical on Windows and Linux.

`loadTrustedDeliveryRolePolicy({repo,baseSha})` resolves one exact commit and reads only `baseSha:profiles/project-profile.schema.json` and `baseSha:profiles/pi-sampler.json` from Git objects. No profile/path/loader/candidate/callback option exists. Ambient HEAD, worktree files, CLI/env/prompt/pane/evidence cannot select policy. Missing policy returns `role_policy_unspecified`; malformed/bounded-invalid policy returns `role_policy_invalid`; unsupported catalog values return `role_provider_not_catalogued`, `role_model_not_catalogued`, `role_thinking_not_catalogued`, or `role_profile_not_catalogued`.

### 1.3 Exact resolution and diagnostic precedence

`resolveDeliveryRoleAssignment({trustedPolicy,role,operatorOverrideId,availability})` accepts only the branded normalized result of the trusted loader or test-only contract parser. The deterministic order is:

1. Require branded policy; absent returns `role_policy_unspecified`.
2. Validate bounds/exact keys/references/catalogs, then profile-to-role admission, in JSON pointer lexical order; first error wins.
3. Validate role enum (`role_invalid`).
4. If override is non-null, validate ID syntax then allowlist membership; failure is `role_override_not_allowed` before inspecting availability.
5. Construct considered assignments: without override, `[selected,...fallbacks]`; with allowlisted override, `[override,...fallbacks excluding override]`. No implicit selected entry is added in override mode. IDs are de-duplicated while preserving this order.
6. Require availability to be an exact object whose lexically sorted keys equal the considered set—no missing/extra keys—and whose values are `available|unavailable`; otherwise `role_availability_invalid`.
7. Select the first available considered assignment; exhaustion returns `role_unavailable`.

Success is exact `{"ok":true,"role","assignment","source","fallbackIndex","rolePolicySha256"}`, where `assignment` is the selected assignment ID string. `source` is `selected|operator-override|fallback`. `fallbackIndex` is JSON `null` for selected/override and is the zero-based index in the role's original `fallbacks` array for fallback success, including override mode after exclusions. No field is optional.

Golden envelopes use the literal fixture digest `dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd` and are complete:

| Case | Exact envelope |
|---|---|
| selected | `{"ok":true,"role":"planner","assignment":"manual-gemini-planner","source":"selected","fallbackIndex":null,"rolePolicySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}` |
| allowlisted override | `{"ok":true,"role":"planner","assignment":"terra-codex-planner","source":"operator-override","fallbackIndex":null,"rolePolicySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}` |
| fallback position 0 | `{"ok":true,"role":"planner","assignment":"terra-codex-planner","source":"fallback","fallbackIndex":0,"rolePolicySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}` |
| fallback position 1 | `{"ok":true,"role":"planner","assignment":"sol-codex-planner","source":"fallback","fallbackIndex":1,"rolePolicySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}` |
| malformed availability | `{"ok":false,"code":"role_availability_invalid"}` |
| nonallowed override | `{"ok":false,"code":"role_override_not_allowed"}` |
| unsupported model fixture | `{"ok":false,"code":"role_model_not_catalogued"}` |
| exhausted | `{"ok":false,"code":"role_unavailable"}` |
| missing policy | `{"ok":false,"code":"role_policy_unspecified"}` |

Slice 3 configures manual Gemini / Luna / Sol / Sol. Planner fallbacks are Terra then Sol; implementer fallback is Sol; reviewer fallbacks are empty; allowlists contain selected plus role fallbacks. `terra-codex-planner.json` directly selects Terra with no override and expects `source:"selected"`. `same-model-separate-contexts.json` uses role-admitted Sol assignments for all roles; policy validation performs no model-inequality check and makes no context-independence claim.

## 2. Executable opaque context-reference boundary

### 2.1 Input and reference contract

Slice 2 adds `contracts/trusted-context-admission-reference-v1.mjs` and generated schema. The only consumer API is:

`consumeTrustedContextAdmissionReference({repo,baseSha,referenceBytes,expected})`

The argument object has exactly those four keys. `referenceBytes` must be a `Uint8Array`/Buffer containing the original UTF-8 bytes, 1–16384 bytes. Strings, parsed objects, callbacks, providers, authority/results, extra keys, BOM, NUL, invalid UTF-8, duplicate keys, trailing bytes, and noncanonical JSON are rejected. Canonical JSON is compact recursive sorted-key UTF-8 with no newline.

The reference has exact keys `format`, `version`, `authorityContract`, `authorityContractDigest`, `assertionDigest`, `repository`, `pullRequest`, `base`, `head`, `rolePolicySha256`, `contextSetDigest`. Format/version are `pi-sampler.trusted-context-admission-reference` / 1; authority contract is `pi-sampler.trusted-context-admission/v1`; digests are lowercase 64 hex; commits are 40 or 64 lowercase hex; repository matches the receipt-v1 repository bound; PR is `[1-9][0-9]{0,30}`. Reference digest is SHA-256 of `UTF8("pi-sampler.trusted-context-admission-reference/v1\0") || canonicalReferenceBytes`.

`expected` has exactly `repository`, `pullRequest`, `base`, `head`, `rolePolicySha256`, `contextSetDigest`, with identical types/bounds. Processing precedence is: API exact shape/type → byte bound/UTF-8/BOM/NUL → strict JSON duplicate/trailing parse → exact keys/schema/constants → canonical byte equality → reference digest → expected exact shape → comparisons in expected key order shown above → trusted provider dispatch. Structural/binding failures are exact `{"ok":false,"code":"<stable-code>","referenceSha256":null|string}` with no extra keys. Codes are `context_admission_input_invalid`, `context_admission_encoding_invalid`, `context_admission_json_invalid`, `context_admission_self_asserted`, `context_admission_reference_invalid`, `context_admission_noncanonical`, and `context_admission_binding_mismatch`.

After strict parse but before generic exact-key rejection, presence of `callerId`, `sessionId`, `lineage`, `fresh`, issuer/key/signature, nonce, provider, authority, or result fields returns `context_admission_self_asserted`; every other unknown key returns `context_admission_reference_invalid`. Neither can produce admission.

### 2.2 Fixed trusted-base provider dispatch and frozen provider-v1 API

The fixed dispatch record path is `contracts/trusted-context-admission-provider-v1.json`. Both states have exact keys `format`, `version`, `status`, `providerContract`, `providerContractDigest`, `modulePath`, and `moduleSha256`. AIDEV-187 commits only this canonical unavailable record:

```json
{"format":"pi-sampler.trusted-context-admission-provider-dispatch","modulePath":null,"moduleSha256":null,"providerContract":"pi-sampler.trusted-context-admission-provider/v1","providerContractDigest":null,"status":"unavailable","version":1}
```

The only loader is `loadTrustedContextAdmissionProvider({repo,baseSha})`. It resolves exact `baseSha`, reads that fixed record from Git objects, checks compact recursive sorted-key bytes and exact fields, and returns `{"ok":false,"code":"context_admission_unavailable","providerContract":"pi-sampler.trusted-context-admission-provider/v1","providerContractDigest":null}`. After a valid reference, `consume…` returns exact `{"ok":false,"code":"context_admission_unavailable","referenceSha256":"<64-hex>","providerContract":"pi-sampler.trusted-context-admission-provider/v1","providerContractDigest":null}`. It does not import or invoke a module in the unavailable state.

The future available record is frozen now, although only AIDEV-190 may create it: status `available`; provider contract unchanged; `providerContractDigest` is the 64-hex digest of the canonical provider-v1 interface descriptor exported by the exact-base reference contract; `modulePath` is exactly `scripts/trusted-context-admission-provider.mjs`; `moduleSha256` is the 64-hex SHA-256 of that exact-base module blob. Null/non-null combinations or extra keys return `context_admission_dispatch_invalid`.

The available module namespace must have the required named export `admitTrustedContextReferenceV1`; the consumer calls exactly `await admitTrustedContextReferenceV1(request, abortSignal)`. `abortSignal` is controller-created and aborts at 5000 ms; callers cannot supply it. `request` has no extras and exact keys:

`format,version,trustedProviderBaseSha,repository,pullRequest,base,head,rolePolicySha256,contextSetDigest,referenceSha256,referenceBytesBase64Url`.

Format/version are `pi-sampler.trusted-context-admission-provider-request` / 1. Every field is copied from the already validated canonical reference/expected values except `trustedProviderBaseSha` (the loader's exact commit), `referenceSha256` (the computed digest), and `referenceBytesBase64Url` (canonical unpadded base64url of the 1–16384 reference bytes). Request canonical JSON is at most 32768 bytes; commits/repository/PR/digests retain Section 2.1 bounds. No path, callback, candidate object, caller identity, authority handle, or unvalidated value enters it.

Provider result has `additionalProperties:false`, canonical size at most 16384 bytes, and exact keys `format`, `version`, `status`, `code`, `referenceSha256`, `providerContractDigest`, `admissionDigest`. Format/version are `pi-sampler.trusted-context-admission-provider-result` / 1; both digests are 64 hex when non-null and result reference digest must equal request. Admitted is exactly status `admitted`, code `context_admitted`, and admissionDigest equal to the structurally validated reference's `assertionDigest`. Blocked is status `blocked`, null admissionDigest, and code exactly one of `context_admission_invalid`, `context_admission_expired`, `context_admission_replayed`, `context_admission_authority_unavailable`, or `context_admission_internal_blocked`. Provider contract digest is always non-null and equals dispatch.

Available dispatch precedence is: validate dispatch bytes/contract digest → read fixed module path as one regular 100644/100755 Git blob no larger than 128 KiB → verify blob SHA-256 → verify the executing clean exact-base file is byte-identical → start one dedicated Node worker at the fixed file URL with candidate/env module resolution disabled → import and require callable named export → construct/freeze request → invoke once with a worker-created AbortSignal → enforce 5000 ms in the parent and terminate on timeout → validate bounded result/exact keys/digests. Worker stdout/stderr are private bounded pipes (16384 bytes each); any provider output or overflow is `context_admission_provider_result_invalid` and is never copied to public evidence. Stable consumer failures are `context_admission_dispatch_invalid`, `context_admission_provider_blob_invalid`, `context_admission_provider_import_failed`, `context_admission_provider_export_invalid`, `context_admission_provider_timeout`, and `context_admission_provider_result_invalid`; thrown/rejected values map to `context_admission_internal_blocked` without echoing them. Structural/reference errors from Section 2.1 precede all dispatch errors. No caller-supplied provider/module/callback/authority/result exists.

`tests/fixtures/context-admission-reference/provider-v1-interface-vectors.json` freezes unavailable and hypothetical available dispatch records, one complete request, one admitted result, every blocked result, timeout/malformed cases, and the AIDEV-190 interface descriptor digest. AIDEV-187 never supplies the available module or an admitted result; AIDEV-190 implements authority behavior behind this unchanged API.

## 3. Frozen successor mappings

### 3.1 Packet v3 → packet v4

Packet v3 has no repository or PR field. Repository/PR remain bound by receipt v2 and the review controller/marker-render expected inputs, not packet v4. Nested `changedFile`, `patch`, `hunk`, and `logicalLine` schemas and all v3 bounds remain unchanged.

Packet v4 root has `additionalProperties:false` and this exact serialized key order:

| Order | v4 key | Required | v3 disposition / bound |
|---:|---|---|---|
| 1 | `format` | yes | replaces constant with `pi-sampler.scoped-review-packet.v4` |
| 2–10 | `base`, `head`, `changedFiles`, `diffStat`, `patches`, `incomplete`, `omittedHunks`, `byteTruncatedHunks`, `immutableMaterial` | yes | unchanged types/semantics/order; commits 40/64 hex; files/patches 200; stat 32768; incomplete false; three arrays max 0 |
| 11 | `rolePolicySha256` | yes | new lowercase 64-hex trusted exact-base policy digest |
| 12 | `contextAdmissionReferenceSha256` | yes | new lowercase 64-hex opaque reference digest |
| 13 | `validationEvidence` | no | v3 optional field unchanged, 1–4096 chars |

Nested bounds remain: path 1–240; hunk header 1–1024; hunks 1–64; logical lines 1–65536; segments 1–64 of 1–4096; byteLength 1–65536; line digest 64 hex. Runtime bounds remain 200 files, 64 KiB hunk, 128 KiB patch, 768 KiB patches, 1 MiB packet, and 4096-byte physical lines.

Endpoint blob admission exactly preserves frozen v3 behavior. Every ordinary endpoint blob is at most 131072 bytes. The sole exception is the exact repository-root path `package-lock.json`: only when its endpoint size exceeds 131072 may it be at most 524288 bytes, and then its UTF-8 text must pass unchanged `validateOversizedPackageLockfile` semantics from `scripts/package-lock-admission.mjs`: JSON object with only sorted top-level keys `lockfileVersion,name,packages,requires,version`; lockfileVersion 3; requires true; bounded nonempty packages with root entry; canonical `${JSON.stringify(value,null,2)}\n` bytes; matching root/top name/version; and every package entry accepted by the existing validation modules. Size 524289 rejects before reading; malformed oversized root rejects; `.hidden/package-lock.json`, `nested/package-lock.json`, and every non-exact path remain ordinary 131072-byte endpoints. A root lockfile at or below 131072 follows ordinary v3 text admission, exactly as frozen v3 does. Packet v4 imports/reuses this additive contract behavior without changing v3 files.

`tests/fixtures/review-compatibility/packet-package-lock-parity-cases.json` freezes generated Git endpoint recipes and exact v3/v4 outcomes:

| Case | Exact outcome |
|---|---|
| canonical root `package-lock.json`, 524288 bytes | admitted |
| root, 524289 bytes | reject `package-lock.json exceeds 524288 bytes` |
| malformed-JSON root, 131073 bytes | reject `package-lock.json is not supported canonical npm lockfile JSON` |
| `.hidden/package-lock.json`, 131073 bytes | reject `.hidden/package-lock.json exceeds 131072 bytes` |
| `nested/package-lock.json`, 131073 bytes | reject `nested/package-lock.json exceeds 131072 bytes` |
| ordinary `src/large.txt`, 131072 bytes | admitted |
| ordinary `src/large.txt`, 131073 bytes | reject `src/large.txt exceeds 131072 bytes` |

Tests generate exact committed blobs from the recipe, run frozen v3 and additive v4, and require identical outcomes/messages.

`serializeReviewPacketV4` uses the table order, nested v3 order, two-space JSON, and exactly one trailing LF. `reviewPacketSha256V4 = SHA256(UTF8("pi-sampler.scoped-review-packet/v4\0") || serializedBytes)`. V3 serialization/digest remains unchanged. Structural v4 validation can pass; publication returns `successor_not_activated`.

### 3.2 Receipt v1 → receipt v2

Receipt v2 retains format `pi-sampler.final-review-receipt`, changes version to 2, has `additionalProperties:false`, and the following exact root key set (source order is nonsemantic because canonicalization sorts keys):

| v2 root key | Required | Disposition / bound |
|---|---|---|
| `format`,`version` | yes | same format; version 2 |
| `repository`,`pullRequest`,`nonce`,`base`,`head` | yes | unchanged v1 patterns/bounds (repository 256, PR 32, nonce 32–128 hex, commit 40/64) |
| `packetSha256`,`acceptanceMatrixSha256`,`verificationEvidenceSha256` | yes | unchanged 64-hex latest-pass bindings |
| `rolePolicySha256`,`contextAdmissionReferenceSha256` | yes | new 64-hex latest-pass bindings |
| `reviewRole` | yes | constant `final-reviewer` |
| `reviewAssignmentId` | yes | `[a-z0-9][a-z0-9-]{0,63}` |
| `reviewProfile` | yes | constant `final-review-v2` |
| `reviewerModelId`,`reviewProfileVersion` | yes | retained maintainer-attested provenance; model enum is exactly `openai-codex/gpt-5.6-sol|openai-codex/gpt-5.6-terra` (1–128 chars) and profile enum is exactly `terra-final-v1` (1–64 chars); neither is security proof |
| `outcome`,`lifecycle`,`revocation`,`receiptSha256` | yes | unchanged v1 semantics; digest rule below |

`lifecycle` exact keys remain `lineageId,fresh,correctionCount,passes`; fresh is true, correctionCount 0–2, passes 1–3. Every v2 pass has exactly these keys:

`index,kind,lineageId,base,head,packetSha256,acceptanceMatrixSha256,verificationEvidenceSha256,rolePolicySha256,contextAdmissionReferenceSha256,outcome,blockerCount,highCount,recordedAt`.

All v1 pass bounds and correction/lineage/chronology rules remain. Both new digests are required in every pass; each must equal the receipt root and every other pass. A policy/context change therefore requires a new fresh receipt, never a mixed-policy correction lineage. Root latest packet/matrix/evidence plus both new digests equal the latest pass.

Revocation exact keys/values remain `revoked,reason,source,recordedAt`; source remains `final-child|terra-parent|head-change|operator|validation|null`, with `terra-parent` explicitly a frozen compatibility value. Receipt size remains 128 KiB; depth 16; nodes 4096; strings 64 KiB; findings 128; passes 3.

`canonicalReceiptV2Payload` is compact recursive sorted-key JSON of the complete receipt excluding `receiptSha256`, no newline. `receiptSha256V2 = SHA256(UTF8("pi-sampler.final-review-receipt/v2\0") || payloadBytes)`. V1 raw digest behavior is unchanged.

### 3.3 Marker v3 → marker v4

V3 grammar is exactly one `<!-- pi-sampler-adversarial-review-attestation:v3 {compact JSON} -->` marker, body maximum 24 KiB and captured payload maximum 4096 characters. V3 exact JSON keys are `format,version,base,head,outcome,packetSha256,acceptanceMatrixSha256,verificationEvidenceSha256,reviewerModelId,reviewProfileVersion,receiptSha256`; it has no repository, PR, or revocation fields.

V4 grammar is exactly one `<!-- pi-sampler-adversarial-review-attestation:v4 {compact JSON} -->`, ASCII single spaces around compact JSON, no CR/LF inside marker, same body/payload bounds. `JSON.stringify` uses this exact insertion order and no extra keys:

`format,version,base,head,outcome,packetSha256,acceptanceMatrixSha256,verificationEvidenceSha256,rolePolicySha256,contextAdmissionReferenceSha256,reviewRole,reviewAssignmentId,reviewProfile,reviewerModelId,reviewProfileVersion,receiptSha256`.

Constants are format `pi-sampler.adversarial-review-attestation`, version 4, outcome `clean`, role `final-reviewer`; all digests are 64 hex and provenance bounds match receipt v2. Marker has no separate marker digest: canonical marker bytes bind `receiptSha256`; receipt v2 supplies the domain-separated digest. Rendering/validation still requires exact repository/PR/base/head inputs and verifies repository/PR through the local receipt, as v3 does. V4 publication returns `successor_not_activated`.

### 3.4 Immutable dispatch and legacy coexistence

`parseReviewArtifactByVersion` selects only exact format/version. Packet v3 calls frozen v3 reader; receipt v1/marker v3 call frozen runtime. No legacy object is rewritten. V4 fields on legacy input and legacy-only field placement on v4 reject; unsupported versions return `review_artifact_version_unsupported`. Existing `reviewerModelId`, `reviewProfileVersion`, `terra-final-v1`, and `terra-parent` remain frozen provenance/compatibility values while v2 adds model-neutral role/assignment/profile fields. Active v3 generator, validator, receipt runtime, workflow, hook, and gate are unchanged.

## 4. Authoritative admission versus candidate evidence

Candidate tests never approve or admit a candidate. Every slice first passes authoritative preceding-base admission and independent read-only review/protected exact-head CI; only then are candidate functional tests considered supporting evidence.

### 4.1 Residue-free dependency lease and managed setup

Placeholders are controller-resolved absolute paths/SHAs, never candidate or policy values:

* `<REPO>`: canonical repository root containing `<BASE>` and `<CANDIDATE>` objects.
* `<BASE_CHECKOUT>` / `<CANDIDATE_CHECKOUT>`: clean detached managed checkouts at those exact commits, initially with no filesystem entry at `node_modules`.
* `<DEPS>` / `<CACHE>` / `<EVIDENCE>`: new operation-ID-scoped directories under one controller-owned external root that is outside every source/review/worktree and not nested under the Git common directory.

The required runtime is exact Node `v24.14.0` and npm `11.13.0`; `node --version` and `npm --version` must print those single lines or the operation blocks before filesystem changes. For each slice, the controller resolves and records `<BASE>:package.json`, `<BASE>:package-lock.json`, and `<BASE>:scripts/review-policy.mjs` blob IDs, modes, byte lengths, and SHA-256. It materializes those exact `git cat-file blob` bytes as `<DEPS>/package.json`, `<DEPS>/package-lock.json`, and `<DEPS>/scripts/review-policy.mjs`; binary-safe writes on Windows/POSIX must reproduce the recorded digests. Candidate package/lock/npmrc/environment cannot contribute. Because none of the slices changes these files, every base must retain package manifest SHA-256 `33cc82da51e54782d5e9ff804cf3d1f7e684ba0e5662f80f85b5f8175b049e19`, lock SHA-256 `3e0440117c3cb0bef132fe27490649e190c993f267338a78baff84f2b88fa2ec`, and review-policy SHA-256 `12d32a4b589dc1d1b05089409cc65e4fffcd7867b5eee438b140688a01cc7b4f`; drift blocks.

With cwd `<DEPS>`, sanitized npm environment removes project/user npmrc, credentials, proxy and `NPM_CONFIG_*` overrides except controller-fixed cache/registry; lifecycle environment is not inherited. Run exactly:

```text
npm ci --ignore-scripts --no-audit --no-fund --cache <CACHE> --registry https://registry.npmjs.org/
```

The network rule permits only HTTPS artifacts named by the exact base lockfile from `https://registry.npmjs.org/`; lockfile `resolved` URLs and `integrity` fields are authority, redirects to another origin, missing integrity, registry/config mutation, script execution, or offline cache miss when network is disabled all block. Cache and install target are external only. Exit 0, complete stdout/stderr digest, exact lock SHA-256, installed tree identity, Node/npm versions, and operation ID are recorded privately. Nothing is installed in a checkout. Public lifecycle evidence exposes only versions, commit/blob/lock/install-result digests and booleans—never machine-local paths, usernames, cache locations, or credentials.

The copied exact-base loader is adjacent to `<DEPS>/node_modules`, so Node resolves `typebox` externally while `verifyTrustedLoader` still compares the executing `<DEPS>/scripts/review-policy.mjs` bytes to `<BASE>:scripts/review-policy.mjs`. For Slice 3, the controller also materializes from exact Slice 2 base blobs `scripts/verify-delivery-role-policy-candidate.mjs` and its complete fixed local import closure at matching `<DEPS>` paths, records every blob/digest, and rejects undeclared/dynamic local imports before execution. Any materialization/install/self-check failure blocks and preserves managed checkouts unchanged.

### 4.2 Common authoritative admission commands

From `<REPO>`, for every slice run:

```text
node <DEPS>/scripts/review-policy.mjs verify --repo <REPO> --mode review-preflight --base <BASE> --candidate <CANDIDATE>
node <BASE_CHECKOUT>/scripts/generate-review-packet.mjs --base <BASE> --head <CANDIDATE>
node <BASE_CHECKOUT>/scripts/validate-review-packet.mjs --packet <EVIDENCE>/packet-v3.json --base <BASE> --head <CANDIDATE>
```

The first stdout is one JSON line with exact fields `format:"pi-sampler.delivery-review-policy"`, `version:1`, `mode:"review-preflight"`, `status:"ready"`, `code:"ready"`, exact base/candidate/profile fields, trusted policy, and 64-hex policy/binding digests; exit is 0. It exactly matches trusted `parseCli`, executes exact base bytes, and treats candidate profile only as Git data. Any other result blocks.

Base packet stdout is stored at `<EVIDENCE>/packet-v3.json`, validated by base bytes, and sorted paths/statuses are compared to the slice allowlist. Missing/extra/rename/copy paths block. Independent read-only review and protected exact-head CI must separately pass.

### 4.3 Candidate functional evidence lease

Only after admission, record normal and ignored `git status --porcelain=v2 --untracked-files=all` for repo/base/candidate and verify candidate `node_modules` is absent. Create exactly one operation-local link `<CANDIDATE_CHECKOUT>/node_modules` to `<DEPS>/node_modules`, never a copied tree. POSIX executes `ln -s <DEPS>/node_modules <CANDIDATE_CHECKOUT>/node_modules` and releases with `unlink <CANDIDATE_CHECKOUT>/node_modules`. Windows executes `cmd.exe /d /s /c mklink /J "<CANDIDATE_CHECKOUT>\node_modules" "<DEPS>\node_modules"` and releases only the junction with `cmd.exe /d /s /c rmdir "<CANDIDATE_CHECKOUT>\node_modules"`. Resolve both endpoints and verify the link target identity/digest before testing. Record normal and `--ignored=matching` status with the link present.

Run complete declared test files from `<CANDIDATE_CHECKOUT>`—never name patterns—using exact Node/npm versions. Each named file must exist and report nonzero tests. In a `finally` path remove only the verified operation-owned link, then require path absence and exact restoration of both normal and ignored statuses for all checkouts. This removal is dependency-lease release, not workspace cleanup. If interrupted, if identity changed, or if removal/inspection fails, stop and preserve the checkout for manual disposition; do not delete or repair anything else. Candidate tests remain non-authoritative and cannot change admission. External sandbox/cache retention or expiry is controller-owned outside workspace lifecycle.

## 5. Exact slices, allowlists, tests, and rollback

Every New/Modified path is assigned to exactly one slice.

### Slice 1 — optional schema bridge

* **Base:** exact original SHA above.
* **Modified allowlist:** `profiles/project-profile.schema.json`, `tests/project-profiles.test.mjs`.
* **Admission:** common preceding-base commands with original base and Slice 1 candidate; packet paths must equal this allowlist.
* **Candidate evidence:** `node --test tests/project-profiles.test.mjs`; then `npm test`. The full existing modified file must execute nonzero tests and cover absent/valid/invalid/bounds rolePolicy schema cases; no later-slice file is referenced.
* **State/output:** current profile, trusted loader, active scripts/gate byte-identical; output merged SHA and schema digest; v3 authoritative.
* **Rollback:** revert two files; absent policy remains valid and v3 fixtures still pass.

### Slice 2 — additive contracts/readers and inert verifier

* **Base:** exact merged Slice 1 SHA/digest.
* **New allowlist:** `contracts/delivery-role-policy-v1.mjs`, `contracts/trusted-context-admission-reference-v1.mjs`, `contracts/trusted-context-admission-reference-v1.schema.json`, `contracts/trusted-context-admission-provider-v1.json`, `docs/scoped-review-packet-v4.schema.json`, `docs/final-review-receipt-v2.schema.json`, `docs/review-marker-v4.schema.json`, `docs/interfaces/AIDEV-190-context-admission-reference-v1.md`, `docs/interfaces/AIDEV-166-role-resolution-v1.md`, `scripts/export-trusted-context-admission-reference-v1-schema.mjs`, `scripts/review-artifact-dispatch.mjs`, `scripts/review-packet-v4.mjs`, `scripts/final-review-receipt-v2.mjs`, `scripts/verify-delivery-role-policy-candidate.mjs`, `.pi/agents/primary-reviewer.md`, `tests/delivery-role-policy.test.mjs`, `tests/trusted-context-admission-reference.test.mjs`, `tests/review-artifact-dispatch.test.mjs`, and every fixture listed in Section 6 under role-policy, context-reference, and review-compatibility.
* **Modified allowlist:** none.
* **Admission:** common commands with Slice 1 base and Slice 2 candidate; packet paths exactly equal this complete list.
* **Candidate evidence:** `node --test tests/delivery-role-policy.test.mjs tests/trusted-context-admission-reference.test.mjs tests/review-artifact-dispatch.test.mjs tests/scoped-review-packet.test.mjs tests/final-review-receipt.test.mjs`; then generated-schema parity and `npm test`. The latter two existing tests are unmodified regressions, not owned paths.
* **State/output:** current profile still omits rolePolicy; v4 structural only/unavailable; output all schema/contract/golden/frozen digests and inert verifier digest; v3 authoritative.
* **Rollback:** remove all Slice 2 additions; Slice 1 runtime remains unchanged.

`verify-delivery-role-policy-candidate.mjs` is inert in Slice 2 and becomes trusted preceding-base evidence for Slice 3. Its sole CLI is `verify --repo <REPO> --base <BASE> --candidate <CANDIDATE>`; it reads its own merged-base contract/schema and candidate `profiles/pi-sampler.json` as a Git blob, rejects any loader/path option, and emits `{"format":"pi-sampler.delivery-role-policy-candidate-verification","version":1,"status":"ready","code":"ready","baseSha","candidateSha","rolePolicySha256"}` or a stable blocked envelope. It never replaces review-policy admission.

### Slice 3 — configured profile and terminology adoption

* **Base:** exact merged Slice 2 SHA and all Slice 2 digests.
* **Modified allowlist:** `profiles/pi-sampler.json`, `.pi/agents/scoped-reviewer.md`, `.agents/skills/project-code-review/SKILL.md`, `.agents/skills/project-delivery/SKILL.md`, `.agents/skills/create-implementation-plan/SKILL.md`, `.github/pull_request_template.md`, `CONTRIBUTING.md`, `docs/SCOPED-REVIEW.md`, `docs/IMPLEMENTATION-PLANNING.md`, `tests/project-delivery-skill.test.mjs`, `tests/implementation-plan-skills.test.mjs`.
* **New allowlist:** none.
* **Admission:** common commands with Slice 2 base and Slice 3 candidate and exact allowlist comparison. Then run the sandboxed trusted Slice 2 verifier: `node <DEPS>/scripts/verify-delivery-role-policy-candidate.mjs verify --repo <REPO> --base <BASE> --candidate <CANDIDATE>`; require exact ready envelope/digest.
* **Candidate evidence:** `node --test tests/delivery-role-policy.test.mjs tests/trusted-context-admission-reference.test.mjs tests/review-artifact-dispatch.test.mjs tests/project-profiles.test.mjs tests/scoped-review-packet.test.mjs tests/final-review-receipt.test.mjs tests/project-delivery-skill.test.mjs tests/implementation-plan-skills.test.mjs`; then `npm test`.
* **State/output:** configured role-policy digest, AIDEV-190 interface bundle digest, AIDEV-166 role-resolution digest, frozen-file digest report, and no-active-gate-change report; context unavailable; v3 authoritative.
* **Rollback:** revert exactly Slice 3 modifications to merged Slice 2; additive interfaces remain inert and v3 remains operable.

No slice changes `.github/workflows/adversarial-review.yml`, `scripts/hooks/pre-push.mjs`, `scripts/review-policy.mjs`, `scripts/generate-review-packet.mjs`, `scripts/validate-review-packet.mjs`, `scripts/final-review-receipt.mjs`, `scripts/validate-adversarial-review-attestation.mjs`, `scripts/review-provenance-contract.mjs`, `docs/scoped-review-packet-v3.schema.json`, or `docs/final-review-receipt-v1.schema.json`.

## 6. Complete owned surface

### Slice 1 — Modified

`profiles/project-profile.schema.json`; `tests/project-profiles.test.mjs`.

### Slice 2 — New

The exact non-fixture paths are the Slice 2 allowlist above. Fixture paths are:

* `tests/fixtures/role-policy/current-gemini-luna-sol.json`
* `tests/fixtures/role-policy/terra-codex-planner.json`
* `tests/fixtures/role-policy/same-model-separate-contexts.json`
* `tests/fixtures/role-policy/valid-override.json`
* `tests/fixtures/role-policy/fallback-0.json`
* `tests/fixtures/role-policy/fallback-1.json`
* `tests/fixtures/role-policy/unavailable.json`
* `tests/fixtures/role-policy/malformed-availability.json`
* `tests/fixtures/role-policy/nonallowed-override.json`
* `tests/fixtures/role-policy/unsupported-catalog.json`
* `tests/fixtures/role-policy/unspecified-policy.json`
* `tests/fixtures/context-admission-reference/structurally-valid.json`
* `tests/fixtures/context-admission-reference/self-asserted.json`
* `tests/fixtures/context-admission-reference/missing-provider.json`
* `tests/fixtures/context-admission-reference/binding-mismatch.json`
* `tests/fixtures/context-admission-reference/duplicate-key.json`
* `tests/fixtures/context-admission-reference/noncanonical.json`
* `tests/fixtures/context-admission-reference/oversized.json`
* `tests/fixtures/context-admission-reference/provider-v1-interface-vectors.json`
* `tests/fixtures/review-compatibility/packet-v3-canonical.json`
* `tests/fixtures/review-compatibility/receipt-v1-canonical.json`
* `tests/fixtures/review-compatibility/marker-v3.txt`
* `tests/fixtures/review-compatibility/terra-final-v1-receipt.json`
* `tests/fixtures/review-compatibility/terra-parent-revoked-receipt.json`
* `tests/fixtures/review-compatibility/packet-v4-structural.json`
* `tests/fixtures/review-compatibility/receipt-v2-structural.json`
* `tests/fixtures/review-compatibility/marker-v4-structural.txt`
* `tests/fixtures/review-compatibility/packet-package-lock-parity-cases.json`

### Slice 3 — Modified

Exactly the Slice 3 modified allowlist above. `.pi/agents/scoped-reviewer.md` is assigned only here; `.pi/agents/primary-reviewer.md` is added only in Slice 2. The nonexistent `tests/review-provenance-contract.test.mjs` is not planned or owned; frozen provenance regression uses the existing unmodified `tests/final-review-receipt.test.mjs`.

## 7. Acceptance checklist

- [ ] AIDEV-187-1: The optional schema bridge is admitted by the original-base preflight and full profile tests while current profile, trusted loader, active review scripts, and v3 behavior remain byte-identical.
- [ ] AIDEV-187-2: Exact-base policy loading and resolution ignore untrusted selectors and follow the fixed catalog, profile-admission, considered-set, availability, precedence, and golden-envelope rules.
- [ ] AIDEV-187-3: The adopted profile resolves manual Antigravity Gemini planner, Luna implementer, Sol primary reviewer, and Sol final reviewer with exact selected envelopes.
- [ ] AIDEV-187-4: Terra direct selection and same-model Sol role assignments resolve without override or model-inequality trust checks, while context admission remains unavailable.
- [ ] AIDEV-187-5: Allowlisted override, both zero-based fallback positions, malformed availability, unsupported catalogs, nonallowed override, exhaustion, and unspecified policy return exact golden envelopes.
- [ ] AIDEV-187-6: Policy and resolution canonical bytes, null or zero-based fallbackIndex values, bounds, and domain-separated digest vectors are identical on Windows and Linux.
- [ ] AIDEV-187-7: The byte-preserving context consumer rejects self-attestation, keeps the dispatch unavailable, and freezes the exact bounded provider-v1 request, result, module, digest, timeout, and error interface for AIDEV-190.
- [ ] AIDEV-187-8: Packet v4 exactly maps packet v3 including canonical root package-lock admission through 524288 bytes and ordinary 131072-byte endpoints, binds policy/context digests, rejects stale policy, and remains non-authoritative.
- [ ] AIDEV-187-9: Receipt v2 binds policy and context digests at root and every pass, and marker v4 follows the exact grammar and key order while preserving lifecycle, revocation, provenance, privacy, and inactive publication.
- [ ] AIDEV-187-10: Immutable dispatch and package-lock boundary parity preserve packet v3, receipt v1, marker v3, terra-final-v1, and terra-parent bytes/results without invented fields, silent upgrade, reinterpretation, or downgrade.
- [ ] AIDEV-187-11: Every model-neutral agent, skill, API, template, documentation, compatibility alias, test, and fixture path is correctly classified and assigned to exactly one slice.
- [ ] AIDEV-187-12: All slices use the exact external dependency lease, preceding-base admission, path allowlists, non-vacuous tests, independent review, protected CI, and restored no-residue status while publishing downstream digests without activating v4.

## 8. Non-vacuous acceptance routes

Every row requires the Sections 4.1–4.3 dependency lease, common admission commands, and link release with the listed slice base/candidate, exact ready JSON, exact packet allowlist, independent review/protected exact-head CI, and unchanged statuses. Candidate commands run only after admission and must report nonzero tests in every named file; absence is a nonzero failure. Node/npm/test argv are identical on Windows/Linux; only the explicitly specified symlink versus junction create/release primitive differs.

| ID | Admission / candidate evidence | Exact asserted result |
|---|---|---|
| 1 | Slice 1 admission; `node --test tests/project-profiles.test.mjs` | Schema cases execute; frozen active digests equal base. |
| 2 | Slice 2 admission; `node --test tests/delivery-role-policy.test.mjs` | Selector probes and D4 precedence/golden envelopes exact. |
| 3 | Slice 3 admission + trusted Slice 2 verifier; `node --test tests/delivery-role-policy.test.mjs tests/project-profiles.test.mjs` | Candidate profile digest and four selected envelopes exact. |
| 4 | Slice 2 admission; `node --test tests/delivery-role-policy.test.mjs tests/trusted-context-admission-reference.test.mjs` | Terra selected/index null; same-model policy passes; context unavailable. |
| 5 | Slice 2 admission; `node --test tests/delivery-role-policy.test.mjs` | Override/fallback/error fixtures match exact envelopes. |
| 6 | Slice 2 admission; `node --test tests/delivery-role-policy.test.mjs` | Cross-platform bytes/digests and limit/limit+1 results match. |
| 7 | Slice 2 admission; `node --test tests/trusted-context-admission-reference.test.mjs` | Original-byte parsing plus unavailable and future provider-v1 request/result/dispatch/import/timeout vectors are exact; no provider is called. |
| 8 | Slice 2 admission; `node --test tests/review-artifact-dispatch.test.mjs tests/scoped-review-packet.test.mjs` | Complete mapping/domain/staleness plus seven package-lock/ordinary endpoint parity cases pass; publication is inactive. |
| 9 | Slice 2 admission; `node --test tests/review-artifact-dispatch.test.mjs tests/final-review-receipt.test.mjs` | Root/pass/marker mappings, mixed-policy negatives, lifecycle/privacy exact. |
| 10 | Slice 2 admission; `node --test tests/review-artifact-dispatch.test.mjs tests/scoped-review-packet.test.mjs tests/final-review-receipt.test.mjs tests/adversarial-review-attestation.test.mjs` | Frozen bytes/results and package-lock boundary outcomes match v4; cross-version extras reject. |
| 11 | Slice 3 admission; `node --test tests/review-artifact-dispatch.test.mjs tests/project-delivery-skill.test.mjs tests/implementation-plan-skills.test.mjs` | Exact path inventory and legacy allowlist pass. |
| 12 | Slice 3 admission + sandboxed trusted Slice 2 verifier; run the complete Slice 3 candidate command and `npm test` under the verified link lease | Node/npm/lock/install/link digests, test counts, predecessor/interface/frozen-gate outputs, and normal/ignored status restoration all match. |

## 9. Downstream outputs, staleness, and decisions

AIDEV-190 receives the role-policy vectors; byte-oriented consumer; exact unavailable/available dispatch schemas; fixed module/export and async request/result API; contract/module digest checks; timeout/error precedence; golden provider-interface vectors; successor mappings; and the `pi-sampler.aidev-190-context-interface` digest. AIDEV-166 receives `pi-sampler.aidev-166-role-resolution-interface` only through AIDEV-190.

The plan stales on ticket/base, Node/npm pin or base package/lock digest, dependency sandbox/link protocol, profile schema, catalogs/profile admission, resolution semantics, context parser/provider request/result/dispatch/module API, package-lock endpoint admission, any successor key/mapping/bound/domain/grammar, frozen legacy/active-gate digest, slice allowlist/test command, downstream digest, or acceptance drift. JIT binds ticket/base/plan and current trusted contracts; later slices bind immediately preceding merged SHAs and outputs.

Unresolved human decisions: none. Authority implementation and v4 activation are intentionally AIDEV-190 decisions.
