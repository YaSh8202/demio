# ADR-009: Unified Model Selection

Date: 2026-07-31
Status: accepted

## Decision

One model selection applies everywhere: the thread's selected model (via `DEFAULT_MODEL_ID` fallback). Per-role model auto-selection (e.g., fast model for planning, powerful model for generation) is future work ("auto mode").

## Context

Supporting role-specific models requires additional configuration, training data selection logic, and cost accounting. The current codebase already tracks thread model selection; unifying on that choice simplifies the initial AgentController migration. Users can manually switch models mid-conversation if needed; automation is deferred to Milestone 2.

## Consequences

- `electron/agent/providers.ts` exports `getModel(modelId)` for controller and workflow steps; no per-step model overrides
- Usage tracking simplified: one model per thread
- Auto-mode per-provider per-role selection and `availableModels` mode config deferred to Milestone 2
