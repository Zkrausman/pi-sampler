# AIDEV-138 Implementation Plan

## Effort & Risk
* **Effort:** Large
* **Risk:** High. Strict security boundaries are required. Mitigations include strict payload sizing, atomic SQLite transactions, UUIDv4 identifiers, fail-closed assertions, and one-way dependency architecture.
* **Dependencies:** Slice 2 is strictly dependent on AIDEV-124 and AIDEV-125 (to be delivered independently when ready).

## Expected File Changes
* **Extension Layer:**
  * `src/extensions/pi-excalidraw/index.ts`
  * `src/extensions/pi-excalidraw/workspace.mjs`
* **Frontend Layer:**
  * `src/components/ExcalidrawViewer.tsx`
  * `src/components/excalidrawScene.ts`
  * `src/App.tsx`
* **Provenance Layer (Slice 2):**
  * `contracts/ticket-episode-v1.schema.json`
  * `contracts/ticket-episode-v1.mjs`
  * `ledgers/episode-evolution-ledger.mjs`
* **Tests:**
  * `tests/pi-excalidraw-workspace.test.mjs`
  * `tests/pi-excalidraw-extension.test.mjs`
  * `tests/excalidraw-viewer.test.mjs`

## Step-by-Step Execution

**Slice 1: Standalone Revision-Safe Workspace & Viewer (Independent)**
1. **Update Workspace Store (`workspace.mjs`)**: 
   - Mandate cryptographically secure identifiers (UUIDv4) for all drawing IDs.
   - Implement strict payload size limits (e.g. maximum byte constraints) and chunking/streaming for the loopback API to prevent OOM vulnerabilities from massive JSON payloads.
   - Enforce workspace/session scoping and authentication checks on the loopback API to prevent state leakage.
   - Ensure all database writes operate within strict atomic SQLite transactions with fail-closed behavior (instant rollback if an error or validation failure occurs).
   - Require attribution metadata (identifying AI vs. Human author) to be persisted with every revision.
2. **Refactor Extension (`index.ts`)**: 
   - Unify `generate_diagram` and `read_diagram` to target the workspace API. Enforce the use of `expectedRevision` to reject concurrent or stale writes.
   - Explicitly sanitize all Drawing IDs and strictly forbid symlink following or path traversal (`../`) if any temporary files must be written during processing.
3. **Refactor Scene Loader (`excalidrawScene.ts`)**: 
   - Load securely from the loopback workspace API using the new UUIDv4 structure, adhering to payload size limits and authentication requirements.
4. **Update Frontend UI (`App.tsx`, `ExcalidrawViewer.tsx`)**: 
   - Manage the selected drawing UUIDv4 state dynamically to replace hardcoded artifact paths.
5. **Implement Conflict UI**: 
   - Gracefully display `WorkspaceConflictError` in `ExcalidrawViewer.tsx` to handle rejected concurrent edits visibly to the human.

**Slice 2: Optional Ticket Episode Artifact Attachment (Blocked on AIDEV-124/125)**
6. **Extend Episode Schema (`ticket-episode-v1.schema.json`)**: 
   - Add schema support for attaching versioned drawing artifacts, embedding strict provenance metadata (agent/model or human attribution).
7. **Integrate Artifact Attachment (`ticket-episode-v1.mjs`, `episode-evolution-ledger.mjs`)**: 
   - Implement logic using atomic SQLite transactions. If revision checking or digest validation fails, instantly roll back.
   - Architect a strict one-way dependency graph. The Evolution domain must rely on generic interfaces (e.g., `ArtifactProvider` or generic schemas) and MUST NOT import directly from the `pi-excalidraw` domain to prevent circular dependencies.

## Test Matrix
* **OOM & Payload Security**: Assert that large payloads over the limit are rejected immediately and chunking works properly.
* **Path & State Security**: Assert that UUIDv4 drawing IDs cannot be manipulated for path traversal, symlink traps are blocked, and unauthenticated loopback requests fail.
* **Concurrency & Transactions**: Assert atomic rollbacks on revision mismatch and confirm that `WorkspaceConflictError` is handled properly.
* **Provenance & Attribution**: Verify that human vs. AI attribution is strictly recorded in the workspace and in Episode evidence.
* **Architecture Integrity**: Verify that no imports flow from `pi-excalidraw` to the Evolution domain.
