---
name: pith-analytics-report
description: "AI agent skill to run local Pith telemetry and generate a weekly analytics markdown report."
---

# Skill: Pith Analytics Report

This skill is intended for autonomous execution by a worker agent picking up the recurring `[Automated] Pith Token Analytics Report` ticket.

## Execution Steps

1. **Telemetry Generation**:
   - Execute the `pith gain` and `pith analyze` CLI commands locally to fetch the latest token savings and anomaly detection data.
   - Execute `pith audit` to fetch any LLM interaction warnings.
2. **Report Synthesis**:
   - Synthesize the CLI outputs into a clean, highly readable Markdown report.
   - The report MUST include three H2 sections: `## Token Savings`, `## Anomalies`, and `## Quality Audit`.
   - Save the file to: `docs/reports/pith-weekly-analytics-[YYYY-MM-DD].md`.
3. **Commit & Pull Request**:
   - Commit the newly generated report using the format: `chore(analytics): generate weekly pith report`.
   - **CRITICAL**: You must sign-off your commit using `git commit -s` to pass DCO checks.
   - Push the branch and open a Pull Request.
4. **Linear SDLC Sync**:
   - Use the `linear_edit_issue` MCP tool to move the ticket to `In Review` so a human can read the analytics report directly in the PR before merging.
