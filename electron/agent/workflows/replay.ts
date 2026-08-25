// ── Replay engine binding ────────────────────────────────────────────────────
//
// Thin TS wrapper over `replay-pure.cjs`. All decision logic lives in the
// .cjs (and is unit-tested there); this file only supplies the real exec
// function and the types. Same split as sync.ts / edl-pure.cjs.

import { createRequire } from "node:module"
import { execAgentBrowser } from "../../lib/agent-browser/exec"
import type { SceneScript } from "./script-schema"

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
  normalizeScript: (raw: unknown) => SceneScript
}

/** Predicted length of a clean take, in ms. */
export function expectedDurationMs(script: SceneScript): number {
  return pure.expectedDurationMs(script)
}

/**
 * Replay one scene's script against the live browser. Stops at the first
 * deviation — the caller stops the recording and recovers off camera.
 */
export async function replayScene(opts: {
  script: SceneScript
  signal?: AbortSignal
  onStep?: (step: ReplayStep) => void
}): Promise<ReplayOutcome> {
  return pure.runScript({
    script: opts.script,
    exec: execAgentBrowser,
    onStep: opts.onStep,
    signal: opts.signal,
  })
}
