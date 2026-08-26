# AIDEV-191 — exact implementation-plan-manifest/v2 delivery admission

## 0. Authority, state, immutable inputs, and non-goals

This is the complete replacement implementation plan authorized after human escalation. Authorization permits only this uncommitted plan and its sibling manifest to be rewritten. It is **not approval**. Implementation remains blocked until the same independent-review lineage reviews the complete corrected pair and returns `approved`.

| Binding | Exact value |
|---|---|
| Repository | `Zkrausman/pi-sampler` |
| Planning worktree | `E:/Repos - Non Indexed/ai-workspaces/plan/AIDEV-191-d92b1c` |
| Planning branch | `zkrausman/aidev-191-plan-implementation-plan-d92b1c` |
| Trusted base/HEAD | `3d858a0d4f8219f5ca1db13ad1de72e35ee09758` |
| Profile | `profiles/pi-sampler.json` |
| Ticket revision | `80a83a007ceffd8f35a6be12b97c01f781b1f7b67874cc2b7c2185c053e84384` |
| Ticket snapshot SHA-256 | `4baf5467e678d702b05ce40e90bb700b248fc1421147d88d3da482d5de59be13` |
| Research packet SHA-256 | `8f3b60dd331dc2581d57d6de2f2fa69a1295d7fdf1e26d210ea078b6a4e5ea6f` |
| Reconciliation SHA-256 | `94b6bc4af20225285c3f2d7a36e454defad09657ace23b9d5e63c0bd4b3dc625` |
| Bootstrap authority SHA-256 | `7a85b262fd92dd7b765c3383a655686881b66b4529444831a7bfedafd9beb30e` |
| Replacement authority SHA-256 | `409d3f59503d5f89ec7be4e33c7ba398532009d6e1cec129c1191790d0953a46` |
| Failed-review report SHA-256 | `b7805d2317004d968355cea3d088f0be09af2cbcb0b092d82566e7d48f6cea4a` |

The implementation may change only the paths classified New or Modified in Section 8, in the assigned slice. Read-only paths are behavioral fixtures and may not change. This plan never authorizes implementation, commit, push, PR creation/update, tracker mutation, review-marker publication, merge, workspace cleanup, or quarantine. It adds no signing, replay, threshold-approval, automatic Antigravity, provider/model selection, or lifecycle authority. `do not merge` remains sticky; only the user's exact `Merge PR #N` action can authorize that one merge.

## 1. Delivery order and mandatory refresh gates

The only permitted order is:

1. **Plan-publication bootstrap on base `3d858a0d4f8219f5ca1db13ad1de72e35ee09758`:** publish/review this v2 plan through the one-time authorized matrix-v1 structural bridge in Section 7. Candidate matrix-v2 code is absent and cannot be claimed.
2. **Slice 1 — inert support:** start exactly at `3d858a0d4f8219f5ca1db13ad1de72e35ee09758`; add all runtime/contracts/controller/tests but no activation declaration and no profile-selected v2 command. Review it under predecessor-base behavior. Its merged commit and frozen output report become `SLICE1_SHA` and `SLICE1_OUTPUT_SHA256`.
3. **Mandatory plan refresh before Slice 2:** Slice 1 merge or any Slice 1 output drift makes this pair stale. Rewrite the complete plan/manifest against exact `SLICE1_SHA`; update ticket, plan, base, contract, controller, runtime, schema, profile and validator digests; rerun the deterministic plan validator; and obtain renewed complete-pair independent approval. This is an intra-ticket transition gate, **not** a manifest hard dependency or predecessor output.
4. **Slice 2 — activation/integration:** only the newly trusted exact `SLICE1_SHA` may run transition validation over the candidate activation declaration, profile, CLI integration, docs and skills. Slice 2 may not use its own activation bytes to validate itself.
5. **AIDEV-187 refresh:** only after reviewed AIDEV-191 activation is merged. Rebase PR #172 and regenerate every stale binding listed in Section 10 before restarting independent approval and the v3 final-child gate.

No step may be combined. A failed gate remains blocked. A rollback is a separately planned/reviewed safe-state change under Section 9, never a blanket `git revert` instruction.

## 2. D1 — exact `acceptance-matrix/v2` wire contract

### 2.1 Encoding, key order, constants, and digest rules

The new published schema is `governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json`; the Go source of runtime truth is `AcceptanceMatrixV2` in `governance/pkg/deliveryevidence/acceptance_v2.go`. Runtime/schema parity is mandatory.

A matrix is canonical only when all of these hold:

* bytes are UTF-8 without BOM, contain no invalid scalar, CR, tab, leading/trailing whitespace, or insignificant whitespace, and are exactly `JSON.stringify(value) + "\n"`;
* object keys occur in the orders specified below; arrays preserve declared order; strings use JSON's shortest standard escaping, never escaped `/`, and integers use base-10 without exponent, sign, or leading zero;
* strict duplicate-key detection occurs before JSON decoding; a duplicate returns `matrix_duplicate_key`; a valid but re-ordered/noncanonical object returns `matrix_noncanonical`; unknown keys return `matrix_schema_invalid`; all objects have `additionalProperties:false`;
* named `*_sha256` fields are lowercase SHA-256 of the exact raw bytes of the named file (including its final newline), with no newline normalization. Artifact digests are SHA-256 of exact artifact bytes. `facts_sha256` alone is domain-separated as `SHA256(UTF8("pi-sampler.delivery-normalized-facts/v1\0") || canonicalFactsBytes)`. The final-review receipt continues to hash the exact canonical matrix bytes without a new domain or reinterpretation;
* limits are measured in UTF-8 bytes after decoding: matrix <= 2,097,152 bytes; manifest <= 2,097,152; plan <= 4,194,304; rows 1..128; nesting <= 16; any string <= 2,048 bytes unless a narrower bound is stated; argv 1..32 elements and each element 1..256 bytes.

The root key order and exact types are:

| # | Key | Exact contract |
|---:|---|---|
| 1 | `schema_version` | constant `acceptance-matrix/v2` |
| 2 | `manifest_schema_version` | constant `implementation-plan-manifest/v2`; therefore the only v2 pair is v2/v2 |
| 3 | `evaluation_scope` | enum `plan-publication`, `implementation-delivery` |
| 4 | `repository` | exact trusted `owner/repository`; 3..256 ASCII bytes, pattern from manifest-v2 |
| 5 | `ticket_id` | exact trusted ticket; 3..32 ASCII bytes |
| 6 | `ticket_revision` | exact 40- or 64-hex trusted revision |
| 7 | `profile_path` | constant `profiles/pi-sampler.json` |
| 8 | `profile_sha256` | raw trusted-base profile blob digest |
| 9 | `base_sha` | exact trusted 40- or 64-hex base commit |
| 10 | `head_sha` | exact candidate 40- or 64-hex commit; unequal to base |
| 11 | `pull_request_number` | integer 1..1,000,000,000 |
| 12 | `plan_path` | exact approved portable path, max 256 bytes |
| 13 | `plan_sha256` | raw exact plan-byte digest |
| 14 | `manifest_path` | deterministic sibling path, max 256 bytes |
| 15 | `manifest_sha256` | raw exact manifest-byte digest |
| 16 | `manifest_contract_path` | constant `contracts/implementation-plan-manifest-v2.mjs` |
| 17 | `manifest_contract_sha256` | trusted-base raw blob digest |
| 18 | `manifest_validator_path` | constant `scripts/validate-implementation-plan.mjs` |
| 19 | `manifest_validator_sha256` | trusted-base raw blob digest |
| 20 | `matrix_contract_path` | constant `governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json` |
| 21 | `matrix_contract_sha256` | trusted-base raw blob digest |
| 22 | `policy_path` | constant `profiles/pi-sampler.json` |
| 23 | `policy_sha256` | must equal `profile_sha256`; trusted policy identity is not candidate-selectable |
| 24 | `evidence_root_id` | opaque ASCII identifier 1..128, pattern `^[A-Za-z0-9][A-Za-z0-9._:-]*$`; never a filesystem path |
| 25 | `generated_at` | canonical UTC RFC3339 `YYYY-MM-DDTHH:MM:SS.sssZ`; not before any row start, not after controller time +300 seconds |
| 26 | `rows` | 1..128 rows, exact manifest order, each manifest ID exactly once |

Exact root values are compared with trusted controller inputs before row evaluation. `manifest_path` is `plan_path` with `-implementation-plan.md` replaced by `-acceptance-manifest-v2.json`; any other pairing is `artifact_path_mismatch`.

### 2.2 Exact row variants

Every row begins, in this order, with `id`, `acceptance_class`, `requirement`, `status`. `id` is 1..128 bytes and follows manifest-v2's exact stable-ASCII pattern; `acceptance_class` and `requirement` are byte-for-byte equal to the corresponding manifest row. Titles are intentionally not repeated. IDs must be unique and in manifest order.

* **Plan-publication specified row:** exact keys `id,acceptance_class,requirement,status,specification`; `status` is constant `specified`. No `evidence`, `blocker`, `waiver`, implementation claim, or observed wording is accepted. `specification` is the evidence object below and must contain artifacts named `plan-validator-report.json` and `independent-plan-review.md`. The former has exit 0 and `ok:true`; the latter is from the authorized independent reviewer and says `approved`. This records that the requirement is specified, never that implementation exists.
* **Implementation-delivery observed row:** exact keys `id,acceptance_class,requirement,status,evidence`; `status` is constant `observed`; `evidence` is the exact evidence object below. Clean delivery additionally requires class-policy satisfaction.
* **Implementation-delivery blocked row:** exact keys `id,acceptance_class,requirement,status,blocker`; `status` is constant `blocked`; `blocker` keys are `code,reason,blocked_by` in that order. `code` is stable ASCII 1..64, `reason` 1..2048 UTF-8 bytes, and `blocked_by` is either a stable ID 1..128 or `null`. A blocked row makes the result `status=blocked,code=rows_blocked`.
* `waived` has no v2 schema variant. Any `waived`, waiver object, replay path/state, signature, nonce or threshold object is `matrix_schema_invalid`; no replay state is opened or consumed.

### 2.3 Evidence, verifier, and artifact objects

`specification` and `evidence` have identical strict keys in this order:

1. `verifier`: object keys `id,version,environment,argv` where `id` and `version` are 1..128 stable ASCII, `environment` is `local|ci|review|external`, and `argv` is 1..32 exact strings (1..256 bytes each). Shell command strings and callbacks are forbidden.
2. `exit_status`: integer 0..255; `specified` and `observed` require 0.
3. `started_at`, `completed_at`: canonical UTC millisecond RFC3339; completed >= started; duration <= 900,000 ms; completed <= `generated_at`; future skew <=300 seconds.
4. `artifacts`: 1..32 strict artifact objects, unique by both `name` and normalized `path`.

Artifact keys are `name,path,sha256,bytes` in that order. `name` is 1..128 stable ASCII. `path` is a relative POSIX path 1..240 bytes, no percent, backslash, empty/dot/dot-dot segment, leading slash, drive/UNC/device prefix, duplicate slash, trailing slash, colon or control byte. `sha256` is exact lowercase 64-hex; `bytes` is integer 0..10,485,760. Total bytes per evidence object <=33,554,432 and all rows combined <=104,857,600. A path maps to exactly `canonicalEvidenceRoot + platformSeparator + pathSegments`; no search, glob, alias or fallback is allowed.

### 2.4 Class policy and cardinality

The controller derives policy only from the trusted-base `profiles/pi-sampler.json` blob whose digest is bound in the matrix. Exactly one trusted profile class with `id == acceptance_class` is required. Its `verifier`, `environment`, and argv-array `command` must equal the evidence verifier. Missing, duplicate or mismatched policy returns blocked `policy_missing`, `policy_ambiguous`, or `verifier_policy_mismatch`.

For `ordinary`, `authority`, `resource-bounded`, and `concurrency`, implementation delivery requires one evidence object and at least one byte-verified artifact. `requirement` requires the trusted `wiki-requirement` external verifier plus one immutable requirement artifact; no command in policy means the evidence argv must be exactly `["external:wiki-requirement"]`. `evidence` and `benchmark` manifest-v2 classes return blocked `unsupported_class_policy` until a separately reviewed external policy exists. Plan publication allows every manifest-v2 class only as `specified`. Waiver is not a manifest-v2 class and is unsupported.

### 2.5 Normalized facts and stable result envelope

After the trusted JS validator returns `ok:true`, the controller emits canonical internal facts (never candidate-authored) with key order:

`format`=`pi-sampler.delivery-normalized-facts`, `version`=1, `repository`, `ticketId`, `ticketRevision`, `profilePath`, `profileSha256`, `baseSha`, `headSha`, `pullRequestNumber`, `planPath`, `planSha256`, `manifestPath`, `manifestSha256`, `manifestSchemaVersion`, `manifestContractSha256`, `manifestValidatorSha256`, `matrixContractSha256`, `policySha256`, `evaluationScope`, `rows` (objects ordered `id,acceptanceClass,requirement`). It is canonicalized by the rules above and domain-hashed as `facts_sha256`. Go receives these already-bound facts; it does not select Git, profile, contract, activation or candidate paths.

All controller/Go results use the exact root key order `format,version,status,code,evaluation_scope,facts_sha256,matrix_sha256,rows,diagnostics`. Constants are `format=pi-sampler.delivery-acceptance-result`, `version=1`; `status` is `valid|blocked|invalid`; `code` is one stable code; missing digests are JSON `null`; rows preserve manifest order as strict objects `id,status,code`; diagnostics are strict objects `code,path` sorted by precedence then Unicode-code-point path. Valid plan publication is `valid/specified`; valid implementation is `valid/observed`; any blocked row is `blocked/rows_blocked`; malformed/untrusted input is `invalid/<code>`. CLI exit is 0 only for `valid`, 3 for `blocked`, 1 for `invalid`, and 2 for argv/usage errors.

Deterministic first-error precedence is: `usage_invalid`, `git_unavailable`, `trusted_base_invalid`, `activation_absent`, `trusted_blob_invalid`, `trusted_digest_mismatch`, `candidate_root_invalid`, `source_mutated`, `artifact_too_large`, `manifest_validator_failed`, `manifest_version_unsupported`, `matrix_duplicate_key`, `matrix_json_invalid`, `matrix_schema_invalid`, `matrix_noncanonical`, `version_pair_mixed`, `version_pair_unsupported`, `binding_mismatch`, `artifact_path_mismatch`, `digest_mismatch`, `row_duplicate`, `row_missing`, `row_unknown`, `row_reordered`, `row_binding_mismatch`, `scope_status_mismatch`, `evidence_root_invalid`, `evidence_path_invalid`, `evidence_identity_changed`, `artifact_digest_mismatch`, `policy_missing`, `policy_ambiguous`, `verifier_policy_mismatch`, `unsupported_class_policy`, `rows_blocked`. All applicable diagnostics may be returned, but `code` is the first by this list.

### 2.6 Exact dispatch/outcome table

| Input | Required result |
|---|---|
| `acceptance-manifest/v1` + `acceptance-matrix/v1` through legacy API | frozen historical envelope/result, unchanged |
| `implementation-plan-manifest/v2` + `acceptance-matrix/v2`, exact canonical pair | continue exact v2 checks |
| either mixed pair | `invalid/version_pair_mixed`, exit 1 |
| unknown or future version | `invalid/version_pair_unsupported`, exit 1 |
| aliases such as `A187-Txx` for approved v2 IDs | `invalid/row_unknown` plus `row_missing` |
| projection/dropped v2 fields | manifest validator failure or `row_binding_mismatch` |
| v1-to-v2 upgrade or v2-to-v1 downgrade | mixed/unsupported; never rewritten |
| duplicate JSON key | `invalid/matrix_duplicate_key` |
| duplicate row | `invalid/row_duplicate` |
| unknown/missing row | `row_unknown` / `row_missing` |
| correct rows in another order | `invalid/row_reordered` |
| stale ticket/base/head/PR/profile/contract/path | `invalid/binding_mismatch` |
| any raw-byte digest mismatch | `invalid/digest_mismatch` |
| structurally valid specified publication rows | `valid/specified`; no implementation claim |
| blocked implementation row | `blocked/rows_blocked`, exit 3 |
| evidence/benchmark without trusted policy | `blocked/unsupported_class_policy`, exit 3 |

## 3. D2 — one trusted-base controller/Go/JS route

### 3.1 Single authority split

There is one authoritative controller route for the mode that is actually trusted: `scripts/trusted-delivery-evidence-controller.mjs` selects/authenticates immutable Git objects for `transition` or activated `validate`; `governance/pkg/deliveryevidence/acceptance_v2.go` consumes already-bound normalized facts and owns matrix/evidence/policy evaluation. Slice 1 `support` is deliberately outside that authority route and runs candidate tests only. Go never reads a schema/profile/plan from a repository path and JS never decides row satisfaction. Existing v1 functions remain separate.

Exports/symbols are:

* JS: `main`, `parseTrustedDeliveryArgs`, `locateFixedGit`, `readTrustedBlob`, `runTrustedPlanValidator`, `buildNormalizedFacts`, `canonicalJSONString`, `sha256Bytes`.
* Go: `AcceptanceMatrixV2`, `AcceptanceMatrixV2Row`, `AcceptanceEvidenceV2`, `AcceptanceArtifactV2`, `NormalizedFactsV1`, `AcceptanceResultV1`, `ParseImplementationPlanManifestV2Compatibility(source CompatibilitySourceV1) AcceptanceResultV1`, `ValidateAcceptanceV2(request AcceptanceV2Request) AcceptanceResultV1`. The compatibility parser is low-level tuple/version parsing only and always returns `delivery_admitted=false`.
* Platform Go: `OpenExternalEvidenceRoot`, `ReadVerifiedArtifact` in `external_root_posix.go` and `external_root_windows.go`.
* CLI: new `-mode acceptance-v2` reads one bounded request from stdin and writes one result line to stdout; legacy modes and strings remain unchanged.

Mode dispatch is exact and occurs before path reads. There is no universal fixed-path set and no mode alias.

**`support` (Slice 1 candidate functional evidence only).** No trusted v2 controller is invoked because base `3d858a0d4f8219f5ca1db13ad1de72e35ee09758` contains none. The candidate runs only:

```text
<node-24-absolute> --test tests/delivery-acceptance.test.mjs tests/delivery-acceptance-v2.test.mjs
<node-24-absolute> scripts/run-governance-tests.mjs
<npm-absolute> test
```

The candidate test harness may emit `pi-sampler.delivery-v2-support-report/v1` to the external evidence root, with candidate head/path/test/inventory digests and `status=functional-only,authority=false`. It cannot call `transition|validate`, select trusted bytes, approve itself, launch a child, create a receipt/marker, or activate v2. Sole authority remains the exact old-base `scripts/review-policy.mjs`, packet/workspace validators, protected CI and independent review.

**`transition` (Slice 2 only).** It starts only from the exact merged `SLICE1_SHA` after the complete pair has been refreshed, deterministically revalidated and independently reapproved. Exact argv is:

```text
<node-24-absolute> <SLICE1-trusted-worktree-absolute>/scripts/trusted-delivery-evidence-controller.mjs --mode transition --trusted-base <SLICE1_SHA> --trusted-worktree <SLICE1-trusted-worktree-absolute> --candidate-root <clean-Slice2-candidate-absolute> --candidate-activation contracts/delivery-acceptance-v2-activation.json --candidate-activation-map contracts/delivery-acceptance-v2-trusted-map.json --expected-repository Zkrausman/pi-sampler --expected-ticket AIDEV-191 --expected-ticket-revision <refreshed-ticket-revision> --expected-head <clean-Slice2-head> --expected-pr <Slice2-PR> --json
```

Trusted predecessor set is exactly `contracts/implementation-plan-manifest-v2.mjs`, `contracts/implementation-plan-manifest-v2.schema.json`, `scripts/validate-implementation-plan.mjs`, `scripts/trusted-delivery-evidence-controller.mjs`, `governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json`, `governance/pkg/deliveryevidence/acceptance_v2.go`, `governance/pkg/deliveryevidence/external_root_posix.go`, `governance/pkg/deliveryevidence/external_root_windows.go`, `governance/cmd/delivery-evidence-validator/main.go`, `profiles/project-profile.schema.json`, and `profiles/pi-sampler.json`. Every one is authenticated from `SLICE1_SHA` before candidate reads. `git cat-file -e <SLICE1_SHA>:contracts/delivery-acceptance-v2-activation.json` and the same command for `contracts/delivery-acceptance-v2-trusted-map.json` **must each fail specifically because the path is absent**; exit 0 is `transition_activation_already_present` or `transition_activation_map_already_present`, while any Git/object failure not exact path absence is `trusted_git_failure`. Candidate `contracts/delivery-acceptance-v2-activation.json` and sibling `contracts/delivery-acceptance-v2-trusted-map.json` are then read only from the clean exact candidate head as mode `100644`, type `blob`, bounded bytes/digests. The declaration has strict format `pi-sampler.delivery-acceptance-v2-activation`, version 1, state `active`; the map has strict format `pi-sampler.delivery-acceptance-v2-trusted-map`, version 1, and binds the declaration raw digest plus every authenticated predecessor and candidate Slice 2 profile/docs/skill digest. Both remain candidate data during transition and are never inserted into the trusted set or allowed to select behavior. Success emits `pi-sampler.delivery-v2-transition-receipt/v1`, `state=will-activate-after-merge`, `authority=false`.

**`validate` (only after Slice 2 activation merge).** Exact argv is:

```text
<node-24-absolute> <activated-trusted-worktree-absolute>/scripts/trusted-delivery-evidence-controller.mjs --mode validate --trusted-base <activated-base> --trusted-worktree <activated-trusted-worktree-absolute> --candidate-root <clean-candidate-absolute> --plan <relative-plan> --manifest <relative-manifest> --matrix <external-absolute-matrix> --evidence-root <external-absolute-root> --expected-repository <owner/repository> --expected-ticket <ticket> --expected-ticket-revision <40|64-hex> --expected-head <clean-head> --expected-pr <1..1000000000> --evaluation-scope <plan-publication|implementation-delivery> --json
```

Validate authenticates the complete transition predecessor set plus trusted `contracts/delivery-acceptance-v2-trusted-map.json` and `contracts/delivery-acceptance-v2-activation.json` from the exact activated base. It authenticates and strict-decodes the fixed-path map first, then reads the fixed-path declaration and compares its raw digest to `activation_sha256` in that trusted map; it also compares every mapped controller/runtime/schema/policy/profile digest before candidate reads. Both blobs require mode `100644`, type `blob`, strict format/version; declaration state is `active`. Missing declaration/map is `activation_absent`/`activation_map_absent`; malformed or mismatched bytes are `activation_invalid`, `activation_map_invalid`, or `trusted_digest_mismatch`. Candidate schema/controller/profile/policy/CLI/env/prompt cannot add, activate, replace or redirect trusted paths.

Mode outputs are canonical JSON + LF. Support keys are `format,version,status,authority,base_sha,head_sha,paths,test_report_sha256,repository_inventory_sha256` with `pi-sampler.delivery-v2-support-report`, 1, `functional-only`, false. Transition keys are `format,version,status,code,authority,trusted_base,candidate_head,repository,ticket_id,ticket_revision,pull_request_number,trusted_paths,activation_path,activation_sha256,activation_map_path,activation_map_sha256,candidate_paths,test_report_sha256,inventory_before_sha256,inventory_after_sha256,state`; constants are `pi-sampler.delivery-v2-transition-receipt`, 1, `valid`, `transition_ready`, false, and `will-activate-after-merge`. Trusted/candidate path arrays are sorted strict objects `path,sha256,bytes`. Validate returns only D1's `pi-sampler.delivery-acceptance-result/v1` envelope.

Mode failure precedence is `usage_invalid,mode_invalid,trusted_base_invalid,trusted_git_failure,trusted_blob_invalid,transition_activation_already_present,transition_activation_map_already_present,activation_absent,activation_map_absent,activation_invalid,activation_map_invalid,trusted_digest_mismatch,candidate_root_invalid,candidate_head_mismatch,candidate_not_clean,candidate_blob_invalid,candidate_inventory_changed,test_failed`. Support test failure is nonzero functional evidence, never an authority result. Unknown modes and mode-inapplicable argv are `usage_invalid`, exit 2.

### 3.2 Git/object and process policy

The controller must itself be run from `trusted-worktree`, require clean `git status --porcelain=v2 -z`, require `HEAD == trusted-base`, and verify its worktree/common-directory identities before use. Fixed Git discovery is `/usr/bin/git`, then `/usr/local/bin/git` on POSIX; on Windows it is `%ProgramFiles%\Git\cmd\git.exe`, then `%ProgramFiles%\Git\bin\git.exe`, with `ProgramFiles` read only to form those two absolute candidates. PATH, `GIT_EXEC_PATH`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY`, alternates, config-count variables, hooks, pager, askpass and SSH variables are ignored.

Every Git spawn is `shell:false`, timeout 30,000 ms, stdout <=8,388,608 bytes, stderr <=65,536 bytes, `windowsHide:true`, and environment limited to `SystemRoot`/`WINDIR` on Windows plus `LC_ALL=C`, `LANG=C`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` (`NUL` on Windows), `GIT_CONFIG_SYSTEM=/dev/null` (`NUL`), `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`. Commands use `git -C <trusted-worktree> cat-file`/`ls-tree`; no shell.

For every path required by the selected mode: `cat-file -t <base>` must be `commit`; `ls-tree -z <base> -- <path>` must return exactly one entry, mode `100644`, type `blob`, exact byte path; `cat-file -t <base>:<path>` must be `blob`; `cat-file -s` must be within the path's bound (contracts/profile/schema 2 MiB, controller/validator 4 MiB, Go source 2 MiB); `cat-file blob` is read once and raw-hashed. Symlink mode `120000`, tree, submodule `160000`, duplicate, oversized or digest drift is `trusted_blob_invalid`. Absence is valid only for the two transition activation/declaration-map path checks; any other absence is `trusted_blob_invalid`. Validate compares the trusted activation digest map before candidate reads; transition proves trusted activation absence before reading candidate activation.

The trusted planning validator route has two explicitly different scopes; neither may silently fall into the other.

**Committed exact-head scope (`implementation-delivery` and refreshed committed plan publication).** `trusted-worktree` is a detached, clean, no-remote checkout at exactly `trusted-base`; its absolute `scripts/validate-implementation-plan.mjs` is mode `100644`, type `blob`, size 62,467 bytes and raw SHA-256 `3bea29df796b108ba284ffed25094855253599bc7fe4d8c5c2a920b972ea62fc` before launch. Candidate root is a separate clean checkout whose `HEAD` equals `expected-head`; the controller verifies object format, commit object, Git common/object-directory identities, no alternates/replacements/grafts/shallow state, and base ancestry. For `plan_path` and `manifest_path`, it requires exactly one `expected-head:<path>` entry, mode `100644`, type `blob`, bounded size, and safe-reads the candidate regular file before and after. Both reads must byte-equal the corresponding `git cat-file blob expected-head:<path>` bytes and raw digest. Any tracked, staged, untracked or ignored candidate file, head drift, mode/type/size/digest drift, symlink/reparse ancestor, common-dir/object identity drift, or before/after inventory drift blocks.

The validator executable is the verified **absolute trusted-worktree path**, but its process `cwd` is deliberately the clean candidate root. Thus the validator's `process.cwd()` resolves candidate Git identity and candidate plan/manifest paths, while relative ESM imports from the absolute trusted script resolve the trusted-base contract module. The validator itself continues to read `profiles/pi-sampler.json` from the exact trusted base selected by `--base`; it never imports the candidate profile. Exact inner argv is:

```text
<node-24-absolute> <trusted-worktree-absolute>/scripts/validate-implementation-plan.mjs --plan <plan_path> --manifest <manifest_path> --base <trusted-base> --profile profiles/pi-sampler.json --repository <expected-repository> --ticket <expected-ticket> --ticket-revision <expected-ticket-revision> --json
```

Spawn is `shell:false`, timeout 120,000 ms, stdout <=1,048,576 bytes, stderr <=65,536 bytes, `windowsHide:true`; stdin is closed. Environment is only `SystemRoot`/`WINDIR` on Windows plus `LC_ALL=C`, `LANG=C`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` (`NUL` on Windows), `GIT_CONFIG_SYSTEM=/dev/null` (`NUL`), `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_REPLACE_OBJECTS=1`, `NODE_NO_WARNINGS=1`. PATH, NODE_PATH, NODE_OPTIONS, loaders/import hooks and all Git selector/config/askpass/SSH variables are absent. Node major must be exactly 24. The one JSON line must be `ok:true`, bind all exact argv values, and report digests equal to the already-read head blobs.

**Uncommitted plan-publication scope.** The same absolute trusted validator may run with `cwd` at the leased planning candidate and safe-read the two authorized uncommitted files, but the result envelope is labelled `scope=uncommitted-plan-publication`, binds no `expected-head`, cannot yield `implementation-delivery`, `valid/observed`, packet, receipt, marker, push or merge authority, and is consumed only by the one-time parent bootstrap. Exactly two untracked planning paths and unchanged base HEAD are required.

After successful validation, JS emits the normalized request to `go run ./cmd/delivery-evidence-validator -mode acceptance-v2` with `cwd=<trusted-worktree>/governance`, Go version from `governance/go.mod` exactly `1.25.0`, stdin <=12 MiB, stdout/stderr bounds above and timeout 900,000 ms. Request keys are `format,version,normalized_facts,facts_sha256,matrix_base64,evidence_root,policy,controller_time`; `format=pi-sampler.delivery-acceptance-request`, version 1. Matrix bytes, not a live path, cross the Go boundary. Policy is normalized from the authenticated profile blob.

Failure precedence before D1 semantic precedence is `trusted_checkout_invalid`, `trusted_validator_blob_invalid`, `candidate_root_invalid`, `candidate_git_identity_invalid`, `candidate_head_mismatch`, `candidate_not_clean`, `candidate_blob_invalid`, `candidate_file_mismatch`, `candidate_inventory_changed`, `validator_spawn_failed`, `validator_output_invalid`, `manifest_validator_failed`. Before and after records include trusted/candidate HEAD, status bytes, common/object identities, object format, exact path blob IDs/modes/sizes/raw digests, safe-file identities/digests and the complete bounded inventories. No process writes either checkout.

## 4. D3 — complete external evidence-root/no-mutation contract

The absolute evidence root is supplied only by the operator/controller argv. Matrix bytes contain only `evidence_root_id`. The root is not read from candidate files, profile overrides, environment or prompt.

1. **Canonical root/exclusions:** reject relative, empty, UNC/device (`\\.\`, `\\?\`, `//`), drive-relative, trailing-dot/space Windows segments, NUL/control, non-UTF-8 or >1,024-byte absolute paths. Open the existing directory and derive its final canonical path and identity. It must be disjoint (neither equal, ancestor nor descendant) from candidate root, trusted worktree, Git common directory, object directory, repository root, profile `worktreeRoot`, `review.workspaceRoot`, `review.quarantineRoot`, and controller temp directory. Windows comparisons use final-handle paths with `\\?\` removed, separators normalized, and invariant case folding; POSIX comparisons use exact bytes. macOS case behavior is determined by a create/probe in the operator root and aliases are rejected if case-insensitive.
2. **Ancestor traversal:** from filesystem root to evidence root, `lstat`/handle-open every existing segment; reject symlink, mount substitution, junction, any reparse tag, non-directory, device, socket, FIFO, or identity change. Capture each ancestor's device/volume and file ID before enumeration and re-open/recompare after. Root and all artifacts must stay on the root device/volume.
3. **Path grammar:** artifact relative path rules are Section 2.3. Normalize no Unicode; reject any two raw names that compare equal under the filesystem's case behavior. Depth <=10 segments, each name 1..255 UTF-8 bytes, relative path <=240 bytes. No glob/search.
4. **Enumeration:** recursively enumerate with directory handles, sorted by raw relative UTF-8 bytes. Bounds: <=1,000 entries including directories, <=10 depth, <=10,485,760 bytes per file, <=104,857,600 aggregate file bytes. Reject unreferenced files except the single controller-produced inventory report; reject sparse allocation mismatch, alternate data streams, executable device nodes and every non-regular file. POSIX requires `st_nlink==1`; Windows `NumberOfLinks==1`; hard-linked files fail `evidence_root_invalid`.
5. **Race-safe read:** POSIX opens each segment relative to its already-open parent using `openat` with `O_NOFOLLOW|O_CLOEXEC`, then the file `O_RDONLY|O_NOFOLLOW`; Windows uses `CreateFileW` with `FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS`, denies write/delete sharing, checks `FileAttributeTagInfo`, volume serial and `FILE_ID_128`. Before read and after EOF, compare type, device/volume, file ID, link count, mode/attributes, size and modification/creation metadata from `fstat`/handle APIs. Read exactly declared `bytes`, require EOF, hash during read, and compare declared SHA-256. Re-open and recompare all ancestor handles after every file and after enumeration. Any swap is `evidence_identity_changed`.
6. **Inventories/no mutation:** before semantic work, capture (a) candidate repository HEAD, branch/detached state, Git common/object identities, `git status --porcelain=v2 -z --untracked-files=all`, tracked-index digest and sorted untracked `path,size,sha256` inventory, and (b) the full evidence-root identity inventory. Git/status output is bounded to 8 MiB and 30 seconds; overflow blocks. Repeat both after every artifact read and before return. Exact before/after bytes and identities must match. A mismatch returns `source_mutated`, discards any otherwise-valid result, writes no repository/evidence/replay bytes, and requires a fresh run.
7. **No v1 inheritance:** v2 never calls `externalPath`, waiver replay, candidate-root schema lookup, `os.Stat` then `os.ReadFile`, or v1 benchmark-path code. There is no first-create operation. All evidence must pre-exist; the validator is read-only.

Platform tests must create real symlinks on POSIX and real junction/reparse/hard-link cases on Windows when privileges permit. A skipped privileged Windows case is reported `blocked/windows_capability_unavailable`, never passed; portable case/path simulations still run in protected Linux CI, but the plan makes no claim that protected Windows CI exists.

## 5. D4 — exact old-base-valid implementation protocol

All shell variables below are authority inputs, not defaults. `CANDIDATE_HEAD`, `PR_NUMBER`, `MATRIX` and `EVIDENCE_ROOT` must be supplied as full authenticated values by the persistent parent; an empty value blocks. The exact Slice 1 setup/preflight is:

```sh
export REPOSITORY='Zkrausman/pi-sampler'
export TICKET='AIDEV-191'
export TICKET_REVISION='80a83a007ceffd8f35a6be12b97c01f781b1f7b67874cc2b7c2185c053e84384'
export BASE='3d858a0d4f8219f5ca1db13ad1de72e35ee09758'
export PROFILE='profiles/pi-sampler.json'
export PLAN='docs/techPlans/AIDEV-191-implementation-plan.md'
export MANIFEST='docs/techPlans/AIDEV-191-acceptance-manifest-v2.json'
export BASE_ROOT='<persistent-parent clean checkout at BASE>'
export CANDIDATE_ROOT='<leased Slice 1 candidate worktree>'
test "$(git -C "$BASE_ROOT" rev-parse HEAD)" = "$BASE"
test -z "$(git -C "$BASE_ROOT" status --porcelain=v1)"
test "$(node -p 'process.versions.node.split(`.`)[0]')" = '24'
test "$(cd "$BASE_ROOT/governance" && go env GOVERSION)" = 'go1.25.0'
(cd "$BASE_ROOT" && npm test)
(cd "$BASE_ROOT/governance" && go test -race ./...)
```

PowerShell uses the same literal values, `Set-Location`, `git -C`, `node.exe`, and `go.exe`; it may not replace the exact argv with a shell string. Both platforms require exact exit 0 and retained output digest before candidate functional tests.

### 5.1 Plan-publication bootstrap

Set `BASE=3d858a0d4f8219f5ca1db13ad1de72e35ee09758`, `PLAN=docs/techPlans/AIDEV-191-implementation-plan.md`, `MANIFEST=docs/techPlans/AIDEV-191-acceptance-manifest-v2.json`, `PROFILE=profiles/pi-sampler.json`, `TICKET_BINDING=<parent-local frozen copy of planning/ticket-binding.json>`, `PARENT_INPUT=<parent-local bootstrap-input-v1.json>`, `MATRIX=<parent-local acceptance-matrix-v1.json>`, and `PARENT_CHECKER=<parent-authored check-aidev-191-bootstrap-v1.mjs>`. None is selected from candidate content. First run the trusted validator in Section 3's uncommitted-plan-publication scope with the exact documented argv:

```text
<node-24-absolute> <trusted-checkout-absolute>/scripts/validate-implementation-plan.mjs --plan docs/techPlans/AIDEV-191-implementation-plan.md --manifest docs/techPlans/AIDEV-191-acceptance-manifest-v2.json --base 3d858a0d4f8219f5ca1db13ad1de72e35ee09758 --profile profiles/pi-sampler.json --repository Zkrausman/pi-sampler --ticket AIDEV-191 --ticket-revision 80a83a007ceffd8f35a6be12b97c01f781b1f7b67874cc2b7c2185c053e84384 --json
```

The old-base-owned checker source is authored and frozen by the persistent parent outside the candidate repository. Its raw SHA-256 and absolute path are recorded in `PARENT_INPUT`; it imports only Node-24 standard modules. It reads the trusted schema with `git -C <detached-clean-no-remote-base-checkout> cat-file blob 3d858a0d4f8219f5ca1db13ad1de72e35ee09758:governance/docs/delivery-evidence/acceptance-matrix-v1.schema.json`, requires mode `100644`, type `blob`, 6,396 bytes and SHA-256 `c52283e1d360491ff67f90d1801f2f5ee7b98f4df9ff6e4c8c9f8dd3d94c0021`, and implements every root/row/property type, enum, pattern and numeric/string/array bound from that exact schema. It does **not** call candidate code, the old Go manifest validator, or matrix-v2 code.

`PARENT_INPUT` is strict canonical JSON with keys `format,version,repository,ticket_id,ticket_revision,ticket_binding_path,ticket_binding_sha256,profile_path,profile_sha256,profile_bytes,base_sha,head_sha,pull_request_number,plan_path,plan_sha256,plan_raw_sha256,plan_bytes,manifest_path,manifest_sha256,manifest_bytes,review_path,review_sha256,review_bytes,review_decision,started_at,completed_at,generated_at,checker_path,checker_sha256` in that order; format is `pi-sampler.aidev-191-bootstrap-input`, version 1. It binds authenticated exact-head PR state and the final approved same-reviewer report (`review_decision=approved`).

The checker safe-reads the exact frozen `ticket-binding.json` bytes before and after, computes raw SHA-256, and requires `80a83a007ceffd8f35a6be12b97c01f781b1f7b67874cc2b7c2185c053e84384`; this digest **is** the trusted ticket revision and no `ticket_revision` JSON member is expected. The strict binding object may contain only its frozen keys. The checker reads and compares only real members: `ticket="AIDEV-191"`, `trusted_base="3d858a0d4f8219f5ca1db13ad1de72e35ee09758"`, `trigger_pr=172`, `github_snapshot_sha256="4baf5467e678d702b05ce40e90bb700b248fc1421147d88d3da482d5de59be13"`, `trigger_review_report_sha256="878e45ef8af52b0b16a86caf98e4ad0dd382fd4441973fb02e436a6086f26da8"`, parent `AIDEV-168`, relations `blocks=["AIDEV-187"],blocked_by=[],related_to=["AIDEV-182","AIDEV-158","AIDEV-169"]`, and authority `explicit_user_planning_authorization`. `github_issue="Zkrausman/pith#58"` is retained only as ticket-mirror identity and is never interpreted as this repository.

Repository authority comes only from `git -C <detached-clean-base-checkout> ls-tree/cat-file` for exact `3d858a0d4f8219f5ca1db13ad1de72e35ee09758:profiles/pi-sampler.json`. Require one entry, mode `100644`, type `blob`, size 2,748 bytes, raw SHA-256 `96e4b00bc78b16b5e544ee48f369137c74a2ef040c7b226b5c88d542d2e6a6c9`; strict-decode it and require `repository.source="Zkrausman/pi-sampler"`. `PARENT_INPUT.profile_path/profile_sha256/profile_bytes`, `repository`, `ticket_id`, `ticket_revision`, `base_sha` and `pull_request_number` must equal those independently derived values. Candidate profile, GitHub mirror repository text and parent-authored overrides cannot replace them.

`plan_sha256` is historical-v1 LF-normalized SHA-256; all other digests are raw bytes. Byte counts are exact nonnegative integers and ticket/profile/plan/manifest/review safe-read bytes, identities and digests must match before and after.

The only truthful bootstrap row has exact key order `id,status,observed`; `status="observed"`. `observed` has exact key order and values:

| Key | Frozen bootstrap value |
|---|---|
| `acceptance_class` | `requirement` for every row; this means only “the exact requirement is specified in the independently approved plan” |
| `verifier` | `aidev-191-plan-specification-parent` |
| `command` | the exact trusted-validator argv printed above, joined by one ASCII space without shell expansion |
| `tool_version` | `pi-sampler.implementation-plan-validator/v1@3bea29df796b108ba284ffed25094855253599bc7fe4d8c5c2a920b972ea62fc` |
| `environment_class` | `review` |
| `exit_status` | integer `0` |
| `started_at` / `completed_at` | exactly the corresponding `PARENT_INPUT` timestamps |
| `artifacts` | exactly three objects in order: plan, manifest, approved review |

Artifact objects have exact key order `name,sha256,bytes`. Names are `AIDEV-191-implementation-plan.md`, `AIDEV-191-acceptance-manifest-v2.json`, `AIDEV-191-independent-plan-review.md`; values equal the input's `plan_raw_sha256/plan_bytes`, `manifest_sha256/manifest_bytes`, and `review_sha256/review_bytes`. No benchmark evidence is allowed. Waiver, blocker, a second payload, ordinary/authority class, implementation verifier/command, arbitrary artifact or timestamp is rejected.

Matrix canonical bytes are exactly one-line UTF-8 without BOM followed by one LF. Root key order is `schema_version,ticket_id,repository,plan_sha256,manifest_sha256,base_sha,head_sha,pull_request_number,generated_at,rows`; each row and nested object uses the orders above. Canonical strings/numbers use `JSON.stringify` shortest encoding; arrays retain order; there is no insignificant whitespace. The checker parses bounded JSON, reconstructs this one permitted object from trusted input plus manifest tuples, serializes `JSON.stringify(expected)+"\n"`, and requires raw byte equality with `MATRIX`. Consequently duplicate keys, aliases, unknown keys, reordered keys, BOM, noncanonical whitespace, and trailing bytes cannot survive even though ordinary `JSON.parse` is used only after the byte equality candidate is bounded. Matrix <=2 MiB, nesting <=16, rows exactly 12.

Root values must be exactly `acceptance-matrix/v1`, `AIDEV-191`, `Zkrausman/pi-sampler`, input plan digest, raw v2 manifest digest, `3d858a0d4f8219f5ca1db13ad1de72e35ee09758`, authenticated exact head, authenticated PR 1..1,000,000,000, input `generated_at`, and the 12 rows. Dates are exact UTC-millisecond `YYYY-MM-DDTHH:MM:SS.sssZ`; `started_at <= completed_at <= generated_at <= checker_clock+300s`, duration <=120,000 ms, and generated time is not before approved-review completion. The checker compares all 12 complete plan checklist `{id,requirement}` values to manifest `{id,acceptance_class,requirement}` in order and uniqueness, then binds each matrix ID to that exact tuple and the three artifacts; count-only/ID-only comparison is impossible.

Exact execution is:

```text
<node-24-absolute> <PARENT_CHECKER-absolute> --base-checkout <detached-clean-base-checkout-absolute> --input <PARENT_INPUT-absolute> --plan <PLAN-absolute> --manifest <MANIFEST-absolute> --matrix <MATRIX-absolute> --json
```

It uses `shell:false`, closed stdin, timeout 120,000 ms, stdout <=1 MiB, stderr <=64 KiB and Section 3's sanitized environment. Exit 0 emits canonical keys `format,version,status,code,repository,ticket_id,ticket_revision,ticket_binding_sha256,profile_path,profile_sha256,base_sha,head_sha,pull_request_number,plan_sha256,manifest_sha256,matrix_sha256,schema_sha256,tuple_sha256,parent_input_sha256,semantics,implementation_attested` with constants `pi-sampler.aidev-191-bootstrap-report`, 1, `valid`, `specified`, semantics=`matrix-v2-unavailable;plan-requirements-specified-only`, `implementation_attested=false`. Schema/canonical/binding/tuple/evidence/time/inventory failures are exits 1 with stable first codes `schema_blob_invalid,ticket_binding_invalid,profile_blob_invalid,matrix_json_invalid,matrix_noncanonical,matrix_schema_invalid,binding_mismatch,tuple_mismatch,evidence_mismatch,time_invalid,source_mutated`; usage is exit 2.

Child launch is permitted only after this checker, old-base review-workspace isolation/packet validation, receipt/marker lifecycle **preflight tests**, exact-head protected CI, and parent clean/no-mutation inventories pass. The fresh child then runs; only afterward may a receipt be created and marker rendered/revalidated under the unchanged old-base lifecycle. Any candidate v2 execution, alias/projection, implementation claim, arbitrary observed evidence, dirty parent, or stale binding blocks. The bootstrap report explicitly cannot attest implementation, approve the plan by itself, publish a marker, or grant any lifecycle authority.

### 5.2 Slice 1 — inert additive support

Start from exactly `BASE`; candidate allowlist is exactly the Slice 1 New/Modified paths in Section 8. Required order:

1. predecessor-base preflight in a clean base checkout: Node major 24, `npm test`, then from `governance` Go 1.25.0 `go test -race ./...`; preserve JSON/TAP and SHA-256;
2. implement only Slice 1 paths; activation declaration must be absent and trusted profile digest must remain `96e4b00bc78b16b5e544ee48f369137c74a2ef040c7b226b5c88d542d2e6a6c9`;
3. candidate functional commands: `node --test tests/delivery-acceptance.test.mjs tests/delivery-acceptance-v2.test.mjs`, `node scripts/run-governance-tests.mjs`, then `npm test`; each exit 0 with nonzero named discovery;
4. run only Section 3's `support` candidate unit/integration commands. The candidate harness emits `pi-sampler.delivery-v2-support-report/v1` containing exact candidate head and raw digests of schema, controller, Go runtime, CLI and tests, with `status=functional-only,authority=false`. Do not invoke `transition` or `validate`; old-base trusted review-policy/packet/workspace/CI and independent review are the sole authority;
5. exact-head independent review and protected predecessor-base CI occur before merge. Candidate tests are functional evidence, never authority. Preserve complete packet/matrix/evidence/receipt ordering.

The output report fields are `format,version,base_sha,head_sha,paths` where paths are sorted objects `path,sha256,bytes`, then `test_report_sha256`, `repository_inventory_sha256`, `status=functional-only`, `authority=false`; canonical JSON + LF. Its raw digest is `SLICE1_OUTPUT_SHA256`, but it is non-authoritative evidence consumed by old-base review, never its replacement.

### 5.3 Mandatory refreshed plan then Slice 2 activation

After Slice 1 merges, capture full lowercase `SLICE1_SHA`; require `git merge-base --is-ancestor 3d858a0d4f8219f5ca1db13ad1de72e35ee09758 $SLICE1_SHA` and require its support report to bind that exact head. Because those values cannot truthfully be predicted here, **this plan becomes stale**. Refresh both artifacts and renew independent approval before Slice 2; do not encode AIDEV-191 as its own dependency.

Slice 2 begins exactly at refreshed `SLICE1_SHA`. The trusted predecessor controller uses Section 3's exact `transition` argv, authenticates the predecessor set, proves trusted activation-path absence, and reads only the candidate-head activation declaration and trusted digest map plus the allowed Slice 2 profile/README/planning-doc/two-skill changes as candidate data. It checks each candidate blob, complete candidate tests, no other diff, and emits `pi-sampler.delivery-v2-transition-receipt/v1` with exact old/new digests, candidate head, `state=will-activate-after-merge`, matrix-v2 positive/negative report digest, and inventories. The candidate declaration is data under test and cannot switch the predecessor run to `validate`. A no-self-validation test copies hostile controller/schema/profile/activation bytes into candidate root and expects identical predecessor output.

After reviewed Slice 2 merge, exact bases containing the declaration may run `--mode validate`; bases without it remain v1-only. The profile adds exactly one argv-array verification command for the trusted controller; docs describe the split. Exact-head independent review, protected base-selected CI, packet/receipt/marker privacy and user-only merge authority remain unchanged.

## 6. D5 — common executable acceptance evidence rules

The following is the complete non-vacuous command map; there is no implicit `Txx` substitution. Node cwd is repository root and Go cwd is `governance`:

| ID | Exact Node-24 command | Exact Go-1.25.0 command |
|---|---|---|
| T01 | `node --test --test-name-pattern "^A191-T01 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T01$' -count=1 -v` |
| T02 | `node --test --test-name-pattern "^A191-T02 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T02$' -count=1 -v` |
| T03 | `node --test --test-name-pattern "^A191-T03 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T03$' -count=1 -v` |
| T04 | `node --test --test-name-pattern "^A191-T04 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T04$' -count=1 -v` |
| T05 | `node --test --test-name-pattern "^A191-T05 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T05$' -count=1 -v` |
| T06 | `node --test --test-name-pattern "^A191-T06 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T06$' -count=1 -v` |
| T07 | `node --test --test-name-pattern "^A191-T07 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T07$' -count=1 -v` |
| T08 | `node --test --test-name-pattern "^A191-T08 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T08$' -count=1 -v` |
| T09 | `node --test --test-name-pattern "^A191-T09 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T09$' -count=1 -v` |
| T10 | `node --test --test-name-pattern "^A191-T10 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T10$' -count=1 -v` |
| T11 | `node --test --test-name-pattern "^A191-T11 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T11$' -count=1 -v` |
| T12 | `node --test --test-name-pattern "^A191-T12 " tests/delivery-acceptance-v2.test.mjs` | `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T12$' -count=1 -v` |

Every A191 test is implemented as an exact named Node test in `tests/delivery-acceptance-v2.test.mjs` and, where Go-specific, an exact named Go subtest under `TestAcceptanceV2/A191-Txx` in `governance/pkg/deliveryevidence/validator_test.go`. Node commands run at repository root with Node 24; Go commands run at `<root>/governance` with Go 1.25.0. `node --test --test-name-pattern "^A191-Txx " tests/delivery-acceptance-v2.test.mjs` must report exactly one pass, zero fail and at least one assertion; `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-Txx$' -count=1 -v` must report the exact subtest and `PASS`. A name-discovery wrapper in the Node fixture fails if selected-pass count is not one; thus filters cannot pass vacuously.

Each test captures before/after repository and external-root inventories and writes no repository artifact. Test reports are canonical JSON in an operator temp root, contain command/versions/exit/stable code/assertion count/inventory digests, and are raw-hashed. The next gate receives that report digest. Linux protected CI runs portable/POSIX cases. Windows local PowerShell runs the identical argv with `node.exe` and `go.exe`; privileged inability is blocked, not skipped/pass.

Authoritative predecessor-base commands are always separate from candidate functional commands: base-selected review/CI validates activation and lifecycle; candidate tests only prove proposed behavior. Exact per-ID routes are in Section 11.

## 7. Bootstrap matrix and truthful publication lifecycle

The matrix-v1 bootstrap is exactly Section 5.1's canonical object and no other matrix. `plan_sha256` follows historical v1 LF-normalization only at the root; `manifest_sha256` is exact v2 manifest bytes. Every row is schema-valid `observed`/`requirement` evidence solely for independently approved plan specification, with the single frozen verifier/command/timestamps and exact plan/manifest/review artifacts. The parent report binds ticket revision and tuple requirement/class text because historical matrix-v1 has no such fields. It says matrix-v2 semantics are unavailable and `implementation_attested=false`. This one-time authority applies only to AIDEV-191 and cannot become a general projection.

Ordering is producer evidence -> trusted validator -> persistent-parent exact tuple/inventory check -> fresh final child -> receipt -> minimal marker -> pre-push fixed-receipt validation -> trusted-base CI. Matrix structural validity never launches the child by itself. Marker and CI remain evidence, not approval or merge authority.

## 8. D7 — complete inventories, slice ownership, consumers

Every New/Modified ordinary path appears in `ownership.files` and belongs to exactly one slice. Dot-prefixed paths are represented as `path:` symbols because the manifest file-path grammar cannot encode them.

### Slice 1 — New

* `governance/pkg/deliveryevidence/acceptance_v2.go`
* `governance/pkg/deliveryevidence/external_root_posix.go`
* `governance/pkg/deliveryevidence/external_root_windows.go`
* `governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json`
* `scripts/trusted-delivery-evidence-controller.mjs`
* `tests/delivery-acceptance-v2.test.mjs`
* `tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md`
* `tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json`

### Slice 1 — Modified

* `governance/cmd/delivery-evidence-validator/main.go`
* `governance/pkg/deliveryevidence/validator_test.go`
* `tests/delivery-acceptance.test.mjs`
* `package.json` (adds a fixed argv script only; no dependency or lockfile change)

### Slice 2 — New

* `contracts/delivery-acceptance-v2-activation.json`
* `contracts/delivery-acceptance-v2-trusted-map.json`

### Slice 2 — Modified

* `profiles/pi-sampler.json`
* `governance/docs/delivery-evidence/README.md`
* `docs/IMPLEMENTATION-PLANNING.md`
* `.agents/skills/project-delivery/SKILL.md`
* `.agents/skills/create-implementation-plan/SKILL.md`

### Read-only behavioral fixtures/consumers

* `governance/pkg/deliveryevidence/acceptance.go`
* `governance/pkg/deliveryevidence/schema.go`
* `governance/docs/delivery-evidence/acceptance-manifest-v1.schema.json`
* `governance/docs/delivery-evidence/acceptance-matrix-v1.schema.json`
* `contracts/implementation-plan-manifest-v2.mjs`
* `contracts/implementation-plan-manifest-v2.schema.json`
* `scripts/validate-implementation-plan.mjs`
* `profiles/project-profile.schema.json`
* `scripts/generate-review-packet.mjs`
* `scripts/validate-review-packet.mjs`
* `scripts/review-policy.mjs`
* `scripts/validate-dco.mjs`
* `scripts/final-review-receipt.mjs`
* `scripts/validate-adversarial-review-attestation.mjs`
* `scripts/hooks/pre-push.mjs`
* `scripts/hooks/pre-push-protocol.mjs`
* `tests/final-review-receipt.test.mjs`
* `tests/adversarial-review-attestation.test.mjs`
* `governance/pkg/deliveryevidence/validator.go`
* `scripts/validate-delivery-evidence.mjs`
* `scripts/validate-delivery-schemas.mjs`
* `scripts/export-implementation-plan-manifest-v2-schema.mjs`
* `tests/implementation-plan-manifest-v2.test.mjs`
* `tests/validate-implementation-plan.test.mjs`
* `tests/scoped-review-packet.test.mjs`
* `docs/SCOPED-REVIEW.md`
* `.github/workflows/adversarial-review.yml`
* `.github/workflows/validate.yml`
* `.github/pull_request_template.md`

Affected contracts are `acceptance-matrix/v2`, exact `implementation-plan-manifest/v2` admission, `delivery-normalized-facts/v1`, `delivery-acceptance-result/v1`, `external-evidence-root/v2`, frozen v1 dispatch, activation-v1, trusted-activation-map-v1 and final-review lifecycle-v3. Affected packages/consumers are Node root scripts/tests/profile, Go `governance/cmd/delivery-evidence-validator`, Go `governance/pkg/deliveryevidence`, planning and delivery skills/docs, packet/receipt/marker/pre-push/base-selected CI. Modified files are never hidden as symbols.

## 9. D4/D8 — sanitized rollback and frozen legacy behavior

### 9.1 Sanitized rollback

Rollback is a new separately reviewed safe-state commit. Preferred rollback removes only `contracts/delivery-acceptance-v2-activation.json`, `contracts/delivery-acceptance-v2-trusted-map.json`, and the v2 profile command while retaining reviewed inert support and manual/uncommitted planning. It must pass predecessor-base v1 regressions and prove that `--mode validate` returns `activation_absent`. If inert support itself is unsafe, replace the controller entry with a reviewed fail-closed stub returning `planning_disabled`/`activation_absent`; retain historical plans/manifests/evidence. Never restore automatic commit/push/PR/tracker/publication/merge, automatic Antigravity, the retired team wrapper, waiver replay, or candidate-selected activation. Rollback needs independent review, publication and explicit later action authorities; it is not “revert PR.”

### 9.2 Frozen v1 bytes and results

The following trusted-base raw byte digests are immutable:

| Frozen artifact/function boundary | SHA-256 |
|---|---|
| `acceptance-manifest-v1.schema.json` | `03733cedbc78f42ffc9268d7da7071184b2bf2ab702a0d4211237b278526d53d` |
| `acceptance-matrix-v1.schema.json` | `c52283e1d360491ff67f90d1801f2f5ee7b98f4df9ff6e4c8c9f8dd3d94c0021` |
| `acceptance.go` containing `validateAcceptanceManifest`, `ValidateAcceptanceManifestFile`, `ValidateAcceptanceMatrixBundle`, `ValidateAcceptanceBundle`, `canonicalPlanSHA256`, `acceptanceIDRe`, `planIDRe` | `1ada2e07253b0b1c5053461cb9d2e4689b14948358b779b847842d50033fcfb6` |
| `schema.go` containing `publishedSchemaPath`, `validatePublishedSchema` | `99a2acfc90622040995864b48f1194b919f2a679f7460df57d8a5aa8eddf83fd` |

Tests hash these exact blobs from base and run canonical AIDEV-158 v1 fixtures through the legacy CLI. A golden result records legacy stdout `delivery evidence valid\n`, exit 0 for accepted bytes, and the existing exact stderr/exit behavior for each frozen rejection fixture. The implementation first freezes those fixture-byte/result vectors in test data generated from base; it does not modify the v1 code to manufacture parity. Explicit negatives prove v1 IDs are not aliases for v2, v1 is never projected/upgraded, v2 is never downgraded, and v2 dispatch cannot call a v1 function.

### 9.3 Unchanged review lifecycle

The exact trusted-base raw-byte map is complete and unabridged:

| Exact path at `3d858a0d4f8219f5ca1db13ad1de72e35ee09758` | SHA-256 |
|---|---|
| `scripts/final-review-receipt.mjs` | `6f54daaf0ca4d9e9d77a7b6ae10ef501dfefdcd3f95f86b0cf436494f36b8f70` |
| `scripts/validate-adversarial-review-attestation.mjs` | `3f82e8ac12170dff1dd97be463714000999fee1d23c01b4f436593b976771716` |
| `scripts/hooks/pre-push.mjs` | `909cbd70be40b99cd08c2087e4ed47a9e9fcc9cbef7147e40c938f100748d992` |
| `.github/workflows/adversarial-review.yml` | `f13e54e13a3fa6243fce15c71e1cd8b85ab186d58ce8e17eb365bb001847e9cc` |
| `.github/workflows/validate.yml` | `35c3e2e44099b88a877185670e6a6df9b6da5b404fdb9290d404bd5fed0dbdef` |
| `.github/pull_request_template.md` | `39487f1e424b45a10ecab24cacb6ad45af79e0bab2873623f17b36f8420240c1` |

These values are bound to these paths, not to similarly named files. The same base separately hashes `scripts/generate-review-packet.mjs` as `11ebb005703f69a4431e4a28fdc050409a442e340cc09902c82a348272bff2b2`, `scripts/review-policy.mjs` as `12d32a4b589dc1d1b05089409cc65e4fffcd7867b5eee438b140688a01cc7b4f`, and `docs/SCOPED-REVIEW.md` as `46513d14f2c6da3e7290a80db3283b61668bc48e25485c3bc3a060ab28c1fe16`; `.github/workflows/test.yml` is absent. A path/digest alias or invented absent path is `trusted_blob_invalid`, never compatibility evidence.

T12's exact immutable-map command, from repository root with the test itself loading fixed Git and `cat-file` blobs from the exact trusted base, is:

```text
node --test --test-name-pattern "^A191-T12 trusted lifecycle blob map$" tests/delivery-acceptance-v2.test.mjs
```

It must discover exactly one test, make at least nine raw blob assertions plus the absent-path assertion, and exit 0. The test authenticates commit/type/mode/size before hashing, compares the complete map above, checks candidate substitutions do not affect output, and writes only a parent-external canonical report digest. Integration tests also execute packet-v3, receipt-v1, marker-v3, receipt revocation, same-base/head revocation invalidation, fixed `artifacts/final-review/receipt.json` pre-push, trusted `pull_request_target` base-validator selection, opaque private matrix/evidence digests, DCO and profile `blockedByDefault:true,userOnly:true,unlockPhrase:"Merge PR #N"`. All lifecycle files remain read-only. Any byte change blocks before behavior is considered.

## 10. D6 — exact AIDEV-187 compatibility and PR #172 refresh

Fixture source is immutable Git object `992ba9bbf044dcaecce1e751695834894aa2d9ea`:

* `docs/techPlans/AIDEV-187-implementation-plan.md`: Git blob `69dcd2680600d15f15a850defbcdfbad4ba51cea`, 44,524 bytes, SHA-256 `e88bafec7997fa247e56451dc72fd49007e9ac1128679d9ee21a6cc061848744`;
* `docs/techPlans/AIDEV-187-acceptance-manifest-v2.json`: Git blob `817aafda0556dd20fda75e735891a0d7aa5616cd`, 17,392 bytes, SHA-256 `f11f7b638adfec563482163f91d299df00467a3909bb27458cc9da8c6025dabc`;
* ticket revision `08967f81071a97e0fa0adb2430906e04fd448413ad41546e6f0b19fa5d24f5d4`; old base `3d858a0d4f8219f5ca1db13ad1de72e35ee09758`.

The fixture copy must byte-equal those Git blobs. Its exact ordered tuples are:

| ID | Class | Exact requirement |
|---|---|---|
| `AIDEV-187-1` | `authority` | The optional schema bridge is admitted by the original-base preflight and full profile tests while current profile, trusted loader, active review scripts, and v3 behavior remain byte-identical. |
| `AIDEV-187-2` | `authority` | Exact-base policy loading and resolution ignore untrusted selectors and follow the fixed catalog, profile-admission, considered-set, availability, precedence, and golden-envelope rules. |
| `AIDEV-187-3` | `ordinary` | The adopted profile resolves manual Antigravity Gemini planner, Luna implementer, Sol primary reviewer, and Sol final reviewer with exact selected envelopes. |
| `AIDEV-187-4` | `authority` | Terra direct selection and same-model Sol role assignments resolve without override or model-inequality trust checks, while context admission remains unavailable. |
| `AIDEV-187-5` | `ordinary` | Allowlisted override, both zero-based fallback positions, malformed availability, unsupported catalogs, nonallowed override, exhaustion, and unspecified policy return exact golden envelopes. |
| `AIDEV-187-6` | `resource-bounded` | Policy and resolution canonical bytes, null or zero-based fallbackIndex values, bounds, and domain-separated digest vectors are identical on Windows and Linux. |
| `AIDEV-187-7` | `authority` | The byte-preserving context consumer rejects self-attestation, keeps the dispatch unavailable, and freezes the exact bounded provider-v1 request, result, module, digest, timeout, and error interface for AIDEV-190. |
| `AIDEV-187-8` | `authority` | Packet v4 exactly maps packet v3 including canonical root package-lock admission through 524288 bytes and ordinary 131072-byte endpoints, binds policy/context digests, rejects stale policy, and remains non-authoritative. |
| `AIDEV-187-9` | `authority` | Receipt v2 binds policy and context digests at root and every pass, and marker v4 follows the exact grammar and key order while preserving lifecycle, revocation, provenance, privacy, and inactive publication. |
| `AIDEV-187-10` | `authority` | Immutable dispatch and package-lock boundary parity preserve packet v3, receipt v1, marker v3, terra-final-v1, and terra-parent bytes/results without invented fields, silent upgrade, reinterpretation, or downgrade. |
| `AIDEV-187-11` | `ordinary` | Every model-neutral agent, skill, API, template, documentation, compatibility alias, test, and fixture path is correctly classified and assigned to exactly one slice. |
| `AIDEV-187-12` | `authority` | All slices use the exact external dependency lease, preceding-base admission, path allowlists, non-vacuous tests, independent review, protected CI, and restored no-residue status while publishing downstream digests without activating v4. |

Compatibility is two separate fixtures/routes and never claims unchanged old-base artifacts are current-base delivery evidence.

1. **Immutable source compatibility fixture.** `aidev-187-source` is byte-for-byte the two `992ba9...` blobs above and has expected historical base `3d858a0d4f8219f5ca1db13ad1de72e35ee09758`. Old-base legacy acceptance exits 1 at published-schema admission; frozen stderr contains `does not match published schema acceptance-manifest-v1.schema.json`, the `/schema_version` constant failure for `acceptance-manifest/v1`, and `/rows/0/id` pattern failure for `^A[0-9]{1,9}-T[0-9]{2,4}$`. At an activated base, only low-level `ParseImplementationPlanManifestV2Compatibility` receives the raw manifest/plan bytes plus their expected object IDs/digests. It checks version `implementation-plan-manifest/v2`, parses the complete strict object, verifies the historical `base_sha=3d858a0d4f8219f5ca1db13ad1de72e35ee09758`, and emits `valid/compatibility_tuple_understood` with source commit/path/blob/raw digest and the ordered tuple digest. It does not run `validate-implementation-plan`, compare to the activated base, create a matrix, or return `specified|observed`; `delivery_admitted=false`.
2. **Refreshed delivery fixture.** After AIDEV-191 activation, rebase PR #172, refresh the AIDEV-187 ticket snapshot/revision and only bytes necessarily stale from the new base and approved request: base binding, ticket revision when the trusted ticket changed, plan prose/base commands, plan digest, manifest/JIT base/plan/contract digests, packet and review evidence. Before accepting it, compare `source.rows.map({id,acceptance_class,requirement})` canonical bytes to refreshed rows and require exact byte equality for all 12 tuples. Titles and all non-stale behavior remain unchanged unless separately authorized. The refreshed pair then runs the full Section 3 trusted validator/controller at the activated exact base and may return `valid/specified` plan-publication rows.

The two external test records are `aidev-187-source-compatibility-report.json` and `aidev-187-refreshed-delivery-report.json`; both bind source fixture digests and tuple SHA-256, while only the latter binds refreshed base/head/ticket/plan/manifest/matrix. The exact T10 Node/Go commands in Section 6 exercise them as separate named subtests and hand both report digests to the PR #172 refresh gate. Count-only, regenerated ID, alias, projection, reordered or requirement-normalized evidence is invalid.

Rebasing PR #172 invalidates: old base `3d858a0d4f8219f5ca1db13ad1de72e35ee09758`; commit/head `992ba9...`; ticket snapshot/revision; old plan and manifest bytes/digests/JIT contract digests; deterministic validator report; independent plan approval/report; packet-v3 base/head and digest; exact 12-row matrix bytes/digest; verification evidence bytes/digest; reviewer model/profile claims; receipt-v1 lineage, packet/matrix/evidence digests and canonical digest; rendered marker-v3; pre-push local receipt; protected CI result. The operator must refresh the AIDEV-187 ticket snapshot, rewrite/revalidate its complete plan/manifest against the activated merged base, renew independent approval, regenerate packet/matrix/evidence, launch a fresh final child, create a new receipt, render/revalidate a new marker, and rerun pre-push/base-selected CI. The old receipt is revoked or retained only as stale history; it cannot be reused.

AIDEV-187 is only `downstream_unblock_set`/context. It is not a predecessor or hard dependency of AIDEV-191.

## 11. D5 — per-acceptance executable routes

Each exact requirement below is also the sibling manifest requirement, byte-for-byte.

- [ ] A191-T01: Add strict acceptance-matrix/v2 as an additive contract while preserving byte-and-result frozen acceptance-manifest/v1 and acceptance-matrix/v1 behavior.
  * Slice/downstream: Slice 1; supplies schema/runtime dispatch to Slice 2. Owned paths: `acceptance_v2.go`, matrix-v2 schema, validator tests, Node v2 test. Fixtures: base v1 schemas plus AIDEV-158 plan/manifest.
  * Candidate commands: root `node --test --test-name-pattern "^A191-T01 " tests/delivery-acceptance-v2.test.mjs`; governance `go test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T01$' -count=1 -v`. Expect exit 0, exactly one named pass each, schema/runtime canonical parity, frozen four blob digests and accepted/rejected legacy envelopes. Mutated v1, v2-as-v1, extra/reordered key negatives fail exact codes. Limits: 2 MiB JSON, 1..128 rows. Before/after inventories equal. Hand off canonical `A191-T01-report.json` digest.

- [ ] A191-T02: Dispatch only exact v1/v1 and v2/v2 manifest/matrix version pairs and fail mixed, unsupported, alias, projection, upgrade, and downgrade inputs with stable envelopes.
  * Slice 1. Paths: controller, `acceptance_v2.go`, CLI, tests. Fixtures: `version-pairs/*.json` generated in temp with all 2x2/mixed/future/alias cases.
  * Candidate commands use the Section 6 Node/Go exact-name forms for T02. Expect v1 golden result unchanged; v2 exact continues; mixed `version_pair_mixed`, future `version_pair_unsupported`, aliases `row_unknown+row_missing`, projection `row_binding_mismatch`; exits 1, never 0. Assert precedence and no callback/env selector. Inventories equal; output `A191-T02-report.json` digest feeds transition review.

- [ ] A191-T03: Preserve every implementation-plan-manifest/v2 row ID, class, requirement, uniqueness, and order exactly in acceptance-matrix/v2 without aliases or generated projections.
  * Slice 1; consumed by AIDEV-187 refresh. Paths: v2 runtime/schema/tests and AIDEV-187 fixtures. Candidate exact-name Node/Go commands for T03; expect exit 0 for exact tuples and exit 1 codes `row_duplicate,row_missing,row_unknown,row_reordered,row_binding_mismatch` for one mutation each. Assert case-sensitive byte equality and 1..128 cardinality. Repository/root unchanged; `A191-T03-report.json` digest feeds parent tuple gate.

- [ ] A191-T04: Select activation, implementation-plan contract, validator, profile, policy, schema, controller, and Go runtime only from verified regular blobs at the exact trusted base.
  * Slice 1 support and Slice 2 activation. Paths: controller, CLI, Go v2 runtime/platform files, activation declaration, trusted activation map, profile. Slice 1 runs only the exact T04 candidate tests and emits non-authoritative support evidence. After mandatory refresh, Slice 2 runs Section 3's complete absolute-path `transition` argv from exact `SLICE1_SHA`: all trusted predecessor blobs must authenticate, trusted activation must be absent with the exact absence result, and candidate activation must be a clean-head regular blob. Hostile candidate controller/schema/profile cannot replace trusted predecessors. `validate` before activation returns `activation_absent`; after activation merge it authenticates the trusted declaration/map. Wrong mode/object/type/mode/size/digest/absence returns the specified stable code. Time/output limits 30s Git, 900s Go, 8MiB/64KiB output. No mutation. Transition-receipt digest feeds Slice 2 review.

- [ ] A191-T05: Bind the canonical matrix root and exact row/evidence/artifact objects to repository, ticket revision, profile, policy, plan, manifest, trusted contracts, validator, base, head, PR, paths, digests, timestamps, and bounded external artifacts.
  * Slice 1. Paths: matrix schema/runtime/controller/external-root files/tests. Exact-name T05 Node/Go commands. Positive asserts all 26 ordered root keys and exact objects; table-driven negatives mutate every binding/key, duplicate/reorder JSON, timestamp, path, 0/129 rows, 2MiB+1 matrix, 32/33 artifacts, 10MiB+1 file, 100MiB+1 aggregate. Expected stable precedence/codes and exits 1/3; positive exit 0. Inventories equal; report digest feeds matrix-v2 transition evidence.

- [ ] A191-T06: Separate plan-publication specified rows from implementation-delivery observed or blocked rows, with waiver unsupported by v2 activation.
  * Slice 1. Paths: schema/runtime/tests. Exact-name T06 Node/Go commands. Positive publication uses only `specified`; positive delivery uses `observed`; blocked returns exit 3 `rows_blocked`. Observed publication, specified delivery, waiver/replay/signature/threshold each fail exact scope/schema codes and do not touch replay state. Timestamps <=900s and +300s skew. Report digest feeds lifecycle-order test.

- [ ] A191-T07: Keep structural validity distinct from satisfaction by requiring trusted class policy and byte-verified, race-safe artifacts from an operator-owned external evidence root with zero source mutation.
  * Slice 1. Paths: Go v2/external-root platform files, controller, tests. Exact-name T07 Node/Go commands create temp external roots. Positive ordinary artifact matches handle identity/bytes/digest/policy. Negatives invented digest, missing file, wrong count, arbitrary verifier, candidate-local root/policy, source mutation and ancestor swap return exact codes; structural-only input is blocked, never valid. Bounds are Section 4. POSIX real symlinks run in Linux CI; Windows junction/reparse/hard-link runs locally and blocks if unavailable. Both inventories equal on success; report digest feeds T09.

- [ ] A191-T08: Fail v2 benchmark and evidence classes closed without separately trusted verifier and threshold policy, and never consume v1 waiver replay state.
  * Slice 1. Paths: v2 runtime/schema/tests; v1 waiver code read-only. Exact-name T08 Node/Go commands. Exact manifest benchmark/evidence rows at publication are `specified`; at delivery return exit 3 `unsupported_class_policy`; candidate thresholds, `passed`, baseline, failed, waiver and replay inputs cannot become valid. Assert replay sentinel raw digest unchanged and no file creation. Report digest feeds activation transition.

- [ ] A191-T09: Enforce producer, trusted validator, persistent-parent, fresh-child, receipt, marker, pre-push, and base-selected CI ordering without self-attestation.
  * Slice 2 after mandatory refresh. Paths: profile/docs/skills/activation; lifecycle scripts/workflows read-only. Exact-name T09 Node command plus existing root `node --test tests/final-review-receipt.test.mjs tests/adversarial-review-attestation.test.mjs`. Predecessor transition command must complete before candidate activation. Negatives child-before-parent, receipt-before-child, candidate validator, stale/revoked receipt and marker-before-receipt return nonzero existing/stable codes. Positive produces transition receipt only, not marker. Inventories equal; transition/lifecycle report digest goes to independent review.

- [ ] A191-T10: Prove the exact AIDEV-187 source blobs are understood without alias or delivery admission by the activated-v2 compatibility parser, then validate the refreshed pair at the activated base with all twelve tuple bytes unchanged.
  * Slice 1 source fixture, Slice 2 activated/refreshed fixture, downstream PR #172. Exact-name T10 Node/Go commands hash both immutable source files and compare all 12 tuples in Section 10. Old-base legacy CLI exits 1 with the three frozen published-schema stderr substrings; activated low-level parser returns 0 `valid/compatibility_tuple_understood` and `delivery_admitted=false` on unchanged source bytes. A separately refreshed pair changes only stale bindings, preserves canonical tuple bytes, and only then the full predecessor controller returns 0 `valid/specified`. Alias/order/requirement mutation fails. The two report digests feed AIDEV-187 refresh; count alone is rejected.

- [ ] A191-T11: Produce deterministic Linux and Windows results for canonical JSON, trusted Git blobs, path identity, evidence-root traversal, race detection, and runtime/schema parity without claiming protected Windows CI.
  * Slice 1. Paths: controller, external-root platform files, schema/runtime/tests. Linux: exact-name T11 Node/Go commands in protected CI. Windows PowerShell: `node.exe --test --test-name-pattern "^A191-T11 " tests/delivery-acceptance-v2.test.mjs`; from `governance`, `go.exe test -race ./pkg/deliveryevidence -run '^TestAcceptanceV2/A191-T11$' -count=1 -v`. Expect byte-identical golden envelopes/facts digests; real platform identity attacks fail. Privilege absence is blocked report, not pass. Numeric bounds are Sections 2–4. Repositories/roots unchanged; both platform report digests feed Slice 1 output.

- [ ] A191-T12: Preserve packet-v3, receipt-v1, marker-v3, revocation, fixed pre-push receipt, trusted-base CI, privacy, DCO, and sticky user-only merge authority unchanged.
  * Slice 1 regression and Slice 2 integration. Read-only lifecycle paths in Section 8; modified profile/skills only in Slice 2. Candidate commands: `node --test --test-name-pattern "^A191-T12 trusted lifecycle blob map$" tests/delivery-acceptance-v2.test.mjs`; `node --test tests/final-review-receipt.test.mjs tests/adversarial-review-attestation.test.mjs`; `node scripts/validate-dco.mjs`; `npm test`. Expect exits 0 and nonzero discovery. The first command verifies every full path/digest and absent-path assertion in Section 9.3 from trusted Git blobs. Remaining assertions cover packet/receipt/marker golden bytes, revocation at same head, fixed receipt path, pull_request_target base execution, opaque evidence privacy, and exact merge-authority profile values. Negative candidate workflow/controller cannot select authority. Inventories equal; report digest is required by both exact-head reviews.

## 12. Staleness, JIT, completion, and unresolved decisions

The current pair is ready only for plan publication and Slice 1. Changes to its final plan bytes, ticket revision, base, any affected contract, any acceptance requirement, activation design, or Slice 1 output require complete refresh/revalidation. In particular, Slice 1 merge/output drift requires renewed approval before Slice 2. The manifest truthfully has no external hard dependencies or predecessor outputs and lists AIDEV-187 only downstream.

Before any implementation, recheck exact base/ticket/final plan digest and trusted-base digests for manifest contract `9c31dc84e57dfd691b3e2a45046b7ab9b2876e51a08e223556bb29d774d92`, validator `3bea29df796b108ba284ffed25094855253599bc7fe4d8c5c2a920b972ea62fc`, profile/policy `96e4b00bc78b16b5e544ee48f369137c74a2ef040c7b226b5c88d542d2e6a6c9`, and profile schema `7c83a3d308d5b7e193a7333316c55cdbfbbc9b3e181b6fadd4f67fba63fae954`. Before Slice 2 those expected values must be replaced by exact `SLICE1_SHA` outputs in a newly validated/approved complete pair.

Unresolved human decisions: none inside this plan. Unknown future `SLICE1_SHA` and output digests are transition results, not discretionary design decisions and not placeholders that authorize Slice 2. Implementation size is very large and conflict surface high because it spans strict cross-language contracts, trusted Git execution, platform filesystem security, profile/skills and review-lifecycle regressions.

Completion of planning requires: final plan digest inserted into the sibling manifest; deterministic validator `ok:true` with 12 lines and zero diagnostics; exact two-file status; same-reviewer complete-pair approval. No lifecycle action follows automatically.
