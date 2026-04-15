// ── Agent IPC Events ─────────────────────────────────────────────────────────
//
// Namespace: "agent"
// Forwards UIMessage stream bytes (and lifecycle signals) from a running
// agent run to the renderer's custom fetch transport.
//
// These are "virtual" — the actual broadcasting happens in
// handlers/agent.ts, which calls webContents.send() directly against the
// same channel format the preload subscribes to.

import type { NamespaceEvents, EventCallback } from "../constants"

export const agentEvents = {
  /** Fired with (runId: string, chunk: Uint8Array) for each SSE chunk. */
  onChunk: (_callback: EventCallback) => {
    return () => {}
  },
  /** Fired with (runId: string) when the run finishes cleanly. */
  onEnd: (_callback: EventCallback) => {
    return () => {}
  },
  /** Fired with (runId: string, message: string) on error. */
  onError: (_callback: EventCallback) => {
    return () => {}
  },
} satisfies NamespaceEvents
