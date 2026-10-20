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
import { isSafeToReplayOffCamera, replayScriptOffCamera } from "./replay"
import { hasProfile, loginProfile, vaultProfileName } from "./credentials"
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
import { projectSteps } from "./transcript"
import { recordRehearsal } from "./scorecard"
import log from "../../lib/logger"
import { BUDGET_MS, idleBudget } from "./budget"

/** Shell only, from the factory's side — the two rehearsal tools come in via `extraTools`. */
const REHEARSAL_TOOL_FILTER = [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]

/**
 * Replay a flow's proven scripts cold, off camera, before the flow may be
 * called `done`.
 *
 * **This is the gate the design was missing.** Rehearsal proves a *sequence of
 * interactive actions* and then writes down a *script*; those are two different
 * artifacts, and until now nothing executed the second one until the camera was
 * already rolling. Every difference between the two — a wait the agent made
 * interactively but never recorded, a step that only worked because the agent
 * had been on the page for a minute, a login the run does not actually have —
 * surfaced at record time, in the one place where nothing can be fixed and the
 * only options are three identical retries and a suspension card.
 *
 * Running it here moves those failures to where they are cheap: the agent is
 * still alive, still has the product open, and still has budget to fix its own
 * script.
 *
 * Positioning comes from `positioningCommands`, the exact function the
 * recording bracket uses, and the step loop is the exact `replayScene` the
 * record pass runs — so a pass here means the same commands in the same order
 * against the same page. A test pins the two together.
 *
 * **Skipped, per scene, when replaying would not be safe:** a `oneShot` scene
 * cannot be run twice at all, and a scene with `params` deliberately runs with
 * DIFFERENT values on the record pass, so replaying it here would either
 * consume those values early or create a third copy of whatever it creates.
 * Skips are reported, never silent — an unproven script should not read as a
 * proven one.
 */
async function dressRehearse(
  workspace: string,
  flowId: string,
  signal: AbortSignal | undefined
): Promise<{ ok: boolean; detail: string }> {
  const doc = await readScripts(workspace)
  const scripts = doc.scripts.filter((s) => s.sceneId.startsWith(`${flowId}.`))
  if (scripts.length === 0) return { ok: true, detail: "no scenes to replay" }

  const skipped: string[] = []
  const replayed: string[] = []

  for (const script of scripts) {
    if (signal?.aborted) return { ok: true, detail: "aborted before replay" }
    if (!isSafeToReplayOffCamera(script)) {
      skipped.push(
        `${script.sceneId} (${script.oneShot ? "oneShot" : "parameterised"})`
      )
      continue
    }

    // `isRetry: false` — this simulates a fresh run of the whole flow, so a
    // chained scene continues from the scene this loop just replayed, exactly
    // as it will during recording.
    const res = await replayScriptOffCamera({ script, isRetry: false, signal })
    if (!res.ok) {
      const slow = res.detail.startsWith("replays cleanly")
      return {
        ok: false,
        detail: slow
          ? `${script.sceneId} ${res.detail}. Replace the slow step with an ` +
            `observation that proves the same state instantly, then call ` +
            `record_scene_script again.`
          : `${script.sceneId} does not replay: ${res.detail}. It worked ` +
            `while you were driving the page by hand, but not as a script ` +
            `run cold from ${script.startUrl}.`,
      }
    }
    replayed.push(script.sceneId)
  }

  const parts = [`replayed ${replayed.length} scene(s) cleanly`]
  if (skipped.length > 0) parts.push(`not replayed: ${skipped.join(", ")}`)
  return { ok: true, detail: parts.join("; ") }
}

/**
 * Step ceiling for one flow.
 *
 * Spec §8 budgeted ~30-40, on the model of snapshot + command + assert +
 * record + screenshot per proven step — about eight proven steps plus
 * exploration. Real flows on a real product do not fit that. The workik
 * `open-project-new` rehearsal proved two scenes (six actions) and still hit
 * the ceiling, because exploration is not a fixed overhead: an ambiguous
 * role match, a selector that needs an `eval` to pin down, or a daemon
 * hiccup each cost a step, and they scale with the product, not the flow.
 *
 * Raised to 100 at the user's direction. The ceiling is a runaway guard, not
 * a budget to spend — `finishFlow` still records how many scenes were
 * actually proven, and a flow that exhausts 100 steps is genuinely wrong
 * rather than merely large.
 */
export const REHEARSAL_MAX_STEPS = 100

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
  let vaultProfile: string | null = null
  const budget = idleBudget(
    BUDGET_MS.rehearsalIdle,
    BUDGET_MS.rehearsal,
    opts.signal
  )
  try {
    // A login-gated product cannot be rehearsed logged out, and the sub-agent
    // must not authenticate itself: credentials typed into a command end up
    // in the scene script, and a scene script is replayed on camera.
    // `save_login` (controller.ts) stored them in the vault before the first
    // flow; this is where they get used. Mirrors `preflightStep` in
    // demo-video.ts, which does the same thing for the record pass — see its
    // comment for why a failure here is advisory rather than fatal.
    //
    // The profile NAME (never the secret) is passed into the prompt below, so
    // the agent can script `auth login <profile>` instead of typing a
    // password — and so it knows it is already signed in and must not sign
    // out to "prove" the login flow.
    if (await hasProfile(workspace)) {
      vaultProfile = vaultProfileName(workspace)
      const auth = await loginProfile(workspace)
      if (!auth.ok && auth.stillOnLoginForm) {
        // Positive evidence of a login form AFTER `auth login` navigated to
        // the login URL: authentication genuinely failed. Loud, because a
        // rehearsal that walks a logged-out product proves the wrong flow —
        // or, worse, proves nothing and burns the step budget rediscovering
        // that it is signed out.
        log.warn(
          `[rehearsal] vault login FAILED for flow ${flow.id} (${auth.detail}) ` +
            `— a password field is still on screen, so this run is NOT ` +
            `authenticated. Check the profile's saved selectors.`
        )
      } else if (!auth.ok) {
        log.info(
          `[rehearsal] vault login did not complete for flow ${flow.id} ` +
            `(${auth.detail}) — expected when the session is already ` +
            `authenticated; continuing`
        )
      }
    }

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
        vaultProfile,
      }),
    })
    const res = await agent.generate(
      `Rehearse the flow "${flow.label}" starting from ${flow.startUrl}.`,
      {
        abortSignal: budget.signal,
        maxSteps: REHEARSAL_MAX_STEPS,
        onStepFinish: () => budget.touch(),
      }
    )
    text = (res.text ?? "").trim()
    steps = (res.steps ?? []) as unknown[]
    // An aborted `generate` does not throw — it RETURNS, with the steps so far
    // and no text. Unlabelled, that read as "rehearsal agent returned nothing"
    // and sent the planner digging through the transcript for a reason that
    // was never in it.
    const expired = budget.expired()
    if (expired && !opts.signal?.aborted) {
      text =
        `BLOCKED: rehearsal ran out of time (${expired}) after ${steps.length} step(s), ` +
        `before it proved a scene. Rehearse a smaller flow, or give guidance that gets it there faster.`
      log.warn(`[rehearsal] flow ${flow.id}: ${text}`)
    }
  } catch (err) {
    text = `BLOCKED: rehearsal agent error: ${
      err instanceof Error ? err.message : String(err)
    }`
    log.warn(`[rehearsal] flow ${flow.id} failed: ${text}`)
  }

  budget.done()

  // Write-only transcript, same role as `narration.agent.json` — the only
  // record of what the sub-agent actually did, since its conversation lives
  // and dies inside this call.
  try {
    await fs.writeFile(
      `${paths.dir}/${flow.id}.agent.json`,
      // Projected, never raw: raw steps restate the whole conversation four
      // times each, and a 100-step flow came to 159 MB stringified on the
      // main thread. See `transcript-pure.cjs`.
      JSON.stringify(
        { flow, modelId: opts.modelId, text, ...projectSteps(steps) },
        null,
        2
      ),
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
  let status: "done" | "blocked" =
    claimsDone && sceneIds.length > 0 ? "done" : "blocked"
  let detail =
    claimsDone && sceneIds.length === 0
      ? `${text} — but no scene script was recorded, so nothing was actually proven`
      : text || "rehearsal agent returned nothing"

  // The dress rehearsal. `done` now means "these scripts have been executed
  // cold and they work", not "the agent said so". Only runs on an otherwise
  // successful flow: a blocked flow has nothing worth replaying, and a
  // half-written script would just produce a second, noisier failure.
  let blockedByDressRehearsal = false
  let dressInfo: { ran: boolean; ok?: boolean; detail?: string } = {
    ran: false,
  }
  if (status === "done") {
    try {
      const dress = await dressRehearse(workspace, flow.id, opts.signal)
      dressInfo = {
        ran: true,
        ok: dress.ok,
        detail: dress.detail.slice(0, 200),
      }
      if (!dress.ok) {
        status = "blocked"
        blockedByDressRehearsal = true
        detail =
          `the script this flow produced does not replay — ${dress.detail} ` +
          `Rehearse it again and fix that step; recording it as it stands ` +
          `would fail on camera with no way to recover.`
        log.warn(
          `[rehearsal] flow ${flow.id} failed its dress rehearsal: ${dress.detail}`
        )
      } else {
        detail = `${detail} (dress rehearsal: ${dress.detail})`
      }
    } catch (err) {
      // A dress rehearsal that cannot run is not evidence the script is bad.
      // Leave the flow `done` and say the check did not happen, rather than
      // blocking a good flow on a broken checker.
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(
        `[rehearsal] dress rehearsal for ${flow.id} could not run: ${msg}`
      )
      detail = `${detail} (dress rehearsal did not run: ${msg})`
    }
  }

  // A blocked result that also exhausted the step budget is not a real
  // blocker the outer agent can resolve with guidance — re-invoking restarts
  // under the same ceiling (dropFlowScripts wipes the partial progress) and
  // can never converge. Say so plainly so the outer agent splits the flow
  // instead of retrying it unchanged.
  // Not when the dress rehearsal is what blocked it: the agent finished
  // inside its budget and produced a script, so "split this flow" is the
  // wrong advice — the script has one bad step and needs fixing, not
  // dividing.
  if (
    status === "blocked" &&
    !blockedByDressRehearsal &&
    steps.length >= REHEARSAL_MAX_STEPS
  ) {
    detail =
      `${detail} — step budget (${REHEARSAL_MAX_STEPS} steps) exhausted after ` +
      `proving ${sceneIds.length} scene(s); this flow needs more steps than one ` +
      `rehearsal call allows, so split it into smaller flows rather than retrying ` +
      `it unchanged`
  }

  await recordRehearsal({
    workspace,
    flowId: flow.id,
    status,
    detail,
    text,
    steps,
    maxSteps: REHEARSAL_MAX_STEPS,
    scripts: doc.scripts.filter((s) => s.sceneId.startsWith(`${flow.id}.`)),
    dress: dressInfo,
  })
  await finishFlow(workspace, { id: flow.id, status, sceneIds, detail })
  return { status, detail, sceneIds }
}
