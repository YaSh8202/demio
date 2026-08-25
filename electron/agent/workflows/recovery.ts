// ── Camera-off recovery ──────────────────────────────────────────────────────
//
// Runs between `record stop` and the retake, so its fumbling never reaches
// the video. Deliberately narrow: see recoveryInstructions() for why it must
// not perform the scene's own steps.

import { WORKSPACE_TOOLS } from "@mastra/core/workspace"
import { createDemioAgent } from "../demio-agent"
import { recoveryInstructions } from "../prompts"
import type { SceneScript } from "./script-schema"
import log from "../../lib/logger"

/** Shell only — recovery reads and writes nothing on disk. */
const RECOVERY_TOOL_FILTER = [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]

/** Hard ceiling matching the prompt's "at most 3 commands". */
const RECOVERY_MAX_STEPS = 6

export interface RecoveryOutcome {
  recovered: boolean
  detail: string
  /**
   * The agent's raw generation steps, returned so the caller can persist
   * them next to the scene's other artifacts.
   *
   * This is the ONLY on-disk evidence for the load-bearing rule in
   * `recoveryInstructions()`: recovery may clear obstacles but must never
   * perform the scene's own scripted actions. Without it that boundary is
   * unfalsifiable after the fact — the tool calls here are what a reviewer
   * reads to confirm none of the script's commands were run. Raw rather than
   * projected, matching `narration.agent.json` in demo-video.ts.
   */
  steps: unknown[]
}

export async function recoverFromDeviation(opts: {
  workspace: string
  modelId: string
  script: SceneScript
  deviation: { index: number; cmd: string; detail: string }
  /** User-typed hint from a prior "retry" resume — forwarded as advisory. */
  guidance?: string
  signal: AbortSignal
}): Promise<RecoveryOutcome> {
  try {
    const agent = createDemioAgent({
      workspace: opts.workspace,
      modelId: opts.modelId,
      toolFilter: RECOVERY_TOOL_FILTER,
      instructionsOverride: recoveryInstructions({
        workspace: opts.workspace,
        script: opts.script,
        deviation: opts.deviation,
        guidance: opts.guidance,
      }),
    })
    const res = await agent.generate(
      `Clear the blocker on step ${opts.deviation.index} of ${opts.script.sceneId}.`,
      { abortSignal: opts.signal, maxSteps: RECOVERY_MAX_STEPS }
    )
    const text = (res.text ?? "").trim()
    const steps = (res.steps ?? []) as unknown[]
    // Unlike the old recorder's DONE/STUCK protocol — which nothing ever
    // parsed — this reply is genuinely read: it decides retake vs escalate.
    if (text.startsWith("CLEARED")) {
      return { recovered: true, detail: text, steps }
    }
    return {
      recovered: false,
      detail: text || "recovery agent returned nothing",
      steps,
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log.warn(`[demo-workflow] recovery agent failed: ${detail}`)
    // `steps: []` rather than omitting the field, so every caller sees one
    // shape and the transcript always carries a `recovery.steps` array.
    return {
      recovered: false,
      detail: `recovery agent error: ${detail}`,
      steps: [],
    }
  }
}
