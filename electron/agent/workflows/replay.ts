// ── Replay engine binding ────────────────────────────────────────────────────
//
// Thin TS wrapper over `replay-pure.cjs`. All decision logic lives in the
// .cjs (and is unit-tested there); this file only supplies the real exec
// function and the types. Same split as sync.ts / edl-pure.cjs.

import { createRequire } from "node:module"
import { execAgentBrowser } from "../../lib/agent-browser/exec"
import type { SceneScript } from "./script-schema"
import log from "../../lib/logger"

const require = createRequire(import.meta.url)

export interface ReplayStep {
  index: number
  cmd: string
  status: "ok" | "deviation"
  detail: string
  durationMs: number
}

export interface ReplayOutcome {
  status: "ok" | "deviation" | "aborted"
  steps: ReplayStep[]
  deviation?: { index: number; cmd: string; detail: string }
}

const pure = require("./replay-pure.cjs") as {
  runScript: (o: {
    script: SceneScript
    exec: typeof execAgentBrowser
    onStep?: (s: ReplayStep) => void
    signal?: AbortSignal
  }) => Promise<ReplayOutcome>
  expectedDurationMs: (s: SceneScript) => number
  positioningCommands: (o: { script: SceneScript; isRetry: boolean }) => {
    commands: string[]
    reopens: boolean
    preRollIndex: number | null
  }
}

/** Predicted length of a clean take, in ms. */
export function expectedDurationMs(script: SceneScript): number {
  return pure.expectedDurationMs(script)
}

/**
 * Replay one scene's script against the live browser. Stops at the first
 * deviation — the caller stops the recording and recovers off camera.
 *
 * **Exception behaviour:** This function resolves with a `ReplayOutcome` for
 * every step-level and abort outcome. However, it throws (does not resolve)
 * only when the agent-browser binary cannot be resolved — an environment
 * failure that is deliberately not converted into a deviation. Recovery
 * cannot fix a missing binary, and retaking the scene would repeat the same
 * failure. Callers must let this exception propagate rather than treating it
 * as a failed take.
 */
export async function replayScene(opts: {
  script: SceneScript
  signal?: AbortSignal
  onStep?: (step: ReplayStep) => void
}): Promise<ReplayOutcome> {
  // The deleted `end-url` check was unconditional; its replacement is the
  // per-step `assert`, which `scriptedActionSchema` marks optional. So a
  // script whose LAST action carries no assert ends the scene with no proof
  // it landed anywhere in particular. Warn rather than reject: assert stays
  // optional on purpose (hand-written scripts, including the shipped
  // fixture, are allowed), but the gap should be visible rather than silent.
  const last = opts.script.actions[opts.script.actions.length - 1]
  if (last && !last.assert) {
    log.warn(
      `[demo-workflow] scene ${opts.script.sceneId}: final action \`${last.cmd}\` ` +
        `has no \`assert\` — this take will finish with no end-state proof`
    )
  }
  return pure.runScript({
    script: opts.script,
    exec: execAgentBrowser,
    onStep: opts.onStep,
    signal: opts.signal,
  })
}

/**
 * Whether a script may be replayed off camera at all.
 *
 * Replaying performs the scene's actions for real. That is fine for a
 * navigation or a read, and not fine for a scene that creates something the
 * product keeps: `oneShot` says so outright, and a non-empty `params` map says
 * the record pass is deliberately going to run with DIFFERENT values, so a
 * dry run here would either consume those values early or leave a third copy
 * behind.
 *
 * Exported so every caller applies the same rule — one policy, not two.
 */
export function isSafeToReplayOffCamera(script: SceneScript): boolean {
  return !script.oneShot && Object.keys(script.params ?? {}).length === 0
}

/**
 * Position a scene and replay it with the camera off.
 *
 * The one way anything in this codebase is allowed to claim a script "works":
 * positioning comes from `positioningCommands` — the exact function the
 * recording bracket uses — and the step loop is `replayScene`, the exact loop
 * the record pass runs. A pass here means the same commands, in the same
 * order, against the same page.
 *
 * `isRetry` must match what the take that follows will do: the dress
 * rehearsal (a fresh run of the whole flow) passes `false` so a chained scene
 * continues from its predecessor; validating an amendment before a RETAKE
 * passes `true`, because a retake always re-opens `startUrl`.
 */
export async function replayScriptOffCamera(opts: {
  script: SceneScript
  isRetry: boolean
  signal?: AbortSignal
}): Promise<{ ok: boolean; detail: string }> {
  const { script } = opts
  const pos = pure.positioningCommands({ script, isRetry: opts.isRetry })
  for (const cmd of pos.commands) {
    if (opts.signal?.aborted) return { ok: true, detail: "aborted" }
    const r = await execAgentBrowser([cmd], { timeout: 60_000 })
    if (!r.ok) {
      return {
        ok: false,
        detail:
          `could not even be positioned: \`${cmd}\` failed ` +
          `(${r.error ?? "unknown error"}). The recording pass runs this exact ` +
          `command before it starts the camera.`,
      }
    }
  }

  const outcome = await replayScene({ script, signal: opts.signal })
  if (outcome.status === "aborted") return { ok: true, detail: "aborted" }
  if (outcome.status === "deviation" && outcome.deviation) {
    const d = outcome.deviation
    return {
      ok: false,
      detail: `step ${d.index} (\`${d.cmd}\`) ${d.detail}`,
    }
  }
  return {
    ok: true,
    detail: `replayed ${script.actions.length} action(s) cleanly`,
  }
}
