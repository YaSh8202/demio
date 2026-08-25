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
