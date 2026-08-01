# ADR-009: Unified Model Selection

Date: 2026-07-31
Status: accepted

## Decision

One model selection applies everywhere: the thread's selected model (via `DEFAULT_MODEL_ID` fallback). Per-role model auto-selection (e.g., fast model for planning, powerful model for generation) is future work ("auto mode").

## Context

Supporting role-specific models requires additional configuration, training data selection logic, and cost accounting. The current codebase already tracks thread model selection; unifying on that choice simplifies the initial AgentController migration. Users can manually switch models mid-conversation if needed; automation is deferred to Milestone 2.

## Consequences

- `electron/agent/providers.ts` exports `getModel(modelId)` which the controller and workflow steps use
- No per-step model override logic in this phase
- The "auto mode" feature (per-provider, per-role selection) is tracked as a separate Milestone 2 initiative
- Usage tracking is simpler: one model per thread
- Future work may add `availableModels` mode configuration to let users pick from a list at conversation start
