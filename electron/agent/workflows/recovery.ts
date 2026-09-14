// ── Camera-off recovery ──────────────────────────────────────────────────────
//
// Runs between `record stop` and the retake, so its fumbling never reaches
// the video. Deliberately narrow: see recoveryInstructions() for why it must
// not perform the scene's own steps.

import { createTool } from "@mastra/core/tools"
import { WORKSPACE_TOOLS } from "@mastra/core/workspace"
import { z } from "zod"
import { createDemioAgent } from "../demio-agent"
import { recoveryInstructions } from "../prompts"
import { hasProfile, vaultProfileName } from "./credentials"
import { scriptedActionSchema } from "./script-schema"
import type { SceneScript, ScriptedAction } from "./script-schema"
import {
  isSafeToReplayOffCamera,
  replayScriptOffCamera,
  assertScriptLints,
  checkAmendment,
} from "./replay"
import { recordScript } from "./rehearsal"
import log from "../../lib/logger"

/** Shell only — recovery reads and writes nothing on disk. */
const RECOVERY_TOOL_FILTER = [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]

/** Hard ceiling matching the prompt's "at most 3 commands". */
const RECOVERY_MAX_STEPS = 6

export interface RecoveryOutcome {
  recovered: boolean
  detail: string
  /**
   * The scene's script, rewritten by the recovery agent and PROVEN by a cold
   * off-camera replay. Present only when an amendment was made and accepted;
   * the caller retakes with this instead of the original.
   *
   * Recovery has always been able to change the world — dismiss a modal, sign
   * in — but never the plan. Most of what actually breaks a take is in the
   * plan: a missing precondition, a selector that moved. Without this the
   * agent could see the fix and had no way to apply it, so the retake replayed
   * the same broken script and failed the same way.
   */
  amendedScript?: SceneScript
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

/**
 * The amendment tool, bound to ONE scene.
 *
 * Deliberately narrow: `actions` only. `startUrl`, `endUrl`, `continuity`,
 * `oneShot` and `params` are the scene's contract with the rest of the
 * pipeline — `endUrl` is the next chained scene's start state, `continuity`
 * decides the recording bracket — and a six-step agent looking at one failed
 * step has no business renegotiating them. Every failure this exists for
 * lives inside `actions`.
 *
 * The candidate is held in memory, not written: it reaches `scripts.json`
 * only after `recoverFromDeviation` replays it cold and it passes. A rejected
 * amendment therefore leaves no trace, and there is no revert path to get
 * wrong if the run dies mid-recovery.
 */
function createAmendTool(
  script: SceneScript,
  failingIndex: number,
  capture: (actions: ScriptedAction[]) => void
) {
  return {
    amend_scene_script: createTool({
      id: "amend_scene_script",
      description:
        "Rewrite this scene's actions when the script itself is what is wrong — a missing `waitBefore`, a selector that no longer matches, an assertion that can never pass. Pass the COMPLETE action list: every step other than the failing one copied VERBATIM from the script in your instructions (every field — `waitBefore`, `assert`, `settleMs`), and the failing step replaced by one or more steps that keep its `assert` (or a better one). Anything else is rejected. The rewrite is replayed cold before any retake, so a bad one is rejected rather than filmed. Use this only when the page is fine and the script is wrong; if the page is what is blocking, clear it with the shell instead.",
      inputSchema: z.object({
        actions: z
          .array(scriptedActionSchema)
          .min(1)
          .describe("The scene's full action list, with your fix applied."),
        reason: z
          .string()
          .describe("One sentence: what was wrong with the old script."),
      }),
      outputSchema: z.object({ ok: z.boolean(), actions: z.number() }),
      execute: async (input) => {
        // "Change only what is broken", enforced: every other step must come
        // back byte-for-byte, the failing step may not be deleted (that would
        // pass every check below — cold replay, verification, duration — and
        // film nothing), and its assertion may not be silently dropped. The
        // first eval of this tool caught the agent rewriting a two-step scene
        // from memory with both `assert`s gone: a script that replays cleanly
        // because it no longer checks anything.
        const shape = checkAmendment(
          script.actions,
          input.actions as ScriptedAction[],
          failingIndex
        )
        if (!shape.ok) {
          throw new Error(
            `amend_scene_script: ${shape.detail} If the step genuinely cannot ` +
              `be performed, reply BLOCKED instead.`
          )
        }
        // Same static gate `recordScript` applies, run here so the agent
        // learns about a bad rewrite inside its own loop — not after a cold
        // replay that was never going to pass.
        assertScriptLints({
          ...script,
          actions: input.actions as ScriptedAction[],
        })
        capture(input.actions as ScriptedAction[])
        return { ok: true, actions: input.actions.length }
      },
    }),
  }
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
    // Resolved on the failure path only — one `auth show` on a run that has
    // already gone wrong. Recovery is the only stage that can sign a
    // signed-out browser back in, and it needs the profile NAME to do it
    // without ever handling the password.
    let vaultProfile: string | null = null
    try {
      if (await hasProfile(opts.workspace)) {
        vaultProfile = vaultProfileName(opts.workspace)
      }
    } catch {
      // A vault that cannot be read is not a reason to skip recovery — the
      // agent simply loses the sign-in option.
      vaultProfile = null
    }

    let amendedActions: ScriptedAction[] | null = null
    const agent = createDemioAgent({
      workspace: opts.workspace,
      modelId: opts.modelId,
      toolFilter: RECOVERY_TOOL_FILTER,
      extraTools: createAmendTool(opts.script, opts.deviation.index, (a) => {
        amendedActions = a
      }),
      instructionsOverride: recoveryInstructions({
        workspace: opts.workspace,
        script: opts.script,
        deviation: opts.deviation,
        guidance: opts.guidance,
        vaultProfile,
        canAmend: true,
      }),
    })
    const res = await agent.generate(
      `Clear the blocker on step ${opts.deviation.index} of ${opts.script.sceneId}.`,
      { abortSignal: opts.signal, maxSteps: RECOVERY_MAX_STEPS }
    )
    const text = (res.text ?? "").trim()
    const steps = (res.steps ?? []) as unknown[]

    // Validate and persist an amendment before deciding the outcome. A
    // rewritten script that has not been replayed is exactly the artifact
    // this whole design exists to stop trusting.
    let amendedScript: SceneScript | undefined
    // TS narrows the closure-assigned local to `null` without this: the
    // callback that sets it is not visible to the control-flow analysis.
    const captured = amendedActions as ScriptedAction[] | null
    if (captured) {
      const candidate: SceneScript = { ...opts.script, actions: captured }
      if (!isSafeToReplayOffCamera(candidate)) {
        // A oneShot or parameterised scene must not be run an extra time just
        // to check it. Accept the amendment unverified and say so — the
        // retake is then its first and only test.
        amendedScript = candidate
        await recordScript(opts.workspace, candidate)
        log.info(
          `[demo-workflow] scene ${candidate.sceneId}: script amended, NOT ` +
            `cold-replayed (oneShot/parameterised) — the retake is its first test`
        )
      } else {
        // `isRetry: true` — what follows this is a retake, and a retake always
        // re-opens `startUrl`. Validating under any other assumption would
        // prove a script the retake is not going to run.
        const proof = await replayScriptOffCamera({
          script: candidate,
          isRetry: true,
          signal: opts.signal,
        })
        if (proof.ok) {
          amendedScript = candidate
          // Persisted only now, and to the same file rehearsal writes, so a
          // later run of this thread gets the fix too.
          await recordScript(opts.workspace, candidate)
          log.info(
            `[demo-workflow] scene ${candidate.sceneId}: script amended and ` +
              `proven off camera (${proof.detail})`
          )
        } else {
          log.warn(
            `[demo-workflow] scene ${candidate.sceneId}: amended script ` +
              `REJECTED — ${proof.detail}`
          )
          return {
            recovered: false,
            detail: `the amended script does not replay either: ${proof.detail}`,
            steps,
          }
        }
      }
    }
    // Unlike the old recorder's DONE/STUCK protocol — which nothing ever
    // parsed — this reply is genuinely read: it decides retake vs escalate.
    // An accepted amendment IS a recovery, whatever the agent's prose says:
    // the script it produced has been replayed cold and works, which is
    // stronger evidence than the word CLEARED.
    if (amendedScript) {
      return {
        recovered: true,
        detail: text.startsWith("CLEARED")
          ? text
          : `CLEARED: script amended and proven off camera. ${text}`.trim(),
        steps,
        amendedScript,
      }
    }
    if (text.startsWith("CLEARED")) {
      return { recovered: true, detail: text, steps }
    }
    // An empty reply after a full step budget is not "nothing" — it is the
    // agent spending every step looking and none fixing. Say so; the
    // suspension card is where the user reads this.
    return {
      recovered: false,
      detail:
        text ||
        (steps.length >= RECOVERY_MAX_STEPS
          ? `recovery agent used all ${RECOVERY_MAX_STEPS} steps without amending the script or replying`
          : "recovery agent returned nothing"),
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
