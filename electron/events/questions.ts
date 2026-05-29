// ── Questions IPC Events ─────────────────────────────────────────────────────
//
// Namespace: "questions"
// Broadcasts pending-question lifecycle to the renderer. Bridges the in-main
// questions registry (`electron/agent/questions.ts`) to the renderer's
// `PromptQuestionCard` via the standard event-channel pattern.
//
// - onAsked(req)    — fires when a new `ask_user` tool call registers.
// - onResolved(id)  — fires on reply, reject, OR abort. Renderer uses this
//                     to clear its pending state without caring which path.

import type { NamespaceEvents, EventCallback } from "../constants"
import {
  onAsked as subscribeAsked,
  onResolved as subscribeResolved,
} from "../agent/questions"

export const questionsEvents = {
  onAsked: (callback: EventCallback) => {
    return subscribeAsked((req) => callback(req))
  },
  onResolved: (callback: EventCallback) => {
    return subscribeResolved((id) => callback(id))
  },
} satisfies NamespaceEvents
