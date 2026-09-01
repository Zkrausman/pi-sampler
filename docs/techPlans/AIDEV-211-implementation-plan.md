# AIDEV-211 implementation plan — Docker whole-process filesystem boundary

## 0. Frozen identity, authority, and remediation state

This is the one human-authorized conformance correction after the prior
human-resolution correction. The same Sol/medium reviewer returned
`changes_required_human_escalation` in human-resolution verification. The
complete report is
`E:\Repos - Non Indexed\pi-sampler\.git\pi-handoffs\AIDEV-211\planning\independent-review-v1\human-resolution-verification\review-tab-output.md`.
The conformance authorization comment `b7ea4ed3-f294-4798-bb21-4e582ecb4221`
records verbatim: `Authorize removal of the stale pre-merge Windows clause: missing Windows evidence blocks only Phase-B canary and activation, not the Phase-A S8 merge. Return the complete pair to the same reviewer.` This correction removes only that stale Section 1.2 clause and preserves the approved F1 provenance route, two-phase lifecycle, and all existing authorities.
It is not a new automatic remediation, challenge, planner, or reviewer; the
complete corrected pair must return once to that same reviewer. Human
resolution is not plan approval or implementation/lifecycle authority.

The pair remains an uncommitted planning handoff. It is not implementation
authority, plan approval, child-ticket creation authority, tracker or
publication authority, commit/push/PR authority, review-marker or receipt
authority, or merge authority. Only the exact user action `Merge PR #N` is
merge authority.

| Binding | Frozen value |
|---|---|
| Ticket | `AIDEV-211` — Enforce lease-bound filesystem sandboxing across delivery worktrees |
| Repository | `Zkrausman/pi-sampler` |
| Trusted planning base and planning HEAD | `006d3e6f0030e7832250e3e0f8768a30b0995244` |
| Planning worktree | `E:\Repos - Non Indexed\ai-workspaces\plan\AIDEV-211-9c726f` |
| Branch | `zkrausman/aidev-211-plan-implementation-plan-9c726f` |
| Purpose | `plan` |
| Lease ID | `6d2ff471efb0edc7736c9870` (the lease token is never copied into this plan, manifest, child, container, session, or evidence) |
| Approved profile | `profiles/pi-sampler.json` |
| Profile SHA-256 | `96e4b00bc78b16b5e544ee48f369137c74a2ef040c7b226b5c88d542d2e6a6c9` |
| Current ticket revision | `e36aec6764fce5b6886b4551c4d90411c4a1ca85f1817812262ef73fa4a1d60a` |
| Authorization | Linear comment `30086905-d4ec-4d60-b4b0-8fc6cd482ecd`; planning with Docker only |
| Remediation status | `ready_for_same_reviewer_verification` after validator, tests, and inventory gates pass |

The current Linear issue, all six comments, all relations, and the GitHub
mirror `Zkrausman/pith#78` were re-read read-only for this correction. The
conformance-authorization comment changes the selected Linear projection.
Canonical recursively sorted JSON over the selected issue/mirror/comment
object is 4,537 bytes and hashes to
`e36aec6764fce5b6886b4551c4d90411c4a1ca85f1817812262ef73fa4a1d60a`; this is
the retained current ticket revision. The issue is `AI Executing`, urgent,
parent `AIDEV-168`, blocks `AIDEV-208` and `AIDEV-202`, and relates to
`AIDEV-207`. The mirror is open, unchanged, and has no comments. The live
re-read and canonical revision check are recorded outside Git in the
human-conformance-correction evidence directory.

The prior Stage 1 remains exactly one draft, one high-risk challenge, and one
integrated revision. This conformance correction launches no new planner,
challenge, or reviewer. No Linear child IDs are fabricated. If lifecycle
policy later requires child IDs, the orchestrator must stop before coding and
perform a separately authorized JIT child-binding/rebind.

### 0.1 R1 review-workspace precondition remains resolved

This plan does not alter source or Git configuration for R1. The Orchestrator
must retain the already-proven clean review-workspace requirement when it
returns this pair to the same reviewer: reprovision a clean managed base
workspace/process, set `GIT_CONFIG_GLOBAL=NUL` and `GIT_CONFIG_NOSYSTEM=1`,
set `GIT_CONFIG_SYSTEM=NUL` on Windows (or the platform-equivalent empty
system/global configuration), and prove that
`git config --show-origin --get-regexp '^user\.(name|email)$'` returns no
effective fields before reading the pair. The current review tab must not be
repaired or reused. The same reviewer must verify the complete corrected plan
and manifest, not only the V1–V3 delta.

## 1. Outcome and security boundary

### 1.1 Required outcome

Make cross-worktree and cross-vault writes impossible by construction for
managed `plan`, `dev`, `review`, and `orchestrator` operations. Every
write-capable Pi process, built-in tool, project/global extension, SDK caller,
wiki action, subagent, shell, interpreter, package script, and descendant
must execute inside one Docker-enforced process/filesystem boundary derived
from a trusted capability. A host that cannot prove that boundary is not a
managed write host.

The only public denial for provider admission, daemon availability,
version/policy support, image/build/publication trust, mount admission,
runtime binding, runner capacity, activation, or confinement-probe failure is
the bounded no-echo token `blocked/unsupported_host`. It must be returned
before starting Pi, a write-capable extension, a background task, a subagent,
or any other managed write-capable process. There is no host-side Pi
fallback, wrapper-only confinement, cleanup recovery, or partially wrapped
mode. Read-only inspection may remain available only through a separately
bounded path.

### 1.2 Supported provider and host matrix

Docker is the sole v1 hard-boundary provider:

| Host class | Supported boundary | Admission condition |
|---|---|---|
| Linux | Approved Docker Engine running Linux containers | Trusted CLI/daemon identity, Linux namespaces/cgroups/security settings, immutable images/builds, private network policy, trusted runner attestation, and every real probe pass |
| Windows | Docker Desktop using its Linux backend | The same Linux-container policy plus Docker Desktop/Linux-backend identity, volume semantics, trusted runner attestation, and every real probe pass |
| Other hosts | None in v1 | Return `blocked/unsupported_host` before any managed write-capable process starts |

The planning environment has no evidence of an attested dedicated Windows
Docker Desktop runner. Therefore Windows is not claimed as currently
admitted: missing, queued, skipped, or failing required runner/real-job
evidence blocks only Phase-B admission, the exclusive canary, and activation,
leaving state `pending-admission`/unsupported or `blocked`. It does not prevent
the separately authorized Phase-A S8 merge under the existing protected checks
and exact user-only merge authority. No ordinary managed operation starts and
no unsandboxed fallback is permitted. Windows path algebra may be unit-tested
in the preparatory graph, but that is not Windows managed-write proof.

The trusted provider policy is read only from an exact trusted Git base, never
from candidate files, ticket text, environment selectors, CLI flags, or a
mutable working-tree profile. The policy path is
`governance/docs/workspace-sandbox/docker-policy-v1.json`. It contains these
immutable registry subjects in addition to the Docker policy:

```text
registry_host: ghcr.io
workload_subject: ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload
relay_subject: ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay
provenance_subject: ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance
```

Those subjects are trusted constants. An environment value may carry a
subject only after the trusted policy verifier has compared it byte-for-byte
with the corresponding constant; an environment value, tag, CLI argument, or
candidate file can never select or replace a subject.

The trusted build context paths are:

```text
docker/workspace-sandbox/Dockerfile
docker/workspace-sandbox/provider-egress.Dockerfile
docker/workspace-sandbox/runtime/package.json
docker/workspace-sandbox/runtime/package-lock.json
docker/workspace-sandbox/runtime/pi-config.json
docker/workspace-sandbox/runtime/subagent-policy.json
docker/workspace-sandbox/runtime/managed-entrypoint.mjs
```

The candidate files describe and test the policy but cannot select an active
provider or image. The trusted post-merge provenance output, not a candidate
`image-lock.json`, is the only image authority. Its fixed OCI subject is
`ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance`, and its exact
controller materialization path is
`control-plane/AIDEV-211/trusted-image-lock-v1.json` under the
operator-owned, separately authenticated provenance store. The lock binds
the workload and relay image references to immutable OCI digests, the exact
base-image digest, Dockerfile/context digests, runtime package-lock digest,
entrypoint digest, fixed registry subjects, trusted-main workflow identity,
signatures, runner attestations, and provenance. A missing, stale, ambiguous,
tag-only, locally built, or mismatched value blocks.

Provider admission runs in the trusted host controller before `docker create`
or `docker run` and verifies, with bounded fixed-identity commands:

1. the Docker CLI is present at an approved executable identity and its
   client/server version and API are in the trusted policy;
2. the daemon responds, reports Linux containers, and is the permitted Docker
   Desktop Linux backend on Windows or permitted Docker Engine on Linux; a
   stopped daemon is a block;
3. the workload and relay images are present at the exact trusted digests, or
   a trusted post-merge builder has reproducibly produced, pushed, signed,
   and separately verified them from the exact context and pinned base image;
4. the effective container configuration enforces non-root execution,
   dropped capabilities, no-new-privileges, read-only root, private
   namespaces, resource bounds, exact named volumes, and the approved
   network policy; and
5. disposable real process-level probes prove an allowed private-volume write
   and denied forbidden-root writes before a user workload is admitted.

A failed command, timeout, unknown output, policy mismatch, unsupported flag,
probe failure, unavailable runner, publication mismatch, or ambiguous identity
maps to `blocked/unsupported_host` without echoing paths, commands,
credentials, daemon errors, lease data, or raw child output. The controller
never retries by launching Pi on the host.

### 1.3 Exact bootstrap, final-main event, canary, and activation lifecycle

The lifecycle is deliberately separate from slice implementation order.
S0 through S7 are preparatory. Candidate implementation and Phase-A PR tests
for S0 through S8 execute under the existing legacy unsandboxed bootstrap
workflow (`.github/workflows/validate.yml`, its `test`/`governance` jobs, and
the bounded local commands below). Those processes are not confinement proof, are
not a managed activation, and do not select a provider, registry subject,
image, or activation state. Candidate Docker probes may collect untrusted
candidate evidence, but no candidate workflow, container, image, test output,
or S7 publication code can select `active`.

Preparatory slices are inert or fail-closed. In particular, S1 provider
admission cannot activate a managed workload by itself, and the S8 Phase-A
merge cannot activate one before the trusted final-main event and Phase-B
gates. No S1-only activation
exists; S2's independent clone/broker, S3's runtime, S4's complete-Pi
entrypoint, S5's session/subagent/wiki controls, S6's evidence core, and S7's
trusted-main publication/CI workflow must all be present in the exact trusted
main base before S8 can consume an activation record.

The trusted controller uses two immutable event records, both validated from
trusted main and never supplied by a candidate, environment selector, or
workload output. After S7 merges it produces
`control-plane/AIDEV-211/merged-s7-event-v1.json`. Its signed
`merged_main_sha` is the JIT base for the S7 post-merge publication/matrix
run, and its ordered predecessor graph must contain the complete S0–S7 graph.
After S8 merges it produces
`control-plane/AIDEV-211/merged-final-slice-event-v1.json`. Its signed
`merged_main_sha` is the JIT final activation base, and its ordered
predecessor graph must contain the complete S0–S8 graph. Both records bind
`repository`, `main_ref`, merged PR/event identity, trusted-main ancestry,
exact tree/artifact digests, workflow SHA, ticket revision, ruleset/receipt
binding, and expiry. The S7/S8 controllers accept only their fixed record
path, verify its signature, repository and exact merged PR event, prove every
predecessor is an ancestor of `merged_main_sha`, check the complete required
tree/artifact inventory, and reject candidate/env text that attempts to
replace any field. The original planning base remains a planning/validator
identity only; it is never an activation base.

S7's trusted post-merge main workflow is the non-candidate publication
authority. First, after S7 merges, it uses the authenticated S7 event and
runs the following sequence against the complete S0–S7 graph. The same fixed
workflow and commands are rerun after S8 merges with the authenticated final
S8 event; that second run is the only publication/matrix output eligible for
S8 activation:

1. verify the exact `merged_main_sha` from the phase-specific trusted event
   and the complete phase-specific predecessor/tree graph;
2. run the pinned Node/Docker/build/sign tools, using the exact base image
   `docker.io/library/node:24.14.0-bookworm-slim@sha256:4bd6219054c8bebcd26a66bfd8ca0bd6e1024b4b97474c59bb7ee3bbcbef4fe8`
   for the supported x64 Linux-container route;
3. reproducibly build and push separate workload and provider-egress images
   to the fixed subjects, with immutable SHA-qualified results, BuildKit
   metadata/provenance, and SBOM; parse the pushed registry attestation and
   metadata into one validated canonical SLSA predicate bound to each fixed
   subject and digest. BuildKit provenance is predicate input only, not a
   cosign attestation;
4. keylessly sign both digest references with `cosign sign`, then explicitly
   create separate keyless SLSA attestations with
   `cosign attest --yes --type slsaprovenance --predicate <validated-predicate>`
   under the protected GitHub OIDC main-workflow identity;
5. use a separate verifier with exact certificate identity and issuer to run
   both `cosign verify` and `cosign verify-attestation`, and independently
   validate the returned predicate, subject, digest, merged-main event, and
   build inputs; and
6. publish and sign the immutable image-lock/provenance record at the fixed
   provenance subject, materialize the verified digest-qualified record at
   `control-plane/AIDEV-211/trusted-image-lock-v1.json`, and bind it to the
   phase-specific main SHA, context, Dockerfiles, runtime lock, relay policy,
   runner attestations, attestation verification records, and workflow SHA.

The S7 PR has no registry publication credentials, `packages:write`, signing
identity, ruleset-mutation, or admission authority. Each post-merge
trusted-main execution is a separate controller event after its corresponding
slice is merged; it is not candidate or container self-publication. A later
S8 activation consumes only the signed record from the final S8 event, and the
future-context ruleset update occurs only in Phase B after the S8 merge.

The exact state artifacts are:

```text
governance/docs/workspace-sandbox/activation-declaration-v1.json
governance/docs/workspace-sandbox/activation-profile-v1.json
governance/docs/workspace-sandbox/activation-profile-v1.schema.json
governance/docs/workspace-sandbox/activation-state-v1.schema.json
governance/docs/workspace-sandbox/rollback-record-v1.json
governance/docs/workspace-sandbox/rollback-record-v1.schema.json
governance/docs/workspace-sandbox/merged-final-slice-event-v1.schema.json
governance/docs/workspace-sandbox/ruleset-transition-v1.schema.json
control-plane/AIDEV-211/merged-s7-event-v1.json
control-plane/AIDEV-211/merged-final-slice-event-v1.json
control-plane/AIDEV-211/trusted-image-lock-v1.json
control-plane/AIDEV-211/activation-state-v1.json
control-plane/AIDEV-211/ruleset-transition-v1.json
```

The first eight are trusted-main declarations/schemas and the last five are
controller-owned state/event/provenance/ruleset records outside Git. The
declaration has `initial_state: "disabled"` and enumerates exactly `disabled`,
`prepared`, `pending-admission`, `canary`, `active`, `blocked`, and
`rolled-back`. It records that candidate bytes cannot select `active`. The
profile contains the exact trusted final-main event binding,
policy/runtime/registry digests, network/mount policy, host-class evidence
references, canary operation class, ruleset-transition digest, and image-lock
digest; its candidate form cannot contain an active image or a mutable tag.

| State | Entry and permitted behavior | Exit |
|---|---|---|
| `disabled` | Initial exact-base state. Legacy bootstrap may run ordinary tests, but there is no managed write activation and no provider/image selection. | Only an exact trusted main base containing S0–S8 and the complete activation declarations may move to `prepared`. |
| `prepared` | S0–S8 are present in trusted main; broker, complete-Pi runtime, session/wiki controls, evidence, publication, runner, ruleset, rollback, event verification, and activation declarations exist. No managed workload starts. | A trusted controller verifies the final-main event and signed lock prerequisites, then moves to `pending-admission`; any missing prerequisite remains blocked. |
| `pending-admission` | The controller has an authenticated immutable `merged_main_sha` and waits for signed workload/relay/provenance records, package-lock/entrypoint/context matches, both runner attestations, ruleset and receipt bindings, and the real protected matrix. It starts no Pi, write-capable descendant, ordinary session, export, or background task. | All non-canary checks pass, including the post-merge ruleset readback -> `canary`; any failure -> `blocked` or, when replacing an active generation, `rolled-back`. Missing, queued, skipped, or failing Windows capacity/evidence stays pending/unsupported or blocked and cannot permit the canary or activation; it does not change the Phase-A S8 merge gate. |
| `canary` | Exactly one capability-bound run, `A211-activation-0001`, may execute the fixed activation-canary operation class. It may run the bounded real T01/T06 probes in isolated volumes and emit controller-collected canary evidence. Every ordinary managed workload, export, resume/session, retained recovery, subagent background task, and user operation is denied before execution. No ordinary managed authorization exists in this state. | Canary and all already-bound Linux/Windows matrix, image/provenance, ruleset, and receipt evidence pass -> one atomic compare-and-swap to `active`; canary failure -> `blocked` for first activation or `rolled-back` for a replacement. |
| `active` | Only after the atomic canary-success transition may the controller issue ordinary fresh capabilities and start managed workloads through the complete Docker entrypoint. Every child, export, and background action remains bound to this active record. | Revocation, expiry, image/provenance mismatch, runner loss, or failed probe stops the full tree and moves to `rolled-back`; a pre-start failure moves to `blocked`. |
| `blocked` | No managed write-capable process starts. The controller retains bounded failure evidence and does not use a host or legacy fallback. | Only a newly verified final-main event/provenance/runner set and explicit controller re-admission can return to `pending-admission`; never directly to `active`. |
| `rolled-back` | The old container is stopped, capabilities revoked, volumes quarantined, exports rejected, and managed activation is disabled. Rollback never restores unsandboxed managed execution. | Only a separately verified new trusted main/event/provenance set can return to `pending-admission`. |

The first protected managed use is activation canary
`A211-activation-0001`. The controller first verifies the final-main event,
real Linux and admitted Windows protected matrix, fixed-subject image lock,
provenance/signatures, ruleset, receipt, and S0–S8 graph, then atomically
moves `pending-admission` to `canary`. It creates one capability whose
operation class is exactly `activation-canary`, private volumes/networks,
independent clone, and complete-Pi entrypoint from the verified digest. The
canary runs only the fixed T01/T06 probes, exports no user or plan bytes, and
is the sole allowed managed process in `canary`. Only after its bounded
controller evidence passes does a compare-and-swap atomically set `active`.
S0–S7 tests, a candidate image, a local Docker build, and activation unit
tests are not the first protected use.

A merge-to-admission failure is safe: merging under the existing Phase-A protected checks S0–S8 leaves the trusted
activation declaration `prepared` until the authenticated final-main event
and external records exist; failed build, push, signature, verifier, ruleset,
runner, receipt, or matrix checks leave it `pending-admission` or `blocked`
and start no managed Pi. The new Phase-B contexts are not required for that S8 merge and are not fabricated as passing. If replacing an active release, the controller
quiesces ordinary use before entering `canary`; there is no ordinary-use
interval in the new generation's canary state. A canary failure performs no
`active` transition and enters `rolled-back` or `blocked`, stops/quarantines
its resources, revokes its capability, and rejects exports. The original
unsandboxed workflow may continue to run explicitly classified legacy tests,
but is never restored as managed execution. The only possible unsupported
host result is `blocked/unsupported_host`.

### 1.4 Executable Pi/subagent/wiki runtime route

The managed image has an isolated runtime root at `/opt/pi-runtime`. It never
uses host `node_modules`, `~/.pi`, `NODE_PATH`, global npm packages, project
package discovery, ambient `PATH` lookup, host extensions, or host custom
tools. The exact direct runtime pins are:

| Component | Exact pin | Managed v1 rule |
|---|---|---|
| Node | `24.14.0`, from the pinned Linux x64 base image above | Image lock records the base digest and the runtime reports the exact `process.version`; mismatch blocks |
| Pi | `@earendil-works/pi-coding-agent@0.84.2`; npm tarball integrity `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==` | Loaded only from the isolated runtime lock and image |
| Subagents | `pi-subagents@0.61.0`; npm tarball integrity `sha512-ed8XbIZtOainz2cvjF9WHAwbGsDY0JH2YLs6ErbGmc09JHRA17U43QiL8jA5DjI+1lVgzXLJhmNW7Ft1XL5lNA==` | Loaded only inside the workload container through the fixed in-container adapter; external CLI agents and host runners are absent |
| Wiki package observed on the host | `@zosmaai/pi-llm-wiki@0.11.7`; npm tarball integrity `sha512-BB3MQ+8f3x3Pv5KeowKdqdlpdQJR0GiOOeEDZkCFx51n0C1HUVevM72Aggm1YY5LzlsTCfccRzNE3VynI2EeSw==` | **Not packaged, not imported, not discovered, and not loaded in managed v1.** This explicit absence is the selected fail-closed route. |
| Subagent direct dependencies | `acorn@8.18.0`, `jiti@2.7.0`, `typebox@1.1.38`, and `yaml@2.8.3` | Exact versions and integrities are recorded in the isolated lock; no range or ambient resolution is accepted |

The isolated runtime package and entrypoint paths are owned by their
consuming slices:

```text
docker/workspace-sandbox/runtime/package.json
docker/workspace-sandbox/runtime/package-lock.json
docker/workspace-sandbox/runtime/pi-config.json
docker/workspace-sandbox/runtime/subagent-policy.json
docker/workspace-sandbox/runtime/managed-entrypoint.mjs
docker/workspace-sandbox/runtime/wiki-disabled.mjs
```

`runtime/package-lock.json` is lockfile v3 and must bind every package in the
runtime closure to an exact version, registry tarball, and integrity. It may
not contain an unresolved range, Git dependency, mutable URL, host/file path,
or optional ambient package. The image builder installs only from this lock
and an allowlisted offline cache inside the build context/container; it does
not install into the linked worktree. The root repository
`package-lock.json` remains only for legacy bootstrap tests and is not a
managed runtime dependency.

`pi-config.json` lists only absolute image-local extension paths and the
fixed in-container subagent adapter. It contains no wiki extension, wiki MCP
server, automatic observation/retro hook, host package path, or deferred
host loader. `managed-entrypoint.mjs` validates the runtime lock digest,
package versions/integrities, image-provided entrypoint digest, `process.execPath`,
empty global-discovery settings, absence of the wiki package, and the disabled
wiki policy before importing Pi or resolving a vault. It then invokes the
pinned Pi CLI from `/opt/pi-runtime` with a fixed argv vector; the user and
candidate cannot replace that vector.

The subagent adapter imports only the pinned `pi-subagents` APIs needed for
in-container child creation and sets a fixed child policy: child processes
inherit the same container, capability digest, private volumes, networks,
expiry, and output redaction. External runners, host panes, host cwd values,
Docker APIs, detached retained runs, and unmanaged background work are
rejected. Managed resume and retained-recovery actions are disabled
fail-closed in v1. A resume request returns `blocked/unsupported_host` before
child execution; v1 has no rebind shortcut. A separately authenticated
capability rebind may be added only by a future authorized change and would
have to issue a new container, generation, and capability.

`wiki-disabled.mjs` is a small in-image denial module, not the mutating wiki
extension. It is loaded before any vault discovery and returns the bounded
denial for observe, retro, capture, ingest, ensure-page, metadata rebuild,
indexing, event, and automatic session observation calls without touching
`cwd`, `process.cwd()`, `WIKI_HOME`, project discovery, or a vault. Read-only
wiki retrieval is also absent in v1 because no separately authenticated
read-only capability exists. The image build asserts that
`@zosmaai/pi-llm-wiki@0.11.7` is absent and the entrypoint asserts it again.
The candidate and all managed `.llm-wiki` bytes are snapshotted and must be
byte-identical after every attempted route.

The runtime route has these JIT outputs and staleness conditions:

| Output | Producer/consumer | Required contents |
|---|---|---|
| `A211-S3-runtime-lock-v1` | S3 merged output consumed by S4/S5/S7 | Runtime package/lock SHA-256, exact Node/Pi/subagent pins, explicit wiki absence, fixed Pi argv, and lock closure/integrity report |
| `A211-FINAL-trusted-image-provenance-v1` | Trusted post-S8-merge main builder only; consumed by S8 | Final merged main SHA, workload/relay/base/context/package-lock/entrypoint digests, fixed subjects, image signatures, canonical SLSA predicates, keyless cosign attestation records, registry record digest, and separate predicate/signature verification results |
| `A211-FINAL-runner-matrix-v1` | Trusted CI/controller only; consumed by S8 | Linux Engine and Windows Desktop Linux-backend labels, attestation, capacity, preflight, exact command results, and evidence digests |
| `A211-S8-activation-record-v1` | S8 trusted controller only; consumed by first ordinary protected use | Event/profile/state digest, provenance and separate-attestation predecessor digests, ruleset-transition/receipt digest, host matrix, canary result, and rollback pointer |

These are local output-contract names, not Linear child IDs. The orchestrator
must bind their actual merge SHAs and digests immediately before each slice;
no unknown image, lock, final-main, or child digest is fabricated in this
plan. A change to any direct version, tarball integrity, lock bytes,
package-manager version, entrypoint bytes/argv, explicit wiki absence,
image/context/base digest, registry subject, provenance signer, runner
contract, final-main event, or canary contract makes the pair stale and
blocks the next slice.

### 1.5 Process topology and Docker invocation

The host-side controller is a narrow trusted control plane, not Pi, an
extension, an SDK tool, a wiki worker, a user shell, or a candidate process.
It may validate trusted inputs, invoke the fixed Docker CLI, monitor expiry,
stop a container, and broker verified byte transfers. It may not execute
candidate commands or expose the Docker socket to a container. Pi and every
write-capable descendant run in the same workload container; no custom Pi
tool or extension remains host-side.

The workload is created with an exact fixed argument vector, not shell text:

- `--rm`, private PID/IPC/UTS/cgroup namespaces, non-root image user
  `1000:1000` (or the exact trusted UID/GID in the image lock),
  `--cap-drop=ALL`, `--security-opt=no-new-privileges:true`, `--read-only`,
  `--init`, and fixed memory/CPU/PID/file-size/time limits;
- no `--privileged`, `--pid=host`, `--network=host`, host IPC, host devices,
  host SSH agent, Docker socket/daemon API, `--volumes-from`, broad home,
  root, parent-directory, repository, `.git`, or host temp mounts;
- only named per-run Docker volumes: read/write workload at `/workspace`,
  bounded scratch at `/scratch`, read-only input at `/run/input`, private
  read/write session at `/run/session`, read/write export at `/run/export`,
  and a read-only single-secret volume at `/run/secrets/provider` for the
  relay only; and
- the fixed image entrypoint starts Pi, selected in-image extensions, SDK
  callers, subagents, shells, interpreters, package scripts, and descendants
  within this same container. Command substitution not in the trusted image
  lock blocks.

There is no writable host bind. The linked worktree, primary checkout,
repository `.git` common storage, sibling worktrees, quarantine, sessions,
canonical wiki, and credentials are never mounted. A logical capability may
name the leased host worktree and external evidence root, but the container
receives only a per-run volume-backed workspace.

### 1.6 Network, credentials, and sessions

Provider-enabled runs use exactly two per-run Docker networks. The Pi
workload attaches only to internal `pi-internal`, with no default route to the
host or Internet and no published ports. A pinned least-privileged
`provider-egress` relay attaches to `pi-internal` and a separate outbound
`provider-egress` network; only the relay reaches approved provider
endpoints. The relay has no workspace-volume access and is not a Pi custom
tool. Runs that do not need a provider use `--network=none`. Missing network,
relay, endpoint allowlist, or outbound-policy proof is
`blocked/unsupported_host`; there is no direct bridge/host-network option.

The operator supplies one short-lived provider credential through a dedicated
per-run secret volume. Only the relay mounts the single required file
read-only at `/run/secrets/provider`; it is not an environment variable and
no home, SSH agent, browser store, or unrelated credential set is mounted.
The session seed is copied into `/run/input`; runtime state is only in
`/run/session`. Secret, input, and session volumes are destroyed after broker
verification or quarantined on block.

The external session descriptor binds an opaque run/container and volume
identity, ticket, repository, exact final-main base/event, lease generation,
capability digest, role/mode, and expiry/revocation epoch. It contains no
lease token. Because managed resume/retained recovery is disabled in v1, a
resume never starts a child; only a future separately authorized authenticated
rebind could issue a new descriptor/container. A moved, quarantined,
deleted/recreated, stale, or differently leased cwd is never reused.

### 1.7 Snapshot, workspace, and export/import broker

The trusted controller validates repository and lease identity using canonical
physical identity, then streams a bounded Git bundle or equivalent verified
snapshot into the input volume without mounting the linked worktree. Inside
the container it imports a full independent clone with its own `.git` and
checks out the exact final-main event SHA detached. No common Git storage,
alternates, hooks, repository-global refs, worktree pointers, or sibling refs
enter the container. A bundle/object mismatch blocks.

At completion, a separately authenticated export broker reads `/run/export`,
validates capability digest/generation, role/mode, closed-world allowlist,
regular-file modes, byte limits, UTF-8/digest rules, and before/after
inventory, then transfers only approved bytes. Planning export may write only:

```text
docs/techPlans/AIDEV-211-implementation-plan.md
docs/techPlans/AIDEV-211-acceptance-manifest-v2.json
```

into the already verified leased planning worktree. It may not write any
other worktree, `.git`, lease record, or repository-global path. Review source
is never exported as a write; only the exact external evidence root is
eligible. All host writes occur after revalidation and through OS-native
identity-safe operations, followed by exact inventory checks.

The broker uses copy/volume semantics rather than a broad writable bind.
POSIX uses no-follow directory/file handles and device/inode identity.
Windows uses handle-based final-path, volume/file-ID, reparse-point,
case/ADS, and ancestor identity checks. It rejects symlink, junction, mount,
reparse, hard-link, cross-volume, sparse, special-file, parent-swap, and
TOCTOU substitutions. Ambiguous rename or identity change preserves staging
for manual disposition and returns a bounded block; it never cleans an
unrelated path.

### 1.8 Capability and role contract

S0 issues a trusted immutable capability with repository identity and the
exact final-main event/base; ticket; lease ID/generation; canonical physical
workspace and disjoint external-root identities; role/mode; explicit
read/write roots; canonical-wiki decision; expiry/revocation; provider,
registry/image/build/network policy digest; per-run container/volume identity;
capability digest; and bounded resource/denial policy.

The lease token remains an existing host-side ownership secret. It is used
only by the trusted controller and is never passed to Pi, a child, an
environment, a session descriptor, a Docker volume, a manifest, or evidence.
Capability issuance fails on exact event/base/profile/lease mismatch,
physical identity drift, root overlap, missing expiry/revocation, or
unsupported role. `plan` and `dev` mutate only the private run workspace and
broker-approved handoff/evidence output. `review` is read-only for source and
may mutate only its exact external evidence output. `orchestrator` operates
the narrow control plane and explicit lease/evidence records without
candidate or merge authority.

At expiry or revocation, the controller stops/kills the complete container
process tree, invalidates the capability generation, refuses export, and
quarantines the run volume. A background task must revalidate immediately
before mutation; in v1 unmanaged retained/background work is disabled.

### 1.9 Managed wiki policy

Managed v1 does not load `@zosmaai/pi-llm-wiki` or any mutating wiki
extension. Observation, retro, capture, ingest, ensure-page, metadata rebuild,
indexing, event, automatic observation/retro, and MCP wiki surfaces are
absent or rejected by the pre-load denial module. This happens before vault
discovery or session start. No candidate-local or sibling `.llm-wiki` can be
selected by `cwd`, `process.cwd()`, `WIKI_HOME`, project discovery, a deferred
closure, or a session variable. Read-only retrieval is absent unless a future
separately authenticated capability is approved.

The candidate `.llm-wiki` bytes are snapshotted before and after every
attempted wiki route and must remain byte-identical, as must all managed
workspace bytes. The installed host package and its guards are not treated as
a capability and are not copied into the image. A future canonical-vault API
is not a v1 fallback.

## 2. Strict serial implementation graph

All slices are serial and have one writer. S0–S7 are preparatory and cannot
select activation. Their tests run under legacy bootstrap and are not
confinement proof; the real protected matrix and publication are rerun by the
trusted S7 main workflow after the final S8 merge and consumed by S8. Each
slice has a credible estimate no greater than 1,500 meaningful changed lines
including tests and generated lock/config text. Before coding a slice, the
orchestrator records exact path/function/test inventory, predecessor merge
SHA, output-contract digest, and `credible_le_1500: true`. If that cannot be
maintained, coding stops and a new cohesive graph requires separate
authorization. No arbitrary file fragmentation is permitted. The exact order
is `S0 -> S1 -> S2 -> S3 -> S4 -> S5 -> S6 -> S7 -> S8`.

Every slice requires exact-head independent review, protected CI, DCO, and
explicit user `Merge PR #N` authority. A merge produces only a JIT-bound
output contract; it does not authorize its successor. Existing packet-v3,
receipt-v1, marker-v3, review-policy, lease lifecycle, external evidence, and
human-only merge controls remain unchanged.

### S0 — capability contract and exact dot-path ownership

**Predecessor:** exact trusted planning base; none. **Purpose:** define the
trusted capability, canonical physical-root identity model, role/write-root
matrix, expiry/revocation semantics, bounded denial envelope, and a
schema-valid exact ownership expansion for dot-prefixed governance paths.
S0 validates/records capabilities and ownership only; it cannot start a
managed write process, select a provider, or claim OS confinement.

The existing manifest-v2 structural schema permits a semantic symbol value
whose literal grammar is `path:<literal-relative-posix-path>`. S0 owns the
separately reviewed companion contract that expands such symbols before
implementation scope is accepted:

```text
ownership.symbols: path:.github/workflows/aidev-211-sandbox.yml
ownership.symbols: path:.github/runner-contracts/aidev-211-sandbox-runner-v1.json
```

`validateOwnedDotPaths` strips only the `path:` prefix, rejects globs,
aliases, traversal, case-folded duplicates, separators other than `/`,
symlinks/reparse points, and non-regular files, and returns the literal
repository-relative paths. It compares the expansion to the complete closed
candidate inventory and requires both exact `.github` paths. The safe
`ownership.files` array continues to hold the portable non-dot paths; these
`path:` symbols are not generic aliases. No S2–S8 slice may rely on the
workflow/runner files until the S0 companion contract has merged and its
trusted output has been revalidated.

**Candidate paths:**

```text
contracts/workspace-capability-v1.mjs
contracts/workspace-capability-v1.schema.json
contracts/implementation-plan-manifest-v2-dotpath.mjs
contracts/implementation-plan-manifest-v2-dotpath.schema.json
scripts/workspace-capability.mjs
scripts/delivery-worktree.mjs
scripts/validate-manifest-owned-paths.mjs
tests/workspace-capability.test.mjs
tests/delivery-worktree.test.mjs
tests/manifest-owned-paths.test.mjs
tests/fixtures/workspace-sandbox/capability-vectors.json
```

**Implementation and proof:** require exact lowercase base/event identity,
approved profile/repository/ticket, authenticated lease ownership, immutable
workspace and external-root identities, disjoint roots, explicit role/mode,
expiry, revocation generation, provider binding, and digest. Test the exact
`path:` expansion against literal workflow/runner files and the closed-world
inventory. Test Windows drive/case/separator/UNC/device/reparse/junction/
ADS/reserved-name and POSIX symlink/mount/device/inode/no-follow vectors,
overlap, hard-link identity, delete/recreate, expiry/revocation, exact
base/profile/ticket binding, secret redaction, and proof S0 alone cannot
authorize a write.

**Legacy command:**
`npm ci --ignore-scripts --no-audit --no-fund && node --test tests/workspace-capability.test.mjs tests/delivery-worktree.test.mjs tests/manifest-owned-paths.test.mjs`.
This is ordinary bootstrap evidence, not confinement proof.

**Output:** `A211-S0-capability-dotpath-contract-v1`, capability and literal
path-expansion contract SHA plus vectors digest. **Estimate:** 1,150 meaningful
lines; 5–7 engineering days. Native identity or exact-path
expansion unavailability is a block, never a Node path-wrapper fallback.

### S1 — Docker provider policy and fail-closed admission

**Predecessor:** `A211-S0-capability-dotpath-contract-v1`. **Purpose:** define
the trusted policy and fixed Docker admission/launcher contract. S1 exposes no
managed workload activation; an S1-only path is invalid.

**Candidate paths:**

```text
governance/docs/workspace-sandbox/docker-policy-v1.json
contracts/workspace-sandbox-provider-v1.mjs
contracts/workspace-sandbox-provider-v1.schema.json
scripts/workspace-sandbox-policy.mjs
scripts/workspace-sandbox-docker.mjs
tests/workspace-sandbox-policy.test.mjs
tests/workspace-sandbox-docker.test.mjs
```

**Implementation and proof:** implement fixed executable/version discovery,
Docker daemon/backend/API checks, policy and image-lock authority checks,
non-root/dropped-capability/read-only-root/resource checks, named-volume-only
mount admission, no-socket/no-privilege/no-host-namespace checks, exact
`pi-internal`/relay network policy, fixed registry-subject comparison, and
bounded no-echo failures. Candidate flags cannot add mounts, networks,
devices, credentials, subjects, or commands. The controller accepts only a
trusted capability and fixed descriptor; it returns
`blocked/unsupported_host` before Pi or any background/child process.

**Legacy commands:**
`node --test tests/workspace-sandbox-policy.test.mjs tests/workspace-sandbox-docker.test.mjs`
and
`node scripts/workspace-sandbox-docker.mjs --check-only --policy-event control-plane/AIDEV-211/merged-s7-event-v1.json`.
The event argument is a fixed trusted-controller input for policy checks, not
an activation or candidate selector. A real disposable Docker check is a
provider probe only; it cannot activate.

**Output:** `A211-S1-docker-provider-v1`, policy/host/probe contract digest.
**Estimate:** 1,100 meaningful lines; 5–8 engineering days. A stopped
Docker daemon, unsupported backend/API, wrong fixed subject, or failed probe
remains a block.

### S2 — isolated snapshot, native broker, and export/import boundary

**Predecessor:** `A211-S1-docker-provider-v1`. **Purpose:** create a full
independent clone in a per-run named volume and broker only closed-world
exports to verified host roots.

**Candidate paths:**

```text
governance/pkg/workspaceboundary/broker.go
governance/pkg/workspaceboundary/broker_posix.go
governance/pkg/workspaceboundary/broker_windows.go
governance/pkg/workspaceboundary/broker_test.go
governance/cmd/workspace-sandbox-broker/main.go
scripts/workspace-sandbox-materialize.mjs
scripts/workspace-sandbox-export.mjs
tests/workspace-sandbox-materialization.test.mjs
tests/workspace-sandbox-export.test.mjs
```

**Implementation and proof:** stream a bounded Git bundle into a named input
volume; import an independent detached clone with its own `.git`, no remotes,
alternates, hooks, common storage, or sibling refs. Bind export records to
ticket/final-main-event/lease generation/capability. Use native no-follow/
handle identity operations for POSIX and Windows; reject reparse/symlink/
junction/mount/hard-link/ADS/cross-volume/special-file/TOCTOU/rename-swap
substitutions. Planning export is a two-file allowlist; dev/review modes are
distinct. Block or expiry destroys/quarantines volumes without unrelated
cleanup.

**Legacy commands:**
`node --test tests/workspace-sandbox-materialization.test.mjs tests/workspace-sandbox-export.test.mjs`
and, from `governance`, `go test -race ./...`.

**Output:** `A211-S2-snapshot-broker-v1`, broker digest and provider
predecessor binding. **Estimate:** 1,420 meaningful lines; 7–10 engineering
days. Missing native identity-safe export on either claimed host is a host
block, not a wrapper fallback.

### S3 — isolated runtime package, lock, and build context

**Predecessor:** `A211-S2-snapshot-broker-v1`. **Purpose:** make the exact
Pi/subagent runtime a self-contained image input with no ambient discovery.
This slice owns the package/runtime paths it consumes; S7 owns the Dockerfiles
that build them after S4/S5 are complete.

**Candidate paths:**

```text
docker/workspace-sandbox/runtime/package.json
docker/workspace-sandbox/runtime/package-lock.json
docker/workspace-sandbox/runtime/pi-config.json
docker/workspace-sandbox/runtime/subagent-policy.json
scripts/workspace-sandbox-runtime.mjs
tests/workspace-sandbox-runtime.test.mjs
tests/workspace-sandbox-runtime-lock.test.mjs
```

**Implementation and proof:** create lockfile-v3 runtime metadata with the
exact pins in section 1.4 and every transitive integrity; exclude the wiki
package and all host/global package roots. The runtime package's direct
dependencies and resolved lock must not use ranges, Git URLs, mutable tags,
host `file:` paths, or install scripts. The trusted builder installs in an
isolated image stage from a bounded offline cache and records the
package-lock digest. The image contains only the selected runtime and project
code needed by the fixed entrypoint; the root package lock is not used for
managed execution.

**Legacy command:**
`node --test tests/workspace-sandbox-runtime.test.mjs tests/workspace-sandbox-runtime-lock.test.mjs`.
The package lock is generated/checked in a disposable build context, never
installed into the planning worktree. **Output:**
`A211-S3-runtime-lock-v1`, including exact package/integrity/lock/argv and
explicit wiki-absence data. **Estimate:** 1,350 meaningful lines; 6–9
engineering days. A lock or image context that permits ambient discovery
blocks S3.

### S4 — complete-Pi entrypoint and process-tree wiring

**Predecessor:** `A211-S3-runtime-lock-v1`. **Purpose:** ensure the fixed
Docker entrypoint starts the complete Pi process tree and that every child,
extension, SDK caller, shell, interpreter, package script, and subagent
inherits the same boundary.

**Candidate paths:**

```text
docker/workspace-sandbox/runtime/managed-entrypoint.mjs
scripts/workspace-sandbox-run.mjs
scripts/workspace-sandbox-process.mjs
tests/workspace-sandbox-process-tree.test.mjs
tests/workspace-sandbox-pi-entrypoint.test.mjs
tests/fixtures/workspace-sandbox/direct-fs-bypass.mjs
tests/fixtures/workspace-sandbox/nested-child-bypass.mjs
```

**Implementation and proof:** the host starts only the trusted image entrypoint
and fixed argv. The entrypoint validates image-local runtime paths, exact
versions/integrities, absence of `@zosmaai/pi-llm-wiki`, empty global package
selection, and wiki disablement before importing Pi. It then starts the
pinned Pi CLI inside the container. Direct `node:fs`, native filesystem,
`node:child_process`, `spawn`, `execFile`, shell, interpreter, package-script,
SDK, and nested-child calls from bypass fixtures remain confined by Docker;
no tool hook or command-text check is relied upon. Native/raw output stays
local and the host-facing result is bounded/redacted.

**Legacy command:**
`node --test tests/workspace-sandbox-process-tree.test.mjs tests/workspace-sandbox-pi-entrypoint.test.mjs`.
Real Docker process probes are still preparatory until S7 trusted rerun.
**Output:** `A211-S4-process-tree-v1`. **Estimate:** 1,300 meaningful lines;
5–8 engineering days. Any host child or shell escape is a slice failure.

### S5 — session/subagent binding and wiki disable-before-load

**Predecessor:** `A211-S4-process-tree-v1`. **Purpose:** bind run/session
identity, expiry, revocation, and child controls, and make the v1 wiki route
absent before vault discovery.

**Candidate paths:**

```text
scripts/workspace-sandbox-session.mjs
scripts/workspace-sandbox-subagent.mjs
scripts/workspace-sandbox-managed-config.mjs
docker/workspace-sandbox/runtime/wiki-disabled.mjs
governance/pkg/wikigovernance/repository.go
governance/pkg/wikigovernance/policy.go
governance/pkg/wikigovernance/repository_test.go
governance/pkg/wikigovernance/policy_test.go
tests/workspace-sandbox-session.test.mjs
tests/workspace-sandbox-subagent.test.mjs
tests/workspace-sandbox-wiki.test.mjs
```

**Implementation and proof:** descriptors contain only opaque run/container/
volume identity, canonical roots, lease generation, capability digest, exact
final-main event, role/mode, and expiry state. Revalidate immediately before
child launch, resume request (which is denied in v1), deferred task, and
export. Reject moved/quarantined/missing/recreated/differently leased paths;
revoke old containers before quarantine. Do not edit external packages: the
image omits the mutating wiki package and the in-image denial module is
checked before Pi/session start. Invoke every mutating wiki route and compare
all workspace and `.llm-wiki` bytes before/after. Read-only retrieval is
absent. A future authenticated canonical-vault capability is not an
implementation-time assumption.

**Legacy command:**
`node --test tests/workspace-sandbox-session.test.mjs tests/workspace-sandbox-subagent.test.mjs tests/workspace-sandbox-wiki.test.mjs`.
**Output:** `A211-S5-session-wiki-v1`. **Estimate:** 1,350 meaningful lines;
6–9 engineering days. Any path/existence-only check, old-cwd reuse, or wiki
import before disablement blocks S5.

### S6 — bounded evidence and adversarial controller core

**Predecessor:** `A211-S5-session-wiki-v1`. **Purpose:** implement bounded
workspace-boundary evidence and the adversarial controller core without
owning publication, privileged runner workflow, or activation. S6 remains
preparatory and cannot activate or publish images.

**Candidate paths:**

```text
governance/docs/delivery-evidence/workspace-boundary-v1.schema.json
governance/pkg/deliveryevidence/workspace_boundary.go
governance/pkg/deliveryevidence/workspace_boundary_test.go
governance/cmd/delivery-evidence-validator/main.go
scripts/validate-workspace-boundary.mjs
scripts/workspace-sandbox-evidence.mjs
tests/workspace-boundary-evidence.test.mjs
tests/workspace-boundary-adversarial.test.mjs
```

**Implementation and proof:** reuse the external evidence-root identity,
exclusion, bounded-inventory, and digest validation. Record only capability
digest/generation, opaque provider/run identity, role/mode, operation class,
bounded before/after inventory digests, verifier/version, and denial code.
Do not record raw paths, lease tokens, credentials, sessions, prompts, or
unredacted process output. The controller refuses incomplete/mismatched S0–S5
predecessors and provides the case interface consumed by S7.

**Legacy commands:**
`node --test tests/workspace-boundary-evidence.test.mjs tests/workspace-boundary-adversarial.test.mjs`
and, from `governance`, `go test -race ./...`.
Real host probes run only as untrusted preparatory evidence until S7 trusted
main reruns them. **Output:** `A211-S6-boundary-evidence-v1`. **Estimate:** 1,250
meaningful lines; 6–9 engineering days. Evidence leakage, an
unbounded inventory, or a mock-only controller blocks S6.

### S7 — trusted-main image publication, provenance, CI, and runner contract

**Predecessor:** `A211-S6-boundary-evidence-v1`. **Purpose:** define and
execute the trusted-main-only registry publication/provenance route, real
Linux/Windows Docker matrix, runner contract, and post-merge evidence for the
future protected-check/ruleset transition. S7 is preparatory with respect to
managed activation: its post-merge main workflow may publish the external
immutable record and collect Phase-B evidence, but no S7 candidate job or
container may self-publish, mutate the Phase-A ruleset, or select `active`.

**Candidate paths:**

```text
docker/workspace-sandbox/Dockerfile
docker/workspace-sandbox/provider-egress.Dockerfile
.github/workflows/aidev-211-sandbox.yml
.github/runner-contracts/aidev-211-sandbox-runner-v1.json
governance/docs/workspace-sandbox/image-lock-v1.schema.json
governance/docs/workspace-sandbox/runner-contract-v1.schema.json
governance/cmd/workspace-sandbox-ci/main.go
scripts/workspace-sandbox-ci.mjs
scripts/workspace-sandbox-ci-preflight.mjs
scripts/workspace-sandbox-provenance.mjs
tests/workspace-sandbox-ci.test.mjs
tests/workspace-sandbox-provenance.test.mjs
tests/workspace-sandbox-publication.test.mjs
```

The literal workflow and runner paths are also bound by S0's
`path:<literal-relative-posix-path>` expansion; they are not generic
contracts or aliases.

**Fixed subjects and variable derivation:** the exact policy constants are
`ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload`,
`ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay`, and
`ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance`. The trusted
workflow first runs:

```text
node scripts/workspace-sandbox-provenance.mjs read-main-event --event-record control-plane/AIDEV-211/merged-s7-event-v1.json --policy governance/docs/workspace-sandbox/docker-policy-v1.json --output "$RUNNER_TEMP/a211-main-vars.json"
```

This fixed script verifies the signed event, exact phase main SHA, main ref,
repository, predecessor/tree graph, and fixed policy subjects. It emits a
bounded JSON record containing `merged_main_sha` and the three already
verified subjects. The trusted workflow derives the tag input with the fixed
record reader, never from caller input:

```text
A211_MERGED_MAIN_SHA="$(node scripts/workspace-sandbox-provenance.mjs read-merged-sha --record "$RUNNER_TEMP/a211-main-vars.json")"
```

The fixed reader returns only the authenticated SHA or fails closed. The
workflow may expose that result as `A211_MERGED_MAIN_SHA` for tag derivation,
but neither it nor any other environment value can select a subject. The
script rejects a subject mismatch, missing event, tag-only value, candidate
event, or untrusted workflow ref.

**Exact trusted-main build commands:** these commands run only after the S7
workflow is on trusted main (and are rerun for the final S8 merged-main event).
The builder is the fixed `a211-trusted-builder-v1` from the runner contract;
there is no local-only IID route:

```text
docker buildx build --builder a211-trusted-builder-v1 --platform linux/amd64 --pull=false --provenance=mode=max --sbom=true --file docker/workspace-sandbox/Dockerfile --tag ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload:${A211_MERGED_MAIN_SHA} --metadata-file "$RUNNER_TEMP/a211-workload-metadata.json" --push .
docker buildx build --builder a211-trusted-builder-v1 --platform linux/amd64 --pull=false --provenance=mode=max --sbom=true --file docker/workspace-sandbox/provider-egress.Dockerfile --tag ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay:${A211_MERGED_MAIN_SHA} --metadata-file "$RUNNER_TEMP/a211-relay-metadata.json" --push .
node scripts/workspace-sandbox-provenance.mjs extract-pushed-digest --metadata "$RUNNER_TEMP/a211-workload-metadata.json" --subject ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload --main-event control-plane/AIDEV-211/merged-s7-event-v1.json --output "$RUNNER_TEMP/a211-workload-digest.json"
node scripts/workspace-sandbox-provenance.mjs extract-pushed-digest --metadata "$RUNNER_TEMP/a211-relay-metadata.json" --subject ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay --main-event control-plane/AIDEV-211/merged-s7-event-v1.json --output "$RUNNER_TEMP/a211-relay-digest.json"
A211_WORKLOAD_DIGEST="$(node scripts/workspace-sandbox-provenance.mjs read-verified-digest --record "$RUNNER_TEMP/a211-workload-digest.json" --subject ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload)"
A211_RELAY_DIGEST="$(node scripts/workspace-sandbox-provenance.mjs read-verified-digest --record "$RUNNER_TEMP/a211-relay-digest.json" --subject ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay)"
docker buildx imagetools inspect --raw "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload@${A211_WORKLOAD_DIGEST}" > "$RUNNER_TEMP/a211-workload-registry-attestation.json"
docker buildx imagetools inspect --raw "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay@${A211_RELAY_DIGEST}" > "$RUNNER_TEMP/a211-relay-registry-attestation.json"
node scripts/workspace-sandbox-provenance.mjs extract-slsa-predicate --metadata "$RUNNER_TEMP/a211-workload-metadata.json" --registry-attestation "$RUNNER_TEMP/a211-workload-registry-attestation.json" --subject ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload --digest "$A211_WORKLOAD_DIGEST" --main-event control-plane/AIDEV-211/merged-s7-event-v1.json --dockerfile docker/workspace-sandbox/Dockerfile --runtime-lock docker/workspace-sandbox/runtime/package-lock.json --output "$RUNNER_TEMP/a211-workload-predicate.json"
node scripts/workspace-sandbox-provenance.mjs extract-slsa-predicate --metadata "$RUNNER_TEMP/a211-relay-metadata.json" --registry-attestation "$RUNNER_TEMP/a211-relay-registry-attestation.json" --subject ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay --digest "$A211_RELAY_DIGEST" --main-event control-plane/AIDEV-211/merged-s7-event-v1.json --dockerfile docker/workspace-sandbox/provider-egress.Dockerfile --runtime-lock docker/workspace-sandbox/runtime/package-lock.json --output "$RUNNER_TEMP/a211-relay-predicate.json"
```

`docker buildx build --push` is the fixed registry output. The bounded
extractor parses only trusted metadata, requires one digest-qualified manifest
whose repository subject equals the fixed argument, calls
`docker buildx imagetools inspect --raw` on that digest, and records the
digest, subject, metadata digest, phase main SHA, build-context digest, and
workflow SHA. `extract-slsa-predicate` then reads both the exact BuildKit
metadata and the exact registry attestation, requires one unambiguous SLSA
provenance predicate, validates its type, builder, invocation, source
repository/ref/merged SHA, materials, Dockerfile/context, runtime lock, and
subject digest, and writes one bounded canonical predicate. Missing,
ambiguous, tag-only, mismatched, or BuildKit-only provenance is rejected.
BuildKit's `--provenance=mode=max` output is therefore a source for the
predicate, never proof that a cosign attestation exists.

`read-merged-sha` and `read-verified-digest` are fixed bounded subcommands
owned by the trusted provenance script; they emit one authenticated value or
fail and do not accept an override. The resulting environment variables are
not authority inputs: a changed, caller-supplied, tag-only, or subject-mixed
value is rejected by the predicate extractor, signer, verifier, and lock
writer. The predicate output is canonicalized before signing and its digest
is recorded in the provenance evidence.

**Exact image-signature and keyless-attestation commands:** the trusted-main
build job has only the narrowly scoped GitHub permissions `contents:read`,
`packages:write`, `id-token:write`, and `attestations:write`, protected by the
main environment. Image signatures and provenance attestations are separate
artifacts. The job signs only digest-qualified fixed subjects and then
attests the validated predicates with the explicit keyless route:

```text
cosign sign --yes --oidc-issuer=https://token.actions.githubusercontent.com "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload@${A211_WORKLOAD_DIGEST}"
cosign sign --yes --oidc-issuer=https://token.actions.githubusercontent.com "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay@${A211_RELAY_DIGEST}"
cosign attest --yes --type slsaprovenance --oidc-issuer=https://token.actions.githubusercontent.com --predicate "$RUNNER_TEMP/a211-workload-predicate.json" "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload@${A211_WORKLOAD_DIGEST}"
cosign attest --yes --type slsaprovenance --oidc-issuer=https://token.actions.githubusercontent.com --predicate "$RUNNER_TEMP/a211-relay-predicate.json" "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay@${A211_RELAY_DIGEST}"
```

A separate verifier job has no `packages:write`, `id-token:write`, signing
identity, or admission capability. With the exact certificate identity
`https://github.com/Zkrausman/pi-sampler/.github/workflows/aidev-211-sandbox.yml@refs/heads/main`
and exact issuer `https://token.actions.githubusercontent.com`, it runs
`cosign verify` for image signatures and separately captures raw JSON from
`cosign verify-attestation` for each digest:

```text
cosign verify --output json --certificate-identity "https://github.com/Zkrausman/pi-sampler/.github/workflows/aidev-211-sandbox.yml@refs/heads/main" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload@${A211_WORKLOAD_DIGEST}" > "$RUNNER_TEMP/a211-workload-signature-verification.json"
cosign verify --output json --certificate-identity "https://github.com/Zkrausman/pi-sampler/.github/workflows/aidev-211-sandbox.yml@refs/heads/main" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay@${A211_RELAY_DIGEST}" > "$RUNNER_TEMP/a211-relay-signature-verification.json"
cosign verify-attestation --type slsaprovenance --output json --certificate-identity "https://github.com/Zkrausman/pi-sampler/.github/workflows/aidev-211-sandbox.yml@refs/heads/main" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload@${A211_WORKLOAD_DIGEST}" > "$RUNNER_TEMP/a211-workload-verified-attestation.json"
cosign verify-attestation --type slsaprovenance --output json --certificate-identity "https://github.com/Zkrausman/pi-sampler/.github/workflows/aidev-211-sandbox.yml@refs/heads/main" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay@${A211_RELAY_DIGEST}" > "$RUNNER_TEMP/a211-relay-verified-attestation.json"
node scripts/workspace-sandbox-provenance.mjs verify-attested-predicate --attestation "$RUNNER_TEMP/a211-workload-verified-attestation.json" --predicate "$RUNNER_TEMP/a211-workload-predicate.json" --subject ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload --digest "$A211_WORKLOAD_DIGEST" --main-event control-plane/AIDEV-211/merged-s7-event-v1.json --output "$RUNNER_TEMP/a211-workload-attestation-verification.json"
node scripts/workspace-sandbox-provenance.mjs verify-attested-predicate --attestation "$RUNNER_TEMP/a211-relay-verified-attestation.json" --predicate "$RUNNER_TEMP/a211-relay-predicate.json" --subject ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay --digest "$A211_RELAY_DIGEST" --main-event control-plane/AIDEV-211/merged-s7-event-v1.json --output "$RUNNER_TEMP/a211-relay-attestation-verification.json"
```

The fixed `cosign` binary and verifier image identities are pinned in the
runner contract. The separate verifier compares the returned attestation
predicate and subject digest with the canonical predicate, authenticated
merged-main event, source tree, build inputs, fixed OIDC identity, and
registry descriptor. It rejects a missing/multiple attestation, certificate
identity, issuer, workflow ref, repository, predicate type, subject, or digest
mismatch; raw output is bounded and remains in the trusted runner evidence
root only.

**Exact signed image-lock publication commands:** the trusted script creates
the lock only from the authenticated event, the two verified digest records,
the exact S3 runtime lock, Dockerfile/provider policy/context digests, runner
attestation, and workflow SHA:

```text
node scripts/workspace-sandbox-provenance.mjs write-image-lock --main-event control-plane/AIDEV-211/merged-s7-event-v1.json --workload-record "$RUNNER_TEMP/a211-workload-digest.json" --relay-record "$RUNNER_TEMP/a211-relay-digest.json" --workload-predicate "$RUNNER_TEMP/a211-workload-predicate.json" --relay-predicate "$RUNNER_TEMP/a211-relay-predicate.json" --workload-signature-verification "$RUNNER_TEMP/a211-workload-signature-verification.json" --relay-signature-verification "$RUNNER_TEMP/a211-relay-signature-verification.json" --workload-attestation-verification "$RUNNER_TEMP/a211-workload-attestation-verification.json" --relay-attestation-verification "$RUNNER_TEMP/a211-relay-attestation-verification.json" --runtime-lock docker/workspace-sandbox/runtime/package-lock.json --workload-dockerfile docker/workspace-sandbox/Dockerfile --relay-dockerfile docker/workspace-sandbox/provider-egress.Dockerfile --policy governance/docs/workspace-sandbox/docker-policy-v1.json --runner-contract .github/runner-contracts/aidev-211-sandbox-runner-v1.json --workflow-path .github/workflows/aidev-211-sandbox.yml --output "$RUNNER_TEMP/trusted-image-lock-v1.json"
oras push ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance:${A211_MERGED_MAIN_SHA} --artifact-type application/vnd.pi-sampler.aidev-211.image-lock.v1+json "$RUNNER_TEMP/trusted-image-lock-v1.json:application/vnd.pi-sampler.aidev-211.image-lock.v1+json"
oras manifest fetch --descriptor ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance:${A211_MERGED_MAIN_SHA} > "$RUNNER_TEMP/a211-lock-descriptor.json"
node scripts/workspace-sandbox-provenance.mjs verify-published-lock --descriptor "$RUNNER_TEMP/a211-lock-descriptor.json" --subject ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance --main-event control-plane/AIDEV-211/merged-s7-event-v1.json --lock "$RUNNER_TEMP/trusted-image-lock-v1.json" --output "$RUNNER_TEMP/a211-lock-record.json"
A211_LOCK_DIGEST="$(node scripts/workspace-sandbox-provenance.mjs read-verified-digest --descriptor "$RUNNER_TEMP/a211-lock-descriptor.json" --subject ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance)"
cosign sign --yes --oidc-issuer=https://token.actions.githubusercontent.com "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance@${A211_LOCK_DIGEST}"
```

The fixed `oras` version/binary digest is pinned by the runner contract. The
lock publication is immutable because the activation input is the verified
`ghcr.io/.../workspace-sandbox-provenance@sha256:<lock-digest>` from the
bounded descriptor, never the tag. A separate verifier repeats:

```text
cosign verify --output json --certificate-identity "https://github.com/Zkrausman/pi-sampler/.github/workflows/aidev-211-sandbox.yml@refs/heads/main" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance@${A211_LOCK_DIGEST}" > "$RUNNER_TEMP/a211-lock-signature-verification.json"
```

The trusted controller materializes only that verified lock at
`control-plane/AIDEV-211/trusted-image-lock-v1.json`; it binds the lock digest
to `merged_main_sha`, final tree/context, both Dockerfiles, S3 runtime lock,
relay policy, canonical predicate digests, separate cosign signature and
attestation verification records, runner attestations, and workflow SHA. The lock writer
refuses a BuildKit-only record, a predicate/attestation digest mismatch, or an
unsigned/unverified image. Candidate/PR jobs have only `contents:read` and,
if needed, `packages:read`; they have no registry publication credentials,
`packages:write`, OIDC signing identity, or activation authority.

**Trusted runner and protected jobs:**

- `aidev-211-linux-docker` runs on a dedicated ephemeral runner with labels
  `self-hosted`, `linux`, `x64`, `docker-engine`, `trusted-sandbox`, and
  `aidev-211-v1`.
- `aidev-211-windows-docker-desktop` runs on a dedicated ephemeral runner
  with labels `self-hosted`, `windows`, `x64`, `docker-desktop-linux`,
  `trusted-sandbox`, and `aidev-211-v1`.
- Both registrations require operator-owned attestation of image, host
  isolation, Docker administrator policy, capacity, no concurrent untrusted
  jobs, ephemeral cleanup, and exact label identity. Fixed preflight rejects
  a missing/expired attestation, wrong OS/backend, stopped daemon,
  insufficient CPU/RAM/PIDs/disk, or missing Docker capability. It never
  falls back to `ubuntu-latest`, a developer machine, or a Windows path
  simulation.
- The workflow has no `continue-on-error` or success-on-skip for these jobs.
  Missing, queued, skipped, or failing Windows runner/evidence leaves the
  post-merge evidence pending and activation `pending-admission`/unsupported
  or `blocked`. It is not a Windows support claim and cannot permit canary or
  activation; it does not block the Phase-A S8 merge under the existing
  protected checks.

**Exact trusted-main matrix commands:**

```text
node scripts/workspace-sandbox-ci-preflight.mjs --host-class linux-docker-engine --runner-contract .github/runner-contracts/aidev-211-sandbox-runner-v1.json --main-event control-plane/AIDEV-211/merged-s7-event-v1.json
docker version --format '{{.Client.Version}}|{{.Server.Version}}|{{.Server.APIVersion}}'
docker info --format '{{.OSType}}|{{.OperatingSystem}}|{{.Driver}}|{{json .SecurityOptions}}'
docker buildx version
node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T01 --main-event control-plane/AIDEV-211/merged-s7-event-v1.json
node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T02 --main-event control-plane/AIDEV-211/merged-s7-event-v1.json
node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T03 --main-event control-plane/AIDEV-211/merged-s7-event-v1.json
node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T04 --main-event control-plane/AIDEV-211/merged-s7-event-v1.json
node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T05 --main-event control-plane/AIDEV-211/merged-s7-event-v1.json
node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T06 --main-event control-plane/AIDEV-211/merged-s7-event-v1.json
node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T07 --main-event control-plane/AIDEV-211/merged-s7-event-v1.json
( cd governance && go test -race ./... )
```

For the final S8 merged-main rerun, the trusted workflow uses the same
commands with every phase-specific event argument set exactly to
`control-plane/AIDEV-211/merged-final-slice-event-v1.json` (the S7 preparatory
run above uses `merged-s7-event-v1.json`). No PR head, tag, or environment
value may substitute an event path or SHA.

The Windows job runs the same fixed commands in PowerShell with
`--host-class windows-docker-desktop-linux`, after the identical attestation
checks and `docker info --format '{{.OSType}}|{{.OperatingSystem}}|{{.Driver}}|{{json .SecurityOptions}}'` proves the Linux backend. It also runs
`(Set-Location governance; go test -race ./...)`. The scripts construct
Docker argv internally; untrusted shell text is never a boundary. Real cases
attempt sibling/primary/.git/wiki/session/credential writes, private positive
writes, shell/PowerShell/Node/Python/interpreter/package-script/spawn/
execFile/nested/subagent escapes, Windows path/reparse/UNC/ADS/hard-link/
TOCTOU cases, POSIX symlink/mount/device/inode cases, resource exhaustion,
expiry/revocation, output redaction, and byte identity.

**Output:** `A211-S7-publication-ci-v1` plus post-final-main JIT outputs
`A211-FINAL-trusted-image-provenance-v1` and `A211-FINAL-runner-matrix-v1`.
**Estimate:** 1,450 meaningful lines; 8–12 engineering days plus dedicated
runner and protected registry capacity. Any mock-only result, missing host,
missing signature/attestation, subject mismatch, candidate publication,
missing required check, or evidence leakage blocks S7.

### S8 — trusted activation, final-main event, canary, and rollback

**Predecessor:** exact merged S7 plus S6 evidence, followed by the final S8
merge event and the S7 trusted-main JIT publication/matrix outputs. **Purpose:**
add the final activation state machine and consume trusted non-candidate
artifacts. S8 is the only slice that can select `active`, and only after the
non-active canary succeeds.

**Candidate paths:**

```text
governance/docs/workspace-sandbox/activation-declaration-v1.json
governance/docs/workspace-sandbox/activation-profile-v1.json
governance/docs/workspace-sandbox/activation-profile-v1.schema.json
governance/docs/workspace-sandbox/activation-state-v1.schema.json
governance/docs/workspace-sandbox/rollback-record-v1.json
governance/docs/workspace-sandbox/rollback-record-v1.schema.json
governance/docs/workspace-sandbox/merged-final-slice-event-v1.schema.json
governance/docs/workspace-sandbox/ruleset-transition-v1.schema.json
scripts/workspace-sandbox-activation.mjs
scripts/workspace-sandbox-ruleset.mjs
scripts/workspace-sandbox-rollback.mjs
tests/workspace-sandbox-activation.test.mjs
tests/workspace-sandbox-activation-lifecycle.test.mjs
tests/workspace-sandbox-ruleset.test.mjs
tests/workspace-sandbox-rollback.test.mjs
tests/workspace-sandbox-event.test.mjs
```

**Implementation and proof:** validate only exact trusted-base declaration/
profile/schema bytes and the fixed-path controller-owned signed final-main
event, image-lock, runner, ruleset, and receipt records. The controller
extracts `merged_main_sha` only from the authenticated event record and
verifies repository, merged PR event, parent/predecessor graph, exact tree and
artifact inventory, trusted-main ancestry, ticket revision, profile, and
S0–S8 output bindings. It never accepts the original planning base as an
activation input and never lets candidate/env text select the final SHA.

The fixed activation invocation is:

```text
node scripts/workspace-sandbox-activation.mjs --event-record control-plane/AIDEV-211/merged-final-slice-event-v1.json --image-lock control-plane/AIDEV-211/trusted-image-lock-v1.json --ruleset-transition control-plane/AIDEV-211/ruleset-transition-v1.json --state control-plane/AIDEV-211/activation-state-v1.json --require-host-class linux-docker-engine --require-host-class windows-docker-desktop-linux
```

The controller, not a user or candidate, supplies this exact argv and fixed
paths. The command has no planning-base activation argument. Unit tests reject a
planning-base value when it is present in an activation descriptor. The event
validator resolves the immutable final SHA, validates all ordered predecessor
merge SHAs are ancestors, checks the exact tree/artifact digests, and proves
the trusted main workflow/ref/repository identity before any capability is
issued. After the final-main verification and protected matrix succeed, the
separate trusted ruleset controller records the future-check transition and
readback:

```text
node scripts/workspace-sandbox-ruleset.mjs update-required-contexts --repository Zkrausman/pi-sampler --branch main --api-endpoint https://api.github.com/repos/Zkrausman/pi-sampler/branches/main/protection/required_status_checks --contexts-json "$RUNNER_TEMP/a211-future-required-contexts.json" --event-record control-plane/AIDEV-211/merged-final-slice-event-v1.json --output "$RUNNER_TEMP/a211-ruleset-transition-request.json"
node scripts/workspace-sandbox-ruleset.mjs verify-readback --repository Zkrausman/pi-sampler --branch main --api-endpoint https://api.github.com/repos/Zkrausman/pi-sampler/branches/main/protection/required_status_checks --expected-contexts "$RUNNER_TEMP/a211-future-required-contexts.json" --request-record "$RUNNER_TEMP/a211-ruleset-transition-request.json" --readback "$RUNNER_TEMP/a211-ruleset-readback.json" --event-record control-plane/AIDEV-211/merged-final-slice-event-v1.json --output control-plane/AIDEV-211/ruleset-transition-v1.json
```

The controller's only permitted mutation is the fixed authenticated GitHub
ruleset API request `PUT /repos/Zkrausman/pi-sampler/branches/main/protection/required_status_checks` with the exact seven future contexts listed in section 3; it immediately performs the corresponding `GET` readback. It records endpoint, method, prior and resulting ruleset digests, exact contexts, authenticated administrator/controller identity, final merged SHA, and bounded response digests without tokens or raw responses. The candidate workflow, planner, image, workload, and activation controller cannot perform this mutation. A failed or ambiguous readback leaves the state `pending-admission`/`blocked` and no canary starts.

Admission verifies the real Linux and admitted Windows protected matrix,
fixed-subject workload/relay/provenance digests, package-lock/entrypoint/
Dockerfile/context digests, signatures/attestations, ruleset and receipt
bindings, and final event ancestry. It then enters `canary`, not `active`.
The single capability-bound `A211-activation-0001` may execute the fixed
T01/T06 canary only. Every ordinary managed workload, export, session/resume,
retained recovery, background task, and user operation is denied while the
state is `canary`. Canary evidence is bounded and controller-collected; the
workload cannot write the activation state or export ordinary files. A
successful canary and all other evidence perform one atomic compare-and-swap
from `canary` to `active`. A canary failure performs no active transition and
enters `blocked` or `rolled-back`, revokes/quarantines resources, and rejects
all exports.

Rollback stops the complete tree, revokes the generation, quarantines volumes,
refuses exports, preserves bounded evidence, and selects `rolled-back` or
`blocked/unsupported_host`. It never checks out or restores a legacy
unsandboxed managed path. A future reactivation requires a new authenticated
final-main event, signed fixed-subject lock, runner/ruleset/receipt evidence,
and a new canary.

**Legacy command:**
`node --test tests/workspace-sandbox-activation.test.mjs tests/workspace-sandbox-activation-lifecycle.test.mjs tests/workspace-sandbox-rollback.test.mjs tests/workspace-sandbox-event.test.mjs`.
The activation controller command is trusted-controller-only and is not a
local/developer activation command. **Output:**
`A211-S8-activation-record-v1`. **Estimate:** 1,450 meaningful lines; 7–10
engineering days. Without a verified final-main event, both attested host
classes, all immutable provenance, receipt/ruleset evidence, and canary pass,
it returns `blocked/unsupported_host` or remains non-active.

## 3. CI, ruleset authority, and two-phase lifecycle gates

The exact workflow owner is `.github/workflows/aidev-211-sandbox.yml`, bound
literally by S0 path expansion and the manifest's `path:` symbols. It is
resolved from trusted main for protected review, provenance, ruleset, and
activation behavior and never from an unchecked PR head. Candidate S0–S7 implementation and PR tests remain
on the legacy bootstrap workflow and produce no activation or publication
evidence. Its only privileged trigger is `push` to the trusted `main` ref
(plus an explicitly authenticated controller replay for the fixed event
record); it has no privileged `pull_request` path. Only after S7 is merged
does the trusted-main workflow run its Linux/Windows protected jobs. After S8
is merged, that same trusted-main workflow is rerun for the authenticated
final-main event that S8 consumes.

The lifecycle is explicitly two phase. New Docker/provenance contexts are not
required to merge the S8 PR; requiring them before the final-main event would
be contradictory because those contexts are produced only after that merge.

### 3.1 Phase A — S8 merge under the existing protected checks

The S8 PR/head or merge-queue candidate is admitted only by the pre-existing
trusted-base ruleset: current `test`, `governance`, and `Adversarial review
evidence` checks, plus DCO, packet-v3, receipt-v1, marker-v3, exact-head
independent review, lease lifecycle, and the separately authorized human-only
`Merge PR #N` action. The phase-A context set is exactly:

```text
test
governance
Adversarial review evidence
DCO
```

The new `aidev-211-linux-docker`, `aidev-211-windows-docker`, and
`aidev-211-provenance` contexts are explicitly **not** required to merge S8
and are not treated as passing, skipped, or available on the PR head. The
trusted controller accepts the merge only from an authenticated GitHub merge
event and later emits the fixed-path
`control-plane/AIDEV-211/merged-final-slice-event-v1.json`; the planning base
and PR head are never activation inputs. Immediately after this merge the
activation declaration remains `prepared`/`pending-admission`, never
`active`, and no managed workload or canary starts.

### 3.2 Phase B — trusted-main verification, ruleset transition, canary, activation

After the authenticated S8 merge event, the already-trusted S7 main workflow
and controller digest performs, in order: exact event/tree/predecessor
verification; fixed-subject Buildx publication; separate image signing and
keyless SLSA `cosign attest`; independent signature and attestation
verification; real Linux Docker Engine and admitted Windows Docker Desktop
Linux-backend probes; receipt and evidence verification; and final image-lock
readback. The trusted workflow's build job has only `contents:read`,
`packages:write`, `id-token:write`, and `attestations:write`, protected by the
main environment. Its verifier has no write/signing authority. Candidate PR
jobs have only `contents:read` and any narrowly required read-only package
permission. The ruleset controller is a separately authenticated
administrator/GitHub App process, not a candidate job, image, workload, or
planner.

Only after all Phase-B image, provenance, runner, receipt, and final-event
checks pass may that trusted ruleset controller update the required checks for
**future PRs**. It uses the fixed endpoint and exact request/readback route:

```text
PUT https://api.github.com/repos/Zkrausman/pi-sampler/branches/main/protection/required_status_checks
{"strict":true,"contexts":["test","governance","Adversarial review evidence","DCO","aidev-211-linux-docker","aidev-211-windows-docker","aidev-211-provenance"]}
GET https://api.github.com/repos/Zkrausman/pi-sampler/branches/main/protection/required_status_checks
```

The controller invokes `scripts/workspace-sandbox-ruleset.mjs` with the exact
commands in S8, verifies the authenticated API readback against the seven
contexts, and writes the immutable external
`control-plane/AIDEV-211/ruleset-transition-v1.json`. That record binds the
repository, protected branch, endpoint and method, prior and resulting
ruleset digests, exact future-context digest, controller/administrator
identity, final merged SHA, API-readback digest, and event/receipt digests;
it never contains a token or raw response. The update is not a retroactive
S8 merge requirement: it changes the ruleset only for future PRs. A failed,
ambiguous, unauthorized, or stale readback leaves `pending-admission` or
`blocked` and cannot create the canary.

The controller then verifies the ruleset-transition record, all required
future-check results, both real host attestations, the signed image lock and
separate cosign attestation records, and the exact final-main event before
moving `pending-admission` to `canary`. Exactly one
`A211-activation-0001` canary may run; only a bounded successful canary can
atomically move `canary` to `active`. No new context is silently treated as
passing. If Windows capacity or its attested check is absent, queued, skipped,
or fails, Phase B remains `pending-admission`/`blocked` and activation is not
permitted; this missing capacity never prevents the already-authorized Phase-A
merge from being evaluated under its existing checks, but it does prevent
canary and activation.

Before every slice, the orchestrator revalidates trusted ticket revision and
relations, exact repository/base/profile, lease generation and physical
roots, predecessor merge/output contract, runtime/image/policy/registry
digests, final-main event, runner attestation, child scope if any, and clean
candidate inventory. No candidate code selects provider, image, registry
subject, network, credential, role, child, dependency, or authority. The
orchestrator must stop before coding if required child IDs, predecessors, or
JIT evidence are absent.

For a plan-role run, the container is seeded from the exact trusted event/base
selected by the controller and exports only the two AIDEV-211 planning files.
The broker verifies the plan digest against the manifest and the trusted
exact-base validator, then leaves those two files uncommitted in the leased
planning worktree. Challenge/review material, receipts, snapshots, raw Docker
output, sessions, and evidence stay outside Git. The planning worktree is
retained for same-reviewer verification and is not cleaned by this handoff.

## 4. Acceptance routing table

The table routes every acceptance row to an exact command, host class,
artifact/evidence, serial predecessor, and protected check. The Docker cases
run once on each stated real host class; a path fixture on the wrong host is
not substituted for the real job.

| ID | Exact command | Host class | Artifact/evidence | Predecessor | Protected check |
|---|---|---|---|---|---|
| A211-T01 | `node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T01 --main-event control-plane/AIDEV-211/merged-final-slice-event-v1.json` and the same command with `--host-class windows-docker-desktop-linux` | Linux Docker Engine; Windows Docker Desktop Linux backend | `A211-T01.json`: sibling write attempts, before/after inventories, capability/probe digests | S2 broker + S4 process tree + S7 runner matrix | `aidev-211-linux-docker`, `aidev-211-windows-docker` |
| A211-T02 | `node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T02 --main-event control-plane/AIDEV-211/merged-final-slice-event-v1.json` and Windows equivalent | Both real Docker host classes | `A211-T02.json`: review-source denial and exact external evidence export | S2 broker + S6 evidence | `aidev-211-linux-docker`, `aidev-211-windows-docker` |
| A211-T03 | `node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T03 --main-event control-plane/AIDEV-211/merged-final-slice-event-v1.json` and Windows equivalent | Both real Docker host classes | `A211-T03.json`: `.llm-wiki` and all workspace byte-identical digests; denial envelope | S5 wiki-disabled-before-load + S6 evidence | `aidev-211-linux-docker`, `aidev-211-windows-docker` |
| A211-T04 | `node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T04 --main-event control-plane/AIDEV-211/merged-final-slice-event-v1.json` and Windows equivalent | Both real Docker host classes | `A211-T04.json`: stale/moved/quarantined resume denial, old-cwd non-use, revoked generation | S5 session/subagent controls + S6 evidence | `aidev-211-linux-docker`, `aidev-211-windows-docker` |
| A211-T05 | `node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T05 --main-event control-plane/AIDEV-211/merged-final-slice-event-v1.json` and Windows equivalent | POSIX Linux Engine and real Windows Desktop Linux backend | `A211-T05.json`: native handle/path/race probes and OS identity digests | S0 identity/path contract + S2 native broker + S7 runner matrix | `aidev-211-linux-docker`, `aidev-211-windows-docker`, `governance` |
| A211-T06 | `node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T06 --main-event control-plane/AIDEV-211/merged-final-slice-event-v1.json` and Windows equivalent | Both real Docker host classes | `A211-T06.json`: shell/PowerShell/Node/Python/spawn/execFile/nested/subagent results | S4 complete-Pi process tree + S5 subagent controls | `aidev-211-linux-docker`, `aidev-211-windows-docker` |
| A211-T07 | `node scripts/workspace-sandbox-ci.mjs --host-class linux-docker-engine --case A211-T07 --main-event control-plane/AIDEV-211/merged-final-slice-event-v1.json` and Windows equivalent | Both real Docker host classes | `A211-T07.json`: bounded stable no-echo outputs, redaction/length/determinism digests | S1 provider + S4 output boundary + S6 evidence | `aidev-211-linux-docker`, `aidev-211-windows-docker` |
| A211-T08 | `npm test && npm run validate:pi-extensions && npm run validate:packages && (cd governance && go test -race ./...)` plus protected workflow checks, final-main ruleset-transition readback, and separate image-lock/attestation verifier | Legacy bootstrap for ordinary regressions; trusted Linux and Windows jobs for managed matrix | Phase-A existing checks, final-main event, Phase-B image/provenance/ruleset/receipt evidence, and S6–S8 evidence | S0–S8; no single local run substitutes for protected checks | Phase A: `test`, `governance`, `Adversarial review evidence`, `DCO`; Phase B/future PRs: `aidev-211-linux-docker`, `aidev-211-windows-docker`, `aidev-211-provenance` |
| A211-T09 | `node scripts/validate-adversarial-review-attestation.mjs` from the trusted review workflow, followed by one complete same Sol review in a clean no-author workspace | Trusted clean managed review workspace; real Linux/Windows evidence supplied by S7 and final-main event | `independent-review-vN` complete report and verified S6/S7/S8/T01 evidence; no delta-only approval | S6 evidence + S7 provenance + S8 exact final-main event/canary gate | `Adversarial review evidence` plus exact-head independent-review gate |

The acceptance requirement text for these rows is unchanged from the ticket
and is repeated byte-for-byte in the manifest. For S8 specifically, the
Phase-A merge gate is only the existing trusted-base checks listed in section
3. The three AIDEV-211 contexts in the table are Phase-B post-merge evidence
and future-PR ruleset contexts; they are not a pre-S8 merge prerequisite and
must never be fabricated as passing. `go test -race ./...` is mandatory where
the table names `governance`; a passing local Node test, mocked Docker wrapper,
candidate publication, or unit-only Windows path test cannot satisfy the
protected host check.

## 5. Staleness and just-in-time revalidation

The pair is stale when the ticket description/comments/relations, authorization
scope, exact planning base/profile bytes, capability/provider policy, Docker
client or backend policy, fixed registry subjects, base/workload/relay image,
build context, runtime package or lock, Pi/subagent version or integrity,
explicit wiki absence, entrypoint, network/mount policy, activation
state/profile/schema, final-main event schema/record, rollback record,
ruleset-transition schema/record, runner labels/attestation/capacity,
workflow/ruleset/receipt contexts, publication signer/verifier/tool versions,
cosign predicate/attestation route, slice paths or estimates,
predecessor/output contract, acceptance requirement/test matrix, or approval
state changes.
Revalidation is required before implementation, validation, publication,
every deferred/background operation, every export, every publication, and
every activation/admission.

The manifest binds the current planning ticket revision, plan digest, exact
planning base, and trusted profile. Its affected contracts/packages and JIT
contract digests bind the dot-path expansion, runtime route, image publication
and fixed subjects, explicit cosign predicate/attestation verification,
CI/runner matrix, two-phase ruleset transition, final-main event,
activation/canary, rollback, and existing review/evidence authorities. Dynamic slice merge SHAs,
final-main event SHA, package-lock/image-lock bytes, workload/relay/entrypoint
digests, signatures, registry lock digest, runner attestations, ruleset and
receipt evidence, canary results, and future child IDs are JIT values; they
must be supplied by trusted controllers/workflows and never invented in this
pair.

For transparency, the manifest's frozen route-contract JIT digests are the
SHA-256 of the exact compact JSON strings below (UTF-8, recursively sorted
keys, no whitespace); the future implementation must preserve these contract
inputs or the pair is stale:

```text
workspace-sandbox/manifest-dotpath-ownership/v1
{"convention":"ownership.symbols:path:<literal-relative-posix-path>","files":[".github/runner-contracts/aidev-211-sandbox-runner-v1.json",".github/workflows/aidev-211-sandbox.yml"],"noAliases":true,"requires":"A211-S0-capability-dotpath-contract-v1","validator":"scripts/validate-manifest-owned-paths.mjs"}
SHA-256: f5b2f43596350f5efa595ee8611c1df2b9eb6431e6da3a8c002b022d0c211405

workspace-sandbox/runtime/v1
{"entrypoint":"docker/workspace-sandbox/runtime/managed-entrypoint.mjs","globalDiscovery":"forbidden","node":"24.14.0","pi":{"integrity":"sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==","name":"@earendil-works/pi-coding-agent","version":"0.84.2"},"packageLock":"docker/workspace-sandbox/runtime/package-lock.json","resume":"disabled","subagents":{"integrity":"sha512-ed8XbIZtOainz2cvjF9WHAwbGsDY0JH2YLs6ErbGmc09JHRA17U43QiL8jA5DjI+1lVgzXLJhmNW7Ft1XL5lNA==","name":"pi-subagents","version":"0.61.0"},"wiki":{"integrity":"sha512-BB3MQ+8f3x3Pv5KeowKdqdlpdQJR0GiOOeEDZkCFx51n0C1HUVevM72Aggm1YY5LzlsTCfccRzNE3VynI2EeSw==","load":"absent","name":"@zosmaai/pi-llm-wiki","version":"0.11.7"}}
SHA-256: 3e8a65f1a5de0959b6bd50e39a82e5203b4f01770a43162c39aabaa795a6ee20

workspace-sandbox/image-publication/v1
{"attestationMode":"keyless-cosign-attest","attestationPredicate":"validated-canonical-slsa","attestationType":"slsaprovenance","authority":"trusted-main-post-merge","baseDigest":"JIT-required","buildkitProvenance":"predicate-source-only","candidateSelfAdmission":false,"cosignAttest":"cosign attest --yes --type slsaprovenance --predicate <validated-canonical-predicate>","cosignVerify":"cosign verify-attestation --type slsaprovenance","fixedRegistry":"ghcr.io/zkrausman/pi-sampler","imageSignature":"cosign sign --yes","lockArtifact":"ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance","oidcIssuer":"https://token.actions.githubusercontent.com","predicateVerifier":"separate-trusted-verifier","relayDigest":"JIT-required","relaySubject":"ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay","selection":"exact-trusted-main-event","workflowRef":"Zkrausman/pi-sampler/.github/workflows/aidev-211-sandbox.yml@refs/heads/main","workloadDigest":"JIT-required","workloadSubject":"ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload"}
SHA-256: 37349b0e9c947a0725a690afd8735690755cab78952554ae5d15b2079d4c4b1f

workspace-sandbox/ci-matrix/v1
{"checks":["test","governance","Adversarial review evidence","DCO","aidev-211-linux-docker","aidev-211-windows-docker","aidev-211-provenance"],"linuxLabels":["self-hosted","linux","x64","docker-engine","trusted-sandbox","aidev-211-v1"],"phaseAExcludes":["aidev-211-linux-docker","aidev-211-windows-docker","aidev-211-provenance"],"phaseARequired":["test","governance","Adversarial review evidence","DCO"],"phaseBTrigger":"push-main-after-s8-merge","publicationSubjects":["ghcr.io/zkrausman/pi-sampler/workspace-sandbox-workload","ghcr.io/zkrausman/pi-sampler/workspace-sandbox-relay","ghcr.io/zkrausman/pi-sampler/workspace-sandbox-provenance"],"rulesetEndpoint":"PUT /repos/Zkrausman/pi-sampler/branches/main/protection/required_status_checks","rulesetReadback":"GET /repos/Zkrausman/pi-sampler/branches/main/protection/required_status_checks","rulesetTransitionAuthority":"administrator-or-trusted-controller","windowsLabels":["self-hosted","windows","x64","docker-desktop-linux","trusted-sandbox","aidev-211-v1"],"windowsAbsent":"pending/unsupported","workflow":".github/workflows/aidev-211-sandbox.yml"}
SHA-256: c1bdc2320039f0d0ad4a6e33e88f1115bc51ee2a3d1cd3802c7576c115115aad

workspace-sandbox/activation/v1
{"activeRequires":["exact-trusted-main-event","signed-image-lock","linux-runner-attestation","windows-runner-attestation","real-probes","receipt-bindings","ruleset-readback","canary-success"],"canary":"A211-activation-0001","declaration":"governance/docs/workspace-sandbox/activation-declaration-v1.json","event":"control-plane/AIDEV-211/merged-final-slice-event-v1.json","phaseA":"s8-merge-under-existing-protected-checks","phaseANewContextsRequired":false,"phaseB":"trusted-main-verification-ruleset-update-canary","profile":"governance/docs/workspace-sandbox/activation-profile-v1.json","states":["disabled","prepared","pending-admission","canary","active","blocked","rolled-back"],"stateStore":"control-plane/AIDEV-211/activation-state-v1.json"}
SHA-256: ac20d1acd428d6680716fe6189a3c374a434cf7940c9cfd86120e8f11917c001

workspace-sandbox/rollback/v1
{"activeTo":"rolled-back","managedFallback":"blocked/unsupported_host","unsandboxedRestore":false,"record":"governance/docs/workspace-sandbox/rollback-record-v1.json"}
SHA-256: 9486a14e4e60a854831235326a37e75e1f02d054683e960f4a8a455b2371a888
```

## 6. Existing authorities, rollback, and non-goals

The pair does not implement a sandbox, modify installed Pi/subagents/wiki
dependencies now, create Linear children, change tracker/GitHub state, publish
a marker/receipt, commit, push, open/update a PR, merge, install packages, or
write wiki bytes. It does not call a host wrapper a sandbox, mount the Docker
socket, broaden mounts to linked worktrees or `.git`, or fall back when
Docker is unavailable. Existing localized Excalidraw, review, delivery,
wiki-format, evidence, packet-v3, receipt-v1, marker-v3, DCO, protected CI,
exact-head review, lease, and human-only merge controls remain defense in
depth and authority gates.

Rollback is a separately reviewed lifecycle change. A rollback target must
preserve manual-only planning and separate action authority; it never restores
a legacy unsandboxed managed path, automatic Linear mutation, automatic
commit/push/PR, publication, review, or merge. If no safe active record exists,
`disabled`/`blocked/unsupported_host` is the only result until a corrected
trusted base/event and independent approval exist. Historical plans/manifests
and review artifacts remain readable and are never silently rewritten.

The external canonical-vault/wiki tools are not invoked by this remediation.
No source, package, image, workflow, registry, tracker, or wiki mutation is
performed here. The only worktree outputs are the two named AIDEV-211 planning
files.

## 7. Complete acceptance parity set

These nine lines are the complete ticket acceptance set. The sibling manifest
repeats each requirement in this exact order and byte-for-byte.

- [ ] A211-T01: Tests prove attempted writes from one managed worktree into a sibling Dev/Plan/Review worktree fail before filesystem mutation.
- [ ] A211-T02: Tests prove review source writes fail while exact external review-evidence writes succeed.
- [ ] A211-T03: Tests prove wiki calls from managed worktrees modify only the canonical vault and leave every managed workspace byte-identical.
- [ ] A211-T04: Tests prove stale/quarantined/moved session and subagent resume bindings fail closed or complete an authenticated explicit rebind; no old cwd is used.
- [ ] A211-T05: Tests cover Windows junction/UNC/case/device-path and POSIX symlink/path-traversal escape attempts plus TOCTOU cases.
- [ ] A211-T06: Spawned shell/process attempts cannot escape allowed roots.
- [ ] A211-T07: Denial diagnostics are bounded, deterministic, and privacy-safe.
- [ ] A211-T08: Existing lease, packet-v3, receipt-v1, marker-v3, DCO, protected CI, independent review, and human-only merge authority remain unchanged.
- [ ] A211-T09: A fresh independent adversarial review demonstrates there is no write path from one active worktree into another.

## 8. Final handoff gate

After this remediation, the orchestrator must run the trusted exact-base v2
validator with the retained ticket revision and profile, then the focused
planning tests. It must prove that the plan and manifest are the only
untracked worktree files, that no tracked/staged/ignored/wiki/temp dependency
bytes changed, and that the exact worktree/base/branch/lease identity remains
valid. Evidence belongs only under the external cycle-2 remediation
directory. A passing validator or local test is necessary evidence, never
independent approval. The pair is eligible only for the same Sol reviewer in
the clean no-author environment specified in section 0.1; implementation
remains blocked until that complete review approves it. If verification 2
still reports a reproducible defect, the orchestrator must stop and escalate
to human review; there is no third automatic cycle.
