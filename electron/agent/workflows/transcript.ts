// ── Agent transcript projection binding ─────────────────────────────────────
//
// Every place an agent's `generate()` steps are written to disk goes through
// `projectSteps` first. See `transcript-pure.cjs` for why: written raw, a
// 100-step rehearsal is 159 MB, 99.7% of it the conversation restated.

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export interface ProjectedStep {
  stepType?: string
  finishReason?: string
  text: string
  reasoningText?: string
  modelId?: string
  toolCalls: Array<{ toolCallId?: string; toolName?: string; args?: unknown }>
  toolResults: Array<{
    toolCallId?: string
    toolName?: string
    result?: unknown
    isError?: true
  }>
  usage?: Record<string, number>
  warnings?: unknown[]
}

const pure = require("./transcript-pure.cjs") as {
  projectSteps: (steps: unknown) => {
    opening: unknown
    steps: ProjectedStep[]
  }
}

/** Reduce raw agent steps to what happened in them, for writing to disk. */
export function projectSteps(steps: unknown): {
  opening: unknown
  steps: ProjectedStep[]
} {
  return pure.projectSteps(steps)
}
