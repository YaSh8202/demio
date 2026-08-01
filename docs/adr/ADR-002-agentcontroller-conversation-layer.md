# ADR-002: AgentController as Conversation Layer

Date: 2026-07-31
Status: accepted

## Decision

Mastra's AgentController replaces the hand-rolled session/harness logic for managing chat conversations. The controller owns session state, mode transitions (plan → execute), built-in tools (`ask_user`, `submit_plan`), and event streaming. Demo-video generation workflows are invoked as a tool call within execute mode.

## Context

Today's implementation maintains sessions manually in `electron/agent/sessions.ts` (AbortController map) and runs via `electron/agent/orchestrator.ts`. The orchestrator hard-codes streaming logic and tool calls, and replay uses a 5MB SSE buffer in `electron/agent/runs.ts`. Chat reattachment is not supported. The `ask_user` tool is hand-rolled in `electron/agent/questions.ts` as deferred promises, with no built-in suspension mechanism.

## Consequences

- `electron/agent/sessions.ts`, `electron/agent/runs.ts`, and `electron/agent/questions.ts` are deleted
- Chat messages stream through controller events on a unified IPC broadcast channel
- Plan approval uses the controller's built-in `submit_plan` suspension (skippable, default ON)
- Renderer switches from `ipc-chat-transport` reassembling SSE chunks to listening for controller events
- Session/thread reattachment and persistence come from LibSQL storage in the controller
