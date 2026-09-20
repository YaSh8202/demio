// ── Stall bookkeeping ────────────────────────────────────────────────────────
//
// Per-thread counters the stall watchdog keeps and `generate_demo` reads (for
// the scorecard's run line). Its own module so the controller can read them
// without importing the watchdog, which imports the controller.

interface StallState {
  /** Nudges sent since the user last spoke. */
  nudges: number
  /** Pipeline tool calls since the user last spoke — see `PIPELINE_TOOLS`. */
  pipelineCalls: number
  lastUserMessageAt: number
  cancelled: boolean
  salvageTried: boolean
}

/**
 * The tools that mean "this request is a demo being made". Listing files or
 * reading a page to answer a question is not one of them: a turn that used
 * only those and ended in text is a conversation, and is left alone.
 */
export const PIPELINE_TOOLS: ReadonlySet<string> = new Set([
  "rehearse_flow",
  "save_login",
  "submit_plan",
  "generate_demo",
])

const states = new Map<string, StallState>()

export function stallState(key: string): StallState {
  let s = states.get(key)
  if (!s) {
    s = {
      nudges: 0,
      pipelineCalls: 0,
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
    pipelineCalls: 0,
    lastUserMessageAt: Date.now(),
    cancelled: false,
    salvageTried: false,
  })
}

/** The user pressed stop: a turn that ends now ended because they said so. */
export function noteCancel(key: string): void {
  stallState(key).cancelled = true
}
