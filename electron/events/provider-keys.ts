// ── Provider Keys Events ─────────────────────────────────────────────────────
//
// Event namespace for provider key changes.
// Broadcasts are triggered by the handler layer (not by event registrars).

import type { NamespaceEvents, EventCallback } from "../constants"

export const providerKeysEvents = {
  onKeysChanged: (_callback: EventCallback) => {
    return () => {} // No-op — broadcasts handled by handlers
  },
} satisfies NamespaceEvents
