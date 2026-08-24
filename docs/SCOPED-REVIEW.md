# Scoped review packets

Scoped packets are deterministic, local, commit-only evidence for a bounded
review. They never read mutable working-tree files or publish packet artifacts.
The generator reads two explicit committed refs and writes the packet only to
stdout:

```sh
node scripts/generate-review-packet.mjs --base <committed-base> --head <committed-head> > review.json
node scripts/validate-review-packet.mjs --packet review.json --base <committed-base> --head <committed-head>
# Alternatively, validate against a separately trusted canonical packet digest:
node scripts/validate-review-packet.mjs --packet review.json --digest <trusted-sha256>
```

New generation defaults to **v3**. Use `--version 2` only when reproducing a
historical v2 packet or validating a v2 packet-consistency attestation:

```sh
node scripts/generate-review-packet.mjs --version 2 --base <base> --head <head>
```

## Packet versions

### v3 line-readable packets

A v3 packet has format `pi-sampler.scoped-review-packet.v3`. It retains exact
base/head commit binding, changed paths, diff statistics, complete Git hunks,
and the explicit completeness fields. Each hunk is represented as:

```json
{
  "header": "@@ -1,2 +1,2 @@",
  "logicalLines": [
    {
      "segments": ["+complete UTF-8 diff line\n"],
      "byteLength": 29,
      "sha256": "<sha256 of the reconstructed logical line>"
    }
  ]
}
```

`logicalLines` are the review evidence. Ordered `segments` are only a bounded
transport representation: they are never independent source chunks and must
be concatenated in order. V3 generation captures each raw Git hunk without
split/join line normalization, so hunk-boundary bytes are preserved exactly.
A line's byte length and digest cover the exact reconstructed UTF-8 bytes,
including its line ending when present. Every logical line before the final
logical line of a hunk retains its Git-output LF, and every non-final hunk must
retain the LF after its final logical line. Git's explicit `\ No newline at end
of file` marker is preserved as its own terminated logical line and must remain
in order after the content line it annotates. The validator matches each hunk's
old/new header counts to ordinary diff prefixes, permits a marker only after an
eligible context/add/delete line, and records the old/new side(s) that reached
no-newline EOF so no later line can consume or remark that side. A final hunk
may preserve the raw output's final-line terminator semantics. The validator
rejects missing, duplicated, reordered, oversized, invalid, or out-of-order
fields, duplicate JSON keys, noncanonical JSON, noncanonical segment
boundaries, digest/length mismatches, missing non-final-hunk terminators, and
any hunk that cannot be reconstructed within the bounds. Trusted base/head
validation independently compares reconstructed hunk bytes with raw Git hunk
slices before accepting the generator-bound packet. Acceptance also requires either trusted
base/head refs, which are resolved and regenerated through Git for exact packet
content, or a separately supplied trusted packet digest. Untrusted expected
refs, nonexistent commits, non-ancestor ranges, forged hunks, and recounts are
rejected.

The canonical v3 JSON is pretty-printed with a final LF and fixed key order.
After JSON escaping, every serialized physical line is at most 4 KiB. A
transport segment is at most 4 KiB of UTF-8 and each logical line has at most
64 segments. The v3 schema is tracked at
[`docs/scoped-review-packet-v3.schema.json`](scoped-review-packet-v3.schema.json);
semantic validation is authoritative for byte bounds and Git-diff invariants;
the schema check verifies every required property, definition, bound, enum,
reference, and strictness setting:

```sh
npm run validate:review-packet-schema
```

### v2 compatibility

V2 is byte-for-byte frozen for historical validation. Its format is
`pi-sampler.scoped-review-packet.v2`, its canonical bytes remain
`JSON.stringify(packet, null, 2)` plus one final LF, and its digest is SHA-256
of exactly those bytes. Existing v2 attestation markers are validated through
that frozen serializer only. A v2 marker is legacy packet-consistency evidence;
it is not a v3 final-review gate and must never be made valid by hashing v3
bytes as v2.

## Shared admission and resource limits

Both versions resolve exact commits, require base ancestry, disable replacement
objects, external diff, and textconv, and run Git with a fixed allowlist
environment. Git repository-selection, trace, config, and hook-path variables
are not inherited. Each Git subprocess has a fixed timeout and capped output.

The admitted subset is deliberately narrow:

- at most 200 changed files;
- at most 64 complete hunks per path;
- each reconstructed hunk at most 64 KiB;
- all reconstructed hunks for one path at most 128 KiB;
- all reconstructed hunks in one packet at most 768 KiB;
- the canonical serialized packet at most 1 MiB;
- paths are bounded safe UTF-8 repository paths;
- tracked endpoints must be regular UTF-8 text blobs.

Binary or invalid UTF-8 content, unsafe paths, symlinks, submodules, unsupported
modes, type changes, copies, renames, and incomplete Git hunks fail closed.
The repository-root `package-lock.json` may be admitted as a bounded canonical
npm lockfile up to 512 KiB, but its complete diff still has to satisfy the
hunk, path, aggregate, packet, and line limits. No endpoint blob or generated
chunk is substituted for a complete hunk.

Generated packets contain no workspace, untracked, environment, credential,
session, or history-outside-range data. The reviewer reads only the supplied
packet and cites reconstructed logical diff lines. A packet digest proves the
canonical packet bytes supplied to the caller; Git-bound validation
additionally proves that those bytes are the exact packet regenerated from the
expected committed range. Neither mode permits a separately disclosed chunk to
substitute for a complete Git hunk.

## Filesystem and reviewer boundary

The generator has no output-file option and performs no filesystem publication.
Shell redirection is the caller's responsibility after securing its target
directory. The scoped reviewer is read-only, uses a fresh context, reports only
blocker/high findings, and must not inspect mutable source, direct imports,
untracked files, credentials, sessions, or unrelated governance material.

## Final Terra review gate

Terra retains iterative and remediation review continuity, then launches exactly
one fresh final child with the complete v3 packet, acceptance matrix, and
verification evidence for one exact base/head pair. The child is read-only and
reports only blocker/high findings. A correction resumes that same child at
most twice, but always supplies a newly frozen complete input set; delta-only
review is not valid. A blocker/high finding or later Terra blocker revokes the
local clean receipt even if HEAD is unchanged. Child loss, timeout, provider
failure, malformed receipt, changed binding, or a third correction blocks.

`scripts/final-review-receipt.mjs` validates the bounded local receipt and
renders the only publishable artifact: the minimal v3 marker. Its canonical
receipt digest binds the opaque local lineage/nonce and every complete pass,
while the public marker exposes only exact base/head, packet/matrix/evidence
digests, bounded model/profile caller claims, outcome, and receipt digest. The
authoritative local path must also validate an existing marker against the
current receipt with `validateFinalReviewAttestation`; this rejects an older
same-base/head marker after the receipt is revoked. The pre-push hook invokes
this authoritative path for the ignored
`artifacts/final-review/receipt.json` before accepting an activated-v3 push. CI
can validate the public receipt digest and packet bindings, but cannot observe
opaque local revocation state.
