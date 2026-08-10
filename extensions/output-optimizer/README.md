# Output optimizer

A Pi extension that reduces oversized **successful** shell-command output before
it reaches the model context. It is a transform only: it never reruns commands,
changes command arguments, or persists raw command output.

## What it does

- Observes `bash`, `exec`, and `run_command` tool results.
- Preserves small output, non-zero exits, failure markers, and diffs verbatim.
- Compresses only large successful output by retaining the beginning, useful
  middle lines, and end.
- Redacts recognized secrets before returning transformed output.
- Requires a trusted project before transforming output.
- Keeps telemetry disabled by default; when enabled, it records counters only,
  never raw output.
- Adds `output_optimizer_status` and `output_optimizer_raw` tools. A caller can bypass a single
  transform with `output_raw: true` on the shell tool input.

## Example: investigating a noisy test run

Use this when Pi needs to inspect a command that produces thousands of lines of
successful progress output, such as a monorepo test suite, build, or dependency
scan. Install the extension, then let Pi run the normal command:

```text
npm run test:integration
```

When the command succeeds with output above the threshold, Pi receives a compact
version containing the beginning, relevant status lines, and the end. The shell
command itself still ran exactly once and its exit status is unchanged.

If the command exits non-zero, contains a failure marker, or emits a diff, Pi
receives the original output instead. When an investigation needs every line of
a successful, large command, call `output_optimizer_raw` and pass `output_raw: true` on
that individual shell-tool call.

## Install

1. Clone `pi-sampler` to a trusted local path.
2. Add the extension entry point to Pi's `extensions` setting:

   ```json
   {
     "extensions": [
       "E:/Repos/pi-sampler/extensions/output-optimizer/src/index.ts"
     ]
   }
   ```

3. Restart Pi or run `/reload`.

For a temporary test, start Pi with:

```powershell
pi -e E:/Repos/pi-sampler/extensions/output-optimizer/src/index.ts
```

Pi supplies the extension runtime dependencies. No project-specific credentials
or configuration are required.

## Safety notes

This extension intentionally does **not** compress failures or diffs, because
those outputs are diagnostic evidence. It should still be installed only from a
reviewed revision: Pi extensions run with your user permissions.

## Verify

From the repository root:

```powershell
node --test tests/output-optimizer.test.mjs
```
