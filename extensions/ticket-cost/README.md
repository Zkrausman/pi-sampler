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

## Use

```text
/ticket-cost begin AIDEV-72
/ticket-cost close AIDEV-72
```

`begin` records an in-memory parent-cost baseline. `close` writes JSON and Markdown receipts under `.pi/ticket-costs/`, each in a completed receipt directory, and provides a paste-ready local Linear closeout block; it never contacts Linear. Artifact scanning is nonrecursive and fails closed after 1,000 total directory entries or 100 eligible metadata files. The command name may collide with another installed extension. Windows are deliberately session-local: after an extension reload or session switch, start a new window before closing. Path checks reject symlinks and traversal, but Node has no portable parent-directory binding to eliminate an active filesystem replacement race on Windows.
