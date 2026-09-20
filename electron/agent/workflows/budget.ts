// ── Wall-clock budgets (ADR-013) ─────────────────────────────────────────────
//
// Step budgets bound how much a sub-agent does; nothing bounded how long it
// takes. A provider connection that stalls mid-stream, or a wedged ffmpeg,
// hung the run for good — which is its own way of never delivering a video.
// Expiry aborts the stage, and every stage already has an answer to being
// aborted: rehearsal reports BLOCKED, recovery reports not-recovered, and the
// post-recording stages degrade (see demo-video.ts).

export const BUDGET_MS = {
  /** One flow's rehearsal: up to 100 model steps, each driving a browser. */
  rehearsal: 12 * 60_000,
  /** One recovery: 6 steps, with a take waiting on it. */
  recovery: 3 * 60_000,
  narrate: 2 * 60_000,
  ttsPerScene: 2 * 60_000,
  compose: 5 * 60_000,
}

/** `signal`, or the budget, whichever ends first. */
export function withBudget(ms: number, signal?: AbortSignal): AbortSignal {
  const budget = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, budget]) : budget
}
