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
} satisfies NamespaceEvents
