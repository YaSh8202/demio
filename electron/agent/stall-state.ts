// ── Stall bookkeeping ────────────────────────────────────────────────────────
//
// Per-thread counters the stall watchdog keeps and `generate_demo` reads (for
// the scorecard's run line). Its own module so the controller can read them
// without importing the watchdog, which imports the controller.

interface StallState {
  /** Nudges sent since the user last spoke. */
  nudges: number
  /** Tool calls since the user last spoke — a turn with none was conversation, not work. */
  toolCalls: number
  lastUserMessageAt: number
  cancelled: boolean
  salvageTried: boolean
}

const states = new Map<string, StallState>()

export function stallState(key: string): StallState {
  let s = states.get(key)
  if (!s) {
    s = {
      nudges: 0,
      toolCalls: 0,
      lastUserMessageAt: Date.now(),
      cancelled: false,
      salvageTried: false,
    }
    states.set(key, s)
  }
  return s
}

export function stallNudges(key: string): number {
  return states.get(key)?.nudges ?? 0
}

/** The user spoke: whatever the harness was doing about the last request is over. */
export function noteUserMessage(key: string): void {
  states.set(key, {
    nudges: 0,
    toolCalls: 0,
    lastUserMessageAt: Date.now(),
    cancelled: false,
    salvageTried: false,
  })
}

/** The user pressed stop: a turn that ends now ended because they said so. */
export function noteCancel(key: string): void {
  stallState(key).cancelled = true
}
