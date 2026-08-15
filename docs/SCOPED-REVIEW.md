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
files. Every Git invocation uses the global `--no-replace-objects` option, so
replacement refs cannot change resolved commits or their content. It runs Git
with a fixed allowlist environment: every inherited variable whose name begins
`GIT_` is removed case-insensitively, including repository-selection and trace
variables. Command-line Git configuration (which takes precedence over system,
global, and repository configuration) disables Trace2 destinations and hooks;
Git diffs additionally use `--no-ext-diff --no-textconv`, preventing configured
external diff and textconv execution. The fixed environment retains only the
platform's basic process-location and temporary/home variables (`PATH` plus
`SystemRoot`/`ComSpec`/`PATHEXT` and conventional home/temp variables on
Windows; `PATH` and conventional home/temp variables elsewhere). The hook-path
setting is defense in depth: Git does not normally run hooks for these read-only
subcommands. On Unix `/dev/null` is a non-directory null device; on Windows,
Git for Windows path interpretation of `/dev/null` is implementation-specific,
but the read-only command set remains non-hook-invoking. The generated packet contains
resolved commit IDs, changed-file paths/statuses, a diff stat, and bounded
textual hunks.

Packets use `pi-sampler.scoped-review-packet.v2` and contain only complete
Git-generated textual hunks. A packet has `incomplete: false` with empty
`omittedHunks`, `byteTruncatedHunks`, and `immutableMaterial` arrays. The
legacy fields remain present so consumers can reject incomplete packets
unambiguously; they are never evidence substitutes.

Each file may have at most 64 hunks, each hunk may be at most 64 KiB, all hunks
for one path may be at most 128 KiB, and all packet hunks may be at most
768 KiB. Each Git diff read remains capped at 384 KiB, and the exact canonical
serialized packet remains capped at 1 MiB. These fixed limits admit complete
medium-sized source and viewer hunks while preserving bounded review input.
Any hunk-count, per-hunk-byte, per-path-total, aggregate-total, Git-diff, or
serialized-packet overflow fails closed: produce a smaller range. The generator
never truncates a hunk or falls back to complete blob endpoints.

The only endpoint-size admission exception is a repository-root
`package-lock.json` above 128 KiB and at most 512 KiB. It must be canonical
npm `lockfileVersion: 3` JSON and satisfy the strict bounded schema for every
top-level, package, dependency, and nested metadata value (including safe
package locations, npm-registry tarball references, and bounded depth). Its
intentionally narrow dependency-range parser is linear rather than a
backtracking regular expression. This admits the committed object only for
validation; it does not omit, segment, embed, or otherwise substitute its
content. The same complete-hunk limits still apply, so an oversized lockfile
diff normally fails closed and must be split into a smaller range. All other
oversized paths and unsupported lockfiles fail closed.

It also deliberately does not emit segmented chunks. A Git blob object ID is a
hash of the whole blob and does not provide a cryptographic proof that
independently disclosed bytes occur at a claimed offset. A packet-generated
chunk hash or Merkle root would only authenticate packet-supplied data, not
bind it to an existing Git blob, unless a separately trusted committed
attestation or a zero-knowledge preimage proof were added. Neither trust
mechanism is part of this local packet protocol.

Generated packets are local artifacts under the existing `.pi` ignore policy.
Reviewers inspect only the complete packet hunks, never mutable working-tree
files or embedded endpoint/chunk alternatives. Normal scope remains the packet
data only: do not run broad discovery or use workspace, untracked,
history-outside-range, environment, credential, session, or governance data.

Node's supported cross-platform filesystem APIs do not provide a portable
descriptor-relative, no-follow directory publication primitive. An `lstat`
parent check followed by exclusive file creation still permits a parent symlink
swap, so the generator performs no filesystem output at all. This removes its
arbitrary-write boundary rather than claiming TOCTOU protection. Use shell
redirection only after securing the target directory yourself; the caller owns
that filesystem operation and its platform-specific race boundary.

Use the tracked `.pi/agents/scoped-reviewer.md` profile with an explicitly
supplied packet. It limits all review to the packet and its embedded immutable
material; it does not read workspace files or run broad discovery. Findings
require concrete evidence and are limited to blocker/high severity. The standard
tier performs the routine bounded review; high-reasoning escalation is only for
concrete security, data-loss, authentication, concurrency, or non-local-invariant
evidence and retains the exact same boundary.
