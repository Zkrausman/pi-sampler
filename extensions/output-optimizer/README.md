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
- Adds `pith_pi_status` and `pith_pi_raw` tools. A caller can bypass a single
  transform with `pith_raw: true` on the shell tool input.

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
