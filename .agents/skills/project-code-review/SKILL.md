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
