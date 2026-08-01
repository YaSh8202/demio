# ADR-008: IPC Event Broadcast for Progress

Date: 2026-07-31
Status: accepted

## Decision

Progress updates from both conversation and workflow layers reach the renderer as AgentController events broadcast over the existing IPC channel. Workflow-specific progress (scene recording, verification, retry) arrives as `tool_update` events emitted by the `generate_demo` workflow tool.

## Context

**Original decision (pre-AgentController):** Progress via agent SSE stream as part of tool output.

**Amended (AgentController adoption):** AgentController emits a standardized event stream (message_start, message_delta, tool_call, tool_result, etc.). This replaces the hand-rolled 5MB SSE replay buffer in `electron/agent/runs.ts`. Workflow progress is surfaced as tool events, reducing the need for custom progress channels while maintaining backward compatibility with the existing IPC broadcast infrastructure.

## Consequences

- `use-agent-events.ts` hook replaces SSE-based `ipc-chat-transport.ts`; listens to controller events on `"demio-ipc-event"`
- Tool calls include step metadata (scene, retry count); workflow suspension events integrate with same stream
- All progress is structured event data (no SSE parsing on renderer); IPC handler serializes to JSON for transport
