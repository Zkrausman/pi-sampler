---
name: wiki-governance-scrub
description: "AI agent skill to validate wiki path policies, fix broken markdown links, and scrub orphaned files."
---

# Skill: Wiki Link & Governance Scrub

This skill is intended for autonomous execution by a worker agent picking up the recurring `[Automated] Wiki Link & Governance Scrub` ticket.

## Execution Steps

1. **Governance Linting**:
   - Run the local wiki governance linter: `go run ./cmd/wiki-governance lint -repo-root .`
   - If the linter reports any path policy violations or structural errors, resolve them by moving or formatting the `.llm-wiki/wiki/**/*.md` files appropriately.
2. **Broken Link Scrub**:
   - Recursively scan the `.llm-wiki` and `docs` directories for markdown links.
   - If a link points to a file that has been deleted or moved, repair the link or remove it.
   - Delete any orphaned markdown documents that are no longer linked to by the index or READMEs.
3. **Commit & Pull Request**:
   - Commit the changes using the format: `docs(wiki): monthly governance and link scrub`.
   - **CRITICAL**: You must sign-off your commit using `git commit -s` to pass DCO checks.
   - Push the branch and open a Pull Request.
4. **Linear SDLC Sync**:
   - Use the `linear_edit_issue` MCP tool to move the ticket to `In Review` so a human knows the PR is ready to merge.
