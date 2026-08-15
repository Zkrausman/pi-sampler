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

Packets use `pi-sampler.scoped-review-packet.v2`. When a file has more hunks
than the packet can include **or any included hunk is byte-truncated**,
`incomplete` is `true` and `omittedHunks` lists every affected path;
`byteTruncatedHunks` identifies the latter subset. For every such path,
`immutableMaterial` embeds canonical committed `base` and/or `head` endpoints
appropriate for its status (`A`, `D`, or `M`). A normal endpoint contains its
Git blob object ID, byte length, and complete UTF-8 content. The generator
checks that complete content hashes to the embedded Git object ID and that the
object is present at the resolved endpoint commit.

An incomplete path must embed each required endpoint in full within the
24 KiB complete-endpoint limit. The generator rejects any incomplete endpoint
that exceeds that bound; split or reduce the change so the reviewer can verify
the complete committed blob. It deliberately does not emit segmented chunks.
A Git blob object ID is a hash of the whole blob and does not provide a
cryptographic proof that independently disclosed bytes occur at a claimed
offset. A packet-generated chunk hash or Merkle root would only authenticate
packet-supplied data, not bind it to an existing Git blob, unless a separately
trusted committed attestation or a zero-knowledge preimage proof were added.
Neither trust mechanism is part of this local packet protocol.

A reviewer must verify that complete endpoint content hashes to its embedded
Git object ID and that the object is present at the resolved endpoint commit.
A missing, changed, truncated, or oversized endpoint is a failed evidence
check: report that the scoped review cannot be completed, not a clean review
conclusion.

Generated packets are local artifacts under the existing `.pi` ignore policy.
Reviewers must inspect the embedded `immutableMaterial` for incomplete paths,
not mutable working-tree files. Normal scope remains the packet and direct
listed immutable content only: do not run broad discovery or use workspace,
untracked, history-outside-range, environment, credential, session, or
governance data.

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
