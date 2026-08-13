# Pi ticket cost

`@zkrausman/pi-ticket-cost` creates local, session-scoped cost receipts for one ticket window. It has no network, shell, tracker, or model calls.

## Install

This package is published to GitHub Packages. Configure its scoped registry, then authenticate with GitHub Packages before `pi install -l` (do not change global npm configuration automatically):

```powershell
npm config set @zkrausman:registry https://npm.pkg.github.com --location=project
npm login --scope=@zkrausman --auth-type=legacy --registry=https://npm.pkg.github.com
pi install -l npm:@zkrausman/pi-ticket-cost
```

Use GitHub Packages credentials with permission to read the package when prompted.

## Harness lifecycle API

A trusted local ticket-loop extension should automatically signal the active window over Pi's **in-process** event bus. This package never infers ticket IDs from chat text and does not contact Linear.

```ts
pi.events.emit("ticket-cost:v1:lifecycle", {
  version: 1,
  requestId: "ticket-loop-close-aidev-72",
  action: "begin", // or "close"
  ticket: "AIDEV-72",
});

pi.events.on("ticket-cost:v1:lifecycle-result", (result) => {
  // { version: 1, requestId, action, ticket, ok, receipt?, jsonPath?, markdownPath?, error? }
});
```

Signals are accepted only while the current project is trusted. The event bus is process-local, so it is suitable for a harness extension running in the same Pi process—not a separate process. `close` writes JSON and Markdown receipts under `.pi/ticket-costs/`, each in a completed receipt directory, with a paste-ready local Linear closeout block.

## Manual fallback

```text
/ticket-cost begin AIDEV-72
/ticket-cost close AIDEV-72
```

`begin` records an in-memory parent-cost baseline. Receipts aggregate the parent usage and sanitized, in-window pi-subagents metadata, including numeric `usage.cost` (and legacy `usage.cost.total`), token counters, and turns. Artifact scanning is nonrecursive and fails closed after 1,000 total directory entries or 100 eligible metadata files. The command name may collide with another installed extension. Windows are deliberately session-local: after an extension reload or session switch, start a new window before closing. Path checks reject symlinks and traversal, but Node has no portable parent-directory binding to eliminate an active filesystem replacement race on Windows.
