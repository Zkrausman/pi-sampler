# Implementation Plan: AIDEV-156

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** L
*   **Estimated Effort:** 2-4 days
*   **Primary Risk:** Changing canonical packet bytes can invalidate existing attestations or weaken complete-hunk evidence through truncation, ambiguous reconstruction, downgrade, or resource exhaustion.

Packet v3 is a new contract. V2 remains byte-for-byte frozen for historical validation but cannot satisfy the later AIDEV-159 authoritative final gate. The admitted path/content subset remains UTF-8 text with safe paths; unsupported bytes, binaries, modes, links, submodules, renames, or oversized resources continue to fail closed.

Numeric defaults to finalize in code and schema: 200 files, 64 hunks/path, 64 KiB reconstructed hunk, 128 KiB/path, 768 KiB aggregate patches, 1 MiB packet, 4 KiB encoded physical line, 4 KiB transport segment, 64 segments/logical line, and existing capped Git subprocess buffers. Generation and validation receive explicit timeouts in their callers.

## Expected File Changes
*   `[MODIFY]` `scripts/generate-review-packet.mjs`: Freeze v2 helpers and add packet v3 generation, canonical serialization, digesting, and physical-line preflight.
*   `[NEW]` `scripts/validate-review-packet.mjs`: Strict bounded parser, duplicate-key rejection, schema/limit validation, exact hunk reconstruction, and canonical-byte verification.
*   `[NEW]` `docs/scoped-review-packet-v3.schema.json`: Strict v3 schema with no additional properties.
*   `[MODIFY]` `docs/SCOPED-REVIEW.md`: Document v2/v3 cutover, complete-hunk representation, numeric limits, and unsupported Git objects.
*   `[MODIFY]` `.pi/agents/scoped-reviewer.md`: Permit deterministic representation segments of complete Git hunks while continuing to reject omitted source chunks.
*   `[MODIFY]` `scripts/validate-adversarial-review-attestation.mjs`: Select packet serialization by marker version without reinterpreting digests.
*   `[MODIFY]` `scripts/package-lock-admission.mjs`: Preserve lockfile-specific admission under v3 bounds.
*   `[MODIFY]` `package.json`: Add packet semantic/schema validation commands.
*   `[MODIFY]` `tests/scoped-review-packet.test.mjs`: Add v3 reconstruction, physical-line, hostile-input, resource, and compatibility tests.
*   `[MODIFY]` `tests/adversarial-review-attestation.test.mjs`: Prove v2 markers remain v2-bound and cannot satisfy a v3-only gate.

## Step-by-Step Execution
1.  **Phase 1: Freeze compatibility and specify v3**
    *   Step 1.1: Extract v2 serialization/digest into explicitly versioned functions and lock current fixtures byte-for-byte.
    *   Step 1.2: Define v3 hunks as ordered logical lines; each line contains ordered UTF-8-safe transport segments and exact reconstructed byte length/digest.
    *   Step 1.3: Define canonical key order, escaping, integer forms, final newline, duplicate-key rejection, and SHA-256 digest input.
2.  **Phase 2: Generate and validate bounded packets**
    *   Step 2.1: Preserve capped Git execution, exact commit resolution, ancestry, safe-path checks, blob object verification, and complete Git-generated hunks.
    *   Step 2.2: Split only representation strings, never omit bytes. Reconstruct every hunk and compare byte-for-byte to the admitted Git diff before output.
    *   Step 2.3: Measure encoded physical lines after JSON escaping and reject any line, segment count, depth, metadata, packet, or aggregate bound violation.
    *   Step 2.4: Implement streaming/capped input validation so an unbounded packet is rejected before full allocation.
3.  **Phase 3: Cut over readers without downgrade**
    *   Step 3.1: Update the scoped reviewer to consume v3 and cite logical diff lines, not transport segments.
    *   Step 3.2: Retain v2 validation only for existing v2 markers and label it packet-consistency evidence.
    *   Step 3.3: Make new packet generation default to v3 only after tests pass; AIDEV-159 owns final-gate enforcement.
4.  **Phase 4: Rollback**
    *   Step 4.1: If v3 must be disabled, stop issuing v3 packets while retaining the reader/validator and frozen v2 path. Never hash v3 bytes as v2 or vice versa.

## Test Matrix
*   **Target Command**: `node --test tests/scoped-review-packet.test.mjs tests/adversarial-review-attestation.test.mjs`
*   **Validation Scenarios**:
    *   [ ] `A156-T01` A representative 55 KiB multiline hunk is complete and every encoded physical line stays within the numeric bound.
    *   [ ] `A156-T02` Reassembling logical lines and segments reproduces exact canonical hunk bytes.
    *   [ ] `A156-T03` Segment removal, duplication, reordering, byte-length change, or digest change is rejected.
    *   [ ] `A156-T04` UTF-8 multibyte boundaries are never split incorrectly; unsupported bytes fail closed.
    *   [ ] `A156-T05` Deep JSON, duplicate keys, huge counts, oversized metadata, segment bombs, subprocess overflow, and timeout paths reject before unbounded allocation.
    *   [ ] `A156-T06` Unsafe paths, replacements, inherited Git variables, textconv/external diff, binaries, links, modes, submodules, and renames retain explicit fail-closed behavior.
    *   [ ] `A156-T07` Two v3 generations from the same immutable range produce identical bytes and digest.
    *   [ ] `A156-T08` Historical v2 marker fixtures validate only through frozen v2 bytes and are rejected by the v3 final-gate class.
    *   [ ] `A156-T09` No filesystem publication occurs; parent-directory symlinks and trace destinations remain untouched.
