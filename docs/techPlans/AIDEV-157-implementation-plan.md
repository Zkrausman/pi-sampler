# Implementation Plan: AIDEV-157

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** L
*   **Estimated Effort:** 3-5 days plus a separately authorized remediation run
*   **Primary Risk:** A linked review worktree shares common Git configuration and object state with the writer repository; cleanup can also destroy ignored or otherwise untracked evidence if it trusts only `git status`.

The managed review target is therefore a disposable isolated clone/workspace, not a linked worktree. It has a separate Git config and common directory, detached exact candidate commit, disabled hooks and push URL, no write-capable publication credentials, and a random lease. Local cloning must use `--no-hardlinks`; alternates, `--shared`, `--reference`, and `--reference-if-able` are prohibited. Provisioning verifies that no alternates file exists and that representative object files are not the same filesystem object/hard link as the source repository. Local writes needed for dependencies/tests occur only inside the disposable clone and cannot mutate the candidate branch, object database, or common repository config.

PR #150 cleanup and identity repair are operational remediation, not automatic implementation behavior. They require a dry run, explicit expected paths/SHAs/keys, backup, and separate user confirmation.

## Expected File Changes
*   `[NEW]` `scripts/review-workspace.mjs`: Prepare, inspect, quarantine, and clean isolated exact-head review clones.
*   `[MODIFY]` `scripts/delivery-worktree.mjs`: Share only safe path/profile/lease primitives; do not add linked `review` worktrees.
*   `[MODIFY]` `profiles/project-profile.schema.json`: Add review workspace root, remote policy, quarantine retention, and resource limits.
*   `[MODIFY]` `profiles/pi-sampler.json`: Configure `<worktreeRoot>/review/` and quarantine policy.
*   `[MODIFY]` `.agents/skills/project-code-review/SKILL.md`: Require managed review preparation and prohibit Git author configuration and candidate mutation.
*   `[MODIFY]` `.agents/skills/project-delivery/SKILL.md`: Hand off exact base/head and retain the unmerged implementation worktree.
*   `[MODIFY]` `README.md`: Document managed review workspaces and separation from plan/implement worktrees.
*   `[NEW]` `docs/runbooks/pr-150-review-workspace-remediation.md`: Exact dry-run, backup, quarantine, confirmation, and rollback procedure without machine-specific paths.
*   `[NEW]` `tests/review-workspace.test.mjs`: Isolation, lease, hostile filesystem, quarantine, and cleanup tests.
*   `[MODIFY]` `tests/delivery-worktree.test.mjs`: Verify shared helpers retain plan/implement guarantees.
*   `[MODIFY]` `tests/project-delivery-skill.test.mjs`: Review handoff and no-merge/no-cleanup requirements.
*   `[MODIFY]` `tests/project-profiles.test.mjs`: Review profile validation.

## Step-by-Step Execution
1.  **Phase 1: Provision isolated review workspaces**
    *   Step 1.1: Resolve the approved profile, repository identity, exact candidate SHA, and canonical review root before creating anything.
    *   Step 1.2: Create a unique six-hex-suffix clone with `--no-hardlinks`, no alternates/reference/shared clone mode, a distinct common directory/object database, detached `HEAD`, disabled hooks, and disabled push URL.
    *   Step 1.3: Record an atomic lease containing random nonce, project/repository identity, canonical path, exact head, owner/run class, creation time, and compare-and-swap state.
    *   Step 1.4: Never set `user.name` or `user.email`; reviewer identity is an opaque run identity, not a Git author.
2.  **Phase 2: Validate review execution boundaries**
    *   Step 2.1: Verify exact head, detached state, clean tracked files, clone-local config, no publication remote, and no hooks before and after review.
    *   Step 2.2: Permit dependency/cache files only through an exact disposable allowlist. Nested repositories, unexpected ignored content, or changed tracked files block automatic deletion.
3.  **Phase 3: Quarantine and cleanup**
    *   Step 3.1: Acquire the cleanup lock, revalidate lease/path/filesystem identity/head/content, and reject symlinks, junctions/reparse points, case aliases, root swaps, nested mounts/repos, hard-link surprises where detectable, and TOCTOU changes.
    *   Step 3.2: Atomically rename a positively safe workspace to lease-specific quarantine; revalidate after rename.
    *   Step 3.3: Delete only after configured retention and a separate authorized cleanup operation. Never force-remove uncertain resources.
4.  **Phase 4: Remediate historical state separately**
    *   Step 4.1: Generate a dry-run inventory for the five known PR #150 review workspaces and exact polluted local Git keys, without mutating them.
    *   Step 4.2: Record the common-config byte digest plus the exact bad key/value/origin and expected worktree paths/SHAs from trusted Git metadata. A backup is audit/recovery evidence, not permission to overwrite the whole file.
    *   Step 4.3: After explicit user confirmation, quarantine only resources passing every check. Remove each exact bad local key with compare-and-swap against the recorded value and config bytes; do not invent or write a replacement owner identity.
    *   Step 4.4: Rollback uses compare-and-swap to restore only the exact removed key/value when current bytes match the expected post-remediation state. If any unrelated concurrent config change occurred, automatic remediation or rollback refuses and preserves the backup for manual recovery.

## Test Matrix
*   **Target Command**: `node --test tests/review-workspace.test.mjs tests/delivery-worktree.test.mjs tests/project-delivery-skill.test.mjs tests/project-profiles.test.mjs`
*   **Validation Scenarios**:
    *   [ ] `A157-T01` Preparation creates a unique isolated clone detached at the exact candidate SHA.
    *   [ ] `A157-T02` Common `.git/config` and all writer worktree configs remain byte-for-byte unchanged; clone object storage has no alternates and shares no tested hard-link identity with the source.
    *   [ ] `A157-T03` Review workspace has no write-capable push URL, active hooks, symbolic candidate branch, or Git author identity.
    *   [ ] `A157-T04` Concurrent suffix and lease races leave exactly one owner and never delete the winner.
    *   [ ] `A157-T05` Dirty tracked files, unexpected untracked/ignored files, nested repos, locks, changed head, missing lease, or unknown provenance are preserved.
    *   [ ] `A157-T06` Symlink, junction, case alias, traversal, root swap, and cleanup TOCTOU attempts fail closed.
    *   [ ] `A157-T07` Safe cleanup first quarantines, revalidates, retains, and only later deletes through separate authorization.
    *   [ ] `A157-T08` Historical remediation dry run makes no changes and reports each resource independently.
    *   [ ] `A157-T09` Exact bad local identity removal does not touch global/system/include config or unrelated worktrees; concurrent config edits cause remediation and rollback to refuse rather than overwrite.
    *   [ ] `A157-T10` Plan and implementation worktree provisioning/cleanup regressions remain green.
