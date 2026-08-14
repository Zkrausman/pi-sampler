# Pi Excalidraw workspace persistence

`src/extensions/pi-excalidraw/workspace.mjs` is a deliberately narrow,
project-local persistence boundary. It stores native Excalidraw scenes in one
SQLite database at `.pi/excalidraw/workspace.sqlite`. It does **not** add a
browser, a Pi tool, diagram interpretation, collaboration, authentication, or
any cloud/network integration.

## Runtime boundary

This module requires **Node 24 or later** and uses only the built-in
`node:sqlite` `DatabaseSync` API. `node:sqlite` is experimental in Node 24 and
Node emits its experimental warning when the module is loaded. On an older Node
or where the built-in API is unavailable, `openExcalidrawWorkspace()` rejects
with `node_sqlite_requires_node_24` or `node_sqlite_unavailable`; do not replace
it with a third-party SQLite binding. Use this boundary only in a trusted local
project on a local filesystem.

## Storage contract

```js
import { openExcalidrawWorkspace } from "./src/extensions/pi-excalidraw/workspace.mjs";

const workspace = await openExcalidrawWorkspace(process.cwd());
const created = workspace.save("system", nativeExcalidrawScene, 0);
const revised = workspace.save("system", changedNativeScene, created.revision);
const exportEnvelope = workspace.exportDrawing("system");
workspace.close();
```

Drawing IDs are bounded ASCII identifiers, not paths. `save()` requires an
explicit `expectedRevision`: use `0` to create and the returned revision to
replace. A stale or missing precondition throws `WorkspaceConflictError` with
code `revision_conflict`; it never silently overwrites a drawing.

The schema is versioned in `schema_migrations`. Migration and every conditional
write use `BEGIN IMMEDIATE` / `COMMIT`; SQLite WAL recovery rolls back an
interrupted transaction on the next open. The store enables `foreign_keys`,
WAL, `synchronous=FULL`, and a bounded busy timeout, then runs `PRAGMA
quick_check` at open. A bad database fails closed (`workspace_open_failed` or
`workspace_corrupt`) rather than being repaired or replaced.

A scene is stored as native Excalidraw JSON, without semantic remapping. The
entire serialized scene is limited to 5 MiB, nesting is limited to 64, its
elements array is limited to 10,000 entries, and its `files` object is limited
to 100 entries and 1 MiB per entry. Unknown native
scene and file fields are retained. `exportDrawing()` and `importDrawing()` use
the versioned `pi-excalidraw-workspace` v1 envelope; an export revision is
informational and import still requires the caller's explicit current-revision
precondition.

`importNativeFile(id, path, expectedRevision)` and
`exportNativeFile(id, path)` operate only on project-relative `.excalidraw`
files. They reject absolute paths, traversal, backslashes, symlink components,
and non-regular files. Export uses a synced temporary file and rename; directory
sync is best effort because it is not portable to every filesystem. As with
other portable Node filesystem APIs, this does not defend against a hostile
concurrent filesystem replacer after validation.

## Optional local service boundary

```js
import { startExcalidrawWorkspaceServer } from "./src/extensions/pi-excalidraw/workspace.mjs";
const service = await startExcalidrawWorkspaceServer(workspace); // 127.0.0.1 only
// service.url is http://127.0.0.1:<ephemeral-port>
```

The server rejects every host except its exact `127.0.0.1:<port>` host header
and rejects a non-matching `Origin`. It has no CORS headers and binds only IPv4
loopback. It exposes only:

- `GET /health`
- `GET /api/drawings/:id`
- `PUT /api/drawings/:id` with `{ scene, expectedRevision }`
- `GET /api/drawings/:id/export`
- `POST /api/drawings/import` with `{ export, expectedRevision }`

Writes return `409 { "error": "revision_conflict", "revision": ... }` for a
stale revision. JSON requests are bounded and the service has no static files,
UI, remote listener, telemetry, or Pi semantic operations. Call
`service.close()` and `workspace.close()` when finished.

`.pi/excalidraw/` is intentionally ignored by source control. Back it up only
through a trusted local mechanism if the workspace matters; this first boundary
does not implement backups, multi-process lock ownership, user identity, or
collaboration.
