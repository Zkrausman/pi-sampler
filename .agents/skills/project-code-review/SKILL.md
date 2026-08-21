---
name: project-code-review
description: Independently review a project change in an isolated worktree using its explicit project profile.
---

# Project code review

Review from a clean worktree and a distinct reviewer identity. The consumer profile supplies the base branch, verification commands, required checks, prohibited paths, and domain policy.

- Inspect the complete diff and the declared scope.
- Reject self-review, dirty review worktrees, missing profile requirements, unverified claims, leaked credentials, and undeclared behavior changes.
- Run the profile's commands without replacing failures with assumed equivalents.
- Report evidence-backed findings with severity, location, correction, and verification requirement.
- Never mutate the candidate branch, merge, or update work-item status.
- Before preparing a review workspace, run the fixed `review-policy.mjs verify` preflight from the approved merged base, passing the exact trusted base commit and mandatory candidate commit. The executable, `profiles/pi-sampler.json` policy bytes, and `profiles/project-profile.schema.json` bytes are all read from that immutable base; never load a candidate-selected loader, profile path, or default.
- Treat candidate `delivery.review` values, including workspace and quarantine roots, as untrusted data. A `ready` result requires candidate policy equivalence and must be the only source of review limits for a later workspace consumer.
- A missing trusted policy is the explicit fail-closed `bootstrap_required` result. It is a blocking outcome, not a generic configuration warning or permission to fall back to candidate values.
- Land the bootstrap change first and record its exact merge SHA. Only then may AIDEV-157 be rebased and reviewed: the later controller must run this base-bound preflight with that exact base SHA and a mandatory candidate SHA before creating any review workspace.
