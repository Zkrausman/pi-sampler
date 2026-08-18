---
name: create-implementation-plan
description: "AI agent skill defining the Definition of Done for all feature planning. Generates a strict IMPLEMENTATION_PLAN.md artifact."
---

# Skill: Create Implementation Plan

This document serves as the **Definition of Done** for all feature planning. It is a strict protocol that any AI agent must follow to generate an `IMPLEMENTATION_PLAN.md` artifact.

## 1. Required Inputs (The Context)

Before generating the implementation plan, the agent **must** ingest and analyze the following:
*   **Raw Issue Ticket**: The original request, containing the feature description, acceptance criteria, and constraints.
*   **Relevant File Boundaries**: Codebase context and function signatures pulled via **pith's high-fidelity parsers**.
*   **Architecture Exports**: Any provided `.excalidraw` JSON architecture exports that dictate structural design and component relationships.

## 2. Execution Rules (The Guardrails)

The agent **must** strictly adhere to the following execution constraints:

*   **Constraint 1: You are the Lead Architect.** 
    *   Do **not** write the final implementation code. 
    *   Your role is strictly to design the architecture and define the execution steps.
*   **Constraint 2: Module Governance.** 
    *   All proposed changes must strictly comply with the `governance/` Go module policies.
*   **Constraint 3: Test Case Definition.** 
    *   Define exact test cases required to validate the feature.
    *   Example: `go test -race <boundaries>` must be explicitly specified for the affected components.

## 3. The Output Template (The Handoff)

The agent **must** output the final plan using the rigid, copy-pasteable Markdown template below. Do not deviate from these headers.

```markdown
# Implementation Plan

## Expected File Changes
*List all files that will be modified, created, or deleted.*
*   `[NEW]` `path/to/new/file.go`: *Purpose of the new file.*
*   `[MODIFY]` `path/to/existing/file.go`: *Brief description of the change.*
*   `[DELETE]` `path/to/deprecated/file.go`: *Reason for deletion.*

## Step-by-Step Execution
*Provide a granular, sequential list of actions required to implement the feature.*
1.  **Phase 1: [Phase Name]**
    *   Step 1.1: ...
    *   Step 1.2: ...
2.  **Phase 2: [Phase Name]**
    *   Step 2.1: ...

## Test Matrix
*Define the exact test commands and scenarios needed to validate this feature.*
*   **Target Command**: `go test -race ./path/to/package/...`
*   **Validation Scenarios**:
    *   [ ] Scenario A (Success case)
    *   [ ] Scenario B (Edge case handling)
```
