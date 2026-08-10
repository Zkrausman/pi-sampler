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

## Configuration and custom-tool support

In a trusted project, the extension loads
`.pi/output-optimizer.json`. Missing or invalid configuration falls back to the
safe defaults below and is reported by `output_optimizer_status`.

```json
{
  "enabled": true,
  "thresholdBytes": 8000,
  "telemetryEnabled": false,
  "additionalToolNames": []
}
```

Copy [`output-optimizer.example.json`](output-optimizer.example.json) to the
consumer project's `.pi/output-optimizer.json` and adjust only these options:

| Option | Allowed values | Default |
| --- | --- | --- |
| `enabled` | Boolean | `true` |
| `thresholdBytes` | Integer from 8,000 through 100,000 | `8000` |
| `telemetryEnabled` | Boolean; counters only, never raw output | `false` |
| `additionalToolNames` | Up to 32 unique lowercase underscore-style tool names | `[]` |

Secret redaction and trusted-project-only transformation are safety invariants;
the configuration cannot disable them. Each listed custom tool must also return
`details.outputOptimizerEligible: true` to opt in at runtime.

| Per-call bypass | Accepted form |
| --- | --- |
| Tool input | `output_raw: true` or `raw: true` |
| Command text | `--output-raw` |

The optimizer always transforms result events from `bash`, `exec`, and
`run_command`. It transforms a custom tool only when both the project
configuration lists its name and the tool result sets
`details.outputOptimizerEligible: true`. The result must use the same textual
content or `details.output` shape as a command result. This double opt-in keeps
structured, sensitive, diff, and evidence results untouched by default.

## Install

1. With GitHub Packages access configured, install the released package:

   ```powershell
   pi install -l npm:@zkrausman/pi-output-optimizer
   ```

   For local development, clone `pi-sampler` to a trusted path instead.
2. For a local checkout, add the extension entry point to Pi's `extensions` setting:

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
