---
name: dependency-security-audit
description: "AI agent skill for automating weekly dependency updates, running tests, and opening a maintenance PR."
---

# Skill: Dependency & Security Audit

This skill is intended for autonomous execution by a worker agent picking up the recurring `[Automated] Dependency and Security Audit` ticket.

## Execution Steps

1. **Dependency Sync & Audit**:
   - For Go modules: Run `go get -u ./...` and `go mod tidy`.
   - For Node modules (if applicable): Run `npm update` and `npm audit fix`.
2. **Test Suite Validation**:
   - Run the relevant test suites (e.g., `go test -race ./...` or `npm test`).
   - If tests fail after an update, revert the offending package bump to keep the build green.
3. **Commit & Pull Request**:
   - Stage the updated manifest files (`go.mod`, `go.sum`, `package.json`, `package-lock.json`).
   - Commit the changes using the format: `chore(deps): weekly dependency update`.
   - **CRITICAL**: You must sign-off your commit using `git commit -s` to pass DCO checks.
   - Push the branch and open a Pull Request.
4. **Linear SDLC Sync**:
   - Use the `linear_edit_issue` MCP tool to move the ticket to `In Review` so a human knows the PR is ready to merge.
