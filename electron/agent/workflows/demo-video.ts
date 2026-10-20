// ── demo-video workflow (ADR-001) ───────────────────────────────────────────
//
// plan (input) → foreach scene [record+verify+retry, DROP on exhaustion]
// → collect (floor scene if nothing survived) → narrate (structured) → tts
// (synthesis only, skipped when no voice) → sync (EDL-based retiming/mix, see
// `./sync`) → compose (concat, ffmpeg).
//
// **Every run ends with a video (ADR-013).** No step here suspends or lets a
// failure past recording end the run: a stage that cannot do its job falls
// back one rung, says so in `degraded`, and the run carries on. The list
// lands on the scorecard's run line and in the chat — degrading is allowed
// because it is never silent. The numbered notes below predate that and still
// explain why scenes are a `.foreach`.
//
// Reconciled against installed `@mastra/core@1.55.0` workflow/agent APIs
// (Task 12) — see `task-12-report.md` for full evidence. The two load-bearing
// deviations from the task-12-brief's starting code:
//
// 1. **Suspend/resume is snapshot-replay, not an in-place await.** Per the
//    installed docs (`node_modules/@mastra/core/dist/docs/references/
//    docs-workflows-suspend-and-resume.md`): "When a workflow is suspended,
//    it restarts from the step where it paused" — resuming RE-INVOKES the
//    suspended step's `execute` from the top, with `resumeData` populated,
//    rather than resolving the original `await suspend(...)` call in place.
//    The canonical pattern reads `resumeData` at the top of `execute` and
//    only calls `suspend()` again if the condition still isn't met — it does
//    NOT use `suspend()`'s return value as the decision (the brief's
//    `recordScenesStep` did exactly that, which is wrong here).
//
//    Given that, a single step containing a `for` loop over every scene
//    (the brief's `recordScenesStep`) is unsafe: resuming it would re-run
//    the loop from scene 0, re-recording every already-completed scene.
//    Fixed by using `.foreach(sceneStep, { concurrency: 1 })` instead — the
//    docs confirm foreach iterations "suspend independently" and a resume
//    only re-invokes the ONE suspended iteration's step
//    (`reference-workflows-workflow-methods-foreach.md`, "Resuming a single
//    iteration"). `concurrency: 1` (default) preserves the sequential
//    continuity contract the brief's manual loop was going for.
//
// 2. **`suspend`/`resumeData` come from `createStep`'s own
//    `suspendSchema`/`resumeSchema` fields**, not an inline
//    `suspend({ suspendSchema, resumeSchema, suspendData })` call —
//    confirmed via `ExecuteFunctionParams` in
//    `agentcontroller-api-notes.md`: `suspend: (suspendPayload?,
//    suspendOptions?) => ...` takes a single payload, not a schema-bearing
//    options object.

import { createWorkflow, createStep } from "@mastra/core/workflows"
import { promises as fs } from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { scenePlanSchema, sceneResultSchema, sceneSchema } from "./schemas"
import type { Scene } from "./schemas"
import { recordSceneWithRetry } from "./record-scene"
import { synthesizeNarrationAudio } from "../lib/voiceover"
import { parseActionEntries, renderScene, renderRawFallback } from "./sync"
import { projectSteps } from "./transcript"
import { recordRun } from "./scorecard"
import type { Degradation } from "./scorecard"
import { maybeFault } from "./fault"
import { BUDGET_MS, withBudget } from "./budget"
import { verifyFinalVideo } from "./verify"
import {
  narrateScenes,
  narrationSegmentsSchema,
  segmentAnchorSchema,
} from "./narrate"
import { resolveFfmpeg } from "../../lib/ffmpeg"
import { getDecryptedKey } from "../../store/provider-keys"
import { getEnvKey } from "../providers"
import { hasProfile, loginProfile } from "./credentials"
import { readScripts } from "./rehearsal"
import log from "../../lib/logger"

const execFileAsync = promisify(execFile)

// Stored key first, env second — same order as `getModel`. The env half is
// what lets a headless run (no safeStorage, so no stored keys) be voiced.
function elevenLabsApiKey(): string | null {
  return getDecryptedKey("elevenlabs") || getEnvKey("elevenlabs") || null
}

const reasonOf = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300)

const degradationSchema = z.object({
  stage: z.enum(["record-scene", "narrate", "tts", "sync", "compose", "floor"]),
  reason: z.string(),
  sceneId: z.string().optional(),
})

/**
 * Scene ids dropped so far, per run (keyed by workspace — one run per thread).
 * `.foreach` iterations share no data, and a `chained` scene has to know its
 * predecessor never finished: its start state is that scene's end state.
 * In-memory is enough now that no step suspends — a run lives in one process
 * from start to compose.
 */
const droppedScenes = new Map<string, Set<string>>()

// `elevenLabsKey` is deliberately NOT part of this schema (code review fix
// #4): `createRun`/`start`/`resume` snapshot `inputData` into the workflow's
// LibSQLStore row on every suspend, and a decrypted API key has no business
// sitting in that table in plaintext. `voiceId` alone travels through the
// pipeline; `ttsStep` re-reads `getDecryptedKey("elevenlabs")` at the moment
// it actually needs the key, off the same on-disk encrypted store
// `controller.ts` already reads it from.
const inputSchema = z.object({
  plan: scenePlanSchema,
  workspace: z.string(),
  modelId: z.string(),
  voiceId: z.string().nullable(),
  // How the harness got the run this far (./stall-watchdog) — carried only so
  // the scorecard's run line can say so.
  nudges: z.number().default(0),
  salvaged: z.boolean().default(false),
})

/** Data every scene-level step needs but doesn't receive as its per-item
 * `inputData` once scenes are inside `.foreach()` — recovered via
 * `getInitData()` instead of being threaded through the array. */
type DemoVideoInit = z.infer<typeof inputSchema>

// `sceneSchema.id` only carries a `.describe()` hint ("Stable slug, e.g.
// scene-01") — no `.regex()` — so a malformed/adversarial plan could smuggle
// path-traversal characters (`../`, `/`) or shell-unsafe characters into a
// sceneId. Every downstream sceneId use ends up in a `path.join(...)` (this
// file's `syncStep`/`composeStep`, and internally inside
// `synthesizeNarrationAudio` and `renderScene` for the per-scene audio/render
// paths) — validate once, here, at the earliest choke point, so every one of
// those sites is safe by construction rather than needing its own guard
// (code review round-2 #6).
const SAFE_SCENE_ID = /^[a-zA-Z0-9._-]+$/

const toScenesStep = createStep({
  id: "to-scenes",
  inputSchema,
  outputSchema: z.array(sceneSchema),
  execute: async ({ inputData }) => {
    // Before a single frame: without ffmpeg there is no sync and no compose,
    // and finding that out after recording every scene helps nobody.
    if (!resolveFfmpeg()) {
      throw new Error(
        "ffmpeg binary not available — cannot produce a demo video."
      )
    }
    droppedScenes.set(inputData.workspace, new Set())
    for (const scene of inputData.plan.scenes) {
      if (!SAFE_SCENE_ID.test(scene.id)) {
        throw new Error(
          `generate_demo: scene id "${scene.id}" is not a safe filename slug ` +
            `(must match ${SAFE_SCENE_ID})`
        )
      }
    }

    // Attach each scene's proven script from rehearsal. A script written
    // inline on the scene wins: explicit beats derived, and a hand-written
    // script (manual-checklist section E) must keep working with no
    // rehearsal artifacts present at all.
    const doc = await readScripts(inputData.workspace)
    const byId = new Map(doc.scripts.map((s) => [s.sceneId, s]))
    const scenes = inputData.plan.scenes.map((scene) =>
      scene.script ? scene : { ...scene, script: byId.get(scene.id) }
    )

    // Fail here rather than per scene. `recordSceneWithRetry` also refuses a
    // scene with no script, but by then the run has already recorded
    // everything before it — and the cause is always the same one thing: the
    // plan named a scene id that rehearsal never produced. Say so once, with
    // both lists, before a single frame is captured.
    const missing = scenes.filter((s) => !s.script).map((s) => s.id)
    if (missing.length > 0) {
      throw new Error(
        `generate_demo: no rehearsed script for scene(s) ${missing.join(", ")}. ` +
          `Rehearsal proved: ${
            doc.scripts.map((s) => s.sceneId).join(", ") || "(nothing)"
          }. Scene ids in the plan must be exactly the sceneIds rehearse_flow returned.`
      )
    }

    return scenes
  },
})

/**
 * Camera-off login, once per run, before the first frame (spec §12).
 *
 * "Advisory, never fatal" applies only to the login OUTCOME: `auth login`
 * waits for the login form to appear, so on a session that is still
 * authenticated it is expected to time out rather than succeed, resolving
 * `{ ok: false }` — which is why that case is logged and not thrown. A
 * session that really is dead surfaces at scene 1's first assertion, and
 * takes the ordinary deviation → recovery → suspend path where the user can
 * act on it.
 *
 * A THROWN error is different and is deliberately left to propagate and fail
 * the run: `hasProfile`/`loginProfile` throw when the agent-browser binary
 * can't be resolved, or when the workspace path's basename sanitises to
 * empty (`vaultProfileName`). Either means every scene in the run is doomed
 * regardless — failing once, here, with the camera off, beats failing at
 * every scene's recording bracket with muddier diagnostics.
 *
 * Passes scenes through untouched; it exists purely for the side effect.
 */
const preflightStep = createStep({
  id: "preflight-login",
  inputSchema: z.array(sceneSchema),
  outputSchema: z.array(sceneSchema),
  execute: async ({ inputData, getInitData }) => {
    const init = getInitData<DemoVideoInit>()
    if (!(await hasProfile(init.workspace))) return inputData
    const res = await loginProfile(init.workspace)
    if (!res.ok && res.stillOnLoginForm) {
      // Not advisory: `auth login` navigated to the login URL and a password
      // field is still on screen, so the run is genuinely signed out. Every
      // scene rehearsed behind the login is about to fail its opening
      // precondition. Say so once, here, with the camera off.
      log.warn(
        `[demo-workflow] preflight auth login FAILED (${res.detail}) — a password ` +
          `field is still on screen, so this run is NOT authenticated. Scenes ` +
          `that start from a signed-in page will fail their precondition.`
      )
    } else if (!res.ok) {
      log.info(
        `[demo-workflow] preflight auth login did not complete (${res.detail}) — ` +
          `expected when the session is still authenticated; continuing`
      )
    }
    return inputData
  },
})

/** What one `.foreach` iteration hands on: a recorded scene, or why there is none. */
const sceneOutcomeSchema = z.object({
  result: sceneResultSchema.nullable(),
  dropped: degradationSchema.nullable(),
})

/**
 * Attempts for a `chained` scene. Its retry re-opens `startUrl`, which throws
 * away the in-page state a state-dependent chained scene continues from (see
 * `DEFAULT_MAX_ATTEMPTS` in ./record-scene) — so every retry past the first is
 * a take that cannot succeed plus a recovery run that cannot help. Two, not
 * one: a chained scene that only chains to avoid a reload retries fine, and
 * one retry is what that costs.
 */
const CHAINED_MAX_ATTEMPTS = 2

/**
 * Records (and mechanically verifies) exactly one scene, with the harness's
 * own internal retry loop (`recordSceneWithRetry`). When that budget is spent
 * the scene is DROPPED and the run goes on (ADR-013, superseding ADR-003's
 * suspend): the question it used to ask — retry, skip or abort — parked the
 * run on a user who may have left, and for a chained scene "retry" could not
 * succeed anyway. The user is told what was dropped, and offered a re-record,
 * once they have a video in hand.
 */
const sceneStep = createStep({
  id: "record-scene",
  inputSchema: sceneSchema,
  outputSchema: sceneOutcomeSchema,
  execute: async ({ inputData: scene, getInitData, writer, abortSignal }) => {
    const init = getInitData<DemoVideoInit>()
    const dropped = droppedScenes.get(init.workspace) ?? new Set<string>()
    droppedScenes.set(init.workspace, dropped)
    const drop = (reason: string) => {
      dropped.add(scene.id)
      log.warn(`[demo-workflow] scene ${scene.id} dropped: ${reason}`)
      return {
        result: null,
        dropped: { stage: "record-scene" as const, sceneId: scene.id, reason },
      }
    }

    // A chained scene starts where its predecessor ended. If that scene never
    // finished, there is no such place — do not spend takes finding that out.
    const chained = scene.script?.continuity === "chained"
    const index = init.plan.scenes.findIndex((s) => s.id === scene.id)
    const previous = index > 0 ? init.plan.scenes[index - 1] : undefined
    if (chained && previous && dropped.has(previous.id)) {
      return drop(
        `continues from ${previous.id}, which was dropped — its start state does not exist`
      )
    }

    const outcome = await recordSceneWithRetry({
      scene,
      workspace: init.workspace,
      modelId: init.modelId,
      // TTS and sync both run AFTER every scene is recorded (see the
      // workflow chain below `sceneStep`), so a scene .webm never carries
      // narration at verify time in this phase — an audio-track check would
      // be unsatisfiable on every voiced run. Flip this back to
      // `init.voiceId !== null` once a future phase moves TTS ahead of
      // recording.
      voiceExpected: false,
      maxAttempts: chained ? CHAINED_MAX_ATTEMPTS : undefined,
      signal: abortSignal,
      onProgress: (u) => {
        void writer.write({
          type: "scene-progress",
          ...u,
          of: init.plan.scenes.length,
        })
      },
    })

    if (outcome.status === "done")
      return { result: outcome.result, dropped: null }
    // A cancelled run is not a dropped scene — let the cancel end the run.
    if (abortSignal?.aborted) {
      throw new Error(`Demo generation stopped by user at scene ${scene.id}`)
    }
    return drop(
      `failed ${outcome.attempts} take(s): ` +
        (outcome.lastReport.checks
          .filter((c) => !c.ok)
          .map((c) => c.detail)
          .join("; ") || "no detail")
    )
  },
})

// Explicit intermediate schemas (rather than chaining `.extend()` off a
// `Step.outputSchema`) — `createStep` exposes `outputSchema` typed as
// `StandardSchemaWithJSON<...>`, which drops the zod-specific `.extend`
// method even though the runtime value is still the same zod object. Each
// schema below is built from a plain zod variable instead, and reused as
// both the producing step's `outputSchema` and the next step's
// `inputSchema` so the two stay structurally identical.
const collectedSchema = inputSchema.extend({
  results: z.array(sceneResultSchema),
  degraded: z.array(degradationSchema),
})

/**
 * The floor: what gets recorded when no scene survived, whatever the cause.
 * No model, no rehearsal — open the product and scroll it, through the same
 * `recordSceneWithRetry` every other scene uses, so it is verified like one.
 * It keeps the promise that a run ends with a video; it is reported as the
 * fallback it is and never passed off as the demo that was asked for.
 */
export const FLOOR_SCENE_ID = "floor.01"

export function floorScene(targetUrl: string): Scene {
  const scroll = { cmd: "scroll down 600", settleMs: 1200 }
  return {
    id: FLOOR_SCENE_ID,
    title: "Product overview",
    goal: "Open the product and scroll through the page",
    startUrl: targetUrl,
    endUrl: targetUrl,
    actions: ["Open the page", "Scroll down through it"],
    expectedOutcome: "The page is open and has been scrolled",
    narrationHint: "",
    script: {
      sceneId: FLOOR_SCENE_ID,
      continuity: "independent",
      oneShot: false,
      startUrl: targetUrl,
      endUrl: targetUrl,
      params: {},
      actions: [{ cmd: "wait 1500", settleMs: 600 }, scroll, scroll, scroll],
    },
  }
}

const collectResultsStep = createStep({
  id: "collect-scene-results",
  inputSchema: z.array(sceneOutcomeSchema),
  outputSchema: collectedSchema,
  execute: async ({ inputData, getInitData, abortSignal }) => {
    const init = getInitData<DemoVideoInit>()
    droppedScenes.delete(init.workspace)
    const results = inputData.flatMap((o) => (o.result ? [o.result] : []))
    const degraded: Degradation[] = inputData.flatMap((o) =>
      o.dropped ? [o.dropped] : []
    )
    if (results.length > 0) {
      // The stall watchdog asks for the floor scene outright when nothing was
      // rehearsed. It recorded fine — and it is still the fallback, so it is
      // reported as one however it got here.
      if (results.some((r) => r.sceneId === FLOOR_SCENE_ID)) {
        degraded.push({
          stage: "floor",
          reason: `no scene was ever rehearsed — this video is a fallback tour of ${init.plan.targetUrl}`,
        })
      }
      return { ...init, results, degraded }
    }

    const floor = await recordSceneWithRetry({
      scene: floorScene(init.plan.targetUrl),
      workspace: init.workspace,
      modelId: init.modelId,
      voiceExpected: false,
      maxAttempts: 1,
      noRecovery: true,
      signal: abortSignal ?? new AbortController().signal,
    })
    if (floor.status !== "done") {
      // The one run that ends with nothing: not even opening the page and
      // scrolling it could be recorded, so the browser or the site is gone.
      throw new Error(
        `no scene could be recorded, and neither could the fallback tour of ${init.plan.targetUrl}: ` +
          (floor.lastReport.checks.find((c) => !c.ok)?.detail ?? "no detail")
      )
    }
    degraded.push({
      stage: "floor",
      reason: `none of the ${init.plan.scenes.length} planned scene(s) could be recorded — this video is a fallback tour of ${init.plan.targetUrl}`,
    })
    return { ...init, results: [floor.result], degraded }
  },
})

const narratedSchema = collectedSchema.extend({
  narration: narrationSegmentsSchema.nullable(),
})

const narrateStep = createStep({
  id: "narrate",
  inputSchema: collectedSchema,
  outputSchema: narratedSchema,
  execute: async ({ inputData, abortSignal }) => {
    // Code review round-2 #2: gate on key AVAILABILITY too, not just
    // `voiceId` — the key itself still never enters workflow input/state
    // (see `inputSchema`'s comment), only this boolean check does. Without
    // this, a voice configured with a missing/revoked key used to record
    // every scene and only THEN hard-fail in `ttsStep` — degrading to an
    // unvoiced video (the pre-fix-round-1 behavior) here instead skips the
    // wasted narration call and matches what `ttsStep` now also degrades to.
    if (!inputData.voiceId || !elevenLabsApiKey()) {
      return { ...inputData, narration: null }
    }
    const actionLogs = await Promise.all(
      inputData.results.map(async (r) => {
        const entries = parseActionEntries(
          await fs.readFile(r.actionsPath, "utf8")
        )
        return {
          sceneId: r.sceneId,
          durationSec: r.durationSec,
          entries,
          numberedActions: entries.map(
            (e) =>
              `${e.idx}: ${e.action}${e.argsSummary ? ` ${e.argsSummary}` : ""}`
          ),
        }
      })
    )
    // A video with no voice is a video. Narration failing — the provider, a
    // malformed object from a weak model, the budget — costs the run its
    // voiceover, never the run.
    let narrationRun: Awaited<ReturnType<typeof narrateScenes>>
    try {
      const budget = withBudget(BUDGET_MS.narrate, abortSignal)
      await maybeFault("narrate", budget)
      narrationRun = await narrateScenes({
        workspace: inputData.workspace,
        modelId: inputData.modelId,
        demoTitle: inputData.plan.demoTitle,
        // The scenes that were RECORDED, not the ones that were planned. A
        // dropped scene has no footage to talk over, and the floor scene is
        // in no plan — narrating the plan paid for lines about scenes that are
        // not in the video and left the fallback tour silent.
        scenes: actionLogs.map((log) => {
          const planned = inputData.plan.scenes.find(
            (s) => s.id === log.sceneId
          )
          return {
            sceneId: log.sceneId,
            goal:
              planned?.goal ??
              `A short tour of ${inputData.plan.targetUrl}, scrolling through the page`,
            narrationHint: planned?.narrationHint ?? "",
            durationSec: log.durationSec,
            numberedActions: log.numberedActions,
            actionEntries: log.entries,
          }
        }),
        signal: budget,
      })
    } catch (err) {
      if (abortSignal?.aborted) throw err
      log.warn(
        `[demo-workflow] narration failed, continuing silent: ${reasonOf(err)}`
      )
      return {
        ...inputData,
        narration: null,
        degraded: [
          ...inputData.degraded,
          { stage: "narrate" as const, reason: reasonOf(err) },
        ],
      }
    }
    // Same blind spot as the recorder (see `writeAgentTranscript` in
    // `./record-scene`): the narrator is a bare `generate()` with no memory,
    // so its conversation is otherwise unrecoverable after the run.
    try {
      await fs.writeFile(
        path.join(inputData.workspace, "narration.agent.json"),
        JSON.stringify(
          {
            modelId: inputData.modelId,
            usage: narrationRun.usage,
            ...projectSteps(narrationRun.steps),
            object: narrationRun.narration,
          },
          null,
          2
        ),
        "utf8"
      )
    } catch {
      // debug artifact only — never fail narration over it
    }
    return { ...inputData, narration: narrationRun.narration ?? null }
  },
})

const sceneAudioSegmentSchema = z.object({
  text: z.string(),
  anchor: segmentAnchorSchema,
  file: z.string().describe("Workspace-relative MP3 path"),
  durationMs: z.number(),
})

const voicedSchema = narratedSchema.extend({
  sceneAudio: z.record(z.string(), z.array(sceneAudioSegmentSchema)).nullable(),
})

const ttsStep = createStep({
  id: "tts",
  inputSchema: narratedSchema,
  outputSchema: voicedSchema,
  execute: async ({ inputData, abortSignal }) => {
    if (!inputData.narration || !inputData.voiceId) {
      return { ...inputData, sceneAudio: null }
    }
    // Key re-read at execution time — never in workflow state (see
    // inputSchema comment).
    const elevenLabsKey = elevenLabsApiKey()
    if (!elevenLabsKey) {
      return { ...inputData, sceneAudio: null }
    }

    const sceneAudio: Record<
      string,
      z.infer<typeof sceneAudioSegmentSchema>[]
    > = {}
    try {
      await maybeFault("tts", withBudget(BUDGET_MS.ttsPerScene, abortSignal))
      for (const sceneNarration of inputData.narration.scenes) {
        if (sceneNarration.segments.length === 0) continue
        if (
          !inputData.results.some((r) => r.sceneId === sceneNarration.sceneId)
        )
          continue
        const audio = await synthesizeNarrationAudio({
          cwd: inputData.workspace,
          sceneId: sceneNarration.sceneId,
          texts: sceneNarration.segments.map((s) => s.text),
          voiceId: inputData.voiceId,
          apiKey: elevenLabsKey,
          signal: withBudget(BUDGET_MS.ttsPerScene, abortSignal),
        })
        sceneAudio[sceneNarration.sceneId] = sceneNarration.segments.map(
          (seg, i) => ({
            text: seg.text,
            anchor: seg.anchor,
            file: audio[i].file,
            durationMs: audio[i].durationMs,
          })
        )
      }
    } catch (err) {
      if (abortSignal?.aborted) throw err
      // All or nothing: a demo whose voice cuts out after scene 2 reads as
      // broken, a silent one reads as silent.
      log.warn(
        `[demo-workflow] speech synthesis failed, continuing silent: ${reasonOf(err)}`
      )
      return {
        ...inputData,
        sceneAudio: null,
        degraded: [
          ...inputData.degraded,
          { stage: "tts" as const, reason: reasonOf(err) },
        ],
      }
    }
    return { ...inputData, sceneAudio }
  },
})

// sceneId → absolute path of the retimed, audio-carrying final scene file
const syncedSchema = voicedSchema.extend({
  retimedPaths: z.record(z.string(), z.string()),
})

const syncStep = createStep({
  id: "sync",
  inputSchema: voicedSchema,
  outputSchema: syncedSchema,
  execute: async ({ inputData, abortSignal }) => {
    const retimedPaths: Record<string, string> = {}
    const degraded = [...inputData.degraded]
    for (const r of inputData.results) {
      if (abortSignal?.aborted) {
        throw new Error("Demo generation stopped by user during sync/retiming")
      }
      try {
        await maybeFault(
          "sync",
          withBudget(BUDGET_MS.syncPerScene, abortSignal)
        )
        const rendered = await renderScene({
          workspace: inputData.workspace,
          sceneId: r.sceneId,
          videoPath: r.videoPath,
          actionsPath: r.actionsPath,
          segments: inputData.sceneAudio?.[r.sceneId] ?? [],
        })
        retimedPaths[r.sceneId] = rendered.finalPath
      } catch (err) {
        if (abortSignal?.aborted) throw err
        // A sync failure is a code bug (see ./sync) — and the scene's take is
        // still a good take. Ship the take, unretimed and unvoiced, and put
        // the bug on the scorecard where it will be seen, rather than let it
        // cost the user the whole video. If even that transcode fails the
        // scene has no usable file: compose leaves it out.
        const reason = reasonOf(err)
        await persistStderr(inputData.workspace, "sync", err)
        log.error(
          `[demo-workflow] sync failed for ${r.sceneId}, using the raw take: ${reason}`
        )
        try {
          retimedPaths[r.sceneId] = await renderRawFallback({
            workspace: inputData.workspace,
            sceneId: r.sceneId,
            videoPath: r.videoPath,
          })
          degraded.push({ stage: "sync", sceneId: r.sceneId, reason })
        } catch (fallbackErr) {
          degraded.push({
            stage: "sync",
            sceneId: r.sceneId,
            reason: `${reason}; the raw take could not be used either: ${reasonOf(fallbackErr)}`,
          })
        }
      }
    }
    return { ...inputData, retimedPaths, degraded }
  },
})

const composeStep = createStep({
  id: "compose",
  inputSchema: syncedSchema,
  outputSchema: z.object({
    videoPath: z.string(),
    scenes: z.array(sceneResultSchema),
    degraded: z.array(degradationSchema),
  }),
  execute: async ({ inputData, abortSignal }) => {
    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) {
      throw new Error(
        "ffmpeg binary not available — cannot compose the final demo video."
      )
    }
    const outDir = path.join(inputData.workspace, "output")
    await fs.mkdir(outDir, { recursive: true })
    const degraded = [...inputData.degraded]

    // Every scene's final file was rendered by sync.ts with identical
    // codec/stream parameters (h264 yuv420p 30fps + aac 44100 stereo) — so
    // the concat is a pure stream copy. A scene with no file (sync and its
    // fallback both failed) is left out, already on `degraded`.
    const kept = inputData.results.filter(
      (r) => inputData.retimedPaths[r.sceneId]
    )
    const parts = kept.map((r) => inputData.retimedPaths[r.sceneId])
    if (parts.length === 0) {
      throw new Error("compose: no scene produced a usable file")
    }

    const outputPath = path.join(outDir, "demo.mp4")
    const listPath = path.join(outDir, "concat.txt")
    await fs.writeFile(
      listPath,
      parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n")
    )
    const concat = (codec: string[]) =>
      execFileAsync(
        ffmpeg,
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          ...codec,
          "-movflags",
          "+faststart",
          outputPath,
        ],
        { signal: withBudget(BUDGET_MS.compose, abortSignal) }
      )
    try {
      await maybeFault("compose", withBudget(BUDGET_MS.compose, abortSignal))
      await concat(["-c", "copy"])
    } catch (err) {
      if (abortSignal?.aborted) throw err
      // Stream copy needs byte-identical stream parameters across parts. If
      // one part broke that promise, re-encoding still gives the user a video.
      const reason = reasonOf(err)
      log.error(
        `[demo-workflow] stream-copy concat failed, re-encoding: ${reason}`
      )
      await persistStderr(inputData.workspace, "compose", err)
      await concat([
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        "-c:a",
        "aac",
        "-ar",
        "44100",
        "-ac",
        "2",
      ])
      degraded.push({ stage: "compose", reason })
    }

    const finalCheck = await verifyFinalVideo({
      videoPath: outputPath,
      scenesDurationSec: kept.reduce((sum, r) => sum + r.durationSec, 0),
      voiced: inputData.sceneAudio !== null,
    })
    await recordRun({
      workspace: inputData.workspace,
      outcome: "video",
      scenes: kept.length,
      plannedScenes: inputData.plan.scenes.length,
      videoPath: outputPath,
      degraded,
      nudges: inputData.nudges,
      salvaged: inputData.salvaged,
      finalCheck,
    })
    return { videoPath: outputPath, scenes: kept, degraded }
  },
})

/** ffmpeg's own words, kept: a thrown `execFile` error carries them and the log line above does not. */
async function persistStderr(workspace: string, stage: string, err: unknown) {
  const stderr = (err as { stderr?: unknown })?.stderr
  if (typeof stderr !== "string" || !stderr) return
  try {
    const dir = path.join(workspace, "logs")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${stage}.stderr.txt`), stderr, "utf8")
  } catch {
    // diagnostics only
  }
}

export const demoVideoWorkflow = createWorkflow({
  id: "demo-video",
  inputSchema,
  outputSchema: composeStep.outputSchema,
})
  .then(toScenesStep)
  .then(preflightStep)
  .foreach(sceneStep, { concurrency: 1 })
  .then(collectResultsStep)
  .then(narrateStep)
  .then(ttsStep)
  .then(syncStep)
  .then(composeStep)
  .commit()
