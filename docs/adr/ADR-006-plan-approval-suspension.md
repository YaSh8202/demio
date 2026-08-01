# ADR-006: Plan Approval via Built-in `submit_plan` Suspension

Date: 2026-07-31
Status: accepted

## Decision

Users approve the agent's plan before execution using AgentController's built-in `submit_plan` tool suspension. This occurs in plan mode before transitioning to execute mode. The suspension is enabled by default but can be disabled for streaming workflows (e.g., live demos).

## Context

Today's system allows the agent to proceed directly to execution. Intermediate users benefit from reviewing the plan (breakdown of scenes, recorded segments, composition strategy) before committing to the potentially long-running generation process. AgentController provides a clean suspension mechanism for this approval gate without requiring custom prompts.

## Consequences

- In plan mode, the agent creates a plan file (zod-validated `ScenePlan[]`) and calls `submit_plan({path})`
- The IPC handler surfaces the plan for user review in the UI
- User responds with approval or rejection via `respondToToolSuspension`
- On approval, the controller transitions to execute mode
- On rejection, the user can iterate (ask agent to refine, adjust parameters, etc.)
- The suspension can be toggled off for non-interactive scenarios
