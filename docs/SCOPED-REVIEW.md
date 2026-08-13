# Scoped review packets

Generate a deterministic, local review packet from two explicit committed refs:

```sh
node scripts/generate-review-packet.mjs --base <committed-base> --head <committed-head> --validation "node --test tests/example.test.mjs: passed" > .pi/review-packets/review.json
```

The generator writes the packet JSON only to stdout. Redirect it to a location
whose directory security is controlled by the operator (or capture stdout in
an approved caller); it deliberately has no `--output` option.

`--validation` is optional, explicit, and bounded; the generator never runs a
command or captures environment data. It resolves both refs to commits, requires
`base` to be an ancestor of `head`, reads only Git objects in `base..head`, and
rejects binary/non-UTF-8 or oversized changed files and ranges with too many
files. The generated packet contains resolved commit IDs,
changed-file paths/statuses, a diff stat, and bounded textual hunks. When a
file has more hunks than the packet can include **or any included hunk is
byte-truncated**, `incomplete` is `true` and `omittedHunks` lists every affected
path; `byteTruncatedHunks` identifies the latter subset. Generated packets are
local artifacts under the existing `.pi` ignore policy.

Node's supported cross-platform filesystem APIs do not provide a
portable descriptor-relative, no-follow directory publication primitive. An
`lstat` parent check followed by exclusive file creation still permits a parent
symlink swap, so the generator performs no filesystem output at all. This
removes its arbitrary-write boundary rather than claiming TOCTOU protection.
Use shell redirection only after securing the target directory yourself; the
caller owns that filesystem operation and its platform-specific race boundary.

Use the tracked `.pi/agents/scoped-reviewer.md` profile with an explicitly
supplied packet. It limits normal review to packet-listed files and necessary
direct imports; it must not conduct broad discovery or read unrelated,
untracked, local-secret, credential, session, or governance data. If
`incomplete` is true (including byte-truncated hunks), the reviewer must inspect
each `omittedHunks` file within that boundary before concluding, or report that
the scoped review cannot be completed. Findings require concrete evidence and
are limited to blocker/high severity. The standard tier performs the routine bounded review; high-reasoning
escalation is only for concrete security, data-loss, authentication,
concurrency, or non-local-invariant evidence and retains the exact same
boundary.
