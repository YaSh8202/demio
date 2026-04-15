// ── Agent Session Manager ────────────────────────────────────────────────────
//
// Tracks in-flight agent runs per thread using AbortControllers.
// Allows cancellation of streaming runs from the renderer.

const sessions = new Map<string, AbortController>()

function key(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

/**
 * Start a new agent session for a thread.
 * Aborts any existing session for the same thread first.
 * Returns the AbortSignal for the new session.
 */
export function startSession(projectId: string, threadId: string): AbortSignal {
  const k = key(projectId, threadId)

  // Abort existing session if any
  const existing = sessions.get(k)
  if (existing) {
    existing.abort()
  }

  const controller = new AbortController()
  sessions.set(k, controller)
  return controller.signal
}

/**
 * Cancel an in-flight agent session.
 */
export function cancelSession(projectId: string, threadId: string): void {
  const k = key(projectId, threadId)
  const controller = sessions.get(k)
  if (controller) {
    controller.abort()
    sessions.delete(k)
  }
}

/**
 * Remove a session (called after natural completion).
 */
export function clearSession(projectId: string, threadId: string): void {
  sessions.delete(key(projectId, threadId))
}
