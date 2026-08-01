# ADR-002: AgentController as Conversation Layer

Date: 2026-07-31
Status: accepted

## Decision

Mastra's AgentController replaces the hand-rolled session/harness logic for managing chat conversations. The controller owns session state, mode transitions (plan → execute), built-in tools (`ask_user`, `submit_plan`), and event streaming. Demo-video generation workflows are invoked as a tool call within execute mode.

## Context

Today's implementation maintains sessions manually in `electron/agent/sessions.ts` (AbortController map) and runs via `electron/agent/orchestrator.ts`. The orchestrator hard-codes streaming logic and tool calls, and replay uses a 5MB SSE buffer in `electron/agent/runs.ts`. Chat reattachment is not supported. The `ask_user` tool is hand-rolled in `electron/agent/questions.ts` as deferred promises, with no built-in suspension mechanism.

## Consequences

- Hand-rolled sessions, runs, and questions files deleted; controller handles all state and mode transitions
- Chat messages stream through controller events on IPC broadcast; plan approval uses built-in `submit_plan` suspension
- Renderer switches from SSE-chunk parsing to controller event listening; session reattachment and persistence managed by LibSQL storage
