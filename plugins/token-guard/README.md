# Token guard

Opt-in Pi extension that detects repeated **completed** tool-call/result signatures. It reports suspicion, not proof of no progress. Bounded canonicalization fails open for unknown, cyclic, oversized, or image evidence; state is memory-only and resets at session/run boundaries.

## Use

Load the extension and opt in with CLI flags:

```sh
pi -e ./extensions/token-guard/index.ts --token-guard
pi -e ./extensions/token-guard/index.ts --token-guard --token-guard-warn-after 6
pi -e ./extensions/token-guard/index.ts --token-guard --token-guard-stop-after 12
```

The optional stop flag is disabled by default and only aborts the current run after repeated completed-signature suspicion. No project configuration, persistence, compaction, image policy, shell filtering, or generic limits are used.


Run the commands above from `plugins/token-guard`. Loading alone is inert without `--token-guard`. Node 24+ is required for the dependency-free local tests (`npm test`); tests use type stripping, not a TypeScript typecheck. This package is not installed or activated by this PR.

## Migration and rollback

After explicitly choosing to activate this extension, disable the old global emergency guard (`~/.pi/agent/extensions/token-burn-guard.ts`) and restart Pi before enabling this one. Keep a backup outside auto-loaded extension directories. Never run both guards together: the old guard still has unconditional turn/tool aborts. This plugin does not edit or disable the old guard for you. To roll back, stop loading this extension and restore the backed-up guard only if desired, then restart Pi.

Unlike the emergency guard, this extension has no generic turn/tool/context ceilings, command-word filters, image interception or automatic compaction. Host image settings and Pi compaction remain authoritative. Intensive useful work and single long-running waits are not interrupted based on volume or elapsed time.

## Limits

Only consecutive equivalent completed call/result pairs are detected; alternating loops and oversized/unsupported results can evade detection. Identical results may still represent useful work: warnings are advisory, and optional stopping can have false positives. No provider cost, cross-session usage or child-agent budget is enforced. Headless mode suppresses UI warnings; explicitly opted-in stopping still applies. Arguments/results are not logged or persisted; only bounded digests are retained for pending calls. JavaScript engine/proxy enumeration may perform internal work before keys are yielded; bounded retained keys and traversal are not a sandbox against hostile JavaScript objects.
