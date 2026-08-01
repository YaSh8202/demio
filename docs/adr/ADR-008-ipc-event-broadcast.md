# ADR-008: IPC Event Broadcast for Progress

Date: 2026-07-31
Status: accepted

## Decision

Progress updates from both conversation and workflow layers reach the renderer as AgentController events broadcast over the existing IPC channel. Workflow-specific progress (scene recording, verification, retry) arrives as `tool_update` events emitted by the `generate_demo` workflow tool.

## Context

**Original decision (pre-AgentController):** Progress via agent SSE stream as part of tool output.

**Amended (AgentController adoption):** AgentController emits a standardized event stream (message_start, message_delta, tool_call, tool_result, etc.). This replaces the hand-rolled 5MB SSE replay buffer in `electron/agent/runs.ts`. Workflow progress is surfaced as tool events, reducing the need for custom progress channels while maintaining backward compatibility with the existing IPC broadcast infrastructure.

## Consequences

- `src/hooks/use-agent-events.ts` replaces `src/lib/ipc-chat-transport.ts` as the renderer's event consumer
- Controller events are broadcast over `"demio-ipc-event"` (same channel as today)
- Each tool call includes metadata about the step (e.g., scene number, retry count)
- Workflow suspension events (retry/skip/abort) integrate with the same event stream
- No SSE parsing on the renderer; all progress is structured event data
- The IPC handler serializes controller events to JSON for transport (same as today)
