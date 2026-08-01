// ── Agent IPC Events ─────────────────────────────────────────────────────────
//
// Namespace: "agent"
//
// These are "virtual" — the actual broadcasting happens in
// handlers/agent.ts, which calls webContents.send() directly against the
// same channel format the preload subscribes to. This file exists purely so
// the preload/renderer typed wrappers (events.agent.*) get generated.

import type { NamespaceEvents, EventCallback } from "../constants"

export const agentEvents = {
  /**
   * Fired with (threadKey: string, event: DemioControllerEvent) for every
   * AgentController event on a session (`${projectId}:${threadId}` key).
   * Maps inside the event are serialized to plain objects before broadcast.
   */
  onEvent: (_callback: EventCallback) => {
    return () => {}
  },
  /**
   * @deprecated Old hand-rolled SSE-byte-pump path (orchestrator/runs.ts),
   * superseded by `onEvent`. Never broadcast by the controller-backed
   * handler — kept declared only so src/lib/ipc-chat-transport.ts (replaced
   * in Task 6) still compiles against `events.agent.onChunk`. Removed
   * outright once that transport is deleted.
   */
  onChunk: (_callback: EventCallback) => {
    return () => {}
  },
  /** @deprecated See `onChunk`. */
  onEnd: (_callback: EventCallback) => {
    return () => {}
  },
  /** @deprecated See `onChunk`. */
  onError: (_callback: EventCallback) => {
    return () => {}
  },
} satisfies NamespaceEvents
