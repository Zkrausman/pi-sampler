# PR #150 review-workspace remediation

This runbook is for the five historical detached review resources associated
with PR #150. It is **not** part of normal review-workspace cleanup. The
managed review script never discovers and deletes historical resources on its
own.

The operator must work from a trusted repository checkout and keep the
inventory, backup, prompts, and raw Git output local. Do not place lease tokens,
local identities, absolute machine paths, session data, or credentials in the
repository.

## Guardrails

- Perform the complete dry run first. A dry run must not rename, delete, edit,
or rewrite a workspace, Git config, branch, remote, or tracker item.
- Record each candidate independently: canonical path, exact expected head SHA,
  Git metadata, clean tracked status, ignored/untracked inventory, nested
  repositories, lock files, filesystem identity, and the reason it is or is not
  eligible. An absent, dirty, locked, changed, symlinked, case-aliased, nested,
or uncertain candidate is preserved.
- Record the repository-local Git-config byte digest and the exact polluted
  local key/value/origin. Do not infer an owner identity and do not touch global,
  system, or included config.
- A backup is recovery evidence, not permission to overwrite the config or
  remove a workspace.
- Quarantine and identity repair require separate explicit user confirmation.
  The user remains the only merge or publication authority.

## Phase 1: dry-run inventory

Use the approved profile and the exact source repository. Capture output outside
Git. The inventory command is read-only:

```powershell
node scripts/review-workspace.mjs inventory `
  --repo <SOURCE-CHECKOUT> `
  --profile profiles/pi-sampler.json
```

For each of the five PR #150 paths, run a managed inspection with the exact
lease token only if a trusted lease exists:

```powershell
node scripts/review-workspace.mjs inspect `
  --repo <SOURCE-CHECKOUT> `
  --profile profiles/pi-sampler.json `
  --workspace <EXPECTED-CANONICAL-PATH> `
  --lease <RECORDED-LEASE-TOKEN>
```

Do not substitute a path, branch, abbreviated SHA, or ticket-named checkout.
Compare the result with trusted Git metadata and the recorded expected SHA.
Unknown provenance is a preservation result.

## Phase 2: config evidence and backup

Before any remediation, capture a byte-for-byte backup of the repository-local
`.git/config` plus its SHA-256 digest. Separately record only the exact bad
local keys and values, with their `--show-origin` source. Review the record
manually. The expected owner configuration is a human decision; this procedure
never invents or writes a replacement identity.

```powershell
git -C <SOURCE-CHECKOUT> config --local --show-origin --get-regexp '^user\.(name|email)$'
sha256sum <SOURCE-CHECKOUT>/.git/config
```

On systems without `sha256sum`, use the platform's equivalent digest command.
Keep the backup and evidence outside the repository.

## Phase 3: per-resource quarantine

Only after explicit confirmation, quarantine a candidate that passed every dry-
run check. Use the recorded exact lease and path; do not use a broad recursive
remove. The managed command revalidates the lease, filesystem identity, exact
head, clean content, locks, nested repositories, config, and roots before and
after its atomic rename:

```powershell
node scripts/review-workspace.mjs quarantine `
  --repo <SOURCE-CHECKOUT> `
  --profile profiles/pi-sampler.json `
  --workspace <EXPECTED-CANONICAL-PATH> `
  --lease <RECORDED-LEASE-TOKEN>
```

Stop and preserve the resource if any concurrent change, compare failure, or
post-rename validation failure occurs. Quarantine is retained for the profile's
retention period.

## Phase 4: exact local-key remediation

After the workspace decisions are complete, and only with separate explicit
confirmation, remove each recorded bad **local** key using compare-and-swap:

1. Re-read the config bytes and require the recorded pre-remediation digest.
2. Require the exact recorded key/value/origin; reject missing, duplicated,
   or changed entries.
3. Remove only that exact local key. Never use `--global`, `--system`, an
   include file, a whole-file replacement, or an owner-identity write.
4. Re-read and record the post-remediation bytes and digest.
5. If any unrelated concurrent config edit occurred, refuse and preserve the
   backup for manual recovery.

Rollback is also compare-and-swap: restore only the exact removed key/value when
current bytes match the recorded post-remediation bytes. Any unrelated change
blocks automatic rollback.

## Phase 5: retained deletion

After the configured retention period, deletion is a separately authorized
operation. Re-run inspection against the quarantine path and stop on any new
content or provenance uncertainty:

```powershell
node scripts/review-workspace.mjs clean `
  --repo <SOURCE-CHECKOUT> `
  --profile profiles/pi-sampler.json `
  --quarantine <RECORDED-QUARANTINE-PATH> `
  --lease <RECORDED-LEASE-TOKEN> `
  --confirm
```

A dirty, changed, locked, symlinked, case-aliased, nested, or lease-less
resource is never force-removed. Preserve its evidence and escalate for manual
review instead.
