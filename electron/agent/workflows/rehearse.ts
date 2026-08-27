// ── Rehearsal: one flow, off camera ─────────────────────────────────────────
//
// One `rehearseFlow` call == one flow == one fresh sub-agent with its own
// bounded step budget. See decision D1 in the Phase 2 plan for why this is a
// sub-agent rather than a controller turn: a 12-scene demo is ~70 browser
// steps, each preceded by a 1-5k-token snapshot, and none of that belongs in
// the chat thread. What reaches the conversation is one line per flow.
//
// Everything the flow proves goes to disk as it is proven (rehearsal.ts), not
// into this function's return value — so a run that dies halfway still leaves
// a usable partial script behind.

import { createTool } from "@mastra/core/tools"
import { WORKSPACE_TOOLS } from "@mastra/core/workspace"
import { promises as fs } from "node:fs"
import { z } from "zod"
import { createDemioAgent } from "../demio-agent"
import { rehearsalInstructions } from "../prompts"
import { sceneScriptSchema } from "./script-schema"
import {
  beginFlow,
  dropFlowScripts,
  ensureRehearsalDirs,
  finishFlow,
  inProgressFlow,
  readFindings,
  readScripts,
  recordFinding,
  recordScript,
  rehearsalPaths,
} from "./rehearsal"
import type { FindingKind } from "./rehearsal"
import log from "../../lib/logger"

/** Shell only, from the factory's side — the two rehearsal tools come in via `extraTools`. */
const REHEARSAL_TOOL_FILTER = [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]

/**
 * Step ceiling for one flow. Spec §8 budgets ~30-40 steps per flow; each
 * proven step costs roughly snapshot + command + assert + record + screenshot,
 * so this is about eight proven steps' worth of room plus exploration.
 */
export const REHEARSAL_MAX_STEPS = 40

/** Flow ids are kebab-case so `<flowId>.NN` scene ids stay unambiguous. */
export const SAFE_FLOW_ID = /^[a-z0-9-]+$/

export interface RehearseFlowOutcome {
  status: "done" | "blocked"
  detail: string
  sceneIds: string[]
}

/**
 * The two tools only the rehearsal sub-agent gets. Both are bound to one
 * workspace AND one flow: without the flow binding, a sub-agent that
 * mis-numbered a scene could overwrite a different flow's proven work, and
 * nothing downstream would be able to tell.
 */
function createRehearsalTools(workspace: string, flowId: string) {
  const scenePrefix = `${flowId}.`
  return {
    record_scene_script: createTool({
      id: "record_scene_script",
      description:
        "Record the proven script for one scene. Call this after EVERY proven step, not once at the end — re-calling with the same sceneId replaces the previous version.",
      inputSchema: sceneScriptSchema,
      outputSchema: z.object({ ok: z.boolean(), actions: z.number() }),
      execute: async (input) => {
        if (!input.sceneId.startsWith(scenePrefix)) {
          throw new Error(
            `record_scene_script: sceneId "${input.sceneId}" does not belong to flow ` +
              `"${flowId}" — scenes of this flow are named ${scenePrefix}01, ${scenePrefix}02, …`
          )
        }
        // Same pattern `demo-video.ts:86` enforces at record time. Checked
        // again here so a bad id fails while the model can still fix it,
        // rather than two tasks downstream when every scene id is frozen into
        // an approved plan.
        if (!/^[a-zA-Z0-9._-]+$/.test(input.sceneId)) {
          throw new Error(
            `record_scene_script: sceneId "${input.sceneId}" is not a safe filename slug`
          )
        }
        await recordScript(workspace, input)
        return { ok: true, actions: input.actions.length }
      },
    }),
    record_finding: createTool({
      id: "record_finding",
      description:
        "Record one rehearsal finding: an ambiguous selector, a required wait, a blocker, or state this rehearsal created in the real product.",
      inputSchema: z.object({
        kind: z.enum(["selector", "wait", "blocker", "state-created", "note"]),
        text: z.string().describe("One sentence. Concrete, not a summary."),
      }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async (input) => {
        await recordFinding(workspace, {
          flowId,
          kind: input.kind as FindingKind,
          text: input.text,
        })
        return { ok: true }
      },
    }),
  }
}

/**
 * Rehearse one flow. Resolves for every outcome including a blocked flow —
 * "blocked" is information the conversation acts on, not an error.
 */
export async function rehearseFlow(opts: {
  workspace: string
  modelId: string
  flow: { id: string; label: string; startUrl: string; goal: string }
  guidance?: string
  resumeNote?: string
  signal?: AbortSignal
}): Promise<RehearseFlowOutcome> {
  const { workspace, flow } = opts
  if (!SAFE_FLOW_ID.test(flow.id)) {
    throw new Error(
      `rehearseFlow: flow id "${flow.id}" must match ${SAFE_FLOW_ID} ` +
        `(scene ids are derived from it)`
    )
  }

  await ensureRehearsalDirs(workspace)

  // §10 resume, detected here rather than in the prompt so it cannot depend on
  // the model noticing. With one sub-agent per flow (decision D1) the spec's
  // Case A and Case B collapse into a single path: a flow STILL marked
  // in-progress when this call starts was interrupted — by an app restart, a
  // cancel, or a crash — and the live page is not where its transcript
  // implies. After a restart the browser is guaranteed gone
  // (`cleanupStaleSessions()` runs `close --all` at app start,
  // daemon.ts:18-32); after a cancel it is parked mid-flow, which is just as
  // unusable a start state. Either way the answer is the same: rewind to the
  // flow's own start. Read BEFORE `beginFlow` below, which overwrites it.
  const previous = await inProgressFlow(workspace)
  const resumeNote =
    opts.resumeNote ??
    (previous?.id === flow.id
      ? "A previous attempt at this flow was interrupted before it finished."
      : undefined)

  // Forget the previous attempt's scenes BEFORE the checkpoint says
  // in-progress: a second attempt may prove fewer scenes than the first, and
  // a leftover `flow.04` would be recorded as if it had been proven.
  await dropFlowScripts(workspace, flow.id)
  await beginFlow(workspace, {
    id: flow.id,
    label: flow.label,
    startUrl: flow.startUrl,
  })

  const paths = rehearsalPaths(workspace)
  let text = ""
  let steps: unknown[] = []
  try {
    const agent = createDemioAgent({
      workspace,
      modelId: opts.modelId,
      toolFilter: REHEARSAL_TOOL_FILTER,
      extraTools: createRehearsalTools(workspace, flow.id),
      instructionsOverride: rehearsalInstructions({
        workspace,
        flow,
        screenshotDir: paths.screenshots,
        findings: await readFindings(workspace),
        guidance: opts.guidance,
        resumeNote,
      }),
    })
    const res = await agent.generate(
      `Rehearse the flow "${flow.label}" starting from ${flow.startUrl}.`,
      { abortSignal: opts.signal, maxSteps: REHEARSAL_MAX_STEPS }
    )
    text = (res.text ?? "").trim()
    steps = (res.steps ?? []) as unknown[]
  } catch (err) {
    text = `BLOCKED: rehearsal agent error: ${
      err instanceof Error ? err.message : String(err)
    }`
    log.warn(`[rehearsal] flow ${flow.id} failed: ${text}`)
  }

  // Write-only transcript, same role as `narration.agent.json` — the only
  // record of what the sub-agent actually did, since its conversation lives
  // and dies inside this call.
  try {
    await fs.writeFile(
      `${paths.dir}/${flow.id}.agent.json`,
      JSON.stringify({ flow, modelId: opts.modelId, text, steps }, null, 2),
      "utf8"
    )
  } catch {
    // debug artifact only — never fail a flow over it
  }

  const doc = await readScripts(workspace)
  const sceneIds = doc.scripts
    .map((s) => s.sceneId)
    .filter((id) => id.startsWith(`${flow.id}.`))

  // A "DONE" with nothing on disk is the failure this design is most exposed
  // to: the sub-agent narrated a successful rehearsal without ever calling
  // record_scene_script. Trust the artifacts, not the prose.
  const claimsDone = text.startsWith("DONE")
  const status: "done" | "blocked" =
    claimsDone && sceneIds.length > 0 ? "done" : "blocked"
  const detail =
    claimsDone && sceneIds.length === 0
      ? `${text} — but no scene script was recorded, so nothing was actually proven`
      : text || "rehearsal agent returned nothing"

  await finishFlow(workspace, { id: flow.id, status, sceneIds, detail })
  return { status, detail, sceneIds }
}
