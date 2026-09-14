// ── demo-video workflow (ADR-001) ───────────────────────────────────────────
//
// plan (input) → foreach scene [record+verify+retry, suspend on exhaustion]
// → collect → narrate (structured) → tts (synthesis only, skipped when no
// voice) → sync (EDL-based retiming/mix, see `./sync`) → compose (pure
// concat, ffmpeg).
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
import type { SceneResult } from "./schemas"
import { recordSceneWithRetry } from "./record-scene"
import { synthesizeNarrationAudio } from "../lib/voiceover"
import { parseActionEntries, renderScene } from "./sync"
import {
  narrateScenes,
  narrationSegmentsSchema,
  segmentAnchorSchema,
} from "./narrate"
import { resolveFfmpeg } from "../../lib/ffmpeg"
import { getDecryptedKey } from "../../store/provider-keys"
import { hasProfile, loginProfile } from "./credentials"
import { readScripts } from "./rehearsal"
import log from "../../lib/logger"

const execFileAsync = promisify(execFile)

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

const sceneResumeSchema = z.object({
  action: z.enum(["retry", "skip", "abort"]),
  guidance: z.string().optional(),
})
const sceneSuspendSchema = z.object({
  sceneId: z.string(),
  failure: z.string(),
  attempts: z.number(),
})

/**
 * Records (and mechanically verifies) exactly one scene, with the harness's
 * own internal retry loop (`recordSceneWithRetry`, up to its own
 * `maxAttempts`). Only suspends the WORKFLOW once that internal retry budget
 * is exhausted, asking the user to retry (optionally with guidance passed
 * through to the off-camera recovery agent as a hint), skip this scene, or
 * abort the whole run.
 *
 * Returns `null` for a skipped scene — filtered out by `collectResultsStep`.
 */
const sceneStep = createStep({
  id: "record-scene",
  inputSchema: sceneSchema,
  outputSchema: sceneResultSchema.nullable(),
  resumeSchema: sceneResumeSchema,
  suspendSchema: sceneSuspendSchema,
  execute: async ({
    inputData: scene,
    resumeData,
    suspend,
    getInitData,
    writer,
    abortSignal,
  }) => {
    const init = getInitData<DemoVideoInit>()

    // Re-invoked from the top on resume (see file header) — resumeData is
    // only populated on that replay pass, so a fresh first pass falls
    // through to recording unconditionally.
    if (resumeData?.action === "abort") {
      throw new Error(`Demo generation aborted at scene ${scene.id} by user`)
    }
    if (resumeData?.action === "skip") {
      return null
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
      guidance:
        resumeData?.action === "retry" ? resumeData.guidance : undefined,
      // This step re-runs from the top on resume, so `recordSceneWithRetry`
      // starts a fresh loop at attempt 1 and would otherwise open the take as
      // if nothing had happened. It has: the previous invocation's last
      // failed attempt left the browser mid-scene. Tell it so, or a chained
      // scene's `record restart` continues from that wreckage instead of the
      // previous scene's clean end state — silently, since replay then runs
      // fine from the wrong page.
      resumedRetry: resumeData?.action === "retry",
      signal: abortSignal,
      onProgress: (u) => {
        void writer.write({
          type: "scene-progress",
          ...u,
          of: init.plan.scenes.length,
        })
      },
    })

    if (outcome.status === "done") return outcome.result

    return await suspend({
      sceneId: scene.id,
      failure: outcome.lastReport.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; "),
      attempts: outcome.attempts,
    })
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
})

const collectResultsStep = createStep({
  id: "collect-scene-results",
  inputSchema: z.array(sceneResultSchema.nullable()),
  outputSchema: collectedSchema,
  execute: async ({ inputData, getInitData }) => {
    const init = getInitData<DemoVideoInit>()
    const results = inputData.filter((r): r is SceneResult => r !== null)
    return { ...init, results }
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
    if (!inputData.voiceId || !getDecryptedKey("elevenlabs")) {
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
    const narrationRun = await narrateScenes({
      workspace: inputData.workspace,
      modelId: inputData.modelId,
      demoTitle: inputData.plan.demoTitle,
      scenes: inputData.plan.scenes.map((s) => {
        const log = actionLogs.find((l) => l.sceneId === s.id)
        return {
          sceneId: s.id,
          goal: s.goal,
          narrationHint: s.narrationHint,
          durationSec: log?.durationSec ?? 0,
          numberedActions: log?.numberedActions ?? [],
          actionEntries: log?.entries,
        }
      }),
      signal: abortSignal,
    })
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
            steps: narrationRun.steps,
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
    const elevenLabsKey = getDecryptedKey("elevenlabs")
    if (!elevenLabsKey) {
      return { ...inputData, sceneAudio: null }
    }

    const sceneAudio: Record<
      string,
      z.infer<typeof sceneAudioSegmentSchema>[]
    > = {}
    for (const sceneNarration of inputData.narration.scenes) {
      if (sceneNarration.segments.length === 0) continue
      if (!inputData.results.some((r) => r.sceneId === sceneNarration.sceneId))
        continue
      const audio = await synthesizeNarrationAudio({
        cwd: inputData.workspace,
        sceneId: sceneNarration.sceneId,
        texts: sceneNarration.segments.map((s) => s.text),
        voiceId: inputData.voiceId,
        apiKey: elevenLabsKey,
        signal: abortSignal,
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
    for (const r of inputData.results) {
      if (abortSignal?.aborted) {
        throw new Error("Demo generation stopped by user during sync/retiming")
      }
      const rendered = await renderScene({
        workspace: inputData.workspace,
        sceneId: r.sceneId,
        videoPath: r.videoPath,
        actionsPath: r.actionsPath,
        segments: inputData.sceneAudio?.[r.sceneId] ?? [],
      })
      retimedPaths[r.sceneId] = rendered.finalPath
    }
    return { ...inputData, retimedPaths }
  },
})

const composeStep = createStep({
  id: "compose",
  inputSchema: syncedSchema,
  outputSchema: z.object({
    videoPath: z.string(),
    scenes: z.array(sceneResultSchema),
  }),
  execute: async ({ inputData }) => {
    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) {
      throw new Error(
        "ffmpeg binary not available — cannot compose the final demo video."
      )
    }
    const outDir = path.join(inputData.workspace, "output")
    await fs.mkdir(outDir, { recursive: true })

    // Every scene's final file was rendered by sync.ts with identical
    // codec/stream parameters (h264 yuv420p 30fps + aac 44100 stereo) —
    // the concat demuxer's uniformity requirement holds by construction
    // and the concat is a pure stream copy.
    const parts = inputData.results.map((r) => {
      const p = inputData.retimedPaths[r.sceneId]
      if (!p) throw new Error(`compose: no retimed output for ${r.sceneId}`)
      return p
    })

    const outputPath = path.join(outDir, "demo.mp4")
    const listPath = path.join(outDir, "concat.txt")
    await fs.writeFile(
      listPath,
      parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n")
    )
    await execFileAsync(ffmpeg, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ])
    return { videoPath: outputPath, scenes: inputData.results }
  },
})

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
