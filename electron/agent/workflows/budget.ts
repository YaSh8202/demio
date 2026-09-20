// ── Wall-clock budgets (ADR-013) ─────────────────────────────────────────────
//
// Step budgets bound how much a sub-agent does; nothing bounded how long it
// takes. A provider connection that stalls mid-stream, or a wedged ffmpeg,
// hung the run for good — which is its own way of never delivering a video.
// Expiry aborts the stage, and every stage already has an answer to being
// aborted: rehearsal reports BLOCKED, recovery reports not-recovered, and the
// post-recording stages degrade (see demo-video.ts).

const DEFAULTS = {
  /**
   * One flow's rehearsal, overall. Up to 100 model steps, each driving a
   * browser — a weak model takes ~30s a step, so the first value here (12 min)
   * cut a healthy rehearsal off at step 27 and reported it as "returned
   * nothing". The overall cap is for the pathological run; what catches a hang
   * is `rehearsalIdle`.
   */
  rehearsal: 45 * 60_000,
  /** No rehearsal step finished in this long: it is stuck, not slow. */
  rehearsalIdle: 5 * 60_000,
  /** One recovery: 6 steps, with a take waiting on it. */
  recovery: 3 * 60_000,
  narrate: 2 * 60_000,
  ttsPerScene: 2 * 60_000,
  /** One scene's retiming — several ffmpeg passes, each with its own timeout too. */
  syncPerScene: 10 * 60_000,
  compose: 5 * 60_000,
}

/**
 * `DEMIO_BUDGET_<NAME>_MS` overrides one, read at use — so a test can make a
 * budget expire in a second and watch the stage degrade (`<stage>:hang` in
 * ./fault), which is the only way expiry is ever seen on purpose.
 */
export const BUDGET_MS = new Proxy(DEFAULTS, {
  get: (defaults, name: keyof typeof DEFAULTS) =>
    Number(process.env[`DEMIO_BUDGET_${String(name).toUpperCase()}_MS`]) ||
    defaults[name],
})

/** `signal`, or the budget, whichever ends first. */
export function withBudget(ms: number, signal?: AbortSignal): AbortSignal {
  const budget = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, budget]) : budget
}

/**
 * A budget on PROGRESS: aborts when `touch()` has not been called for `idleMs`
 * (or after `totalMs` overall). For a loop of many steps, where "how long in
 * total" says little and "how long since anything happened" says everything.
 * `expired()` tells a budget abort from the caller's own.
 */
export function idleBudget(
  idleMs: number,
  totalMs: number,
  signal?: AbortSignal
): {
  signal: AbortSignal
  touch: () => void
  done: () => void
  expired: () => string | null
} {
  const controller = new AbortController()
  let why: string | null = null
  const fire = (reason: string) => () => {
    why = reason
    controller.abort(new Error(reason))
  }
  let idle = setTimeout(
    fire(`no step finished in ${idleMs / 60_000} min`),
    idleMs
  )
  const total = setTimeout(
    fire(`still running after ${totalMs / 60_000} min`),
    totalMs
  )
  return {
    signal: signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal,
    touch: () => {
      clearTimeout(idle)
      idle = setTimeout(
        fire(`no step finished in ${idleMs / 60_000} min`),
        idleMs
      )
    },
    done: () => {
      clearTimeout(idle)
      clearTimeout(total)
    },
    expired: () => why,
  }
}
