# Scoped review packets

Generate a deterministic, local review packet from two explicit committed refs:

```sh
node scripts/generate-review-packet.mjs --base <committed-base> --head <committed-head> --output .pi/review-packets/review.json --validation "node --test tests/example.test.mjs: passed"
```

`--validation` is optional, explicit, and bounded; the generator never runs a
command or captures environment data. It resolves both refs to commits, requires
`base` to be an ancestor of `head`, reads only Git objects in `base..head`, and
rejects unsafe output paths, binary/non-UTF-8 or oversized changed files, and
ranges with too many files. The generated packet contains resolved commit IDs,
changed-file paths/statuses, a diff stat, and bounded textual hunks. When a
file has more hunks than the packet can include, `incomplete` is `true` and
`omittedHunks` lists every affected path. Generated packets are local artifacts
under the existing `.pi` ignore policy.

The output must be a new, repository-relative `.json` path. The generator
refuses every existing output path, whether tracked or untracked, and publishes
with exclusive creation, so a file created after validation is also never
overwritten. On a write failure it removes only the file descriptor it can prove
this invocation created.

Use the tracked `.pi/agents/scoped-reviewer.md` profile with an explicitly
supplied packet. It limits normal review to packet-listed files and necessary
direct imports; it must not conduct broad discovery or read unrelated,
untracked, local-secret, credential, session, or governance data. If
`incomplete` is true, the reviewer must inspect each `omittedHunks` file within
that boundary before concluding, or report that the scoped review cannot be
completed. Findings require concrete evidence and are limited to blocker/high
severity. The standard tier performs the routine bounded review; high-reasoning
escalation is only for concrete security, data-loss, authentication,
concurrency, or non-local-invariant evidence and retains the exact same
boundary.
